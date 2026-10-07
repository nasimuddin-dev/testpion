---
title: "Assertions reference"
description: "All assertion and evaluator types with options."
---

::: v-pre

# Assertions

In a test file the checks go in an `assertions:` list; `checks:` works too.

All checks share `type`, an optional `name`, and usually `path` (JSONPath such as `$.data.items[0].id`) and `expected`.

| Type | Options |
|---|---|
| `status` / `http-status` | `expected`: `200`, `"2xx"`, `[200, 201]`, `success`, `error` |
| `exists`, `not-exists` | `path` |
| `equals`, `not-equals`, `exact-match` | `path`, `expected`, `ignoreCase`, `trim` |
| `contains`, `not-contains` | `path`, `expected` (a string or a list; `any: true`) |
| `regex`, `not-regex` | `path`, `expected` / `pattern`, `flags` |
| `json-schema` | `path`, `schema` (inferred from `expected` if omitted) |
| `snapshot` | `expected` (the stored JSON), `path` (optional), `mode`: `shape` (default: the same fields and types, values may change) or `values`, `ignore` (paths such as `$.id`, `$..updatedAt`, `$.items[*].price`), `strict` (also fail on new fields) |
| `openapi` | `spec` (an OpenAPI 3 / Swagger 2 file in the workspace, or the document inline), `operationId` (optional). See [contract testing](#openapi-contract-testing). |
| `asyncapi` | Realtime tests: `spec` (an AsyncAPI 2 / 3 file, or the document inline), `channel` (WebSocket), `allowUnknownChannels`. See [AsyncAPI checks](/api-testing/websocket#check-messages-against-an-asyncapi-document). |
| `type`, `length`, `threshold`, `greater-than`, `less-than` | `path`, `expected` / `min` / `max` |
| `latency`, `tokens`, `cost` | `max` (`tokens` also takes `field: input\|output\|total`) |
| `first-token` (alias `ttft`) | LLM: `max` milliseconds until the first token of a streamed answer (without streaming, the whole latency) |
| `header` | `header`, `expected` |
| `jwt` | A JSON Web Token in the response: from `header` (e.g. `Authorization`), from `path` (a JSONPath such as `$.access_token`), or the first one found. Fails when there is none, it has expired, or it expires within `min` seconds; `claims` must match (a list claim such as `aud` must contain the value). The signature is not verified. Example: `{ type: jwt, path: $.id_token, min: 300, claims: { iss: https://auth.example.com } }`. |
| `certificate` | HTTPS: `min` days the server's TLS certificate must still be valid (default 14). Fails when it expires sooner or has expired; the message names the subject, issuer and date. Useful in [monitors](./monitors.md). |
| `graphql-no-errors`, `graphql-errors` | `expected` (count or message) |
| `grpc-status` | `expected`: a gRPC status name (`OK`, `NOT_FOUND` …), a code, or a list. Default `OK`. |
| AI, RAG, agent and safety checks | see [evaluations](../ai-testing/evaluations.md) |

Check options can use variables, e.g. `expected: "{{expected}}"`. Script tests (`tp.test`) also appear as checks.

## Snapshots

A **snapshot** check keeps a copy of a response and compares later responses with it. By default it compares the *shape*: every field of the snapshot must still be there with the same type, while values may change, so it suits live data. `mode: values` compares the values too (array lengths included); `ignore` skips volatile fields.

```yaml
assertions:
  - type: snapshot
    mode: values
    ignore: ["$.id", "$..updatedAt"]
    expected: { "id": 1, "name": "Rex", "tags": ["dog"], "updatedAt": "2026-10-01" }
```

In the app, **Snapshot** above a JSON response adds one for the whole body, and the menu of an object or array in the response tree adds one for that part (*Keeps this shape*). A failure lists the differences, for example `$.price is string, was number` or `$.owner.email is missing`. When the API changed on purpose, **Update snapshot** next to the failed check (the response's Tests tab) keeps the new response as the snapshot.

## OpenAPI contract testing

The `openapi` check verifies that a response keeps the API's contract, as documented in its OpenAPI (3.0, 3.1) or Swagger 2.0 document:

1. The request is matched to an operation by method and path. Server base paths (`servers`, `basePath`) and templates such as `/pets/{id}` are understood, and literal paths win over templated ones. Give `operationId` to name the operation yourself.
2. The response status must be documented for that operation (exactly, as `2XX`, or through `default`).
3. Its content type must be documented.
4. The body must match the documented schema, including `$ref`s, `nullable`, enums, formats and `additionalProperties`. Every violation is listed, e.g. `/species must be equal to one of the allowed values: cat, dog`.

```yaml
name: Get a pet
type: http
url: "{{baseUrl}}/v1/pets/1"
assertions:
  - type: openapi
    spec: openapi.yaml        # relative to the workspace (or to the current folder when there is no workspace)
```

In the app, add **Matches OpenAPI contract** under a request's assertions. The document is read from the workspace only; paths can't point outside it.

:::
