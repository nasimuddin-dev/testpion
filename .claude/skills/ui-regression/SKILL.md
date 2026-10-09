---
name: ui-regression
description: Run TestPion's end-to-end UI regression suite (apps/desktop/e2e) in the real Electron app, read the report, fix failures, and add a plan for every new UI feature. Use before every release, after any UI change, and after installing a release.
---

# UI regression (end to end)

The suite drives the real app: each plan in `apps/desktop/e2e/plans/*.cjs` starts TestPion with a fresh copy of
`examples/public-workspace`, runs its steps in the window, takes a screenshot per step and checks each result
against the plan's expectation. The local demo servers (`examples/servers/demo-servers.mjs`) are started if port
4010 is free.

## When

- **Before every release** (after unit + integration tests, before `scripts/release.py`). A release with a failing plan does not ship.
- **After installing a release**: run it against the installed exe (see the install-and-verify skill).
- After any UI change, at least the plans it touches (`--only`).

## Run

```bash
npm run build -w @testpion/desktop
npm run e2e -w @testpion/desktop
```

- Some plans: `npm run e2e -w @testpion/desktop -- --only rename-explorer,keyboard`
- Installed app: `npm run e2e -w @testpion/desktop -- --exe "$LOCALAPPDATA/Programs/TestPion/TestPion.exe"`
- Output (screenshots `NN-step.png`, `report.json` per plan, `summary.json`): `-- --out <dir>` (default: a temp folder, printed at the end).
- Leak / slowdown soak (not in the suite): `SOAK_CYCLES=36 SOAK_OUT=<dir> node apps/desktop/e2e/run-e2e.mjs --only _soak --timeout 3600` writes `metrics.jsonl` (both processes GC'd per cycle) and heap snapshots after cycle `SOAK_SNAP_AT` (5) and the last; with other agents rebuilding `dist`, run it against a private copy of Electron with the build in `resources/app` (`--exe`).

Plans run one at a time on purpose: running several apps at once was tried (2026-10-01) and was no faster on a
CPU-bound machine and flakier (inline rename and typing steps need the window's keyboard focus, which only one
window has). The run takes several minutes (the app starts once per plan; `core` alone is 62 steps). Run it in the background
and read the output when it finishes. Do not use the machine's real `~/.testpion`: the runner sets `TESTPION_HOME`.

## Reading results

`PASS` / `FAIL` / `FLAKY` per plan, then each failing step with the reason and the step's result:

- `expected /…/`: the result did not match. Open the step's screenshot in the plan's output folder before changing anything.
- `console errors: …`: the window logged an error during the step (a real bug unless the plan lists the step in `allowErrors`).
- `failure marker in the result`: a step without an expectation returned `NO …`, `ERR …`, `NOT RENAMED`, ….
- `did not run` / `no report`: the app crashed or timed out; rerun the plan alone and look at `<out>/homes/<plan>-1/logs/app.log`.

A plan that fails is rerun once. **FLAKY** (failed, then passed) is reported but not a failure; if the same plan is
flaky twice, fix the step's timing (wait for the element, not a longer sleep) rather than ignoring it.

Fix the app, not the expectation, unless the change in behaviour was intended; then update the expectation in the
same commit as the UI change.

## Adding a plan for a new feature

Every UI feature gets steps in an existing plan or a new `plans/<feature>.cjs`:

```js
// One line: what the plan covers.
const { withExpect, allUnder } = require('../lib.cjs');
const steps = [
  ['open-thing', `(async () => { await __t.requests(); await __t.sleep(400); /* … */ return 'row: ' + name; })()`],
  ['perf', `(async () => { /* … */ return 'per keystroke ms: ' + times.join(','); })()`, false], // false: no screenshot
];
module.exports = withExpect(steps, {
  'open-thing': /row: My thing/,
  perf: allUnder('per keystroke ms', 200),
}, { prepare: (ws, out) => {/* fixtures in the workspace copy */}, env: (out) => ({ E2E_STUB_SAVE: out + '/x.md' }), allowErrors: ['step-that-throws'] });
```

- A step is `[name, code, screenshot = true]`; `code` is an expression run in the window. It returns a short string
  describing what is on screen: labels, counts, focus, selection. It should not return just `ok`.
- The helpers in `e2e/helpers.js` are available as `__t`: `view(label)`, `requests()`, `expand(row)`, `open(row)`, `menu`, `tab`, `button`, `key`, `tabMenu`, `sleep`, `esc`, ….
- `requests()` waits for the Collections sidebar and its rows (at most 3 s), not a fixed sleep: time it and you measure the app.
- `run-e2e.mjs` starts Electron with background throttling and occlusion detection off, so a window behind others keeps painting (`painted()` waits don't hang).
- Menu items run their action just after the menu closes (a `setTimeout 0`): after clicking one, wait (`waitFor`/`sleep`) before checking its effect.
- Steps run in order in one app session, so a plan can build on earlier steps. Put things back if a later step depends on them.
- Expectations are by step name (a RegExp, or `(result) => true | 'reason'`); `withExpect` throws on an unknown name.
- Native open/save dialogs: `E2E_STUB_OPEN` / `E2E_STUB_SAVE` (`CANCEL` cancels).
- App settings for the plan: `settings: { … }` (merged into settings.json), e.g. `{ assistantProvider: 'demo', assistantModel: 'demo' }` to use the examples' offline model for AI features.
- Uncaught exceptions are recorded with their stack in the step's `errors` (report.json); a minified name like `l is not a function` is easier to read after `npx vite build --minify false`.
- Files starting with `_` in `plans/` are skipped (drafts).
- Run the new plan three times (`--only <name>`) to confirm it is stable before committing.
