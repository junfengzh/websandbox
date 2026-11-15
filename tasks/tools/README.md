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
- `--sql-only` prints the task's `answer_sql` / `state_sql` results.

`kit/bin/wsb-grade.js` is the kit's minimal equivalent (no logging, no site-grader default).
