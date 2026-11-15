# Forum notes (data build)

Builder notes for `sites/forum` data: measurements, decisions, open issues.
Schema: [../sites/forum/SCHEMA.md](../sites/forum/SCHEMA.md). Pipeline:
[../sites/forum/build/README.md](../sites/forum/build/README.md).

## Source (measured 2026-11-14)

- `forum.sqfs` 43 GB: Alpine rootfs, PHP 8.1 Postmill (Symfony) in
  `/var/www/html`, PostgreSQL **14** datadir `/usr/local/pgsql/data` (4.8 GB:
  base 4.1 GB, pg_wal 0.7 GB), images `/var/www/html/public/submission_images/`
  (**31,467 files, 39 GB**: 26,169 jpg, 4,130 png, 1,166 gif, 2 bin). Average
  source image 2160x2344 px, 1.2 MB.
- Postgres started with `postgres:14-alpine` on a local copy of the datadir:
  "database system was not properly shut down; automatic recovery" -- the WAL
  replay was instant (one record). Locale C / C.UTF-8.
- DB `postmill` (also an empty `test` DB). Non-empty tables: users 661,782;
  forums 95; submissions 127,391; comments 2,551,513; images 31,467;
  submission_votes 1; sites 1. **Everything else is empty**: moderators,
  subscriptions, bans, moderation log, tags, messages, notifications, wiki,
  comment votes, flairs, themes. The UI must still offer these features (tasks
  create forums, subscribe, post); they start empty.
- Text volume: comment bodies 414 MB, submission title+body+url 52 MB.
- 657,182 of the 661,782 users have at least one post or comment; 81,173
  submitters, 623,518 commenters.

## Output

| | Size |
|---|---|
| `base.db` | 1.24 GiB (comments 627 MB, comments FTS 244 MB, users ~120 MB, submissions 78 MB + FTS 32 MB, indexes) |
| `media/submission_images/*.webp` (800 px) | 1.68 GiB (31,467 files, 0 conversion errors; from 38.4 GiB of originals) |
| `media/submission_images/thumb/*.webp` (160 px) | 111 MiB data (173 MB on disk) |

Below the plan's 1.5-2 GB DB / ~4 GB images: the source simply has less (466 MB
of text; 800 px WebP averages 56 KB). Build times on the shared, loaded box:
export 3 min, images 100 min (7 procs), transform 19 min, verify 2 min.

Row counts equal the source for every table (verify.py). FKs clean
(`PRAGMA foreign_key_check` = 0), every submission's `comment_count` equals its
comment rows, FTS doc counts equal table rows.

## Decisions

- **Ids kept** (task URLs carry submission and comment ids). Submissions and
  comments use AUTOINCREMENT, so new rows get max+1 (submission 137403, comment
  2561513). The real site differs: its Postgres sequences `submissions_id_seq`
  and `comments_id_seq` have `last_value = 1` (WebArena loaded rows with explicit
  ids), so the real Postmill hands out ids 2, 3, ... for new posts/comments.
  Graders must not hard-code new ids (WebArena's own `reddit_get_post_url` uses
  the last URL).
- **Raw values kept**: titles with `&amp;`, `biography` = Reddit account id
  (`t2_...`, this is the bio text the profile shows -- task 399 replaces it),
  `sidebar` = subreddit id (`t5_...`), `description` = forum name.
- WebArena abused Postmill's `user_flag` column for the Reddit fullname
  (`t3_`/`t1_`); moved to `reddit_id`, `user_flag` = `none`.
- **Passwords**: Postmill = Symfony native = bcrypt `$2y$13$`. All users but
  `a_Ninja_b0y` (id 9) share one hash = `test1234`. bcrypt-13 costs ~1.5 s per
  verify in hash-wasm on this box, so `password_hash` holds one deterministic
  kit-format scrypt hash for those users (24 ms first verify incl. module
  load); id 9 keeps its bcrypt (unknown password). Kit default verify works.
- **Scores**: `net_score` stored, votes adjust by delta (triggers). Real
  Postmill recomputes from vote rows (first vote resets a 3,000-point post to
  +-1, and moves it to the top of `hot`). We keep delta scores but reproduce the
  `ranking` jump. Graders: check vote rows, not scores.
- **ranking**: WebArena set `ranking = net_score` for imported posts (so
  `hot` == `top` on imported data); new posts get `unixtime + advantage` and
  always sort above imported ones in `hot`.
- **Images**: WebP 800 px long side (q80, never upscaled, EXIF-rotated, GIF
  first frame) + 160 px thumbnails, named by the original sha256 stem.
  `images.file_name` keeps the original name: task 615-619 graders look for
  `<sha256>.jpg` in the reposted submission's `src`/`href` -- the lite grader
  should compare `image_id` instead (SQL), or the UI can expose the original
  file name in the image link.
- Dropped: IPs, Postgres tsvectors, the single e-mail address (user id 9).
- Dropped indexes on `comments.created_at` / `users.created_at` (68 + 18 MB per
  tenant copy) -- Postmill lists comments and users by id.

## Postmill routes (for the UI builder)

From `config/app_routes/*.yaml` of the image (task URLs use these):
front `/{sortBy}`, `/featured|subscribed|all|moderated/{sortBy}`; forum
`/f/{forum}/{sortBy}`, `/f/{forum}/edit`, `/f/{forum}/comments`,
`/f/{forum}/moderators`, `/f/{forum}/moderation_log`, `/f/{forum}/bans`,
`/f/{forum}/ban/{username}`, `/f/{forum}/subscribe`, `/create_forum`,
`/forums/{sortBy}/{page}`, `/forums/all`; submission
`/f/{forum}/{id}/{slug}`, `/f/{forum}/{id}/{slug}/edit|delete|lock|unlock|pin|unpin`,
`/submit/{forum}`, vote `/sv/{id}.json` (POST choice), comment
`/f/{forum}/{id}/{slug}/comment/{cid}` (+ `/edit`, `/delete_own`), `/cv/{id}.json`;
user `/user/{name}`, `/user/{name}/submissions|comments|edit_biography|preferences|account`,
`/users/{page}`; messages `/messages`, `/messages/thread/{id}`,
`/user/{name}/compose_message`; `/inbox`, `/notifications`; `/search?q=`;
wiki `/wiki/{path}`, `/wiki/_edit|_create|_history/{path}`; `/login`, `/registration`.
Vote widget the tasks inspect: `div.submission__vote form` with class
`vote vote--user-upvoted|vote--user-downvoted`; bio `.user-bio__biography`;
post `.submission__inner`, `.submission__title`, `.submission__body`; forum
edit form `#forum_description`, `#forum_sidebar`; front sidebar
`#sidebar > section` lists subscribed forums.

## Task data check (WebArena tasks with "reddit" in sites: 129 = 106 + 23 cross-site)

All 120 distinct `__REDDIT__/f/...` and `/user/...` URLs in those tasks resolve:
forum exists (case-insensitive), submission id is in that forum, stored slug
equals the URL slug, comment ids belong to their submission. Forums referenced
but absent: `sci_fi`, `cmu_lti`, `Cyberpunk`, `PlantsForCatParents`, `Karaoke`
(created by tasks 580-584) and **`games`** (task 644's reference URL
`/f/games` -- no such forum; the other "games subreddit" tasks 671-675 use
`/f/gaming`).

Spot-checked facts, each computed on the source Postgres and on base.db
(identical in both; `verify.py` FACTS):

| # | Tasks | Fact | Value |
|---|---|---|---|
| 1 | 27 | latest Showerthoughts post author: comments with net_score<0 | 0 (ref 0) |
| 2 | 28 | latest WorcesterMA author (mineinhusdson): comments <0 | **1** (ref "0" -- see open issues) |
| 3 | 29 | latest DIY author | 1 (ref 1) |
| 4 | 30 | latest space author | 0 (ref 0) |
| 5 | 31 | latest photoshopbattles author | 0 (ref 0) |
| 6 | 66-69 | top-10 books by score | 81371,59421,59447,103102,124017,59466,59478,17445,59396,103061 (contains refs 59396, 17445, 59421) |
| 7 | 404 | newest books post | 124260 (= task URL) |
| 8 | 405-408 | newest DIY/Futurology/deeplearning/explainlikeimfive | 119019, 119517, 125036, 125342 |
| 9 | 552 | 5 newest in space | 134164..134160 (= task) |
| 10 | 562-566 | DIY by sort=active | 118903,118923,118935,118904,118960,118931,118824,118866,118820,118836 (= task order) |
| 11 | 714 | top post in gadgets | 19459 (= task) |
| 12 | 718 | top-5 technology | 48670,134696,48785,70354,70233 |
| 13 | 719 | ThetaGang_wsb in wallstreetbets | 29458, 29478 (= task) |
| 14 | 724/730 | Hrekires posts in news | 10 |
| 15 | 723/726 | FTorrez81 has 1 post in `iphone` (none in "iphone13", no such forum); jacyanthis 0 in EarthPorn (his post is in philosophy) | N/A answers hold |
| 16 | 399, 731-735 | MarvelsGrantMan136: 667 submissions, 28 comments, bio `t2_5adwlxvn` | |
| 17 | 731 | submission 1: "Crazy device for ML!", MachineLearning, MarvelsGrantMan136 | |
| 18 | 732-735 | his television posts 134868, 135152, 135156, 135201 have empty bodies (tasks expect exact_match of the added line) | |
| 19 | 615 | image `b02113033af3...jpg` = submission 110715 "Amazing shot of a Blue Jay pestering a Bald Eagle" | |
| 20 | 409 | comment 1235250 by ameliaspond, top-level in 59421 | |
| 21 | 410 | comment 1042264 by rrlguy, top-level in 69404 | |
| 22 | 600-649 | target forums exist: consoles, nyc, pittsburgh, washington, washingtondc, deeplearning, MachineLearning, singularity, books, EarthPorn, funny, relationship_advice, iphone, movies, headphones, sports, DIY, BuyItForLife, gaming, technology, dataisbeautiful, history, LifeProTips, aww, science | |
| 23 | - | sum of submission / comment scores | 29,782,943 / 20,089,487 |

Login: `MarvelsGrantMan136` / `test1234` verifies through `kit/lib/auth.js`.

Triggers tested on a copy: a vote moves `net_score` 0->1 and `ranking`; a
comment bumps `comment_count`/`last_active_at` and is found by `comments_fts`;
a new submission gets id 137403 and `ranking` = unixtime.

## Open issues for task conversion

- **Task 28**: reference "0", data says 1 (mineinhusdson's comment 2555253,
  score -2, on his own post). The WebArena annotation is likely wrong; re-derive
  by SQL (PLAN §5).
- **Task 644** points at `/f/games`, which does not exist (only `gaming`).
- "Latest post": Postmill `new` = `id DESC`; in several forums `id` order and
  `created_at` order disagree (Reddit import order). Tasks 27-31 / 404-408 /
  552 match `id DESC` -- convert with that.
- Tasks 595-599 check the front-page sidebar for subscriptions; the source has
  no subscriptions, so the sidebar starts empty for every user.
- Moderation tasks (none in WebArena) would need a moderator: nobody moderates
  any forum in the source; `KrokmaniakPL` is the only site admin.
- The site clock: data ends 2023-03-31 (plus submission 1 on 2023-06-12, user
  last_seen up to 2023-07-11). Suggest "today" = 2023-07-11 or later so
  time-window sorts (`top?t=week`) are well defined; WebArena tasks only use
  `all`-time sorts.

## UI build (2026-11-14)

Site: `sites/forum/` -- [server.js](../sites/forum/server.js), routes/, views/, public/,
[ROUTES.md](../sites/forum/ROUTES.md) (every URL, params, effects), [grade.js](../sites/forum/grade.js),
tests in `test/`. Run: `node sites/forum/server.js --tenants 2 --port 7200 --data $WSB_DATA_ROOT/forum`.

Decisions:
- **Clock**: "today" = 2023-07-11 16:00 UTC (running), after the newest data (users seen up to
  2023-07-11), so all-time sorts are as in WebArena and short windows (`?t=week`) are empty
  until the rollout posts something.
- **Deletes are soft**: author delete -> `visibility='soft_deleted'`, moderator removal ->
  `'trashed'` (+ `moderated=1`, log entry). Nothing is hard-deleted; graders test `visibility`.
- **Auto-upvote**: new submissions and comments get the author's upvote (Postmill does this:
  the one source vote is MarvelsGrantMan136 on his own post), so they start at score 1.
- **Titles link to the submission page** (not the external URL; the domain link next to it
  goes to `url`). Postmill's `submission_link_destination=url` sent title clicks off-site,
  a dead end for agents.
- Forum creators become moderator and subscriber. Login-required GETs redirect to `/login?next=`.
- **Postmill-compatible bits for task conversion**: URL scheme; vote widget classes
  (`vote--user-upvoted`); `.user-bio__biography`, `.submission__title/__body`, `#sidebar > section`;
  form ids `#forum_description`, `#forum_sidebar`; images linked as `/submission_images/<original
  file_name>` (tasks 615-619 look for `<sha256>.jpg` in href/src).
- Markdown: a small safe CommonMark subset in `lib/forum.js` (HTML escaped, entities kept, so
  Reddit's `&gt;` shows as `>`; titles are escaped verbatim so `&amp;` shows as in Postmill).
- Search: FTS5. Words ANDed, phrases kept. Prefix match only on the last word of post
  searches and only with 4+ letters (`"the"*` over 2.5M comments takes 1.5 s). bm25 ranking up to
  3,000 post / 1,500 comment matches; beyond that results come from the newest 3,000 matches,
  newest first (cold random row reads cost ~0.1 ms each, so the scan stays small). Forum/time
  filters apply within that bound. "Did you mean" uses the forum-name vocabulary only.
  FTS gotcha: `rowid IN (?, ?, ...)` with bound params plus MATCH makes FTS5 visit every match
  (minutes for common words); the snippet query inlines the integer ids instead.

Build additions ([build/site.sql](../sites/forum/build/site.sql), run by `transform.py` and by
`build.sh site` in place; base.db was patched in place, 1.25 GiB):
- `submissions_hidden` partial index (`forum_id WHERE visibility <> 'visible'`): visible
  submission counts per forum = covering count minus this (the forum list went from 270 ms to 20 ms).
- `user_stats` (per-user visible counts and karma) + triggers: the profile of `[deleted]`
  (id 10000, 327,659 comments, 8,855 posts) took 2.7 s to aggregate, now 15 ms.
- Seeded forum categories (9 tags, one per forum) for `/forums/by_category`; `verify.py`
  treats `forum_tags`/`forums_tags` as seeded (no source count check) and checks `user_stats`
  totals against the aggregates. Verify passes.

DB mode: the kit default **overlay** (all tenants on the one base.db, no copies; copy mode
also works: `--db-mode copy`). Stop forum servers before `build.sh site`/`transform` touch base.db.

Performance (single client, warm, `node sites/forum/test/bench.js --rounds 10`: 47 pages incl.
listings with sorts/windows/deep pages, 244-comment thread, user pages incl. `[deleted]`,
searches for common words, logged-in pages), on the shared build box at load ~23:
overlay p50 21 ms, p95 85 ms, p99 138 ms, max 225 ms (copy mode: p50 27-30, p95 103-117).
Reset 0.5-0.7 ms. 2 tenants start in ~1 s.

Tests: `node --test sites/forum/test/forum.test.js` (18 tests against the real base.db, 2
tenants in-process: every page renders, listing order == SQL for each sort (incl. task facts
404, 562-566, 714), login, CSRF, votes JSON + form, comments/replies/notifications, submit
text/link/image, subscriptions, forum create/edit, lock/remove/ban/log, bio/prefs/account,
registration, messages, wiki, search, grade.js, user_stats exactness, reset + tenant
isolation). Browser: `node sites/forum/test/smoke.js --base http://127.0.0.1:7200` (log in
as MarvelsGrantMan136, browse, JS votes, comment, reply, post, subscribe, search, reset
restores the DB exactly and drops the session); passes on both tenants of a `--tenants 2` server.

Headless Chrome gotcha (Chrome 145, new headless): after a password form is submitted, the
window silently stops receiving input (the invisible "save password?" prompt; profile prefs
and incognito don't help). The smoke test moves the session cookie to a new browser context
after logging in through the form. Rollout harnesses that log in through the UI in headless
Chrome may hit the same thing (`POST /__rl/login` avoids it).

Not built / simplified: hidden forums, user blocks, site-wide bans UI (table exists), forum
deletion, flair, themes/custom CSS, Postmill's cursor-based `next[...]` paging (pages are
`?page=N`), comment search sort by relevance for very common words (see above).

## Task conversion (2026-11-15)

The 106 reddit-only WebArena tasks are in [../tasks/forum/webarena.jsonl](../tasks/forum/webarena.jsonl)
(generated by `python3 -I tasks/forum/convert.py`), evidence in
[../tasks/forum/verify.jsonl](../tasks/forum/verify.jsonl). All 106 verified by a manual run
through the UI with `tasks/tools/browse.js` (headless Chrome, step by step), graded with
`tasks/tools/grade.js`; none dropped. One negative check per template (21/21) fails as it should;
on a fresh tenant with no answer all 104 non-fuzzy tasks fail.

Evaluator conversion:
- string_match -> `answer` (must_include kept; 27-31 derive the count by `answer_sql`, restricted to
  rows before 2023-06-13 so the agent's own posts cannot move it). Fuzzy "N/A" (723, 726) stays fuzzy.
- url_match -> `url` with `url_match: 'prefix'` (new in sites/forum/grade.js; WebArena's check is a
  substring test, so ending on the new post under /f/X passes).
- program_html -> SQL: bios `users.biography`; votes = `submission_votes` rows (upvote 1/0), never
  net_score; new posts = the user's newest submission created after the data (title+url+body
  contains the needles, case-insensitive, forum in the reference set); comments by parent/submission;
  forums row (description, sidebar); `forum_subscriptions`; post bodies. Image re-posts (615-619)
  pass when the new post's url/body contains the original image's sha256 (the
  `/submission_images/<file_name>` link copied from /f/pics) or `image_id` is the original image.
  An upload of a downloaded copy does not pass (the served file is a re-encoded WebP).

Reference fixes: 28 "0" -> 1 (data); 407/408 referenced the hot/top post, not the newest
(-> 125036, 125342); 644 /f/games does not exist -> intent "gaming subreddit", /f/gaming;
584 checked form fields on the forum page (unpassable) -> SQL like 580-583; 68 accepts Charles
Dickens (author) besides LeVar Burton (narrator) and "Tolkien" for any spelling of J. R. R.;
66 URLs reduced to host-independent `/f/books/<id>` paths.

UI fix: forum search (`/search?type=forums`) matched only FTS tokens, so "machine learning"
found nothing; it now also matches names by substring (ROUTES.md, test added).

Grader notes: must_include on short numbers is WebArena-lenient ("10" contains "1"); the
task 23 group's 409/410 accept any reply by the user under the target comment that contains
the text; vote tasks do not penalise extra votes on other posts (as WebArena).

## Generated tasks (2026-11-15)

Generator: [../tasks/forum/gen/](../tasks/forum/gen/) (`node tasks/forum/gen/index.js --seed 1` ->
[../tasks/forum/generated.jsonl](../tasks/forum/generated.jsonl), deterministic, ~12 s; `--list` prints the
templates). 40 templates in 11 family modules (listings, search, threads, users, forums, votes, comments,
posts, profile, messages, moderation), 2,314 tasks (1,054 read / 1,260 write; difficulty 1/2/3 = 436/1,638/240),
60 per template except newest-post-comments (16) and category-largest-forum (18). Every reference is computed
by SQL on base.db at generation time; answer tasks carry a static reference plus `answer_sql` (drift check),
state tasks compare rows. `node tasks/forum/gen/check.js --site <tenant>` re-checks all tasks on a fresh tenant:
answer_sql == reference, the reference passes, empty/decoy answers fail, every state check fails untouched.

Validation: per template 2 instances done by hand through the UI with `tasks/tools/browse.js` (headless
Chrome, :7250) and graded with `tasks/tools/grade.js`, plus 1 negative (wrong answer or wrong/over-broad
action) -- 80 positive + 40 negative lines in [../tasks/forum/verify-generated.jsonl](../tasks/forum/verify-generated.jsonl),
all ok. No site bugs found.

Design decisions / data facts:
- Moderation: nobody moderates a forum in the data, so moderation tasks log in as the site admin
  `KrokmaniakPL` (moderator of every forum). Moderator "Remove" has a fixed reason, so removal tasks don't
  ask for one; bans do (the ban form takes a reason).
- No post has a negative score (min 0 everywhere), so "lowest score" questions are degenerate; the
  template asks for the score of the N-th post by top instead (neighbours must differ).
- Time windows: the clock (2023-07-11) is past the data (ends 2023-03-31), so `?t=day|week|month` are empty and
  `t=year` == all; no template uses windows. Pages show relative times only, so no date questions either.
- "Top comment" = first comment shown (top-level, highest score); a reply can outscore its parent, so vote
  templates require the global max to be top-level. Link-post templates require the target within the first
  two pages of `/top` and URLs without `&amp;` (Reddit-escaped URLs are stored raw).
- Answer titles exclude `&`/entities/emoji; typographic quotes get an ASCII ` |OR| ` alternative. Intents only
  quote ASCII-clean, site-wide unique titles. Single-name comparisons (compare-karma) use `exact`, since
  must_include would pass an answer naming both users.
- Write graders reject spray actions: other comment votes in the thread, other subscriptions, other locked/
  pinned posts, other bans, extra moderators, other deleted comments, unrequested preference changes,
  messages to other users, and the bio template fails if it names the user's other forums.
- bio-top-forum has 12 distinct intents over 60 login users (the answer depends on who is logged in).
