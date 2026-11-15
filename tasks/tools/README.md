# Task tools

Shared tools for converting and verifying WebArena tasks on the lite sites
(docs/CONVENTIONS.md "WebArena tasks"). `npm install` here once (puppeteer-core).

## browse.js -- step-by-step headless Chrome

A persistent headless Chrome you drive from the shell one command at a time, the way a
person would use a browser: look at the page, click a link, type, submit. Chrome keeps
running between invocations; each call reconnects through the WebSocket endpoint saved in
the state file (`$WSB_TMP/wsb-browse/<port>.json`).

```
B="node tasks/tools/browse.js"           # add --port P (or WSB_BROWSE_PORT) per builder: use your range
$B start                                 # headless Chrome, own --user-data-dir, debugging port 7280 by default
$B goto http://127.0.0.1:7200/           # relative URLs resolve against the current page
$B snapshot                              # compact text view; interactive elements numbered [N]
$B find 'Submitted by'                   # snapshot lines matching a regex
$B click 12                              # click [12] (waits for the navigation, if any)
$B clickm 'link "New"' [--nth 2]         # click the first (nth) element whose description matches
$B type 15 "My title" [--append] [--enter]
$B type @'textarea "Body"' "text"        # @REGEX instead of N anywhere: first matching element
$B select @'select "Forum' books         # option value or label
$B check @'radio.*value=text' on         # checkbox / radio
$B upload @'file-input' ./pic.jpg
$B submit [N]                            # requestSubmit() the form of N (default: focused element)
$B press Enter | back | forward | reload
$B text '.submission__title'             # innerText of every match;  attr SELECTOR NAME
$B url | title | screenshot out.png [--full] | eval "document.title"
$B cookie wsb_sid VALUE [URL]            # e.g. the cookie from POST /__rl/login
$B stop                                  # kill Chrome, delete the state file and profile
```

Snapshot format: one line per block, `[N] link "text" -> href`, `[N] button "▲" (pressed)`,
`[N] input[text] "Label" name=title value="..."`, `[N] textarea ...`, `[N] select ... selected="x" [a | *x* | b]`,
`[N] radio [x] "Text" name=type value=text`, `[N] summary "Reply" (closed)`, headings as `#`.
Numbers are stored as `data-wsb-n` attributes by the last snapshot (`snapshot`, `find`,
`clickm` and `@REGEX` all renumber), so re-snapshot after a navigation before using numbers.
Long pages are cut at 15,000 characters (`--max N`, `--all`).

Chrome flags/prefs keep the password manager out of the way (`--password-store=basic`,
`--disable-features=PasswordLeakDetection,PasswordManagerOnboarding,...`,
`credentials_enable_service=false` in the profile's Preferences): with them, clicks keep
working after a login form is submitted in new headless (the forum UI builder saw input die
there otherwise). Verified on Chrome 145 by logging in through /login and clicking on.

Logging in without the form: `POST /__rl/login {"user": "..."}` returns the session cookie;
set it with `browse.js cookie <name> <value> <site URL>` and reload.

## grade.js -- grade a task against a running tenant

```
node tasks/tools/grade.js --site http://127.0.0.1:7200 --tasks tasks/forum/webarena.jsonl --id 27 \
  [--answer "..."] [--url "http://.../f/books/..."] [--tenant I] [--grader sites/forum/grade.js] \
  [--log tasks/forum/verify.jsonl --how "steps" --notes "..." [--expect-fail]] [--sql-only]
```

- Uses `sites/<task.site>/grade.js` when it exists (site URL canonicalisation, extra
  `url_match` modes), else the kit grader (`kit/lib/grader.js`). Queries go through the
  tenant's control API (`/__rl/query`), so the rollout's uncommitted state is graded.
- Prints `{task_id, pass, checks}`; exit 0 pass, 1 fail, 2 pending (fuzzy: needs the LLM
  judge), 3 error.
- `--log` appends a verify line `{task_id, when, how, final_url, observed, ok, notes}`
  (`observed` = the answer and each check's got/reference/drift). `--expect-fail` logs a
  negative check (`negative: true`, `ok` = the grader failed it), used to show a grader is
  not trivially passable.
- `--sql-only` prints the task's `answer_sql` / `state_sql` / `state` results.
- Cross-site tasks (`tasks/cross/webarena.jsonl`): `--sites shopping=URL,forum=URL,gitlab=URL,...`
  gives every site's control API (`sites.sh urls` prints it); `state: [{site, sql, expect}]`
  checks run on their site, the rest on `grade_site` (`--site` defaults to its `--sites` URL);
  the site grader is `sites/<dir>/grade.js` of `grade_site` (gitlab = code, shopping* = store).

`kit/bin/wsb-grade.js` is the kit's minimal equivalent (no logging, no site-grader default).

## sites.sh -- all sites up with one command

```
tasks/tools/sites.sh up [--tenants N] [--base 7700] [--stride 10] [--only store,forum,code,wiki,map]
                        [--bind ports|rl] [--port 80] [--workers W] [--data-root DIR] [--control-token T] [--fresh]
tasks/tools/sites.sh status | down | urls [--tenant I] | reset [--tenant I | --all]   (same --base)
```

Starts `sites/{store,forum,code,wiki,map}/server.js` (store = storefront + `/admin`) with the data in
`$WSB_DATA_ROOT/<site>` and waits until every site's `/__rl/health` is ok (a few
seconds; the map loads its routing graph). Pids and logs: `$WSB_TMP/wsb-sites/<base>/`.
`down` kills by pid (process group; workers too).

- `--bind ports` (default): site k (store 0, forum 1, code 2, wiki 3, map 4) on
  `127.0.0.1:BASE + k*STRIDE + i` for tenant i. **Cookies are per host, not per port**, and all
  sites use `wsb_sid`: in one browser, logging in on one site logs you out of another. Fine for
  single-site work; use `--bind rl` for cross-site runs.
- `--bind rl`: tenant i of each site on its own address `127.10.<i>.<k>:PORT` (shopping .2,
  shopping_admin .3 -- the same store process --, forum .4, gitlab .5, wiki .6, map .7; the RL
  `hostMap` scheme), so every site keeps its own cookies; the control API of each site on
  `127.0.0.1:BASE + k*STRIDE` (kit `--loopback-port`), tenant by `X-WSB-Tenant`. PORT 80 (the
  RL default) needs CAP_NET_BIND_SERVICE; any free port works locally (`--port 7799`).
- `urls --tenant I` prints the host placeholders for tenant I (`__REDDIT__=http://127.10.1.4:7799`,
  ...) and the `--sites ... --tenant I` arguments for grade.js / `tasks/cross/check_refs.js`.

Example (cross-site verification): `sites.sh up --tenants 2 --bind rl --port 7799`, then
`grade.js --tasks tasks/cross/webarena.jsonl --id 552 $(sites.sh urls --tenant 1 | tail -1)`.
