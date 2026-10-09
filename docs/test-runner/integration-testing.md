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
2. **Add steps** with **Add step**: an HTTP request, GraphQL, gRPC, WebSocket, an MCP tool call, an LLM prompt, a **Delay** (a pause, `type: delay` with `ms: 2000`: for a search index or a queue to catch up; **Wait (ms)** in the inspector), or **From a collection…**. With a step selected, the new one goes after it and waits for it.
3. **Connect** two steps by dragging the dot on a step's right edge onto another step: that step gains a `dependsOn` on the first and can use what it extracts as `{{name}}`. A connection that would make a cycle is refused with a message. Click a connection and press <kbd>Delete</kbd> to remove it.
4. **Edit** the selected step in the inspector on the right: its name; for HTTP the method, URL, headers, authorization and body (the request view's editors); the values to **Extract** (variable → JSONPath, with **Pick from the last response** once the flow has run); its **Checks** (the same editor as a request's Tests tab); and the steps it **Waits for**. **Open in editor** shows the step in the YAML.
5. **See the data flow**: a connection is labelled with the variables the first step extracts and the second reads (`{{token}}`). A step that reads a variable no earlier step extracts and the active environment does not define is marked with **!**.
6. **Run**: **Run flow** runs the file; **Run step** runs the selected step with the steps it waits for. The steps light up as their results come in; click a result to open it in **Runs**.
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

The same edits from the command line and for agents, on the same code (comments and line endings kept):

```bash
testpion flow edit rest/checkout.yaml --op '{"op":"addStep","step":{"name":"Health","type":"http","url":"{{baseUrl}}/health"}}'
testpion flow edit rest/checkout.yaml --connect health --to login          # login waits for health
testpion flow edit rest/checkout.yaml --op '{"op":"updateStep","id":"login","set":{"extract":{"token":"$.access_token"}}}' --json
testpion flow edit rest/checkout.yaml --op '{"op":"addFromCollection","collection":"Shop","items":["Checkout"]}'
testpion flow edit rest/checkout.yaml --remove health --dry-run            # print the new text, write nothing
```

`--op` takes one edit or a JSON list of them: `addStep` (`step`, `after`, `at`), `addSteps` (`steps`, `chain`), `updateStep` (`id`, `set`; `null` removes a key; `name` / `id` rename and every `dependsOn` follows), `removeStep`, `renameStep`, `connect` / `disconnect` (`from`, `to`), `setLayout` (`positions`, or `null` to auto-arrange), `duplicateStep`, `addFromCollection` (`collection`, `items`) and `pasteSteps` (`from`, `ids`). The MCP tools `flow_add_step`, `flow_connect`, `flow_disconnect`, `flow_update_step` and `flow_remove_step` do the same for an agent and answer the steps, edges and problems after the change.

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

With the workspace in git, the same job can comment on a pull request with what the branch changes in the tests, by meaning (`testpion diff origin/main HEAD --markdown`); see [Keep your workspace in git](/getting-started/git#in-ci-test-every-pull-request). An OpenAPI document in the repository adds a breaking-change check (`--openapi`).

## Patterns

- **Per-environment data:** keep base URLs and credentials in environments; `-e Staging` in CI, *Development* on a laptop. Secrets are never in the files.
- **Independent flows:** every flow creates what it needs and deletes it at the end; use dynamic values for names so two runs never collide. A `concurrency` of 1 for flows that share records.
- **Contract + integration:** `testpion coverage` after the run says which operations of the OpenAPI document the flows exercised, with `--min` as a gate.
- **Flaky steps:** `retries` in the suite masks them; `flaky_tests` (the app's Runs view, the MCP tool) finds them so they get fixed instead.
- **Data-driven:** a dataset (CSV/JSON) runs a collection once per row (`--data`), for many accounts or inputs.

:::
