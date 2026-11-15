# Wiki routes (`wiki.wa`)

Every URL the wiki site serves, for graders and the task converter. Wikipedia's URL scheme
is kept (`/wiki/<Title>`, `/w/index.php?search=` / `?title=&action=info`,
`/wiki/Special:WhatLinksHere/<Title>`, `/wiki/Special:Random`), and WebArena's Kiwix URLs
(`/wikipedia_en_all_maxi_2022-05/A/<Title>`, the start URL form of the 23 Wikipedia tasks)
redirect to it. Server: [server.js](server.js); handlers: [routes/index.js](routes/index.js);
article lookup/rendering: [lib/wiki.js](lib/wiki.js); search: [lib/search.js](lib/search.js);
data: [SCHEMA.md](SCHEMA.md).

Read-only site: shared DB mode, no logins, no writes, all routes `raw` (no tenant lock or
session). `/__rl/reset` only resets the kit's state; `/__rl/query` runs on `base.db` (tables in
SCHEMA.md). `<Title>` is the article `path` (underscores for spaces); URLs keep `/ : , ' ( )`
readable and percent-encode the rest (`Washington_%26_Jefferson_College`).

## Articles

| URL | Response |
|---|---|
| `/`, `/wiki`, `/wiki/` | 302 → `/wiki/Main_Page` (the 2022-05-01 Wikipedia main page) |
| `/wiki/<Title>` | the article: `h1#firstHeading`, "From Wikipedia, the free encyclopedia", body in `#mw-content-text` (infobox `table.infobox` moved to the top of the lead, TOC `#toc` before the first section heading when there are >= 4 headings, sections `<h2 id=anchor>`..`<h6>`, tables, thumbnails from `/media/`, references `ol.references li#cite_note-N`), footer "This page was last edited on 26 April 2022 (revision N)". Internal links go to included articles only; links to articles not in the DB are red text `<span class="new">` (no link). Tools menu: What links here, Page information |
| `/wiki/<title variant>` | 301 to the canonical path when the request has spaces (`Christopher%20Nolan`) or a lower-case first letter (`christopher_Nolan`) |
| `/wiki/<Redirect>` | 302 → `/wiki/<Target>?rdfrom=<Redirect>`; the target shows "(Redirected from <Redirect>)" in `#contentSub` (only when `rdfrom` really is a redirect to it) |
| `/wiki/<Redirect>?redirect=no` | the redirect page itself ("Redirect page" → target link) |
| `/wiki/<missing>` | 404 "This offline Wikipedia does not have an article with this exact name" + search link + similar titles |
| `/w/index.php?title=<Title>` | 302 → `/wiki/<Title>` |

No categories, category pages, talk pages, history or edit pages: the ZIM has none (SCHEMA.md),
and the site shows no category UI rather than inventing one.

## Search

| URL | Response |
|---|---|
| `/w/index.php?search=<q>&title=Special:Search&go=Go` (the header search box; also without `go`, and `/search?search=`, `/wiki/Special:Search?search=`) | **Go**: 302 → `/wiki/<Title>` when `q` is an article title, a redirect, a case variant or (diacritics/case-insensitive) a suggestion title; otherwise the results page |
| `/w/index.php?search=<q>&title=Special:Search&fulltext=1[&limit=20][&offset=0]` | **results page**: "Showing results 1 – 20 of N", `ul.mw-search-results > li.mw-search-result` with `.mw-search-result-heading a` (title), `.searchresult` (lead with `.searchmatch` highlights), size and last-edit date, page image; "There is a page named X" when an exact match exists (it is also listed first); pager "View (previous 20 \| next 20) (20 \| 50 \| 100 \| 250 \| 500)" (`offset`, `limit` <= 500; the first 1,000 results are listed) |
| … `&fulltext=1` with typos | `Did you mean: <alt>`; with no results, the results for `<alt>` and "Showing results for <alt>. No results found for <q>" (`nodym=1` searches the original) |
| `/search?pattern=<q>[&content=wikipedia_en_all_maxi_2022-05][&start=0][&pageLength=25]` | Kiwix-style full-text search: same results page (`start` = offset, `pageLength` = limit) |
| `/wiki/Special:Search` | empty search form |

Ranking (lib/search.js): stop words dropped, all remaining words required (porter stems,
`"phrases"` kept), score = `bm25(title x50, body x1) - 0.3 ln(1 + in-links)` (SCHEMA.md), exact
title/redirect match first. More than 8,000 matches (common words): title matches and the
articles in the most-linked id window (~4,000 matches) are scored, the rest follow in
in-link order. Results per query are cached per process.

## Title suggestions (autocomplete)

| URL | Response |
|---|---|
| `/w/api.php?action=opensearch&search=<prefix>[&limit=10]` | OpenSearch JSON `[prefix, [titles], [descriptions], [urls]]` (what the header box uses) |
| `/w/rest.php/v1/search/title?q=<prefix>[&limit=10]` | `{pages: [{id, key, title, matched_title, display_title, description, thumbnail}]}` |
| `/suggest?term=<prefix>[&count=10]` | Kiwix: `[{value, label, kind: "path", path: "A/<Title>"}]` |

Titles and redirect titles by prefix (diacritics/case-insensitive), ranked by in-links, one
entry per target article.

## Special pages

| URL | Response |
|---|---|
| `/wiki/Special:Random`, `/random[?content=…]` | 302 → a random article |
| `/wiki/Special:WhatLinksHere/<Title>` (or `?target=<Title>`) `[&limit=50][&from=<page id>\|&back=<page id>][&hidelinks=1][&hideredirs=1]` | "Pages that link to "X"": summary `#mw-whatlinkshere-summary` (N articles on this wiki link here; M redirects), `ul#mw-whatlinkshere-list` (linking articles in page-id order, paged by page id like MediaWiki), `ul#mw-whatlinkshere-redirects` (redirects to the page, first page only). A redirect as target shows the links to its article. Counts are within this wiki (115k articles) |
| `/w/index.php?title=<Title>&action=info`, `/wiki/Special:PageInfo/<Title>` | "Information for "X"": page ID, lengths (plain text / HTML bytes), sections, infobox, page image, redirects, links here (this wiki), in-links on the full 2022 Wikipedia, last-edit date, revision id, outgoing / red / external links, images |
| `/wiki/Special:AllPages[?from=<Title>]` | 345 titles in path order from `from`, Previous/Next page |
| `/wiki/Special:SpecialPages` | list of the special pages |
| `/wiki/Special:<other>` | 404 |

## Kiwix URLs (WebArena start URLs)

| URL | Response |
|---|---|
| `/wikipedia_en_all_maxi_2022-05/A/<Title>`, `/content/wikipedia_en_all_maxi_2022-05/A/<Title>` | 301 → `/wiki/<Title>` (then the usual redirect handling) |
| `/wikipedia_en_all_maxi_2022-05[/]` | 301 → `/wiki/User:The_other_Kiwix_guy/Landing` (WebArena's Wikipedia start page; its topic list is linked to the articles here) |
| `/wikipedia_en_all_maxi_2022-05/<other>` | 301 → `/wiki/<other>`; `I/`, `-/`, `M/` → 404 |

## Static and diagnostics

`/static/wiki.css`, `/static/wiki.js` (search-box combobox), `/static/favicon.svg`,
`/static/opensearch.xml`; `/media/<xx>/<hash>.webp|svg` (thumbnails); `/robots.txt`;
`/__wiki/stats` (render-cache entries/MB/hits and RSS of this process).

## Skins

`default` (Vector-like, side navigation), `dark`, `compact` (top navigation, relabelled
"Surprise me" / "Backlinks" / "About this page" / search placeholder). Set per tenant with
`POST /__rl/reset {"skin": "dark"}`.
