---
title: "Import fidelity"
description: "What TestPion's Postman, Insomnia, Bruno, Hoppscotch and GraphQL schema importers map, what becomes a note after the import, and what to check by hand."
---

::: v-pre

# Import fidelity

An import never drops something silently. Before anything is written, the Import dialog **previews** what will be created and shows the **compatibility report**: for every item, whether it came over **fully**, **with changes**, or **not at all, and why** (unsupported auth, a template tag left as text, a script API TestPion lacks, a value you still have to enter). After the import the same report is shown with an **Undo import** button, and it is kept (the last 30 imports of a workspace): `testpion import-report <id>`, MCP `get_import_report`. How to import: [Collections](/api-testing/collections#import).

<figure class="aps-screenshot">
  <img src="/images/import-notes.jpg" alt="After importing a Postman collection with an unsupported auth scheme: Imported postman, then Check after import naming the request, set to No auth with a disabled X-Imported-Auth header" width="1440" height="900" loading="lazy">
</figure>

## The import dialog

1. **Source.** Choose files (several at once), choose a folder (a Bruno or OpenCollection collection, or any folder of files), paste a document or a copied cURL command, or give a link. You can also **drop** files, folders or a link anywhere on the window, or open **Home ▸ Migrate from…** for how to export from Postman, Insomnia or Bruno. A ZIP is opened (a Postman data export holds every collection and environment; a zipped collection folder works too). The format is found by the content, never by the extension.
2. **Preview.** For each input: what it creates (collections with their folder and request tree, environments, API definitions, flows, gRPC calls and connections), name clashes, secret values that go to the secret store, and the report. **Nothing has been written yet.** *Keep pm.\** in scripts is a choice here.
3. **Result.** The same report, a toast with **Undo**, and *Undo import* in the dialog. Undo moves what the import made to Recently deleted (so it can be restored) and removes the flow files it wrote; it is refused, changing nothing, while an imported collection was edited since (`testpion import-undo --force` overrides).

`testpion import` does the same: a single file is imported at once, **several files, a folder or a ZIP are previewed first** (`--apply` imports them), `--preview` previews anything, `--report report.json|report.md` writes the report, `--json` returns the plan (`preview: true`) or the result with `report` and `importId`. MCP: `import_preview` (read-only), `import_definition` (returns `report` and `importId`), `get_import_report`, `undo_definition_import`.

### Reading the report

Items are collections, folders, requests and environments. **Fully** items came over as they were; **with changes** had something converted or marked (an auth scheme, a script line, a template tag); **not imported** counts what was left out. Findings are grouped by what they are (*Auth schemes TestPion does not have*, *Template tags left as text*, *Script APIs without an equivalent*, *Values to enter* …) and each names the item by its path and field, with the original text where there is one. **Download** writes the report as JSON or Markdown. The `notes` list of the older result (CLI `--json`, MCP) stays, one line per finding, for scripts that read it.

## What each importer maps

| From | Comes over | In the report |
|---|---|---|
| **Postman** v2.0 / v2.1, environments and globals, data export ZIP | Folders (with description), requests, params, headers, bodies (a switched-off body is reported), auth (including NTLM, Hawk and EdgeGrid), variables, scripts (`pm.*` → `tp.*`, the old `postman.*` and `tests[]` too), saved responses, descriptions, **request, folder and collection settings** (redirects, cookies, URL encoding, TLS versions, HTTP/1 only). Secret values of an environment go to the secret store | An auth scheme TestPion doesn't have (ASAP, WSSE), an OAuth 2 grant it doesn't run, settings with no equivalent (`insecureHTTPParser` …), `{{vault:name}}` secrets (values to enter), `pm.datasets` / `pm.mock` / `pm.state`, mock-server URLs |
| **Insomnia** v4 JSON, v5 YAML | The same, plus environments (base merged into each), **folder headers, scripts, descriptions and auth** (kept on the folder), request settings (redirects, URL encoding, cookies), template tags, gRPC and WebSocket requests (v4 and v5), design documents (kept in `specs/`) | Template tags without an equivalent, `insomnia.parentFolders` and other APIs TestPion lacks, v5 Socket.IO / MCP items, unit tests, cookie jars, mock routes |
| **Bruno** folder, ZIP, export or `.bru` file | Folders (docs, headers, auth, scripts, variables), requests, params, headers, bodies (SPARQL as text, file bodies), auth (NTLM and EdgeGrid too), `settings` blocks, custom `http` methods, environments, assertions, docs, scripts (`bru.*` → `tp.*`), the collection's `.env`. **Folder and collection headers stay folder and collection headers** | Secret values to enter again, `.env` names without a value, `bru.*` calls TestPion lacks, gRPC / WebSocket requests, response examples |
| **OpenCollection YAML** (Bruno's new default format: a folder with `opencollection.yml`, or one bundled file) | Folders, requests, params, headers, bodies, auth (OAuth 2 flows too), runtime variables, scripts, assertions, actions that set a variable, settings, examples, environments | gRPC / WebSocket items, scripts of other lifecycles, `extends` of environments, proxy and certificates |
| **Hoppscotch** | Folders, requests, params, headers, bodies, auth | Scripts (`pw.*`, kept as comments), unsupported auth |
| **GraphQL schema** (`.graphql`, `.gql`) | A GraphQL request for `{{graphqlUrl}}` with an operation for the first Query field; the schema in `specs/graphql/` | Where to set the endpoint; a schema that does not build |

Folder and collection **headers** and **settings** are real fields now: the *Headers* tab of a folder and of a collection sends them with every request inside (the request's own header of the same name wins, an inner folder's wins over an outer one's), and the folder's and collection's settings are the defaults of their requests.

## Auth

A scheme TestPion has (basic, bearer, API key, digest, OAuth 1, OAuth 2, AWS Signature, JWT HS256/384/512, **NTLM, Hawk, Akamai EdgeGrid**) comes over as that auth. NTLM (v2) runs its three-message handshake on one connection, Hawk and EdgeGrid sign the request when it is sent. A scheme it doesn't have (ASAP, WSSE, netrc, a JWT signed with RS256 …) is **never inherited from the folder**: the request gets **No auth**, a disabled header such as `X-Imported-Auth-ASAP: needs manual setup`, and a finding. Set the auth up by hand before you run it.

## Scripts

Scripts are always converted to TestPion's `tp.*` (a runtime alias keeps `pm.*` working, so a line the converter could not rewrite still runs; *Keep pm.** is for collections you also use in Postman). The converter reads the script's syntax tree, not its text: strings, comments, regular expressions and template literals are left alone, formatting survives, and a variable of your own named `pm` (a parameter, a destructuring) is not touched while the rest of the script is converted. A script that does not parse is kept as written and reported with its line. Converting twice changes nothing. What has no equivalent gets a `// TODO(import)` line and a finding.

| Source | Becomes |
|---|---|
| `pm.*` | `tp.*` (same API) |
| `postman.setEnvironmentVariable` / `getEnvironmentVariable` / `clearEnvironmentVariable(s)`, the global variants, `setNextRequest`, `getResponseHeader` | `tp.environment.set` / `get` / `unset` / `clear`, `tp.globals.*`, `tp.execution.setNextRequest`, `tp.response.headers.get` |
| `tests["name"] = expr`, `responseBody`, `responseCode.code`, `responseTime`, `JSON.parse(responseBody)` | `tp.test("name", …)`, `tp.response.text()`, `tp.response.code`, `tp.response.responseTime`, `tp.response.json()` |
| `insomnia.*` | `tp.*` (`insomnia.baseEnvironment` / `collectionVariables` → `tp.environment`) |
| `bru.getEnvVar` / `setEnvVar` / `getVar` / `setVar` / `runner.*` / `interpolate` / `runRequest` … | `tp.environment.*`, `tp.variables.*`, `tp.collectionVariables.*`, `tp.execution.*`, `tp.variables.replaceIn`, `tp.execution.runRequest` |
| No equivalent: `pm.datasets`, `pm.mock`, `pm.state`, `insomnia.parentFolders`, `insomnia.request.auth.update` / `proxy` / `certificate`, `bru.sendRequest`, `bru.cookies` … | A `// TODO(import)` line above, a finding |

`tp.execution.runRequest("Get patient")` runs another saved HTTP request of the collection (by name, `Folder / Name` or id) with the auth, headers and variables it would have, and answers its response (`await` it, or pass a callback). Its own scripts and checks do not run: it is a call, not a step.

`testpion scripts convert --to tp` and *Convert scripts* in the app use the same converter on a collection that is already imported.

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
- Findings about template tags left as text, and chained variables: run the source request first.
- Scripts with `// TODO(import)`.
- *Values to enter*: secret variables to fill in (Bruno secrets, `.env` names, Postman Vault references).

## Importing from Postman with an API key

For a collection you cannot export as a file, give the Import dialog (or `--postman-api-key` / `POSTMAN_API_KEY`) a Postman API key (Postman ▸ Settings ▸ API keys) and a reference: `postman:collection/<id>`, `postman:environment/<id>`, `postman:workspace/<id>` (every collection and environment of a workspace), an `api.getpostman.com` URL or a link copied from the Postman app. The key is kept in the secret store (the dialog) and sent only to api.getpostman.com; it never appears in a report or an error.

## Not yet

Thunder Client, Yaak, HTTPie and Apidog files, Postman v1 collections and the v3 (file-based) format, Hoppscotch scripts and environments, GitHub / GitLab repository links, re-import that updates instead of adding, lifting simple `pm.test` calls into assertions, and AI help for what the converter could not do are planned (backlog B-23b, B-24).

:::
