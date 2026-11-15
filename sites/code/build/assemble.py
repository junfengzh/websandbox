#!/usr/bin/env python3
"""Assemble base.db: relational export + git shards + templates, then index and finalize.

Usage: python3 -I assemble.py --rel rel.db --shards DIR --out base.db

Copies rel.db to OUT, merges every SHARDS/p<id>.db (projects) and SHARDS/t_<name>.db
(templates) with dedupe by sha, fills site_settings, builds FTS5 indexes (+ sync triggers),
drops build-only tables, ANALYZE + VACUUM + integrity_check.
"""
import argparse, glob, os, shutil, sqlite3, time

SETTINGS = {
    'external_url': 'http://metis.lti.cs.cmu.edu:8023',   # GitLab's configured URL (WebArena)
    'ssh_clone_prefix': 'ssh://git@metis.lti.cs.cmu.edu:2222/',  # + full_path + '.git' (tasks 293-297)
    'http_clone_prefix': 'http://metis.lti.cs.cmu.edu:8023/',     # + full_path + '.git'
    'time_zone': 'UTC',
    'gitlab_version': '15.7.5',
    'source': 'WebArena gitlab-populated-final-port8023 (GitLab CE 15.7.5)',
    'access_levels': '{"5":"Minimal Access","10":"Guest","20":"Reporter","30":"Developer","40":"Maintainer","50":"Owner"}',
}

FTS = '''
CREATE VIRTUAL TABLE projects_fts USING fts5(name, path, full_path, description,
  content='projects', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE issues_fts USING fts5(title, description,
  content='issues', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE merge_requests_fts USING fts5(title, description,
  content='merge_requests', content_rowid='id', tokenize='porter unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE users_fts USING fts5(username, name,
  content='users', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
INSERT INTO projects_fts(projects_fts) VALUES ('rebuild');
INSERT INTO issues_fts(issues_fts) VALUES ('rebuild');
INSERT INTO merge_requests_fts(merge_requests_fts) VALUES ('rebuild');
INSERT INTO users_fts(users_fts) VALUES ('rebuild');
'''


def triggers(table, fts, cols):
    c = ', '.join(cols)
    new = ', '.join('new.' + x for x in cols)
    old = ', '.join('old.' + x for x in cols)
    return f'''
CREATE TRIGGER {table}_fts_ai AFTER INSERT ON {table} BEGIN
  INSERT INTO {fts}(rowid, {c}) VALUES (new.id, {new}); END;
CREATE TRIGGER {table}_fts_ad AFTER DELETE ON {table} BEGIN
  INSERT INTO {fts}({fts}, rowid, {c}) VALUES ('delete', old.id, {old}); END;
CREATE TRIGGER {table}_fts_au AFTER UPDATE OF {c} ON {table} BEGIN
  INSERT INTO {fts}({fts}, rowid, {c}) VALUES ('delete', old.id, {old});
  INSERT INTO {fts}(rowid, {c}) VALUES (new.id, {new}); END;
'''


def merge_git(db, shard_alias):
    s = shard_alias
    db.execute(f'''INSERT OR IGNORE INTO git_objects (sha, type, size, enc, omitted, binary, data)
                   SELECT sha, type, size, enc, omitted, binary, data FROM {s}.objects''')
    db.execute(f'''INSERT OR IGNORE INTO commits (sha, tree_sha, parents, author_name, author_email, authored_at,
                     author_tz, committer_name, committer_email, committed_at, committer_tz, title, message,
                     additions, deletions, files_changed, has_tree)
                   SELECT sha, tree_sha, parents, author_name, author_email, authored_at, author_tz, committer_name,
                     committer_email, committed_at, committer_tz, title, message, additions, deletions,
                     files_changed, has_tree
                   FROM {s}.commits ORDER BY committed_at, sha''')
    db.execute(f'''UPDATE commits SET has_tree = 1 WHERE has_tree = 0 AND sha IN
                   (SELECT sha FROM {s}.commits WHERE has_tree = 1)''')
    db.execute(f'''INSERT OR IGNORE INTO commit_files (commit_id, ord, path, old_path, change, additions, deletions)
                   SELECT c.id, f.ord, f.path, f.old_path, f.change, f.additions, f.deletions
                   FROM {s}.commit_files f JOIN commits c ON c.sha = f.sha''')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--rel', required=True)
    ap.add_argument('--shards', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    t0 = time.time()
    tmp = a.out + '.tmp'
    for f in (tmp, tmp + '-journal'):
        if os.path.exists(f):
            os.remove(f)
    shutil.copyfile(a.rel, tmp)
    db = sqlite3.connect(tmp, isolation_level=None)
    for p in ('journal_mode=OFF', 'synchronous=OFF', 'cache_size=-2000000', 'temp_store=MEMORY'):
        db.execute('PRAGMA ' + p)
    db.execute('BEGIN')

    projects = [r[0] for r in db.execute('SELECT project_id FROM _repos ORDER BY project_id')]
    for pid in projects:
        f = os.path.join(a.shards, f'p{pid}.db')
        if not os.path.exists(f):
            print('MISSING shard', pid); continue
        db.execute('ATTACH ? AS s', (f,))
        meta = dict(db.execute('SELECT key, value FROM s.meta'))
        merge_git(db, 's')
        db.execute('''INSERT INTO refs (project_id, kind, name, sha, tag_sha, tag_message, tagger_name, tagger_email, tagged_at)
                      SELECT ?, kind, name, sha, tag_sha, tag_message, tagger_name, tagger_email, tagged_at FROM s.refs''', (pid,))
        db.execute('''INSERT INTO project_commits (project_id, commit_id)
                      SELECT ?, c.id FROM s.commits sc JOIN commits c ON c.sha = sc.sha WHERE sc.in_project = 1''', (pid,))
        db.execute('''INSERT INTO branch_commits (project_id, branch, pos, commit_id)
                      SELECT ?, b.branch, b.pos, c.id FROM s.branch_commits b JOIN commits c ON c.sha = b.sha''', (pid,))
        db.execute('''INSERT INTO contributors SELECT ?, branch, author_email, author_name, commits, commits_all,
                      additions, deletions, first_at, last_at FROM s.contributors''', (pid,))
        db.execute('''INSERT INTO wiki_pages (project_id, slug, title, format, content, updated_at, author_name)
                      SELECT ?, slug, title, format, content, updated_at, author_name FROM s.wiki_pages''', (pid,))
        db.execute('UPDATE projects SET default_branch = ?, commit_count = ?, objects_policy = ? WHERE id = ?',
                   (meta.get('default_branch') or None, int(meta.get('default_commits', 0)), meta.get('policy', 'full'), pid))
        db.execute('COMMIT'); db.execute('DETACH s'); db.execute('BEGIN')
        print(f'p{pid} merged ({time.time() - t0:.0f}s)', flush=True)

    for f in sorted(glob.glob(os.path.join(a.shards, 't_*.db'))):
        db.execute('ATTACH ? AS s', (f,))
        meta = dict(db.execute('SELECT key, value FROM s.meta'))
        merge_git(db, 's')
        br = meta['default_branch']
        head = db.execute("SELECT sha FROM s.refs WHERE kind = 'branch' AND name = ?", (br,)).fetchone()[0]
        db.execute('INSERT INTO project_templates VALUES (?,?,?,?,?)',
                   (meta['template_name'], meta['template_title'], meta['template_description'], head, br))
        db.execute('COMMIT'); db.execute('DETACH s'); db.execute('BEGIN')
    print('templates merged', flush=True)

    db.executemany('INSERT OR REPLACE INTO site_settings VALUES (?,?)', SETTINGS.items())
    db.execute('DROP TABLE _repos')
    db.executescript(FTS)
    db.executescript(triggers('projects', 'projects_fts', ['name', 'path', 'full_path', 'description']))
    db.executescript(triggers('issues', 'issues_fts', ['title', 'description']))
    db.executescript(triggers('merge_requests', 'merge_requests_fts', ['title', 'description']))
    db.executescript(triggers('users', 'users_fts', ['username', 'name']))
    for t in ('projects_fts', 'issues_fts', 'merge_requests_fts', 'users_fts'):
        db.execute(f"INSERT INTO {t}({t}) VALUES ('optimize')")
    db.execute('COMMIT')
    print(f'fts done ({time.time() - t0:.0f}s)', flush=True)
    db.execute('ANALYZE')
    db.execute('PRAGMA journal_mode=DELETE')
    db.execute('VACUUM')
    ok = db.execute('PRAGMA integrity_check').fetchone()[0]
    fk = db.execute('PRAGMA foreign_key_check').fetchall()
    db.close()
    if ok != 'ok':
        raise SystemExit('integrity_check: ' + ok)
    print('foreign_key_check violations:', len(fk))
    os.replace(tmp, a.out)
    print(f'assemble done in {time.time() - t0:.0f}s -> {a.out} ({os.path.getsize(a.out) / 1e9:.2f} GB)')


if __name__ == '__main__':
    main()
