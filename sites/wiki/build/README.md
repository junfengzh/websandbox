# Wiki build pipeline

Turns the WebArena Kiwix ZIM (`wikipedia_en_all_maxi_2022-05.zim`, 95 GB, read
in place on NFS) into `data/wiki/base.db` + `data/wiki/media/` (3-4 GB in
total). Schema: [../SCHEMA.md](../SCHEMA.md). Design notes, selection and
measurements: [docs/NOTES-wiki.md](../../../docs/NOTES-wiki.md).

## Setup

```bash
W=$WSB_WORK/wiki
python3 -m venv $W/venv
$W/venv/bin/pip install zstandard pillow lxml numpy     # (libzim optional: inspection only)
cd sites/wiki/build && npm install                      # better-sqlite3 + zstd-napi, for verify.js
```

Paths (override with env): `WIKI_ZIM` (the ZIM), `WIKI_WORK`
(`$WSB_WORK/wiki`), `WIKI_OUT`
(`$WSB_DATA_ROOT/wiki`), `WEBARENA_TASKS`.

## Steps

Run from this directory with `PY="$W/venv/bin/python -I"`. Every step is
resumable or cheap to re-run; outputs of each step are inputs of the next.

| step | command | output (in WORK unless noted) | time (8 cores, NFS, shared box) |
|---|---|---|---|
| 1 | `$PY s1_dirents.py` | `dirents.db`: every ZIM directory entry (articles, redirects, images) | 4 min |
| 2 | `$PY s2_linkscan.py` | `s2/stats.npz`: in-links, size, infobox, image count per article (streams all 28 GB of HTML clusters once; chunked, resumable) | 68 min |
| 3 | `$PY s3_select.py` | `selection.tsv`: task articles + one hop, then by in-links until the budget (`WIKI_ARTICLE_BUDGET_MB`) | ~5 min |
| 4 | `$PY s4_articles.py` | `build.db`: cleaned zstd HTML, text, links, media list per article (resumable per 400-article job) | 9 h on the loaded box (CPU-bound; ~2-3 h idle) |
| 5 | `$PY s5_media.py` | `OUT/media/`: thumbnails within `WIKI_MEDIA_BUDGET_MB` (default 900; built with 850), prunes files over budget (resumable per file) | 6 min |
| 6 | `$PY s6_assemble.py` | `OUT/base.db`: final DB with FTS5, redirects, links, suggestions; strips `<img>` of thumbnails not kept | 14 min |
| 7 | `node verify.js [OUT]` | checks: task articles + facts, links, images, redirects, FTS, suggestions, size | seconds |

Files:
- `zimraw.py` -- minimal ZIM reader (directory, clusters, direct blob reads). libzim's Python random access costs ~1 s per article over NFS; streaming clusters is bandwidth-bound instead.
- `zimget.py` -- random access by path through `dirents.db` (inspection: `$PY zimget.py Christopher_Nolan out.html`).
- `clean.py` -- Kiwix page -> article HTML + plain text + lead + sections + links + images.
- `task_articles.json` -- the articles the WebArena Wikipedia tasks need, why, and the facts `verify.js` checks.
- `common.py` -- paths.

Afterwards delete `WORK/build.db` (2.8 GB), `WORK/s2/chunk_*.npz` and
`WORK/dirents.db` (2.3 GB); keep `s2/stats.npz` and `selection.tsv`.
