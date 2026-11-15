# Generated tasks

Beyond the converted WebArena tasks, each site gets a task generator
(PLAN §6). Conventions shared by all site generators:

- Code: `tasks/<site>/gen/` -- one module per template family, plus
  `tasks/<site>/gen/index.js` that writes `tasks/<site>/generated.jsonl`
  deterministically from a seed (`node tasks/<site>/gen/index.js --seed 1`).
- A **template** = an intent pattern with slots + a slot sampler (SQL over
  base.db) + the eval (answer_sql / state_sql / url, same `eval` format as the
  converted tasks, see CONVENTIONS.md) + metadata. 2-4 hand-written phrasings
  per template (chosen by the seed) for wording variety.
- Template ids: `gen-<site>-<name>` (string), never colliding with WebArena's
  numeric `intent_template_id`.
- Task line fields (in addition to the CONVENTIONS task fields):
  `source: "generated"`, `template: "gen-<site>-<name>"`, `skills` (e.g.
  `search`, `filter-sort`, `navigate`, `read-detail`, `aggregate`, `form-edit`,
  `create`, `multi-step`, `compare`), `difficulty` (1-3), `status`.
- Answers must be unique and well-defined on the data: the sampler rejects
  slot values with ties, empty results or ambiguity; every task's reference is
  computed by SQL at generation time and re-checked by the grader.
- Validation: for EVERY template, at least 2 instances are done by hand
  through the UI with `tasks/tools/browse.js` and graded with
  `tasks/tools/grade.js`, plus 1 negative check (wrong answer/state fails);
  evidence in `tasks/<site>/verify-generated.jsonl`. A template whose
  instances are not solvable through the UI is fixed or removed.
- Variety over volume: aim for 25-40 templates per site covering every major
  feature of the site (search, browse, filters/sort, detail reading,
  aggregation by counting/visiting pages, edits, creation, multi-step
  workflows), with read and write tasks mixed (~50/50), and >= 1,000 tasks
  per site (more for large sites), no two tasks identical.
- Split: `split` is assigned later by the lead (template-disjoint train /
  held-out); generators don't set it.
