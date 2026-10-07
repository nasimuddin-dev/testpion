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

Dynamic values (`{{$randomFirstName}}`, `{{$randomInt}}`, `{{$guid}}`) keep records unique when flows run in parallel or again. A `testScript` with `pm.test` covers what assertions can't say in one line (see [Assertions](/test-runner/assertions)). GraphQL, gRPC, WebSocket and MCP steps mix into the same file (`type: graphql` …).

The same flow can live in a **collection** (requests with pre-request and post-response scripts, `pm.variables.set` to pass values along) and run with `testpion run-collection`; the collection runner in the app runs it with a data file for many iterations.

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
