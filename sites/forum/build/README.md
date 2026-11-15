# Forum build pipeline

Turns the WebArena Postmill forum (`forum.sqfs`, 43 GB rootfs) into
`$WSB_DATA_ROOT/forum/base.db` (SQLite, schema in
[../SCHEMA.md](../SCHEMA.md)) and `.../data/forum/media/` (WebP images).

```
sites/forum/build/build.sh                 # all steps
sites/forum/build/build.sh transform verify  # re-run some steps
```

| Step | What | Time (loaded 8-core box) |
|---|---|---|
| `mount` | `sudo mount -o loop,ro forum.sqfs $WSB_MNT/forum` | s |
| `pg` | copy `/usr/local/pgsql/data` (4.8 GB, PG 14) to `work/forum/pgdata`, start `postgres:14-alpine` as `wsb-forum-pg` (no published port; psql via `docker exec`). First start does a short crash recovery (WAL replay) -- the step waits for it | ~2 min |
| `export` | `export.py`: every table to `work/forum/export/<table>.jsonl.gz` via `row_to_json` (exact NULL/''/types; timestamps to UTC text; IPs and tsvectors dropped) + `counts.json` | ~3 min, 350 MB |
| `images` | `images.py`: `public/submission_images/*` (read from the mount, never copied) -> `media/submission_images/<sha256>.webp` (<= 800 px long side, q80) and `.../thumb/<sha256>.webp` (<= 160 px); manifest `work/forum/images_manifest.jsonl`. Incremental | ~1 h |
| `transform` | `transform.py`: export + manifest -> `base.db` (schema.sql, bulk load, then search.sql: FTS5 + triggers, then site.sql; FK check, ANALYZE, VACUUM, integrity_check). Needs node + `kit/node_modules` (bcrypt check of the source hashes) | ~20 min |
| `site` | apply `site.sql` in place (lite-site indexes, `user_stats` + triggers, seeded forum categories; `transform` already runs it) + ANALYZE, so an existing base.db can be patched without a rebuild | ~1 min |
| `verify` | `verify.py`: row counts vs source, FKs, FTS doc counts, media files, every `__REDDIT__` URL in the WebArena reddit tasks, 22 task facts compared against the live source DB, kit login check -> `work/forum/verify.json` | ~2 min |
| `cleanup` | remove the PG container + `pgdata` copy, unmount. Keeps `work/forum/export` so `transform` can run again without Postgres | s |

Python scripts run with `python3 -I` and need only the stdlib + Pillow (WebP).
The build is deterministic: source ids are kept, rows are loaded in id order,
the scrypt salt is derived from a fixed string.
