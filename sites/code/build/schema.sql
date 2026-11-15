-- websandbox code hosting (gitlab.wa) lite schema. Documented in ../SCHEMA.md.
-- Conventions: ids are the source GitLab ids (stable, so tasks/graders can use them);
-- timestamps are TEXT 'YYYY-MM-DD HH:MM:SS' UTC; dates 'YYYY-MM-DD'; booleans 0/1;
-- git object ids are lowercase 40-char hex TEXT.

CREATE TABLE site_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- ---------------------------------------------------------------- people
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  public_email TEXT,
  commit_email TEXT,
  password_hash TEXT,              -- bcrypt ($2a$10$..., Devise, no pepper); NULL = cannot log in
  state TEXT NOT NULL DEFAULT 'active',   -- active | blocked | deactivated
  is_admin INTEGER NOT NULL DEFAULT 0,
  user_type TEXT,                  -- NULL = human; else bot kind (ghost, alert_bot, support_bot, ...)
  bio TEXT, website_url TEXT, location TEXT, organization TEXT, job_title TEXT, pronouns TEXT,
  twitter TEXT, linkedin TEXT, skype TEXT,
  avatar TEXT,                     -- media-relative path (media/avatars/...) or NULL (letter avatar)
  private_profile INTEGER NOT NULL DEFAULT 0,
  feed_token TEXT,                 -- RSS feed token (WebArena task 259 reads byteblaze's); not a credential elsewhere
  projects_limit INTEGER NOT NULL DEFAULT 100000,
  can_create_group INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_activity_on TEXT,
  last_sign_in_at TEXT
);
CREATE INDEX users_email ON users(email COLLATE NOCASE);
CREATE INDEX users_name ON users(name COLLATE NOCASE);

CREATE TABLE user_statuses (       -- "Set status" (emoji + message + busy)
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  emoji TEXT NOT NULL DEFAULT 'speech_balloon',
  message TEXT,
  availability TEXT NOT NULL DEFAULT 'not_set',   -- not_set | busy
  clear_status_at TEXT
);

CREATE TABLE follows (
  follower_id INTEGER NOT NULL REFERENCES users(id),
  followee_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT,                 -- NULL for source rows (GitLab does not record it)
  PRIMARY KEY (follower_id, followee_id)
) WITHOUT ROWID;
CREATE INDEX follows_followee ON follows(followee_id);

-- ---------------------------------------------------------------- namespaces
-- Every user has one namespace (kind 'user', path = username); groups are kind 'group'
-- (parent_id for subgroups). Projects live in a namespace; full_path is the URL path.
CREATE TABLE namespaces (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,              -- user | group
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  full_path TEXT NOT NULL UNIQUE COLLATE NOCASE,
  parent_id INTEGER REFERENCES namespaces(id),
  owner_id INTEGER REFERENCES users(id),     -- for kind 'user'
  description TEXT,
  visibility TEXT NOT NULL DEFAULT 'public', -- private | internal | public
  avatar TEXT,
  request_access_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX namespaces_owner ON namespaces(owner_id);
CREATE INDEX namespaces_parent ON namespaces(parent_id);

-- Project and group membership; pending invites are rows with user_id NULL and invite_email set
-- (or user_id set and invite_accepted_at NULL for invited existing users, as GitLab does not do).
-- access_level: 10 guest, 20 reporter, 30 developer, 40 maintainer, 50 owner (5 minimal access).
CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL,       -- project | namespace (group)
  source_id INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  access_level INTEGER NOT NULL,
  created_by_id INTEGER REFERENCES users(id),
  invite_email TEXT,
  invite_accepted_at TEXT,
  requested_at TEXT,               -- access request (not yet approved)
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX members_source ON members(source_type, source_id);
CREATE INDEX members_user ON members(user_id);

-- ---------------------------------------------------------------- projects
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  namespace_id INTEGER NOT NULL REFERENCES namespaces(id),
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  full_path TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- namespace full_path + '/' + path
  description TEXT,
  visibility TEXT NOT NULL,        -- private | internal | public
  creator_id INTEGER REFERENCES users(id),
  default_branch TEXT,             -- NULL = empty repository
  archived INTEGER NOT NULL DEFAULT 0,
  star_count INTEGER NOT NULL DEFAULT 0,      -- denormalised count of stars rows (as GitLab)
  forks_count INTEGER NOT NULL DEFAULT 0,     -- direct forks (projects.forked_from_id = id)
  forked_from_id INTEGER REFERENCES projects(id),
  open_issues_count INTEGER NOT NULL DEFAULT 0,
  open_merge_requests_count INTEGER NOT NULL DEFAULT 0,
  commit_count INTEGER NOT NULL DEFAULT 0,    -- commits on the default branch
  repository_size INTEGER NOT NULL DEFAULT 0, -- bytes, from GitLab project_statistics
  import_url TEXT,                 -- original upstream (GitHub) URL, credentials stripped
  issues_enabled INTEGER NOT NULL DEFAULT 1,
  merge_requests_enabled INTEGER NOT NULL DEFAULT 1,
  wiki_enabled INTEGER NOT NULL DEFAULT 1,
  forking_enabled INTEGER NOT NULL DEFAULT 1,
  objects_policy TEXT NOT NULL DEFAULT 'full', -- full | heads | default (which trees/blobs are stored; SCHEMA.md)
  template_name TEXT,              -- set when created from a built-in template
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_activity_at TEXT
);
CREATE INDEX projects_namespace ON projects(namespace_id);
CREATE INDEX projects_forked_from ON projects(forked_from_id);
CREATE INDEX projects_stars ON projects(star_count DESC);
CREATE INDEX projects_activity ON projects(last_activity_at DESC);

CREATE TABLE stars (
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, project_id)
) WITHOUT ROWID;
CREATE INDEX stars_project ON stars(project_id);

CREATE TABLE protected_branches (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,              -- branch name or wildcard
  allow_force_push INTEGER NOT NULL DEFAULT 0,
  created_at TEXT
);
CREATE INDEX protected_branches_project ON protected_branches(project_id);

-- ---------------------------------------------------------------- labels / milestones
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),     -- project label, or
  group_id INTEGER REFERENCES namespaces(id),     -- group label
  title TEXT NOT NULL,
  color TEXT NOT NULL,
  description TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX labels_project ON labels(project_id, title);
CREATE INDEX labels_group ON labels(group_id);

CREATE TABLE milestones (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  group_id INTEGER REFERENCES namespaces(id),
  iid INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL DEFAULT 'active',  -- active | closed
  start_date TEXT,
  due_date TEXT,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX milestones_project ON milestones(project_id);
CREATE INDEX milestones_group ON milestones(group_id);

-- label_links: target_type 'issue' | 'merge_request'
CREATE TABLE label_links (
  label_id INTEGER NOT NULL REFERENCES labels(id),
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  created_at TEXT,
  PRIMARY KEY (target_type, target_id, label_id)
) WITHOUT ROWID;
CREATE INDEX label_links_label ON label_links(label_id, target_type);

-- ---------------------------------------------------------------- issues
CREATE TABLE issues (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  iid INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,             -- opened | closed
  issue_type TEXT NOT NULL DEFAULT 'issue',   -- issue | incident | test_case | task
  author_id INTEGER REFERENCES users(id),
  milestone_id INTEGER REFERENCES milestones(id),
  due_date TEXT,
  confidential INTEGER NOT NULL DEFAULT 0,
  discussion_locked INTEGER NOT NULL DEFAULT 0,
  weight INTEGER,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  user_notes_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  updated_by_id INTEGER,
  closed_at TEXT,
  closed_by_id INTEGER,
  last_edited_at TEXT,
  last_edited_by_id INTEGER,
  UNIQUE (project_id, iid)
);
CREATE INDEX issues_project_state ON issues(project_id, state, created_at);
CREATE INDEX issues_author ON issues(author_id, state);
CREATE INDEX issues_updated ON issues(updated_at);
CREATE INDEX issues_milestone ON issues(milestone_id);

CREATE TABLE issue_assignees (
  issue_id INTEGER NOT NULL REFERENCES issues(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (issue_id, user_id)
) WITHOUT ROWID;
CREATE INDEX issue_assignees_user ON issue_assignees(user_id);

-- ---------------------------------------------------------------- merge requests
CREATE TABLE merge_requests (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),   -- target project
  iid INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  state TEXT NOT NULL,             -- opened | closed | merged | locked
  draft INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id),
  source_project_id INTEGER REFERENCES projects(id),
  source_branch TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  milestone_id INTEGER REFERENCES milestones(id),
  merge_status TEXT,               -- can_be_merged | cannot_be_merged | unchecked | ...
  head_sha TEXT, base_sha TEXT, start_sha TEXT,   -- latest diff version
  merge_commit_sha TEXT,
  squash INTEGER NOT NULL DEFAULT 0,
  commits_count INTEGER NOT NULL DEFAULT 0,
  files_count INTEGER NOT NULL DEFAULT 0,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  upvotes INTEGER NOT NULL DEFAULT 0,
  downvotes INTEGER NOT NULL DEFAULT 0,
  user_notes_count INTEGER NOT NULL DEFAULT 0,
  discussion_locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  merged_at TEXT, merged_by_id INTEGER,
  closed_at TEXT, closed_by_id INTEGER,
  last_edited_at TEXT, last_edited_by_id INTEGER,
  UNIQUE (project_id, iid)
);
CREATE INDEX mrs_project_state ON merge_requests(project_id, state, created_at);
CREATE INDEX mrs_author ON merge_requests(author_id, state);
CREATE INDEX mrs_source ON merge_requests(source_project_id, source_branch);
CREATE INDEX mrs_updated ON merge_requests(updated_at);

CREATE TABLE mr_assignees (
  merge_request_id INTEGER NOT NULL REFERENCES merge_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (merge_request_id, user_id)
) WITHOUT ROWID;
CREATE INDEX mr_assignees_user ON mr_assignees(user_id);

-- state: unreviewed | reviewed | requested_changes
CREATE TABLE mr_reviewers (
  merge_request_id INTEGER NOT NULL REFERENCES merge_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'unreviewed',
  created_at TEXT,
  PRIMARY KEY (merge_request_id, user_id)
) WITHOUT ROWID;
CREATE INDEX mr_reviewers_user ON mr_reviewers(user_id);

CREATE TABLE mr_approvals (
  merge_request_id INTEGER NOT NULL REFERENCES merge_requests(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT,
  PRIMARY KEY (merge_request_id, user_id)
) WITHOUT ROWID;
CREATE INDEX mr_approvals_user ON mr_approvals(user_id);

-- Files of the latest diff version (first 100 per MR; merge_requests.files_count = total;
-- additions/deletions there sum the stored files only). old_path NULL = same as new_path. diff: unified diff hunks (no ---/+++ header), zlib
-- (deflate, RFC1950) compressed; NULL when too_large or dropped by the size policy (diff_omitted=1).
CREATE TABLE mr_diff_files (
  merge_request_id INTEGER NOT NULL REFERENCES merge_requests(id),
  ord INTEGER NOT NULL,
  old_path TEXT, new_path TEXT NOT NULL,
  a_mode TEXT, b_mode TEXT,
  new_file INTEGER NOT NULL DEFAULT 0, renamed_file INTEGER NOT NULL DEFAULT 0,
  deleted_file INTEGER NOT NULL DEFAULT 0, binary INTEGER NOT NULL DEFAULT 0,
  too_large INTEGER NOT NULL DEFAULT 0, diff_omitted INTEGER NOT NULL DEFAULT 0,
  additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
  diff BLOB,
  PRIMARY KEY (merge_request_id, ord)
);

-- Commits of the latest diff version (newest first, ord 0 = head). Up to the first
-- 100 per MR (merge_requests.commits_count has the true count).
CREATE TABLE mr_commits (
  merge_request_id INTEGER NOT NULL REFERENCES merge_requests(id),
  ord INTEGER NOT NULL,
  sha TEXT NOT NULL,
  title TEXT,
  author_name TEXT, author_email TEXT,
  authored_at TEXT, committed_at TEXT,
  PRIMARY KEY (merge_request_id, ord)
) WITHOUT ROWID;

-- ---------------------------------------------------------------- notes, awards, events
-- noteable_type: issue | merge_request | commit (commit_sha set). system=1 rows are the
-- timeline notes GitLab writes ("added ~bug label", "mentioned in ...").
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  noteable_type TEXT NOT NULL,
  noteable_id INTEGER,
  commit_sha TEXT,
  author_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  system INTEGER NOT NULL DEFAULT 0,
  system_action TEXT,              -- system_note_metadata.action (label, assignee, commit, ...)
  internal INTEGER NOT NULL DEFAULT 0,
  type TEXT,                       -- NULL | DiscussionNote | DiffNote
  discussion_id TEXT,
  position TEXT,                   -- JSON diff position for DiffNote
  resolved_at TEXT, resolved_by_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  last_edited_at TEXT
);
CREATE INDEX notes_noteable ON notes(noteable_type, noteable_id, created_at);
CREATE INDEX notes_author ON notes(author_id);
CREATE INDEX notes_commit ON notes(project_id, commit_sha) WHERE commit_sha IS NOT NULL;

-- awardable_type: issue | merge_request | note; name: thumbsup | thumbsdown | ...
CREATE TABLE award_emoji (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  awardable_type TEXT NOT NULL,
  awardable_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT
);
CREATE INDEX award_emoji_target ON award_emoji(awardable_type, awardable_id);

-- Timeline of label / state / milestone changes (GitLab resource_*_events).
-- kind: label (action add|remove, label_id) | state (state) | milestone (action, milestone_id)
CREATE TABLE resource_events (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  target_type TEXT NOT NULL,       -- issue | merge_request
  target_id INTEGER NOT NULL,
  user_id INTEGER,
  action TEXT,
  label_id INTEGER, milestone_id INTEGER, state TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX resource_events_target ON resource_events(target_type, target_id, created_at);

-- Activity feed. action: created | updated | closed | reopened | pushed | commented |
-- merged | joined | left | destroyed | expired | approved. target_type: issue | merge_request |
-- note | milestone | project | NULL. push_* set for action 'pushed'.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),
  group_id INTEGER,
  author_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  target_title TEXT,
  push_ref TEXT, push_ref_type TEXT, push_action TEXT,   -- branch|tag ; created|removed|pushed
  push_commit_count INTEGER, push_commit_from TEXT, push_commit_to TEXT, push_commit_title TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX events_project ON events(project_id, created_at);
CREATE INDEX events_author ON events(author_id, created_at);

-- To-do list. target_type: issue | merge_request | commit; action: assigned | mentioned |
-- build_failed | marked | approval_required | unmergeable | directly_addressed | merge_train_removed | review_requested
CREATE TABLE todos (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  project_id INTEGER REFERENCES projects(id),
  group_id INTEGER,
  target_type TEXT NOT NULL,
  target_id INTEGER,
  commit_sha TEXT,
  author_id INTEGER REFERENCES users(id),
  note_id INTEGER,
  action TEXT NOT NULL,
  state TEXT NOT NULL,             -- pending | done
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX todos_user ON todos(user_id, state, created_at);

-- ---------------------------------------------------------------- git
-- Content-addressed trees and blobs, shared by all projects (forks dedupe for free).
-- type: blob | tree. data: the raw git object body (for trees the binary git format
-- "<mode> <name>\0<20-byte sha>"...), stored per enc: 0 raw, 1 zlib (deflate RFC1950).
-- omitted=1: content not stored (size/type policy, see SCHEMA.md); size is still the real size
-- and the sha the real git sha. A web edit adds rows with sha = sha1("<type> <len>\0" + body).
CREATE TABLE git_objects (
  sha TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  enc INTEGER NOT NULL DEFAULT 0,
  omitted INTEGER NOT NULL DEFAULT 0,
  binary INTEGER NOT NULL DEFAULT 0,  -- blob looks binary (NUL in first 8000 bytes)
  data BLOB
);

-- Commits are shared too (keyed by sha). tree_sha points into git_objects when the tree
-- was kept (has_tree=1); stats come from `git log --numstat` for every commit regardless.
CREATE TABLE commits (
  id INTEGER PRIMARY KEY,
  sha TEXT NOT NULL UNIQUE,
  tree_sha TEXT NOT NULL,
  parents TEXT NOT NULL DEFAULT '',    -- space-separated parent shas, first parent first
  author_name TEXT, author_email TEXT,
  authored_at TEXT,                    -- UTC
  author_tz INTEGER,                   -- author's UTC offset in minutes (e.g. -300)
  committer_name TEXT, committer_email TEXT,
  committed_at TEXT, committer_tz INTEGER,
  title TEXT,                          -- first line of message
  message TEXT,                        -- full message
  additions INTEGER, deletions INTEGER, files_changed INTEGER,   -- vs first parent (numstat)
  has_tree INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX commits_author_email ON commits(author_email COLLATE NOCASE);
CREATE INDEX commits_author_name ON commits(author_name COLLATE NOCASE);

-- Files changed by each commit vs its first parent (first 300 per commit; files_changed has the total).
-- change: A added | M modified | D deleted | R renamed (old_path set) | T type change.
CREATE TABLE commit_files (
  commit_id INTEGER NOT NULL REFERENCES commits(id),
  ord INTEGER NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  change TEXT NOT NULL,
  additions INTEGER, deletions INTEGER,     -- NULL for binary
  PRIMARY KEY (commit_id, ord)
) WITHOUT ROWID;

-- Refs per project. kind: branch | tag | mr (refs/merge-requests/<iid>/head).
-- sha = the commit; tag_sha/tag_message/tagger_* for annotated tags.
CREATE TABLE refs (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  sha TEXT NOT NULL,
  tag_sha TEXT, tag_message TEXT, tagger_name TEXT, tagger_email TEXT, tagged_at TEXT,
  PRIMARY KEY (project_id, kind, name)
) WITHOUT ROWID;
CREATE INDEX refs_sha ON refs(sha);

-- Which commits belong to which project: everything reachable from its branches and tags.
CREATE TABLE project_commits (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  commit_id INTEGER NOT NULL REFERENCES commits(id),
  PRIMARY KEY (project_id, commit_id)
) WITHOUT ROWID;
CREATE INDEX project_commits_commit ON project_commits(commit_id);

-- History of a branch in `git rev-list` order (pos 0 = head; reverse chronological, topo order),
-- precomputed for the default branch of every project and for other branches with
-- <= 50,000 commits. A branch without rows here: walk commits.parents from refs.sha.
CREATE TABLE branch_commits (
  project_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  pos INTEGER NOT NULL,
  commit_id INTEGER NOT NULL REFERENCES commits(id),
  PRIMARY KEY (project_id, branch, pos)
) WITHOUT ROWID;

-- Contributors per branch (same branches as branch_commits), exactly as GitLab 15.7's
-- Repository > Contributors page computes them: the newest 6000 non-merge commits of the branch
-- (git log order), grouped by lower(author_email); author_name = name on the newest such commit;
-- `commits` = count within those 6000 (what the page shows), `commits_all` = all non-merge commits.
-- Dates are committer dates (the page's charts use committed_date). additions/deletions over all.
CREATE TABLE contributors (
  project_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  author_email TEXT NOT NULL,          -- lower-cased
  author_name TEXT NOT NULL,
  commits INTEGER NOT NULL,
  commits_all INTEGER NOT NULL,
  additions INTEGER NOT NULL,
  deletions INTEGER NOT NULL,
  first_at TEXT, last_at TEXT,
  PRIMARY KEY (project_id, branch, author_email)
) WITHOUT ROWID;

-- Built-in project templates ("Create from template"): commit + tree in git_objects/commits.
CREATE TABLE project_templates (
  name TEXT PRIMARY KEY,             -- rails, express, android, plainhtml, jekyll, ...
  title TEXT NOT NULL,
  description TEXT,
  commit_sha TEXT NOT NULL,          -- head of the template's default branch
  default_branch TEXT NOT NULL
);

-- Wiki pages (from <project>.wiki.git, current version only).
CREATE TABLE wiki_pages (
  project_id INTEGER NOT NULL REFERENCES projects(id),
  slug TEXT NOT NULL,                -- path without extension
  title TEXT NOT NULL,
  format TEXT NOT NULL DEFAULT 'markdown',
  content TEXT NOT NULL,
  updated_at TEXT,
  author_name TEXT,
  PRIMARY KEY (project_id, slug)
) WITHOUT ROWID;
