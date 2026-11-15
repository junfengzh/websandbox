# Wiki data: sources, licences, attribution

## Source

| What | Where |
|---|---|
| Article text, redirects, links | `wikipedia_en_all_maxi_2022-05.zim`, the ZIM file used by the WebArena Wikipedia site (Kiwix). Snapshot of English Wikipedia taken 2022-05-01 by Kiwix with mwoffliner 1.11.11 (`Name=wikipedia_en_all`, `Flavour=maxi`). 6,492,232 articles, 10,027,208 redirects, 6,745,266 images. |
| Thumbnails | Images inside the same ZIM (already WebP thumbnails made by mwoffliner from Wikimedia Commons / en.wikipedia files), downscaled to at most 320 px wide. |

The ZIM was produced by [Kiwix](https://www.kiwix.org/) from
[Wikipedia](https://en.wikipedia.org/) content; WebArena ([webarena.dev](https://webarena.dev),
Zhou et al., 2023) distributes the same file with its Wikipedia environment.

websandbox uses a subset of it (see `docs/NOTES-wiki.md` for how it is
selected) and transforms the HTML (page chrome, styles, scripts and navboxes
removed; links to articles outside the subset turned into plain text).

## Licences

- **Text:** Wikipedia article text is licensed under the
  [Creative Commons Attribution-ShareAlike 4.0 International licence](https://creativecommons.org/licenses/by-sa/4.0/)
  (CC BY-SA 4.0); some text is also available under the GFDL. The modified
  articles in this dataset are distributed under CC BY-SA 4.0 as well
  (ShareAlike).
- **Media:** images come from Wikimedia Commons and English Wikipedia and are
  under their own licences (mostly CC BY-SA, CC BY, public domain; some
  non-free images used on Wikipedia under fair use). The licence and author of
  each file are on its file page, `https://commons.wikimedia.org/wiki/File:<name>`
  or `https://en.wikipedia.org/wiki/File:<name>`; the original file name is
  kept in the build's media table (`zpath`) for this purpose.
- **Kiwix / mwoffliner** tooling is GPL-3.0; no Kiwix code is redistributed,
  only content it packaged.

## Attribution text

> Text: Wikipedia contributors, *Wikipedia, The Free Encyclopedia*,
> English edition, snapshot of 2022-05-01, via the Kiwix ZIM
> `wikipedia_en_all_maxi_2022-05`, licensed under CC BY-SA 4.0
> (https://creativecommons.org/licenses/by-sa/4.0/). Modified: subset of
> articles, cleaned HTML, links outside the subset removed, images
> downscaled. Images: Wikimedia Commons / Wikipedia contributors, under
> their individual licences.

Each article keeps its Wikipedia revision id (`article.oldid`) and last-edit
date (`article.edited`), so the page footer can link the exact source
revision: `https://en.wikipedia.org/w/index.php?oldid=<oldid>` (history
and authors of each article are available there). The site footer must
show the CC BY-SA notice, as the Kiwix pages did ("This article is issued
from Wikipedia. The text is licensed under Creative Commons -
Attribution - Sharealike. Additional terms may apply for the media files.").
