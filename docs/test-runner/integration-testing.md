---
title: "Integration testing"
description: "Test whole flows against a running API with TestPion: chained steps, clean-up, suites, running by hand and in CI/CD (GitHub Actions, GitLab, Azure DevOps, Jenkins) with the system under test started first."
---

::: v-pre

# Integration testing

An integration test exercises a real, running system through its API: sign in, create a record, read it back, change it, delete it, and check that every step behaves. TestPion runs such flows from YAML test files or from a collection, by hand from the app or the CLI, and in CI where it can also **start the system under test** and wait for it to be healthy. Results come back as console output, JUnit for the CI system, and an HTML report.

The examples workspace has a complete one: `tests/rest/patient-lifecycle.yaml` in the *Veterinary API (example)* workspace, against the demo API (`node examples/servers/demo-servers.mjs`).

## Generate a flow

TestPion writes a first flow for every resource of an API: in a definition's **Preview**, **Generate tests ▸ Integration flows**; on a collection, **Export ▸ Integration flows**; from the terminal, `testpion integration-suite specs/clinic.yaml` (or a collection name); for agents, `generate_flows`. Each flow is the file described below (create, read back, update, listed, delete, gone), the login first. Review the generated bodies and set the variables it names, then run the suite. See [the test runner](/test-runner/overview#an-integration-suite-from-an-api-definition-or-a-collection).

## Write a flow

A flow is a test file whose steps depend on each other. Three things make it work:

- **`dependsOn`** orders the steps and skips the rest when one fails (a step can depend on several).
- **`extract`** saves parts of a response as variables for the steps after it: `patientId: $.id`.
- **Clean-up at the end**, and checks that it worked, so the flow can run again and leaves nothing behind.

```yaml
# tests/rest/patient-lifecycle.yaml (shortened)
defaults:
  type: http
  dependsOn: auth-token           # from tests/rest/auth.yaml: it saves {{accessToken}}
tests:
  - id: lifecycle-create
    name: Create a patient
    method: POST
    url: "{{baseUrl}}/patients"
    auth: { type: bearer, token: "{{accessToken}}" }
    body: { name: "Lifecycle {{$randomFirstName}}", species: cat }
    extract:
      patientId: $.id
    assertions:
      - { type: status, expected: 201 }
      - { type: header, header: location, expected: /patients/ }

  - id: lifecycle-read
    name: Read it back
    dependsOn: lifecycle-create
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions:
      - { type: equals, path: $.id, expected: "{{patientId}}" }

  - id: lifecycle-delete
    name: Delete it (clean-up)
    dependsOn: [lifecycle-read]
    method: DELETE
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions:
      - { type: status, expected: 204 }

  - id: lifecycle-gone
    name: It is gone afterwards
    dependsOn: lifecycle-delete
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions:
      - { type: status, expected: 404 }
```

Dynamic values (`{{$randomFirstName}}`, `{{$randomInt}}`, `{{$guid}}`) keep records unique when flows run in parallel or again. A `testScript` with `tp.test` covers what assertions can't say in one line (see [Assertions](/test-runner/assertions)). GraphQL, gRPC, WebSocket and MCP steps mix into the same file (`type: graphql` …).

The same flow can live in a **collection** (requests with pre-request and post-response scripts, `tp.variables.set` to pass values along) and run with `testpion run-collection`; the collection runner in the app runs it with a data file for many iterations.

## Group flows into a suite

A suite names the files that belong together and how to run them:

```yaml
# tests/integration.suite.yaml
name: Integration
tests:
  - rest/auth.yaml
  - rest/patient-lifecycle.yaml
  - graphql
  - mcp
concurrency: 1      # flows that share records run one at a time
retries: 0          # a flow should pass as written
environment: Development
```

## Run it by hand

```bash
node examples/servers/demo-servers.mjs &                          # the system under test
testpion wait-for http://127.0.0.1:4010/health                     # until it answers
testpion run -w examples/veterinary-workspace --suite integration -r console junit html -o test-results
```

In the app: **Tests ▸ Runs ▸ Run suite**, or open the file and **Run**. A failed step shows its request, response and the check that failed; **Explain with AI** says why.

## See a flow

Open the file in **Tests** and pick the **Flow** tab: one node per step with its type, method and URL and the names it extracts, an arrow for every `dependsOn`, laid out left to right (a step sits one column after the last step it waits for; steps that depend on nothing share the first column). Drag the background to pan, the wheel zooms, **Fit** shows the whole flow. After a run the nodes carry the latest result (passed, failed, error, skipped) with the step's duration; click a node to jump to the step in the editor, click its result to open it in the run. A dependency nobody defines, or two steps that wait for each other, is listed under the diagram.

The same from the command line and for agents:

```bash
testpion flow rest/patient-lifecycle.yaml            # the steps in columns, with the latest run's results
testpion flow rest/patient-lifecycle.yaml --json     # steps, edges, layers, problems, the run
testpion flow rest/patient-lifecycle.yaml --dot | dot -Tsvg > flow.svg
```

The `flow_graph` MCP tool answers the same JSON (with the DOT) for a file, so an agent can read a flow before it changes one with `flow_add_step`, `flow_connect` and the other flow tools (below) or `write_test_file`.

## Design a flow

The **Flow** tab of a test file is also where you build one, on a canvas (a suite stays a read-only diagram: it names other files). The YAML file stays the only source of truth: every change on the canvas is written to the file at once, keeping its comments, key order and line endings, and the **Editor** tab shows the same text. The CLI, CI, monitors and agents run it unchanged.

1. **Start**: **Tests ▸ + ▸ New flow (designer)** creates `name: …` with `tests: []` and opens the designer. An empty flow offers **Add a step**, **Create from a collection** (one saved request, or a folder's requests in order, each waiting for the one before it, with `extract` suggested for the ids and tokens in their saved example responses) and **Generate with AI** (describe the flow; the assistant writes the YAML, you read it in the assistant and **Review and use this flow** replaces the file, marked as AI-generated; Undo brings the old file back).
2. **Add steps** with **Add step**: an HTTP request, GraphQL, gRPC, WebSocket, an MCP tool call, an LLM prompt, a **Delay** (a pause, `type: delay` with `ms: 2000`: for a search index or a queue to catch up; **Wait (ms)** in the inspector), a **Condition (if / else)**, **For each (loop)**, a **Script**, a **Sub-flow**, a **Log**, **Flow output…**, or **From a collection…**. With a step selected, the new one goes after it and waits for it (after a condition, on its true branch; on the false one when only that is still empty).
3. **Connect** two steps by dragging the dot on a step's right edge onto another step: that step gains a `dependsOn` on the first and can use what it extracts as `{{name}}`. A condition has two dots, **true** and **false**: the step you drop one on runs only on that branch (`when: true` or `when: false`), and its connection is labelled with it. A connection that would make a cycle is refused with a message. Click a connection and press <kbd>Delete</kbd> to remove it.
4. **Edit** the selected step in the inspector on the right: its name; for HTTP the method, URL, headers, authorization and body (the request view's editors); the values to **Extract** (variable → JSONPath, with **Pick from the last response** once the flow has run); its **Checks** (the same editor as a request's Tests tab); and the steps it **Waits for**. Under **Runs**: **Only if** (an `if:` expression), the **Branch** of the condition it waits for, and **Repeat** (once, a number of times, for each row of a list, or of a dataset); the node shows **× 3**. A condition edits its expression and lists its branches, a script its code, a sub-flow its **Flow file** and **Inputs**, a log its **Message**; with no step selected, **Output** edits what the flow returns. **Open in editor** shows the step in the YAML.
5. **See the data flow**: a connection is labelled with the variables the first step extracts and the second reads (`{{token}}`). A step that reads a variable no earlier step extracts and the active environment does not define is marked with **!**.
6. **Run**: **Run flow** runs the file; **Run step** runs the selected step with the steps it waits for. The steps light up as their results come in (the branch not taken shows as skipped); click a result to open it in **Runs**.
7. **Arrange**: drag steps (their places are saved in the file under `layout:`, which only the Flow tab reads), **Auto-arrange** lays them out in columns again, the wheel zooms and **Fit** shows everything. <kbd>Shift</kbd>+click selects several; <kbd>Delete</kbd> removes them (the steps that waited for them no longer do); <kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates; <kbd>Ctrl</kbd>+<kbd>C</kbd> / <kbd>Ctrl</kbd>+<kbd>V</kbd> copy steps to this or another flow; **Undo** / **Redo** (<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>) take back any canvas change.

```yaml
name: Health then echo
tests:
  - id: health
    name: Health
    type: http
    method: GET
    url: http://127.0.0.1:4010/health
    extract:
      status: $.status
    assertions:
      - type: status
        expected: 200
  - id: echo
    name: Echo the status
    type: http
    url: "http://127.0.0.1:4010/health?s={{status}}"
    dependsOn: [ health ]

layout:            # where the designer draws each step; the runner ignores it
  health: [ 0, 0 ]
  echo: [ 284, 0 ]
```

The other blocks, in one flow (each is described under [test types](/test-runner/overview#execution-model)):

```yaml
name: Blocks
output:                       # what the flow returns (sub-flows, flows exposed as MCP tools)
  greeting: "{{greeting}}"
tests:
  - { id: health, name: Health, url: "http://127.0.0.1:4010/health" }
  - { id: up, name: Up?, type: condition, if: "status == 200", dependsOn: [ health ] }
  - { id: say-up, name: Say up, type: log, message: "up", dependsOn: [ up ], when: true }
  - { id: retry, name: Try again, url: "http://127.0.0.1:4010/health", dependsOn: [ up ], when: false }
  - { id: each, name: Each, url: "http://127.0.0.1:4010/health?i={{$index}}", forEach: [ { n: a }, { n: b }, { n: c } ] }
  - { id: calc, name: Calc, type: script, script: "tp.variables.set('greeting', 'hello')" }
  - { id: login, name: Log in, type: flow, file: auth/login.yaml, inputs: { user: "{{user}}" } }
```

The same edits from the command line and for agents, on the same code (comments and line endings kept):

```bash
testpion flow edit rest/checkout.yaml --op '{"op":"addStep","step":{"name":"Health","type":"http","url":"{{baseUrl}}/health"}}'
testpion flow edit rest/checkout.yaml --connect health --to login          # login waits for health
testpion flow edit rest/checkout.yaml --op '{"op":"updateStep","id":"login","set":{"extract":{"token":"$.access_token"}}}' --json
testpion flow edit rest/checkout.yaml --op '{"op":"addFromCollection","collection":"Shop","items":["Checkout"]}'
testpion flow edit rest/checkout.yaml --remove health --dry-run            # print the new text, write nothing
```

`--op` takes one edit or a JSON list of them: `addStep` (`step`, `after`, `at`), `addSteps` (`steps`, `chain`), `updateStep` (`id`, `set`; `null` removes a key; `name` / `id` rename and every `dependsOn` follows), `removeStep`, `renameStep`, `connect` / `disconnect` (`from`, `to`; `connect` from a condition takes `when: true | false`), `setOutput` (`output`, or `null`), `setLayout` (`positions`, or `null` to auto-arrange), `duplicateStep`, `addFromCollection` (`collection`, `items`) and `pasteSteps` (`from`, `ids`). `--connect up --to retry --when false` and `--output '{"token":"{{token}}"}'` are shorthands. The MCP tools `flow_add_step`, `flow_connect` (with `when`), `flow_disconnect`, `flow_update_step`, `flow_remove_step` and `flow_set_output` do the same for an agent and answer the steps, edges and problems after the change.

## Debug a flow

The designer's toolbar has **Debug** and **History**, and each step a right-click menu (also **Debug** in the inspector) with **Run from here**, **Run to here**, **Add breakpoint** (<kbd>F9</kbd>) and **Pin last response**.

- **History** lists the file's runs, newest first: status, when, how long, steps passed and the first failing step. Selecting one colours the canvas with that run's results; selecting a step then shows its request and response (**Input / output**), checks, trace, timing and **Variables** for that run, and **Back to latest** returns to the latest results. Every run records the variables after each step (the ones the run made or changed; each value cut at 4 KB, secrets shown as `[REDACTED]`).
- The **variables timeline** under the result is a slider over the run's steps: at each, every variable's value after the step, the ones it changed highlighted. Moving it selects the step on the canvas.
- **Breakpoints**: a red dot on the step. **Debug** runs the flow one step at a time and pauses before each breakpoint: the canvas marks the step **PAUSED** and the inspector shows the current variables, which you can change for the rest of this run (the environment and the file stay as they are). **Continue** (<kbd>F8</kbd>) runs on to the next breakpoint, **Step over** (<kbd>F10</kbd>) runs the step and pauses before the next one, **Stop** ends the run. A paused step never times out: the pause is before it starts.
- **Run from here** runs the step and every step after it; the steps before it are taken from the run selected in **History** (or the latest run that has them): their variables, their responses (what an `if:` reads), the conditions' branches. **Run to here** runs the step with only the steps it waits for.
- **Pin last response** keeps the step's last response (status, headers and up to 1 MB of the body) and marks the node **PINNED**: runs from the designer answer the step with it instead of calling the API (its result says `pinned response`), so later steps can be worked on without hitting a slow or rate-limited API. **Unpin response** calls the API again. The CLI, CI, monitors and agents never use pins.
- **Replay with this run's data** on a failed run in **History** runs the flow as it is now from that run's first failing step, with the variables and responses it had before it: check a fix on the exact data that failed.

Breakpoints and pins are kept per computer in the workspace's `.local/flows/` folder (git-ignored), never in the YAML. Secret values are not recorded, so a run from here or a replay takes them from the environment.

From the command line and for agents:

```bash
testpion flow runs rest/checkout.yaml                       # the history: status, when, how long, first failing step
testpion flow runs rest/checkout.yaml --run run-ab12 --json # one run's steps with the variables after each
testpion test tests/rest/checkout.yaml --from pay           # pay and the steps after it, seeded from the latest run
testpion run tests/rest/checkout.yaml --from pay --seed-run run-ab12
testpion test tests/rest/checkout.yaml --seed-run run-ab12  # replay run-ab12 from its first failing step
testpion test tests/rest/checkout.yaml --to pay             # pay with only the steps it waits for
```

The MCP tool `flow_runs` answers the history (and, with `runId`, one run's steps and variables); `run_tests` with one file in `paths` takes `from` and `seedRunId` the same way.

## Arazzo workflows: import and export

[Arazzo](https://spec.openapis.org/arazzo/latest.html) is the OpenAPI Initiative's format for API workflows: steps that call OpenAPI operations, pass values from one response to the next and say what success means. TestPion reads and writes Arazzo 1.0, so a workflow written for another tool runs as a flow here, and a flow you built here can be handed to tools that read Arazzo.

**Import.** **Import** in the app (or `testpion import adopt-pet.arazzo.yaml -w my-api`) recognises an Arazzo document by its `arazzo:` key and writes one flow file per workflow under `tests/arazzo/` (never replacing a file: a second import of the same workflow gets `-2`). The OpenAPI documents its `sourceDescriptions` name are looked up next to the Arazzo file and in the workspace (by path, by file name in `specs/`, or as `specs/<source name>.json|yaml`); `--fetch-sources` also downloads the ones given as http(s) links. What becomes what:

| Arazzo | Flow file |
|---|---|
| a workflow | a file `tests/arazzo/<workflowId>.yaml`; its `summary` is the `name:` |
| `steps`, in order | steps, each with `dependsOn` on the one before |
| `operationId` / `operationPath` | `method` and `url` from the OpenAPI document: `{{baseUrl}}` + the path (a second source gets `{{<name>_baseUrl}}`); the document's server URL is noted at the top of the file |
| `parameters` (`in: path / query / header / cookie`) | the path, `params`, `headers`, `cookies` |
| `requestBody` (`payload`, `contentType`, JSON Pointer `replacements`) | `body` (JSON, form fields, or text with its `Content-Type`) |
| `$inputs.petName` | `{{petName}}` |
| `$steps.login.outputs.token` | `{{login_token}}`, with `extract: { login_token: $.access_token }` on step `login` |
| `outputs: { id: $response.body#/id }` | `extract` (`$statusCode` → `$status`; a `$response.header.X` output → a `testScript` line that sets the variable) |
| `successCriteria`: `$statusCode == 200`, `$statusCode >= 200 && $statusCode < 300`, `$response.body#/name == 'Rex'`, `!= null`, `>` `<` `>=` `<=`, header conditions, `jsonpath` and `regex` criteria | checks: `status` (`2xx`), `equals`, `exists`, `not-equals`, `greater-than`, `less-than`, `threshold`, `header`, `regex` |
| `onFailure: [{ type: retry, retryLimit: 2 }]` | `retries: 2` |
| a step with `workflowId` | a sub-flow step (`type: flow`, `file:`, `inputs:`) |
| workflow `inputs` (JSON Schema) | `expose.inputs` (with `default` and `required`), so the flow is also an MCP tool |
| workflow `outputs` | `output:` |

What a flow file cannot say (a `goto` action, `||` conditions, `xpath` criteria, `retryAfter`, a cross-workflow `dependsOn`) is kept as a `# Arazzo, not imported: …` comment on the step and listed in the import summary. An `operationId` whose OpenAPI document was not found becomes a skipped step (`skip: true`) to fill in.

**Export.** Right-click a flow in the **Tests** tree ▸ **Export as Arazzo…**, or:

```bash
testpion flow export arazzo/adoptpet.yaml --arazzo -o adopt-pet.arazzo.yaml -w my-api
testpion flow export checkout.yaml --spec specs/shop.openapi.yaml --json       # { file, document, notes, sources }
```

Each HTTP step is matched by method and path against the OpenAPI document (`--spec`, else the sources an import noted at the top of the file, else the workspace spec that describes most of the flow's requests) and becomes an `operationId` (or an `operationPath` when the operation has none); a request no document describes keeps its request under `x-testpion-request`. `extract` becomes `outputs`, `{{variables}}` become `$steps.<step>.outputs.<name>` or `$inputs.<name>` (and the inputs are listed in the workflow's `inputs`), status, body and header checks become `successCriteria`, `retries` a retry action, and `dependsOn` the step order. Other checks, `if`, `forEach`, scripts and non-HTTP steps go under `x-testpion-*` keys and into the notes. An imported Arazzo document exports back to an equivalent one.

Agents use the MCP tools `import_arazzo` (`text`, `file` or `url`; `fetch_sources`; `dry_run` returns the files without writing them) and `export_arazzo` (`file`, `spec`, `workflow_id`).

## Run it in CI/CD

Integration tests need the system up first. `testpion ci` writes a pipeline that installs the CLI, **starts the system under test**, **waits for its health URL**, runs the suite, fails the build on a failed test and publishes the JUnit and HTML reports:

```bash
testpion ci github -w . --suite integration -e Staging --start "npm start" --wait-for http://127.0.0.1:3000/health -o .github/workflows/api-tests.yml
testpion ci gitlab  -w api-tests --suite integration --start "docker compose up -d" --wait-for http://localhost:8080/health --workspace-dir api-tests
testpion ci azure   -w . --suite integration --start "dotnet run --project src/Api" --wait-for http://localhost:5000/health
testpion ci jenkins -w . --suite integration --start "./gradlew bootRun" --wait-for http://localhost:8080/actuator/health
```

Secret values never go into the file: the command lists the **CI secrets to create** (for example `TESTPION_SECRET_ENV_STAGING_APIKEY` for the *Staging* environment's secret `apiKey`), and the pipeline passes them to the CLI. AI agents get the same file from the `ci_config` MCP tool.

### GitHub Actions in five lines

The repository is also a reusable action:

```yaml
jobs:
  api-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: nasimuddin-dev/testpion@v0.43.0
        with:
          workspace: api-tests
          suite: integration
          environment: Staging
          start: npm start
          wait-for: http://127.0.0.1:3000/health
        env:
          TESTPION_SECRET_ENV_STAGING_APIKEY: ${{ secrets.STAGING_API_KEY }}
```

Inputs: `workspace`, one of `suite` / `collection` (+ `folder`) / `tests`, `environment`, `start`, `wait-for`, `wait-seconds`, `out`, `upload`. The reports are uploaded as the `testpion-results` artifact; `junit.xml` works with any test-report step.

### What a CI run gives you

| File in `test-results/` | For |
|---|---|
| `junit.xml` | The CI system's test tab (GitHub test reporters, GitLab's *Tests*, Azure *PublishTestResults*, Jenkins *junit*) |
| `report.html` | People: every step with its request, response, checks and timing |
| `results.jsonl`, `summary.json` | Scripts and agents; `testpion report` re-generates the other formats from it |

Exit codes: `0` all passed, `1` a test failed, `2` a configuration problem, `3` the run could not execute (the system never answered, for example).

## Pull requests: tests plus what changed

With the workspace in git, the same job can comment on a pull request with what the branch changes in the tests, by meaning (`testpion diff origin/main HEAD --markdown`): for a flow, the steps added, removed, renamed or changed (and which parts), the connections added or removed, and "rearranged" when only the layout moved; see [Keep your workspace in git](/getting-started/git#in-ci-test-every-pull-request). An OpenAPI document in the repository adds a breaking-change check (`--openapi`).

## Patterns

- **Per-environment data:** keep base URLs and credentials in environments; `-e Staging` in CI, *Development* on a laptop. Secrets are never in the files.
- **Independent flows:** every flow creates what it needs and deletes it at the end; use dynamic values for names so two runs never collide. A `concurrency` of 1 for flows that share records.
- **Contract + integration:** `testpion coverage` after the run says which operations of the OpenAPI document the flows exercised, with `--min` as a gate.
- **Flaky steps:** `retries` in the suite masks them; `flaky_tests` (the app's Runs view, the MCP tool) finds them so they get fixed instead.
- **Data-driven:** a dataset (CSV/JSON) runs a collection once per row (`--data`), for many accounts or inputs.

:::
