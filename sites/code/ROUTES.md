# Code hosting (`gitlab.wa`) -- routes

GitLab 15.7 URL schemes, so WebArena start/reference URLs keep working. `:ns/:proj` is a
project's `full_path` (`byteblaze/gimmiethat.space`); `<ref>` is a branch, tag or (abbreviated)
commit sha and may contain slashes (`github/fork/chtitux/addRssFeed`): the longest branch/tag
prefix wins, as in GitLab. Paths are URL-encoded per segment. Server: `server.js` (contract for
`collab/` at its top). Schema: `SCHEMA.md`. Clock: "today" = 2023-04-27 (UTC).

Run: `node sites/code/server.js --tenants 2 --port 7400 --data $WSB_DATA_ROOT/code`
Tests: `node --test sites/code/test/` (real base.db) and `CODE_PASSWORD=... node sites/code/test/smoke.js`
(headless Chrome; the password is in docs/NOTES-code.md).

## Repository side (`repo/`)

### Auth
| Method / path | |
|---|---|
| GET/POST `/users/sign_in` | sign-in form (`login` = username or e-mail, `password`, `next`); `/login` redirects here |
| POST `/users/sign_out` (GET too) | sign out |
| GET/POST `/users/sign_up` | register (first/last name, username, e-mail, password >= 8) -> user + namespace |

### Dashboard, explore, search
| | |
|---|---|
| `/` | signed in: "Your projects" (as `/dashboard/projects`); anonymous: redirect to sign-in |
| `/dashboard/projects`, `/dashboard/projects/personal`, `/dashboard/projects/starred` | project lists |
| `/dashboard/activity?scope=projects\|starred\|mine&filter=push\|merged\|issue\|comments\|wiki\|team` | activity feed |
| `/explore/projects`, `/explore/projects/starred` (Most stars), `/explore/projects/trending` | all visible projects |
| `/explore/groups?filter=&sort=`, `/explore/users?search=&sort=` | |
| `/search?search=&scope=projects\|issues\|merge_requests\|users` | global search (FTS5) |
| `/search?search=&project_id=N&scope=blobs\|issues\|merge_requests\|commits` | project search (code = default branch) |

Project-list params (dashboard, explore, user tabs, forks): `name=` (filter by name/path/description),
`sort=latest_activity_desc` (default) `|latest_activity_asc|name_asc|name_desc|created_desc|created_asc|stars_desc|stars_asc`,
`visibility=public|internal|private`, `archived=true|only`, `page=` (20 per page).

### Users
| | |
|---|---|
| `/:username` | profile overview (calendar, activity, personal projects); a group path dispatches to collab (`plugin.groupPage`) or `/groups/:path` |
| `/users/:u/activity\|groups\|contributed\|projects\|starred\|snippets\|followers\|following` | profile tabs |
| POST `/users/:u/follow`, `/users/:u/unfollow` | `follows` row |
| `/-/profile` (POST) | edit profile: name, pronouns, public e-mail, website URL, location, job title, organization, bio, Twitter/LinkedIn/Skype, private profile, avatar upload (multipart `avatar`, stored as `/uploads/...`) |
| POST `/-/profile/status` | `status_message`, `status_busy=1`, `clear_status_after` -> `user_statuses` (`clear=1` removes) |
| `/-/profile/password/edit`, POST `/-/profile/password` | change password (stored scrypt) |
| `/-/profile/personal_access_tokens` | shows the feed (RSS) token |
| `/-/profile/account` | username / e-mail (read-only) |

### Projects
| | |
|---|---|
| `/:ns/:proj` | overview: star/fork counts, clone URLs (SSH/HTTP from `site_settings`), stats, file tree, README |
| `/:ns/:proj/activity?event_filter=` | project activity |
| POST `/:ns/:proj/-/toggle_star` (`star=1\|0`, else toggles; JSON with `Accept: application/json`) | `stars` + `projects.star_count` |
| `/:ns/:proj/-/starrers` | |
| `/:ns/:proj/-/forks`, GET `/-/forks/new`, POST `/-/forks` (`namespace_id`, `name`, `path`, `description`, `visibility`) | fork = new project + copied refs / project_commits / branch_commits / contributors; parent `forks_count` + 1 |
| GET `/projects/new`, POST `/projects` (`mode=blank\|template`, `name`, `path`, `namespace_id`, `visibility`, `description`, `readme=1`, `template=<project_templates.name>`) | blank (optional README commit on `main`) or from a built-in template |

### Files and web editor
| | |
|---|---|
| `/:ns/:proj/-/tree/<ref>[/<path>]` | directory listing (last commit per entry), README |
| `/:ns/:proj/-/blob/<ref>/<path>` | highlighted file (Markdown rendered; `?plain=1` source); `#L10-20` highlights lines |
| `/:ns/:proj/-/raw/<ref>/<path>` | raw bytes (`?inline=false` download) |
| `/:ns/:proj/-/blame/<ref>/<path>` | blame from the stored history (newest 60 versions) |
| `/:ns/:proj/-/find_file/<ref>?q=` | file finder |
| GET `/-/edit/<ref>/<path>`, POST `/-/update/<ref>/<path>` (`file_path`, `content`, `commit_message`, `branch_name`, `create_merge_request=1`) | edit (a different `file_path` = move/rename) |
| GET `/-/new/<ref>/<dir>`, POST `/-/create/<ref>/<dir>` (`file_name` may contain `/`) | new file |
| POST `/-/delete/<ref>/<path>` (`commit_message`, `branch_name`) | delete file (modal on the blob page) |

A web commit writes: blobs (stored raw), rewritten trees, a `commits` row with the real git
sha (author = the user, times = site clock), `commit_files`, `project_commits`, the ref update
(a new `branch_name` creates the branch from the current ref), `branch_commits` (the new head
gets `pos = min(pos) - 1`, so **order by pos**; pos may be negative after web commits),
`projects.commit_count` (+1 on the default branch), `last_activity_at`, a `pushed` event, and
`temp.repo_files` (below). Contributors: the author's row is bumped at once and job
`repo.contributors` recomputes the 6000-commit window. With `create_merge_request=1` and a new
branch the response redirects to `/-/merge_requests/new?merge_request[source_branch]=..&merge_request[target_branch]=..`.
Permissions: Developer+ on unprotected branches, Maintainer+ on protected ones (`protected_branches`);
others get 403 ("fork it first").

**Grader table `temp.repo_files(project_id, branch, path, content, blob_sha, commit_sha, updated_at)`**:
the current content of every file a web commit wrote on that branch (`content` NULL = deleted;
copied to branches created from it and to forks). E.g. task 414:
`SELECT content FROM repo_files WHERE project_id = (SELECT id FROM projects WHERE full_path = 'byteblaze/dotfiles') AND branch = 'main' AND path = 'LICENSE'`.

### Commits, branches, tags, statistics
| | |
|---|---|
| `/:ns/:proj/-/commits[/<ref>[/<path>]]?author=&search=&page=` | history grouped by UTC committed day, 40 per page; `author` = substring of name or e-mail (like `git log --author`); path history skips merges |
| `/:ns/:proj/-/commit/<sha>` (`.diff`, `.patch`) | commit with diff (computed from stored blobs; "history truncated" + file list only for commits without trees); POST `.../comment` adds a commit note |
| `/:ns/:proj/-/compare`, `/-/compare/<from>...<to>` (`..` = straight) | commits in `to` not in `from` + diff from the merge base |
| `/:ns/:proj/-/branches[/active\|stale\|all]?search=&sort=name_asc\|updated_desc\|updated_asc` | stale = last commit older than 90 days |
| GET `/-/branches/new?ref=`, POST `/-/branches` (`branch_name`, `ref`), POST `/-/branches/delete` (`branch_name`) | |
| `/:ns/:proj/-/tags?search=&sort=`, `/-/tags/<name>`, GET `/-/tags/new`, POST `/-/tags` (`tag_name`, `ref`, `message`), POST `/-/tags/delete` | |
| `/:ns/:proj/-/graphs/<ref>` | Contributors = `contributors.commits` (GitLab 15.7 semantics, see NOTES); `?format=json`; `/charts` |
| `/:ns/:proj/-/network/<ref>` | commit graph (newest 150) |

Old commits of the 29 `recent`-policy repositories have no stored files: tree/blob/raw/blame
pages show a "History truncated" message; omitted blobs (> 1 MB, big binaries) show "file too large".

## Collaboration side (`collab/`)

(issues, merge requests, labels, milestones, members, groups, settings, wiki, to-dos -- appended by the collab builder)
