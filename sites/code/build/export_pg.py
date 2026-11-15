#!/usr/bin/env python3
"""Export the WebArena GitLab PostgreSQL DB into the lite schema (relational part).

Usage: python3 -I export_pg.py --pg 'host=127.0.0.1 port=7432 user=gitlab-psql dbname=gitlabhq_production' --out base.db

Writes every table in schema.sql except the git tables (import_git.py fills those) and
the build-only table _repos(project_id, disk_path, wiki_disk_path). Token/secret tables
(personal_access_tokens, oauth_*, keys, ci_*, deploy tokens, web hooks, ...) are never
read; token-ish user columns are not exported except users.feed_token (task 259).
"""
import argparse, os, re, sqlite3, sys, time, zlib

import psycopg

HERE = os.path.dirname(os.path.abspath(__file__))

VIS = {0: 'private', 10: 'internal', 20: 'public'}
ISSUE_STATE = {1: 'opened', 2: 'closed'}
MR_STATE = {1: 'opened', 2: 'closed', 3: 'merged', 4: 'locked'}
ISSUE_TYPE = {0: 'issue', 1: 'incident', 2: 'test_case', 3: 'requirement', 4: 'task', 5: 'objective', 6: 'key_result'}
USER_TYPE = {1: 'support_bot', 2: 'alert_bot', 3: 'visual_review_bot', 4: 'service_user', 5: 'ghost',
             6: 'project_bot', 7: 'migration_bot', 8: 'security_bot', 9: 'automation_bot',
             10: 'security_policy_bot', 11: 'admin_bot', 12: 'suggested_reviewers_bot'}
EVENT_ACTION = {1: 'created', 2: 'updated', 3: 'closed', 4: 'reopened', 5: 'pushed', 6: 'commented',
                7: 'merged', 8: 'joined', 9: 'left', 10: 'destroyed', 11: 'expired', 12: 'approved'}
EVENT_TARGET = {'Issue': 'issue', 'MergeRequest': 'merge_request', 'Note': 'note', 'DiffNote': 'note',
                'DiscussionNote': 'note', 'Milestone': 'milestone', 'WikiPage::Meta': 'wiki_page',
                'DesignManagement::Design': 'design', 'Project': 'project'}
TODO_ACTION = {1: 'assigned', 2: 'mentioned', 3: 'build_failed', 4: 'marked', 5: 'approval_required',
               6: 'unmergeable', 7: 'directly_addressed', 8: 'merge_train_removed', 9: 'review_requested',
               10: 'member_access_requested', 11: 'review_submitted'}
TARGET = {'Issue': 'issue', 'MergeRequest': 'merge_request', 'Commit': 'commit', 'Note': 'note',
          'Snippet': 'snippet', 'PersonalSnippet': 'snippet', 'ProjectSnippet': 'snippet'}
REVIEWER_STATE = {0: 'unreviewed', 1: 'reviewed', 2: 'requested_changes'}
RSTATE = {1: 'opened', 2: 'closed', 3: 'merged', 4: 'locked', 5: 'reopened'}
ADD_REMOVE = {1: 'add', 2: 'remove'}

MR_DIFF_FILE_MAX = 32768      # per-file diff text kept up to this many bytes
MR_DIFF_TOTAL_MAX = 32768     # per-MR diff text budget (files in order; later ones diff_omitted)
MR_FILES_MAX = 100            # first N files per MR (merge_requests.files_count keeps the total)
MR_COMMITS_MAX = 100


def ts(v):
    if v is None:
        return None
    if hasattr(v, 'utcoffset') and v.utcoffset() is not None:
        v = (v - v.utcoffset()).replace(tzinfo=None)
    return v.strftime('%Y-%m-%d %H:%M:%S')


def d(v):
    return v.isoformat() if v is not None else None


def b(v):
    return 1 if v else 0


def nz(*vals):
    for v in vals:
        if v not in (None, ''):
            return v
    return None


def strip_userinfo(url):
    if not url:
        return None
    return re.sub(r'^(\w+://)[^/@]*@', r'\1', url)


class Ex:
    def __init__(self, pg, out):
        self.pg = psycopg.connect(pg, autocommit=False)
        self.db = sqlite3.connect(out)
        self.db.execute('PRAGMA journal_mode=OFF')
        self.db.execute('PRAGMA synchronous=OFF')
        self.db.execute('PRAGMA cache_size=-1000000')

    def rows(self, sql, name=None, size=20000):
        cur = self.pg.cursor(name=name or 'c%d' % int(time.time() * 1e6))
        cur.itersize = size
        cur.execute(sql)
        for r in cur:
            yield r
        cur.close()

    def ins(self, table, cols, it):
        q = 'INSERT INTO %s (%s) VALUES (%s)' % (table, ','.join(cols), ','.join('?' * len(cols)))
        n = 0
        batch = []
        for r in it:
            batch.append(r)
            if len(batch) >= 20000:
                self.db.executemany(q, batch); n += len(batch); batch = []
        if batch:
            self.db.executemany(q, batch); n += len(batch)
        print(f'  {table}: {n}', flush=True)
        return n

    def run(self):
        db = self.db
        db.executescript(open(os.path.join(HERE, 'schema.sql')).read())
        db.execute('CREATE TABLE _repos (project_id INTEGER PRIMARY KEY, disk_path TEXT, wiki_disk_path TEXT)')
        t0 = time.time()

        # ---------------- users
        self.ins('users', ['id', 'username', 'name', 'email', 'public_email', 'commit_email', 'password_hash', 'state',
                           'is_admin', 'user_type', 'bio', 'website_url', 'location', 'organization', 'job_title',
                           'pronouns', 'twitter', 'linkedin', 'skype', 'avatar', 'private_profile', 'feed_token',
                           'projects_limit', 'can_create_group', 'created_at', 'updated_at', 'last_activity_on',
                           'last_sign_in_at'],
                 ((r[0], r[1], r[2] or r[1], r[3], nz(r[4]), nz(r[5]), r[6], r[7] or 'active', b(r[8]),
                   USER_TYPE.get(r[9]) if r[9] else None, nz(r[10]), nz(r[11], r[12]), nz(r[13], r[14]),
                   nz(r[15], r[16]), nz(r[17]), nz(r[18]), nz(r[19], r[20]), nz(r[21], r[22]), nz(r[23], r[24]),
                   ('avatars/user/%d/%s' % (r[0], r[25])) if r[25] else None, b(r[26]), r[27], r[28] or 0, b(r[29]),
                   ts(r[30]), ts(r[31]), d(r[32]), ts(r[33]))
                  for r in self.rows('''
                    SELECT u.id, u.username, u.name, u.email, u.public_email, u.commit_email, u.encrypted_password,
                           u.state, u.admin, u.user_type, ud.bio, u.website_url, ud.website_url, u.location, ud.location,
                           u.organization, ud.organization, ud.job_title, ud.pronouns, u.twitter, ud.twitter,
                           u.linkedin, ud.linkedin, u.skype, ud.skype, u.avatar, u.private_profile, u.feed_token,
                           u.projects_limit, u.can_create_group, u.created_at, u.updated_at, u.last_activity_on,
                           u.last_sign_in_at
                    FROM users u LEFT JOIN user_details ud ON ud.user_id = u.id ORDER BY u.id''')))
        # Only byteblaze's feed token is referenced by a task; blank everyone else's.
        db.execute("UPDATE users SET feed_token = NULL WHERE username <> 'byteblaze'")
        # Users without a usable bcrypt hash cannot log in.
        db.execute("UPDATE users SET password_hash = NULL WHERE password_hash NOT LIKE '$2%'")

        self.ins('user_statuses', ['user_id', 'emoji', 'message', 'availability', 'clear_status_at'],
                 ((r[0], r[1] or 'speech_balloon', r[2], {0: 'not_set', 1: 'busy'}.get(r[3], 'not_set'), ts(r[4]))
                  for r in self.rows('SELECT user_id, emoji, message, availability, clear_status_at FROM user_statuses')))
        self.ins('follows', ['follower_id', 'followee_id', 'created_at'],
                 self.rows('SELECT follower_id, followee_id, NULL FROM user_follow_users'))

        # ---------------- namespaces (routes give full_path)
        self.ins('namespaces', ['id', 'kind', 'path', 'name', 'full_path', 'parent_id', 'owner_id', 'description',
                                'visibility', 'avatar', 'request_access_enabled', 'created_at', 'updated_at'],
                 ((r[0], 'group' if r[1] == 'Group' else 'user', r[2], r[3], r[4], r[5], r[6] if r[1] != 'Group' else None,
                   nz(r[7]), VIS.get(r[8], 'public'), ('avatars/group/%d/%s' % (r[0], r[9])) if r[9] else None,
                   b(r[10]), ts(r[11]), ts(r[12]))
                  for r in self.rows('''
                    SELECT n.id, n.type, n.path, n.name, r.path, n.parent_id, n.owner_id, n.description,
                           n.visibility_level, n.avatar, n.request_access_enabled, n.created_at, n.updated_at
                    FROM namespaces n JOIN routes r ON r.source_type = 'Namespace' AND r.source_id = n.id
                    WHERE n.type IN ('User', 'Group') ORDER BY n.id''')))

        self.ins('members', ['id', 'source_type', 'source_id', 'user_id', 'access_level', 'created_by_id', 'invite_email',
                             'invite_accepted_at', 'requested_at', 'expires_at', 'created_at', 'updated_at'],
                 ((r[0], 'project' if r[1] == 'Project' else 'namespace', r[2], r[3], r[4], r[5], r[6], ts(r[7]),
                   ts(r[8]), d(r[9]), ts(r[10]), ts(r[11]))
                  for r in self.rows('''SELECT id, source_type, source_id, user_id, access_level, created_by_id,
                    invite_email, invite_accepted_at, requested_at, expires_at, created_at, updated_at
                    FROM members ORDER BY id''')))

        # ---------------- projects
        self.ins('projects', ['id', 'namespace_id', 'path', 'name', 'full_path', 'description', 'visibility',
                              'creator_id', 'archived', 'star_count', 'forked_from_id', 'repository_size', 'import_url',
                              'issues_enabled', 'merge_requests_enabled', 'wiki_enabled', 'forking_enabled',
                              'created_at', 'updated_at', 'last_activity_at'],
                 ((r[0], r[1], r[2], r[3], r[4], nz(r[5]), VIS.get(r[6], 'public'), r[7], b(r[8]), r[9] or 0, r[10],
                   r[11] or 0, strip_userinfo(r[12]), b(r[13] is None or r[13] > 0), b(r[14] is None or r[14] > 0),
                   b(r[15] is None or r[15] > 0), b(r[16] is None or r[16] > 0), ts(r[17]), ts(r[18]), ts(r[19]))
                  for r in self.rows('''
                    SELECT p.id, p.namespace_id, p.path, p.name, r.path, p.description, p.visibility_level, p.creator_id,
                           p.archived, p.star_count, f.forked_from_project_id, s.repository_size, p.import_url,
                           pf.issues_access_level, pf.merge_requests_access_level, pf.wiki_access_level,
                           pf.forking_access_level, p.created_at, p.updated_at, p.last_activity_at
                    FROM projects p JOIN routes r ON r.source_type = 'Project' AND r.source_id = p.id
                    LEFT JOIN fork_network_members f ON f.project_id = p.id
                    LEFT JOIN project_statistics s ON s.project_id = p.id
                    LEFT JOIN project_features pf ON pf.project_id = p.id
                    WHERE NOT p.pending_delete ORDER BY p.id''')))
        self.ins('_repos', ['project_id', 'disk_path', 'wiki_disk_path'],
                 ((r[0], r[1], r[1] + '.wiki') for r in self.rows('SELECT project_id, disk_path FROM project_repositories')))
        self.ins('stars', ['user_id', 'project_id', 'created_at'],
                 ((r[0], r[1], ts(r[2])) for r in self.rows(
                     'SELECT user_id, project_id, created_at FROM users_star_projects')))
        self.ins('protected_branches', ['id', 'project_id', 'name', 'allow_force_push', 'created_at'],
                 ((r[0], r[1], r[2], b(r[3]), ts(r[4])) for r in self.rows(
                     'SELECT id, project_id, name, allow_force_push, created_at FROM protected_branches')))

        # ---------------- labels / milestones
        self.ins('labels', ['id', 'project_id', 'group_id', 'title', 'color', 'description', 'created_at', 'updated_at'],
                 ((r[0], r[1], r[2], r[3], r[4], nz(r[5]), ts(r[6]), ts(r[7])) for r in self.rows(
                     'SELECT id, project_id, group_id, title, color, description, created_at, updated_at FROM labels '
                     'WHERE NOT template ORDER BY id')))
        self.ins('milestones', ['id', 'project_id', 'group_id', 'iid', 'title', 'description', 'state', 'start_date',
                                'due_date', 'created_at', 'updated_at'],
                 ((r[0], r[1], r[2], r[3], r[4], nz(r[5]), r[6] or 'active', d(r[7]), d(r[8]), ts(r[9]), ts(r[10]))
                  for r in self.rows('SELECT id, project_id, group_id, iid, title, description, state, start_date, '
                                     'due_date, created_at, updated_at FROM milestones ORDER BY id')))
        self.ins('label_links', ['label_id', 'target_type', 'target_id', 'created_at'],
                 ((r[0], TARGET[r[1]], r[2], ts(r[3])) for r in self.rows(
                     "SELECT DISTINCT ON (target_type, target_id, label_id) label_id, target_type, target_id, created_at "
                     "FROM label_links WHERE target_type IN ('Issue','MergeRequest') AND label_id IN (SELECT id FROM labels) "
                     "ORDER BY target_type, target_id, label_id")))

        # ---------------- issues
        self.ins('issues', ['id', 'project_id', 'iid', 'title', 'description', 'state', 'issue_type', 'author_id',
                            'milestone_id', 'due_date', 'confidential', 'discussion_locked', 'weight', 'upvotes',
                            'created_at', 'updated_at', 'updated_by_id', 'closed_at', 'closed_by_id', 'last_edited_at',
                            'last_edited_by_id'],
                 ((r[0], r[1], r[2], r[3], r[4], ISSUE_STATE.get(r[5], 'opened'), ISSUE_TYPE.get(r[6], 'issue'), r[7],
                   r[8], d(r[9]), b(r[10]), b(r[11]), r[12], r[13] or 0, ts(r[14]), ts(r[15]), r[16], ts(r[17]), r[18],
                   ts(r[19]), r[20])
                  for r in self.rows('''SELECT id, project_id, iid, title, description, state_id, issue_type, author_id,
                    milestone_id, due_date, confidential, discussion_locked, weight, upvotes_count, created_at, updated_at,
                    updated_by_id, closed_at, closed_by_id, last_edited_at, last_edited_by_id FROM issues
                    WHERE project_id IS NOT NULL ORDER BY id''')))
        self.ins('issue_assignees', ['issue_id', 'user_id'],
                 self.rows('SELECT DISTINCT issue_id, user_id FROM issue_assignees'))

        # ---------------- merge requests
        self.ins('merge_requests', ['id', 'project_id', 'iid', 'title', 'description', 'state', 'draft', 'author_id',
                                    'source_project_id', 'source_branch', 'target_branch', 'milestone_id', 'merge_status',
                                    'head_sha', 'base_sha', 'start_sha', 'merge_commit_sha', 'squash', 'commits_count',
                                    'files_count', 'discussion_locked', 'created_at', 'updated_at', 'merged_at',
                                    'merged_by_id', 'closed_at', 'closed_by_id', 'last_edited_at', 'last_edited_by_id'],
                 ((r[0], r[1], r[2], r[3], r[4], MR_STATE.get(r[5], 'opened'), b(r[6]), r[7], r[8], r[9], r[10], r[11],
                   r[12], r[13], r[14], r[15], r[16], b(r[17]), r[18] or 0, r[19] or 0, b(r[20]), ts(r[21]), ts(r[22]),
                   ts(r[23]), r[24], ts(r[25]), r[26], ts(r[27]), r[28])
                  for r in self.rows('''
                    SELECT m.id, m.target_project_id, m.iid, m.title, m.description, m.state_id, m.draft, m.author_id,
                           m.source_project_id, m.source_branch, m.target_branch, m.milestone_id, m.merge_status,
                           md.head_commit_sha, md.base_commit_sha, md.start_commit_sha,
                           coalesce(m.merge_commit_sha, encode(m.squash_commit_sha, 'hex')), m.squash,
                           md.commits_count, md.files_count, m.discussion_locked, m.created_at, m.updated_at,
                           mm.merged_at, coalesce(mm.merged_by_id, m.merge_user_id), mm.latest_closed_at,
                           mm.latest_closed_by_id, m.last_edited_at, m.last_edited_by_id
                    FROM merge_requests m
                    LEFT JOIN merge_request_diffs md ON md.id = m.latest_merge_request_diff_id
                    LEFT JOIN merge_request_metrics mm ON mm.merge_request_id = m.id
                    ORDER BY m.id''')))
        self.ins('mr_assignees', ['merge_request_id', 'user_id'],
                 self.rows('SELECT DISTINCT merge_request_id, user_id FROM merge_request_assignees'))
        self.ins('mr_reviewers', ['merge_request_id', 'user_id', 'state', 'created_at'],
                 ((r[0], r[1], REVIEWER_STATE.get(r[2], 'unreviewed'), ts(r[3])) for r in self.rows(
                     'SELECT DISTINCT ON (merge_request_id, user_id) merge_request_id, user_id, state, created_at '
                     'FROM merge_request_reviewers ORDER BY merge_request_id, user_id, id')))
        self.ins('mr_approvals', ['merge_request_id', 'user_id', 'created_at'],
                 ((r[0], r[1], ts(r[2])) for r in self.rows(
                     'SELECT DISTINCT ON (merge_request_id, user_id) merge_request_id, user_id, created_at '
                     'FROM approvals ORDER BY merge_request_id, user_id, id')))

        # MR diff files (latest version), with a size budget for the diff text.
        total_files = {}

        def diff_rows():
            cur_mr, used, k = None, 0, 0
            for r in self.rows('''
                SELECT m.id, f.relative_order, f.old_path, f.new_path, f.a_mode, f.b_mode, f.new_file, f.renamed_file,
                       f.deleted_file, f."binary", f.too_large, f.diff
                FROM merge_requests m JOIN merge_request_diff_files f ON f.merge_request_diff_id = m.latest_merge_request_diff_id
                ORDER BY m.id, f.relative_order''', size=5000):
                mr, diff = r[0], r[11] or ''
                if mr != cur_mr:
                    cur_mr, used, k = mr, 0, 0
                k += 1
                total_files[mr] = k
                if k > MR_FILES_MAX:
                    continue
                add = dele = 0
                for line in diff.split('\n'):
                    if line.startswith('+') and not line.startswith('+++'):
                        add += 1
                    elif line.startswith('-') and not line.startswith('---'):
                        dele += 1
                raw = diff.encode('utf-8', 'replace')
                omitted = 0
                blob = None
                if diff and not r[10]:
                    if len(raw) > MR_DIFF_FILE_MAX or used + len(raw) > MR_DIFF_TOTAL_MAX:
                        omitted = 1
                    else:
                        used += len(raw)
                        blob = zlib.compress(raw, 6)
                yield (mr, k - 1, None if r[2] == r[3] else r[2], r[3], r[4], r[5], b(r[6]), b(r[7]), b(r[8]), b(r[9]), b(r[10]), omitted,
                       add, dele, blob)
        self.ins('mr_diff_files', ['merge_request_id', 'ord', 'old_path', 'new_path', 'a_mode', 'b_mode', 'new_file',
                                   'renamed_file', 'deleted_file', 'binary', 'too_large', 'diff_omitted', 'additions',
                                   'deletions', 'diff'], diff_rows())
        db.execute('''UPDATE merge_requests SET
              additions = coalesce((SELECT sum(additions) FROM mr_diff_files f WHERE f.merge_request_id = merge_requests.id), 0),
              deletions = coalesce((SELECT sum(deletions) FROM mr_diff_files f WHERE f.merge_request_id = merge_requests.id), 0)''')
        db.executemany('UPDATE merge_requests SET files_count = ? WHERE id = ?', [(n, m) for m, n in total_files.items()])

        self.ins('mr_commits', ['merge_request_id', 'ord', 'sha', 'title', 'author_name', 'author_email', 'authored_at',
                                'committed_at'],
                 ((r[0], r[1], r[2].hex() if isinstance(r[2], (bytes, memoryview)) else r[2],
                   (r[3] or '').split('\n', 1)[0][:500], r[4], r[5], ts(r[6]), ts(r[7]))
                  for r in self.rows(f'''
                    SELECT m.id, c.relative_order, c.sha, c.message, u.name, u.email, c.authored_date, c.committed_date
                    FROM merge_requests m
                    JOIN merge_request_diff_commits c ON c.merge_request_diff_id = m.latest_merge_request_diff_id
                         AND c.relative_order < {MR_COMMITS_MAX}
                    LEFT JOIN merge_request_diff_commit_users u ON u.id = c.commit_author_id
                    ORDER BY m.id, c.relative_order''', size=20000)))

        # ---------------- notes
        self.ins('notes', ['id', 'project_id', 'noteable_type', 'noteable_id', 'commit_sha', 'author_id', 'body', 'system',
                           'system_action', 'internal', 'type', 'discussion_id', 'position', 'resolved_at',
                           'resolved_by_id', 'created_at', 'updated_at', 'last_edited_at'],
                 ((r[0], r[1], TARGET.get(r[2], (r[2] or '').lower()), r[3], nz(r[4]), r[5], r[6] or '', b(r[7]), r[8],
                   b(r[9]), r[10], r[11], r[12], ts(r[13]), r[14], ts(r[15]), ts(r[16]), ts(r[17]))
                  for r in self.rows('''
                    SELECT n.id, n.project_id, n.noteable_type, n.noteable_id, n.commit_id, n.author_id, n.note, n.system,
                           sm.action, coalesce(n.internal, n.confidential, false), n.type, n.discussion_id, n.position,
                           n.resolved_at, n.resolved_by_id, n.created_at, n.updated_at, n.last_edited_at
                    FROM notes n LEFT JOIN system_note_metadata sm ON sm.note_id = n.id ORDER BY n.id''')))
        self.ins('award_emoji', ['id', 'user_id', 'awardable_type', 'awardable_id', 'name', 'created_at'],
                 ((r[0], r[1], TARGET.get(r[2], r[2]), r[3], r[4], ts(r[5])) for r in self.rows(
                     'SELECT id, user_id, awardable_type, awardable_id, name, created_at FROM award_emoji')))

        # ---------------- resource events
        def res_events():
            for r in self.rows('SELECT id, issue_id, merge_request_id, user_id, action, label_id, created_at '
                               'FROM resource_label_events WHERE epic_id IS NULL ORDER BY id'):
                yield ('label', 'issue' if r[1] else 'merge_request', r[1] or r[2], r[3], ADD_REMOVE.get(r[4]), r[5],
                       None, None, ts(r[6]))
            for r in self.rows('SELECT id, issue_id, merge_request_id, user_id, state, created_at '
                               'FROM resource_state_events WHERE epic_id IS NULL ORDER BY id'):
                yield ('state', 'issue' if r[1] else 'merge_request', r[1] or r[2], r[3], None, None, None,
                       RSTATE.get(r[4]), ts(r[5]))
            for r in self.rows('SELECT id, issue_id, merge_request_id, user_id, action, milestone_id, created_at '
                               'FROM resource_milestone_events ORDER BY id'):
                yield ('milestone', 'issue' if r[1] else 'merge_request', r[1] or r[2], r[3], ADD_REMOVE.get(r[4]), None,
                       r[5], None, ts(r[6]))
        self.ins('resource_events', ['kind', 'target_type', 'target_id', 'user_id', 'action', 'label_id', 'milestone_id',
                                     'state', 'created_at'], res_events())

        # ---------------- events (+ push payloads), todos
        self.ins('events', ['id', 'project_id', 'group_id', 'author_id', 'action', 'target_type', 'target_id',
                            'target_title', 'push_ref', 'push_ref_type', 'push_action', 'push_commit_count',
                            'push_commit_from', 'push_commit_to', 'push_commit_title', 'created_at'],
                 ((r[0], r[1], r[2], r[3], EVENT_ACTION.get(r[4], str(r[4])), EVENT_TARGET.get(r[5], r[5]), r[6],
                   r[7], r[8], {0: 'branch', 1: 'tag'}.get(r[9]), {0: 'created', 1: 'removed', 2: 'pushed'}.get(r[10]),
                   r[11], r[12].hex() if r[12] else None, r[13].hex() if r[13] else None, r[14], ts(r[15]))
                  for r in self.rows('''
                    SELECT e.id, e.project_id, e.group_id, e.author_id, e.action, e.target_type, e.target_id,
                           coalesce(i.title, m.title, ms.title), pp.ref, pp.ref_type, pp.action, pp.commit_count,
                           pp.commit_from, pp.commit_to, pp.commit_title, e.created_at
                    FROM events e
                    LEFT JOIN issues i ON e.target_type = 'Issue' AND i.id = e.target_id
                    LEFT JOIN merge_requests m ON e.target_type = 'MergeRequest' AND m.id = e.target_id
                    LEFT JOIN milestones ms ON e.target_type = 'Milestone' AND ms.id = e.target_id
                    LEFT JOIN push_event_payloads pp ON pp.event_id = e.id
                    ORDER BY e.id''')))
        self.ins('todos', ['id', 'user_id', 'project_id', 'group_id', 'target_type', 'target_id', 'commit_sha', 'author_id',
                           'note_id', 'action', 'state', 'created_at', 'updated_at'],
                 ((r[0], r[1], r[2], r[3], TARGET.get(r[4], r[4]), r[5], r[6], r[7], r[8], TODO_ACTION.get(r[9], str(r[9])),
                   r[10], ts(r[11]), ts(r[12]))
                  for r in self.rows('SELECT id, user_id, project_id, group_id, target_type, target_id, commit_id, '
                                     'author_id, note_id, action, state, created_at, updated_at FROM todos ORDER BY id')))

        # ---------------- derived counters
        db.executescript('''
          UPDATE issues SET user_notes_count = (SELECT count(*) FROM notes n WHERE n.noteable_type = 'issue'
              AND n.noteable_id = issues.id AND n.system = 0),
            upvotes = (SELECT count(*) FROM award_emoji a WHERE a.awardable_type = 'issue' AND a.awardable_id = issues.id AND a.name = 'thumbsup'),
            downvotes = (SELECT count(*) FROM award_emoji a WHERE a.awardable_type = 'issue' AND a.awardable_id = issues.id AND a.name = 'thumbsdown');
          UPDATE merge_requests SET user_notes_count = (SELECT count(*) FROM notes n WHERE n.noteable_type = 'merge_request'
              AND n.noteable_id = merge_requests.id AND n.system = 0),
            upvotes = (SELECT count(*) FROM award_emoji a WHERE a.awardable_type = 'merge_request' AND a.awardable_id = merge_requests.id AND a.name = 'thumbsup'),
            downvotes = (SELECT count(*) FROM award_emoji a WHERE a.awardable_type = 'merge_request' AND a.awardable_id = merge_requests.id AND a.name = 'thumbsdown');
          UPDATE projects SET
            forks_count = (SELECT count(*) FROM projects f WHERE f.forked_from_id = projects.id),
            open_issues_count = (SELECT count(*) FROM issues i WHERE i.project_id = projects.id AND i.state = 'opened'),
            open_merge_requests_count = (SELECT count(*) FROM merge_requests m WHERE m.project_id = projects.id AND m.state = 'opened');
        ''')
        db.commit()
        print(f'export_pg done in {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--pg', required=True)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    for s in ('', '-journal', '-wal', '-shm'):
        if os.path.exists(a.out + s):
            os.remove(a.out + s)
    Ex(a.pg, a.out).run()
