# Code hosting (`gitlab.wa`) -- base.db schema

`$WSB_DATA_ROOT/code/base.db` (SQLite) holds everything the GitLab-like
site needs: people, groups, projects, issues, merge requests, notes, activity, **and the git
data** (commits, refs, trees, blobs). There is no git server at runtime. Built by
[`build/`](build/README.md) from the WebArena GitLab (CE 15.7.5); the DDL with column
comments is [`build/schema.sql`](build/schema.sql) -- this page explains how the pieces fit.

Conventions:

- **ids are the source GitLab ids** (users, projects, issues, MRs, notes, labels, ...), so
  converted tasks and graders can name them. New rows get ids from SQLite as usual.
- Timestamps are TEXT `YYYY-MM-DD HH:MM:SS` in **UTC** (GitLab's time zone was UTC; commit
  lists group by UTC committed date -- this is what the WebArena answers assume). Dates
  `YYYY-MM-DD`. Booleans 0/1. Git ids are 40-char lowercase hex TEXT.
- Enumerations are stored as text (`state = 'opened'`), mappings from GitLab's integers are
  in `build/export_pg.py`. Access levels stay numeric (GitLab's): 5 minimal, 10 guest,
  20 reporter, 30 developer, 40 maintainer, 50 owner (also in `site_settings.access_levels`).
- Counters that GitLab denormalises are denormalised here too and **the site must keep them
  in step when it writes**: `projects.star_count`, `forks_count`, `open_issues_count`,
  `open_merge_requests_count`, `commit_count`; `issues/merge_requests.user_notes_count`,
  `upvotes`, `downvotes`.
- FTS5 indexes are external-content tables with triggers, so inserts/updates/deletes on
  `projects`, `issues`, `merge_requests`, `users` keep them in sync automatically (and roll
  back with the tenant transaction).

## Tables at a glance

| Area | Tables |
|---|---|
| settings | `site_settings` (external URL, clone URL prefixes, version, access level names) |
| people | `users`, `user_statuses`, `follows` |
| namespaces | `namespaces` (kind `user` / `group`), `members` (project + group membership and invites) |
| projects | `projects`, `stars`, `protected_branches`, `project_templates`, `wiki_pages` |
| planning | `labels`, `label_links`, `milestones` |
| issues | `issues`, `issue_assignees` |
| merge requests | `merge_requests`, `mr_assignees`, `mr_reviewers`, `mr_approvals`, `mr_diff_files`, `mr_commits` |
| discussion | `notes`, `award_emoji`, `resource_events` |
| activity | `events`, `todos` |
| git | `git_objects`, `commits`, `commit_files`, `refs`, `project_commits`, `branch_commits`, `contributors` |
| search | `projects_fts`, `issues_fts`, `merge_requests_fts`, `users_fts` |

## Users, login and passwords

`users.password_hash` is the source GitLab `encrypted_password`: **bcrypt** (`$2a$10$...`,
Devise, cost 10, no pepper). The kit's `kit.auth.verifyPassword(password, hash)` verifies it
as-is (via hash-wasm), so `byteblaze` / `hello1234` (the WebArena login) works. New or
changed passwords should be written with `kit.auth.hashPassword()` (scrypt); both formats
verify. `password_hash` is NULL for the 3 bots (they cannot log in). Other users' plaintext
passwords are unknown (WebArena created them with random passwords); give a rollout a
session with `POST /__rl/login` instead.

Profile fields (`bio`, `website_url`, `location`, `organization`, `job_title`, `pronouns`,
`twitter`, `linkedin`, `skype`) merge `users` and `user_details`. `avatar` is a path under
`media/` (only 2 bots have one; everyone else gets a letter/identicon avatar). `feed_token`
is kept only for byteblaze (task 259 asks for it: `TMN_bBn9Z48qVbUFZV45`); no other token or
secret is exported (personal access tokens, OAuth, SSH keys, runners, CI variables, deploy
tokens, webhooks, OTP secrets, reset/confirmation tokens are all dropped).

`user_statuses` (Set status: emoji, message, `availability` `busy`) is empty in the source;
tasks 418-422 write it. `follows(follower_id, followee_id)` has 5 rows.

## Namespaces, groups, members

Every user has a namespace (`kind = 'user'`, `path = username`, `owner_id = user`); groups
are `kind = 'group'` (`parent_id` for subgroups). `projects.namespace_id` points here and
`full_path` (namespace path + `/` + project path) is the URL path; it is unique
case-insensitively, as in GitLab.

`members(source_type, source_id)`: `source_type = 'project'` (`source_id` = project id) or
`'namespace'` (a group). Rules the UI must follow (as GitLab):

- the **owner of a personal namespace is Owner of its projects** even without a members
  row (the source has explicit owner rows for most personal projects anyway);
- group members inherit access to the group's projects;
- an invite by email is a row with `user_id NULL` and `invite_email`; inviting an existing
  user (tasks 480-485, 567-579) simply inserts a row with that `user_id` and the chosen
  `access_level` (and `expires_at` if set);
- `requested_at` set = an access request not yet approved.

## Projects

`visibility` private/internal/public. `forked_from_id` = the direct parent of a fork
(`forks_count` counts direct forks). `default_branch` comes from the repository's HEAD
(NULL = empty repository). `import_url` is the GitHub upstream (credentials stripped) --
see `SOURCES.repos.md`. `star_count` is GitLab's counter (it is what the "most starred"
tasks read; it equals the imported GitHub-era counter, not `count(stars)` -- adding/removing a
star must add/subtract 1). `objects_policy` says which trees/blobs are stored (below).

Clone URLs (tasks 293-297) are `site_settings.ssh_clone_prefix || full_path || '.git'`,
i.e. `ssh://git@metis.lti.cs.cmu.edu:2222/convexegg/super_awesome_robot.git`; HTTP likewise
with `http_clone_prefix`.

`project_templates` are GitLab's 29 built-in templates (Android, NodeJS Express, Pages/Plain
HTML, Pages/Jekyll, Ruby on Rails, ...): `commit_sha` is the template's head commit, whose
tree is in `git_objects`. "Create from template" = new project with a `refs` branch row
(`default_branch` of the template) pointing at `commit_sha`, plus `project_commits` rows.
A blank project with "Initialize repository with a README" = one web-edit commit (below).

`wiki_pages` is the current version of each project wiki (`<project>.wiki.git` HEAD).

## Issues and merge requests

`issues` / `merge_requests` are keyed by global `id`; the URL uses `(project_id, iid)`.
`state`: issues `opened|closed`; MRs `opened|closed|merged|locked`. Labels attach through
`label_links(target_type 'issue'|'merge_request', target_id, label_id)`; project labels have
`project_id`, group labels `group_id` (a project sees its own + its ancestors' group labels).
Assignees: `issue_assignees`, `mr_assignees`; MR reviewers `mr_reviewers(state unreviewed|reviewed|requested_changes)`;
approvals `mr_approvals`. Milestones are project or group scoped (`iid` per scope).

MR diffs: `mr_diff_files` has the **latest diff version**, first 100 files per MR in order
(`merge_requests.files_count` = the real total), with `additions`/`deletions` counted from the
hunks and the hunk text zlib-compressed in `diff` (`zlib.inflateSync`). Size policy:
`diff` is kept while the MR's total stays <= 32 KB and the file's diff <= 32 KB, else
`diff_omitted = 1` (show "diff too large, view the file"); `too_large` is GitLab's own flag.
`merge_requests.additions/deletions` sum the stored files. `mr_commits` lists the latest
version's commits (newest first, first 100; `commits_count` = total) with author and title;
for full details join `commits` on `sha` (MR heads from `refs/merge-requests/<iid>/head` are
in `commits` too, see refs kind `mr`).

## Notes, events, to-dos

`notes(noteable_type 'issue'|'merge_request'|'commit', noteable_id | commit_sha)`. `system = 1`
rows are GitLab's timeline notes ("added ~bug label", "changed milestone", "mentioned in");
`system_action` is their kind. `type` NULL (plain comment) / `DiscussionNote` (threaded,
`discussion_id` groups a thread) / `DiffNote` (`position` = GitLab's JSON line position).
`resource_events` is the structured label/state/milestone history (kind `label|state|milestone`).
`award_emoji` is empty in the source (all upvotes are 0) but is where thumbs up/down go.

`events` is the activity feed (`action` created/updated/closed/reopened/pushed/commented/
merged/joined/left/destroyed/expired/approved; push events carry `push_*`). `todos` are the
per-user to-do list (`state` pending/done) -- byteblaze has 5 pending (task 44).

## Git

All git data is content-addressed and shared across projects, so forks and templates dedupe.

- `git_objects(sha, type 'blob'|'tree', size, enc, omitted, binary, data)`: `data` is the raw
  git object body; `enc = 1` means zlib (RFC 1950 deflate, `zlib.inflateSync`), `enc = 0`
  raw. Trees are in git's binary format: repeated `<mode> <name>\0<20-byte sha>` (mode
  `40000` tree, `100644`/`100755` file, `120000` symlink, `160000` submodule commit). The sha
  is the real git id: `sha1("<type> <size>\0" + body)` -- a web edit computes it the same way.
- **Placeholders**: `omitted = 1` rows have the real `size` but no `data`: blobs > 1 MB, and
  binary blobs > 256 KB (binary = a NUL byte in the first 8000 bytes). The UI shows
  "file too large / stored externally" with the size. Submodule entries have no object.
- `commits(id, sha, tree_sha, parents, author_*, authored_at, author_tz, committer_*, committed_at,
  committer_tz, title, message, additions, deletions, files_changed, has_tree)`: **every**
  commit of every project (branches, tags, MR heads), keyed by sha. `parents` is a
  space-separated sha list (first parent first). `*_tz` = UTC offset in minutes.
  `additions`/`deletions`/`files_changed` are vs the first parent (`git log --numstat`;
  NULL line counts for gcc-mirror/gcc, whose 200k commits were imported with file lists only).
- `commit_files(commit_id, ord, path_id, old_path_id, change A|M|D|R|T, additions, deletions)`:
  files changed by each commit vs its first parent (first 100 per commit; paths interned in
  `paths(id, path)`). Lets the commit page list changed files even when trees are not
  stored; a real diff needs both blobs.
- `has_tree = 1`: the commit's whole tree (and blobs, modulo placeholders) is stored, so
  the file browser and diffs work at that commit. Which commits: see the object policy.
- `refs(project_id, kind 'branch'|'tag'|'mr', name, sha, tag_*)`: `sha` is always the commit
  (annotated tags: `tag_sha`, `tag_message`, `tagger_*`, `tagged_at`). kind `mr` = GitLab's
  `refs/merge-requests/<iid>/head` (`name` = iid).
- `project_commits(project_id, commit_id)`: the commits reachable from the project's branches
  and tags (forks have their own rows). Use it for "commits in project", commit search, and
  the commit page's "which project" check.
- `branch_commits(project_id, branch, pos, commit_id)`: the branch's history in `git log`
  order (pos 0 = head, reverse chronological), stored for the **default branch of every
  project** and for other branches with <= 10k commits, smallest first, until 30k rows per
  project. For
  a branch without rows, walk `commits.parents` from `refs.sha` (date-ordered merge of
  parents, like `git log`). A new commit on a branch must shift/insert rows (or the site may
  drop and recompute the branch's rows -- it's a cache).
- `contributors(project_id, branch, author_email, author_name, commits, commits_all, additions,
  deletions, first_at, last_at)`: exactly GitLab 15.7's Contributors page -- the newest 6000
  non-merge commits of the branch, grouped by **lower-cased author email**, name taken from
  the newest such commit; `commits` = count within those 6000 (what the page shows; tasks
  308-318/784-788 read it), `commits_all` = all non-merge commits. Recompute for the branch
  after a web commit (a background job, per PLAN §4.3).

### Object policy (what trees/blobs are stored)

Measured on the source: unique blob bytes over all history are 229 GB (gcc alone 143 GB,
first-contributions 32 GB, openapi-generator 25 GB), so full history cannot be kept for the
big repositories. Per project (`projects.objects_policy`):

- `full`: every tree and blob reachable from any branch or tag -- projects whose history
  blobs (<= 1 MB each) total <= 100 MB. This is most projects, including every byteblaze
  repo and every repo a write task edits.
- `recent`: the trees of the newest 100 commits of the default branch (+ the parent of the
  oldest, for diffs), then the heads of the other branches and tags, newest first, each one
  only if its new blobs fit in the remaining 20 MB budget (measured before walking, so a
  stored commit is always complete). Older commits keep metadata, `commit_files` and stats but
  `has_tree = 0` (UI: "the file contents of this old commit are not available in this sandbox").
- gcc-mirror/gcc (the only repository > 100k commits) is `recent` with the newest 30 commits,
  and its commits are the default branch's history plus the tip commits of its other
  branches/tags (whose older history is not imported).

### Web edits (how the site writes git)

Edit/create/delete a file on branch B of project P at path `a/b/c`:
1. blob: `body` = new content; `sha = sha1('blob ' + len + '\0' + body)`; insert into
   `git_objects` (`enc` 0 or 1) if missing.
2. trees: rewrite the path from the leaf up -- load tree `a/b` (from the head commit's tree),
   replace/insert the entry (entries sorted by git's rule: by name, with trees compared as
   `name + '/'`), hash and insert; repeat for `a` and the root.
3. commit: insert `commits` (parents = old head, `has_tree = 1`, author = the user,
   times = site clock, title/message), `commit_files`, `project_commits`.
4. refs: update `refs.sha` for B (or insert a new branch for "create new branch"), then
   `branch_commits` (shift + insert pos 0), `projects.commit_count`, `last_activity_at`,
   `contributors` (job), and an `events` row (`pushed`, `push_*`).
A fork = a new project + copies of the parent's `refs` and `project_commits` rows (no objects).

## Search

FTS5, external content (rowid = source id): `projects_fts(name, path, full_path,
description)`, `issues_fts(title, description)` and `merge_requests_fts(title, description)`
with porter stemming, `users_fts(username, name)`. Use `bm25()` with title weighted higher.
GitLab's issue filter bar also matches substrings of titles; small enough to do with
`title LIKE '%term%'` on one project's issues. No code search index (the UI can scan blobs
of one tree for "Go to file" / in-repo search).
