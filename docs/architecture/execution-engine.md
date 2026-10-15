---
title: "Execution engine"
description: "How tests are loaded, executed, checked, traced and reported."
---

::: v-pre

# Execution engine

For each test, `executeTest` runs these steps:

1. Clone the variable scope and add request variables.
2. Run the pre-request script in the sandbox.
3. Run the protocol call (HTTP, GraphQL, gRPC, WebSocket, MCP, LLM, RAG or agent) under a timeout and abort signal, recording spans; a flow block (delay, condition, script, sub-flow, log, set, assert) runs its own step instead. A data-changing call to an environment marked as production without the caller's consent is refused here, before anything is sent.
4. Run the test script.
5. Run checks (assertions, evaluators and implicit limits) against a normalised check context.
6. Extract values into runtime variables.
7. Classify the result: an execution exception means `error`, a failed check means `failed`, otherwise `passed`.

`runTests` pulls tests from an async iterator with backpressure, schedules them on a semaphore, handles dependencies with deferred promises, retries with backoff, streams redacted results to JSONL, and aggregates statistics incrementally with exact percentiles.

Every error is normalised to a kind (`NetworkError`, `TimeoutError`, `AuthenticationError`, …) with *what*, *why* and suggested fixes.

:::
