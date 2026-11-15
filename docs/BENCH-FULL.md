# Full-stack load benchmark (2026-11-15)

PLAN §9 success criteria, measured with every site up at RL scale on the build box (8 cores, 70 GB, otherwise idle
apart from ~1-2 cores of unrelated background jobs):

```
tasks/tools/sites.sh up --base 7930 --tenants 16 --bind rl --port 7999 --workers 4,map=1
node tasks/tools/bench-full.js --base 7930 --port 7999 --tenants 16 --rollouts 32 --seconds 300 --think 1000-3000
node tasks/tools/bench-full.js --base 7930 --port 7999 --tenants 16 --rollouts 32 --seconds 150 --think 0
```

Store, forum, code and wiki with 4 worker processes each (the wiki notes: "use --workers for many tenants"), the map
with 1 (its notes: 1, or 2; the routing graph is ~3.4 GB per process). `sites.sh --workers` now takes
`W,site=W,...`.

**Result: all four targets met.**

| criterion | target | measured |
|---|---|---|
| reset after a rollout's writes | < 50 ms | server **p95 1.0 ms**, max 1.3 ms (think run); client round trip p95 3.3 ms. No-think stress: server p95 0.9 / max 15 ms, client p95 119 ms (CPU-saturated box) |
| page p95, 32 concurrent rollouts | < 300 ms | **59 ms** with 1-3 s think time (p99 378 ms); **176 ms** with no think time at 949 req/s (p99 663 ms) |
| RAM, all sites x 16 tenants | < 20 GB | **9.6 GB** PSS peak in the think run (14.1 GB after the no-think stress, high-water); 7.0 GB idle after start |
| startup | (none) | **10.7 s** warm page cache, **19.9 s** cold (after `drop_caches`), all 80 tenants healthy |

## The simulated rollouts (`tasks/tools/bench-full.js`)

32 rollouts at a time, each on its own tenant (a pool of 16 per site process, so 2-11 concurrent rollouts per
site), driven by 4 client processes (one process cannot parse HTML at 900 req/s: in a first stress run with a
single client, every latency including reset round trips had a ~75 ms floor from the client's own event loop).
A rollout = a random task of `tasks/splits/{train,heldout}.jsonl` (13,042 single-site tasks): `/__rl/login` as its
`login_user`, GET its start URL, then 8-20 steps: click a random same-origin link (write tasks: half the time a link
to a page with a write form -- product, admin edit page, forum post, issue/MR), submit a search form with words of
the intent (~20% of steps), go back (~10%); write tasks also submit up to 3 allowlisted POST forms (add to cart,
wishlist, review, admin "save" of an unchanged edit form, forum comment, gitlab note / new issue). Every page loads
its same-origin CSS/JS/images (6 parallel, cached per rollout like a browser) and, on the map, `style.json` and the
12 vector tiles of the view. Think time 1-3 s per step (an LLM agent is slower still: closer to 5-20 s), then
`POST /__rl/reset` of the tenant. "Page" = documents + search results + form posts (with their redirect); assets
are reported separately.

## Per site, think time 1-3 s (300 s, 346 rollouts, 23,606 requests, 78 req/s, 0 errors, 0 HTTP 5xx)

p50 / p95 / p99 ms. Reset: server-side `ms` of `/__rl/reset` (p50 / p95 / max) and the client's round trip (p50 / p95).

| site | rollouts | writes | docs | doc | searches | search | form posts | post | assets | reset server | reset client |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shopping | 48 | 69 | 525 | 10 / 29 / 637 | 141 | 26 / 601 / 969 | 69 | 5 / 9 / 1676 | 5 / 13 / 46 | 0.2 / 0.3 / 0.6 | 1.7 / 2.8 |
| shopping_admin | 68 | 9 | 832 | 5 / 47 / 580 | 169 | 13 / 130 / 640 | 9 | 5 / 16 / 16 | 4 / 12 / 68 | 0.2 / 1.0 / 1.9 | 1.8 / 3.2 |
| forum | 66 | 79 | 824 | 9 / 32 / 58 | 183 | 21 / 49 / 74 | 79 | 6 / 12 / 15 | 5 / 24 / 145 | 0.4 / 0.8 / 1.3 | 2.0 / 3.2 |
| gitlab | 64 | 24 | 822 | 7 / 39 / 202 | 175 | 6 / 96 / 932 | 24 | 9 / 12 / 85 | 4 / 59 / 161 | 0.3 / 0.7 / 1.1 | 2.2 / 3.8 |
| wiki | 52 | 0 | 660 | 5 / 22 / 78 | 145 | 34 / 102 / 138 | 0 | - | 4 / 12 / 78 | 0.3 / 0.5 / 0.5 | 2.1 / 5.6 |
| map | 48 | 0 | 607 | 2 / 11 / 75 | 152 | 41 / 215 / 599 | 0 | - | 13 / 264 / 497 | 0.2 / 0.3 / 0.4 | 1.9 / 2.8 |
| **all pages** | 346 | 181 | 5,416 pages: **p50 6.8 / p95 58.9 / p99 378 / max 1,748** | | | | | | assets 18,190: 4.5 / 17.6 / 115 | | |

## Per site, no think time (150 s, 2,194 rollouts, 143,907 requests, 949 req/s, 0 errors, 0 HTTP 5xx)

Far heavier than real rollouts (each rollout fires its next request as soon as the last one returns; load average
17 on 8 cores, the 4 client processes included).

| site | rollouts | writes | doc | search | post | assets | reset server | reset client |
|---|---|---|---|---|---|---|---|---|
| shopping | 237 | 333 | 50 / 151 / 552 | 88 / 835 / 2319 | 43 / 126 / 760 | 65 / 242 / 881 | 0.2 / 0.3 / 11 | 39 / 158 |
| shopping_admin | 266 | 53 | 48 / 184 / 911 | 69 / 518 / 974 | 55 / 176 / 996 | 71 / 302 / 1715 | 0.2 / 1.3 / 4.5 | 38 / 125 |
| forum | 444 | 438 | 43 / 138 / 226 | 64 / 170 / 240 | 31 / 97 / 150 | 46 / 153 / 247 | 0.4 / 0.9 / 15 | 23 / 95 |
| gitlab | 524 | 218 | 32 / 119 / 271 | 32 / 183 / 1071 | 30 / 74 / 138 | 37 / 143 / 336 | 0.2 / 0.4 / 3.8 | 21 / 74 |
| wiki | 362 | 0 | 31 / 108 / 218 | 71 / 273 / 370 | - | 41 / 122 / 229 | 0.2 / 0.2 / 1.2 | 19 / 81 |
| map | 361 | 0 | 16 / 83 / 457 | 104 / 1539 / 4046 | - | 98 / 514 / 739 | 0.2 / 0.2 / 1.7 | 14 / 67 |
| **all pages** | 2,194 | 1,042 | 34,168 pages: **p50 38 / p95 176 / p99 663 / max 17,227** | | | assets 109,739: 51 / 201 / 511 | server p95 0.7 | client p95 94 |

The tail is the map: bike/foot routes up to the 250 km cap (A* on the one routing thread) and geocoder searches for
generic words ("coordinates street") queue for seconds when the box is saturated. A second map worker process
(`map=2`) did not fix it (search p95 1.0 s, max still 24 s: the CPU is the limit) and costs +4 GB (PSS 18.8 GB),
so the map stays at 1. Agent-paced load (the think-time run) does not show it (map search p95 215 ms).

## RAM

Sum over each site's process group (master + workers), from `/proc/<pid>/smaps_rollup`. RSS double-counts the
file pages that several processes map: the wiki maps base.db (`mmapMB: 4096`) in each of its 5 processes, so its
RSS is 17-27 GB but its PSS 2-3 GB. **PSS is the real footprint** (anonymous PSS = heaps, SQLite page caches,
rollout dirty pages, the map's routing graph).

| site (processes) | idle after start: RSS / PSS | think run peak: RSS / PSS / anon | after no-think stress: RSS / PSS / anon |
|---|---|---|---|
| store (5) | 2,015 / 1,783 MB | 2,702 / 2,458 / 2,448 | 3,541 / 3,297 / 3,287 |
| forum (5) | 315 / 101 | 1,112 / 870 / 860 | 1,394 / 1,152 / 1,142 |
| code (5) | 404 / 190 | 1,279 / 1,042 / 1,034 | 2,963 / 2,728 / 2,718 |
| wiki (5) | 7,039 / 1,854 | 17,464 / 2,063 / 374 | 26,732 / 3,200 / 1,466 |
| map (1) | 3,151 / 3,105 | 3,419 / 3,372 / 3,369 | 4,154 / 4,106 / 4,102 |
| **total** | 12.9 / **7.0 GB** | 25.4 / **9.6** / 7.9 GB | 37.9 / **14.1** / 12.4 GB |

RSS keeps its high-water mark after resets (malloc keeps freed pages; kit/BENCH.md), so the stress column is an
upper bound for a long-running stack. Budget: < 20 GB with 6 GB to spare in the worst case.

## Startup

`sites.sh up` returns when every tenant of every site answers `/__rl/health` (it now checks all tenants, not only
tenant 0: with workers each process serves its own share). 10.7 s with base.db pages in the page cache, 19.9 s
cold. Per site (warm): store 7.3-7.5 s (per-tenant product index attach, 4 tenants per worker), wiki 3.6-4.2 s,
code 0.9-1.2 s, forum 0.7-1.2 s, map 0.7-1.1 s.

## Fixed along the way

- **kit: product images took ~300 ms each** (forum thumbnails ~100 ms; 52 s under load in the first run as the
  queue built up): `@fastify/static` >= 10.1's wildcard route re-reads every directory of the path per request to
  validate its spelling, and the store's product images sit in one directory of 194k files. `/media/*` is now served
  with `reply.sendFile` (same `..` guards; kit test). Image p95 300 ms -> 13 ms.
- **store admin: re-saving Default Category took ~50 s** and stalled its worker (the first run's 52 s outliers):
  `UPDATE categories SET name = ...` fires the `categories_names_au` trigger even when the name is unchanged, which
  rewrites `category_names` (and the products FTS) of all 105k products in it. The save now sets `name` only when it
  changed (51 ms; admin test).
- **sites.sh with `--bind rl --workers W > 1`**: the 127.0.0.1 control listener lives in worker 0 only, so
  `sites.sh reset/urls` (and grade.js `--sites`) reached only tenants `i % W == 0` ("tenant 1 is not served by this
  process"). The control URL is now the tenant's own `127.10.<i>.<k>` address.
- code (the MR fixes of docs/NOTES-code.md) was already in.

## Known slow spots (not fixed: rare, and inside the target at agent pace)

- Store catalog search for very common words (`q=product`, `q=item check`): 0.6-1 s at agent pace, 2.3 s under
  stress -- bm25 over tens of thousands of matching products (kit/BENCH.md "FTS ranking of large match sets").
- Map: bike/foot routes of 100-250 km (0.7-2 s idle) and generic-word geocoder searches; see above.
- Code: search inside gcc-mirror/gcc (199k commits) ~1 s; commit history with an author + message filter that
  matches nothing scans the whole path history (0.5 s idle on twbs/bootstrap); blob pages in gcc ~0.3 s.
- Admin: a few report / grid pages 0.6-1.8 s on first view (cold page cache).
