---
title: "Import fidelity"
description: "What TestPion's Postman, Insomnia, Bruno, Hoppscotch and GraphQL schema importers map, what becomes a note after the import, and what to check by hand."
---

::: v-pre

# Import fidelity

An import never drops something silently: whatever does not map one to one is a **note** that names the request or folder. The notes appear after the import (**Check after import** in the app, the first ones with *and N more*), under the result of `testpion import` (up to 20; `--json` lists them all in `notes`) and in the MCP tool `import_definition` (`notes`). How to import: [Collections](/api-testing/collections#import).

<figure class="aps-screenshot">
  <img src="/images/import-notes.jpg" alt="After importing a Postman collection with Hawk auth: Imported postman, then Check after import (1 note) naming the request Health with Hawk, set to No auth with a disabled X-Imported-Auth-Hawk header" width="1440" height="900" loading="lazy">
</figure>

## What each importer maps

| From | Comes over | Becomes a note |
|---|---|---|
| **Postman** v2.0 / v2.1 | Folders, requests, params, headers, bodies, auth, variables, scripts (`pm.*` → `tp.*`), saved responses, descriptions | An auth scheme TestPion doesn't have, an OAuth 2 grant it doesn't run, a JWT sent as a query parameter |
| **Insomnia** v4 JSON, v5 YAML | The same, plus environments (base merged into each), request and folder scripts (`insomnia.*` → `tp.*`), template tags, gRPC and WebSocket requests (v4) | Folder headers (added to each request inside), template tags without an equivalent, `insomnia.parentFolders` and other APIs TestPion lacks, v5 gRPC / WebSocket / Socket.IO / MCP items, design documents, unit tests, cookie jars |
| **Bruno** folder, export or `.bru` file | Folders, requests, params, headers, bodies, auth, variables, environments, assertions, docs, scripts (`bru.*` → `tp.*`), the collection's `.env` | Secret values to enter again, `.env` names without a value, `bru.*` calls TestPion lacks, gRPC / WebSocket requests, unsupported body types |
| **Hoppscotch** | Folders, requests, params, headers, bodies, auth | Scripts (`pw.*`, kept as comments), unsupported auth |
| **GraphQL schema** (`.graphql`, `.gql`) | A GraphQL request for `{{graphqlUrl}}` with an operation for the first Query field; the schema in `specs/graphql/` | Where to set the endpoint; a schema that does not build |

## Auth

A scheme TestPion has (basic, bearer, API key, digest, OAuth 1, OAuth 2, AWS Signature, JWT HS256/384/512) comes over as that auth. A scheme it doesn't have (Hawk, NTLM, Akamai EdgeGrid, ASAP, WSSE, netrc, a JWT signed with RS256 …) is **never inherited from the folder**: the request gets **No auth**, a disabled header such as `X-Imported-Auth-Hawk: needs manual setup`, and a note. Set the auth up by hand (or send the header your API expects) before you run it.

## Insomnia template tags

| Tag | In TestPion |
|---|---|
| `{% uuid %}` | `{{$guid}}` |
| `{% now 'iso-8601' %}`, `'millis'`, `'unix'` | `{{$isoTimestamp}}`, `{{$timestampMs}}`, `{{$timestamp}}` |
| `{% timestamp %}` | `{{$timestampMs}}` |
| `{% faker 'randomFirstName' %}` | `{{$randomFirstName}}` (the same names as Postman's dynamic variables) |
| `{% base64 … %}`, `{% hash … %}`, `{% now 'custom', … %}` | A line of the request's pre-request script that sets a variable, used in its place |
| `{% response 'body', 'req_…', '$.token' %}` | **Chained**: the referenced request's post-response script sets `{{insomnia_<request>_<field>}}`, which this request uses. Send that request first (Insomnia did it on its own). Headers, the raw body and the URL chain the same way |
| `{% prompt %}` | `{{prompt_<label>}}`: set it in an environment |
| Any other (`cookie`, `os`, `file`, `jsonpath`, `request`, plugins, a JSONPath with filters) | Left as text, with a note naming the request |

`{{ _.name }}`, `{{ _['a-b'] }}` and `{{ name }}` become `{{name}}`.

## Bruno scripts and .env

Bruno's `bru.*` calls are written with TestPion's API: `bru.getEnvVar` / `setEnvVar` → `tp.environment.get` / `set`, `bru.getVar` → `tp.variables.get`, `bru.setVar` → `tp.collectionVariables.set` (it lasts for the run, like Bruno's), `bru.runner.setNextRequest` → `tp.execution.setNextRequest`, `bru.getProcessEnv` → `tp.variables.get`. `req`, `res`, `test` and `expect` run as in Bruno. A call TestPion lacks (`bru.sendRequest`, `bru.cookies` …) would fail when run: it gets a `// TODO(import)` line above it and a note. **Export ▸ Bruno collection folder** writes the scripts back with `bru.*`.

The collection's `.env` file (only `.env`; `.env.example` and the like are not read) becomes secret variables of a *Bruno .env* environment and of each imported environment: `{{process.env.API_KEY}}` is `{{API_KEY}}`, and the values go to the secret store, never into workspace files. A name used but not set is listed as *values needed*. `testpion import` has no secret store, so it lists the names under *Secret values were not saved*: set them in the app, or as `TESTPION_SECRET_*` variables for the CLI ([Secrets](/security/secrets)).

## What to check by hand

- Requests with an `X-Imported-Auth-…` header (unsupported auth).
- Notes about template tags left as text, and chained variables: run the source request first.
- Scripts with `// TODO(import)`.
- *Values needed*: secret variables to fill in (Bruno secrets, `.env` names).
- Folder headers that were added to each request (TestPion folders have no headers yet).

:::
