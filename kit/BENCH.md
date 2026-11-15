# Kit benchmark

Note: the 32-tenant and big-DB sections below were measured in copy mode (the default
at the time); overlay mode (now the default) is measured in its own section.

`node bench/bench.js multi|big --dir WORK ...` on the notes toy site (`bench/load.js` is the
client). Run 2026-11-14 on the shared build box (8 cores, 70 GB, ext4 md RAID).

**Caveat: the box was saturated by other jobs during every run** (load average 20-29 on 8
cores, 0% idle, our processes at nice 5). A bare Fastify "hello" route cost 0.6 ms CPU and
1-2 ms wall per request here, roughly 10x a quiet machine. Read the absolute latencies as
pessimistic; the CPU-per-request numbers and the ratios are the useful part.

## Reset

| | |
|---|---|
| reset (server side: `ROLLBACK; BEGIN` + empty uploads + clock), dirty tenant after a load run | **0.6-8 ms max**, typically < 1 ms |
| reset over HTTP from a client (incl. loopback round trip on the busy box) | 10-120 ms max, typically ~10 ms |
| reset after 2,000 / 20,000 note creations on the 1.3 GB DB | 7.5 / 23 ms |
| reset after rewriting the whole 1.3 GB DB in one rollout (750 MB WAL) | 58 ms |

Target < 50 ms: met with a wide margin on the server side; the HTTP round trip dominates.

## 32 tenants, 200k-note DB (205 MB), 32 clients, one client per tenant

Mix per client: 15% list, 15% sorted + paged list, 20% search, 10% search + filter + sort,
25% note view, 10% create (POST, CSRF), 5% edit; a reset + re-login every 200 requests.

CPU per request (in-process `inject`, single client, same busy box):

| request | CPU ms |
|---|---|
| bare Fastify JSON route (reference) | 0.59 |
| kit `/__rl/health` | 0.59 |
| note page (session, 1 query, layout render) | 1.2 |
| list page 1 (capped count + 20 rows) | 3.3 |
| list sorted by likes, page 40 | 4.1 |
| search, common word (~7k matches: bm25 rank + capped count + snippets) | 28-32 |

Kit overhead per request is in the noise; pages cost what their SQL costs. **FTS ranking of
large match sets is the expensive operation** (bm25 is computed for every matching row):
sites should keep searches selective (prefix only on the last term, filters before rank)
and expect ~4 µs per matching row on this box.

Closed loop, no think time (each client fires its next request as soon as the last returns --
far heavier than real rollouts):

| workers | rps | p50 ms | p95 ms | p99 ms | RSS total (loaded) | RSS per tenant |
|---|---|---|---|---|---|---|
| 1 | 16-34 | 830-1830 | 1650-3190 | 2480-4800 | 1.1 GB | 31-34 MB |
| 4 | 62 | 315 | 1506 | 2220 | 1.4 GB | 42 MB |
| 8 | 126 | 108 | 1002 | 1576 | 1.8 GB | 54 MB |

With 2 s think time per client (closer to an agent; still ~3x a real LLM-paced rollout):

| workers | rps | CPU ms/req | p50 ms | p95 ms | p99 ms |
|---|---|---|---|---|---|
| 1 | 11 | 20.1 | 763 | 2530 | 3897 |
| 4 | 14 | 20.9 | **30** (view 4.8, list 7) | 1018 | 1289 |

Reading: one event loop serves the whole mix at ~20 ms CPU/request average (dominated by
the 30% searches), i.e. ~50 rps per core on this box; requests queue behind each other's
searches on a single loop. **Use `--workers 4` (or more) for 16-32 tenants**: each worker
owns `i % W` and binds its own `127.10.<i>.<k>` addresses, so there is no proxy hop and a
slow search only delays the tenants of its own worker. The p95 target (< 300 ms) needs a
machine that is not saturated: on this box the p95 is set by CPU starvation, not by the kit.

RAM: ~70 MB for an idle 32-tenant process; each tenant grows to its SQLite page cache
(`--cache-mb`, default 32) plus its share of V8 heap -- **30-55 MB per tenant** loaded, plus
~60 MB per extra worker process. 16 tenants x 6 sites x ~45 MB ≈ 4.3 GB, inside the 20 GB budget.

Startup: copying base.db to 32 tenant files (205 MB each, 4 at a time) took 32-41 s cold
on the busy box; a restart reuses the copies (0.1-5 s for 32 tenants).

## Big DB (1.3 M notes), long transactions

1.3 M notes, base.db 1330 MB (incl. FTS5 index), 4 tenants. Build: 30 min on the busy box.

| | |
|---|---|
| cold start: copy base.db to 4 tenant files (4 concurrent) | 31 s (~170 MB/s on the loaded RAID); restarts reuse the copies |
| note page / list page 1 / sorted list page 40 (CPU, in-process) | 1.1 / 3.3 / 4.8 ms -- same as on the 205 MB DB (indexed) |
| search for a common word (45k matches) | **205-255 ms CPU**: bm25 over every match (~7 µs/match). `count` capped at 10k: 9-25 ms; top-20 by rowid instead of bm25: 2-28 ms |
| rollout of 2,000 note creations via HTTP (FTS updated), then reset | WAL 0 MB (all in page cache), **reset 7.5 ms** |
| rollout of 20,000 note creations, then reset | WAL still ~0 at the end of the run, **reset 23 ms**; FTS query over the new rows 45 ms |
| raw SQLite: 20,000 inserts (+FTS triggers) each in its own savepoint, one open transaction | 0.15-0.9 ms per insert, no degradation trend; ROLLBACK 19 ms |
| pathological: one `UPDATE notes SET likes = likes + 1` (dirties the whole 1.3 GB DB) | 77 s; WAL grew to 750 MB; **reset 58 ms**; state verified restored |

Findings:
- Reset cost is proportional to nothing much: ROLLBACK discards dirty cache pages and resets
  the WAL index; it stays in milliseconds even after the whole DB was rewritten.
- The WAL only grows when a rollout's dirty pages exceed the page cache (`--cache-mb`); its
  file keeps its high-water size (it is reused, never checkpointed). Realistic rollouts
  (tens to thousands of writes) never touch it.
- Long transactions do not slow down writes or reads (the HTTP run first looked slow --
  that was unread flash messages accumulating in the session, now capped at 10).
- **Full-text ranking of very common terms on million-row tables is the one slow thing**
  (hundreds of ms). Sites with big FTS tables should: rank a short field (titles/names)
  rather than long bodies, keep `prefix: 'last'`, add `prefix='2 3'` indexes if prefix
  queries are common, and fall back to a column sort when `countCapped` hits the cap.

## Overlay mode (default since 2026-11-14): all tenants on one base.db

`node --expose-gc bench/bench.js overlay --dir WORK --notes 200000 --tenants 8 --cache-mb 32`:
8 tenants in one process on the same 205 MB base.db, each running one big UPDATE
(different per tenant) inside its rollout transaction, then a reset.

| rows updated per tenant | RSS growth per tenant | reset (max of 8) |
|---|---|---|
| 2,000 (1% of the table) | 3.4 MB | 14 ms |
| 20,000 (10%) | 22 MB | 33 ms |
| 100,000 (50%, ~50 MB of pages) | 100 MB | 343 ms |

- Isolation: 8 different results (each tenant sees only its own writes); FTS5 inserts
  visible to their own tenant only (tests).
- **Nothing reaches the file**: the process's disk `write_bytes` (from `/proc/self/io`) stayed
  **0** for the whole run, base.db's sha256 and mtime unchanged, no `-journal`/`-wal` files
  created. Also verified in `test/overlay.test.js` with 4 tenants in 2 worker processes
  writing in parallel with a 2 MB page cache (write set larger than the cache).
- Memory: a dirty page costs ~2x its size (cache page + the in-memory rollback journal copy).
  `cache_spill=OFF` lets the cache grow past `cache_size` instead of spilling, so the cost
  is bounded by the rollout's write set, not by the cache setting. RSS keeps its high-water
  mark after a reset (malloc keeps the pages for reuse) -- ~1 GB after the 8 x 100k-row test.
- Reset cost is O(dirty pages) here (ROLLBACK replays the in-memory journal), unlike copy
  mode's O(1) WAL rollback: milliseconds for realistic rollouts, ~0.35 s for a 50 MB write set.
- An explicit COMMIT on such a connection *does* write base.db (verified in a probe), which
  is why the commit guard exists. If a rollout exhausts memory, SQLite should fail with
  SQLITE_NOMEM and roll back; the guard then refuses writes outside the transaction (not
  exercised in tests). Use `--db-mode copy` for sites whose rollouts write hundreds of MB.

- 32 tenants, 2 s think time, overlay (re-run 22:52, box load 30-42 -- *more* loaded than
  before, so the p95 target still could not be checked fairly): start **3.6 s** for 32
  tenants (copy mode: 32-41 s cold) with **zero extra disk**; 1 worker: p50 655 / p95 2026 ms;
  4 workers: p50 32 ms (view 4.3, list 5.6, create 5.1) / p95 803 / p99 1296 ms; CPU
  20 ms/request (unchanged; search-dominated); RSS 33-41 MB per tenant; reset after the run
  <= 1.4 ms server-side.

## Reproduce

```
node bench/bench.js multi --dir $WSB_WORK/kit/multi --notes 200000 --tenants 32 --workers 1,4,8 --seconds 30 [--think-ms 2000]
node --expose-gc bench/bench.js overlay --dir $WSB_WORK/kit/ov --notes 200000 --tenants 8
node bench/bench.js big   --dir $WSB_WORK/kit/big   --notes 1300000 --tenants 4 --seconds 30
```
