# Flow designer: build test flows visually

Postman Flows lets people wire API calls on a canvas. TestPion's flows already exist as test files (steps chained
with `dependsOn`, values passed with `extract` and `{{variables}}`), and the Tests view shows them read-only as a
diagram (the Flow tab, `components/FlowDiagram.tsx`, layout in `packages/shared/src/flow-graph.ts`). The designer
makes that diagram editable. The YAML file stays the one source of truth: the canvas edits it, the Editor tab shows
the same text, and the CLI, CI, monitors and agents run it unchanged.

## What a person can do on the canvas

1. **Add a step** from a palette: HTTP request (blank, or copied from a saved request in a collection with
   `testFromRequest`), GraphQL, gRPC, WebSocket, MCP tool call, LLM prompt, and a Delay. A new step is dropped where
   the person clicks or after the selected step (then it depends on it).
2. **Connect steps** by dragging from a step's output port to another step's input port: the target gains a
   `dependsOn` on the source. Selecting an edge and pressing Delete removes it. A connection that would make a cycle is
   refused with a message.
3. **Edit a step** in an inspector beside the canvas: name, the request (method, URL, headers, body, auth — the same
   editors as the request view where they exist), values to extract (variable name → JSONPath, with a picker from the
   step's last response), checks (the existing AssertionEditor), and the steps it waits for.
4. **See the data flow**: an edge is labelled with the variables the source extracts and the target uses
   (`{{token}}`); a step that uses a variable no earlier step sets and no environment defines is marked.
5. **Run** the flow, or one step with what it depends on, from the canvas; steps light up with their status as the
   run goes (the existing run panel results), and clicking a run step opens its result.
6. **Arrange**: drag steps (positions saved in the file under `layout:`), Auto-arrange (the shared layered layout),
   zoom, fit, minimap off. Multi-select with Shift, delete, duplicate, copy/paste between flows. Undo and redo for
   every canvas change.
7. **Start a flow**: an empty flow file shows the palette's first choices like Postman: Add a step, Create from a
   collection (a folder's requests in order, each depending on the previous, extracts suggested from responses that
   return ids/tokens), Generate with AI (describe the flow; the assistant writes the YAML, reviewed before saving).

## How it is built

- **Core `flow-edit.ts`**: operations on the YAML text with the `yaml` Document API, keeping comments, key order and
  line endings (the same approach as `exposed-flows.ts` `setExposure`): addStep, updateStep, removeStep (also removes
  it from others' dependsOn), connect, disconnect (cycle check), renameStep (updates dependsOn references),
  setLayout, duplicateStep. Each returns the new text; all are unit-tested on files with comments and CRLF.
- **Test schema**: `layout:` (step id → [x, y]) is a known top-level key; the loader ignores it at run time.
- **Renderer**: `FlowDiagram` gains an `editable` mode (ports, drag, selection, edge selection) rather than a second
  canvas component; a `FlowDesigner` wraps it with the palette, inspector and toolbar; the Tests view's Flow tab uses
  the designer for YAML/JSON test files. Every edit goes through one RPC (`tests.flowEdit {file, op}`) that applies the
  core operation and saves, so undo is a stack of texts and the Editor tab updates through the existing file watch.
- **AI-first**: CLI `testpion flow edit <file> --add-step … | --connect a b | --remove x` (JSON in/out) and MCP tools
  `flow_add_step`, `flow_connect`, `flow_update_step`, `flow_remove_step` over the same core operations.
- **Docs**: a "Design a flow" section in docs/test-runner/integration-testing.md.
- **Tests**: unit tests for every operation; an e2e plan that builds a three-step flow on an empty file by clicking
  (add from a collection, connect, add an extract, run, see statuses) and checks the YAML.

## Second release: the rest of the blocks

Each block is a runner feature first (the file runs the same in the CLI, CI, monitors and through MCP), then a canvas
block.

1. **If** — `if: <expression>` on any step (and a `type: condition` block with only that): the step runs when the
   expression is true, else it is `skipped` with the reason; steps that depend only on skipped steps are skipped too.
   Expressions: comparisons and boolean logic over variables and the previous step's response (`status == 200`,
   `$.role == 'admin' && {{count}} > 0`), evaluated in the script sandbox. On the canvas a condition block has true and
   false outputs (`onTrue`/`onFalse` targets written as `dependsOn` plus `when: true|false`); the branch not taken
   shows as skipped after a run.
2. **Repeat / for each** — `repeat: N` or `forEach: { dataset: datasets/users.csv }` (or an inline list) on a step: it
   runs once per iteration with the row's fields (and `$index`) as variables; extracts from the last iteration flow on;
   results list each iteration. The node shows "× N".
3. **Script** — `type: script` with `script:` (tp.* API, variables in and out, no request) for computing or reshaping
   values between steps.
4. **Sub-flow** — `type: flow` with `file:` and `inputs:` runs another flow file as one step; its extracted values
   (or its `output:`) come back as the step's variables.
5. **Log / Output** — `type: log` with `message:` (template) shows a value in the run results; `output:` at the top of a
   flow file declares what the flow returns (a map of templates), used by sub-flows and by flows exposed as MCP tools.

Every block: loader + lint + runner + flow graph kinds + canvas palette and inspector + MCP flow tools schema + docs +
unit tests + an e2e step.

## Third release: better than Postman Flows

From research of Postman Flows feedback (no polling, flows can't set variables, hard to debug nested flows, parallel by
default, no text format, free-plan limits, no Arazzo) and n8n's debugging (execution history, pinned data, replay).
Built in this order:

1. **Debugging**: run history per flow (every past run: each step's request, response, variables, timing); breakpoints
   (pause before a step, inspect and edit variables, continue / step over); run from here / run to here (earlier
   steps' results reused); pin a step's response (later steps build on it without calling the API); replay a failed
   run on its own data; a variables timeline (each variable's value after every step). *Built:* engine hooks in
   `runner/debug-hooks.ts` (runTests `pauseBefore`, `onlyIds`, `seed`, `pins`, per-step `variables` in results),
   history / plans / designer state in `runner/flow-history.ts` (`.local/flows/`), RPC in
   `backend/handlers/flow-debug.ts` (`tests.flowRun`, `run.paused` / `runs.resume`), canvas parts in
   `FlowDebugParts.tsx`; `testpion flow runs`, `testpion test --from/--to/--seed-run`, MCP `flow_runs` and
   `run_tests` `from`/`seedRunId`.
2. **Blocks**: Wait until (repeat a step until a condition, interval, timeout, backoff); Finally (clean-up that always
   runs); Parallel group (sequential by default, a frame marks steps that may run together); Set variable (writes
   environment / collection / global scope); Assert (checks only). *Built:* keys read in `runner/control-keys.ts`
   (`until:`, `finally:`, `parallel:`, `type: set` / `assert`, `type: wait` = a request with `until:`), run in
   `runner/flow-control.ts` (Wait until with tries / backoff / timeout / cancel, Set variable through the scripts'
   `applyScriptOutput` + `persistVariable`, Assert on the previous response or the variables) and in runner.ts (finally
   steps held back per file and run with their own signal after the file's other steps, also after a failure, a bail,
   a cancel or a stop; a step that waits for one is skipped, never left waiting; a parallel group shares one worker
   slot); frames in `flowGraph().groups` (parallel groups, the Finally lane as the last column), `FlowFrame` on the one
   canvas, `FlowControlFields.tsx` in the inspector, flow-edit op `group`, `testpion flow edit --parallel/--finally`,
   MCP `flow_update_step` with a list of ids. **Decision on ordering:** the default stays as it was — steps run
   concurrently when nothing orders them (`--concurrency`, default 4; sub-flows and debugged runs one at a time), so
   existing suites are not slowed; `dependsOn` says "after", `parallel:` is the explicit "together" (its steps share
   one slot, so they run side by side even at concurrency 1), and the canvas already draws unordered steps in the same
   column (parallel lanes). Set variable in the CLI matches scripts: scoped writes last for the run (no persistence;
   `testpion run --export-environment` writes them out); in the app they become current values, secret-looking ones
   stored as secrets. Not built: a nested `group:` / `type: finally` block holding steps (the flat `parallel:` /
   `finally:` keys keep every step a plain item of `tests:`, which the canvas, flow-edit and the Arazzo export need).
3. **Record a flow** from the HTTP Debugger: selected exchanges become steps in order, with extracts and dependencies
   found from values that flow from one response into a later request. *Built:* core `runner/flow-from-exchanges.ts`
   (`flowFromExchanges`, `flowFromHar`, `noiseReason`), RPC `debug.createFlow` / `debug.record` in
   `backend/handlers/debugger-flow.ts`, `components/debugger/CreateFlowDialog.tsx` (row menu, the Debugger's Flow menu,
   Record a flow… with a Recording badge, the designer's Record from the Debugger), `testpion flow from-har`, MCP
   `flow_from_exchanges` (`mcp-server/recording-tools.ts`).
4. **Canvas comfort**: sticky notes, coloured group frames, minimap, search, hover preview of the last response, checks
   as you edit (unset variables, unreachable steps, cycles), command palette in the canvas, align and snap. *Built:*
   notes and frames in the file's `layout:` (`notes:`, `frames:`; `layoutExtras` / `frameBoxes` in shared
   `flow-graph.ts`, flow-edit ops `addNote` / `updateNote` / `removeNote` / `addFrame` / `updateFrame` / `removeFrame`,
   frames follow renames and lose removed steps, Auto-arrange keeps both, lint checks them, MCP `flow_annotate`); the
   checks in shared `flowChecks` (mirrors the runner: branch-skipped vs failed, finally steps run whatever happened),
   used by the designer's problems strip, `testpion flow [-e env]`, `flow --json` / `flow_graph` (`checks`) and lint
   (cycles, never-run steps); minimap, Ctrl+F search, hover card (`StepPreview`: CodeBlock + prettyBody), guides and
   snap while dragging, Align / Distribute, all on the one `FlowDiagram`; Ctrl+K canvas commands through
   `lib/palette-context.ts` into the app's CommandPalette; the toolbar folds through `OverflowActions` (ui.tsx, also the
   response bar's). Then (Postman's new-flow screen): a Start node (`StartNode` in `FlowCanvasParts.tsx`: trigger
   menu, inputs as `expose.inputs` or `defaults.vars` through the flow-edit op `setInputs`; steps that wait for nothing
   hang off it), the empty flow's suggestions on the canvas, a block picker at any output port (the app's
   `CommandPalette` with `anchor`, groups and details: blocks, saved requests, sub-flows), toolbar **+ Block**, **Text**,
   **Run flow ▾**, and a Deploy panel (`FlowDeploy.tsx`, RPC `tests.deployStatus`, `flows.webhooks.*`, op
   `setWebhook`). Scale: nodes memoised with stable callbacks, only what is on screen drawn, compact nodes below 0.42
   zoom, the minimap's shapes memoised, `flowChecks` one iterative pass (20000-step chain in the unit tests);
   `_perf-flow-canvas-500` measures open, drag, zoom and hover. Not built: a monitor that runs a test file (Schedule ▸
   Set up opens the monitor editor, which takes collections only), CI for a single file (the CI dialog targets suites).
   *In progress (owner request, after Postman's new-flow screen):* a **Start node** drawn from the file's header
   ("Change trigger": Manual / Schedule → monitor / MCP tool → `expose:` / CI; "+ Add input" edits `expose.inputs` or
   `defaults.variables`), steps without `dependsOn` hang off Start; an **empty flow** shows Start with suggestion
   buttons on curved edges (Add blocks, API example, Create from collection, Record from the Debugger, Generate with
   AI); a **block picker at the port** (click a port, its hover "+", or drop a connection on empty canvas): one search
   box over blocks (Requests, Logic, Data, Flow) and the workspace's saved requests and sub-flows, ↑↓ Enter Esc, the
   chosen block added connected after that port.
   *Deploy (owner request, after Postman's Deploy panel):* a Deploy button and panel listing where the flow runs
   besides a click: Schedule (monitors), Webhook (new `webhook:` key; `testpion serve flows` and in-app serving, POST
   body = inputs, response = `output:`, optional secret), MCP tool (`expose:`), CI. Cloud deploy comes with the cloud work.
5. **Standards and review**: Arazzo 1.0 import and export; git diff of flows by meaning (step added / removed /
   changed, edges changed) in the Git view and pull-request summaries.
6. **Scale**: data-driven runs with a per-row results grid; an environment matrix; a flow as a load-test scenario
   (each virtual user runs the flow); a run timeline report (critical path) shareable as HTML. *Built:* core
   `runner/flow-data-run.ts` (`runFlowOnce`: one run with its own variable copy and cookie jar, no persisted Set
   variable; `runFlowData`: rows streamed from `readDataset` or the file's new `data:` header key, `$row` / `$index`,
   1–32 rows at once, bail, cancel; memory bounded: rows go to `onRow`, the result keeps counts and the first 100
   failing rows), `runner/flow-env-matrix.ts` (`runFlowMatrix`, a context per environment from the host, step
   statuses and outputs that differ), `runner/flow-scale-runs.ts` (`runs/scale/<id>/`: run.json, rows.jsonl +
   steps.jsonl appended as rows finish with an offset index, so a page of 200 rows of 100,000 is 200 small reads;
   full steps kept for failing rows up to 1,000 and the first 100 passing; newest 50 runs kept), `load/flow-load.ts`
   (LoadTarget `flow`: each virtual user runs the flow with its own cookie jar; per-step `perRequest`, `iteration`
   counts / failures / latency; every host through the safeguards), shared `flow-timeline.ts` (`flowTimeline`: lanes,
   waits, what held each step up — its last dependency, for a finally step the last other step, else the step that
   freed its worker — and the critical path; `timelineSvg` / `timelineHtml`, the same picture in the app and the
   self-contained HTML) with core `runner/flow-report.ts` (`runTimeline` of any run, `flowRunTimeline` of a file's
   run); RPC in `backend/handlers/flow-scale.ts` (`tests.dataRun` / `tests.matrixRun` in the background, batched
   `scale.progress`, `scale.finished`, `tests.scaleCancel`, paged `tests.scaleRows`, `tests.scaleRow`,
   `tests.flowTimeline` / `tests.flowTimelineHtml`); UI `FlowScaleGrids.tsx` (`FlowDataGrid`: virtualised, only the
   pages on screen held; `FlowMatrixGrid`; `ScaleRunPanel` in the Tests view's Runs tab), `RunWithDataDialog.tsx`
   (Run with data… / Run in environments…), `RunTimeline.tsx` (the run panel's Timeline tab), the Load view's
   **Test file** target; `testpion test --data / --data-query / --data-limit / --data-concurrency / --env-matrix
   (or -e repeated) / --json`, `testpion load --test-file --think`, `testpion flow report [--run] [--html] [--json]`;
   MCP `flow_data_run`, `flow_env_matrix`, `flow_scale_result`, `flow_timeline` (`mcp-server/scale-tools.ts`) and
   `load_test` `test_file`. Measured: a 10,000-row CSV run (2 steps a row, 16 rows at once, local server) took about
   20 s with the live heap flat (+11 MB at row 5,000, nothing kept after); a page of 200 rows reads in under 10 ms;
   a 1,000-step timeline computes and draws in about 35 ms. The per-request floor is the HTTP client (~0.5 ms a
   request at 16 at once); its timeout error is now made only when a request times out (it was built, with its
   stack, for every request).

