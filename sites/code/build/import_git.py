#!/usr/bin/env python3
"""Read the GitLab bare repositories into per-project shard DBs (step 1 of the git import).

Usage: python3 -I import_git.py --repos DIR --rel rel.db --shards DIR [--jobs N] [--only PROJECT_ID,...]

For each project (rel.db `_repos`), writes SHARDS/p<id>.db with refs, commits (+ files
changed), the project's commit set, branch histories, contributors, wiki pages and the
trees/blobs chosen by the object policy (see ../SCHEMA.md "Git objects"):

  full    every tree/blob reachable from branches and tags   (history blobs <= FULL_MAX)
  recent  the last RECENT_COMMITS commits of the default branch, then other branch heads and
          tags (newest first) until RECENT_EXTRA bytes of new blobs were added
Blobs > BLOB_MAX, and binary blobs > BINARY_MAX, are kept as placeholders (omitted=1).
merge_shards.py then merges the shards into base.db (dedupe by sha).
"""
import argparse, os, sqlite3, subprocess, sys, time, zlib
from concurrent.futures import ProcessPoolExecutor, as_completed

FULL_MAX = 100_000_000
RECENT_COMMITS = 100
RECENT_EXTRA = 20_000_000
BLOB_MAX = 1_000_000
BINARY_MAX = 256_000
NUMSTAT_MAX_COMMITS = 50_000      # bigger repos (gcc): file lists without line counts / renames
COMMIT_FILES_MAX = 100
BRANCH_ROWS_MAX = 30_000          # per project, non-default branches (smallest first)
BRANCH_MAX = 10_000               # non-default branch stored only if <= this many commits
HUGE_COMMITS = 100_000            # repos above this (gcc): only the default branch's history + ref tips,
HUGE_FILES_COMMITS = 5_000        #   commit_files for the newest 5000 commits only,
HUGE_RECENT_COMMITS = 30          #   trees for the newest 30 default-branch commits only

SHARD_SCHEMA = '''
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE refs (kind TEXT, name TEXT, sha TEXT, tag_sha TEXT, tag_message TEXT, tagger_name TEXT,
                   tagger_email TEXT, tagged_at TEXT, PRIMARY KEY (kind, name));
CREATE TABLE commits (sha TEXT PRIMARY KEY, tree_sha TEXT, parents TEXT, author_name TEXT, author_email TEXT,
                      authored_at TEXT, author_tz INTEGER, committer_name TEXT, committer_email TEXT,
                      committed_at TEXT, committer_tz INTEGER, title TEXT, message TEXT, additions INTEGER,
                      deletions INTEGER, files_changed INTEGER, in_project INTEGER DEFAULT 0, has_tree INTEGER DEFAULT 0);
CREATE TABLE commit_files (sha TEXT, ord INTEGER, path TEXT, old_path TEXT, change TEXT, additions INTEGER,
                           deletions INTEGER, PRIMARY KEY (sha, ord));
CREATE TABLE branch_commits (branch TEXT, pos INTEGER, sha TEXT, PRIMARY KEY (branch, pos));
CREATE TABLE contributors (branch TEXT, author_email TEXT, author_name TEXT, commits INTEGER, commits_all INTEGER, additions INTEGER,
                           deletions INTEGER, first_at TEXT, last_at TEXT, PRIMARY KEY (branch, author_email));
CREATE TABLE objects (sha TEXT PRIMARY KEY, type TEXT, size INTEGER, enc INTEGER, omitted INTEGER, binary INTEGER, data BLOB);
CREATE TABLE wiki_pages (slug TEXT PRIMARY KEY, title TEXT, format TEXT, content TEXT, updated_at TEXT, author_name TEXT);
'''


def utc(unix):
    return time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(int(unix)))


def tzmin(z):
    z = z.strip()
    if len(z) != 5:
        return None
    m = int(z[1:3]) * 60 + int(z[3:5])
    return -m if z[0] == '-' else m


def dec(bs):
    return bs.decode('utf-8', 'replace')


class Git:
    def __init__(self, gitdir):
        self.dir = gitdir
        self.env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', HOME='/nonexistent', LC_ALL='C')
        self._batch = self._check = None

    def run(self, *args, check=True):
        r = subprocess.run(['git', '-c', 'core.quotePath=false', '-c', 'safe.directory=*', '-C', self.dir, *args],
                           capture_output=True, env=self.env)
        if check and r.returncode != 0:
            raise RuntimeError(f'git {args[:3]} failed: {r.stderr[:300]!r}')
        return r.stdout

    def stream(self, *args):
        return subprocess.Popen(['git', '-c', 'core.quotePath=false', '-c', 'safe.directory=*', '-C', self.dir, *args],
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.env, bufsize=1 << 20)

    def _proc(self, mode):
        return subprocess.Popen(['git', '-c', 'safe.directory=*', '-C', self.dir, 'cat-file', mode],
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, env=self.env, bufsize=1 << 16)

    def check(self, sha):
        if not self._check:
            self._check = self._proc('--batch-check')
        self._check.stdin.write(sha.encode() + b'\n'); self._check.stdin.flush()
        p = self._check.stdout.readline().split()
        if len(p) < 3 or p[1] == b'missing':
            return None, 0
        return p[1].decode(), int(p[2])

    def cat(self, sha):
        if not self._batch:
            self._batch = self._proc('--batch')
        self._batch.stdin.write(sha.encode() + b'\n'); self._batch.stdin.flush()
        p = self._batch.stdout.readline().split()
        if len(p) < 3 or p[1] == b'missing':
            return None, None
        n = int(p[2])
        data = self._batch.stdout.read(n)
        self._batch.stdout.read(1)
        return p[1].decode(), data

    def close(self):
        for p in (self._batch, self._check):
            if p:
                p.stdin.close(); p.wait()


LOG_FMT = '%x1e%H%x1f%T%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%ad%x1f%cn%x1f%ce%x1f%ct%x1f%cd%x1f%B%x1f'


def parse_log(g, revs, numstat):
    """Yield (commit tuple, files list) for `git log revs` with first-parent diffs."""
    args = ['log', '-z', '--raw', '--no-abbrev', '--diff-merges=first-parent', '--date=format:%z', '--format=' + LOG_FMT]
    args += ['--numstat', '-M'] if numstat else ['--no-renames']
    p = g.stream(*args, *revs)
    buf = b''

    def records():
        nonlocal buf
        while True:
            chunk = p.stdout.read(1 << 20)
            if not chunk:
                break
            buf += chunk
            parts = buf.split(b'\x1e')
            buf = parts.pop()
            for r in parts:
                if r:
                    yield r
        if buf:
            yield buf

    for rec in records():
        f = rec.split(b'\x1f', 12)
        if len(f) < 13:
            continue
        sha, tree, parents, an, ae, at, atz, cn, ce, ct, ctz, msg, rest = f
        toks = rest.split(b'\0')
        raws, nums = [], []
        i = 0
        while i < len(toks):
            t = toks[i].lstrip(b'\n')
            if not t:
                i += 1; continue
            if t.startswith(b':'):
                st = t.split(b' ')[4] if len(t.split(b' ')) > 4 else b'M'
                c = chr(st[0])
                if c in 'RC':
                    raws.append((c, dec(toks[i + 2]) if i + 2 < len(toks) else '', dec(toks[i + 1]))); i += 3
                else:
                    raws.append((c, dec(toks[i + 1]) if i + 1 < len(toks) else '', None)); i += 2
            elif b'\t' in t:
                a, d_, path = t.split(b'\t', 2)
                ai = None if a == b'-' else int(a)
                di = None if d_ == b'-' else int(d_)
                if path == b'':
                    nums.append((ai, di)); i += 3
                else:
                    nums.append((ai, di)); i += 1
            else:
                i += 1
        files = []
        for k, (c, path, old) in enumerate(raws):
            a, d_ = nums[k] if numstat and k < len(nums) else (None, None)
            files.append((path, old, 'M' if c == 'C' else ('R' if c == 'R' else c), a, d_))
        m = dec(msg).rstrip('\n')
        yield ((sha.decode(), tree.decode(), parents.decode(), dec(an), dec(ae), utc(at), tzmin(dec(atz)), dec(cn),
                dec(ce), utc(ct), tzmin(dec(ctz)), m.split('\n', 1)[0][:1000], m), files)
    p.wait()


def is_binary(data):
    return b'\0' in data[:8000]


REUSE_KEYS = ('default_branch', 'huge', 'numstat', 'commits', 'project_commits')


def process(pid, gitdir, wikidir, shard, reuse=False):
    """reuse=True keeps an existing shard's refs/commits/commit_files (the slow `git log` step,
    whose output does not depend on the object/branch policies) and recomputes the rest."""
    t0 = time.time()
    old = {}
    if reuse and os.path.exists(shard):
        db = sqlite3.connect(shard)
        try:
            old = dict(db.execute('SELECT key, value FROM meta'))
        except sqlite3.Error:
            old = {}
        if 'commits' not in old:
            db.close(); old = {}
    if old:
        db.execute('PRAGMA journal_mode=OFF'); db.execute('PRAGMA synchronous=OFF')
        for t in ('meta', 'branch_commits', 'contributors', 'objects', 'wiki_pages'):
            db.execute(f'DELETE FROM {t}')
        db.execute('UPDATE commits SET has_tree = 0')
        db.execute('DELETE FROM commit_files WHERE ord >= ?', (COMMIT_FILES_MAX,))
    else:
        for s in ('', '-journal'):
            if os.path.exists(shard + s):
                os.remove(shard + s)
        db = sqlite3.connect(shard)
        db.execute('PRAGMA journal_mode=OFF'); db.execute('PRAGMA synchronous=OFF')
        db.executescript(SHARD_SCHEMA)
    meta = {k: old[k] for k in REUSE_KEYS if k in old}
    if not os.path.isdir(gitdir):
        meta['missing'] = 1
        db.executemany('INSERT INTO meta VALUES (?,?)', list(meta.items())); db.commit(); db.close()
        return pid, meta
    g = Git(gitdir)

    if old:
        refs = db.execute('SELECT * FROM refs').fetchall()
        branches = {r[1]: r[2] for r in refs if r[0] == 'branch'}
        default = old.get('default_branch') or None
        huge = old.get('huge') == '1'
        meta['reused'] = 1
    else:
        # ---------------- refs
        out = g.run('for-each-ref', '--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objectname)%00%(*objecttype)'
                    '%00%(taggername)%00%(taggeremail)%00%(taggerdate:unix)%00%(contents)%1e',
                    'refs/heads', 'refs/tags', 'refs/merge-requests')
        refs = []
        for rec in out.split(b'\x1e'):
            rec = rec.lstrip(b'\n')
            if not rec:
                continue
            name, otype, oid, peeled, ptype, tn, te, td, contents = (rec.split(b'\0', 8) + [b''] * 9)[:9]
            name = dec(name)
            if name.startswith('refs/heads/'):
                kind, short = 'branch', name[11:]
            elif name.startswith('refs/tags/'):
                kind, short = 'tag', name[10:]
            elif name.startswith('refs/merge-requests/') and name.endswith('/head'):
                kind, short = 'mr', name[20:-5]
            else:
                continue
            otype = dec(otype)
            if otype == 'tag':
                if dec(ptype) != 'commit':
                    continue
                refs.append((kind, short, dec(peeled), dec(oid), dec(contents).rstrip('\n') or None, dec(tn) or None,
                             dec(te).strip('<>') or None, utc(td) if td.strip() else None))
            elif otype == 'commit':
                refs.append((kind, short, dec(oid), None, None, None, None, None))
        db.executemany('INSERT OR IGNORE INTO refs VALUES (?,?,?,?,?,?,?,?)', refs)
        branches = {r[1]: r[2] for r in refs if r[0] == 'branch'}
        head = g.run('symbolic-ref', '-q', 'HEAD', check=False).decode().strip()
        default = head[11:] if head.startswith('refs/heads/') and head[11:] in branches else None
        if default is None and branches:
            default = 'main' if 'main' in branches else ('master' if 'master' in branches else sorted(branches)[0])
        meta['default_branch'] = default or ''

        # ---------------- commits (branches + tags = project; + MR heads = known commits)
        total = int(g.run('rev-list', '--count', '--branches', '--tags') or 0) if refs else 0
        huge = total > HUGE_COMMITS
        meta['huge'] = int(huge)
        tips = sorted(set(r[2] for r in refs))
        if huge:
            in_proj = set(dec(x) for x in g.run('rev-list', 'refs/heads/' + default).split()) | \
                set(r[2] for r in refs if r[0] in ('branch', 'tag'))
            runs = [['refs/heads/' + default], ['--no-walk'] + tips]
        else:
            in_proj = set(dec(x) for x in g.run('rev-list', '--branches', '--tags').split()) if refs else set()
            runs = [['--branches', '--tags'] + (['--glob=refs/merge-requests/*'] if any(r[0] == 'mr' for r in refs) else [])]
        ncommits = len(in_proj)
        numstat = ncommits <= NUMSTAT_MAX_COMMITS
        meta['numstat'] = int(numstat)
        n = 0
        cbatch, fbatch = [], []
        for revs in (runs if refs else []):
            for c, files in parse_log(g, revs, numstat):
                adds = sum(f[3] or 0 for f in files) if numstat else None
                dels = sum(f[4] or 0 for f in files) if numstat else None
                cbatch.append(c + (adds, dels, len(files), 1 if c[0] in in_proj else 0))
                if not huge or n < HUGE_FILES_COMMITS:
                    for k, f in enumerate(files[:COMMIT_FILES_MAX]):
                        fbatch.append((c[0], k) + f)
                n += 1
                if len(cbatch) >= 5000:
                    db.executemany('INSERT OR IGNORE INTO commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)', cbatch)
                    db.executemany('INSERT OR IGNORE INTO commit_files VALUES (?,?,?,?,?,?,?)', fbatch)
                    cbatch, fbatch = [], []
            db.executemany('INSERT OR IGNORE INTO commits VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)', cbatch)
            db.executemany('INSERT OR IGNORE INTO commit_files VALUES (?,?,?,?,?,?,?)', fbatch)
            cbatch, fbatch = [], []
        n = db.execute('SELECT count(*) FROM commits').fetchone()[0]
        meta['commits'] = n
        meta['project_commits'] = ncommits

    # ---------------- branch histories + contributors
    rows_left = BRANCH_ROWS_MAX
    others = []
    for br in ([] if huge else sorted(b for b in branches if b != default)):
        cnt = int(g.run('rev-list', '--count', 'refs/heads/' + br) or 0)
        if cnt <= BRANCH_MAX:
            others.append((cnt, br))
    order = ([default] if default else []) + [br for cnt, br in sorted(others)]
    stored = []
    for br in order:
        shas = [dec(x) for x in g.run('rev-list', 'refs/heads/' + br).split()]
        if br != default:
            if len(shas) > rows_left:
                break
            rows_left -= len(shas)
        db.executemany('INSERT INTO branch_commits VALUES (?,?,?)', ((br, i, s) for i, s in enumerate(shas)))
        stored.append(br)
        if br == default:
            meta['default_commits'] = len(shas)
    # GitLab 15.7 Contributors page: the newest 6000 non-merge commits of the ref (git log order),
    # grouped by lower(author_email); name = the name on the newest of those commits.
    db.execute('''CREATE TEMP TABLE nm AS
        SELECT b.branch, b.pos, lower(c.author_email) AS em, c.author_name, c.additions, c.deletions, c.committed_at,
               row_number() OVER (PARTITION BY b.branch ORDER BY b.pos) AS k
        FROM branch_commits b JOIN commits c ON c.sha = b.sha WHERE instr(c.parents, ' ') = 0''')
    db.execute('''INSERT INTO contributors
        SELECT branch, em, (SELECT n2.author_name FROM nm n2 WHERE n2.branch = nm.branch AND n2.em = nm.em
                            ORDER BY n2.pos LIMIT 1),
               sum(k <= 6000), count(*), coalesce(sum(additions), 0), coalesce(sum(deletions), 0),
               min(committed_at), max(committed_at)
        FROM nm GROUP BY branch, em HAVING sum(k <= 6000) > 0 OR count(*) > 0''')
    db.execute('DROP TABLE nm')
    meta['branches_stored'] = len(stored)

    # ---------------- objects
    hist = 0
    if refs:
        p = g.stream('cat-file', '--batch-all-objects', '--batch-check=%(objecttype) %(objectsize)')
        for line in p.stdout:
            t, s = line.split()
            if t == b'blob' and int(s) <= BLOB_MAX:
                hist += int(s)
        p.wait()
    meta['history_blob_bytes'] = hist
    policy = 'full' if hist <= FULL_MAX else 'recent'
    meta['policy'] = policy

    seen_trees, seen_blobs = set(), set()
    stat = {'bytes': 0, 'blobs': 0, 'trees': 0, 'omitted': 0}
    obatch = []

    def flush():
        db.executemany('INSERT OR IGNORE INTO objects VALUES (?,?,?,?,?,?,?)', obatch)
        obatch.clear()

    def pack(data):
        z = zlib.compress(data, 6)
        return (1, z) if len(z) < len(data) * 0.9 else (0, data)

    def blob(sha):
        if sha in seen_blobs:
            return
        seen_blobs.add(sha)
        typ, size = g.check(sha)
        if typ != 'blob':
            return
        if size > BLOB_MAX:
            obatch.append((sha, 'blob', size, 0, 1, 1, None)); stat['omitted'] += 1
            return
        _, data = g.cat(sha)
        binary = is_binary(data)
        if binary and size > BINARY_MAX:
            obatch.append((sha, 'blob', size, 0, 1, 1, None)); stat['omitted'] += 1
            return
        enc, body = pack(data)
        obatch.append((sha, 'blob', size, enc, 0, int(binary), body))
        stat['bytes'] += size; stat['blobs'] += 1

    def tree(sha):
        stack = [sha]
        while stack:
            t = stack.pop()
            if t in seen_trees:
                continue
            seen_trees.add(t)
            typ, data = g.cat(t)
            if typ != 'tree':
                continue
            enc, body = pack(data)
            obatch.append((t, 'tree', len(data), enc, 0, 0, body)); stat['trees'] += 1
            i = 0
            while i < len(data):
                sp = data.index(b' ', i); nul = data.index(b'\0', sp)
                mode = data[i:sp]; oid = data[nul + 1:nul + 21].hex()
                i = nul + 21
                if mode == b'40000':
                    stack.append(oid)
                elif mode == b'160000':
                    continue           # submodule (gitlink)
                else:
                    blob(oid)
            if len(obatch) >= 2000:
                flush()

    walked = []

    def walk_commit(sha):
        r = db.execute('SELECT tree_sha FROM commits WHERE sha = ?', (sha,)).fetchone()
        if r:
            tree(r[0]); walked.append(sha)

    if policy == 'full':
        for (sha,) in db.execute('SELECT sha FROM commits WHERE in_project = 1').fetchall():
            walk_commit(sha)
    else:
        if default:
            for (sha,) in db.execute('SELECT sha FROM branch_commits WHERE branch = ? AND pos < ? ORDER BY pos',
                                     (default, (HUGE_RECENT_COMMITS if huge else RECENT_COMMITS) + 1)).fetchall():
                walk_commit(sha)
        # other branch heads and tags, newest first, while their *new* blobs fit the budget
        # (cost measured with ls-tree before walking, so a head is stored completely or not at all)
        left = RECENT_EXTRA
        heads = [] if huge else db.execute('''SELECT DISTINCT r.sha FROM refs r JOIN commits c ON c.sha = r.sha
                              WHERE r.kind IN ('branch','tag') ORDER BY c.committed_at DESC''').fetchall()
        for (sha,) in heads:
            if left <= 0:
                break
            cost = 0
            for line in g.run('ls-tree', '-r', '-l', '-z', sha).split(b'\0'):
                if not line:
                    continue
                parts = line.split(b'\t', 1)[0].split()
                if len(parts) == 4 and parts[1] == b'blob' and parts[3] != b'-':
                    sz = int(parts[3])
                    if parts[2].decode() not in seen_blobs and sz <= BLOB_MAX:
                        cost += sz
            if cost <= left:
                walk_commit(sha)
                left -= cost
    flush()
    db.executemany('UPDATE commits SET has_tree = 1 WHERE sha = ?', ((s,) for s in walked))
    meta.update({'obj_' + k: v for k, v in stat.items()})
    meta['walked_commits'] = len(walked)

    # ---------------- wiki (current version of <project>.wiki.git)
    if wikidir and os.path.isdir(wikidir):
        w = Git(wikidir)
        if w.run('rev-parse', '-q', '--verify', 'HEAD', check=False).strip():
            ls = w.run('ls-tree', '-r', '-z', 'HEAD').split(b'\0')
            last = w.run('log', '-1', '--format=%ct%x1f%an', 'HEAD').decode().strip().split('\x1f')
            pages = []
            for e in ls:
                if not e:
                    continue
                info, path = e.split(b'\t', 1)
                path = dec(path)
                base, _, ext = path.rpartition('.')
                fmt = {'md': 'markdown', 'markdown': 'markdown', 'rdoc': 'rdoc', 'asciidoc': 'asciidoc',
                       'adoc': 'asciidoc', 'org': 'org', 'textile': 'textile', 'creole': 'creole',
                       'rst': 'rst', 'mediawiki': 'mediawiki', 'wiki': 'mediawiki'}.get(ext.lower())
                if not fmt or not base:
                    continue
                _, data = w.cat(info.split()[2].decode())
                if data is None or len(data) > BLOB_MAX:
                    continue
                pages.append((base, base.rsplit('/', 1)[-1].replace('-', ' '), fmt, dec(data),
                              utc(last[0]) if last and last[0] else None, last[1] if len(last) > 1 else None))
            db.executemany('INSERT OR IGNORE INTO wiki_pages VALUES (?,?,?,?,?,?)', pages)
            meta['wiki_pages'] = len(pages)
        w.close()

    g.close()
    meta['seconds'] = round(time.time() - t0)
    db.executemany('INSERT INTO meta VALUES (?,?)', [(k, str(v)) for k, v in meta.items()])
    db.commit(); db.close()
    return pid, meta


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repos', required=True)
    ap.add_argument('--rel', required=True)
    ap.add_argument('--shards', required=True)
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--only', default='')
    ap.add_argument('--reuse', action='store_true', help='keep existing shards\' git log output (see process())')
    a = ap.parse_args()
    os.makedirs(a.shards, exist_ok=True)
    rel = sqlite3.connect(a.rel)
    todo = rel.execute('SELECT r.project_id, r.disk_path, r.wiki_disk_path, p.repository_size FROM _repos r '
                       'JOIN projects p ON p.id = r.project_id ORDER BY p.repository_size DESC').fetchall()
    rel.close()
    if a.only:
        keep = set(int(x) for x in a.only.split(','))
        todo = [t for t in todo if t[0] in keep]
    with ProcessPoolExecutor(a.jobs) as ex:
        futs = [ex.submit(process, pid, os.path.join(a.repos, disk + '.git'), os.path.join(a.repos, wiki + '.git'),
                          os.path.join(a.shards, f'p{pid}.db'), a.reuse) for pid, disk, wiki, _ in todo]
        for f in as_completed(futs):
            pid, meta = f.result()
            print(pid, ' '.join(f'{k}={v}' for k, v in meta.items()), flush=True)


if __name__ == '__main__':
    main()
