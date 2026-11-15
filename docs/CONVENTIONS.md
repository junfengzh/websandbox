# Build conventions

Rules for everyone (human or agent) building websandbox. Read with
[PLAN.md](PLAN.md).

## Repo

- `websandbox`, branch `main`, remote `git@github.com:junfengzh/websandbox.git` (public).
- Several builders work in this repo at the same time. Stage **explicit paths
  you own** (never `git add -A` / `git add .`), then `git pull --rebase` and
  `git push`. Small, frequent commits.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never commit data (DBs, images, dumps) -- `.gitignore` covers the usual
  suffixes. Never commit secrets, cookies or API keys; never print them.
- Ownership: `kit/` (kit builder), `sites/<site>/` (that site's builder),
  `tasks/<site>/` (that site's builder), `tasks/common/` and `docs/` (lead;
  others may append notes to `docs/NOTES-<site>.md`).

## Machine and paths

- Build box: 8 cores, 70 GB RAM. Node 20 (code must run on Node >= 20).
  `sudo` and `docker` are available. Java 17 is available (planetiler).
- Raw sources (read-only, NFS):
  - `$WSB_SRC/*.sqfs` -- WebArena site rootfs images
    (`shopping`, `shopping_admin`, `forum`, `gitlab`) with `*.config.json`
    (entrypoint/env of the original container).
  - `$WEBARENA_SRC/` -- the original WebArena docker tars and
    `wikipedia_en_all_maxi_2022-05.zim` (95 GB).
  - `$WSB_SRC/us-northeast-latest.osm.pbf` (Geofabrik).
- Docker cannot bind-mount NFS. Mount a squashfs with
  `sudo mount -o loop,ro <file> $WSB_MNT/<site>`, and
  copy any database data directory you need to start a DB from to
  `$WSB_WORK/<site>/` (local disk) first.
- Work dir: `$WSB_WORK/<site>/` (intermediates, dumps).
- Outputs: `$WSB_DATA_ROOT/<site>/base.db` and
  `$WSB_DATA_ROOT/<site>/media/`. The lead publishes data
  to the HF dataset `junfengzhou/websandbox`; builders do not upload.
- Disk: the scratch disk has ~110 GB free shared by everyone. Delete intermediates
  you no longer need; never leave a raw DB copy >20 GB lying around once
  exported. Check `df -h $WSB_SCRATCH` before big copies.
- Temp files: `$WSB_TMP/` or the session's job tmp dir, never `/tmp`
  shared names and never hidden folders in the repo.
- Python that reads extracted (untrusted) data runs with `python3 -I`.
- Kill anything you start (DB containers, servers) when done. Do not use
  `pkill -f <pattern>` where the pattern also appears in your own command
  line; kill by PID or `docker rm -f <name>`.

## Ports (avoid collisions between builders)

| Who | Ports | Docker container names |
|---|---|---|
| kit | 7100-7199 | `wsb-kit-*` |
| forum | 7200-7299 | `wsb-forum-*` |
| store | 7300-7399 | `wsb-store-*` |
| code hosting | 7400-7499 | `wsb-code-*` |
| wiki | 7500-7599 | `wsb-wiki-*` |
| map | 7600-7699 | `wsb-map-*` |

If you run the original WebArena sites, use them for reference (read-only browsing;
do not log in and change state there): shopping `http://<webarena-host>:7770`,
admin `http://<webarena-host>:7780/admin`, gitlab `http://<webarena-host>:8024`,
forum `http://<webarena-host>:9999`, wiki `http://<webarena-host>:8888`. Some may be
down; they are not required.

## WebArena tasks

- Source: `$WEBARENA_TASKS`
  (812 tasks; do not modify `3rd-party/`).
- Converted tasks: `tasks/<site>/webarena.jsonl`, one JSON object per line:
  `task_id` (original WebArena id), `site`, `intent`, `intent_template`,
  `intent_template_id`, `start_url` (lite URL, host placeholders below),
  `require_login`, `login_user`, `eval` (see below), `changes` (what was
  changed from the original and why), `status` (`verified` | `dropped`),
  `drop_reason`.
- Host placeholders in URLs: `__SHOPPING__`, `__SHOPPING_ADMIN__`,
  `__REDDIT__`, `__GITLAB__`, `__WIKIPEDIA__`, `__MAP__`.
- `eval`: `{ "type": "answer" | "url" | "state" | combination list,
  "answer": {"exact"|"must_include"|"fuzzy": ...},
  "answer_sql": "...", "url": "...", "state_sql": "...", "state_expect": ... }`.
  `answer_sql` / `state_sql` run read-only on the tenant DB through the
  control API. The kit's grader runs these.
- Verification log: `tasks/<site>/verify.jsonl`, one line per task:
  `task_id`, `when`, `how` (browser steps summary), `final_url`, `observed`
  (value read from the page / state query result), `ok`, `notes`.
  "Manual run" = really doing the task through the site's UI in a browser
  (chrome-devtools MCP tools if available, else Playwright/puppeteer scripted
  per task), not just running the SQL.

## Licences and attribution

Keep `sites/<site>/SOURCES.md`: where the data came from, its licence and
the attribution text. The lead turns these into the dataset card.
