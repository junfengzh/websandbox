# Notes: code hosting data build (gitlab.wa)

Builder notes for `sites/code/build/` (2026-11-14/15). Schema: `sites/code/SCHEMA.md`;
pipeline: `sites/code/build/README.md`; provenance: `sites/code/SOURCES.md` + `SOURCES.repos.md`.

## Source

- `$WSB_SRC/gitlab.sqfs` (21 GB): GitLab CE 15.7.5 Omnibus, PostgreSQL
  13.8 datadir 12 GB (`/var/opt/gitlab/postgresql/data`, owner uid 996, superuser
  `gitlab-psql`, collation C.UTF-8), bare repos 13 GB in hashed storage (175 projects + 174
  wiki repos + 7 object pools for forks; `alternates` are relative, so a plain copy works).
  Repos are root-only on the image, hence the copy + chown.
- External URL `http://metis.lti.cs.cmu.edu:8023`, ssh port 2222, time zone UTC (default).
- Real GitLab for reference: `http://<webarena-host>:8024` (read-only GETs only; used to confirm
  the contributors numbers below).

## Result

`$WSB_DATA_ROOT/code/base.db` = **2.88 GB** (+ `media/` 2 bot avatars).

| table | rows | | table | rows |
|---|---|---|---|---|
| users | 2,399 | | commits | 768,026 (464,033 project commits; rest = MR heads) |
| namespaces | 2,401 (2 groups) | | git_objects | 599,983 (395,013 blobs, 204,970 trees) |
| projects | 175 (7 forks) | | refs | 156,742 (4,585 branches, 3,831 tags, 148,326 MR heads) |
| members | 184 | | commit_files | 3,904,071 (paths: 517,539) |
| stars | 2,218 | | branch_commits | 1,318,659 |
| issues | 80,962 | | contributors | 113,943 |
| merge_requests | 134,336 | | project_templates | 29 |
| notes | 303,407 | | wiki_pages | 363 |
| label_links | 147,190 | | mr_diff_files | 759,930 |
| events / todos | 26,507 / 2,338 | | mr_commits | 425,051 |

Space: git_objects 1.19 GB, commits 0.43 GB (gcc's 200k messages ~0.1 GB), mr_diff_files
0.30 GB, issues+notes+MRs 0.37 GB, FTS 0.09 GB, rest small.

## Blob / history policy (measured first)

Unique blob bytes over all history: **229 GB** (gcc-mirror/gcc 143 GB, first-contributions
32 GB -- its README is rewritten in each of 9k commits --, openapi-generator 25 GB, bootstrap
5.5 GB, buck 3.4 GB, dynamorio 3.3 GB, keycloak 2.7 GB, ...); trees 17 GB; blobs > 1 MB 65 GB.
Default-branch snapshots alone: 1.7 GB. Chosen policy (knobs in `import_git.py`):

- **all commits** of every project are kept (metadata, parents, numstat, changed files), so
  every commit-count / contributor / date task works on full history;
- `full` objects (all trees/blobs of all branches+tags) for the 146 projects whose history
  blobs total <= 100 MB -- this includes every byteblaze/convexegg/yjlou/root repo and
  every repo a write task edits; `recent` for 29 big ones (newest 100 default-branch
  commits + other heads/tags while they fit a 20 MB budget; gcc newest 30 commits);
- blobs > 1 MB and binary blobs > 256 KB are placeholders (`omitted = 1`, real size kept):
  1,844 placeholders;
- stored raw 8.3 GB -> 1.05 GB with zlib; forks/templates dedupe by sha.
- MR diffs: latest version, first 100 files/MR, diff text kept up to 32 KB per MR
  (285,808 of 759,930 file diffs omitted -- mostly openapi/keycloak generated code).
- gcc (199,478 commits): default-branch history + tips of its 98 branches / 186 tags only
  (the other ~250k commits of old release branches are not imported), file lists for the
  newest 5,000 commits, no line counts.

## Passwords

`users.password_hash` = GitLab's Devise **bcrypt** (`$2a$10$`, no pepper), copied as-is;
`kit.auth.verifyPassword` handles it -- checked: byteblaze / hello1234 verifies `true`.
3 bots have no hash. New passwords: `kit.auth.hashPassword` (scrypt). Secrets dropped:
the export only reads whitelisted tables/columns (no personal_access_tokens, oauth, keys,
ci/runner/deploy tokens, webhooks, OTP, reset/confirm/invite tokens); `feed_token` kept for
byteblaze only (task 259's answer, already public in the task file); import URLs stripped of
userinfo (none had any).

## Task coverage (204 tasks with "gitlab" in `sites`: 180 gitlab-only + 24 cross-site)

Every entity the tasks name exists: byteblaze's 14 repos and their files (LICENSE,
LICENSE.txt, index.html), a11yproject.com, primer/design, metaseq, PyTorch-GAN, 2019-nCov,
ChatGPT, super_awesome_robot, aem-hacker, awesome-python, AndroidSlidingUpPanel, csvkit,
administrate, create-react-app, IMSI-Catcher-Detector (+ gh-pages branch),
archive-my-tweets (+ php52 branch), dehenne/awesome-visibility, ffmpeg-python, keycloak,
openapi-generator, angular-storage, AndroidAsync, arch-wiki-docs, all users the invite /
follow / group tasks name (Abishek=abisubramanya27, Vinta, yjlou, lahwaacz=Jakub Klinkovský,
koush, Roshanjossey, Seirdy=Rohan Kumar, bblanchon, primer, patou, egpast, westurner,
jontutcher, JonasVautherin, dilipchandima, dawiss1337, bmyun, DCMJY, ASWATFZLLC,
patrickhlauke, linkmatrix, qhduan, Agnes-U, pandey2000, sayakpaul, R1kk3r, ghost), the MRs
the comment/review tasks open (primer/design!450, a11yproject!1531/!1265/!1071/!1270/!1485,
empathy-prompts!19, a11y-webring.club!40), the dialog / dialog-component / bump-doctocat /
redesign / markdown-figure-block branches, byteblaze's to-dos, assigned and review-requested
MRs, user status (empty table, written by tasks 418-422), templates Android / NodeJS Express /
Plain HTML / Jekyll / blank (29 templates), the SSH clone URL host, the RSS token.
Not present by design: none needed. Issue/MR **attachments** (uploads, 3.6 GB of images in
15,181 files) are not copied -- no task needs them; markdown links to `/uploads/...` will 404.
award_emoji is empty in the source (all upvotes 0).

## Verification (`build/verify.py`, 88 checks, all pass)

- row counts vs PostgreSQL for 21 tables/filters (users, projects, issues by state, MRs by
  state, notes, labels, label_links, milestones, members, stars, follows, events, todos,
  assignees, reviewers, approvals, protected branches, namespaces): all equal;
- for all 175 projects: branch count, tag count and default-branch commit count equal `git`;
  every ref target is in `commits`; every default-branch head is browsable (`has_tree`); no
  orphans in 9 FK paths;
- **task facts**, each computed from base.db AND independently from the source (git/PG):
  commits by author/date (132, 133, 134, 135, 136, 304, 307), top contributors (308, 309,
  310, 311, 312, 314, 315, 316, 317, 318, 784, 786), contributors on a non-default branch
  (785 gh-pages, 788 php52 + user location), followers (787), repo members (349, 350),
  most/least-starred repos (169, 170), top-8 starred (523-527), feed token (259), clone URL
  (293), byteblaze's latest issues by keyword (173, 177, 178, 180, 182), label filters
  (102, 104, 106 -- 33/57/31 issues), to-dos (44: 5 pending), assigned MRs (156: 3), review
  requests (357: 5), the MR pages of 389/390/393/415/416/417, the files edited by
  411/412/441, templates for 747-756, byteblaze's bcrypt hash.

Findings for the task converter:

- Dates: answers assume **UTC committed dates** (GitLab groups commit lists by
  `committed_date` in the server zone, UTC). E.g. 135 "Eric and Kilian on 1/3/2023" = 1.
- Contributors = GitLab 15.7's page: newest 6000 non-merge commits, grouped by
  lower(email), name from the newest commit (confirmed in the shipped JS bundle and
  against the live GitLab JSON). `contributors.commits` matches the live site exactly.
- **786**: reference 412, but the data (and the live WebArena GitLab's
  `/vinta/awesome-python/-/graphs/master?format=json`) say vinta.chen@gmail.com has **414**;
  also the intent says "branch main" but the default branch is `master`. Fix the reference.
- **307** "Nic ... in April 2021" = 0 in the data; the reference 16 is Nic Chan's commits in
  **April 2022**. Fix the intent's year (or the answer to 0).
- **136** "Steven Woodson ... 2/6/2023" = 5 only when counting his two git identities
  ("Steven Woodson" 3 + "Steve Woodson" 2); the answer SQL must match both (e.g. author name
  LIKE '%Woodson%').
- **177/182** "homepage content": the issue is titled "Rethink the homepage's content"
  (a11yproject #719, closed) -- search must tolerate the possessive (FTS does).
- **170** "least stars": the reference lists byteblaze's own repos with 0 stars
  (contributions = own/member projects, not just event history).
- **414**: byteblaze/dotfiles has no LICENSE in the source; the task creates it.
- **785**: the branch is `gh-pages` (intent says "gh-page").

## Timings (shared 8-core box, load 30+ from other builders)

pg datadir copy 8 min; repo copy ~7 min; `export` 9-12 min; `git` first run 2 h 15 min
(openapi-generator `git log --numstat -M` alone 2 h, first-contributions 77 min, CRA 66 min,
gcc 50 min -> 5 min after the gcc change); re-run with `--reuse` (keeps the git-log output,
recomputes branches/contributors/objects) 5 min; templates 1 min; assemble 2 min; verify 4 s.
Disk peak ~30 GB in `work/code` (pgdata 12 + repos 13 + shards 3.7), all removed by `cleanup`.

## Site: repository side (`sites/code/repo/`, 2026-11-15)

Routes: `sites/code/ROUTES.md`. Facts for task conversion / graders:

- Site clock "today" = 2023-04-27 16:00 UTC (data ends 2023-04-26).
- Web edits create real git objects (blob/tree/commit shas as git computes them); the new head
  of a branch gets `branch_commits.pos = min(pos) - 1` (order by pos; pos can be negative).
- `temp.repo_files(project_id, branch, path, content, ...)` holds the current text of every file
  a web commit wrote (NULL = deleted), copied to new branches and forks: state checks on edited
  files are plain SQL (task 414's LICENSE, the README tasks, ...).
- Stars: `stars` row + `projects.star_count` +/- 1; forks: new `projects` row with
  `forked_from_id`, parent `forks_count` + 1; follows: `follows`; status: `user_statuses`
  (message, `availability = 'busy'`); profile fields on `users`.
- Contributors page = `contributors.commits` for the branch (job `repo.contributors` recomputes
  after a web commit); commits list `?author=` is a substring match on name or e-mail.

## Site: collaboration side (`sites/code/collab/`, 2026-11-15)

Routes: `sites/code/ROUTES.md` ("Collaboration side"). Facts for task conversion / graders:

- **base.db additions** (build step `collab` = `sites/code/build/collab_indexes.sql`, run after
  `assemble`; applied to the current base.db on 2026-11-15 01:05 -- restart servers started
  before that): indexes `issues(project_id, created_at|updated_at)`, `issues(project_id, state,
  updated_at)`, the same three on `merge_requests`, `merge_requests(milestone_id)`; tables
  `label_priorities(project_id, label_id, priority)` (empty in the source), `topics(id, name)` +
  `project_topics(project_id, topic_id)` (empty). Measured on the shared box: list/detail pages
  p50 18 ms, p95 130 ms, max 170 ms (bootstrap 22k issues, first-contributions 65k MRs, label
  priority sort is the slowest).
- Issue search = GitLab's: every word of >= 3 chars must occur in title or description
  (substring, case-insensitive), so "homepage content" finds "Rethink the homepage's content".
- Label filters match the label **title exactly** (case-sensitive, as PostgreSQL in GitLab);
  `label_name[]` repeated = AND. `label_name[]=None` = issues without labels.
- New rows: issue/MR `iid` = max+1 per project; milestone `iid` per project/group; notes get a
  deterministic 40-hex `discussion_id`. Labels/state/milestone changes go to `resource_events`
  (as GitLab 15.7), assignee/reviewer/title/description/due-date changes to system `notes`.
- Assignees/reviewers may be any active user (GitLab allows anyone who can read a public
  project), e.g. Seirdy on a11y-webring.club (task 447), not only members.
- A merge writes a real merge commit (two parents) and moves the target ref; `branch_commits`
  of the target is rewritten with pos 0..n in `git log` date order (still "order by pos").
  From a fork, `/-/merge_requests/new` targets the upstream by default (as GitLab).
- Invites: an existing user gets a `members` row at once (no acceptance step); an unknown
  e-mail is a pending invite (`user_id` NULL). Group creation can invite members directly
  (tasks 799-803); the creator is Owner (50).
- Project deletion removes every dependent row synchronously (foreign keys are enforced).

## Task conversion, batch a (2026-11-15)

93 gitlab-only tasks of 24 templates (289-294, 298-300, 303, 308, 310, 312, 316, 320-325, 327-330) in
`tasks/code/webarena-a.jsonl` (`python3 -I tasks/code/convert-a.py`), evidence in `tasks/code/verify-a.jsonl`:
all 93 verified by a manual browse.js run + grade.js, one negative check per template (24/24 fail as they
should); on a fresh tenant with no answer all 93 fail or stay pending (fuzzy). None dropped.

- program_html -> SQL: members rows (any role / `access_level = 10`), `follows`, new `projects` row,
  `temp.repo_files` for index.html, byteblaze's newest new issue (`created_at >= '2023-04-27'`) with title /
  due_date / assignee or text in title+description. The url_match "GOLD in PRED" on issue lists of 327/328 is
  dropped (the kit grader has no prefix mode; the SQL check covers it).
- Reference fixes: 786 412 -> 414 and "main" -> "master"; 784 "main" -> "development" (no main branch);
  785 "gh-page" -> "gh-pages"; 307 April 2021 -> 2022; 45 sort=created_asc (oldest) -> newest-first list
  (exact URL match on the default list variants); 536 @lahwaacz -> @ghost (intent names ghost); 175 keyword
  "dependency" -> "dependencies" (title search is a substring match; the reference is "Outdated
  dependencies"); 174/175 intent says "(assigned to me)" (the references are the dashboard's assigned issues,
  not authored ones); 317 tie Peter Albert / Zachary DeVito (12) both accepted; 296/297 exact -> must_include.
- "Repositories where I made contributions" (168-172) = own + member projects ("Your projects"); the
  Contributed tab is event-based and misses dotfiles/gimmiethat.space/remove-board-....
- 312 csvkit: James McKinney has 450 + 130 under two e-mails; GitLab groups by e-mail, so Groskopf (499) is top.
- Site fixes: top-bar counters were shadowed by page `counts` locals ("undefined" on dashboard/tree/profile
  pages); member invites accept a user's full name (unique exact match), like GitLab's invite picker.
- Headless Chrome: a date input takes typed `MM/DD/YYYY` (typing `YYYY-MM-DD` garbles it).

## Task conversion, part b (2026-11-15)

87 gitlab-only tasks outside part a's templates: [../tasks/code/webarena-b.jsonl](../tasks/code/webarena-b.jsonl)
(`python3 -I tasks/code/convert-b.py`), evidence in [../tasks/code/verify-b.jsonl](../tasks/code/verify-b.jsonl).
All 87 verified by a UI run (browse.js) + grade.js, none dropped; one or more negative checks per template
(17/17, 31 in all) fail as they should; on a fresh tenant all 86 non-fuzzy tasks fail.

- program_html -> SQL on: last non-system MR note (348/360), forks by `forked_from_id` (352), `temp.repo_files`
  with whitespace-insensitive needles (355; the MIT needle spans a line break; no row = file unchanged),
  `user_statuses` (361; "Busy" also = busy flag), `issue_assignees` (999), `users.website_url` without scheme
  (331), `stars` on fixed top-N ids (354), `members` roles (351), new `milestones` (339), open MR + `mr_reviewers`
  for the branch pair (335), new issues (337), projects (visibility, `template_name`, "Initial commit",
  members; 332/2100), group namespace + members (600). WebArena's "GOLD in PRED" url checks on 335/337/339 are
  dropped (no prefix mode in the kit grader; the state check pins the project).
- Reference fixes: 102 URL pointed at the wrong repo; 178 / 179 references were not the latest issue with the
  keyword in the title (179's answer Yes -> No); 181 intent ("my" issue -> issue in my repositories);
  590-592 intent year 2023 -> 2030 (reference dates); 668/805 "master" -> "main" (no master branch).
- 805/807: an open MR already exists for the branch pair (!1141, !390); GitLab refuses a duplicate, so the task
  is solved by setting reviewers on that MR -- the check accepts any open MR for the pair.
- Site fix: MRs with no changes can be created (668 redesign -> main), as in GitLab.
- Cosmetic gaps (not needed by graders): profile shows the website with its scheme (GitLab strips it);
  project slugs from the name are lower-cased (byteblaze/autoagi; URLs are case-insensitive anyway).

## Generated tasks (2026-11-15)

Generator `tasks/code/gen/` (`node tasks/code/gen/index.js --seed 1` -> `tasks/code/generated.jsonl`, deterministic per
seed + base.db; `node tasks/code/gen/check.js --site <fresh tenant>` bulk-checks every task: read references pass with no
SQL drift and an empty answer fails; write tasks fail on the untouched state). 40 templates (`gen-code-*`), 2,491 tasks
(read 1,326 / write 1,165), 117 login users (byteblaze on his repos + a11yproject (Maintainer) + primer/design
(Developer); elsewhere the personal-namespace owner, who is Owner). Evidence: `tasks/code/verify-generated.jsonl`
(every template: >= 2 UI runs with browse.js + grade.js, >= 1 negative).

- Read templates: explore filter + star ranking, a user's projects by activity/created/stars/commits, profile fields,
  default branch + head author, branch head commit, file line N, README section headings, package.json fields, branch /
  tag / stale / active counts, tag -> commit title, contributors (most additions/deletions, count), path history (count,
  last author, oldest commit), author's first/latest commit, commit added/deleted lines, issue counts with 2 filters
  (label+label, label+milestone, label+assignee), issue detail by title, most-commented labeled issue, milestone
  open/closed counts, MR reviewer counts, MR files / line totals, MR source branch / commit count.
- Write templates: full issue create (labels, milestone, assignee), comment + close, reopen latest-updated closed
  labeled issue, relabel, milestone + due date, assign the most-commented issue to its author, MR review request,
  branch from tag, annotated tag, web-editor replace (LICENSE year or a unique phrase; exact normalised content via
  `temp.repo_files`), new file (content + commit title), branch + edit + MR, delete a merged MR's source branch,
  members (add with role + expiry, change role, remove), labels, milestones (close/reopen, due date), star a user's
  projects, project settings (description, topics, visibility, feature toggles), profile fields.
- Data facts the samplers rely on: imported issues/MRs are authored by root ("Created by: X" in the body), so
  author questions use non-root authors only; `closed_at` / `merged_at` are NULL for imported rows (use updated_at /
  iid order instead); no confidential issues; file-content references come from the blobs (zlib) and their
  answer_sql returns the reference only while the branch head is unchanged; order-sensitive pairs (added vs deleted,
  source vs target) are asked one value per task because must_include is order-free.
- Site fixes: the profile header labels Job title / Organization / Location (they were unlabeled text); the MR
  Changes tab "View file @ sha" link pointed at `undefined/-/blob/...`.
