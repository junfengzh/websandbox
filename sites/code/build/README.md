# Code hosting build pipeline

Turns the WebArena GitLab image into `$WSB_DATA_ROOT/code/base.db`
(schema: [../SCHEMA.md](../SCHEMA.md); sources: [../SOURCES.md](../SOURCES.md)).

```
sites/code/build/build.sh            # everything, then cleanup
sites/code/build/build.sh mount pgcopy pgstart export      # or individual steps
```

| step | what | time* |
|---|---|---|
| `mount` | `sudo mount -o loop,ro gitlab.sqfs` at `$WSB_MNT/code` | s |
| `pgcopy` | copy the PostgreSQL 13 datadir (12 GB) to `$SCR/work/code/pgdata`, trust-only `pg_hba.conf` | 8 min |
| `pgstart` | `postgres:13.8` container `wsb-code-pg` on 127.0.0.1:7432 (datadir uid 996) | s |
| `export` | `export_pg.py`: PostgreSQL -> `rel.db` (relational tables, MR diffs/commits) | 9-12 min |
| `repocopy` | copy the bare repos (13 GB; root-only on the image) to `$SCR/work/code/repos`, chown | 5 min |
| `git` | `import_git.py`: each repo -> `shards/p<id>.db` (refs, commits + numstat, branch histories, contributors, trees/blobs by policy, wiki); `JOBS` parallel | see NOTES |
| | `import_git.py --reuse` keeps existing shards' `git log` output (the slow part) and recomputes branches, contributors and objects -- use it after changing the object/branch policies | 5 min |
| `templates` | `templates.py`: GitLab's built-in project templates (bundles) -> `shards/t_<name>.db` | 1 min |
| `assemble` | `assemble.py`: rel.db + shards -> base.db (dedupe by sha), site_settings, FTS5 + triggers, ANALYZE, VACUUM, integrity_check | |
| `media` | the 2 uploaded avatars -> `data/code/media/avatars/` | s |
| `verify` | `verify.py`: counts vs source, git ref/commit counts vs `git`, orphans, 40+ WebArena task facts (base.db vs source vs reference answer) | |
| `licenses` | `licenses.py`: `../SOURCES.repos.md` (upstream + licence per project) | s |
| `cleanup` | remove the container, pgdata, repo copy, shards, rel.db; unmount | |

\* on the shared 8-core build box under load; see `docs/NOTES-code.md` for the measured run.

Needs: sudo, docker, git >= 2.31 (`--diff-merges`), python3 (stdlib sqlite3 with FTS5) and a
venv with `psycopg[binary]` (created by the script under `$SCR/work/code/venv`). Disk: ~25 GB
of intermediates (pgdata + repos) plus ~2 GB shards, freed by `cleanup`.

Policy knobs (top of each script): `FULL_MAX`, `RECENT_COMMITS`, `RECENT_EXTRA`, `BLOB_MAX`,
`BINARY_MAX`, `NUMSTAT_MAX_COMMITS`, `COMMIT_FILES_MAX`, `BRANCH_MAX`, `BRANCH_ROWS_MAX`
(import_git.py) and `MR_DIFF_FILE_MAX`, `MR_DIFF_TOTAL_MAX`, `MR_FILES_MAX`,
`MR_COMMITS_MAX` (export_pg.py). Secrets: only whitelisted tables/columns are read; token
tables are never queried and nothing secret is printed.
