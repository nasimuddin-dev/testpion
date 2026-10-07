---
title: "Test runner"
description: "Run test suites in parallel with bounded concurrency, retries, timeouts, dependencies, setup/teardown, cancellation and resumable runs."
---

::: v-pre

# Test runner

Tests are YAML or JSON files under `tests/`, of type `http`, `graphql`, `grpc`, `websocket` (or `socketio`, `mqtt`), `mcp`, `llm`, `rag` or `agent`. A file can hold one test, a `tests:` list (with `defaults:`), or a dataset template. You don't have to write them by hand: **Save as test** in the REST tab menu and **Test** in the GraphQL, gRPC and WebSocket views save the current request as a test file (the MCP view has **Save as test** too). Suites are `*.suite.yaml` files:

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

An AsyncAPI document (kept in `specs/asyncapi/` by its import) gets realtime tests instead: per channel, its example message sent through the broker or server and read back, checked against the document with the [`asyncapi` check](/api-testing/websocket#check-messages-against-an-asyncapi-document). The suite runs with the servers environment the import made (such as *Clinic events servers*). `testpion tests-from-spec specs/asyncapi/clinic-events.yaml`.

## Execution model

- Tests stream from disk and are never loaded all at once. At most 2× the concurrency is pulled ahead of the workers (**backpressure**).
- **Bounded concurrency:** a semaphore-based worker pool.
- **Retries:** exponential backoff; the attempt count is recorded.
- **Timeout** per test and **cancellation** (Ctrl+C in the CLI, *Cancel* in the UI).
- **Dependencies:** `dependsOn: [id]` waits for other tests. If a dependency does not pass, the dependent test is skipped with a reason.
- **Extraction:** `extract: { token: $.access_token }` sets runtime variables for later tests.
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
