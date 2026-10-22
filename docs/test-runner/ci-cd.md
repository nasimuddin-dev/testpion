---
title: "CI/CD integration"
description: "Run TestPion tests in GitHub Actions, GitLab CI, Azure DevOps and Jenkins."
---

::: v-pre

# CI/CD

```bash
testpion test ./tests                      # nearest workspace.json is used
testpion run --workspace veterinary-api --environment staging --suite regression
testpion run-collection "Veterinary API" -e Staging          # a collection, like Newman
```

### Coming from Newman

`run-collection` takes Postman collection and environment files directly and uses Newman's option names, so most pipelines only need the command changed:

```bash
# before
newman run api.postman_collection.json -e staging.postman_environment.json -d data.csv -n 2 --folder Smoke --reporters cli,junit
# after
testpion run-collection api.postman_collection.json -e staging.postman_environment.json -d data.csv -n 2 --folder Smoke -r console junit -o results
```

The other direction works too. If part of a team or pipeline stays on Newman, `testpion export "My API" -o api.postman_collection.json` and `testpion export-environment Staging -o staging.postman_environment.json` produce files Newman runs.

**Exit codes:** `0` success · `1` test failure · `2` configuration error · `3` execution error (e.g. cancelled).

**Secrets:** supply them through the CI secret store as environment variables:

- `TESTPION_SECRET_ENV_<ENV>_<KEY>` for environment secrets
- `TESTPION_SECRET_PROVIDER_<ID>_APIKEY` for provider keys
- or reference `{{$env.NAME}}` directly

## Generate a pipeline

TestPion writes the pipeline file for you, like Postman's *Run in CI*. It works for **GitHub Actions**, **GitLab CI**, **Azure Pipelines** and **Jenkins**, and can run a suite, a collection (or some of its folders), or all tests.

- **In the app:** choose **Run in CI…** in the ⋯ menu at the top of the **Tests** list, right-click a collection and choose **Run in CI…**, or use the command palette (**Run in CI (GitHub Actions, GitLab, Azure, Jenkins)…**). Choose the CI system, what to run, the environment, and where the workspace folder is in your repository. **Try it here first** shows the same run as a command on this computer, with **Copy** and **Run in terminal**. Then **Copy** the file or **Save** it.
- **From a run:** a run's ⋯ (the results header in **Tests** or the Collection runner) has **Run in CI…**, the dialog preselected with what the run ran (its test files with their name and tag filter, or its collection and the folders and requests it picked) and its environment, and **Copy CLI command**, the `testpion` command that runs it again from a terminal. The command palette has both for the last run (**Run last run in CI…**, **Copy CLI command of last run**). From a terminal: `testpion ci github -w . --run <runId|last>`; agents: `ci_config` with `runId`.
- **From a flow:** in the flow designer, **Deploy** ▸ **CI** ▸ **Set up…** opens the dialog for that one file. Under **Run the flow** pick **once**, **once per data row** (the file's own `data:` or a dataset) or **in several environments**, and tick **Keep the run as an HTML timeline** to keep `test-results/timeline.html`, also when the run fails. See [Run a flow at scale](/test-runner/integration-testing#run-a-flow-at-scale).
- **From the terminal:** `testpion ci <github|gitlab|azure|jenkins>`

  ```bash
  testpion ci github -w . --suite regression -e Staging -o .github/workflows/testpion.yml
  testpion ci gitlab -w api-tests --collection "My API" --folder Smoke -e Staging --workspace-dir api-tests
  testpion ci github -w . --run last                     # what the latest run ran, in its environment
  testpion ci github -w . --tests rest/checkout.yaml --data datasets/users.csv -e Staging --timeline-html
  testpion ci github -w . --tests rest/checkout.yaml --env-matrix Development Staging
  testpion ci azure -w . --json          # .data: { provider, path, content, secrets, command, localCommand }
  testpion ci github -w . --suite regression --openapi api/openapi.yaml   # also check the spec on pull requests
  ```

  `--data` (without a file: the flow's own `data:`), `--env-matrix` and `--timeline-html` take exactly one flow file in `--tests`, and `--data` and `--env-matrix` don't mix.

- **AI agents:** the `ci_config` tool of the [MCP server](/ai-testing/mcp-server).

The pipeline does four things:

1. Installs the TestPion CLI from its GitHub repository, pinned to your TestPion version (for example `v0.51.0`), so runs are reproducible.
2. Runs the tests with the `console`, `junit` and `html` reports.
3. Publishes `junit.xml` as test results, where the CI system supports it.
4. Keeps the reports as build artifacts.

A flow run once per data row or in several environments keeps its rows in `test-results/data-run.json` (or the matrix in `env-matrix.json`) instead of the plain reports. These files are the CLI's [JSON envelope](/cli/reference#json-output-dry-runs-and-scripts): the generated pipeline only archives them, and a step of your own that reads them reads `.data` (`jq '.data.summary' test-results/data-run.json`).

With an **OpenAPI document** (`--openapi`, or the field in the dialog), pull requests also compare the document with the target branch's version and fail on [breaking changes](#catch-breaking-api-changes).

A failing test fails the build. The file never contains secret values. Instead, TestPion lists the **CI secrets to create**, such as `TESTPION_SECRET_ENV_STAGING_APIKEY` for the *Staging* environment's secret `apiKey`, and the pipeline passes them to the CLI.

### Pipelines against production

**Scripts and secrets in a pipeline.** A workspace's scripts do not see secret variables, and can only send requests to the host of their own request, unless the run says otherwise ([Trust and permissions](/security/trust)). A pipeline whose scripts need them (an HMAC signature from a secret, a login call to another host) tick **Allow scripts to read secrets and call other hosts in this pipeline** in the CI dialog (it is off by default), or pass `--trust-scripts` to `testpion ci …`, `trustScripts: true` to `ci_config`, or `trust-scripts: true` to the GitHub Action. The generated run line then carries `--trust-scripts`. Do this only for a repository you trust: every script in it can then read the pipeline's secrets.

A pipeline that runs against an environment marked as [production](/api-testing/environments#production) runs its reads (GET, HEAD, OPTIONS, GraphQL queries, gRPC reads), but every data-changing step fails with *"… is a production environment: POST … needs confirmation"* unless the run line has `--allow-production` (`testpion test`, `run`, `run-collection`, `send`, `load`, `eval run`, `serve flows`, `monitor add / run / start` and `ai attempt-fix` take it). So a smoke run against production needs nothing. For a pipeline that has to write, tick **Allow data-changing requests to the production environment** in the CI dialog (it shows, for any suite, collection or test files, when the environment is marked production), run `testpion ci … --allow-production`, or pass `allowProduction: true` to `ci_config`; the GitHub Action takes `allow-production: true`.

## Integration tests: start the system first

`--start "<command>"` and `--wait-for <health URL>` make the pipeline start the system under test in the background and wait until it answers before the tests run; `testpion wait-for <url>` does the waiting in any pipeline. See [Integration testing](/test-runner/integration-testing) for the flow pattern, the suite and the reusable GitHub Action.

## By hand

From version 0.44.0 the CLI is on npm, so a pipeline can run it with `npx`; pin the version:

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: npx testpion@0.51.0 run -w . --suite regression -e Staging -r console junit html -o test-results
```

The generated files still install the CLI from the repository, which works for any version:

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: git clone --depth 1 --branch v0.51.0 https://github.com/nasimuddin-dev/testpion.git "$RUNNER_TEMP/testpion" && cd "$RUNNER_TEMP/testpion" && npm ci && npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli
- run: node "$RUNNER_TEMP/testpion/packages/cli/bin/testpion.js" run -w . --suite regression -e Staging -r console junit html -o test-results
  env:
    TESTPION_SECRET_PROVIDER_OPENAI_APIKEY: ${{ secrets.OPENAI_API_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: test-results, path: test-results }
```

To run a collection instead, use `run-collection "My API" -w . -e Staging -r console junit -o test-results`. For GitLab, Azure DevOps and Jenkins, publish `test-results/junit.xml` with `reports: junit`, *PublishTestResults* or the `junit` step.

**Explain the failures in the log:** add `--triage` to the run line. After a run with failures, TestPion groups them by likely cause and, with an AI model set up for the job (`TESTPION_AI_PROVIDER` and its key, or a model on the runner), explains each with evidence and a verified fix; it writes `test-results/triage.md` and `triage.json` and adds a *Triage (AI)* section to the JUnit, HTML and Markdown reports. The exit code stays the run's. With the GitHub Action, `triage: true` adds `--triage` and shows the failure triage from `triage.md` in the job summary beside the run's Markdown report. See [Explain the failures in the job](/test-runner/integration-testing#explain-the-failures-in-the-job).

## API coverage

`testpion coverage` compares a run with the API's OpenAPI document. It shows which operations were called and which documented responses were seen: a `404` for an unknown id, a `401` without a token and so on. It also lists operations nobody tested. With `--min` it becomes a gate that fails the build when coverage drops:

```yaml
# GitHub Actions, after the tests ran in the workspace
- run: node "$RUNNER_TEMP/testpion/packages/cli/bin/testpion.js" coverage specs/api.yaml --min 80 --markdown coverage.md
- run: cat coverage.md >> "$GITHUB_STEP_SUMMARY"
  if: always()
```

```text
  ✓ GET    /health  seen 200
  ◐ GET    /patients  seen 200 · not seen 401, 403
  ✗ DELETE /patients/{id}  not seen 204, 404

83.3% of operations covered (5/6) · 35.7% of documented responses seen (5/14) · minimum 80%
```

In the app, open **API coverage** from a finished run, an API definition's **Coverage** tab or the command palette; *By tag* shows how many operations of each tag were called, least covered first. **Suggest tests with AI** drafts tests for the gaps for you to review. AI agents get the same report from the `api_coverage` MCP tool.

## Catch breaking API changes

`testpion openapi-diff` compares two versions of an OpenAPI / Swagger document and lists what can break existing clients: removed operations or success responses, new required parameters or body fields, changed types, response fields that were removed or became optional, and request enums that lost a value. Additions (new operations, optional parameters, response fields) are listed as other changes. With `--fail-on-breaking` it exits `1` when something breaks, so a pull request that changes the spec can be checked against the main branch:

```yaml
# GitHub Actions, after the install step above
- run: git show origin/main:openapi.yaml > "$RUNNER_TEMP/openapi.main.yaml"
- run: node "$RUNNER_TEMP/testpion/packages/cli/bin/testpion.js" openapi-diff "$RUNNER_TEMP/openapi.main.yaml" openapi.yaml --fail-on-breaking
```

```text
4 → 5 operations (1 added, 0 removed)

2 breaking changes:
  ✗ GET /pets: query parameter "limit" is now required
  ✗ GET /pets/{id} response 200 owner: was always returned, now optional
```

Either side can be a file or an http(s) link. `--json` prints the result for scripts, and AI agents get the same through the MCP tool `openapi_diff`. In the app, open the command palette (**Ctrl+K**) and choose **Compare OpenAPI versions**: each side can be a document kept in the workspace (`specs/`, where imports put them), a link or a file.

## Lint API definitions

`testpion openapi-lint` checks OpenAPI / Swagger documents for mistakes that break tools and clients, and for gaps that make an API hard to use. It exits `1` on errors, so a pipeline can stop a broken spec before it is published:

```yaml
- run: npx testpion@0.51.0 openapi-lint specs/ --fail-on error
```

```text
specs/clinic.yaml: 12 operations, 2 errors, 1 warning, 3 notes
  specs/clinic.yaml:41:9   error   {petId} is in the path but not declared as a path parameter  path-param-undeclared
  specs/clinic.yaml:88:11  error   operationId "getPet" is also used by GET /pets/{id}  operation-id-unique
  specs/clinic.yaml:102:13 warning The example does not match its schema: /weight must be number  example-valid
```

| Level | Rules |
|---|---|
| Errors | `syntax`, `info` (title and version), `ref-unresolved`, `path-ambiguous` (`/pets/{id}` and `/pets/{petId}`), `path-param-undeclared`, `path-param-unused`, `path-param-required`, `parameter-duplicate`, `operation-id-unique`, `operation-responses`, `security-scheme-defined` |
| Warnings | `example-valid`, `operation-id`, `operation-success-response`, `response-schema`, `request-body-on-get`, `path-trailing-slash`, `server-not-https` |
| Notes | `operation-summary`, `operation-tags`, `servers`, `component-unused` |

`--disable` leaves rules out and `--fail-on warning` makes warnings fail the build too. In the app, an API definition's **Lint** tab lists the problems, marks them in the editor as you type, and a click shows the place; **How to fix (AI)** asks the assistant for the changes. Agents use the MCP tool `openapi_lint`.

## Fuzz an API

`testpion fuzz` sends each operation of an OpenAPI document its valid example, then requests that break one rule of the schema at a time: a required field left out, a wrong type, a value outside its enum, range, length or format, a body that isn't JSON, a path or query parameter of the wrong type. What comes back shows the bugs plain tests miss:

| Finding | Meaning |
|---|---|
| Server error | The API answered 5xx to that input: an unhandled case. `testpion fuzz` exits `1` on these. |
| Invalid input accepted | A 2xx for input the document forbids: validation is missing, or the document is wrong. |
| Undocumented status | A status the operation's responses don't list. |
| Not authorized | The valid example got 401 or 403, so the variants weren't judged: give the token. |

```bash
testpion fuzz specs/clinic.yaml --base-url http://localhost:3000 -e Development
testpion fuzz specs/clinic.yaml --base-url http://localhost:3000 --var accessToken=$TOKEN --markdown fuzz.md
```

These are real requests, and some create or change data. So fuzzing runs only against local or private-network hosts unless `--allow-remote`, never with a production environment, and leaves DELETE out unless `--include-delete`. Run it against a local or test copy of the API, for example in an integration pipeline after `--start` and `--wait-for`. `--fail-on server-error,accepted-invalid` makes accepted invalid input fail the build too, `--operation "POST /patients"` narrows it, and `--json` prints the report.

**Save the findings as tests** so a fix stays checked: `--save-tests` (or **Save as tests** in the app) writes each server error and accepted invalid input to `tests/<api>/fuzz-findings.yaml` as a test that expects a 4xx. They fail until the API is fixed, then guard against the bug coming back.

In the app, an API definition's **Fuzz** tab does the same with the active environment, groups the findings, opens any request as a tab, and **Explain and fix (AI)** asks the assistant what is wrong and where to fix it. Agents use `api_fuzz` (local hosts only).

:::
