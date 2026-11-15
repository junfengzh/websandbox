# Forum lite schema

`base.db` (SQLite) built by [build/](build/) from the WebArena Postmill database.
DDL: [build/schema.sql](build/schema.sql) (tables, views),
[build/search.sql](build/search.sql) (FTS5 + triggers) and [build/site.sql](build/site.sql)
(lite-site additions: `user_stats`, the `submissions_hidden` index, seeded forum categories). Media under
`DATA/media/` (served by the kit at `/media/...`).

Conventions: ids of users, forums, submissions, comments are **Postmill's ids**
(task URLs contain them). Timestamps are `'YYYY-MM-DD HH:MM:SS'` UTC text
(Postmill showed them in the user's timezone, `America/New_York` for all but one
user). Booleans are 0/1. Text values are raw source values -- e.g. titles keep
HTML entities like `&amp;` exactly as stored (Postmill escaped them again on
output, so the page showed `&amp;`).

## Tables

| Table | Rows | Notes |
|---|---|---|
| `users` | 661,782 | `username` (display), `normalized_username` = lower (unique; use for login and `/user/<name>`), `password_hash` (see Passwords), `role` `user`/`admin` (1 admin: `KrokmaniakPL`), `biography` (WebArena stored the Reddit account id `t2_...` here -- this is what the profile page shows), `created_at`, `last_seen_at`, preference columns copied from Postmill (`timezone`, `front_page`, `front_page_sort_mode`, `night_mode`, `show_thumbnails`, `allow_private_messages`, ...) |
| `forums` | 95 | `name` (mixed case, e.g. `DIY`, `EarthPorn`), `normalized_name` (lower, unique: `/f/diy` == `/f/DIY`), `title`, `description` (= name in the data), `sidebar` (= subreddit id `t5_...` in the data), `created_at`, `featured`, `moderation_log_public` |
| `forum_tags`, `forums_tags` | 9, 95 | forum categories (`/forums/by_category`, `/tag/<name>`); empty in the source, **seeded by site.sql** (Technology, Gaming, Science & Learning, News & Politics, Entertainment, Humor & Memes, Pictures & Art, Lifestyle & Advice, Places; one per forum) |
| `moderators` | 0 | (forum, user); empty in the source -- nobody moderates; site admin can |
| `forum_subscriptions` | 0 | (user, forum, subscribed_at); empty -- every subscriber count is 0 |
| `hidden_forums` | 0 | |
| `forum_bans` | 0 | ban/unban events per forum (`banned` 1/0, `expires_at`); current state = latest row per (forum,user) |
| `user_bans`, `user_blocks` | 0 | site-wide bans; user block list |
| `images` | 31,467 | `id` (Postmill uuid), `file_name` (original `<sha256>.<ext>`; tasks look for it in `src`/`href`), `width`/`height` (original), `path`/`thumb_path` (WebP under media/), `media_width`/`media_height`, `bytes` |
| `submissions` | 127,391 | `forum_id`, `user_id`, `title`, `slug`, `url` (link posts), `body` (markdown; `''` or NULL), `media_type` `url`/`image`, `image_id`, `created_at`, `edited_at`, `last_active_at`, `sticky`, `locked`, `moderated`, `visibility` (`visible`/`soft_deleted`/`trashed`), `user_flag`, `net_score`, `comment_count`, `ranking`, `reddit_id` (`t3_...`) |
| `comments` | 2,551,513 | `submission_id`, `parent_id` (NULL = top level), `user_id`, `body`, `created_at`, `edited_at`, `visibility` (`soft_deleted` = shown as "[deleted]" with replies kept), `moderated`, `user_flag`, `net_score`, `reddit_id` (`t1_...`). Max 244 comments per submission, median 8 |
| `submission_votes`, `comment_votes` | 1, 0 | one row per (user, item); `upvote` 1/0. The single source vote: MarvelsGrantMan136 upvoted his own submission 1 |
| `forum_log_entries` | 0 | moderation log; `action_type` `ban`, `submission_deletion`, `submission_restored`, `submission_lock`, `comment_deletion`, `comment_restored` |
| `message_threads`, `message_thread_participants`, `messages` | 0 | private messages (`/messages`); `subject` is a lite addition |
| `notifications` | 0 | `notification_type` `comment`/`submission_mention`/`comment_mention`/`message`; `read_at` lite addition |
| `wiki_pages`, `wiki_revisions` | 0 | `/wiki/<path>`; current text = latest revision |
| `site_settings` | 17 | key/value copy of Postmill's `sites` row, plus `source_bcrypt_0` (the shared original bcrypt hash) (`site_name`=Postmill, `wiki_enabled`, `forum_create_role`=ROLE_USER, `default_sort_mode`=hot, ...) |
| `user_stats` | 657,182 | site.sql: per-user `submissions`, `comments` (visible counts), `submission_karma`, `comment_karma` (sums of visible `net_score`); kept exact by triggers on submissions/comments (insert, `net_score`/`visibility` change, delete). The profile page reads it |
| views `user_karma`, `forum_stats` | | karma = sum of visible scores (Postmill has no karma); submission/subscriber counts |
| FTS5 `submissions_fts(title, body, url)`, `comments_fts(body)` | | external content, `porter unicode61` (stemmed, like Postmill's english tsvector search) |
| FTS5 `forums_fts(name, title, description, sidebar)` | | `unicode61` (unstemmed; usable as `kit.search.didYouMean` vocabulary) |

Data ranges: submissions 2022-10-01 .. 2023-03-31 (imported from Reddit), plus
submission 1 by MarvelsGrantMan136 on 2023-06-12 (the newest row). Comments
2022-10-01 .. 2023-03-31. Users created up to 2023-06-12 (some with
`created_at` 1970-01-01).

## Passwords

Postmill uses Symfony's `native` hasher = PHP `password_hash()` bcrypt,
`$2y$13$...` (cost 13, ~1.5 s per verify in hash-wasm). In the source, 661,781
users share one hash, which verifies as WebArena's documented password
**`test1234`**; one user (`a_Ninja_b0y`, id 9) has another, unknown password.

`users.password_hash`: for users whose bcrypt matched `test1234`, one
deterministic `scrypt$1024$<salt>$<hash>` string (kit format, ~2 ms); for id 9
the original `$2y$13$` hash. The kit's default `kit.auth.verifyPassword(pw,
user.password_hash)` handles both, so no `auth.verify` override is needed. The
replaced (shared) original bcrypt hash is kept once, in
`site_settings.source_bcrypt_0`. Login by
username: `findUser: (db, login) => db.prepare('SELECT * FROM users WHERE
normalized_username = lower(?)').get(login)` (Postmill logins are
case-insensitive on the normalized name).

## Scores, votes, ranking (sorts)

- `net_score` is the stored score. Source scores are the Reddit scores at
  import time; there are no per-vote rows behind them. Triggers on
  `*_votes` adjust `net_score` by the vote delta (+1/-1, +-2 on flip, undo on delete).
  **Quirk of the original:** Postmill recomputes `net_score` from the vote rows
  on every vote, so in real WebArena the first vote on a post resets its score to
  +-1. The lite schema deliberately keeps the delta behaviour; graders should
  check the vote rows (`submission_votes WHERE user_id=13915 AND
  submission_id=?`), not the score.
- Upvote/downvote counts are not available separately. "Comments with more
  downvotes than upvotes" (tasks 27-31) = `net_score < 0`.
- Sorts (Postmill `SubmissionPage::SORT_MAP`), all with `id` as tie-break in the
  same direction: `hot` = `ranking DESC`, `new` = `id DESC`, `active` =
  `last_active_at DESC`, `top` = `net_score DESC`, `controversial` =
  `net_score ASC, id ASC`, `most_commented` = `comment_count DESC`. Time windows
  (`?t=day|week|month|year|all`) filter `created_at` against the site clock.
  Stickies first on page 1.
- `ranking`: WebArena imported every post with `ranking = net_score` (so `hot`
  == `top` for imported posts). Postmill sets `ranking = unixtime(created) +
  clamp(net*1800 + comments*(net > -5 ? 5000 : 500), -43200, 86400)` on new posts
  and on every vote/comment, which puts new or just-voted posts above all
  imported ones in `hot` -- in real WebArena too. The triggers reproduce this
  (`submissions_ranking_ai/au`); submission 1 already has it.
- Comments: Postmill orders siblings by `net_score DESC` (then id); index
  `comments_submission(submission_id, parent_id, net_score)`.

## Triggers (keep stored aggregates right for any write path)

- FTS sync on insert/update/delete of submissions, comments, forums.
- votes -> `net_score`; `net_score`/`comment_count` change -> `ranking`.
- comment insert -> `comment_count + 1`, `last_active_at = max(.., created_at)`;
  comment delete -> `comment_count - 1`. Soft delete (visibility) does not change
  counts (as Postmill).
- New submissions: insert with `ranking = 0` (or anything); the insert trigger
  sets the Postmill value.

## URLs (Postmill routes the tasks use)

`/f/<forum>` (+ `/hot|new|active|top|controversial|most_commented`),
`/f/<forum>/<id>/<slug>` (slug ignored on lookup; `-` is used in comment links),
`/f/<forum>/<id>/-/comment/<comment_id>`, `/f/<forum>/edit`
(`#forum_description`, `#forum_sidebar`), `/create_forum`, `/submit/<forum>`,
`/user/<name>` (`.user-bio__biography`), `/user/<name>/edit_biography`,
`/forums`, `/search?q=`, `/messages`, `/notifications`, `/wiki/<path>`,
`/f/<forum>/moderation_log`, `/f/<forum>/bans`. Slug = Postmill
`Slugger::slugify(title)`: lower-case, split on non-word characters, joined
with `-`, cut at the last whole word within 60 characters (`submissions.slug`).
