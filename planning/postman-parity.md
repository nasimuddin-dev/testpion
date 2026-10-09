# Postman parity: Toolsets, Datasets, Flow view, flows as MCP tools

Research of 2026-10-08 compared Postman's sidebar (Collections, Environments, Documents, Specs, Mocks, Datasets,
Toolsets, Flows) with TestPion. Collections, Environments, Specs and Mocks are covered. Four additions are worth
building, in this order; a drag-and-drop Flows editor and Documents are left out (see the end).

Every feature follows the house rules: one shared component per UI pattern; AI-first (a CLI command with `--json`,
an MCP tool, a docs page); cloud-ready (UI only through RPC); an e2e plan and unit tests.

## 1. Toolsets: design an agent's tools on the MCP mock

Postman's toolset is a named group of tool definitions (name, description, input schema), each answered by a mock or a
short script, served as a real MCP server so an agent harness can be tried against it before the backend exists.
TestPion's MCP mock (`*.mcp-mock.yaml`, `packages/core/src/mcp-server/mcp-mock.ts`, served by `testpion mock-mcp`)
already is that server; what it lacks is the design surface.

- **Tools tab** on an MCP server whose transport is *Mock*: the mock file's tools as a list; a form per tool (name,
  description, input schema as JSON with the editor, responses: `when` arguments, text / JSON answer, `isError`, or a
  **script** `(args) => result` run in the sandbox); add, duplicate, delete, reorder; **Try** calls the tool with a
  generated form; the YAML stays the source of truth (Save writes it, the file tab edits it raw).
- **Script answers**: `script:` on a response, run with the same sandbox as test scripts, `args` in scope, returns
  text or an object. Core: `mockToolResult` runs it.
- **Serve** from the tab: the stdio command line and the HTTP URL to paste into an agent's configuration, copied in one
  click (the CLI already serves it).
- **Generate with AI**: a toolset from a sentence (assistant task `design-toolset`), reviewed before saving.
- CLI: `testpion mock-mcp <file> --list --json` prints the tools; MCP: `mock_tools` lists a mock's tools.
- Docs: `docs/mcp/mocking.md` gains "Design a toolset".

## 2. Datasets in the sidebar

Datasets exist as files in `datasets/` (JSON, JSONL, CSV, Markdown) and as database queries (SQLite, Postgres,
MySQL), used by tests and the Collection Runner. They have no place in the sidebar.

- **Datasets** section in the Collections sidebar under API definitions: every file in `datasets/`, with its format and
  row count; `+` creates one (empty CSV/JSONL, or **Generate test data…** which exists), a row's menu has *Run a
  collection with it*, *Rename*, *Duplicate*, *Delete*.
- A dataset opens in a tab: a preview table (first 200 rows, column types), the raw file in the editor (the data
  languages), row and column counts, **Run a collection with this dataset** (opens the Collection Runner with the
  dataset chosen), **Use in a test** (copies the `dataset:` YAML).
- CLI `testpion datasets` already lists; add `testpion datasets show <name> --json` (rows, columns). MCP:
  `list_datasets`, `read_dataset` (first N rows).
- Docs: `docs/test-runner/datasets.md` gains the sidebar and the tab.

## 3. Flow view: an integration flow as a diagram

A flow is a test file whose steps chain with `dependsOn` and `extract`. A read-only diagram makes it readable; the
YAML stays the source of truth (editable on the canvas later, if used).

- Tests view: a **Flow** tab beside Editor and Runs for a file whose steps use `dependsOn` (or any file: one node per
  step, in file order when nothing depends). Nodes: step name, type badge, method and URL for HTTP, the values it
  extracts; edges from `dependsOn`; layered left-to-right layout (longest-path layering, barycentre ordering), SVG,
  pan and zoom, fit.
- After a run: nodes coloured by the latest result (passed, failed, error, skipped), duration on the node, click a node
  opens the step in the editor (the line) and its result in the run panel.
- Shared: the diagram is one component (`FlowDiagram`) so a suite's files, or a collection's folder order, can use it
  later.
- CLI: `testpion flow <file> --json` prints the nodes and edges (and `--dot` for Graphviz); MCP: `flow_graph`.
- Docs: `docs/test-runner/integration-testing.md` gains "See a flow".

## 4. A flow as an MCP tool

Postman deploys a flow as an MCP server. TestPion's MCP server already runs tests; it can expose chosen flows and
suites as tools an agent calls by name.

- A test file or suite gains `expose: { tool: checkout_flow, description: …, inputs: [customerId, …] }` (inputs are
  variables the flow reads; each becomes a tool argument, with `default` and `description`).
- The MCP server lists one tool per exposed flow (`flow_tools.ts`, outside the 1500-line `testpion-mcp.ts`): calling
  it runs the flow with the arguments as runtime variables and the chosen environment, and returns the summary
  (passed/failed/error per step, extracted values, the run id) with `isError` when a step failed.
- App: in the Tests view a file's menu has **Expose as MCP tool…** (a dialog for the name, description and inputs
  that writes the `expose:` block); Settings ▸ AI agents lists the exposed flows.
- CLI: `testpion flows --json` lists exposed flows; `testpion run` already runs them.
- Docs: `docs/ai-testing/mcp-server.md` gains "Your flows as tools".

## Left out, on purpose

- A drag-and-drop Flows editor: large; the Flow view shows whether people want it.
- Deploying to a cloud (webhook and schedule triggers): belongs to the cloud phase (`planning/cloud-platform.md`).
- Documents (free-standing Markdown pages): little value next to request and collection docs.
