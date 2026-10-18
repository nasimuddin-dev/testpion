---
title: "Load testing"
description: "Load test HTTP endpoints, whole collections and LLM providers with virtual users, ramp-up, rate limits and safeguards."
---

::: v-pre

# Load testing

Configure virtual users, duration, ramp-up and ramp-down, a global requests-per-second cap, and think time. The results include throughput, p50/p90/p95/p99 latency, error rate, status code distribution and connection failures, the server time (time to first byte, p50 and p95) and connections (how many requests opened a new one and its average set-up time, or reused one; mostly new connections means the server does not keep them alive), with live charts: requests per second, p95 latency, errors per second and virtual users over time (one crosshair across all four; hover for the values at that second) and a status-code bar with counts and shares.

Every finished load test is kept in the workspace (`runs/load/history.jsonl`, the newest 500): under the results, *Earlier load tests* shows the p95 latency and throughput of the last runs as trends and lists them with virtual users, requests per second, p95, error rate and whether the pass rules held; click a run to compare the others with it (change in requests per second and p95, green when better). With a saved load test open, only its runs are shown. AI agents read the same history with the `load_history` MCP tool; `load_test` runs, and `testpion load` runs in a workspace (`-w`, `--saved` or `--collection`), are recorded too.

LLM targets also report tokens per second, input and output tokens, estimated cost, time to first token, time between tokens and total generation time.

**Save the results.** The down arrow at the right end of the results' bar saves them as JSON (the configuration, the pass rules and every number); its **▾** has CSV tables (per request, or per step for a flow, status codes, per second), one self-contained HTML page with all the tables, and Markdown. See [Save and export results](/getting-started/save-and-export-results).

**Environment:** the **Environment** field picks what a load test runs against ([the same picker everywhere](/getting-started/finding-your-way#the-environment-the-same-way-everywhere), **PRODUCTION** in red); it starts on the active environment. The result's header shows the environment the run used as a badge, and `testpion load --json` / `load_test` name the `environment`.

**Safeguards:** by default, only localhost and private-network hosts can be targeted. Remote hosts require an explicit opt-in (**Allow remote hosts**, `--allow-remote`) and a confirmation. A load test against an environment marked as production asks first, with the same question as every send and run ([Production](/api-testing/environments#production)): the Load view no longer has a production switch of its own. From the terminal it needs `--allow-production` for data-changing requests. The number of virtual users is capped in Settings. Only load test systems you own or are authorised to test.

```bash
testpion load http://127.0.0.1:4010/health --vus 50 --duration 30 --ramp-up 5
```

## Saved load tests

**Save** (next to the title; `Save*` when there are changes) keeps the whole configuration: the target, headers and body, users, duration, ramp-up and ramp-down, rate limit, think time and pass/fail rules. It appears under **Saved** in the sidebar, where you can group load tests in folders and right-click one to **Run** it again. Load tests open in tabs like requests, each with its own unsaved changes: a single click in **Saved** opens a preview tab (its name in italics) that the next click replaces, a double-click keeps it, and the first line of the view says where it is (*Load tests › folder › name*). Saved load tests are kept in the workspace file `library/load-tests.json`. Run one from a terminal or CI by name; options you type there win over the saved ones, and `{{variables}}` resolve from the `-e` environment:

```bash
testpion load --saved "Health smoke" -e Staging --duration 30
```

## A whole collection

Choose **Collection** as the target in the **Load** view (or `testpion load --collection`) to load-test a user journey instead of one endpoint: every virtual user sends the collection's HTTP and GraphQL requests in order, again and again, like Postman's performance tests. Pick the whole collection or one folder.

- **Auth and variables:** the collection's auth inheritance applies, and variables come from the environment picked in the **Environment** field. They are resolved once, before the load starts.
- **Warm-up:** scripts don't run under load (they would measure the script sandbox rather than the API). Turn on **Run it once first with scripts** (`--warm-up`) to run the selection once like the Collection Runner: values its scripts set, such as a login token, are then used by the load test. Variables that are still undefined are listed.
- **Cookies:** each virtual user keeps its own cookies, so a *log in → use the session → log out* sequence works for every user.
- **Results:** besides the totals, a **Per request** table shows each request's count, errors and p50/p95/p99, and how many passes through the collection were made.

```bash
testpion load --collection "Veterinary API" -w . -e Staging --folder Patients --warm-up --vus 20 --duration 60
```

## A gRPC method

Choose **gRPC method** as the target (or `testpion load <server> --grpc <method>`) to load-test a unary or server-streaming method: give the server (`localhost:50051`, `grpcs://host:443` for TLS), the method (`package.Service/Method`), the message as JSON and optional metadata. The methods come from the server through reflection (or `--proto` files in the CLI). Each virtual user calls the method again and again over one HTTP/2 connection; results count gRPC status codes (`OK`, `NOT_FOUND` …), and anything other than `OK` is an error.

```bash
testpion load localhost:50051 --grpc vet.v1.PetService/GetPet -d '{"id":"1"}' --vus 20 --duration 30 --threshold "p95<50"
```

## A flow as the scenario

Choose **Test file (a flow)** as the target (or `testpion load --test-file <file>`) to put a whole flow under load: every virtual user runs the flow file again and again, steps in their order with their dependencies, extracted values, checks and blocks, each user with its own variables and cookies (a login step logs each user in). Users, duration, ramp up / down, the request rate (one run of the flow at a time per token) and think time (`--think <ms>`, between runs) work as for other targets, and every host a step sends to goes through the safeguards first.

The results count every step as a request: **Per step** lists each step's requests, errors and p50 / p95 / p99, and the header says how many runs of the flow there were, how many failed and how long a run took (p50 / p95). Rules can name a step: `p95[Create order]<400`.

```bash
testpion load --test-file rest/checkout.yaml -w . -e Staging --vus 20 --duration 60 --ramp-up 10 --think 500 --threshold "errors<1%" "p95[Pay]<800"
```

AI agents use `load_test` with `test_file`. See also [Run a flow at scale](/test-runner/integration-testing#run-a-flow-at-scale).

## Pass or fail (thresholds)


Give rules that decide whether the test passed, like k6 thresholds. They're checked on the final numbers: in the **Load** view under **Pass if** (a green or red summary with each rule's actual value), and with `--threshold` in the CLI, which exits with 1 when a rule fails (so a CI job fails on a slow build):

```bash
testpion load http://127.0.0.1:4010/health --vus 20 --duration 30   --threshold "p95<300" "errors<1%" "rps>=100"
testpion load --collection "Veterinary API" -w . --threshold "p99[Get patient]<800" --json load.json
```

| Rule | Meaning |
|---|---|
| `p50`, `p90`, `p95`, `p99`, `avg`, `min`, `max` `< 500` | Latency in ms (`1s` works too). |
| `errors<1%` / `error_rate<1%` | Share of failed requests; `errors<5` is a count. |
| `rps>=50`, `requests>=1000` | Throughput and total requests. |
| `ttft_p95<800`, `tokens_per_sec>=20` | LLM targets. |
| `p95[Get patient]<400` | One request of a collection. |

Operators: `<`, `<=`, `>`, `>=`. A rule for a number the test didn't produce fails. Without thresholds, the CLI fails when more than 5% of requests failed. The `--json` file and the `load_test` MCP tool (`thresholds: [...]`) include each rule's result.

:::
