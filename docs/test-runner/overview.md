---
title: "Test runner"
description: "Run test suites in parallel with bounded concurrency, retries, timeouts, dependencies, setup/teardown, cancellation and resumable runs."
---

::: v-pre

# Test runner

Tests are YAML or JSON files under `tests/`, of type `http`, `graphql`, `grpc`, `websocket` (or `socketio`, `mqtt`), `mcp`, `llm`, `rag` or `agent`, and the flow blocks: `delay` (a pause between the steps of a flow), `condition` (an `if:` with true and false branches), `script` (tp.* code, no request), `flow` (another test file run as one step) and `log` (a message in the results). A file can hold one test, a `tests:` list (with `defaults:`), or a dataset template. You don't have to write them by hand: **Save as test** in the REST tab menu and **Test** in the GraphQL, gRPC and WebSocket views save the current request as a test file (the MCP view has **Save as test** too). Suites are `*.suite.yaml` files:

```yaml
name: Regression
tests: [rest, graphql, mcp, ai]
setup: [rest/auth.yaml]
teardown: [rest/cleanup.yaml]
concurrency: 8
retries: 1
environment: Staging
```

## Writing test files in the app

The editor (Tests view) knows the format: keys complete with a line of help (the keys of the test's type, the checks' keys with every check type, `dependsOn` with the ids of the file), hovering a key explains it, and mistakes get a marker a moment after you type: an unknown `type`, an unknown check type, a key the runner does not read (with the key you probably meant), a `dependsOn` nobody defines. The same checks run from the terminal with `testpion lint-tests` (exit 1 on errors, `--json` for scripts) and for AI agents through the `lint_tests` tool, so a pull request can be checked before the tests run.

## A first suite from an API definition

An API definition's **Preview ▸ Generate tests** writes a test file per tag under `tests/<api>/` and a suite, `tests/<api>.suite.yaml`. Each operation gets two tests:

- its example request, checked for the documented success status, the [OpenAPI contract](/test-runner/assertions#openapi-contract-testing) and a latency under 2 seconds;
- one invalid request (a required field left out, a wrong type, a path parameter that isn't a number …) that must get a 4xx.

Requests use `{{baseUrl}}` and the auth variables an import uses (`{{accessToken}}`). The example values (ids, bodies) come from the document, so look at them before trusting the results. Files that exist are kept. From the terminal, `testpion tests-from-spec specs/clinic.yaml`; agents use `generate_tests`.

### An integration suite from an API definition or a collection

**Generate tests ▸ Integration flows** (in a definition's Preview, or **Export ▸ Integration flows** on a collection) writes one flow per resource the API creates, under `tests/<api>/flows/`: create it, read it back (`equals $.id`), update it, see it listed, delete it and see it gone (404), each step depending on the one before, the created id flowing between them through `extract` and `{{variables}}`. A login operation (`POST /auth/token`, `/login` …) becomes the first step and saves `{{accessToken}}`; names get a `{{$randomInt}}` so the flow runs again. `tests/<api>-integration.suite.yaml` runs them all. A collection goes through the OpenAPI document made from it, so its saved examples say what a created record looks like.

The result names the environment variables the flows read (`baseUrl`, `clientId`, `clientSecret` or `username`, `password`; a parent id for nested paths). Set them, review the bodies, then `testpion run --suite <api>-integration -e <environment>`. Terminal: `testpion integration-suite specs/clinic.yaml` or `testpion integration-suite "Clinic API"`; agents: `generate_flows`. See [integration testing](/test-runner/integration-testing) for what a flow is made of.

An AsyncAPI document (kept in `specs/asyncapi/` by its import) gets realtime tests instead: per channel, its example message sent through the broker or server and read back, checked against the document with the [`asyncapi` check](/api-testing/websocket#check-messages-against-an-asyncapi-document). The suite runs with the servers environment the import made (such as *Clinic events servers*). `testpion tests-from-spec specs/asyncapi/clinic-events.yaml`.

## Execution model

- Tests stream from disk and are never loaded all at once. At most 2× the concurrency is pulled ahead of the workers (**backpressure**).
- **Bounded concurrency:** a semaphore-based worker pool.
- **Retries:** exponential backoff; the attempt count is recorded.
- **Timeout** per test and **cancellation** (Ctrl+C in the CLI, *Cancel* in the UI).
- **Dependencies:** `dependsOn: [id]` waits for other tests. If a dependency does not pass, the dependent test is skipped with a reason.
- **Extraction:** `extract: { token: $.access_token }` sets runtime variables for later tests.
- **Delay:** `- { name: Wait for the index, type: delay, ms: 2000 }` pauses a flow (for a search index, a queue, an eventually consistent read). `ms` is 0 to 600000 (ten minutes); it honours `dependsOn` like any test, never waits longer than its timeout, stops at once when the run is cancelled, and passes with its duration and no request or trace payload.
- **If:** `if: "status == 200 && {{count}} > 0"` on any step runs it only when the expression is true; else it is skipped with the reason, and so are the steps that wait only for it. The expression is JavaScript comparisons and `&&` `||` `!` over `status`, `headers['content-type']`, `$.json.path` (or `body`) of the previous step's response (the last step it waits for, else the one that finished last), `{{variables}}` and `vars.name`. It runs in the script sandbox in a context of its own: no tp API, no network, files, processes or `require`, at most 250 ms.
- **Condition:** `- { id: is-admin, name: Admin?, type: condition, if: "$.role == 'admin'", dependsOn: [me] }` passes and records whether it came out true; the steps that depend on it with `when: true` run on its true branch, those with `when: false` on its false branch, and the branch not taken is `skipped` (`branch not taken: is-admin came out false`), with every step after it that waits only for that branch. A step that waits for both branches (a merge) runs when either ran. A failed or errored condition skips both branches as a dependency that did not pass.
- **Repeat / for each:** `repeat: 3`, `forEach: [{ id: 1 }, { id: 2 }]` or `forEach: { dataset: datasets/users.csv }` (CSV, JSON, JSONL or Markdown, relative to the test file; `limit` caps the rows) runs a step once per row, in order, with the row's fields, `{{$index}}` (0, 1, …) and `{{$item}}` as its variables. The result lists each iteration (`metadata.iterationResults`) with a check *N of M iterations passed*, failing checks prefixed `[#i]`; what the last iteration extracts flows on. At most 10000 iterations; the run's cancel stops between them.
- **Script:** `- { name: Total, type: script, script: "tp.variables.set('total', 2 * {{count}})" }` runs tp.* code with no request (`pm.*` works too): `tp.variables.set` passes values to the steps after it, `tp.test` adds checks, an exception is an error.
- **Sub-flow:** `- { name: Log in, type: flow, file: auth/login.yaml, inputs: { user: "{{user}}" } }` runs another test file (relative to this one, else inside `tests/`) as one step with `inputs` as its variables. The file's `output:` (or, without one, the values it extracted) come back as variables of this flow and as the step's body (`extract: { t: $.token }` works); a step of it that fails fails the step. A flow that runs itself (A → B → A) or nests deeper than five levels is refused with the chain in the error.
- **Log:** `- { name: Show the token, type: log, message: "token {{token}}" }` shows the message (variables resolved, secrets masked) as the step's output in the results.
- **Output:** `output: { token: "{{token}}", orderId: "{{orderId}}" }` at the top of a file declares what the flow returns, resolved after its run: a sub-flow step gets these values, and a flow exposed as an MCP tool returns them as `output` in its result.
- Results are appended to `results.jsonl` as they finish, which also acts as a checkpoint: `--resume <runId>` continues an interrupted run.
- Only aggregates (counts, percentiles, tokens, cost, mean scores) are kept in memory, so runs with a million tests are fine.

## Reports

Every run writes `junit.xml`, `report.json`, `report.html` and `report.md`, containing totals, duration, errors, latency percentiles, AI metrics, tokens, cost estimates, and per-test AI details (prompt, model, input, output, evaluator, score, explanation). The HTML report also has a pass/fail bar, a response-time histogram, the slowest tests and the checks that failed most and, for AI evaluations, the scores of each evaluator (plain SVG and HTML, so it works as a CI artifact). See [assertions](./assertions.md), [datasets](./datasets.md) and [CI/CD](./ci-cd.md).

In the editor, the preview of a test file shows each test's latest result and when it ran (click it to open that run). Select a result and open **History** to see the same test in the latest runs: whether it passed, its time per run (with the median) and the checks that failed, flagged as *flaky?* when the result keeps flipping; click a run to open it. `testpion history test "<name>"` and the `test_history` MCP tool give the same. With no run open, the Runs tab also lists the **flaky tests** of the workspace: those whose result changed two or more times over the latest 30 runs, or that passed only after a retry, each with its latest results as a strip (also `testpion history flaky`, which exits 1 when there are any, and the `flaky_tests` MCP tool).

In the app, a finished run has a **Charts** tab next to its results: how many tests fell in each response-time range (passed and failed), results per test type, the five slowest tests (click one to find it in the results), flaky tests (passed only after a retry), where the time of HTTP and GraphQL requests went (DNS lookup, TCP connect and TLS handshake on new connections, waiting for the server, download; also in the `run_breakdown` MCP tool), the checks that failed most and, for AI evaluations, how the scores of each evaluator spread from 0 to 1 with their mean.

<figure class="aps-screenshot">
  <img src="/images/run-charts.jpg" alt="The Charts tab of a test run: response-time histogram, results by type, evaluator score distributions and the slowest tests" width="1440" height="900" loading="lazy">
</figure>

:::
