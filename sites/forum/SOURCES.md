# Forum data: sources, licences, attribution

`base.db` and `media/` of the websandbox forum are extracted from the Postmill
forum ("reddit") that WebArena ships as a docker image. Nothing is added.

| Part | Source | Licence |
|---|---|---|
| Forums, users, submissions, comments, scores, the one vote | WebArena `forum` image (`postmill-populated-exposed-withimg.tar`; rootfs squashfs `forum.sqfs`), PostgreSQL 14 database `postmill` | WebArena: Apache-2.0. The WebArena authors filled the forum with public Reddit content (95 subreddits, posts and comments from 2022-10-01 to 2023-03-31, plus a few later test posts); the texts belong to their Reddit authors and are subject to Reddit's terms (User Agreement / Data API terms). |
| Submission images (`media/submission_images/`) | same image, `/var/www/html/public/submission_images/` (31,467 files, 39 GB), downscaled to WebP | Images posted to Reddit (mostly hosted on i.redd.it / imgur); copyright remains with their owners. |
| Database layout and semantics (sorts, ranking, slugs) | Postmill (https://gitlab.com/postmill/Postmill), the app in the same image | Zlib licence, (c) Emma and contributors. Only behaviour is reimplemented; no Postmill code is copied. |

Usernames, titles and texts are public Reddit content as WebArena published it.
Each submission and comment keeps its original Reddit id (`reddit_id`,
`t3_...` / `t1_...`), forums keep the subreddit id (in `sidebar`, `t5_...`), and
users the Reddit account id (in `biography`, `t2_...`), so items can be traced
back to their origin. Not exported: IP addresses (registration, post, vote IPs),
Postgres search vectors, e-mail addresses (only one account, `a_Ninja_b0y`,
had one; it is set to NULL).

Passwords: all accounts but one share WebArena's documented password
(`test1234`, from WebArena's `browser_env/env_config.py`); the shared original
bcrypt hash is kept in `site_settings.source_bcrypt_0`.

## Attribution text

> Forum data derived from WebArena (Zhou et al., 2023, "WebArena: A Realistic
> Web Environment for Building Autonomous Agents", https://webarena.dev,
> Apache-2.0), which contains public Reddit posts, comments and images
> (copyright their authors; Reddit terms apply). Forum structure modelled on
> Postmill (https://postmill.xyz, Zlib licence).
