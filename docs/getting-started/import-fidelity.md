---
title: "Import fidelity"
description: "What TestPion's Postman, Insomnia, Bruno, Hoppscotch, Thunder Client, Yaak, HTTPie, Apidog and GraphQL schema importers map, what becomes a note after the import, how a second import updates, and what to check by hand."
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

One page per tool, generated from the importers' own support table so it cannot drift: [Migrate to TestPion](/migrate/) (Postman, Insomnia, Bruno, Hoppscotch, Thunder Client, Yaak, HTTPie, Apidog), with how to export, what comes over, what is changed and what does not.

| From | Comes over | In the report |
|---|---|---|
| **Postman** v2.0 / v2.1, **v1**, **v3 and Native Git folders**, environments and globals, data export ZIP | Folders (with description), requests, params, headers, bodies (a switched-off body is reported), auth (including NTLM, Hawk and EdgeGrid), variables, scripts (`pm.*` → `tp.*`, the old `postman.*` and `tests[]` too, `pm.state` as `tp.state`), saved responses, descriptions, **request, folder and collection settings** (redirects, cookies, URL encoding, TLS versions, HTTP/1 only). Secret values of an environment go to the secret store; **globals become the workspace's globals** | An auth scheme TestPion doesn't have (ASAP, WSSE), an OAuth 2 grant it doesn't run, settings with no equivalent (`insecureHTTPParser` …), `{{vault:name}}` secrets (values to enter), `pm.datasets` / `pm.mock`, mock-server URLs, a v3 field TestPion does not read. A v3 file that **refers to another file** (`$ref: ../shared/auth.yaml`, with an optional `#/pointer`) is followed when the file is in the folder you imported; one that points outside the folder, to a missing file or in a loop is named and left out (import the whole folder with its shared files inside it) |
| **Insomnia** v4 JSON, v5 YAML | The same, plus environments (base merged into each), **folder headers, scripts, descriptions and auth** (kept on the folder), request settings (redirects, URL encoding, cookies), template tags, gRPC and WebSocket requests (v4 and v5), design documents (kept in `specs/`), **unit tests (each becomes a `tp.test` of the request it sends) and the cookie jar (to the workspace's jar)** | Template tags without an equivalent, `insomnia.parentFolders` and other APIs TestPion lacks, v5 Socket.IO / MCP items, a unit test with no request, mock routes |
| **Bruno** folder, ZIP, export, `.bru` file or a GitHub / GitLab link | Folders (docs, headers, auth, scripts, variables), requests, params, headers, bodies (SPARQL as text, file bodies), auth (NTLM and EdgeGrid too), `settings` blocks, custom `http` methods, environments, assertions, docs, scripts (`bru.*`, `req`, `res` → `tp.*`), the collection's `.env`, **response examples, gRPC and WebSocket requests**. **Folder and collection headers stay folder and collection headers** | Secret values to enter again, `.env` names without a value, `bru.*` calls TestPion lacks, the `.proto` file of a gRPC request |
| **OpenCollection YAML** (Bruno's new default format: a folder with `opencollection.yml`, or one bundled file) | Folders, requests, params, headers, bodies, auth (OAuth 2 flows too), runtime variables, scripts, assertions, actions that set a variable, settings, examples, environments, gRPC and WebSocket items | Scripts of other lifecycles, `extends` of environments, proxy and certificates |
| **Hoppscotch** | Folders, requests, params, headers, bodies, auth, request variables, **`pw.*` / `hopp.*` scripts (to `tp.*`)**, collection and folder headers, variables and scripts, GraphQL requests, saved responses, **environments** | Unsupported auth (AWS signature, Hawk), `hopp.fetch` |
| **Thunder Client** | Folders, requests, params, bodies, auth, **GUI tests (assertions where there is one, test code otherwise), `tc.*` scripts, post-request "set variable" actions**, `{{#guid}}`-style generators, environments | An auth scheme TestPion doesn't have, a generator with a format TestPion lacks |
| **Yaak** | Folders, requests, params, bodies, auth (Basic, Bearer, API key, Digest, JWT, OAuth 1 and 2, AWS, Hawk, NTLM, Akamai EdgeGrid), `${[ var ]}` templates and `uuid` / `timestamp` / `random.range(a, b)` functions, environments (base merged), gRPC and WebSocket requests; a git-sync folder too | `${[ response.body.path(…) ]}` (reading another request's response), Yaak's own functions with no TestPion variable (`hash.*`, `encode.*` …: compute them in a pre-request script) and **functions and auth types a Yaak plugin brings**, which are named as a plugin's: TestPion does not run Yaak plugins |
| **HTTPie** (Desktop exports) | Nested collections as folders, requests, params, bodies, auth with inheritance, docs, environments | An auth scheme TestPion doesn't have; **an encrypted password or variable** is left empty and named (TestPion has no key for it): enter it again |
| **Apidog** | Folders and endpoints as requests under `{{baseUrl}}`, parameters with their examples, bodies from examples or schemas, responses as examples, custom scripts, environments, global variables | Pre/post operations other than custom scripts; **an encrypted environment value or credential** is left empty and named |
| **GraphQL schema** (SDL, or an introspection result) | A folder per operation type (Queries, Mutations, Subscriptions) with a request for every root field, built from the schema; the schema in `specs/graphql/` | Where to set the endpoint; a schema that does not build; more than 60 fields of a type |

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
| Bruno's `req.*`, `res.*`, `res('path')`, `test`, `expect` | `tp.request.*`, `tp.response.*` (`res.body` is `tp.response.json()`), `tp.test`, `tp.expect` |
| `bru.sendRequest(config, callback)`, `bru.cookies.jar()` | An adapter over `tp.sendRequest` (callback or `await`), `tp.cookies.jar()` (which also answers Bruno's `getCookie` / `setCookie` / `deleteCookie` names) |
| `req.setTimeout(ms)`, `req.setMaxRedirects(n)` with a number | The request's *Timeout* / *Maximum redirects* setting; the line becomes a comment |
| `bru.getProcessEnv('NAME')` | `tp.variables.get('NAME')`; a name the import has no value for is listed as a value to enter |
| `pw.test`, `pw.expect(x).toBe(y)` and the other matchers, `pw.env.*`, `pw.response.*`; `hopp.*` | `tp.test`, `tp.expect(x).to.equal(y)` (chai), `tp.environment.*`, `tp.response.*` |
| `tc.setVar` / `getVar` / `test` / `loadModule` / `runRequest`, `tc.response.*`, `tc.request.*`, `expect` | `tp.environment.*`, `tp.test`, `require`, `tp.execution.runRequest`, `tp.response.*`, `tp.request.*`, `tp.expect` |
| `pm.state` | `tp.state` (values that last across runs on this computer, kept as globals named `state.<key>`) |
| No equivalent: `pm.datasets`, `pm.mock`, `insomnia.parentFolders`, `insomnia.request.auth.update` / `proxy` / `certificate`, `bru.getAuthMode`, `res.setBody`, `hopp.fetch` … | A `// TODO(import)` line above, a finding; **Fix what the import left with AI** (below) |

Every mapping is a row of the converter's tables (`packages/core/src/scripts/convert`); [the migration pages](/migrate/) list them per tool, generated from the same tables. A corpus of 265 snippets from the tools' documentation and real collections is converted in the tests, every conversion is idempotent, and where the original runs offline the converted script is checked to set the same variables and pass the same tests.

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

Bruno's `bru.*` calls are written with TestPion's API: `bru.getEnvVar` / `setEnvVar` → `tp.environment.get` / `set`, `bru.getVar` → `tp.variables.get`, `bru.setVar` → `tp.collectionVariables.set` (it lasts for the run, like Bruno's), `bru.runner.setNextRequest` → `tp.execution.setNextRequest`, `bru.getProcessEnv` → `tp.variables.get`. `req`, `res`, `test` and `expect` are written with `tp.*` as well (the sandbox still runs a leftover Bruno call through a small shim). A call TestPion lacks would fail when run: it gets a `// TODO(import)` line above it and a note. **Export ▸ Bruno collection folder** writes the scripts back with `bru.*`.

The collection's `.env` file (only `.env`; `.env.example` and the like are not read) becomes secret variables of a *Bruno .env* environment and of each imported environment: `{{process.env.API_KEY}}` is `{{API_KEY}}`, and the values go to the secret store, never into workspace files. A name used but not set is listed as *values needed*. `testpion import` has no secret store, so it lists the names under *Secret values were not saved*: set them in the app, or as `TESTPION_SECRET_*` variables for the CLI ([Secrets](/security/secrets)).

## What to check by hand

- Requests with an `X-Imported-Auth-…` header (unsupported auth).
- Findings about template tags left as text, and chained variables: run the source request first.
- Scripts with `// TODO(import)`.
- *Values to enter*: secret variables to fill in (Bruno secrets, `.env` names, Postman Vault references).

## Importing from Postman with an API key

For a collection you cannot export as a file, give the Import dialog (or `--postman-api-key` / `POSTMAN_API_KEY`) a Postman API key (Postman ▸ Settings ▸ API keys) and a reference: `postman:collection/<id>`, `postman:environment/<id>`, `postman:workspace/<id>` (every collection and environment of a workspace), an `api.getpostman.com` URL or a link copied from the Postman app. The key is kept in the secret store (the dialog) and sent only to api.getpostman.com; it never appears in a report or an error.

## Importing again updates

Import the same source again (a Postman collection after a colleague changed it, a Bruno folder after a `git pull`) and TestPion **updates the collection it made** instead of adding a copy. It remembers, per computer, what each item was in the source (the tool's own id of the request or folder where there is one: a Postman item id, an Insomnia `_id`, a Thunder or Yaak id; else its path of names) and a fingerprint of the item as imported and as saved. The preview then shows each item as:

- **Replace**: the source changed it and nobody edited it here (the item keeps its id, so favourites, history and links stay; a folder keeps its other items),
- **New**: the source has it and the collection does not,
- **Skip**: nothing changed in the source, or it changed there *and* you edited it here (a conflict: it stays yours unless you choose Replace), or you deleted it here (choose New to bring it back).

For an item whose **scripts** differ, the preview also shows the lines: *Show the lines that differ* under the item opens a line diff of its pre-request and test script (what you have now, against what the source has), so Replace or Leave it is chosen on the lines and not on the whole item.

Items that left the source are kept and listed. Pick another action per item in the dialog, or *Add a copy* to import it again as a second collection. An environment of the same name only gets the variables it lacks, its values are kept. The update is one undo step (the collection goes back as it was). From the command line it is the default: the preview prints the update (`testpion import <source> --preview`), `--update-decisions file.json` overrides single items by the keys the preview prints, `--new-copy` adds a copy.

## Simple tests as assertions

A test that only checks a status, a response time, a header, a body text or a field of the JSON (`pm.test("ok", () => pm.response.to.have.status(200))`, `tp.expect(json.items).to.have.lengthOf(3)`, `to.be.a("number")`, `to.be.above(0)`, `to.have.property("id")`, `to.be.json`, `jsonSchema`, about fifteen shapes) can be an **assertion**, shown in the request's *Tests* tab and readable without running the script. The report says how many can be (*N simple tests can be lifted into assertions*); tick **Lift N simple tests into assertions** in the preview (`--lift-tests`, MCP `lift_tests`) and they move, one assertion each, keeping the test's name; the rest of the script stays. Only tests that are exactly one of these shapes move, nothing is guessed.

## Links to repositories

A link to a **public** GitHub or GitLab repository or folder (`https://github.com/owner/repo/tree/main/api/clinic`, `https://gitlab.com/group/project`) imports as the folder's files: a Bruno or OpenCollection collection, a Postman Git collection, a Yaak sync folder, a folder of exports. Only the two services are asked (github.com's API and raw files, gitlab.com's API), over https, with no token, no cookie and no credential, and a redirect to any other host is refused. At most 500 files that look like import files, 5 MB each and 25 MB together are read; over a limit the message says so and to link a narrower folder. Nothing in the repository is executed, symbolic links and submodules are skipped, and a path that leaves the folder is refused. A private repository answers "not found": clone it and import the folder.

## Fix what the import left with AI

The scripts that still carry a `// TODO(import)` line (a call with no `tp.*` equivalent) can be rewritten as a reviewed proposal: **Fix what the import left…** in the import report, `testpion ai run import-leftovers --item collection:<id>`, MCP `ai_run_task`. TestPion finds the marked scripts itself; the model rewrites each with `tp.*` only, one item per script with a diff. Every rewrite is checked statically (no `pm.*`, `bru.*` …, no member that does not exist), run in the sandbox against the request's saved example response (never against the real API) and refused when it throws; a script that keeps its TODO is a warning, not a pass. Nothing changes until you accept, and Undo puts the script back. Without a model set up the marked lines stay and the report lists them.

## Going back out

`testpion export <collection> --format insomnia` (v5 YAML), `insomnia-v4` (JSON), `opencollection` (Bruno's YAML folder, `--out <folder>`) or `opencollection-file`; the workspace's environments go along (secret values never), scripts are written in the target tool's API (`tp.*` becomes `insomnia.*` / `bru.*`) and TestPion's assertions become tests where the format has none. What the format cannot hold (saved examples for Insomnia, JWT and EdgeGrid auth, a check with no test form) is listed on standard error as `not exported: …` and in the MCP tool `export_collection`'s `notes`. Insomnia has no collection-level headers, auth or scripts, so they are copied onto the top-level items. An export read back by the importers gives the same requests (a property test runs it over generated collections).

## Not yet

Socket.IO and MCP items of an Insomnia v5 file, Insomnia's mock routes, a `.proto` file next to an imported gRPC request, `pm.datasets` and `pm.mock` (no equivalent), Postman's flows and monitors (not exportable), Paw, SoapUI and Kreya files, and exports to Hoppscotch, Thunder Client, Yaak and HTTPie are not covered; they are tracked in the backlog (B-24b).

:::
