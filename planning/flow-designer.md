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
   environment / collection / global scope); Assert (checks only).
3. **Record a flow** from the HTTP Debugger: selected exchanges become steps in order, with extracts and dependencies
   found from values that flow from one response into a later request.
4. **Canvas comfort**: sticky notes, coloured group frames, minimap, search, hover preview of the last response, checks
   as you edit (unset variables, unreachable steps, cycles), command palette in the canvas, align and snap.
5. **Standards and review**: Arazzo 1.0 import and export; git diff of flows by meaning (step added / removed /
   changed, edges changed) in the Git view and pull-request summaries.
6. **Scale**: data-driven runs with a per-row results grid; an environment matrix; a flow as a load-test scenario
   (each virtual user runs the flow); a run timeline report (critical path) shareable as HTML.
