# Notes: wiki lite data build

Builder notes for `sites/wiki/` (data only; the server is separate work).
Pipeline: [sites/wiki/build/README.md](../sites/wiki/build/README.md);
schema: [sites/wiki/SCHEMA.md](../sites/wiki/SCHEMA.md); sources and
licences: [sites/wiki/SOURCES.md](../sites/wiki/SOURCES.md).

Output: `$WSB_DATA_ROOT/wiki/base.db` + `media/`.

## Result (build of 2026-11-15)

| | |
|---|---|
| articles | **115,040** (91,464 with an infobox) |
| redirects | 971,031 (every ZIM redirect whose target is selected) |
| links (what links here) | 8,838,020 article -> article pairs |
| title suggestions | 985,523 rows, 40,622 precomputed 1-3 char prefixes |
| thumbnails | 146,917 files, WebP <= 320 px (or SVG) |
| **total size** | **3.79 GB**: base.db 2.93 GB + media 0.86 GB (146,917 files; ~1.0 GB on disk with 4 KB blocks) |

Size breakdown (dbstat):

| part | MB |
|---|---|
| `article` (zstd HTML 1,522 MB + lead/sections/meta) | 1,736 |
| `article_fts` (contentless, detail=full) | 919 |
| `link` | 97 |
| `suggest` + index, `suggest_top` | 90 |
| `redirect` + index | 77 |
| `media`, `zdict`, other | 10 |
| thumbnails (files) | 862 |

## Source: the ZIM

`wikipedia_en_all_maxi_2022-05.zim`: 95.2 GB, ZIM v6.0, old namespace
scheme (`A/` articles, `I/` images, `-/` assets, `M/` metadata), mwoffliner
1.11.11, snapshot 2022-05-01. 23,264,812 entries: 6,492,232 articles,
10,027,208 redirects, 6,745,266 images; 139,570 clusters, of which 117,272
hold article HTML (27.8 GB compressed, zstd) and 22,295 hold images (46.6 GB,
uncompressed). Article HTML is the mobile (Minerva) Parsoid output with
`<details>` sections, inline TemplateStyles, navboxes and a Kiwix footer
carrying the revision id and last-edit date.

**No categories:** mwoffliner strips category links, so the DB has no
categories or category pages (PLAN §4.4 lists them; they would need another
source, e.g. a categorylinks dump of the same date). No talk pages either.

## Throughput (ZIM on NFS, shared 8-core box)

- python-libzim random access: opening the archive takes ~55 s; random article
  reads did not finish 300 reads in 5 min (> 1 s/article: each read
  decompresses a ~240 KB cluster fetched over NFS). Unusable for 100k+
  articles, so the build uses its own reader (`zimraw.py`) that streams
  clusters in file order and reads uncompressed image blobs directly.
- NFS: sequential ~22 MB/s with other builders active (dd, 4 MB blocks); 8 MB
  read in 0.76 s; random 4 KB reads 35-140 ms.
- zstd cluster decode: ~200 MB of HTML per 0.4 s (one core); not a bottleneck.
- Steps as run (box at load 15-30 from other builders the whole time):
  s1 dirents 4.5 min; s2 link scan of all 6.5 M articles 68 min (CPU-bound
  in Python regex + resolution, 6 processes); s3 selection 4 min; s4 clean +
  compress 115k articles 9.0 h (33 min of it training the zstd dictionary
  from 3,000 random articles = random cluster reads; the rest lxml cleaning,
  CPU-bound at ~20 % per worker on the loaded box -- expect ~2-3 h on an idle
  box); s5 thumbnails 6 min for 188k images (16 threads, cluster order);
  s6 assemble 14 min. Total ~11 h wall clock.
- Every step is resumable (s2 per 1000-cluster chunk, s4 per 400-article
  job, s5 per file, s6 rebuilds from build.db in minutes).

## Selection

1. **Task articles** (`build/task_articles.json`, 97 distinct articles +
   `Main_Page`, `Wikipedia` and the Kiwix landing page), then **one hop**:
   every article they link to (35,864), since a solver may open any link
   on a task page.
2. **By in-link count** over the full ZIM link graph (s2: distinct source
   articles per target, redirects resolved; score x1.25 for infoboxes;
   articles < 6 KB raw HTML skipped as stubs) until the article budget
   (2,350 MB estimated compressed HTML + FTS) was reached: 79,076 more, down
   to 677 in-links. The most-linked targets are identifier/authority pages
   (ISBN 1.34 M in-links, VIAF, DOI, United States 453k, ...); counts include
   navbox links (which inflate e.g. sports arenas), an acceptable proxy for
   "articles people reach".
3. **Thumbnails**: in page order, up to 12 per task article, 4 for the top 25k
   and hop articles, 2 for the rest, plus tiny icons/flags (<= 40 px); then a
   byte budget (850 MB) walked in article-id order; images that did not fit
   are removed from the HTML in s6 (45,917 articles lost at least one image).

## WebArena tasks that use Wikipedia (23)

All are cross-site: the Wikipedia part is a lookup, the answer is checked on
the map or GitLab. Articles included (all verified present and rendering
with the facts below by `verify.js`):

| tasks | what the solver looks up | articles (core) | fact in the 2022-05 text |
|---|---|---|---|
| 97 | top CS school in Massachusetts (-> MIT; then CMU->MIT drive) | MIT, CMU, List of colleges and universities in Massachusetts, MIT CSAIL, MIT Schwarzman College of Computing, Harvard, Computer science, College and university rankings, Massachusetts | MIT article (rankings) |
| 265-268 | closest national park to Boston / largest city in Maine / Stephen King's hometown / Vinalhaven (-> Acadia) | List of national parks of the United States, National park, NPS, Acadia NP, Boston, Maine, Portland ME, List of municipalities in Maine, Stephen King, Bangor ME, Durham ME, Vinalhaven ME, Mount Desert Island, Bar Harbor, Cuyahoga Valley NP, Shenandoah NP, New River Gorge NP, List of areas in the NPS | Portland "largest city"; King born in Portland, Maine |
| 424 | where Mister Rogers' Neighborhood was filmed (-> Pittsburgh) | Mister Rogers' Neighborhood, Fred Rogers, WQED (TV), Pittsburgh, Fred Rogers Productions | "WQED", "Pittsburgh" |
| 425 | longest bridge in the Western Hemisphere (-> Mackinac Bridge) | Mackinac Bridge, List of longest bridges, List of longest suspension bridge spans, Lake Pontchartrain Causeway, Western Hemisphere, Suspension bridge, Verrazzano-Narrows, Golden Gate | Mackinac: "Western Hemisphere" |
| 426 | PA crash site of Flight 93 (-> Somerset County) | United Airlines Flight 93, September 11 attacks, Shanksville, Somerset County PA, Flight 93 National Memorial, Stonycreek Township | "Shanksville", "Somerset County" |
| 427 | university with most Turing Award winners (expected MIT) | Turing Award, MIT, Stanford, UC Berkeley, CMU, Harvard, Princeton | see caveat below |
| 428 | undergrad college of Nash (-> CMU) | Nash equilibrium, John Forbes Nash Jr., CMU, Princeton, A Beautiful Mind (film) | "Carnegie" |
| 429-430 | where The Chair was filmed (-> Chatham University; Washington & Jefferson College) | The Chair (2021 TV series), The Chair (disambiguation), Chatham University, Washington & Jefferson College, Washington PA, Sandra Oh, Pittsburgh | both colleges named |
| 556-561 | Nolan's films, before/after 2010, career timeline headings, Oscar winners, BAFTA nominees | Christopher Nolan, filmography, List of awards and nominations received by Christopher Nolan, all 12 feature films (Following ... Tenet, Oppenheimer), Doodlebug, Batman in film, Emma Thomas, Jonathan Nolan, Syncopy, Academy Awards, BAFTA | all 4 section headings ("1993–2003: Early career and breakthrough", ...) and all 12 film titles |
| 737-741 | home stadiums (76ers -> Wells Fargo Center; in the 70s -> the Spectrum, 3601 South Broad Street; Yankees in the 80s -> Yankee Stadium (1923); Knicks -> MSG; Celtics -> TD Garden) | Philadelphia 76ers, Wells Fargo Center, Spectrum (arena), South Philadelphia Sports Complex, Philadelphia Convention Hall and Civic Center, New York Yankees, Yankee Stadium (1923), Yankee Stadium, Knicks, Nets, MSG, Celtics, TD Garden, Boston Garden, CMU, List of NBA arenas, NBA | "3601 South Broad Street", "161st Street", ... |

Caveats -- task answers not (fully) supported by the ZIM text:

- **427 (Turing Award / MIT):** the 2022-05 *Turing Award* article has no
  affiliation column, and *List of Turing Award laureates by university
  affiliation* does not exist in the ZIM. The university articles give
  counts that favour **Stanford**: "29 Turing Award laureates" (Stanford, as
  of April 2021) vs "26 Turing Award winners" (MIT, as of December 2021),
  Berkeley 25, Princeton 16, Harvard 14 (or 9), CMU 13. A solver reading the
  ZIM would plausibly answer Stanford; the expected answer is MIT. Flag for
  the task converter (keep with a note, or drop).
- **556 (Oppenheimer):** the film was unreleased in 2022-05 but *Oppenheimer
  (film)* exists and is listed as upcoming in the Nolan article, so the
  expected list is reachable.
- **267 (Stephen King's hometown):** the article says born in Portland,
  raised in Durham, lives in Bangor; the reference drive time (1h 23min)
  fits Bangor -> Acadia rather than Portland. Map-side ambiguity, but both
  give Acadia as the park.
- Tasks 97, 265-268, 424-430, 737-741 are graded on the map; 556-561 on
  GitLab. Nothing in their answers needs content beyond the articles above.

## Measurements behind the design

- **Cleaning** (`clean.py`): Nolan 434 KB raw -> 286 KB cleaned -> 48 KB zstd-19;
  across the build 13.2 KB compressed HTML per article (1.52 GB total for
  115k; raw cleaned HTML ~7x larger).
- **zstd dictionary** (112 KB, trained on 3,000 cleaned articles): -20 % vs
  no dictionary at level 15 (2.67 vs 3.36 MB on a 1,914-article sample);
  level 19 is no better and 5x slower. Node: `zstd-napi` supports
  dictionaries (Node 20 has no built-in zstd).
- **FTS5 size** on 5,000 articles (98 MB of plain text): contentless
  `detail=full` 0.455 x text, `detail=column` 0.161 x, `detail=none` 0.076 x;
  `columnsize=0` saves nothing measurable. Chosen: contentless `detail=full`
  (phrase queries), no stored text (storing zstd text would add 0.84 GB).
- **Thumbnails**: the ZIM's images are already WebP thumbnails at display
  size (mostly 220-300 px, ~3.5 KB); only location maps etc. are larger
  (up to 1100 px, 70 KB) and get downscaled. Average kept file 5.9 KB.
- **Search ranking**: see SCHEMA.md (bm25 title weight 50 minus 0.3 x
  ln(1 + in-links)): top-1 correct for 10 of 12 sample queries, top-3 for 12.

## Cleanup

Kept in `work/wiki/`: `s2/stats.npz` (270 MB; the 68-min link scan),
`selection.tsv`, logs, the venv. Deleted: s2 chunks (1.8 GB), `build.db`
(2.8 GB; re-running s6 alone needs it, so a ranking/FTS change means
re-running s4, ~3-9 h), `dirents.db` (2.3 GB; s1 recreates it in 5 min),
test DBs and scratch HTML.
