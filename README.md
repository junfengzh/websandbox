# websandbox

Lightweight, self-hostable websites for training and evaluating web agents:
a store with its back office, a forum, a code-hosting site, a Wikipedia and a
map. Each site is one SQLite database plus one small Node server, boots in
under a second, and resets to its initial state in milliseconds, so a single
machine can run dozens of independent copies of every site.

The sites are rebuilt from the [WebArena](https://webarena.dev) environments:
same kinds of features and the same underlying data, without the original
stacks (Magento, Postmill, GitLab, Kiwix, OpenStreetMap). All 812 WebArena
tasks are converted to them and verified, and a task generator adds many more.

Status: early -- see [docs/PLAN.md](docs/PLAN.md). Nothing is built yet.

## Layout (planned)

```
kit/            shared server kit: tenants, transactional reset, auth, search, jobs, control + grading API
sites/<site>/   one site: server, templates, schema (SCHEMA.md), build pipeline, grader
tasks/          converted WebArena tasks, generated tasks, verification log
docs/           plan and design notes
```

## Data

Data (SQLite databases, map tiles, routing graph and image archives, ~21 GB)
is not in this repo; it is published as the Hugging Face dataset
[junfengzhou/websandbox](https://huggingface.co/datasets/junfengzhou/websandbox),
one folder per site (`store`, `forum`, `code`, `wiki`, `map`) with a
`manifest.json`, `SHA256SUMS` and `SOURCES.md` each.

```bash
huggingface-cli download junfengzhou/websandbox --repo-type dataset --local-dir data
for s in store forum code wiki; do tar -xf data/$s/media.tar -C data/$s; done
zstd -dc data/map/static.tar.zst | tar -x -C data/map

(cd kit && npm install); for s in forum code wiki map; do (cd sites/$s && npm install); done
tasks/tools/sites.sh up --data-root data     # all five sites; `sites.sh urls` prints them
```

## Licence

Code: Apache-2.0 (see [LICENSE](LICENSE)). Data: see the dataset card; it
carries the licences and attribution of its sources (WebArena, Wikipedia
CC BY-SA, OpenStreetMap ODbL, and others).
