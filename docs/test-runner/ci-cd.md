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

- **In the app:** click the pipeline icon at the top of the **Tests** view, right-click a collection and choose **Run in CI…**, or use the command palette (**Run in CI**). Choose the CI system, what to run, the environment, and where the workspace folder is in your repository. Then **Copy** the file or **Save** it.
- **From the terminal:** `testpion ci <github|gitlab|azure|jenkins>`

  ```bash
  testpion ci github -w . --suite regression -e Staging -o .github/workflows/testpion.yml
  testpion ci gitlab -w api-tests --collection "My API" --folder Smoke -e Staging --workspace-dir api-tests
  testpion ci azure -w . --json          # { path, content, secrets, command }
  testpion ci github -w . --suite regression --openapi api/openapi.yaml   # also check the spec on pull requests
  ```

- **AI agents:** the `ci_config` tool of the [MCP server](/ai-testing/mcp-server).

The pipeline does four things:

1. Installs the TestPion CLI from its GitHub repository, pinned to your TestPion version (for example `v0.8.0`), so runs are reproducible.
2. Runs the tests with the `console`, `junit` and `html` reports.
3. Publishes `junit.xml` as test results, where the CI system supports it.
4. Keeps the reports as build artifacts.

With an **OpenAPI document** (`--openapi`, or the field in the dialog), pull requests also compare the document with the target branch's version and fail on [breaking changes](#catch-breaking-api-changes).

A failing test fails the build. The file never contains secret values. Instead, TestPion lists the **CI secrets to create**, such as `TESTPION_SECRET_ENV_STAGING_APIKEY` for the *Staging* environment's secret `apiKey`, and the pipeline passes them to the CLI.

## Integration tests: start the system first

`--start "<command>"` and `--wait-for <health URL>` make the pipeline start the system under test in the background and wait until it answers before the tests run; `testpion wait-for <url>` does the waiting in any pipeline. See [Integration testing](/test-runner/integration-testing) for the flow pattern, the suite and the reusable GitHub Action.

## By hand

From version 0.44.0 the CLI is on npm, so a pipeline can run it with `npx`; pin the version:

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: npx testpion@0.44.0 run -w . --suite regression -e Staging -r console junit html -o test-results
```

The generated files still install the CLI from the repository, which works for any version:

```yaml
# GitHub Actions
- uses: actions/setup-node@v4
  with: { node-version: 24 }
- run: git clone --depth 1 --branch v0.8.0 https://github.com/nasimuddin-dev/testpion.git "$RUNNER_TEMP/testpion" && cd "$RUNNER_TEMP/testpion" && npm ci && npm run build -w @testpion/core -w @testpion/cli
- run: node "$RUNNER_TEMP/testpion/packages/cli/bin/testpion.js" run -w . --suite regression -e Staging -r console junit html -o test-results
  env:
    TESTPION_SECRET_PROVIDER_OPENAI_APIKEY: ${{ secrets.OPENAI_API_KEY }}
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: test-results, path: test-results }
```

To run a collection instead, use `run-collection "My API" -w . -e Staging -r console junit -o test-results`. For GitLab, Azure DevOps and Jenkins, publish `test-results/junit.xml` with `reports: junit`, *PublishTestResults* or the `junit` step.

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

:::
