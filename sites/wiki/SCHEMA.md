# Wiki lite: `base.db` schema

`$WSB_DATA_ROOT/wiki/base.db` (SQLite, read-only at
runtime) + `media/` (thumbnails as files). Built by [`build/`](build/README.md)
from the WebArena Kiwix ZIM `wikipedia_en_all_maxi_2022-05` (English
Wikipedia, 2022-05-01). Sources and licences: [SOURCES.md](SOURCES.md).

## Tables

### `article`
| column | type | |
|---|---|---|
| `id` | integer PK | 1..N. Task articles first (selection rank), then by in-link count. Stable for a given build. |
| `path` | text unique | URL segment: the page is `/wiki/<path>`; underscores for spaces, as on Wikipedia (`Washington_&_Jefferson_College`, `Mister_Rogers'_Neighborhood`). |
| `title` | text | display title (`Christopher Nolan`). |
| `html` | blob | cleaned article body HTML, **zstd with the dictionary in `zdict` (id 1)**. Starts with `<div class="mw-parser-output">`. |
| `html_len` | int | decompressed size in bytes. |
| `text` | blob | plain text, zstd *without* dictionary -- NULL in the default build (`KEEP_TEXT=1` in s6 stores it: +~0.84 GB). |
| `text_len` | int | plain-text size in bytes (what FTS indexed). |
| `lead` | text | first paragraph as plain text (<= 600 chars): search-result snippets, link previews. |
| `sections` | text | JSON `[[level, anchor, heading], ...]` (levels 2-6) for the table of contents. Anchors are the `id`s of the `<h2>`..`<h6>` in `html`. |
| `infobox` | int | 1 if the article has an infobox. |
| `image` | text | first non-icon image (`/media/..`), or NULL: page image for search results. |
| `inlinks` | int | number of articles in the *whole* ZIM linking here (popularity; ranks search/suggestions). |
| `edited` | text | last-edit date on Wikipedia (`YYYY-MM-DD`), from the Kiwix footer. |
| `oldid` | int | source revision id: `https://en.wikipedia.org/w/index.php?oldid=<oldid>`. |
| `reason` | text | why selected: `task:<webarena ids>`, `always`, `hop1:<task article path>`, `inlinks`. |

Article HTML conventions:
- internal links: `<a href="/wiki/<path>[#anchor]" title="...">`, only to articles in this DB (always the canonical path, never a redirect);
- links to articles not in the DB: `<span class="new" title="X (page does not exist)">text</span>` (style as red links, no href);
- external links: `<a rel="nofollow" class="external ..." href="https://...">`;
- images: `<img src="/media/ab/0123456789abcdef.webp" width height loading="lazy">` (width capped at 320, aspect kept). Images not kept were removed from the HTML;
- references: inline `<span class="mw-ref reference"><a href="#cite_note-N">[N]</a></span>`, list in `<ol class="references">` with `id="cite_note-N"`;
- Wikipedia's CSS class names are kept (`infobox`, `wikitable`, `thumb tright`, `hatnote`, `reflist`, `mw-collapsible`...) so a MediaWiki-like stylesheet applies; inline `style` attributes are kept.
- No `<style>`, `<script>`, navboxes, edit links, Parsoid `data-*` attributes.

### `zdict`
`id` integer PK, `dict` blob: the zstd dictionary for `article.html`.
Node (>= 20): `zstd-napi` -- `const d = new Decompressor(); d.loadDictionary(dict); d.decompress(row.html)`.
Python: `zstandard.ZstdDecompressor(dict_data=zstandard.ZstdCompressionDict(dict)).decompress(blob)`.

### `redirect` (without rowid)
`path` text PK (`Mr._Rogers`), `title` text, `target` int -> `article.id`.
Every ZIM redirect whose (chain-resolved) target is in the DB. Lookup order
for `/wiki/<p>`: `article.path = p`, else `redirect.path = p` -> HTTP redirect
to the target's path (Wikipedia shows "(Redirected from ...)").
Index `redirect_target(target)` lists the redirects to an article.

### `link` (without rowid)
`(dst, src)` PK: article `src` links to article `dst` (both in the DB, distinct
pairs, no self links). "What links here" = `select src from link where dst=?`.
Outgoing links are in the HTML.

### `media` (without rowid)
`url` text PK (`/media/ab/0123456789abcdef.webp`), `w`, `h` (pixels; 0 for
SVG), `bytes`. The file is `<data dir>/<url>`. WebP <= 320 px wide, or SVG.

### `article_fts` (FTS5, contentless)
`fts5(title, body, content='', tokenize='porter unicode61 remove_diacritics 2')`,
`rowid` = `article.id`, `body` = plain text without reference lists.
Contentless, so `snippet()`/`highlight()` are unavailable: use `article.lead`
for snippets (or decompress `article.html` and cut around the match).
`detail=full`, so phrase (`"suspension bridge"`), prefix (`mack*`) and NEAR
queries work. Recommended ranking (tuned on the task queries, see
`build/verify.js`): bm25 with title weight 50, plus a small popularity prior;
and an exact title/redirect match goes first (or straight to the page, like
Wikipedia's "Go"):

```sql
select a.id, a.path, a.title, a.lead,
       bm25(article_fts, 50.0, 1.0) - 0.3 * ln(1 + a.inlinks) as score
from article_fts f join article a on a.id = f.rowid
where article_fts match ? order by score limit 20;
```

Pure bm25 (no prior) ranks short sub-articles first ("List of accolades
received by Inception" for *christopher nolan*); a larger prior (>= 0.6)
lets huge articles win (*stephen king* -> Hungary). Queries of very common
words take up to ~350 ms (the whole match set is scored); strip stop words
("where was the") before matching.

### `suggest`, `suggest_top` (title suggestions / autocomplete)
`suggest(norm, title, target, score, is_redirect)`, index `(norm, score desc)`.
`norm` = lowercased, diacritics removed, `_` -> space, whitespace collapsed.
Article titles (score = 2 * inlinks + 1) and redirect titles (score = inlinks
of the target). `suggest_top(prefix, items)`: for normalized prefixes of 1-3
characters, the top 10 as JSON `[[title, article_id], ...]` (precomputed
because those ranges are large). Longer prefixes:

```sql
select title, target from suggest where norm >= :p and norm < :p || char(1114111)
order by score desc limit 10;
```

### `meta`
key/value: `source`, `licence`, `built`, counts, `fts_detail`, `zstd`,
`categories` (none -- see below), `main_page`.

## Not in the data

- **Categories:** the ZIM (mwoffliner) strips category links, so there are no
  categories or category pages.
- **Talk pages, history, users:** not in the ZIM. Talk pages (write tasks) would be a runtime table added by the site.
- **Main page:** the Kiwix landing page `User:The_other_Kiwix_guy/Landing` is included (`reason='always'`), as is `Main_Page`.
