# Store build pipeline

Turns the two WebArena Magento 2 stores into one lite store:
`$WSB_DATA_ROOT/store/base.db` (SQLite, schema in
[../SCHEMA.md](../SCHEMA.md)) and `$WSB_DATA_ROOT/store/media/`
(WebP images).

## Rebuild

```bash
sites/store/build/build.sh            # everything, ~1 h (images dominate)
sites/store/build/build.sh transform images finalize verify   # from existing raw exports
```

Needs: `sudo` (loop mounts), `docker`, `python3` (a venv with PyMySQL, Pillow and
argon2-cffi is created in `work/store/venv`), `3rd-party/webarena` (its
`browser_env/env_config.py` supplies the public demo passwords; override with `ACCOUNTS=`), `sqlite3`, ~45 GB free on
the scratch disk while the shop MariaDB data dir copy (3.7 GB) and raw export
(1.9 GB) exist; inputs are read from the squashfs mounts (NFS).

| Step | What | Output |
|---|---|---|
| `mount-admin`, `mount-shop` | `sudo mount -o loop,ro` of `shopping_admin.sqfs` / `shopping.sqfs` at `$WSB_MNT/store_{admin,shop}` | |
| `export-admin`, `export-shop` | copy `/var/lib/mysql` to `work/store/<n>_mysql`, run `mariadb:10.6.12` (the version in both images) as `wsb-store-<n>-db` on 127.0.0.1:7301/7302 with `--skip-grant-tables`, dump every needed table 1:1 with `export_raw.py`, remove the container | `work/store/raw_{admin,shop}.db` (5 MB / 1.9 GB) |
| `transform` | `transform.py`: merge both stores into the lite schema (`schema.sql`), renumber, clean shop description HTML (`htmlclean.py`), build FTS5 (`search.sql`), convert password hashes to kit formats | `data/store/base.db` (1.15 GB) |
| `images` | `images.py`: originals from `pub/media/catalog/product` → WebP, long side 600 px, q80, 6 processes; also category and CMS (wysiwyg) images | `data/store/media/` (4.5 GB), `product_images.file/width/height/bytes` |
| `finalize` | rollback journal, `ANALYZE`, `VACUUM`, `integrity_check` (kit.build.finalize conventions) | |
| `verify` | `verify.py` + `spotchecks.py`: row counts vs raw exports, referential integrity, uniqueness, FTS row counts, image files, task facts | exit 1 on failure |
| `cleanup` | remove containers, unmount, delete the MariaDB data dir copies | |

All Python runs with `python -I` (the data is untrusted). Raw exports are kept
in `work/store/` (small enough; they make `transform` re-runnable without
MariaDB).

## Files

- `export_raw.py` — MariaDB → SQLite, exact values (DECIMAL as text), skips
  index/cache/log tables and secret config rows.
- `transform.py` — the merge; ID policy at the top and in SCHEMA.md.
- `schema.sql`, `search.sql` — DDL.
- `htmlclean.py` — description shrinking + product-details extraction.
- `images.py`, `verify.py`, `spotchecks.py`, `build.sh`.
