# Regrade with the final graders (2026-11-15)

The kit grader changed while the tasks were being converted: whole-number `must_include`, plain numbers compared by
value, `url_match: 'prefix'`, `answer.numeric`, answer spec lists, cross-site `eval.state`, accent folding. So every
task and every recorded verification run was graded again with the final graders (`kit/lib/grader.js` +
`sites/{forum,wiki,map}/grade.js`). All sites were up with `tasks/tools/sites.sh up --tenants 6 --base 7900 --bind rl --port 7999`
(own address per site and tenant; port 80 needs privileges that the build box does not grant).

## How

- **Offline checks**, [tools/regrade.js](tools/regrade.js) (`node tasks/tools/regrade.js --base 7900 --out problems.jsonl`),
  on a freshly reset tenant, for every non-dropped task:
  - *empty*: no pass with an empty answer and no actions (final URL = `start_url`, and also an empty URL);
  - *ref*: answer tasks pass with the stored reference answer (`reference_answer` / `ref`, else built from the eval:
    exact value, the first alternative of each `must_include` item, numeric value + unit, `answer_sql` rows); url /
    map-URL tasks pass with the reference URL (`reference_url`, else the first `eval.url`); a static reference with
    `answer_sql` must not drift (drift only counts when the SQL values fail the static check);
  - *replay*: every recorded verify run (`observed.answer` + `final_url`) is graded again and must keep its recorded
    outcome (pass, or fail for negative checks). For tasks with state checks, the run cannot be replayed offline, so
    only their answer/url/map checks are compared, check by check. A mismatching run that a later run of the same task
    and kind supersedes is counted as superseded. Runs judged by the LLM judge (fuzzy) are skipped.
- **UI re-runs of state tasks**: 2 tasks per template that has a state check (seeded sample, 156 templates; plus all 13
  tasks of the code templates 335/337/339), done again through the UI with `tasks/tools/browse.js` and graded with
  `tasks/tools/grade.js --log` (notes "regrade UI re-run", appended to the site's verify log): 321 tasks, 8 parallel
  runners on their own tenants.

## Results (final graders, after the fixes below)

| file | tasks | empty fails | ref passes | url ref passes | replays (full) | replays (per check) | skipped |
|---|---|---|---|---|---|---|---|
| forum/webarena.jsonl | 106 | 106 | 11/11 | 58/58 | 14/14 | 94/94 | 64 |
| store/webarena-shopping.jsonl | 186 | 186 | 87/87 | 53/53 | 129/129 | 16/16 | 116 |
| store/webarena-admin.jsonl | 179 | 179 | 84/84 | 8/8 | 108/109 (1 lenient) | -- | 196 |
| code/webarena-a.jsonl | 93 | 93 | 47/47 | 21/21 | 71/71 | 16/16 | 52 |
| code/webarena-b.jsonl | 87 | 87 | 6/6 | 18/18 | 13/13 | 33/33 | 117 |
| map/webarena.jsonl | 108 | 108 | 88/88 | -- | 201/201 | -- | 20 |
| cross/webarena.jsonl | 48 | 48 | 6/6 | 13/13 | 32/32 | 33/33 | 29 |
| forum/generated.jsonl | 2,314 | 2,314 | 1,054/1,054 | -- | 57/57 | -- | 105 |
| code/generated.jsonl | 2,491 | 2,491 | 1,326/1,326 | -- | 65/65 | -- | 101 |
| wiki/generated.jsonl | 1,950 | 1,950 | 1,790/1,790 | 160/160 | 106/106 | -- | 0 |
| map/generated.jsonl | 1,770 | 1,770 | 1,410/1,410 | 360/360 | 105/105 | -- | 0 |
| store/generated-shopping.jsonl | 1,796 | 1,796 | 810/810 | 55/55 | 50/51 (1 superseded) | 6/6 | 68 |
| store/generated-admin.jsonl | 1,962 | 1,962 | 1,061/1,061 | -- | 43/44 (1 superseded) | -- | 120 |
| **all** | **13,090** | **13,090** | **7,780/7,780** | **746/746** | **994/997** | **198/198** | 988 |

"skipped" = state-only runs (covered by the UI re-runs), fuzzy runs, and runs marked `superseded`. The remaining
non-matches are not grader problems:
- admin 199 (lenient): a run logged as failing now passes; it was logged before `000000299 |OR| 299` was added.
- `gen-shopping-product-spec-0001`, `gen-admin-product-attribute-0001` (superseded): negatives logged before a
  template fix; the later runs after the fix match.
- 5 admin "drifts" are fuzzy tasks (183, 186, 201, 202, 203) whose `answer_sql` is a helper in another format than the
  judge's reference ("May 30, 2023" vs `2023-05-30 11:10:06`); the LLM judge grades them, not the SQL. 147 cosmetic
  drifts (static reference with ` |OR| ` alternatives or more items than the SQL's first column) pass the static check
  with the SQL values.

The restored url checks pass every recorded run that has a final URL (10 runs of 327/328), and all 13 UI re-runs of
335/337/339 end under the reference path.

**UI re-runs:** 321 tasks, all pass on their final run except two whose task was then fixed (below); runners' own
slips (stale element numbers, a missed menu) were redone and logged after the failed attempt.

## Changes

Every change is also in the task's `changes` (prefix "regrade 2026-11-15"); converters and generators were changed and
re-run, so the task files are reproducible.

| Tasks | Change | Why |
|---|---|---|
| code 658-665, 808, 809 (template 327/328) | `type: ['url', 'state']`, `url: /<repo>/-/issues`, `url_match: 'prefix'` (convert-a.py) | restore WebArena's "GOLD in PRED" url check, dropped while the kit had no prefix mode; 660's WebArena URL was the repo tree, the issue list is used |
| code 590-594 (339), 666-668, 805-807 (335), 669, 670 (337) | url check under `/-/milestones`, `/-/merge_requests`, `/-/issues` with `url_match: 'prefix'` (convert-b.py) | same; re-verified through the UI (13/13) |
| admin 458-463, 780 | `start_url` `/admin/admin/catalog/...` -> `/admin/catalog/product/edit/id/N/` (convert_admin.py) | the doubled `/admin` opened a 404 page, so "this product" was unknown |
| admin 544 | intent "Selena Yoga Hoodie" -> "Selene Yoga Hoodie" | the product is Selene; a search for "Selena" finds nothing (WebArena typo) |
| admin 694-698 | category check also accepts subcategories (and Gear itself for 697/698) | WebArena only checked that the chosen category's label contained "bottom"/"top"/"gear"; Men > Bottoms > Pants is a natural pick for jeans |
| forum 630-639 | number needles matched with thousands separators removed | "$1,000" did not count as 1000 |
| `gen-forum-bio-top-forum` (60) | the "must not name your other forums" decoys match whole words (tasks/forum/gen/profile.js) | a bio containing "start" counted as naming /f/art |
| `gen-forum-search-post-forum-author` (60) | `answer_sql` returns username and forum as two rows | it returned two columns of one row, so the drift check saw only the username |
| `gen-admin-order-ship-one-item` (40, re-sampled) | the sampler skips orders that already have a shipment (tasks/store/gen/admin/orders_write.js) | order 300 already had its items shipped in the base data (no Ship button): `-0018`, `-0030` were unsolvable |
| `gen-code-mr-request-review` (60, re-sampled) | the sampler skips 14 open MRs the site cannot render (tasks/code/gen/write_issues.js) | 13 gcc-mirror/gcc MRs return HTTP 500 and processwire/processwire!247 takes > 2 min (see below): `-056`, `-059` were unsolvable |

The two re-sampled templates were validated again (2 UI runs each, `verify-generated.jsonl`); their older log lines
are marked `superseded` (the task ids now name other instances). The changed admin tasks were re-run through the UI
(460, 544, 697).

## Findings for site owners (not fixed here)

- **code**: open-MR pages crash when the merge base is outside the stored history: `sites/code/collab/routes/merge_requests.js`
  `mergeability()` calls `git.getCommit(rv.base).tree_sha` on null (TypeError, not `GitUnavailable`) -> HTTP 500 on 13
  gcc-mirror/gcc MRs (13, 15, 17, 21, 22, 29, 33, 48, 49, 51, 65, 67, 75). processwire/processwire!247 (and possibly
  a few primer/design / lunaru/MongoRecord / amwhalen MRs under load) takes > 60-120 s (rev-list), holding the
  tenant lock. A scan of all 3,222 open MR pages: `$WSB_TMP/regrade/mrscan/`.
  **Fixed 2026-11-15** (docs/NOTES-code.md "MR page fixes"): the gcc pages say the merge base is outside the stored
  history; processwire!247 was the dry-run merge diffing line-ending rewrites (now bounded, deterministic); a scan of
  every MR (3 tabs) and issue page of every project -- 483,970 pages -- is all HTTP 200, p95 <= 26 ms, max 1.3 s
  (first view of a deep gcc merge base, cached after). The 14 MRs skipped by `gen-code-mr-request-review` render now
  (the sampler still skips them; re-sampling would change task ids).
- **code**: merged MR pages have no "Delete source branch" button; MR search finds `!6981` but not `6981`; for a fork
  the new-MR form targets the upstream project by default (as GitLab).
- **store admin**: Categories and Customer Groups are plain multi-selects (Ctrl-click; `browse.js select` sets one
  option); choosing a carrier does not fill the tracking title; product grid SKU search also lists similar SKUs; the
  Reviews grid has no product filter (the product page's "Product Reviews (N)" link works); the size list has no
  "uni-size" (697's intent asks for it; not graded).
- **graders, strict but faithful to WebArena** (kept): forum 637 needs the literal "sony headphone"; shopping 530/532
  need the full order number `000001161` in the contact-form draft.

## Strict numbers (2026-11-15, second pass)

`must_include` with plain-number references used to accept any equal number in the answer, so a count could be
guessed by listing numbers ("1, 2, 3, 4, 5"). The kit grader now grades **count/amount questions with strict
numbers** (kit/README.md "Grading"): when every `must_include` item has a plain-number alternative and the intent
asks for a count or amount (`how many`, `how much`, `number of`, `count`, `total`, `amount`, `sum`; not "phone
number of" / "order number of" or a sort key like "the highest grand total"), the answer also fails if it has any
number that is neither a reference value nor mentioned in the intent. `answer.strict_numbers: true|false` overrides.
A legit extra number ("3 orders, total $45" for "how many orders") fails by design: the question asks for one count.

Full regrade with the same setup (`sites.sh up --tenants 2 --base 7900 --bind rl --port 7999`, `regrade.js`):
strict numbers apply to **2,012 of the 7,780 answer tasks**; the results table above is unchanged after the fixes
below (13,090/13,090 empty fail, 7,780/7,780 ref, 746/746 url ref, 994/997 full replays with the same 1 lenient +
2 superseded, 198/198 per-check replays). The first pass failed 41 references and 3 recorded runs, all only
because of extra numbers:

| Tasks | Change | Why |
|---|---|---|
| map 254 ("What is the phone number of ...") | none -- the trigger no longer reads identifier "number of" as a count | the phone number's parts are three references; "+1" failed |
| `gen-wiki-settlement-population` (70) | `answer.strict_numbers: false` (tasks/wiki/gen/infobox.js, `changes` note) | the reference is the infobox figure with its census year ("47,743 (2010)"), which the intent does not name; 41 references failed |
| `gen-admin-bestseller-units` (19 tie instances of 25) | `answer.strict_numbers: false` (tasks/store/gen/admin/catalog_read.js, `changes` note on the template) | the intent also asks for the product, and names carry numbers ("9 Elements ...", "Sprite Stasis Ball 75 cm"): 2 recorded UI runs failed |

Both templates were regenerated (same seed): only those 95 tasks changed. `consolidate.py` (seed 20261115) rebuilt
`tasks/all.jsonl` and the splits with identical membership (train 10,452 / held-out 2,638, templates.json
unchanged).
