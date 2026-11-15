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

A Fastify plugin (`collab/index.js`) registered at the root prefix. Every write is a plain SQL
change in the tenant transaction (listed per section) so graders check state with `/__rl/query`.
POST forms carry `_csrf`; field names below. Tests: `node --test sites/code/collab/test/`
(node:test on the real base.db) and `node sites/code/collab/test/smoke.js` (headless Chrome).
List pages drop empty query params with a redirect (canonical URLs). Permissions follow GitLab:
issues: comment = any signed-in reader, edit/close = author or Reporter+, sidebar fields (assignees,
labels, milestone, due date, confidential, lock) = Reporter+; MRs: Developer+ (merge into a
protected branch: Maintainer+); labels/milestones Reporter+; members Maintainer+ (Owner role: Owner);
settings Maintainer+, archive/path/transfer/delete Owner. Archived projects are read-only.

### Issue and merge request lists
| | |
|---|---|
| `/:ns/:proj/-/issues` (also with trailing `/`) | project issues |
| `/:ns/:proj/-/merge_requests` | project MRs |
| `/groups/:group/-/issues`, `/groups/:group/-/merge_requests` | across the group's (sub)projects |
| `/dashboard/issues`, `/dashboard/merge_requests` | across readable projects; needs one filter (else "Please select at least one filter"); `scope=all` accepted |

Query parameters (GitLab's): `state=opened|closed|all` (MRs also `merged`; default `opened`) ·
`search=` (each word of >= 3 chars must occur in title or description; `#12` = iid; `in=title|description`) ·
`author_username=` · `assignee_username=` (or `assignee_username[]=`, `assignee_id=None|Any`) ·
`reviewer_username=` (MRs; `reviewer_id=None|Any`) · `label_name[]=` (repeat = AND; `None` / `Any`) ·
`not[label_name][]=` · `not[author_username]=` · `milestone_title=` (`None|Any|Upcoming|Started|<title>`) ·
`confidential=yes|no` · `my_reaction_emoji=` · `due_date=0|any|overdue|week|month|next_month_and_previous_two_weeks` ·
`source_branch=` / `target_branch=` / `draft=yes|no` / `approved_by_usernames[]=` (MRs) · `iids[]=` ·
`sort=created_date` (default, newest) `|created_asc|updated_desc|updated_asc|due_date|due_date_desc|milestone_due_asc|milestone_due_desc|popularity|popularity_asc|label_priority|priority|title_asc|title_desc|merged_at_desc|merged_at_asc|closed_at_desc|closed_at_asc` ·
`page=` (20 per page), `per_page=` (<= 100). Tabs show per-state counts. Confidential issues are
listed only for the author, assignees and Reporter+ members.

### Issues
| Method / path | Fields | Writes |
|---|---|---|
| GET `/:ns/:proj/-/issues/new` (`?issue[title]=&issue[description]=`) | | |
| POST `/:ns/:proj/-/issues` | `title`, `description`, `issue_type` (issue/incident), `confidential`, `assignee_ids[]` and/or `assignee_ids_usernames` (comma list), `label_ids[]`, `milestone_id`, `due_date` (YYYY-MM-DD) | `issues` (iid = max+1), `label_links`, `issue_assignees`, `projects.open_issues_count`+1, `events` created, `todos` (assigned, @mentions) |
| GET `/:ns/:proj/-/issues/:iid` | | page: `[data-qa-selector=title_content]`, `.detail-page-description`, `#notes-list` (`.timeline-discussion-body`), `[data-testid=sidebar-due-date]` |
| GET/POST `/-/issues/:iid/edit` | `title`, `description`, `confidential`, `issue_type` | system notes "changed title from ...", "changed the description" |
| POST `/-/issues/:iid/close`, `/reopen` | | `state`, `closed_at/closed_by_id`, counter, `resource_events` (kind state), `events` |
| POST `/-/issues/:iid/assignees` | `assignee_ids[]`, `assignee_ids_usernames`, or `assign_self=1`, `unassign_all=1` | `issue_assignees`, system note "assigned to @x", `todos` |
| POST `/-/issues/:iid/labels` | `label_ids[]` (the whole set) | `label_links`, `resource_events` (label add/remove) |
| POST `/-/issues/:iid/milestone` | `milestone_id` ('' = none) | `issues.milestone_id`, `resource_events` (milestone) |
| POST `/-/issues/:iid/due_date` | `due_date` or `remove=1` | `issues.due_date`, system note "changed due date to December 31, 2030" |
| POST `/-/issues/:iid/confidential` | `confidential=0/1` | `issues.confidential`, system note |
| POST `/-/issues/:iid/lock` | `locked=0/1` | `issues.discussion_locked` |
| POST `/-/issues/:iid/todo` | | toggles a `marked` to-do |
| POST `/-/issues/:iid/award` | `name` (thumbsup/thumbsdown/...) | `award_emoji` toggle, `upvotes`/`downvotes` |
| POST `/-/issues/:iid/notes` | `note`, `discussion_id` (reply), `start_thread=1`, `internal=1`, `close=1`/`reopen=1` ("Comment & close") | `notes` (`noteable_type` 'issue'), `user_notes_count`+1, `events` commented, mention to-dos |
| POST `/-/issues/:iid/notes/:id/edit`, `/delete`, `/award` | `note` | |
| POST `/-/issues/:iid/delete` | (Owner) | deletes the issue and its rows |
| GET `/-/autocomplete/users.json?search=&project_id=` | | user picker JSON |

### Merge requests
| Method / path | Fields | Writes |
|---|---|---|
| GET `/:ns/:proj/-/merge_requests/new` | `merge_request[source_project_id]`, `merge_request[source_branch]`, `merge_request[target_project_id]`, `merge_request[target_branch]` (`change_branches=1` = step 1) | step 1 picks branches; step 2 previews commits/files. From a fork the target defaults to the upstream project (as GitLab) |
| POST `/:ns/:proj/-/merge_requests` | `source_project_id`, `source_branch`, `target_project_id`, `target_branch`, `title`, `description`, `draft`, `assignee_ids[]`/`assignee_ids_usernames`, `reviewer_ids[]`/`reviewer_ids_usernames`, `milestone_id`, `label_ids[]`, `force_remove_source_branch`, `squash` | `merge_requests` (head/base/start sha, counts), `mr_commits`, `mr_diff_files` (computed: merge base -> source head, zlib hunks, size policy as the import), `refs` kind mr, `mr_reviewers` (+ `review_requested` to-dos), `mr_assignees`, `label_links`, counter, `events` |
| GET `/-/merge_requests/:iid`, `/commits`, `/diffs` | | Overview (`.detail-page-description > a.gl-font-monospace` = [source, target]), approvals + merge widget, activity; Commits; Changes |
| GET/POST `/-/merge_requests/:iid/edit` | `title` (`Draft:` prefix = draft), `description`, `target_branch`, `squash` | system notes; target change recomputes the diff |
| POST `/-/merge_requests/:iid/close`, `/reopen`, `/toggle_draft` | | state / draft (+ resource_events, events) |
| POST `/-/merge_requests/:iid/assignees`, `/reviewers` (`reviewer_ids[]`, `reviewer_ids_usernames`, `assign_self`), `/labels`, `/milestone`, `/lock`, `/todo`, `/award` | as issues | `mr_reviewers` etc. + system notes ("requested review from @x") |
| POST `/-/merge_requests/:iid/approve`, `/unapprove` | Developer+ | `mr_approvals`, reviewer state `reviewed`, system note "approved this merge request", `events` approved |
| POST `/-/merge_requests/:iid/review_state` | `state=unreviewed|reviewed|requested_changes` (reviewers) | `mr_reviewers.state` |
| POST `/-/merge_requests/:iid/merge` | `should_remove_source_branch`, `squash`, `commit_message` | see below |
| POST `/-/merge_requests/:iid/notes` (+ `/notes/:id/edit|delete|award`), `/delete` | as issues | `notes` (`noteable_type` 'merge_request') |

**Merge** = a real merge commit (parents: target head, source head; message `Merge branch 'a' into
'b'` + title + `See merge request ns/proj!iid`; tree = source tree when the target is an ancestor,
else a 3-way merge per path with line-level patching of text files; conflicts block the merge),
or with `squash` one commit on top of the target. Then: `refs` (target branch), `project_commits`
(incl. a fork's commits), `branch_commits` (rewritten in pos order 0..n), `projects.commit_count`,
`last_activity_at`, `merge_requests.state='merged'`, `merged_at`, `merged_by_id`,
`merge_commit_sha`, counter, `resource_events` (state merged), `events` merged, all pending to-dos of
the MR done, `temp.repo_files` rows of the source branch copied to the target branch, job
`repo.contributors` for the target; optional source-branch deletion (repo side's
`write.deleteBranch`); "Closes #n" / "Fixes #n" in the title/description closes those issues when
merging into the default branch. The widget shows why a merge is blocked (draft, conflicts, missing
branch, file contents not stored for `recent`-policy history).

### Labels and milestones
| Method / path | Fields | Writes |
|---|---|---|
| GET `/:ns/:proj/-/labels?search=&sort=name_asc|name_desc|created_desc|created_asc|updated_desc|updated_asc` | | prioritized + other labels (project + inherited group labels), open issue/MR counts |
| GET `/-/labels/new`, POST `/-/labels` | `title`, `description`, `color` (#hex) | `labels` |
| GET/POST `/-/labels/:id/edit`; POST `/-/labels/:id/delete` | | delete also removes `label_links`, `label_priorities` |
| POST `/-/labels/:id/toggle_priority`, `/-/labels/:id/move` (`direction=up|down`) | | `label_priorities` (table added by build step `collab`) |
| `/groups/:group/-/labels` (+ `/new`, `/:id/edit`, `/:id/delete`) | | group labels (`labels.group_id`) |
| GET `/:ns/:proj/-/milestones?state=opened|closed|all&search_title=&sort=due_date_asc|due_date_desc|start_date_asc|start_date_desc|name_asc|name_desc|created_desc|created_asc` | | with progress (closed/total issues) |
| GET `/-/milestones/new`, POST `/-/milestones` | `title`, `description`, `start_date`, `due_date` (YYYY-MM-DD; due >= start) | `milestones` (iid per scope), `events` |
| GET `/-/milestones/:iid?tab=issues|merge_requests|labels` | | `.block.start_date`, `.block.due_date`, issue columns (unstarted / ongoing / closed) |
| GET/POST `/-/milestones/:iid/edit`; POST `/:iid/close`, `/:iid/reopen`, `/:iid/delete` | | `state` active/closed; delete unsets issues'/MRs' milestone |
| `/groups/:group/-/milestones` (same sub-paths) | | group milestones (`milestones.group_id`) |

### Members
| Method / path | Fields | Writes |
|---|---|---|
| GET `/:ns/:proj/-/project_members?search=&sort=&tab=invited|access_requests` | | direct + inherited (group, personal namespace owner) members, roles, expiry |
| POST `/:ns/:proj/-/project_members` | `invitees` (usernames and/or e-mails, comma list; also `user_ids[]`), `access_level` (10/20/30/40/50), `expires_at` | `members` row per user (`source_type` 'project'); an existing member is updated; an e-mail of a user adds that user, other e-mails a pending invite (`user_id` NULL, `invite_email`); `events` joined |
| POST `/-/project_members/:id/update` | `access_level`, `expires_at` | |
| POST `/-/project_members/:id/delete` | `unassign_issuables=1` | removes the row (also revokes an invite / denies a request) |
| POST `/-/project_members/leave`, `/request_access`, `/:id/approve_access_request` | | |
| `/groups/:group/-/group_members` (same sub-paths) | | `source_type` 'namespace'; a group keeps >= 1 Owner |

### Groups
| Method / path | Fields | Writes |
|---|---|---|
| GET `/groups/new` (`?parent_id=` subgroup), POST `/groups` | `name`, `path` (default: slug of the name), `visibility`, `description`, `parent_id`, `invitees` (usernames/e-mails), `invite_access_level` | `namespaces` (kind group), creator `members` Owner (50), invitees' `members`, `events` |
| GET `/groups/:group`, `/<group>` (repo dispatches to `plugin.groupPage`) `?filter=&sort=` | | subgroups + projects; "New project" links to `/projects/new?namespace_id=N` (repo side) |
| GET `/groups/:group/-/activity` | | group feed |
| GET/POST `/groups/:group/-/edit` (Owner) | `name`, `description`, `visibility`, `request_access_enabled` | |
| POST `/groups/:group/-/transfer_path` | `path` | renames the group, its subgroups' and projects' `full_path` |
| POST `/groups/:group/-/delete` | `confirm_name` = full path | deletes the group, subgroups and their projects |
| GET `/dashboard/groups?filter=&sort=` | | groups the user is a member of |

### Project settings (`/:ns/:proj/...`, not under `/-/`)
| Method / path | Fields | Writes |
|---|---|---|
| GET/POST `/:ns/:proj/edit` (Maintainer+) | `name`, `description`, `topics` (comma list), `visibility`, `issues_enabled`, `merge_requests_enabled`, `wiki_enabled`, `forking_enabled` | `projects`; topics in `topics` / `project_topics` (build step `collab`; temp tables when base.db predates it) |
| POST `/:ns/:proj/archive`, `/unarchive` (Owner) | | `projects.archived` |
| POST `/:ns/:proj/rename` (Owner) | `path` | `projects.path`, `full_path` |
| POST `/:ns/:proj/transfer` (Owner) | `new_namespace_id` (own namespace or a group where Maintainer+) | `namespace_id`, `full_path` |
| POST `/:ns/:proj/remove` (Owner) | `confirm_name` = full path | deletes the project and all its rows (FK order) |

### Wiki
| Method / path | Fields | Writes |
|---|---|---|
| GET `/:ns/:proj/-/wikis` (-> `/home`), `/-/wikis/pages?sort=title|created_at&direction=asc|desc`, `/-/wikis/<slug>` | | `wiki_pages` (slugs may contain `/`) |
| GET `/-/wikis/new`, POST `/-/wikis` | `title` (slug = title with spaces -> `-`), `content`, `format`, `message` | insert (Developer+), `events` |
| GET/POST `/-/wikis/<slug>/edit`; POST `/-/wikis/<slug>/delete` | | update (title change moves the page) / delete |

### To-dos
| Method / path | | Writes |
|---|---|---|
| GET `/dashboard/todos?state=pending|done&project_id=&author_id=&type=Issue|MergeRequest&action_id=&sort=created_asc` | | |
| POST `/dashboard/todos/:id/done`, `/:id/restore`, `/dashboard/todos/mark_all_as_done` | | `todos.state` |
