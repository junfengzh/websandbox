# Forum routes (`forum.wa`)

Every URL the forum serves, for the grader and the task converter. Postmill's URL scheme
is kept where the WebArena tasks use it (`/f/<forum>`, `/f/<forum>/<id>/<slug>`,
`/user/<name>`, `/forums`, `/search?q=`, `/submit`, sort paths). Server:
[server.js](server.js); handlers: [routes/](routes/); tables: [SCHEMA.md](SCHEMA.md);
URL canonicalisation and SQL helpers for graders: [grade.js](grade.js).

Conventions:

- **Case-insensitive names**: `/f/books` == `/f/BOOKS`, `/user/marvelsgrantman136` ==
  `/user/MarvelsGrantMan136` (lookups use `normalized_name` / `normalized_username`).
  Generated links use the stored spelling (`/f/DIY`, `/f/MachineLearning`).
- **Slugs are ignored** on lookup: `/f/books/59421/-` == `/f/books/59421/friendly-reminder-bookshop-org-exists`.
  A submission id under the wrong forum is a 404. `/f/<forum>/<id>` (no slug) redirects to the slugged URL.
- **Paging**: `?page=N` (1-based, omitted for page 1), 25 items per listing page; "More »" /
  "« Previous" links (no total count, like Postmill). Forum list and user list: 50 per page.
- **Sorts** (`<sort>` below): `hot` (default; `ranking DESC`), `new` (`id DESC`), `active`
  (`last_active_at DESC`), `top` (`net_score DESC`), `controversial` (`net_score ASC`),
  `most_commented` (`comment_count DESC`); ties by `id` in the same direction. Time window
  `?t=day|week|month|year|all` (default `all`) filters `created_at` against the site clock
  (default "now" 2023-07-11 16:00 UTC, running). Stickies (`sticky=1`) are listed first on
  page 1 of a forum. Unknown sort -> 404.
- **Writes** are form POSTs with a CSRF token (`_csrf` field, or `X-CSRF-Token` header for
  `fetch`). Login-required pages redirect anonymous GETs to `/login?next=<url>`; anonymous
  POSTs get 401 (403 if they have no session/CSRF token at all). Success redirects (302)
  and sets a flash message; validation errors re-render the form with status 422.
- **Deletion is soft** everywhere: graders should test `visibility`, not row existence
  (`visible` | `soft_deleted` = deleted by its author | `trashed` = removed by a moderator).
  Non-visible submissions/comments are left out of listings, search, counts and karma.
- Moderator = a row in `moderators` for the forum, or the site admin (`users.role='admin'`,
  only `KrokmaniakPL`). Creating a forum makes the creator its moderator.

## Front page and listings

| Method | Path | Notes |
|---|---|---|
| GET | `/` , `/<sort>` | Front page. Logged in: the user's `front_page` setting (default `subscribed`; with no subscriptions it falls back to all forums with a notice) and `front_page_sort_mode` (default `hot`). Anonymous: all forums. `?t=`, `?page=` |
| GET | `/all`, `/all/<sort>` | All forums |
| GET | `/subscribed`, `/subscribed/<sort>` | Forums the user subscribes to (login) |
| GET | `/featured`, `/featured/<sort>` | Forums with `featured=1` (none in the data) |
| GET | `/moderated`, `/moderated/<sort>` | Forums the user moderates (login) |
| GET | `/f/<forum>`, `/f/<forum>/<sort>` | Forum page: listing + sidebar (`#sidebar`: description, sidebar text, submission/subscriber counts, subscribe button, categories, moderators, mod tools) |
| GET | `/f/<forum>/<id>` | Redirect to `/f/<forum>/<id>/<slug>` |
| GET | `/comments` | Latest comments site-wide (`id DESC`) |
| GET | `/f/<forum>/comments` | Latest comments on the forum's 200 most recently active submissions |
| GET | `/submission_images/<file_name>` | Image by its original Postmill file name (`images.file_name`, e.g. `<sha256>.jpg`); serves the stored WebP (or the uploaded file). The submission page links images this way |
| GET | `/media/submission_images/<sha256>.webp`, `.../thumb/<sha256>.webp` | Shared media (800 px / 160 px) |
| GET | `/uploads/<name>` | This tenant's uploads (emptied by reset) |

Listing rows: `<article class="submission post-row" id="submission-<id>">` with the vote
widget, thumbnail, `.submission__title a.submission__link` (-> submission page), the link
domain (-> `url`), submitter, time (`<time datetime>`), forum, comment count.

## Submissions and comments

| Method | Path | Body / params | Effect |
|---|---|---|---|
| GET | `/f/<forum>/<id>/<slug>` | `?sort=top\|new\|old` (comments; default `top` = `net_score DESC, id`) | Submission page: `.submission__title`, `.submission__body`, link/image, actions, threaded comments. Each comment is `<details class="comment" id="comment-<cid>" open>` (summary = collapse toggle), with Reply (`<details class="reply-box">`), Permalink, Parent, Edit/Delete (own), Remove/Restore (moderators). Deleted comments with replies show as `[deleted]`/`[removed]` |
| GET | `/f/<forum>/<id>/<slug>/comment/<cid>` | | Permalink: that comment and its replies, links to parent and full thread |
| GET | `/submit`, `/submit/<forum>` | `?forum=` preselects | Submit form (login): post type radio `type` = `link`\|`text`\|`image`, `forum` (select, `#submission_forum`), `title` (`#submission_title`), `url` (`#submission_url`), `image` (file, `#submission_image`), `body` (`#submission_body`) |
| POST | `/submit`, `/submit/<forum>` | multipart or urlencoded: `type, forum, title, url, body, image` | Inserts `submissions` (slug = Postmill slugify, `media_type` `url`/`image`, `ranking` by trigger) + the author's upvote (`submission_votes`, like Postmill; new posts start at `net_score` 1); image uploads add an `images` row (`file_name` = `<sha256>.<ext>`, `path` = `/uploads/...`). Mentions (`@name`, `/u/name`) notify. Redirects to the new post. 403 if banned from the forum |
| GET/POST | `/f/<forum>/<id>/<slug>/edit` | `title, url, body` | Author or moderator; sets `edited_at` |
| POST | `/f/<forum>/<id>/<slug>/delete` | `reason` (moderators) | Author: `visibility='soft_deleted'`. Moderator (not own, or own with a `reason`): `visibility='trashed', moderated=1` + log `submission_deletion` |
| POST | `/f/<forum>/<id>/<slug>/restore` | | Moderator: `visibility='visible'` + log `submission_restored` |
| POST | `/f/<forum>/<id>/<slug>/lock`, `/unlock` | | Moderator: `locked` 1/0 + log `submission_lock` (`locked` 1/0). Locked: no new comments (except moderators) |
| POST | `/f/<forum>/<id>/<slug>/pin`, `/unpin` | | Moderator: `sticky` 1/0 |
| POST | `/f/<forum>/<id>/<slug>/comment` | `comment` (or `body`), `parent_id` (optional) | New comment (login; not on locked/deleted posts; not when banned) + author's upvote; `comment_count`/`last_active_at` by trigger; notification `comment` to the parent comment's (or submission's) author, `comment_mention` for mentions. Redirects to `<post>#comment-<cid>` |
| GET/POST | `/f/<forum>/<id>/<slug>/comment/<cid>/edit` | `comment` | Author or moderator; sets `edited_at` |
| POST | `/f/<forum>/<id>/<slug>/comment/<cid>/delete_own` | | Author: `visibility='soft_deleted'` |
| POST | `/f/<forum>/<id>/<slug>/comment/<cid>/delete` | `reason` | Moderator: `visibility='trashed', moderated=1` + log `comment_deletion` |
| POST | `/f/<forum>/<id>/<slug>/comment/<cid>/restore` | | Moderator + log `comment_restored` |

## Votes

| Method | Path | Body | Effect |
|---|---|---|---|
| POST | `/sv/<id>` | `choice=1\|-1\|0`, `next` | Submission vote (login). 1 = up, -1 = down, 0 = retract. One row per (user, submission) in `submission_votes` (`upvote` 1/0; deleted on retract); `net_score` +-1/+-2 by trigger. Redirects to `next` / Referer (no-JS fallback) |
| POST | `/sv/<id>.json` | same | JSON `{netScore, choice}` (used by `static/forum.js`; 401 JSON if logged out) |
| POST | `/cv/<id>`, `/cv/<id>.json` | same | Comment votes (`comment_votes`) |

Widget: `<div class="submission__vote|comment__vote"><form class="vote [vote--user-upvoted|vote--user-downvoted]" action="/sv/<id>">`
with buttons `.vote__up` / `.vote__down` (`aria-pressed`) and `.vote__net-score`. Graders: check
the vote rows, not `net_score` (see SCHEMA.md "Scores").

## Forums

| Method | Path | Body / params | Effect |
|---|---|---|---|
| GET | `/forums`, `/forums/<sort>` | sort = `name` (default) \| `title` \| `submissions` \| `subscribers` \| `created`; `?page=` | Table of forums with counts, categories, subscribe buttons |
| GET | `/forums/all` | | All forums A-Z (cards) |
| GET | `/forums/by_category` | | Forums grouped by category (`forum_tags`) |
| GET | `/tag/<name>` | | Forums in one category (case-insensitive) |
| POST | `/f/<forum>/subscribe`, `/f/<forum>/unsubscribe` | `next` | `forum_subscriptions` insert/delete (login). JSON `{subscribed, subscribers}` with `Accept: application/json` |
| GET/POST | `/create_forum` | `name` (`#forum_name`, 3-25 `\w`, unique case-insensitively), `title`, `description` (`#forum_description`), `sidebar` (`#forum_sidebar`), `tags` (comma-separated categories, `#forum_tags`) | Inserts `forums`; creator becomes moderator and subscriber; unknown categories are created. Redirects to `/f/<name>` |
| GET/POST | `/f/<forum>/edit` | `title, description, sidebar, tags, moderation_log_public`, `featured` (admin) | Moderators. Same field ids as create |
| GET | `/f/<forum>/moderators` | | Moderator list (+ add/remove forms for moderators) |
| POST | `/f/<forum>/moderators` | `username` | Add a moderator (moderators) |
| POST | `/f/<forum>/moderators/<username>/remove` | | Remove a moderator |
| GET | `/f/<forum>/bans` | `?username=` redirects to the ban form | Current bans (latest event per user, not expired) (moderators) |
| GET/POST | `/f/<forum>/ban/<username>` | `reason` (required), `expires` (YYYY-MM-DD, optional) | `forum_bans` row (`banned=1`) + log `ban`. Banned users cannot submit, comment or vote in the forum |
| POST | `/f/<forum>/unban/<username>` | `reason` | `forum_bans` row with `banned=0` + log `ban` |
| GET | `/f/<forum>/moderation_log` | `?page=` | `forum_log_entries` of the forum (403 if `moderation_log_public=0` and not a moderator) |
| GET | `/moderation_log` | `?page=` | Site-wide log (public forums) |

## Users

| Method | Path | Body / params | Effect |
|---|---|---|---|
| GET | `/user/<name>` | `?page=` | Overview: the user's submissions and comments interleaved by time; sidebar `.user-bio__biography`, post/comment karma (`.karma--posts`, `.karma--comments`), counts, registration date, links |
| GET | `/user/<name>/submissions`, `/user/<name>/comments` | `?page=` | `id DESC` |
| GET | `/u/<name>` | | Redirect to `/user/<name>` |
| GET/POST | `/user/<name>/edit_biography` | `biography` (`#user_biography_biography`, <= 300 chars) | `users.biography` (self or admin) |
| GET/POST | `/user/<name>/preferences` | `front_page`, `front_page_sort_mode`, `timezone`, `night_mode` (`auto\|light\|dark`), checkboxes `show_thumbnails`, `open_external_links_in_new_tab`, `notify_on_reply`, `notify_on_mentions`, `allow_private_messages` (ids `#user_settings_<field>`) | `users` columns (unchecked = 0) |
| GET/POST | `/user/<name>/account` | `username`, `email`, `new_password`, `new_password_repeat`, `current_password` (required to change anything; admins exempt) | Username change changes `/user/<name>` |
| GET | `/users` | `?page=` (<= 200) | All users, newest first |

## Messages and notifications

| Method | Path | Body | Effect |
|---|---|---|---|
| GET/POST | `/user/<name>/compose_message` | `subject`, `message` | New `message_threads` (+ 2 participants) + first `messages` row; notification `message` to the recipient (refused if `allow_private_messages=0`) |
| GET | `/messages` | `?page=` | The user's threads, newest activity first, unread counts |
| GET | `/messages/thread/<id>` | | Thread (participants only, else 404); marks its message notifications read |
| POST | `/messages/thread/<id>/reply` | `message` | New message + notifications |
| GET | `/notifications` (`/inbox` redirects) | `?page=` | Notifications (`comment`, `comment_mention`, `submission_mention`, `message`), newest first, unread highlighted |
| POST | `/notifications/clear` | | Marks all read (`read_at`) |
| POST | `/notifications/<id>/read` | | Marks one read |

Header: unread counts in the bell/envelope links (`aria-label="Notifications (N unread)"`,
`"Messages (N unread)"`).

## Search

`GET /search?q=<text>&type=submissions|comments|forums|users&sort=relevance|new|top&t=<window>&f=<forum>&page=N`

- `type` default `submissions`. FTS5 over `submissions_fts(title, body, url)` (bm25 weights 10/2/1),
  `comments_fts(body)`, `forums_fts`; users by name prefix/substring.
- Words are ANDed; `"quoted phrases"` work; the last word of a post search is prefix-matched
  when it has 4+ letters (comments match whole words, stemmed, like Postmill's tsvector search).
- `sort=relevance` ranks by bm25 when at most 3,000 posts / 1,500 comments match; above that
  (common words) results come from the newest 3,000 matches, newest first (the page says so).
  `top` = `net_score DESC`, `new` = `id DESC`.
- `f=<forum>` and `t=` filter the results.

## Wiki

| Method | Path | Body | Effect |
|---|---|---|---|
| GET | `/wiki` | | Redirect to `/wiki/index` |
| GET | `/wiki/<path>` | | Current revision (404 page with a "create" link if missing) |
| GET | `/wiki/_all`, `/wiki/_recent` | | All pages; recent revisions |
| GET | `/wiki/_history/<path>`, `/wiki/_revision/<id>` | | Revisions |
| GET/POST | `/wiki/_create[/<path>]` | `path`, `title`, `body` | `wiki_pages` + first `wiki_revisions` (login). Paths are lower-cased, spaces -> `_` |
| GET/POST | `/wiki/_edit/<path>` | `title`, `body` | New revision (login; locked pages: admin only) |
| POST | `/wiki/_lock/<path>`, `/wiki/_unlock/<path>` | | Admin |

## Accounts

| Method | Path | Body | Effect |
|---|---|---|---|
| GET/POST | `/login` | `login` (`#login-username`), `password` (`#login-password`), `next` | Case-insensitive username. All source users: `test1234` |
| POST, GET | `/logout` | | |
| GET/POST | `/registration` | `username` (`#user_username`), `email`, `password`, `password_repeat` | New `users` row (scrypt hash), logged in |

## Control API

The kit's `/__rl/*` (reset, health, clock, query, login, jobs, stats): see
[../../kit/README.md](../../kit/README.md#control-api-__rl). Reset restores every table above,
FTS indexes, sessions and uploads.
