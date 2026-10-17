# Import compatibility: Postman, Insomnia, Bruno and the rest

**Owner request (2026-10-17):** "We have to think about compatibility with the other providers like Postman, Insomnia
and Bruno, so that a user from any of those can smoothly upload/import their collection into TestPion."

**Goal.** A user of Postman, Insomnia, Bruno (or Hoppscotch, Thunder Client, Yaak, HTTPie, Apidog …) imports what they
have and it just works: requests, folders, auth, variables, environments, scripts, tests, examples, docs and
settings. Anything that did not map is listed in a **Compatibility report** (never dropped silently), and the
collection can go back out (round trip) to the tool it came from.

Status: research and plan, no code yet. Item ids: `IMP-…`. Sizes and statuses follow [README.md](README.md).
Related plans: [ai-features.md](ai-features.md) (AI-10 import cleanup), [git-integration.md](git-integration.md)
(GIT-303 one file per request, not built), [postman-parity.md](postman-parity.md). `planning/export-import.md` and
`planning/git-everything.md` do not exist yet; when they land, the item-kind registry in section 4a is the one to
share (this plan only adds what import needs on top of it).

---

## 1. Inventory: what TestPion has today (v0.48.1)

### 1.1 Entry points

| Surface | Where | What it does |
|---|---|---|
| Format detection | `packages/core/src/import/importers.ts:22-51` `detectFormat` | By content, not extension: WSDL, .http, single .bru, GraphQL SDL, .env, then JSON/YAML → Arazzo, Insomnia/Bruno/Hoppscotch (`other-tools.ts:456`), AsyncAPI, OpenAPI, Swagger, Postman (`info._postman_id` or schema URL), Postman env/globals, HAR, TestPion workspace/collection. |
| Dispatcher | `importers.ts:428-497` `importAny` | Calls the importer, returns `{collection, environments, notes, scripts, savedItems, flows}`. Unknown JSON gets a line/column parse error (`:478-490`). **`graphql-sdl` is detected (`:29`) but has no case: the user gets "Unrecognised import format (graphql-sdl)".** |
| Workspace write | `import/workspace-import.ts:98-173` `importIntoWorkspace` | Saves collection, environments (name clash → "(imported)", `:150-157`), OpenAPI/AsyncAPI kept in `specs/` + contract checks (`:108-136`), gRPC/WebSocket library items (`:70-91`), `scriptCompatibility` warnings (`:145`). Secret values go to the secret store **only for .env** (`:162-166`). Writes immediately: there is no preview and no undo. |
| CLI | `packages/cli/src/commands/data.ts:617-671` `testpion import <file\|dir\|url\|->` | `--keep-pm`, `--no-contract-checks`, `--fetch-sources`, `--json`; a directory is read as a Bruno folder (`readBrunoFolder`); cURL/fetch/PowerShell snippets go to the "Imported" collection. **No `--from`, no `--dry-run/--preview`, no `--report`.** |
| CLI export | `data.ts:533-584` `testpion export --format postman\|testpion\|openapi\|bruno\|http\|asyncapi`, `:586` `export-environment` (Postman env), `:673-697` `scripts convert --to tp\|pm` | Postman export prints `not exported:` notes on stderr. |
| MCP | `packages/core/src/mcp-server/testpion-mcp.ts:755` `import_definition` (url or text, `keep_pm`), `arazzo-tools.ts:18/53` `import_arazzo`/`export_arazzo`, `testpion-mcp.ts:704` OpenAPI export, `agent-kit.ts:248` prompt `import_and_test` | **No MCP tool exports to Postman / Bruno / .http, none previews an import, none imports a Bruno folder or a zip.** |
| App: Import dialog | `apps/desktop/src/views/rest/dialogs.tsx:124-235` `ImportModal` | Choose file…, Bruno folder… (`pickFolderFiles`, `:201-208`), Import link, paste text, "Keep pm.* in scripts". The result is shown as **toasts** (`:149-168`): success line, "kept pm.*", "Not imported: (3 notes) +N more", "script APIs TestPion doesn't have". No preview tree, no report you can open again. |
| App: backend | `apps/desktop/backend/handlers/collections.ts:129-144` `col.import`, `:226-234` `col.importUrl`, `col.importBrunoFolder`, `col.importFile`; `handlers/workspace.ts:182-185` `ws.importFile` (Workspace menu ▸ Import…); `:423` `col.export` | Same core path. |
| Menus | `src/App.tsx:409` palette "Import (Postman, Insomnia, Bruno, OpenAPI, HAR, cURL …)", `menu-commands.ts:130` File ▸ Import, `Explorer.tsx:717` import button, `CollectionsView.tsx:242`, `WorkspaceMenu.tsx:80-90` | All open the same dialog (uniform-UI rule holds). |
| Drag and drop | — | **None.** `onDrop` handlers exist only for tree moves and flows (`CollectionTree.tsx:293-326`, `FlowDrop.tsx`); dropping a Postman file or a Bruno folder on the window does nothing. |
| From a link | `import/fetch-url.ts:12-29` `rawImportUrl` (GitHub/GitLab/Bitbucket blob → raw), 20 MB cap (`:6`), proxy-aware | A single file only: no repo/folder (Bruno repo on GitHub), no zip, no Postman public-workspace link resolution, no Postman API key flow. |
| Tests | `tests/unit/import-other-tools.test.ts` (14 cases, inline tiny fixtures), `postman-builder.test.ts` (8), `bruno-folder.test.ts` (8), `postman-export.test.ts` (10), `import-scripts-tp.test.ts` (15), `script-aliases.test.ts`, `script-compat.test.ts` (2), `insomnia-realtime.test.ts`, `asyncapi-import.test.ts`, `openapi-import-contract.test.ts`, `import-url.test.ts`, `dynamic-vars.test.ts`; e2e `apps/desktop/e2e/plans/import-collections.cjs` with one vet-clinic sample each for Postman, Insomnia, Bruno (`e2e/fixtures/{postman,insomnia,bruno}`) run against the demo server. | **No `tests/fixtures/import/` corpus, no real-world collections, no golden outputs, no round-trip property tests, no malicious-file tests for importers, no perf test for big collections.** |

### 1.2 Postman (`importers.ts:209-396`)

Mapped: folders (+ folder auth, variables, pre-request/test scripts `:316-327`), request method/URL, query params with
description/disabled, path variables (`url.variable`), headers (v2.0 string form too, `:335`), bodies raw
(json/xml/html/text by `options.raw.language`), urlencoded, formdata (text/file), file → binary, GraphQL → a GraphQL
item (`:338-348`); auth noauth/bearer/basic/apikey/digest/oauth1/awsv4/oauth2 (`:211-271`); `protocolProfileBehavior`
`followRedirects`/`strictSSL` (`:357-358`); description; saved responses → examples incl. `originalRequest`
(`:288-306`); collection variables, auth, scripts. Environment/globals: `importPostmanEnvironment` (`:389-396`);
secret values blanked.

Gaps found in the code:

* **Silent auth loss.** `pmAuth` returns `undefined` for `hawk`, `ntlm`, `edgegrid`, `jwt`, `asap` (and any new type),
  and the caller then sets `{ type: 'inherit' }` (`:337`), so the request quietly uses the parent's auth. TestPion
  even has a `jwt` auth type (`model/types.ts:24-32`) that the importer does not use. OAuth 2 `implicit` and
  `device` grants become `authorization_code`; token name, refresh URL, `audience`, `resource`, `state`,
  `addTokenTo`/header prefix, `client_authentication: body` are dropped.
* **Settings.** Only `followRedirects` and `strictSSL`; `maxRedirects` (TestPion has it, `types.ts:71`),
  `disableCookies`, `followOriginalHttpMethod`, `followAuthorizationHeader`, `disableUrlEncoding`,
  `insecureHTTPParser`, `tlsDisabledProtocols`, `disableBodyPruning` dropped; folder/collection-level
  `protocolProfileBehavior` ignored. Nothing is reported.
* **Folder description** dropped (the model has no folder description, `types.ts:701-713`).
* **Bodies.** `body.disabled` ignored; per-field `contentType` of formdata dropped; formdata `src` arrays (several
  files) are passed through as an array; raw `javascript`/`graphql` languages → text; `file.content` ignored.
* **Variables.** Collection variable `type`/`description` dropped; request-level `variable` ignored.
* **Examples.** Response `cookie`, `responseTime`, `_postman_previewlanguage`, originalRequest non-raw bodies dropped.
* **Globals** are imported as an *environment* (`detectFormat :46`), not as TestPion globals (`storage/current-values.ts`).
* **Secrets.** Postman env `type: secret` values are blanked (good) but not offered to the secret store and not
  listed as "values needed" (the .env importer does both).
* **Not handled at all:** Collection v1 (`requests` + `order`), Postman data dump (Settings ▸ Export data: a zip /
  folder with many collections and environments), Postman v3 / file-based collections (section 2), zip files.
* **Scripts:** converted pm → tp (below); the sandbox runs nearly all of `pm.*`.

### 1.3 Insomnia (`other-tools.ts:78-242`)

Mapped: v4 JSON (`_type: export`, resources linked by `parentId`, `:222-241`) and v5 YAML
(`type: collection.insomnia.rest/5.x`, `:208-220`); folders with auth and folder environment → variables; request
method/URL/params/path params/headers/body by MIME (json/xml/html/text, urlencoded, multipart incl. file), GraphQL
(`:121-129`); auth bearer (prefix), basic, digest, apikey, oauth1, oauth2 (password/auth code/client credentials,
PKCE), iam → awsv4, none; `settingFollowRedirects: off`; description; base environment + sub-environments merged
(`:153-161`, nested objects flattened to dotted keys, `:38-43`); gRPC requests with their `.proto` text and WebSocket
requests become library items (`:167-195`); `insomnia.*` scripts → `pm.*` → `tp.*` (`:61-66`).

Gaps found in the code:

* **Template tags are not handled.** `normalizeTemplate` (`:30-35`) rewrites `{{ _.x }}` and `{{ x }}` but leaves
  `{% response … %}` (request chaining), `{% faker … %}`, `{% uuid %}`, `{% now %}`, `{% base64 %}`, `{% hash %}`,
  `{% prompt %}`, `{% cookie %}`, `{% jsonpath %}`, `{% file %}`, `{% os %}`, `{% request %}` in place: the request
  is sent with the literal text. This is the biggest silent break for Insomnia users (request chaining is how
  Insomnia passes tokens). `{{ _['a-b'] }}` bracket syntax is also missed.
* **Folder scripts, folder headers, folder descriptions** (Insomnia 9+) are dropped in both v4 and v5; v5 folder
  `scripts` and request `settings` are ignored.
* **Auth:** `hawk`, `ntlm`, `asap`, `netrc` → `undefined` → inherit (silent); OAuth 2 `implicit` → client credentials.
* **Settings:** only follow-redirects; `settingSendCookies`, `settingStoreCookies`, `settingEncodeUrl`,
  `settingRebuildPath`, `settingDisableRenderRequestBody` dropped.
* **Bodies:** binary file body (`body.fileName`) dropped.
* **Not imported, not reported:** `cookie_jar`, `api_spec` (design documents: OpenAPI text that could go to
  `specs/`), `unit_test_suite`/`unit_test` (Insomnia's chai tests, could become test scripts or flows),
  private environments, client certificates, proto directories, `mock` routes (Insomnia mock servers).
* **v5 risk to verify:** the v5 converter treats every non-folder item as an HTTP request (`:212-214`); gRPC /
  WebSocket entries in a v5 file would become broken HTTP requests (v4 handles them).
* A script that does not use `insomnia.` is commented out (`:64`), even if it is plain JS (console.log, a loop).

### 1.4 Bruno (`bru.ts`, `other-tools.ts:244-396`, `scripts/bruno.ts`)

Mapped: Bruno JSON export, a single `.bru` file and a collection folder (`bruno.json`, `collection.bru`,
`folder.bru`, request `.bru`, `environments/*.bru`, `bru.ts:162-204`, 50 MB cap `:226`); request
method/URL/query/path params/headers/body json/xml/text/form-urlencoded/multipart (file refs)/GraphQL; auth
none/inherit/bearer/basic/digest/apikey/awsv4/oauth2 (client credentials/password/auth code, basic fields only);
`vars:pre-request` / `vars:post-response` → script lines; `assert` → status assertion + generated `test()` lines
(`scripts/bruno.ts:100-144`, 27 operators); `script:pre-request`, `script:post-response`, `tests`; `docs` (request,
collection); folder/collection root auth, variables, scripts; env `vars` + `vars:secret` (names only).
Scripts run unchanged through a `bru`/`req`/`res`/`test` shim over `pm` (`scripts/bruno.ts:6-84`).

Gaps found in the code:

* **tp-not-pm violation:** `brunoVars` writes `pm.variables.set(...)` into imported scripts (`other-tools.ts:291`),
  and Bruno scripts never go through `importScriptsToTp`; the import returns no `scripts` summary.
* **Silent drops:** `grpc-request`, `ws-request` (Bruno 2.x) items in an export (`:341` returns `[]`);
  `body:file`, `body:sparql`; `auth:ntlm`, `auth:wsse`, OAuth 2 implicit and extra fields (callback URL, PKCE,
  token placement, refresh, credentials id); `settings { encodeUrl, timeout }` blocks; collection `vars:post-response`
  (`bru.ts:92` reads only `req`); folder `docs`; Bruno response **examples**; `bruno.json` `scripts.moduleWhitelist`,
  `clientCertificates`, `proxy`, `presets`; the collection `.env` file (`readBrunoFolder` skips dotfiles, `:220`) so
  `{{process.env.X}}` references end up unresolved.
* **Folder headers are flattened** into every request (`other-tools.ts:315-320`) because folders have no headers in
  TestPion's model: the import works, but the structure is lost and a Bruno export writes them per request.
* **Shim gaps** (run but silently do nothing): `bru.getProcessEnv` (`scripts/bruno.ts:35`), `req.setTimeout`,
  `req.getAuthMode`, `bru.cwd`; missing `bru.sendRequest`, `bru.runRequest`, `bru.getSecretVar`, `bru.cookies`,
  `bru.getOauth2CredentialVar`, `res.setBody`, `req.setMaxRedirects`, `require('axios')` and other npm modules.
* **OpenCollection YAML** (Bruno's new file format) is not read.

### 1.5 Hoppscotch (`other-tools.ts:398-452`)

Folders and requests, body by content type, params/headers (active flag), auth inherit/none/bearer/basic/digest/
api-key/oauth-2 (always client credentials). **Scripts (`pw.*`) come over as comments** (`:428-429`). Not mapped:
Hoppscotch environments (separate export), collection/folder headers and variables, `requestVariables`, GraphQL
collections, AWS signature / Hawk / JWT / Akamai auth, response examples.

### 1.6 Others

* **OpenAPI 2/3/3.1** (`importers.ts:84-207`): good; examples from responses (`:165-201`), security → auth (only the
  first scheme of the first requirement; `oauth2`/`openIdConnect` → bearer `{{accessToken}}`), tags → folders,
  kept in `specs/` with contract checks. Not mapped: server variables beyond the first server as environments,
  `callbacks`/`webhooks`, header/cookie params' examples, `deprecated`, `externalDocs`, multiple content types.
* **HAR** (`:400-425`), **cURL/fetch/PowerShell/HTTPie snippets** (`snippet.ts`, `curl.ts`), **.http/.rest**
  (`http-file.ts`, JetBrains `{% %}` handlers mapped), **.env** (`dotenv.ts`, secrets to the store), **WSDL 1.1/2.0**
  (`wsdl.ts`), **AsyncAPI 2/3** (`asyncapi.ts`), **Arazzo 1.0** (`arazzo.ts`, flows), TestPion files.
* **Not supported at all:** Thunder Client, Yaak, HTTPie desktop collections, Apidog, Paw/RapidAPI, SoapUI projects,
  Kreya, RAML, Postman v1, GraphQL SDL (detected, not imported), protobuf files on their own, zip archives.

### 1.7 Scripts, dynamic variables, export

* **Sandbox compatibility is already strong.** `pm`, `tp` and `aps` are the same object (`scripts/prelude.ts:639-701`):
  `test` (+`skip`, done callbacks, async), `expect` (chai), `variables`, `environment` (+`name`), `globals`,
  `collectionVariables`, `iterationData`, `request`, `response`, `info`, `cookies` (+`jar()`), `sendRequest`
  (replayed by the host, max 20), `vault` (backed by secret variables), `require` (workspace packages),
  `execution.setNextRequest/skipRequest/location`, `visualizer.set/clear`; legacy `postman.*`
  (`:685-697`), `responseBody`, `responseCode`, `tests["x"] = …` (`:702-721`); modules ajv, atob, btoa, chai,
  cheerio, crypto-js, csv-parse, lodash, moment, tv4, uuid, xml2js (`scripts/compat.ts:4`). The collection runner
  honours `setNextRequest` (`runner/collection-run.ts:203`). `scripts/compat.ts:6` `UNSUPPORTED` is empty: the only
  warnings left are unknown `require()` and missing `pm.require` packages.
* **pm → tp conversion** (`scripts/aliases.ts:10-157`) is a hand-written tokenizer that renames the global
  identifier (`pm.` / `pm[` outside strings, comments, regexes, templates). It bails out of the whole script on
  any local `pm` declaration (regex heuristics, `:12-24`), and does not touch `postman.*`, legacy globals,
  `insomnia.*` (pre-mapped by regex), `bru.*`, `pw.*`, `tc.*`. The summary is "N converted / M unchanged with reason"
  (`import/import-scripts.ts:11-25`); there is no per-script line-level report.
* **Dynamic variables:** about 75 Postman names (`vars/dynamic.ts:44-120`) plus `$randomInt(min,max)`, `$env.*`,
  `$secret.*`. Postman documents 118 (`$guid`, `$timestamp`, `$isoTimestamp` and 115 `$random*`); about 45 are missing (section 5). Insomnia `{% faker %}`,
  `{% uuid %}`, `{% now %}`, Bruno's `{{$random…}}` (Bruno adopted Postman's names), Thunder's `{{#guid}}`-style
  and Hoppscotch's `<<$guid>>` are not converted.
* **Export:** Postman v2.1 collection + environment (`import/postman-export.ts`, tp → pm, notes for unmappable auth
  and checks), Bruno folder (`bru-export.ts`), OpenAPI 3.1 (`openapi/from-collection.ts`), .http
  (`collectionToHttpFile`), AsyncAPI 3 (`asyncapi-export.ts`), Arazzo (`arazzo-export.ts`), TestPion JSON. **No
  Insomnia export (v4 or v5), no OpenCollection, no Hoppscotch / Thunder export, no environments for Insomnia.**

---

## 2. The source formats and what competitors do

Research of 2026-10-17. Items marked *(unverified)* come from known export files and should be checked against
real samples when the corpus is built (IMP-113).

### 2.1 Postman

* **Collection v2.0 / v2.1** (JSON Schema: https://schema.postman.com/collection/json/v2.1.0/draft-07/collection.json).
  Item = `request` (+ `id`, `name`, `description`, `variable[]`, `event[]`, `response[]`, `protocolProfileBehavior`);
  folder = `item[]` (+ `description`, `variable[]`, `event[]`, `auth`, `protocolProfileBehavior`); a folder is told
  apart only by having no `request`. Body modes `raw` (+ `options.raw.language`), `urlencoded`, `formdata`
  (text/file, `src`), `file`, `graphql`; `disabled`. Auth enum in the schema: `apikey`, `awsv4`, `basic`, `bearer`,
  `digest`, `edgegrid`, `hawk`, `noauth`, `oauth1`, `oauth2`, `ntlm`; the app also writes **`jwt`** and **`asap`**
  (https://learning.postman.com/v11/docs/use/send-requests/authorization/authorization-types,
  https://learning.postman.com/docs/use/send-requests/authorization/atlassian). v2.1 auth attributes are
  `[{key,value,type}]`, v2.0 a plain object; v2.1 URLs are always objects. Description is a string or
  `{content,type,version}`. Variables: `key`, `value` (any type), `type`, `description`, `disabled`.
* **`protocolProfileBehavior`** (full list, https://raw.githubusercontent.com/postmanlabs/postman-runtime/develop/docs/protocol-profile-behavior.md):
  `strictSSL`, `followRedirects`, `maxRedirects`, `disableCookies`, `disableBodyPruning`, `disableUrlEncoding`,
  `disabledSystemHeaders`, `insecureHTTPParser`, `followOriginalHttpMethod`, `followAuthorizationHeader`,
  `protocolVersion` (http1/http2/auto), `removeRefererHeaderOnRedirect`, `tlsPreferServerCiphers`,
  `tlsDisabledProtocols`, `tlsCipherSelection`.
* **Saved responses:** `originalRequest`, `responseTime`, `timings`, `header`, `cookie[]`, `body`, `status`, `code`.
* **Environment / globals:** `{id, name, values:[{key, value, type: default|secret, enabled}], _postman_variable_scope,
  _postman_exported_at}` (https://apis.io/schemas/postman/postman-environment/). Data dumps (admins) are a link to an
  archive of one JSON per item (https://learning.postman.com/docs/getting-started/importing-and-exporting/exporting-data).
  **Vault:** requests reference `{{vault:name}}`, scripts use `pm.vault`; exports carry only the reference
  (https://learning.postman.com/docs/use/postman-vault/use-vault-secrets) → flag as "value needed".
* **Collection format v3 (YAML, many files)** is now Postman's current schema
  (https://learning.postman.com/docs/collections/collections-schemas): any folder can be a collection root, one
  `*.request.yaml` per request with a sibling `<name>.resources/` (`examples/`, `scripts/`), `definition.yaml` for
  collection/folder metadata, fractional-index ordering, an explicit `type` per item (protocol-neutral). Newman
  cannot run it; the Postman CLI converts (`postman collection migrate`,
  https://learning.postman.com/docs/postman-cli/postman-cli-collections). **Native Git** adds `.postman/resources.yaml`
  (local file ↔ cloud id) and `postman/collections/…`, `postman/environments/<Env>.environment.yaml`
  (https://learning.postman.com/v11/docs/use/native-git/overview). No public field-level spec of the request YAML
  was found: build the parser from files produced by `postman collection migrate` on our corpus. **No competitor
  imports v3 yet: a differentiator.**
* **Dynamic variables:** 118 documented (3 plain + 115 `$random*`, faker-backed;
  https://learning.postman.com/docs/tests-and-scripts/write-scripts/variables-list/).
* **Sandbox** (https://learning.postman.com/docs/tests-and-scripts/write-scripts/postman-sandbox-reference/overview/):
  `pm.request/response/message/info/execution/variables/environment/collectionVariables/globals/iterationData/cookies/sendRequest/require/test/expect/visualizer/vault`,
  and new: **`pm.datasets`** (SQL over datasets), **`pm.mock`** (match saved examples), **`pm.state`** (persists
  across runs). TestPion lacks these three: add `tp.state` (small: backed by `.local/`), map `pm.mock` to the mock
  server's example matcher, `pm.datasets` to TestPion datasets (`listWorkspaceDatasets`). Until then they are
  `SCRIPT_API` findings (today `compat.ts` reports nothing for them: they would throw at run time).
* **Not exportable from Postman:** Flows, monitors, mock servers; multi-protocol collections (gRPC, WebSocket,
  Socket.IO, MQTT) cannot be exported at all; v1 collections are rejected even by Postman's own import. The
  migration guide therefore tells users to recreate these (TestPion flows, monitors, mock server) and the report
  says so when a collection references a mock URL (`*.mock.pstmn.io`).

### 2.2 Insomnia

* **Export** (https://developer.konghq.com/insomnia/import-export/): the app now exports **v5 YAML** (and HAR) only;
  v4 JSON is import-only. `inso export spec` exports OpenAPI.
* **v4:** `_type: export`, `__export_format: 4`, flat `resources[]` linked by `parentId`; `_type` ∈ `workspace`,
  `request`, `request_group`, `environment`, `cookie_jar`, `api_spec`, `grpc_request`, `websocket_request`,
  `websocket_payload`, `proto_file`, `proto_directory`, `unit_test_suite`, `unit_test` *(unverified list)*.
* **v5** (from source: https://raw.githubusercontent.com/Kong/insomnia/develop/packages/insomnia/src/common/insomnia-v5.ts):
  file types `collection.insomnia.rest/5.0`, `spec.insomnia.rest/5.0`, `environment.insomnia.rest/5.0`,
  `mock.insomnia.rest/5.0`, `mcpClient.insomnia/5.0`; `schema_version` separate (e.g. `"5.1"`). Collection:
  `meta`, `collection[]`, `cookieJar`, `environments` (base + `subEnvironments[]`, private ones only with
  `includePrivateEnvironments`), `spec`, `testSuites[{tests[{name, requestId, code}]}]`. Folders: `children`,
  **`headers`, `scripts{preRequest, afterResponse}`**, `authentication`, `environment`. HTTP: `body{mimeType, text,
  fileName, params}`, `parameters`, `pathParameters`, `scripts`, **`settings{renderRequestBody, encodeUrl,
  followRedirects, rebuildPath, cookies{send, store}}`**. Also gRPC (`protoFileId`, `reflectionApi`), WebSocket,
  **Socket.IO** (`eventListeners`) and **MCP clients** (`transportType`). Today's v5 importer reads none of
  scripts (request-level `scripts.preRequest/afterResponse` vs v4 `preRequestScript/afterResponseScript`: verify),
  folder headers, settings, spec, testSuites, cookie jar, gRPC/WS/Socket.IO/MCP items.
* **Template tags** (https://developer.konghq.com/insomnia/template-tags/): External Vault, Faker, Base64,
  Timestamp, UUID, OS, Hash, File, JSONPath, Cookie, Prompt, Response, Request; raw form
  `{% response 'body', 'req_…', 'b64::…', 'never', 60 %}` *(argument order unverified)*.
* **Scripting** (https://developer.konghq.com/insomnia/scripts/; after-response since 9.3): `insomnia.environment`
  (set/get/unset/replaceIn), `baseEnvironment`, `variables`, `collectionVariables` (= base environment),
  `request` (addHeader/removeHeader/body.update/auth.update/proxy/certificate), `response`, `test`, `expect`,
  `parentFolders.get/getById/getByName`, `sendRequest`, top-level await; `require` of ajv, atob, btoa, chai,
  cheerio, crypto-js, csv-parse, lodash, moment, postman-collection, tv4, uuid, xml2js and Node core modules
  (assert, buffer, events, path, querystring, url, util …). No `globals`, no `iterationData`, no legacy `postman.*`.
  TestPion gaps: `insomnia.parentFolders`, `request.auth.update/proxy/certificate`, `require('postman-collection')`
  and Node core modules → findings (or small shims: `url`, `querystring`, `path` are cheap).
* **Imports:** Insomnia v4/v5, Postman v2.0/2.1, HAR, OpenAPI 3.0/3.1, Swagger, WSDL, cURL.

### 2.3 Bruno

* **.bru grammar** (from source: https://raw.githubusercontent.com/usebruno/bruno/main/packages/bruno-lang/v2/src/bruToJson.js):
  blocks `meta`, `settings`, `tests`, `docs`, **`example`**, `headers`, `params:query`, `params:path`, `metadata`,
  `grpc`, `ws`; methods incl. **`http`** (custom method); `vars:pre-request`, `vars:post-response`, `assert`;
  auth `awsv4`, `basic`, `bearer`, `digest`, **`ntlm`, `oauth1`, `oauth2` (+ `additional_params` blocks), `wsse`,
  `apikey`, `akamai-edgegrid`**; bodies `json`, `text`, `xml`, `sparql`, `graphql`, `graphql:vars`,
  `form-urlencoded`, `multipart-form`, **`file`, `grpc`, `ws`**; scripts `pre-request`, `post-response` and gRPC
  hooks. Language rules: dictionary/text/array blocks, `~` disables (https://docs.usebruno.com/bru-lang/language).
  Today's parser (`bru.ts`) misses `settings`, `example`, `http`, `oauth1`, `ntlm`, `wsse`, `akamai-edgegrid`,
  oauth2 extras, `body:file/sparql/grpc/ws`, gRPC/WS requests.
* **Environments:** `vars` + `vars:secret` (values in the app only,
  https://docs.usebruno.com/secrets-management/secret-variables); `.env` at the root → `{{process.env.X}}`.
* **OpenCollection YAML:** YAML came with Bruno 3.0 and is **the default since 3.1** (2026-02-17,
  https://blog.usebruno.com/making-yaml-the-default-in-bruno-v3.1); `.bru` stays "for the near future". Layout
  (https://docs.usebruno.com/v3/opencollection-yaml/overview): `opencollection.yml` (`opencollection: "1.0.0"`),
  `environments/*.yml`, `<folder>/folder.yml`, one `.yml` per request (`info{name,type,seq}`,
  `http{method,url,body{type,data},auth}`, `runtime.scripts[{type,code}]`, `settings`). Spec and JSON Schema at
  spec.opencollection.com / schema.opencollection.com. **New Bruno users will have YAML, not .bru: this is a
  release-A item, not B.**
* **Script API** (https://docs.usebruno.com/testing/script/javascript-reference): `req` (getUrl/setUrl, getHost,
  getPath, getQueryString, getPathParams, getMethod/setMethod, getName, getTags, getAuthMode, headers +
  `headerList`, getBody/setBody, setTimeout, setMaxRedirects, onFail, disableParsingResponseJson), `res` (status,
  body, getStatus/StatusText/Header(s)/Body/setBody/ResponseTime/Size/Url), `bru` env/global/collection/folder/
  request/runtime vars, `getProcessEnv`, `getSecretVar`, `getOauth2CredentialVar`, runner
  (setNextRequest/skipRequest/stopExecution/iterationData/iterationIndex/totalIterations), `sendRequest`, `sleep`,
  `interpolate`, `runRequest`, `cwd`, `isSafeMode`, `getTestResults`, `getAssertionResults`, `cookies.jar()`,
  `grpc`. Script order: collection → folder → request pre-request; post-response the reverse
  (third-party: https://qaskills.sh/blog/bruno-api-testing-complete-guide) — **TestPion runs collection → folder →
  request for tests too (`types.ts:711`): the order differs; the report notes it for collections with several
  post-response levels.**
* **Bruno's importers** (https://docs.usebruno.com/get-started/import-export-data/import-collections.md): Bruno,
  OpenCollection, Postman (data dump in the paid edition), Insomnia v4/v5, OpenAPI 2/3, WSDL, git clone; no HAR or
  cURL file import. The pm → bru translator
  (https://raw.githubusercontent.com/usebruno/bruno/main/packages/bruno-converters/src/postman/postman-translations.js)
  tries an AST translation then a regex table; **unmapped calls pass through unchanged with no warning**
  (`pm.sendRequest`, `pm.iterationData`, `pm.visualizer`, `pm.vault`, `pm.require` are not mapped) and
  `pm.response.text()` becomes `JSON.stringify(res.getBody())` (wrong for non-JSON). Good ideas worth copying:
  `require` scan with "install / needs developer mode / unsupported" groups, "preserve scripts" option, clash
  choice Replace / New / Skip (https://docs.usebruno.com/import-export-data/postman-migration).

### 2.4 Other tools

* **Hoppscotch** (https://docs.hoppscotch.io/documentation/features/importer): imports Hoppscotch, Postman
  (environments incl. secrets; scripts *experimental, with consent*; advanced auth and collection settings dropped),
  Insomnia (no scripts/tests/advanced auth), OpenAPI (no bodies), HAR, cURL; 10 MB cloud / 50 MB self-hosted.
  Scripting (https://docs.hoppscotch.io/documentation/features/scripts): new default `hopp.*` sandbox
  (`hopp.env` active/global, `request`, `response.asJSON/asText/bytes`, `cookies`, `test`/`expect`, `fetch`) **with a
  `pm.*` compatibility layer** (no visualizer, collectionVariables, iterationData, setNextRequest, require), and
  legacy `pw.*`. Collection-level scripts since 2026.5.0. Collection JSON has a `v` version field.
* **Thunder Client** (https://docs.thunderclient.com/features/import, paid): imports Postman 2.1, Insomnia v4/v5,
  Hoppscotch, OpenAPI 3, `.env`, cURL. Scripts: `tc.*` (`tc.setVar(k, v, "request")`, `tc.loadModule` for cheerio,
  lodash, moment, tv4), `expect`; GUI tests stored as `tests[{type: "res-code", action: "equal", value}]`
  *(unverified)* (https://docs.thunderclient.com/scripting/postman).
* **Yaak**: one YAML file per model (`yaak.<id>.yaml`) for git sync
  (https://yaak.app/docs/using-yaak/local-directory-git-sync); imports Postman, Insomnia, OpenAPI/Swagger, cURL,
  and Bruno (2026.9.0). Its Bruno import **keeps unconverted scripts, tests, assertions and examples in the
  request description** (https://yaak.app/docs/migration/bruno) — the simplest "nothing silently lost" pattern;
  TestPion's report is the structured version of the same idea.
* **HTTPie Desktop**: imports Postman/Insomnia collections, environments and **data-dump zips**, cURL; skips
  gRPC/WS/body files, flattens sub-folders into breadcrumb names (https://httpie.io/blog/changelog-0021). Own JSON
  format with a published schema since 2025.2.0 (https://httpie.io/blog).
* **Paw / RapidAPI for Mac**: `.paw` is proprietary and undocumented; only community extensions export to Postman
  v2 (https://paw.cloud/extensions/PostmanCollectionV2Importer). Plan: document "export to Postman/OpenAPI first".
* **Apidog** imports Postman, OpenAPI/Swagger, cURL, Markdown, Insomnia, apiDoc, HAR, WSDL
  (https://docs.apidog.com/export-data-635117m0) and exports OpenAPI/Postman: import through those.
* **Kreya**: imports Postman and Insomnia v4/v5 (REST, GraphQL, gRPC, WebSocket); projects are plain JSON on disk
  (https://kreya.app/docs/import-from-other-tools/).
* **SoapUI**: XML project (`con:soapui-project`, `con:interface` with the WSDL, `con:testSuite/testCase/testStep`,
  Groovy) *(unverified)*. TestPion already imports WSDL; release C maps interfaces + request steps + simple
  assertions, Groovy as findings.
* **Standards:** HAR 1.2 (http://www.softwareishard.com/blog/har-12-spec/); OpenAPI 3.1 adds `webhooks` and
  `mutualTLS` security (https://spec.openapis.org/oas/v3.1.0); AsyncAPI 3 separates channels/operations/servers
  (https://www.asyncapi.com/docs/reference/specification/v3.0.0).

### 2.5 Who imports what (the bar)

| Tool | Imports |
|---|---|
| Postman | Postman v2, envs, globals, dumps; OpenAPI, Swagger, AsyncAPI, protobuf, GraphQL, Smithy; cURL; git repos; "Migrate to Postman" from SoapUI, Hoppscotch, Insomnia, Thunder Client (https://learning.postman.com/docs/getting-started/importing-and-exporting/importing-data/) |
| Insomnia | Insomnia v4/v5, Postman v2.0/2.1, HAR, OpenAPI 3.0/3.1, Swagger, WSDL, cURL |
| Bruno | Bruno, OpenCollection, Postman (+ script translation), Postman dump (paid), Insomnia v4/v5, OpenAPI 2/3, WSDL, git |
| Hoppscotch | Hoppscotch, Postman (experimental scripts), Insomnia, OpenAPI, HAR, cURL |
| Yaak | Postman, Insomnia, OpenAPI/Swagger, cURL, Bruno (.bru and YAML) |
| Thunder Client | Postman 2.1, Insomnia v4/v5, Hoppscotch, OpenAPI 3, cURL, .env |
| **TestPion today** | Postman v2.x + env, Insomnia v4/v5, Bruno folder/JSON/.bru, Hoppscotch, OpenAPI 2/3/3.1, AsyncAPI 2/3, Arazzo, WSDL, HAR, .http, .env, cURL/fetch/PowerShell/HTTPie snippets |

**What competitors do better today:** Bruno reads OpenCollection YAML and Postman dumps, translates the most common
`pm.*` calls, scans `require` with install hints, and offers Replace/New/Skip on clashes; Insomnia's v5 parser covers
folder scripts/headers, settings, Socket.IO and MCP items; Hoppscotch and HTTPie import Postman environments with
secret values and data-dump zips; Postman auto-detects an Insomnia install folder and imports git repos; Yaak keeps
unconverted scripts visibly in the description instead of dropping them.

**Where TestPion can be clearly best:** (1) its sandbox already runs nearly all of `pm.*` (sendRequest, visualizer,
vault, require packages, setNextRequest, cookie jar), which no competitor matches — scripts *work* after import,
not just "translate"; (2) **no one produces a structured per-item compatibility report** (converted / lossy /
unsupported, with the original kept) — TestPion will, in the UI, the CLI `--json` and MCP; (3) first to read
**Postman v3 / Native Git** folders; (4) Insomnia `{% response %}` chaining turned into working variables or flows;
(5) round trip back to Postman, Insomnia and Bruno; (6) AI cleanup of leftovers as reviewed, sandbox-verified
proposals.

---

## 3. Gap analysis

Legend: ✓ supported, **P** partial, ✗ not supported, — not applicable to that tool. "Today" is TestPion v0.48.1.

### 3.1 Matrix: source × feature

| Feature | Postman v2.x | Insomnia v4/v5 | Bruno folder/JSON | OpenCollection YAML | Hoppscotch | Thunder | Yaak | HTTPie | Apidog / Paw / SoapUI | OpenAPI |
|---|---|---|---|---|---|---|---|---|---|---|
| Requests, folders, order | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | ✗ (via their OpenAPI/Postman export) | ✓ (tags) |
| Query / path params, headers | ✓ | ✓ | ✓ | ✗ | P (no request vars) | ✗ | ✗ | ✗ | — | ✓ |
| Body json/xml/text/html | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | — | ✓ (sample) |
| Body urlencoded / multipart | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | — | P (keys only) |
| Body binary file | ✓ | ✗ | ✗ (`body:file`) | ✗ | ✗ | ✗ | ✗ | ✗ | — | ✗ |
| GraphQL | ✓ | ✓ | ✓ | ✗ | ✗ (GQL collections) | ✗ | ✗ | ✗ | — | — |
| gRPC / WebSocket / Socket.IO / MQTT | ✗ (not in v2.1 export) | ✓ v4, ? v5 | ✗ (dropped) | ✗ | ✗ | — | ✗ | — | — | — (AsyncAPI ✓) |
| Auth basic/bearer/apikey/digest | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | ✗ | — | ✓ |
| Auth OAuth 1 | ✓ | ✓ | — | ✗ | — | ✗ | ✗ | — | — | — |
| Auth OAuth 2 | P (grants, extras) | P (implicit) | P (basic fields) | ✗ | P (always CC) | ✗ | ✗ | — | — | P (→ bearer) |
| Auth AWS v4 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | — | — | — |
| Auth NTLM / Hawk / EdgeGrid / ASAP / WSSE / JWT | ✗ **silent** (→ inherit) | ✗ **silent** | ✗ **silent** | ✗ | ✗ | ✗ | ✗ | — | — | — |
| Inherit / none | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | — | — | ✓ |
| Collection/folder auth | ✓ | ✓ | ✓ | ✗ | ✓ | ✗ | ✗ | — | — | P |
| Collection/folder headers | — | ✗ (folder) | P (flattened) | ✗ | ✗ | ✗ | ✗ | — | — | — |
| Collection/folder scripts | ✓ | ✗ (folder) | ✓ | ✗ | — | ✗ | — | — | — | — |
| Collection/folder variables | ✓ | ✓ (folder env) | P (no post-response) | ✗ | ✗ | ✗ | ✗ | — | — | ✓ (baseUrl) |
| Scripts → runnable | ✓ (pm → tp) | P (needs `insomnia.`) | ✓ (shim, bru.*) | ✗ | ✗ (comments) | ✗ | — | — | — | — |
| Scripts → tp.* (rule) | ✓ | ✓ | ✗ (bru.*, `pm.` lines) | ✗ | ✗ | ✗ | — | — | — | — |
| No-code tests / assertions | — | — | ✓ (assert) | ✗ | — | ✗ (Thunder tests) | — | — | — | ✓ (status + contract) |
| Template chaining (`{% response %}`, Yaak `${[ ]}`) | — | ✗ **silent** | — | — | — | ✗ | ✗ | — | — | — |
| Dynamic variables | P (≈73/118) | ✗ (`{% faker %}`…) | P (same names) | ✗ | ✗ (`<<$x>>`) | ✗ | ✗ | — | — | — |
| Environments (+ base/sub) | ✓ (separate file) | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ | — | P (first server) |
| Globals | P (as an env) | — | P (global envs not exported) | — | P | ✗ | — | — | — | — |
| Secrets → "values needed" + secret store | P (blanked, not listed) | ✗ (private env) | P (names only) | ✗ | ✗ | ✗ | ✗ | — | — | — |
| Examples / saved responses | ✓ | — | ✗ | ✗ | ✗ | — | — | — | — | ✓ |
| Docs (request / folder / collection) | P (no folder) | P (no folder) | P (no folder) | ✗ | — | ✗ | ✗ | — | — | ✓ |
| Settings (redirects, SSL, timeout, cookies, encoding) | P (2 of ~12) | P (1 of 6) | ✗ | ✗ | — | ✗ | ✗ | — | — | — |
| Cookies / cookie jar | — | ✗ | — | — | — | — | — | — | — | — |
| Client certs / proxy | — | ✗ | ✗ (bruno.json) | ✗ | — | ✗ | — | — | — | — |
| API specs (design docs, API Builder) | ✗ (separate download) | ✗ (`api_spec`) | — | — | — | — | — | — | — | ✓ |
| Unit tests (Insomnia test suites) | — | ✗ | — | — | — | — | — | — | — | — |
| Flows / mocks / monitors | ✗ (not exportable) | ✗ (mocks) | — | — | — | — | — | — | — | (mock from examples ✓) |
| Round-trip export | ✓ v2.1 | ✗ | ✓ folder | ✗ | ✗ | ✗ | ✗ | ✗ | — | ✓ |
| Folder / zip / repo import | ✗ (data dump zip) | ✗ (git-sync folder) | ✓ folder, ✗ zip/repo | ✗ | — | ✗ | ✗ | — | — | URL ✓ |
| Report of what did not map | P (toasts, script-only) | P | P | — | P | — | — | — | — | P |

### 3.2 Top gaps by user impact (day one)

**Postman power user**

1. **No compatibility report.** Results are toasts that vanish; no per-item list, nothing to download, no preview
   before writing. A 600-request collection with 40 problems needs a report.
2. **Silent auth fallback to inherit** for NTLM, Hawk, EdgeGrid, JWT, ASAP: requests go out with the wrong
   credentials. Also OAuth 2 extras (implicit, refresh, token prefix, audience) lost.
3. **Dynamic variables:** about 45 of Postman's 118 names unknown (they render as empty or literal text).
4. **Data dump / zip / many files at once:** Postman's "Export data" gives one archive with every collection and
   environment; today the user imports them one by one, and globals become an environment.
5. **Settings** (cookies off, max redirects, URL encoding, TLS) and folder descriptions dropped.
6. **Secrets:** the user is not told which environment values they must re-enter.
7. (Smaller) Postman v3 / file-based collections from Postman's Git integration; `pm.require` packages from the
   team package library (warned, but the user has to copy the code by hand).

**Insomnia power user**

1. **Template tags (`{% response %}` chaining, `{% faker %}`, `{% uuid %}`, `{% now %}`, `{% base64 %}`,
   `{% hash %}`, `{% prompt %}`) are left as literal text**: the most common Insomnia setup (log in, then use the
   token via `{% response %}`) does not work after import, and nothing says so.
2. Folder-level scripts and headers (Insomnia 9+) dropped. **Likely bug to verify first:** v5 YAML (the only format
   Insomnia still exports) stores request scripts as `scripts.preRequest` / `scripts.afterResponse`, but
   `insomniaRequest` reads the v4 names `preRequestScript` / `afterResponseScript` (`other-tools.ts:131-132`), so
   v5 request scripts may be dropped silently; add a v5 fixture with scripts in IMP-111.
3. Design documents (`api_spec`) and unit test suites dropped silently.
4. NTLM/Hawk/ASAP/netrc auth → inherit silently; client certificates, cookie jar, request settings dropped.
5. Plain-JS scripts without `insomnia.` are commented out.
6. No export back to Insomnia.

**Bruno power user**

1. Scripts stay `bru.*` and lines are generated as `pm.*` (tp-not-pm rule broken), and shim calls that silently do
   nothing (`getProcessEnv`, `setTimeout`) or are missing (`bru.sendRequest`, `bru.runRequest`, `bru.cookies`,
   `bru.getSecretVar`, npm `require`).
2. `.env` + `{{process.env.X}}` not imported: every secret-based request breaks.
3. gRPC / WebSocket requests, `body:file`, `body:sparql`, NTLM/WSSE auth, `settings` blocks, examples silently dropped.
4. Folder headers flattened into requests (works, but round trip and editing suffer).
5. OpenCollection YAML (Bruno's new format) and zipped / GitHub-hosted collections cannot be imported.

**Everyone else:** Thunder Client (very common VS Code user base), Yaak, HTTPie desktop, Hoppscotch environments and
`pw.*` scripts, GraphQL SDL (detected but errors), Postman v1.

---

## 4. Plan

### 4a. One canonical intermediate model: the *import document*

Today every importer writes straight to `Collection` and each one re-implements auth, bodies, templates and scripts
(three `kv` helpers, four auth mappers). The plan puts one typed document in between:

```
source bytes ──► detect (content sniff) ──► parser (one per format, small, pure)
                                              │  produces
                                              ▼
                          ImportDocument  (normalised, lossless-as-possible, with provenance)
                                              │  shared mapping layers:
                                              │   auth · body · templates/variables · dynamic vars
                                              │   scripts (converter, section 4b) · settings · examples · docs
                                              ▼
                          Planner  ──► ImportPlan (what will be created/changed, ids, clashes) ──► preview
                                              │  apply (one transaction, undoable)
                                              ▼
                          Workspace items (collections, environments, specs, library items, flows, globals)
```

```ts
interface ImportDocument {
  source: { format: SourceFormat; version?: string; tool?: string; fileCount: number; bytes: number };
  collections: ImportCollection[];          // a data dump can hold many
  environments: ImportEnvironment[];        // with base/sub merged, secrets marked
  globals?: ImportVariable[];
  specs: Array<{ name: string; text: string; kind: 'openapi' | 'asyncapi' | 'graphql' | 'proto' | 'wsdl' }>;
  items: ImportItem[];                       // non-collection items: grpc, websocket, socketio, mqtt (by item kind)
  flows?: ArazzoFlowFile[];
  findings: ImportFinding[];                // everything the parser could not represent (never dropped silently)
}
interface ImportFinding {
  where: ItemPath;            // ["Users", "Create user"] + field ("auth", "settings.disableCookies", "script:test:12")
  sourceRef?: string;         // original id (_id, uid, file path) so the report can link back
  severity: 'info' | 'converted' | 'warning' | 'unsupported';
  code: string;               // e.g. AUTH_UNSUPPORTED, TEMPLATE_TAG, SCRIPT_API, SETTING_DROPPED, SECRET_VALUE_NEEDED
  message: string; suggestion?: string; original?: string;   // the original text, for "show me what it was"
}
```

* Items are typed by the **item-kind registry** (`kind: 'http' | 'graphql' | 'grpc' | 'websocket' | …`; today
  `COLLECTION_ITEM_KINDS` in `runner/collection-realtime.ts:121` plus the collection node kinds). When
  `planning/export-import.md` / `git-everything.md` define the registry, the import document reuses it as is; each
  kind supplies `fromImport()` / `toExport()` adapters, so a new protocol is importable without touching parsers.
* **Shared mapping layers** (`packages/core/src/import/map/`): `auth.ts` (one table: source type × fields →
  `AuthConfig`, unknown → a finding + `{ type: 'none' }` + a disabled header placeholder, *never* inherit),
  `body.ts`, `templates.ts` (`{{ _.x }}`, `<<x>>`, `{% tag %}`, `${[ x ]}`, `{{process.env.X}}`, `{{#guid}}` →
  TestPion syntax, section 4c), `settings.ts`, `examples.ts`, `vars.ts` (secret detection: declared secret, or a
  name/value that looks like one, reuse `Redactor`), `scripts.ts` (section 4b).
* **Exporters are the reverse:** `Collection → ExportDocument → writer per format`, with the same finding type, so
  the export report and the import report are one component.
* **Model additions needed for fidelity** (each small, each also useful outside import): folder `description`,
  folder/collection `headers` (Bruno, Insomnia 9+), folder/collection `settings` (Postman
  `protocolProfileBehavior`, Bruno `settings`), `HttpSettings.disableCookies` / `encodeUrl`, `AuthConfig` types
  `ntlm`, `hawk`, `edgegrid`, `asap`, `wsse` (or at least a typed `unsupported` holder that keeps the source
  config for round trip), OAuth 2 `implicit` / `device` grants + `refreshUrl`, `tokenPrefix`, `audience`/`resource`,
  `addTokenTo`; multipart field `contentType` already exists.
* **Provenance** is kept per item in `.local/meta.json` (not in the collection file, GIT-101 rule):
  `{ importedFrom: 'postman', sourceId }`. It lets a re-import **update** instead of duplicate (option in 4d) and
  makes the round trip keep the original ids.

### 4b. Script conversion engine

**Decision: always convert to `tp.*` on import (the tp-not-pm rule), with the existing runtime alias as the safety
net. No new "compat mode" sandbox.**

* The runtime alias already exists and is universal (`pm === tp`, `postman.*`, legacy globals, the Bruno shim). A
  separate per-script "compat" flag would add a second execution mode, a second set of docs and tests, and would
  keep `pm.*` in files forever. Converting gives readable, uniform files, and anything the converter could not
  rewrite still runs because of the alias. `--keep-pm` stays for teams who keep using the same collection in
  Postman.
* What changes is the **converter**: from identifier renaming to an **AST-based, per-API-member** converter with a
  report per script.

**Engine.** `packages/core/src/scripts/convert/`: parse with `acorn` (+ `acorn-walk`; ~150 KB, no transitive deps;
add to `@testpion/core` deps) in `ecmaVersion: 'latest'`, `allowAwaitOutsideFunction`, `allowReturnOutsideFunction`;
apply **positional edits** (splice by node range) so formatting and comments survive; scope analysis decides
whether `pm` is the global (no regex heuristics: `function (pm) {}` keeps its own `pm`, but the rest of the script is
still converted). A script that does not parse is kept as is (it still runs through the alias) and gets a
`SCRIPT_PARSE_ERROR` finding with line/column.

**Per-script result:** `converted` / `converted-with-warnings` / `kept` (parse error or unknown API) /
`not-convertible` (no equivalent: kept as a commented block with `// TODO(import): …` and the reason, *only* when the
code would throw at run time; otherwise it is left runnable). Line-level findings feed the report.

**Coverage table (source API → TestPion).** Full table lives next to the code (`convert/coverage.ts`) and is the
single source for the docs page and the tests.

| Source | Members | Target | Status |
|---|---|---|---|
| Postman | `pm.test`, `pm.expect`, `pm.response.*` (`code`, `status`, `json()`, `text()`, `headers`, `responseTime`, `to.have.status`, `to.be.ok` …), `pm.request.*`, `pm.variables/environment/globals/collectionVariables/iterationData.*`, `pm.info.*`, `pm.cookies.*`, `pm.sendRequest`, `pm.visualizer.*`, `pm.execution.*`, `pm.vault.*`, `pm.require` | `tp.<same>` | rename (exists today) |
| Postman legacy | `postman.setEnvironmentVariable/getEnvironmentVariable/…Global…/clear…`, `postman.setNextRequest`, `postman.getResponseHeader/Cookie`, `tests["x"] = expr`, `responseBody`, `responseCode.code`, `responseTime`, `responseHeaders`, `environment.x`, `globals.x`, `data.x`, `request.*`, `iteration`, `JSON.parse(responseBody)` | `tp.environment.set(…)`, `tp.execution.setNextRequest(…)`, `tp.response.headers.get(…)`, `tp.test("x", () => tp.expect(expr).to.be.ok)`, `tp.response.text()`, `tp.response.code`, `tp.response.responseTime`, `tp.environment.get('x')`, `tp.iterationData.get('x')`, `tp.response.json()` | new |
| Postman globals | `_` (lodash), `CryptoJS`, `atob/btoa`, `tv4`, `xml2Json`, `cheerio`, `require('…')` of built-ins | unchanged (available) | — |
| Postman flow control | `pm.execution.setNextRequest(name)` / `postman.setNextRequest` | kept (runner honours it) + finding `FLOW_SUGGESTION`: "this collection branches; a flow can express it" with a one-click *Make a flow* (dependsOn/if from the call sites) | new suggestion |
| Postman unknown | `pm.require('@team/pkg')` when the package is not in the workspace | kept + `SCRIPT_PACKAGE_MISSING` (exists today); offer "paste the package" | — |
| Insomnia | `insomnia.test/expect/environment/baseEnvironment/collectionVariables/variables/iterationData/request/response/sendRequest/cookies/vault/info/execution` | `tp.<same>` (`baseEnvironment` → `tp.collectionVariables`, with a finding) | direct (no pm hop) |
| Bruno | `bru.getEnvVar/setEnvVar/hasEnvVar/deleteEnvVar/getEnvName`, `bru.getVar/setVar/…`, `bru.getCollectionVar/getFolderVar/getRequestVar`, `bru.getGlobalEnvVar/setGlobalEnvVar`, `bru.interpolate`, `bru.setNextRequest`, `bru.runner.setNextRequest/skipRequest/stopExecution`, `bru.sleep`, `bru.sendRequest`, `bru.getSecretVar`, `bru.cookies.*`, `req.getUrl/setUrl/getMethod/setMethod/getHeader(s)/setHeader(s)/deleteHeader/getBody/setBody/getName`, `res.status/getStatus/getHeader(s)/getBody/body/getResponseTime/res('path')`, `test()`, `expect()` | `tp.environment.*`, `tp.collectionVariables.*` (runtime vars), `tp.globals.*`, `tp.variables.replaceIn`, `tp.execution.*`, `await new Promise(r => setTimeout(r, ms))`, `tp.sendRequest`, `tp.variables.get` (secret), `tp.cookies.jar()`, `tp.request.*`, `tp.response.*`, `tp.test`, `tp.expect` | new (shim stays as fallback) |
| Bruno no-ops | `req.setTimeout`, `req.setMaxRedirects`, `req.getAuthMode`, `bru.getProcessEnv`, `bru.cwd`, `bru.runRequest`, `require('axios')`, npm modules from `moduleWhitelist` | `req.setTimeout(ms)` → request `settings.timeoutMs` when constant (static lift) else finding; `bru.getProcessEnv('X')` → `tp.variables.get('$env.X')` (opt-in env access) or `{{$env.X}}`; `bru.runRequest('path')` → `tp.sendRequest` of the named request (new `tp.execution.runRequest`? owner decision D4) | new |
| Hoppscotch | `pw.test`, `pw.expect(x).toBe/toBeLevel2xx/3xx/4xx/5xx/toBeType/toHaveLength/toInclude` (+`.not`), `pw.env.get/set/resolve/getResolve/unset`, `pw.response.status/body/headers/responseTime`, `hopp.*` (new sandbox, Postman-like) | `tp.test`, `tp.expect(x).to.equal/…` (jest-style → chai mapping table), `tp.environment.*`, `tp.response.*` | new |
| Thunder Client | `tc.setVar/getVar`, `tc.response.*`, `tc.request.*`, `tc.test`, `expect`, `tc.runRequest`, `tc.loadModule`; no-code `tests[]` (`res-code`, `res-time`, `json-query`, `res-header`, `res-body` with `equal/contains/<`…), `set-env-var` actions | scripts → `tp.*`; no-code tests → **TestPion assertions** (`status`, `responseTime`, `jsonPath`, `header`, `body contains`) and `set-env-var` → extract rules | new |
| HTTP Client (JetBrains) | `client.test/assert/global.*`, `response.*`, `request.variables.*` | exists (`http-file.ts`) | — |

**Tests → assertions (optional lift).** A deterministic pass recognises the 15 most common `pm.test` shapes
(`pm.response.to.have.status(200)`, `pm.expect(pm.response.code).to.eql(200)`, `responseTime below N`,
`to.have.header('X')`, `pm.expect(json.x).to.eql(v)`, `to.have.jsonSchema(s)` …) and offers them as structured
TestPion assertions (visible in the Tests tab, readable by AI). Off by default on import (fidelity first), offered in
the report ("Lift 212 simple tests into assertions") and in Tidy up.

**AI for the leftovers (AI-10).** The report's "Fix with AI" sends only the unconverted fragments plus the API table
and returns a **reviewed proposal** (diff per script, verified by running the sandbox against the request's saved
example or a fake response, never against the real API). Human accepts per item. Works from CLI/MCP
(`testpion ai import-cleanup --json`, MCP `propose_import_fixes`).

### 4c. Dynamic variables and template tags

Target: every dynamic value a source tool can produce renders in TestPion. TestPion keeps Postman's names (they are
the de-facto standard, Bruno adopted them) and adds the missing ones in `vars/dynamic.ts`.

| Source | Syntax | TestPion |
|---|---|---|
| Postman / Bruno | `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomUUID}}`, `{{$random…}}` (118 documented) | same names; add the ≈45 missing (section 5). A unit test reads the list in `tests/fixtures/import/postman-dynamic-variables.json` (copied from the Postman docs page) and fails when a name is not in `DYNAMIC_VARIABLES` |
| Insomnia | `{% uuid 'v4' %}`, `{% now 'iso-8601' %}` / `'millis'` / `'unix'` / custom, `{% faker 'randomFirstName' %}` (Postman names), `{% base64 'encode', 'normal', 'x' %}`, `{% hash 'sha256', 'hex', 'x' %}`, `{% timestamp %}` | `{{$guid}}`, `{{$isoTimestamp}}` / `{{$timestampMs}}` / `{{$timestamp}}`, `{{$randomFirstName}}`; base64/hash → a one-line pre-request script that sets a request variable (finding `converted`) |
| Insomnia chaining | `{% response 'body', 'req_x', 'b64::JC50b2tlbg==::46b', 'never'\|'no-history'\|'when-expired'\|'always', 60 %}`, `'header'`, `'raw'`, `'url'` | Decode the `b64::` path; if the referenced request precedes this one in the same collection: add to the referenced request's test script `tp.collectionVariables.set('insomnia_<req>_<path>', tp.response.json()…)` (JSONPath via `jsonpath-plus`) and replace the tag with `{{insomnia_<req>_<path>}}`. Policy `always`/`when-expired` (send the other request first) → a **flow suggestion** (dependsOn) + `warning`. Unknown/unordered → `warning` with the original kept in the description. |
| Insomnia other | `{% prompt %}` | a variable with a finding "ask once: set it in the environment" |
| Insomnia other | `{% cookie %}`, `{% jsonpath %}`, `{% file %}`, `{% os %}`, `{% request %}`, plugin tags | finding `unsupported` with the original text; no silent literal |
| Bruno | `{{process.env.X}}` + `.env` | `.env` values → **secret store** (like `dotenv.ts`), reference → `{{X}}` in a "Bruno .env" environment; the report lists them as "values needed" if the `.env` was not included |
| Hoppscotch | `<<x>>`, `<<$guid>>`-style | `{{x}}` (exists), `{{$guid}}` |
| Thunder | `{{#guid}}`, `{{#date}}`, `{{#dateISO}}`, `{{#number}}`, `{{#string}}`, `{{#email}}`, `{{#bool}}`, `{{#enum, a, b}}`, `{{#date, 'YYYY-MM-DD'}}`; `{{var | filter}}` | `{{$guid}}`, `{{$timestampMs}}`, `{{$isoTimestamp}}`, `{{$randomInt}}`, `{{$randomAlphaNumeric}}`…, `{{$randomEmail}}`, `{{$randomBoolean}}`; filters/enum → pre-request script line |
| Yaak | `${[ var ]}`, `${[ response.body.path(...) ]}`, `${[ uuid.v4() ]}`, `${[ timestamp.iso8601() ]}`, `${[ faker… ]}` | same strategy as Insomnia |

**Rule:** a template the mapper does not know is never left as a silent literal: it gets an `unsupported` finding,
and the request is marked in the tree (the same "problem" badge the Problems view uses).

### 4d. Import UX

One **Import** dialog (existing `ImportModal`, extended; uniform-UI rule: the same component from File ▸ Import,
the palette, Explorer, Collections view and the Workspace menu), three steps in one modal:

1. **Source.** Choose files… (several at once), Choose folder… (any folder: Bruno, Insomnia git-sync `.insomnia/`,
   Postman v3 file collection, a folder of mixed files), paste, link. **Drag and drop** anywhere on the window
   (files, folders, `.zip`) opens the dialog at step 2. Links: a file URL (today), a GitHub/GitLab repo or tree URL
   (download the archive of that path, size-capped), a Postman public collection/workspace link (via the public
   `api.getpostman.com` collection JSON when the link carries it; private needs the user's Postman API key, typed
   by the user in the dialog, kept in the secret store, never logged: owner decision D3). Format is detected **by
   content** (never by extension); zip entries are detected one by one.
2. **Preview.** A tree of what will be created (collections, folders, requests with method badges, environments,
   specs, gRPC/WebSocket items, flows), with per-item status icons (mapped / converted / warning / unsupported) and
   counts. Options: target (new collection, or merge into an existing one; re-import of the same source updates by
   provenance id instead of duplicating), keep folder structure / flatten, environments → TestPion environments
   (base + sub merged as today, or as one environment with sub-environments if GIT/env work adds them), secrets →
   listed as **values needed** with inline fields that write straight to the secret store, name clashes (rename /
   replace / skip), scripts (convert to tp.* / keep pm.* / lift simple tests into assertions), dynamic variables
   (convert template tags). Nothing is written yet.
3. **Import and report.** Writes in one transaction; progress bar for big inputs (streamed parse, batched saves,
   cancellable); then the **Compatibility report**.

**Compatibility report** (a panel, reopenable from the collection's header ▸ *Import report*, stored in
`.local/import-reports/<id>.json`):

* Header: source tool + version, counts — requests, folders, environments; **mapped**, **converted** (scripts,
  template tags), **warnings**, **unsupported**, **values needed**.
* Grouped list by code (Auth not supported (3), Template tags (12), Script APIs (5) …) and by item; each row links
  to the item (opens the request at the field) and shows *Original* vs *Imported* (the original text kept in the
  report, redacted by the `Redactor`).
* Actions: *Fix with AI* (AI-10 proposal), *Lift tests into assertions*, *Make a flow* (setNextRequest/chaining
  suggestions), *Set values needed*, *Download report* (JSON + Markdown), *Undo import*.
* **Undo:** the whole import is one undo step (Ctrl+Z right after, or *Undo import* in the report while nothing in
  the imported items has been edited since; implemented as "delete what this import created", using the plan's
  list of created ids, through the trash so it is recoverable).
* Post-import check: **no automatic run** (production guard; the imported environment may point at production).
  The report offers *Run against a mock* (TestPion's mock server from the saved examples) as a safe smoke test and,
  as an idea only, *Compare with the source tool* (paste a Newman/Bruno CLI JSON report and diff statuses/tests).

Performance targets: 10,000 requests parse + preview < 2 s, apply < 5 s; the preview tree is virtualised (existing
tree virtualisation); memory < 300 MB for a 50 MB input.

### 4e. Round trip / export

| Target | Today | Plan | Fidelity notes |
|---|---|---|---|
| Postman v2.1 collection + environment | ✓ | add folder description/headers (as each request's headers with a finding), settings → `protocolProfileBehavior`, new auth types, examples with cookies/time, original ids from provenance | tp → pm; assertions other than status become `pm.test` code (today: dropped with a note) — generate tests instead of dropping |
| Postman data dump (zip) | ✗ | export a workspace as Postman's archive layout | for users going back |
| Insomnia v4 JSON | ✗ | new | tp → `insomnia.*`; `{{x}}` → `{{ _.x }}`; chaining via scripts |
| Insomnia v5 YAML | ✗ | new (preferred for Insomnia 10+) | environments + sub-environments |
| Bruno folder | ✓ | folder headers, settings, examples, `.env` template (names only), tp → bru where 1:1 (option; Bruno also runs much of `pm.*` via its translator) | |
| OpenCollection YAML | ✗ | new (Bruno's default format since 3.1) | |
| OpenAPI 3.1 | ✓ | security schemes from auth, examples | |
| Hoppscotch / Thunder | ✗ | later (release C), on demand | |

Round-trip guarantee tested as a property: `import(export(c)) ≈ c` for TestPion → X → TestPion on every field X can
hold, and `export(import(x)) ≈ x` on the corpus for Postman and Bruno (normalised JSON diff, ids via provenance).

### 4f. CLI, MCP, docs

* `testpion import <file|dir|zip|url>... -w <ws> [--from auto|postman|insomnia|bruno|opencollection|hoppscotch|thunder|yaak|httpie|openapi|har|…] [--preview | --apply] [--report report.json|report.md] [--into <collection>] [--on-clash rename|replace|skip] [--scripts tp|keep] [--lift-tests] [--json]`.
  `--preview` (default for several files or a zip in non-interactive mode? owner decision D5) prints the plan and the
  report without writing; exit code 0, or 3 when unsupported items exist and `--strict` is given.
* `testpion export <collection> --format postman|insomnia|insomnia-v5|bruno|opencollection|openapi|http|asyncapi --report …`.
* `testpion import-report <id> [--json]` re-prints a stored report.
* MCP: `import_definition` gains `files` (several), `folder` (local path, read-only, workspace-relative or
  allow-listed), `preview: true`, `from`, `on_clash`; new `export_collection` (`format`), `get_import_report`,
  `propose_import_fixes` (AI-10). `llms.txt` and `docs/cli/reference.md` updated (llms.txt by its owner, not here).
* Docs: `docs/migrate/postman.md`, `insomnia.md`, `bruno.md`, `others.md` — what comes over, a feature-mapping
  table, the script API table, dynamic variables, screenshots of the preview and the report; and
  `docs/migrate/compatibility.md`, **generated** from `convert/coverage.ts` + the importer capability table (the
  same tables the tests assert), so docs cannot drift.

### 4g. Test corpus and strategy

* **Corpus** in `tests/fixtures/import/<tool>/<case>/` with `input.*` and `expected.json` (the normalised
  `ImportDocument` + report, ids replaced by stable hashes of the source path). Sources: synthetic files covering
  every field of each schema (generated from the schema enums: every auth type, body mode, setting); public samples
  with permissive licences (Postman's public API network templates, Bruno's and Insomnia's example repos, the
  OpenAPI petstore, Hoppscotch's sample), stored with their licence and source URL; version variants (Postman v2.0
  and v2.1, Insomnia v4 and v5.0/5.1, Bruno 1.x/2.x `.bru`, OpenCollection).
* **Golden tests per importer** (`tests/unit/import-golden.test.ts`): parse → normalised document equals
  `expected.json`; update with `UPDATE_GOLDEN=1`.
* **Round-trip property tests** (fast-check, already a devDependency? if not: add): random collections within the
  intersection of features → export → import → equal.
* **Script-conversion corpus** ≥ 200 real snippets (`tests/fixtures/import/scripts/<tool>/*.js` + `*.expected.js`)
  from public collections and the official docs (paraphrased into our own tests where licences require), each
  **executed** in the sandbox against a fake request/response before and after conversion: the same tests pass/fail
  and the same variables are set (behavioural equivalence, not text equality).
* **Hostile inputs** (`tests/unit/import-hostile.test.ts`): zip bombs (ratio and total caps), 200 MB body, 50-level
  nesting, `__proto__`/`constructor` keys (prototype pollution; parse with null-prototype objects), path traversal
  in Bruno folder names and zip entries (`../../x`, absolute, drive letters, NUL), symlinks in folders, Windows
  reserved names, scripts that would do something if run (**scripts are never executed during import**: assert the
  sandbox is not created), YAML anchors/billion-laughs (`yaml` `maxAliasCount`), invalid UTF-8, BOMs.
* **Performance:** `tests/perf/import-10k.test.ts`: 10,000 requests, 500 folders, 50 environments: parse + plan
  < 2 s, apply < 5 s, heap < 300 MB (quality-bar rule: a release gate).
* **E2E** (extend `apps/desktop/e2e/plans/import-collections.cjs`, run only in the final regression per the
  regression-at-the-end rule): drag a Postman file → preview tree → import → report shows the expected counts →
  open a converted request (tp.* in the editor) → run against the demo server → all tests pass; the same for an
  Insomnia file with `{% response %}` chaining and a Bruno folder with `.env`; undo import.

### 4h. AI-first parity

Every capability above has: a CLI command with `--json`, an MCP tool, docs/llms.txt entries, and an AI assist in the
app with human review:

| Capability | CLI | MCP | App AI |
|---|---|---|---|
| Preview / import | `import --preview/--apply --json` | `import_definition {preview}` | — |
| Report | `import-report --json` | `get_import_report` | "Explain this report" |
| Fix leftovers | `ai import-cleanup --json` | `propose_import_fixes` | Fix with AI (reviewed proposal, AI-10) |
| Export | `export --format … --report` | `export_collection` | — |
| Script conversion | `scripts convert --from postman|bruno|insomnia|hoppscotch|thunder --to tp --report` | `convert_scripts` | per-script "Convert with AI" for `not-convertible` |

The agent prompt `import_and_test` (`agent-kit.ts:248`) is updated to: preview, import, read the report, fix values
needed with the user, run against the mock, then propose tests.

### 4i. Roadmap

**Release A — "Switch from Postman, Insomnia or Bruno today"** (≈ 4–5 weeks)

| Id | Item | Size |
|---|---|---|
| IMP-101 | `ImportDocument` + findings type; port Postman, Insomnia, Bruno, Hoppscotch to parsers + shared mappers (behaviour-preserving first: existing tests stay green) | L |
| IMP-102 | No silent drops: every unmapped field becomes a finding; unknown auth → none + finding (never inherit) | M |
| IMP-103 | Compatibility report panel (shared component), stored reports, download JSON/MD, CLI `--report`, MCP `get_import_report` | M |
| IMP-104 | Preview step (plan without writing), name clash options, values-needed fields to the secret store; undo whole import | L |
| IMP-105 | Drag and drop of files/folders on the window; multi-file pick; folder pick for any tool | S |
| IMP-106 | Script converter v2 (acorn AST, scope-aware, per-script report) for pm/postman legacy/insomnia/bru → tp; fix `brunoVars` `pm.` lines; shim fills (`bru.sendRequest`, `bru.getSecretVar`, `bru.cookies`, `req.setTimeout` lift) | L |
| IMP-107 | Insomnia template tags: `{% uuid/now/faker/base64/hash/prompt %}`, `{% response %}` chaining → extract + variable (+ flow suggestion) | M |
| IMP-108 | Dynamic variables: add the ≈45 missing Postman `$random*` names (118 total); Thunder `{{#…}}` and Hoppscotch forms in the template mapper | S |
| IMP-109 | Model fidelity: folder description + headers + settings, collection headers/settings, `disableCookies`/`encodeUrl`, OAuth 2 implicit/device/refresh/prefix | M |
| IMP-110 | Auth types NTLM, Hawk, EdgeGrid, ASAP/JWT mapping (JWT exists), WSSE; or a typed `unsupported` holder kept for round trip (owner decision D2) | M–L |
| IMP-111 | Bruno: **OpenCollection YAML** (the default since Bruno 3.1), `.env` + `process.env`, `settings`, `body:file`, `example`, `http` custom method, oauth1/ntlm/wsse/edgegrid, gRPC/WS items, collection post-response vars; Insomnia: folder scripts/headers, `api_spec` → specs/, unit tests → test scripts, v5 gRPC/WS check, settings, cookie jar → workspace jar | M |
| IMP-112 | Postman: data dump zip (fflate, caps), globals → workspace globals, secrets listed, all `protocolProfileBehavior`, collection v1 | M |
| IMP-113 | Corpus + golden + hostile + 10k perf tests; e2e plan extension | M |
| IMP-114 | Docs: migration guides + generated compatibility matrix | S |

**Release B — "Every other tool, and back"** (≈ 4 weeks)

| Id | Item | Size |
|---|---|---|
| IMP-201 | Thunder Client collections + environments (scripts, no-code tests → assertions) | M |
| IMP-202 | Yaak export (incl. `${[ ]}` templates), HTTPie desktop collections, Apidog JSON (or via its OpenAPI/Postman export, documented), GraphQL SDL (fix the dead `graphql-sdl` detection: a GraphQL endpoint request + schema), Postman v3 / Native Git folders (first to market), Insomnia git-sync folder | L |
| IMP-203 | Hoppscotch environments + `pw.*`/`hopp.*` → tp converter + GraphQL collections | M |
| IMP-204 | Exporters: Insomnia v4 + v5, OpenCollection, Postman improvements; export report | L |
| IMP-205 | URL import: GitHub/GitLab repo or tree (archive of a path), Postman public links; optional Postman API key | M |
| IMP-206 | MCP `export_collection`, `convert_scripts`, `propose_import_fixes` (AI-10 import cleanup as reviewed proposals) | M |
| IMP-207 | Lift simple tests into assertions (deterministic) + Tidy-up integration | S |
| IMP-208 | Re-import updates by provenance (sync from a Postman/Bruno source repeatedly) | M |

**Release C — polish and breadth** (ongoing): SoapUI projects (SOAP + REST, assertions), Paw/RapidAPI (via its
export extensions), Kreya, RAML; corpus to ≥ 50 real collections and ≥ 500 script snippets; "Compare with the source
tool" (Newman/Bruno CLI report diff); Hoppscotch/Thunder export on demand; telemetry-free "report a failed import"
that makes a redacted bug report file.

**Risks.** AST converter regressions on odd scripts (mitigation: behavioural corpus, fall back to the original text
when the converted one fails to parse, alias always on); format churn (Postman v3, OpenCollection and Insomnia v5
move fast: version-gated parsers, `detect` reports the version, unknown versions import best-effort with a finding);
licence of public sample collections (store only permissively licensed ones, or synthetic equivalents); scope
creep across a dozen tools (release A is only the big three + report); model changes ripple into the editor,
runner, exporters and git merge driver (each model addition gets its own small item and tests); secrets in source
files (never written to workspace files; the report shows names only).

**Owner decisions.**

* **D1** Confirm: always convert to `tp.*`, keep the universal runtime alias, no separate compat sandbox mode
  (recommended).
* **D2** New auth types (NTLM needs a multi-round handshake in the HTTP layer; Hawk/EdgeGrid are signing schemes like
  AWS v4) vs a typed `unsupported` holder that only round-trips (recommended: EdgeGrid + Hawk + NTLM real, ASAP via
  JWT, WSSE as a header generator).
* **D3** Postman API key for private links/workspaces: allowed (user-typed, secret store) or files only.
* **D4** Bruno `bru.runRequest` / Thunder `tc.runRequest`: add `tp.execution.runRequest(name)` (runs a saved
  request from a script) or convert to `tp.sendRequest` with a finding.
* **D5** CLI default for multi-file/zip/folder input: preview first (`--apply` needed) or apply directly as today.
* **D6** Folder headers/settings as real model fields (recommended) vs keep flattening.
* **D7** Name and placement: a "Migrate from…" entry on Home for first-run users (opens the same dialog with the tool
  preselected and short how-to-export instructions per tool).

---

## 5. Appendix: dynamic variable gap list

Postman documents 118 dynamic variables
(https://learning.postman.com/docs/tests-and-scripts/write-scripts/variables-list/). TestPion has about 73 of them
(`vars/dynamic.ts:44-120`; `$uuid` and `$timestampMs` are TestPion extras). Missing, by group (from the Postman
list as known; IMP-108 verifies with the fixture copy of the page):

* **Images (13):** `$randomAbstractImage`, `$randomAnimalsImage`, `$randomBusinessImage`, `$randomCatsImage`,
  `$randomCityImage`, `$randomFoodImage`, `$randomNightlifeImage`, `$randomFashionImage`, `$randomPeopleImage`,
  `$randomNatureImage`, `$randomSportsImage`, `$randomTransportImage`, `$randomImageDataUri` (placeholder URLs; the
  data URI a tiny inline PNG).
* **Finance (6):** `$randomBankAccountName`, `$randomBankAccountBic`, `$randomBankAccountIban`,
  `$randomCreditCardMask`, `$randomBitcoin`, `$randomTransactionType` (fake/test values only).
* **Business and catch phrases (7):** `$randomBs`, `$randomBsAdjective`, `$randomBsBuzz`, `$randomBsNoun`,
  `$randomCatchPhraseAdjective`, `$randomCatchPhraseDescriptor`, `$randomCatchPhraseNoun`.
* **Databases (4):** `$randomDatabaseColumn`, `$randomDatabaseType`, `$randomDatabaseCollation`,
  `$randomDatabaseEngine`.
* **Grammar (5):** `$randomAdjective`, `$randomNoun`, `$randomVerb`, `$randomIngverb`, `$randomPhrase`.
* **Files (5):** `$randomCommonFileName`, `$randomCommonFileType`, `$randomCommonFileExt`, `$randomFilePath`,
  `$randomDirectoryPath`.
* **Profession / names / text / lorem (≈5):** `$randomJobDescriptor`, `$randomJobType`, `$randomLoremLines`,
  `$randomLoremText`, `$randomNamePrefix` variants as listed.

Other tools' forms map onto these names (section 4c): Insomnia `{% faker 'name' %}` uses the same names, Bruno uses
Postman's names, Thunder's `{{#guid}}`-family and Hoppscotch's forms are rewritten by the template mapper.
