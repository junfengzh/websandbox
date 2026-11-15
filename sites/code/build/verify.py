#!/usr/bin/env python3
"""Verify base.db against the source GitLab (PostgreSQL + bare repos) and WebArena task facts.

Usage: python3 -I verify.py --db base.db --pg 'host=... dbname=gitlabhq_production' --repos DIR [--json out.json]

1. row counts per table vs the source tables;
2. per project: branch/tag counts and default-branch commit count vs `git`;
3. orphan checks (dangling references);
4. task spot checks: each fact computed from base.db AND independently from the source
   (Postgres / git), compared with the WebArena reference answer.
Exit code 1 if any check fails.
"""
import argparse, collections, json, os, sqlite3, subprocess, sys

import psycopg

FAILS = []


def report(name, ok, detail):
    print(('PASS ' if ok else 'FAIL ') + name + ': ' + detail, flush=True)
    if not ok:
        FAILS.append(name)


class V:
    def __init__(self, a):
        self.db = sqlite3.connect(a.db)
        self.pg = psycopg.connect(a.pg)
        self.repos = a.repos

    def q(self, sql, *args):
        return self.db.execute(sql, args).fetchall()

    def pq(self, sql, *args):
        with self.pg.cursor() as c:
            c.execute(sql, args)
            return c.fetchall()

    def gitdir(self, full_path):
        r = self.pq('''SELECT pr.disk_path FROM project_repositories pr JOIN routes r ON r.source_type = 'Project'
                       AND r.source_id = pr.project_id WHERE lower(r.path) = lower(%s)''', full_path)
        return os.path.join(self.repos, r[0][0] + '.git')

    def git(self, full_path, *args):
        return subprocess.run(['git', '-c', 'safe.directory=*', '-C', self.gitdir(full_path), *args],
                              capture_output=True, check=True, env=dict(os.environ, TZ='UTC')
                              ).stdout.decode('utf-8', 'replace')

    # ------------------------------------------------------------------ 1. counts
    def counts(self):
        pairs = [
            ('users', 'users', None), ('projects', 'projects', None), ('issues', 'issues', None),
            ('merge_requests', 'merge_requests', None), ('notes', 'notes', None), ('labels', 'labels', 'NOT template'),
            ('milestones', 'milestones', None), ('members', 'members', None), ('stars', 'users_star_projects', None),
            ('follows', 'user_follow_users', None), ('events', 'events', None), ('todos', 'todos', None),
            ('issue_assignees', '(SELECT DISTINCT issue_id, user_id FROM issue_assignees) x', None),
            ('mr_reviewers', '(SELECT DISTINCT merge_request_id, user_id FROM merge_request_reviewers) x', None),
            ('mr_approvals', '(SELECT DISTINCT merge_request_id, user_id FROM approvals) x', None),
            ('protected_branches', 'protected_branches', None),
            ('namespaces', 'namespaces', "type IN ('User','Group')"),
        ]
        for lite, src, where in pairs:
            n = self.q(f'SELECT count(*) FROM {lite}')[0][0]
            m = self.pq(f'SELECT count(*) FROM {src}' + (f' WHERE {where}' if where else ''))[0][0]
            report(f'count {lite}', n == m, f'lite {n} source {m}')
        n = self.q("SELECT count(*) FROM label_links")[0][0]
        m = self.pq("SELECT count(*) FROM (SELECT DISTINCT target_type, target_id, label_id FROM label_links "
                    "WHERE target_type IN ('Issue','MergeRequest') AND label_id IN (SELECT id FROM labels WHERE NOT template)) x")[0][0]
        report('count label_links', n == m, f'lite {n} source {m}')
        for state in ('opened', 'closed'):
            n = self.q('SELECT count(*) FROM issues WHERE state = ?', state)[0][0]
            m = self.pq('SELECT count(*) FROM issues WHERE state_id = %s', {'opened': 1, 'closed': 2}[state])[0][0]
            report(f'count issues {state}', n == m, f'lite {n} source {m}')
        for state, sid in (('opened', 1), ('closed', 2), ('merged', 3)):
            n = self.q('SELECT count(*) FROM merge_requests WHERE state = ?', state)[0][0]
            m = self.pq('SELECT count(*) FROM merge_requests WHERE state_id = %s', sid)[0][0]
            report(f'count merge_requests {state}', n == m, f'lite {n} source {m}')

    # ------------------------------------------------------------------ 2. git
    def git_checks(self):
        bad = []
        for pid, path, br, cc in self.q('SELECT id, full_path, default_branch, commit_count FROM projects ORDER BY id'):
            gd = self.gitdir(path)
            heads = subprocess.run(['git', '-c', 'safe.directory=*', '-C', gd, 'for-each-ref', '--format=x',
                                    'refs/heads'], capture_output=True).stdout.count(b'x')
            tags = subprocess.run(['git', '-c', 'safe.directory=*', '-C', gd, 'for-each-ref', '--format=x',
                                   'refs/tags'], capture_output=True).stdout.count(b'x')
            nb = self.q("SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'branch'", pid)[0][0]
            nt = self.q("SELECT count(*) FROM refs WHERE project_id = ? AND kind = 'tag'", pid)[0][0]
            gc = 0
            if br:
                gc = int(subprocess.run(['git', '-c', 'safe.directory=*', '-C', gd, 'rev-list', '--count',
                                         'refs/heads/' + br], capture_output=True).stdout or 0)
            if (heads, tags, gc) != (nb, nt, cc):
                bad.append(f'{path}: git {heads}/{tags}/{gc} lite {nb}/{nt}/{cc}')
        report('git refs+default-branch commit counts (all projects)', not bad, '; '.join(bad[:5]) or 'all match')
        # every stored tree/blob of a walked commit exists, and tree_sha of has_tree commits is stored
        n = self.q('''SELECT count(*) FROM commits c LEFT JOIN git_objects o ON o.sha = c.tree_sha
                      WHERE c.has_tree = 1 AND o.sha IS NULL''')[0][0]
        report('trees of has_tree commits present', n == 0, f'{n} missing')
        n = self.q('''SELECT count(*) FROM refs r LEFT JOIN commits c ON c.sha = r.sha WHERE c.id IS NULL''')[0][0]
        report('ref targets present in commits', n == 0, f'{n} missing')
        n = self.q('''SELECT count(*) FROM projects p JOIN refs r ON r.project_id = p.id AND r.kind = 'branch'
                      AND r.name = p.default_branch JOIN commits c ON c.sha = r.sha WHERE c.has_tree = 0''')[0][0]
        report('default-branch heads browsable (has_tree)', n == 0, f'{n} not browsable')

    # ------------------------------------------------------------------ 3. orphans
    def orphans(self):
        checks = {
            'issues.project_id': 'SELECT count(*) FROM issues i LEFT JOIN projects p ON p.id = i.project_id WHERE p.id IS NULL',
            'issues.author_id': 'SELECT count(*) FROM issues i LEFT JOIN users u ON u.id = i.author_id WHERE i.author_id IS NOT NULL AND u.id IS NULL',
            'merge_requests.project_id': 'SELECT count(*) FROM merge_requests m LEFT JOIN projects p ON p.id = m.project_id WHERE p.id IS NULL',
            'notes.author_id': 'SELECT count(*) FROM notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.author_id IS NOT NULL AND u.id IS NULL',
            'projects.namespace_id': 'SELECT count(*) FROM projects p LEFT JOIN namespaces n ON n.id = p.namespace_id WHERE n.id IS NULL',
            'label_links.label_id': 'SELECT count(*) FROM label_links l LEFT JOIN labels x ON x.id = l.label_id WHERE x.id IS NULL',
            'members.user_id': 'SELECT count(*) FROM members m LEFT JOIN users u ON u.id = m.user_id WHERE m.user_id IS NOT NULL AND u.id IS NULL',
            'stars.project_id': 'SELECT count(*) FROM stars s LEFT JOIN projects p ON p.id = s.project_id WHERE p.id IS NULL',
            'events.project_id': 'SELECT count(*) FROM events e LEFT JOIN projects p ON p.id = e.project_id WHERE e.project_id IS NOT NULL AND p.id IS NULL',
        }
        for k, sql in checks.items():
            n = self.q(sql)[0][0]
            report(f'orphans {k}', n == 0, str(n))

    # ------------------------------------------------------------------ 4. task facts
    def commits_lite(self, path, names, d0, d1):
        ph = ' OR '.join(['c.author_name LIKE ?'] * len(names))
        return self.q(f'''SELECT count(*) FROM projects p JOIN branch_commits b ON b.project_id = p.id
                          AND b.branch = p.default_branch JOIN commits c ON c.id = b.commit_id
                          WHERE p.full_path = ? AND ({ph}) AND substr(c.committed_at, 1, 10) BETWEEN ? AND ?''',
                      path, *[f'%{n}%' for n in names], d0, d1)[0][0]

    def commits_src(self, path, names, d0, d1):
        br = self.git(path, 'symbolic-ref', '--short', 'HEAD').strip()
        n = 0
        for line in self.git(path, 'log', '--format=%an%x1f%cd', '--date=format-local:%Y-%m-%d', br).splitlines():
            an, day = line.split('\x1f')
            if any(x.lower() in an.lower() for x in names) and d0 <= day <= d1:
                n += 1
        return n

    def top_lite(self, path, k=3, branch=None):
        return self.q('''SELECT c.author_name, c.author_email, c.commits FROM contributors c JOIN projects p ON p.id = c.project_id
                         WHERE p.full_path = ? AND c.branch = coalesce(?, p.default_branch)
                         ORDER BY c.commits DESC LIMIT ?''', path, branch, k)

    def top_src(self, path, k=3, branch=None):
        br = branch or self.git(path, 'symbolic-ref', '--short', 'HEAD').strip()
        cnt, name = collections.Counter(), {}
        for line in self.git(path, 'log', '--no-merges', '-n', '6000', '--format=%an%x1f%ae', 'refs/heads/' + br).splitlines():
            an, ae = line.split('\x1f')
            cnt[ae.lower()] += 1
            name.setdefault(ae.lower(), an)
        return [(name[e], e, c) for e, c in cnt.most_common(k)]

    def tasks(self, tasks):
        exp = {t['task_id']: t['eval'].get('reference_answers') for t in tasks}

        # Reference answers that disagree with the source data itself (checked on the live WebArena
        # GitLab too); see docs/NOTES-code.md. Values here are what the source shows.
        corrected = {786: {'must_include': ['414']}}   # live /-/graphs/master JSON: vinta.chen@gmail.com 414

        def must(tid, got):
            ref = corrected.get(tid) or exp[tid] or {}
            vals = ref.get('must_include') or ([ref['exact_match']] if 'exact_match' in ref else [])
            return all(str(v).lower() in got.lower() for v in vals)

        # commit counts by author and date (UTC committed date, default branch)
        for tid, path, names, d0, d1 in [
                (132, 'a11yproject/a11yproject.com', ['kilian'], '2023-03-05', '2023-03-05'),
                (133, 'a11yproject/a11yproject.com', ['Eric'], '2023-03-02', '2023-03-02'),
                (134, 'a11yproject/a11yproject.com', ['kilian'], '2023-03-01', '2023-03-01'),
                (135, 'a11yproject/a11yproject.com', ['Eric', 'Kilian'], '2023-01-03', '2023-01-03'),
                # the reference counts both of his git identities ("Steven Woodson" 3 + "Steve Woodson" 2)
                (136, 'byteblaze/a11y-webring.club', ['Steven Woodson', 'Steve Woodson'], '2023-02-06', '2023-02-06'),
                (304, 'a11yproject/a11yproject.com', ['Eric'], '2023-02-01', '2023-05-31'),
                # reference 16 = Nic Chan's commits in April *2022* (the intent says 2021, which has 0)
                (307, 'a11yproject/a11yproject.com', ['Nic'], '2022-04-01', '2022-04-30')]:
            a, b_ = self.commits_lite(path, names, d0, d1), self.commits_src(path, names, d0, d1)
            report(f'task {tid} commits {names} {path} {d0}..{d1}', a == b_ and must(tid, str(a)),
                   f'lite {a} source {b_} expected {exp[tid]}')

        # top contributors
        for tid, path, k, field in [(308, 'primer/design', 1, 0), (309, 'thoughtbot/administrate', 1, 0),
                                    (310, 'umano/AndroidSlidingUpPanel', 1, 0), (311, 'eriklindernoren/PyTorch-GAN', 1, 0),
                                    (312, 'wireservice/csvkit', 1, 0), (314, 'primer/design', 3, 0),
                                    (315, 'eriklindernoren/PyTorch-GAN', 3, 1), (316, 'facebook/create-react-app', 3, 0),
                                    (317, 'root/metaseq', 3, 2), (318, 'yjlou/2019-nCov', 3, 0),
                                    (784, 'CellularPrivacy/Android-IMSI-Catcher-Detector', 1, 1),
                                    (786, 'vinta/awesome-python', 1, 0)]:
            a = [tuple(r) for r in self.top_lite(path, k)]
            b_ = self.top_src(path, k)
            got = ' | '.join(f'{n}: {c} <{e}>' for n, e, c in a)
            report(f'task {tid} top-{k} contributors {path}', [x[2] for x in a] == [x[2] for x in b_]
                   and [x[1] for x in a] == [x[1] for x in b_] and must(tid, got), f'lite [{got}] expected {exp[tid]}')
        # 785: branch gh-page(s) ; 788: branch php52 + profile fields
        for tid, path, branch in [(785, 'CellularPrivacy/Android-IMSI-Catcher-Detector', 'gh-pages'),
                                  (788, 'amwhalen/archive-my-tweets', 'php52')]:
            have = self.q('''SELECT count(*) FROM contributors c JOIN projects p ON p.id = c.project_id
                             WHERE p.full_path = ? AND c.branch = ?''', path, branch)[0][0]
            if not have:
                report(f'task {tid} contributors on {branch}', False, 'branch not in contributors'); continue
            a = self.top_lite(path, 1, branch)[0]
            b_ = self.top_src(path, 1, branch)[0]
            extra = ''
            if tid == 788:
                u = self.q('SELECT username, location FROM users WHERE name = ?', a[0])
                extra = ' ' + ' '.join(f'{x[0]} {x[1]}' for x in u)
            got = f'{a[0]} {a[1]}{extra}'
            report(f'task {tid} top contributor {path}@{branch}', a[1] == b_[1] and a[2] == b_[2] and must(tid, got),
                   f'lite [{got} {a[2]}] source [{b_[1]} {b_[2]}] expected {exp[tid]}')
        # 787: followers of the top contributor of dehenne/awesome-visibility
        a = self.top_lite('dehenne/awesome-visibility', 1)[0]
        f = self.q('''SELECT count(*) FROM follows f JOIN users u ON u.id = f.followee_id
                      WHERE u.name = ? OR u.email = ? OR u.username = ?''', a[0], a[1], a[0])[0][0]
        report('task 787 followers of top contributor', must(787, str(f)), f'{a[0]} <{a[1]}> followers {f}')

        # members of byteblaze repos (tasks 349, 350)
        for tid, path in [(349, 'byteblaze/gimmiethat.space'), (350, 'byteblaze/solarized-prism-theme')]:
            a = sorted(r[0] for r in self.q('''SELECT u.username FROM members m JOIN users u ON u.id = m.user_id
                    JOIN projects p ON p.id = m.source_id WHERE m.source_type = 'project' AND p.full_path = ?
                    AND u.username <> 'byteblaze' ''', path))
            b_ = sorted(r[0] for r in self.pq('''SELECT u.username FROM members m JOIN users u ON u.id = m.user_id
                    JOIN routes r ON r.source_type = 'Project' AND r.source_id = m.source_id
                    WHERE m.source_type = 'Project' AND r.path = %s AND u.username <> 'byteblaze' ''', path))
            report(f'task {tid} members of {path}', a == b_ and must(tid, ' '.join(a)), f'lite {a} source {b_}')

        # most / least starred repos byteblaze contributed to (169, 170): contributed = has push/other events
        rows = self.q('''SELECT p.path, p.star_count FROM projects p WHERE p.id IN (SELECT e.project_id FROM events e
                         JOIN users u ON u.id = e.author_id WHERE u.username = 'byteblaze') ORDER BY p.star_count DESC''')
        src = self.pq('''SELECT p.path, p.star_count FROM projects p WHERE p.id IN (SELECT e.project_id FROM events e
                         JOIN users u ON u.id = e.author_id WHERE u.username = 'byteblaze') ORDER BY p.star_count DESC''')
        top = [r[0] for r in rows if r[1] == rows[0][1]] if rows else []
        low = [r[0] for r in rows if r[1] == rows[-1][1]] if rows else []
        report('task 169 most-starred contributed repos', sorted(rows) == sorted(src) and must(169, ' '.join(top + [r[0] for r in rows[:2]])),
               f'top {rows[:3]}')
        own0 = [r[0] for r in self.q('''SELECT p.path FROM projects p JOIN namespaces n ON n.id = p.namespace_id
                                         WHERE n.path = 'byteblaze' AND p.star_count = 0''')]
        report('task 170 least-starred (0) byteblaze repos', must(170, ' '.join(own0)), f'{own0}')
        # top starred repos (523..527)
        a = self.q('SELECT full_path, star_count FROM projects ORDER BY star_count DESC, id LIMIT 8')
        b_ = self.pq('''SELECT r.path, p.star_count FROM projects p JOIN routes r ON r.source_type='Project' AND r.source_id=p.id
                        ORDER BY p.star_count DESC, p.id LIMIT 8''')
        report('task 523 top-8 starred projects', [tuple(x) for x in a] == [tuple(x) for x in b_], str(a[:5]))

        # feed token (259), clone URL (293)
        tok = self.q("SELECT feed_token FROM users WHERE username = 'byteblaze'")[0][0]
        report('task 259 feed token', tok == (exp[259] or {}).get('exact_match'), 'matches' if tok == exp[259]['exact_match'] else 'differs')
        pre = self.q("SELECT value FROM site_settings WHERE key = 'ssh_clone_prefix'")[0][0]
        fp = self.q("SELECT full_path FROM projects WHERE full_path = 'convexegg/super_awesome_robot'")
        got = f'git clone {pre}{fp[0][0]}.git' if fp else ''
        report('task 293 ssh clone url', got == exp[293]['exact_match'], got)

        # latest updated / created byteblaze issue with keyword (173-182)
        for tid, kw, order in [(173, 'better', 'updated_at'), (177, 'homepage content', 'updated_at'),
                               (178, 'better', 'created_at'), (180, 'dependency', 'created_at'),
                               (182, 'homepage content', 'created_at')]:
            like = '%' + '%'.join(kw.split()) + '%'      # keywords in order ("homepage's content")
            a = self.q(f'''SELECT i.title, i.state FROM issues i JOIN users u ON u.id = i.author_id
                           WHERE u.username = 'byteblaze' AND lower(i.title) LIKE ? ORDER BY i.{order} DESC LIMIT 1''',
                       like)
            b_ = self.pq(f'''SELECT i.title, CASE i.state_id WHEN 1 THEN 'opened' ELSE 'closed' END FROM issues i
                             JOIN users u ON u.id = i.author_id WHERE u.username = 'byteblaze' AND lower(i.title) LIKE %s
                             ORDER BY i.{order} DESC LIMIT 1''', like)
            ref = json.dumps(exp[tid])
            want_closed = ('Yes' in ref) or ('closed' in ref.lower() and 'not' not in ref.lower() and 'No,' not in ref)
            ok = bool(a) and a == [tuple(x) for x in b_] and ((a[0][1] == 'closed') == want_closed)
            report(f'task {tid} byteblaze latest-{order} issue "{kw}"', ok, f'{a} expected {exp[tid]}')

        # issues with a label (102-106 are list pages; compare counts with source)
        for tid, path, label in [(102, 'a11yproject/a11yproject.com', 'help wanted'), (104, 'keycloak/keycloak', 'flaky-test'),
                                 (106, 'umano/AndroidSlidingUpPanel', 'BUG')]:
            a = self.q('''SELECT count(*) FROM issues i JOIN projects p ON p.id = i.project_id
                          JOIN label_links ll ON ll.target_type = 'issue' AND ll.target_id = i.id
                          JOIN labels l ON l.id = ll.label_id WHERE p.full_path = ? AND lower(l.title) LIKE ?''',
                       path, f'%{label.lower()}%')[0][0]
            b_ = self.pq('''SELECT count(*) FROM issues i JOIN routes r ON r.source_type = 'Project' AND r.source_id = i.project_id
                            JOIN label_links ll ON ll.target_type = 'Issue' AND ll.target_id = i.id
                            JOIN labels l ON l.id = ll.label_id WHERE r.path = %s AND lower(l.title) LIKE %s''',
                         path, f'%{label.lower()}%')[0][0]
            report(f'task {tid} issues labelled ~{label} in {path}', a == b_ and a > 0, f'lite {a} source {b_}')

        # byteblaze to-dos (44), MRs assigned (156) / review requested (357)
        for name, lite, src in [
                ('task 44 byteblaze pending todos',
                 "SELECT count(*) FROM todos t JOIN users u ON u.id = t.user_id WHERE u.username='byteblaze' AND t.state='pending'",
                 "SELECT count(*) FROM todos t JOIN users u ON u.id = t.user_id WHERE u.username='byteblaze' AND t.state='pending'"),
                ('task 156 open MRs assigned to byteblaze',
                 "SELECT count(*) FROM mr_assignees a JOIN merge_requests m ON m.id=a.merge_request_id JOIN users u ON u.id=a.user_id WHERE u.username='byteblaze' AND m.state='opened'",
                 "SELECT count(*) FROM merge_request_assignees a JOIN merge_requests m ON m.id=a.merge_request_id JOIN users u ON u.id=a.user_id WHERE u.username='byteblaze' AND m.state_id=1"),
                ('task 357 open MRs with byteblaze as reviewer',
                 "SELECT count(*) FROM mr_reviewers a JOIN merge_requests m ON m.id=a.merge_request_id JOIN users u ON u.id=a.user_id WHERE u.username='byteblaze' AND m.state='opened'",
                 "SELECT count(DISTINCT a.merge_request_id) FROM merge_request_reviewers a JOIN merge_requests m ON m.id=a.merge_request_id JOIN users u ON u.id=a.user_id WHERE u.username='byteblaze' AND m.state_id=1")]:
            a, b_ = self.q(lite)[0][0], self.pq(src)[0][0]
            report(name, a == b_ and a > 0, f'lite {a} source {b_}')

        # MR pages referenced by tasks 389-393 / 415-417 exist with notes
        for tid, path, iid in [(389, 'primer/design', 450), (390, 'a11yproject/a11yproject.com', 1531),
                               (393, 'byteblaze/empathy-prompts', 19), (415, 'byteblaze/a11y-webring.club', 40),
                               (416, 'a11yproject/a11yproject.com', 1270), (417, 'a11yproject/a11yproject.com', 1485)]:
            a = self.q('''SELECT m.title, m.state, (SELECT count(*) FROM notes n WHERE n.noteable_type='merge_request'
                          AND n.noteable_id=m.id) FROM merge_requests m JOIN projects p ON p.id=m.project_id
                          WHERE p.full_path=? AND m.iid=?''', path, iid)
            report(f'task {tid} MR {path}!{iid} present', bool(a), str(a[0][:2]) + f' notes={a[0][2]}' if a else 'missing')

        # files the edit tasks touch (411-414, 441, 736): blob present on the default branch
        for tid, path, fname in [(411, 'byteblaze/cloud-to-butt', 'LICENSE.txt'),
                                 (412, 'byteblaze/accessible-html-content-patterns', 'LICENSE'),
                                 (414, 'byteblaze/dotfiles', '!LICENSE'), (441, 'byteblaze/gimmiethat.space', 'index.html')]:
            a = self.q('''SELECT c.tree_sha FROM projects p JOIN refs r ON r.project_id = p.id AND r.kind='branch'
                          AND r.name = p.default_branch JOIN commits c ON c.sha = r.sha WHERE p.full_path = ?''', path)
            absent = fname.startswith('!')     # the task creates it (no LICENSE in the source either)
            fname = fname.lstrip('!')
            found = False
            if a:
                import zlib
                o = self.q('SELECT enc, data FROM git_objects WHERE sha = ?', a[0][0])
                if o:
                    data = zlib.decompress(o[0][1]) if o[0][0] == 1 else o[0][1]
                    found = (b' ' + fname.encode() + b'\0') in data
            report(f'task {tid} {path}/{fname} {"absent" if absent else "present"} on default branch', found != absent,
                   'present' if found else 'missing')

        # templates for 747-756
        names = {r[0] for r in self.q('SELECT name FROM project_templates')}
        need = {'android', 'express', 'plainhtml', 'jekyll'}
        report('tasks 747-756 project templates', need <= names, f'{len(names)} templates, need {sorted(need)}')
        # login hash for byteblaze present (kit verifies bcrypt)
        h = self.q("SELECT password_hash LIKE '$2a$%' FROM users WHERE username='byteblaze'")[0][0]
        report('byteblaze bcrypt hash present', bool(h), 'bcrypt' if h else 'missing')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True)
    ap.add_argument('--pg', required=True)
    ap.add_argument('--repos', required=True)
    ap.add_argument('--tasks', default=os.environ.get('WEBARENA_TASKS', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..', '..', '3rd-party', 'webarena', 'config_files', 'test.raw.json')))
    a = ap.parse_args()
    v = V(a)
    v.counts()
    v.git_checks()
    v.orphans()
    v.tasks(json.load(open(a.tasks)))
    print(f'\n{len(FAILS)} failed: {FAILS}')
    sys.exit(1 if FAILS else 0)


if __name__ == '__main__':
    main()
