---
title: "Collections"
description: "Organise requests in collections and folders with variables, inherited auth, scripts, import/export and versioning."
---

::: v-pre

# Collections

Collections hold folders and requests (REST and GraphQL), plus collection-level variables, auth (inherited by requests set to *Inherit*), and pre-request and test scripts.

Each collection is a versioned JSON file under `collections/` in the workspace, and its `version` increments on every save. Commit it to git for review and history.

## Overview

A collection's **Overview** tab shows it at a glance: how many requests and folders it has, how many have checks (assertions or a test script), how many REST requests are documented, and how many are failing now (their latest response failed its checks, or, without checks, had an error status). *By method* counts the requests per HTTP method. *Request health* lists the requests sent from the app with their latest status, median response time (of the latest 50), how many of their responses failed and when they were last sent: failing requests first, then the slowest, each with its latest results as a strip. The chips above it switch to the requests **Not sent yet** or **Without checks**, with their counts (long lists show 100 at a time, **Show all** the rest). When nothing has been sent yet, it says so once and offers **Run the collection**. Click a request to open it. *Where the time went* adds up the DNS lookup, TCP connect, TLS handshake, server wait and download of the responses sent from the app (also the `collection_timing` MCP tool).

*Recent runs* shows the pass / fail of the collection's latest runs (Collection Runner and `run-collection`) with a link to the last one. *Variable flow* shows how requests chain: each variable a script sets (`pm.environment.set`, `pm.collectionVariables.set` …), which request or collection / folder script sets it and how many requests use it (`{{name}}` or a script `get`), in run order. It flags variables *used before they are set* (a request uses one before any earlier script sets it and no environment defines it), *never set* and *set, never used*. The `variable_flow` MCP tool returns the same.

For scripts and agents: `testpion requests "My API" --health --json` in the CLI and the `collection_health` MCP tool return the same numbers.

## Favorites

To keep frequently used endpoints close at hand, choose **Add to favorites** from a REST or GraphQL request's **⋯** menu (or right-click). The request gets a star in the tree and appears in the **Favorites** section at the top of the explorer, with its collection's name; click it to open it, or use its menu to remove it. Favorites are stored with the request in the collection JSON.

To open or fold a whole collection or folder at once, use **Expand all** / **Collapse all** in its **⋯** menu (the explorer's **Collapse all** button folds every collection).

## Request menu

Right-click a request in the tree, or click its **⋯** button:

| Item | What it does |
|---|---|
| **Open in tab** | Open the request. |
| **Rename**, **Duplicate**, **Add to favorites** | Manage the request. |
| **Move to…** | Move it to another folder, or to a folder of another collection. Open tabs follow it. You can also drag it: onto a request to place it before that one, onto a folder to put it inside, or onto a collection's name for its top level. |
| **Copy URL** | The URL with `{{variables}}` resolved from the active environment. |
| **Copy as cURL (bash)**, **cURL (cmd)**, **PowerShell**, **fetch** | A runnable command or code, like the browser's *Copy as …*, with variables resolved and inherited auth applied. `fetch` code also runs in Node.js 18+. |
| **More code snippets…** | Open the request with the code generator (Python requests and httpx, Go, Java, Kotlin, C#, Dart, HTTPie and more). |
| **Delete** | Delete the request after a confirmation. The message that follows has **Undo** for a few seconds. |

Copied commands include the request's real header and token values, so they run as they are, like Postman's *Copy as cURL*. When they do, the confirmation message says so. Folders have their own menu (Run, Monitor on a schedule, Edit folder, New HTTP request, New folder, Rename, Move to…, Delete).

## Tidy up

**Tools ▸ Tidy up…** in a collection's header finds what piles up in big or imported collections:

- **Duplicate requests**: the same method, URL and body (query parameter order and spacing don't matter).
- **Hosts typed into URLs**: `http://localhost:5002/…` instead of `{{bannerManagementBaseUrl}}/…`. **Use a variable…** opens **Replace** with the host filled in.
- **Empty folders**, and **unused variables** (collection variables no request or script reads).

Tick the fixes to make (remove the copies of duplicates, keeping the first; remove empty folders; remove unused variables) and **Remove what is ticked**; **Undo** in the message puts the collection back. From the terminal, `testpion tidy "Master Collections"` lists them and `--remove-duplicates`, `--remove-empty-folders` and `--remove-unused-variables` fix them; agents use `collection_tidy`.

## Find and replace

**Tools ▸ Find and replace…** in a collection's header changes text across its requests at once: a host that moved, a header that was renamed, a value that should become a `{{variable}}`.

1. Type what to **Find** and what to **Replace with**. Every change appears below as you type: the request, where (the URL, a header, a parameter, the body, an auth field, a script or the name), and the text before and after.
2. Narrow it with **Match case**, **Regular expression** (`$1` … for groups) and the **Look in** chips.
3. **Replace** saves the changes; **Undo** in the message puts the collection back.

From the terminal, `testpion replace "Master Collections" "http://localhost:5002" "{{bannerManagementBaseUrl}}" --in url` shows the changes and `--apply` saves them; agents use `replace_in_collection`.

## Import

**Import** accepts:

- OpenAPI 3 / Swagger 2 (JSON or YAML). Tags become folders, parameters and example bodies are generated, security schemes map to auth, and each documented response becomes a saved [example](#examples) (so the collection can be [mocked](/api-testing/mock-servers) right away). The document is kept in the workspace's `specs/` folder and every request gets a [**Matches OpenAPI contract**](../test-runner/assertions.md#openapi-contract-testing) check, so running the collection tests the API against its own contract (`testpion import --no-contract-checks` leaves the checks out).
- Postman v2.1 collections (including scripts, request descriptions and saved responses, which become [examples](#examples)) and environments.
- Insomnia exports (the v4 JSON export and v5 YAML files). Environments come over too: the base environment is merged into each sub-environment. From a v4 export, gRPC requests (with their `.proto` files) and WebSocket requests come over as the collection's gRPC calls and connections.
- Bruno collections: the collection folder itself (**Bruno folder…**, the folder with `bruno.json` and the `.bru` files you keep in git), a single `.bru` request file, or a JSON export (*Export collection*). See [Bruno](#bruno) below.
- Hoppscotch collections (JSON).
- WSDL 1.1 and 2.0 documents of SOAP services (a file, or a `?wsdl` link). See [SOAP](#soap-wsdl) below.
- AsyncAPI 2 and 3 documents of event-driven APIs (Kafka, MQTT, WebSocket, Socket.IO). See [AsyncAPI](#asyncapi) below.
- `.http` / `.rest` files of VS Code's REST Client and the JetBrains HTTP Client. See [.http files](#http-files) below.
- HAR files.

From Insomnia, Bruno and Hoppscotch, TestPion takes folders, requests, bodies, headers, parameters, auth and variables. `{{ _.name }}` and `<<name>>` become `{{name}}`. Insomnia's pre-request and after-response scripts run: its `insomnia.*` script API follows Postman's, so `insomnia.test`, `insomnia.expect`, `insomnia.environment` and `insomnia.response` become their `pm.*` twins. Bruno scripts and tests run as they are (`bru`, `req`, `res`). Hoppscotch scripts use their own API (`pw.*`), so they come over as comments to rewrite with `pm.*` / `tp.*`. An imported environment never replaces one you already have: a name that's taken gets *(imported)* added.
- TestPion collections and workspace exports.
- A single request copied as cURL (bash or cmd), fetch or PowerShell. It is saved to the **Imported** collection, named after its method and path. Secrets in it (tokens, API keys, cookies, passwords) are replaced by `{{variables}}`, and a message lists the ones to add as secret environment variables. To just try the request without saving it, paste it into the REST view instead (see [paste a request](/api-testing/rest#paste-a-request-from-the-browser)).

If a Postman collection's scripts use something TestPion's script sandbox doesn't have (a `pm.require` package the workspace doesn't have yet, or a `require()` of a module the sandbox doesn't have: it has ajv, atob, btoa, chai, cheerio, crypto-js, csv-parse, lodash, moment, tv4, uuid and xml2js), the import says which requests and what to use instead (`scriptWarnings` in `testpion import --json` and the MCP tool).

A Postman import keeps collection-level and request scripts, path variables, OAuth 2.0 settings, GraphQL bodies (as GraphQL requests), descriptions and saved responses.

### SOAP (WSDL)

A WSDL 1.1 or 2.0 document becomes a collection of SOAP requests, one folder per SOAP port or endpoint (SOAP 1.1 and SOAP 1.2 are both kept; WSDL 2.0 endpoints are SOAP 1.2 unless the binding says `wsoap:version="1.1"`, operations inherited through `extends` are included, and HTTP bindings are skipped; with a single port there is no folder level). Each operation is a `POST` to `{{baseUrl}}` (the service address, set as a collection variable) with:

- the right headers: `Content-Type: text/xml` and `SOAPAction` for SOAP 1.1, `Content-Type: application/soap+xml; action=…` for SOAP 1.2;
- a sample envelope built from the XML Schema in the WSDL's `<types>`: every element of the input message with a placeholder value (`?` for text, `0` for numbers, `false`, the first value of an enumeration, dates), including the fields of base types (`extension`), with document/literal and RPC styles;
- a status 200 check (a SOAP Fault comes back as 500 in SOAP 1.1).

Replace the placeholders and send. The response is XML: `xml2Json(pm.response.text())` turns it into an object for tests. Schemas and WSDLs it imports (`xsd:import`, `xsd:include`, `wsdl:import`, like the `?xsd=xsd0` and `?wsdl=wsdl0` documents of JAX-WS and WCF services) are fetched from the same site for a link, or read from next to the file for a file.

To try it, run the [demo servers](/getting-started/installation#try-it-with-the-demo-servers) and import the link `http://127.0.0.1:4010/soap/patients?wsdl` (`GetPatient` with id `1` or `2`, `RegisterPatient`).

### .http files

A `.http` or `.rest` file becomes a collection named after the file, one request per `###` block:

- `@name = value` lines become collection variables, and `{{name}}` works as everywhere in TestPion.
- `### Title` or `# @name login` names a request; query lines that continue the URL on the next lines are joined.
- `Authorization: Basic user password` becomes basic auth and `Authorization: Bearer …` bearer auth; other headers stay as they are.
- Form bodies become form fields, JSON and XML bodies stay as written, and `< ./file.json` is a body from a file (check the path after importing).
- REST Client chaining works: a named request that another one reads (`{{login.response.body.$.access_token}}`, `{{login.response.headers.X-Token}}`) keeps its response for it, so the token flows to the next request when the collection runs.
- JetBrains response handlers (`> {% … %}`) become the request's test script and pre-request scripts (`< {% … %}`) its pre-request script. They run as written: `client.test`, `client.assert`, `client.global.set`, `response.body`, `response.status` and `request.variables.set` map to `tp.*`. A handler kept in a separate `.js` file isn't imported, and the import says so.

**Export ▸ .http file** writes a collection back as one file for those tools: folders become the request titles, collection variables `@name = value` lines, and bearer, basic and header API key auth (inherited from a folder or the collection too) an `Authorization` or key header. Scripts and non-HTTP requests are left out, and a message lists them.

### AsyncAPI

An AsyncAPI document becomes a collection of [realtime connections](/api-testing/websocket), one per channel, in folders by the operations' first tag:

- **Servers** become an environment named after the API, such as *Clinic events servers*, with a variable per server (`{{productionUrl}}` = `kafkas://broker.example.com:9093`). The connections use the channel's server, or the first one.
- **Kafka:** the channel's address is the topic to produce to, with the first message's example payload, its key (from the Kafka binding) and its headers. When the application sends on the channel, the topic is also read on connect.
- **MQTT:** the topic to publish to, with the channel's QoS; when the application sends on it, the topic filter is subscribed on connect (`{parameters}` become `+`).
- **WebSocket:** the channel's address is a path on the server; **Socket.IO:** it is the event.
- Every message a channel carries is kept as a saved message to send again, built from its first example or its schema. `{parameters}` in addresses become `{{variables}}`.

Who sends what follows the document: in AsyncAPI 2, `publish` is what the application receives (TestPion sends it) and `subscribe` what it sends (TestPion reads it); in AsyncAPI 3, `action: send` and `receive` say the same. Channels on other protocols (AMQP, NATS …) are listed in the collection's description as not imported.

The document is kept in `specs/asyncapi/` and listed under **API definitions** (marked ASYNC): its **Preview** shows the servers and each channel, whether the API publishes or consumes there, and its messages with payloads and examples, with **Generate tests**. It is also used by the [`asyncapi` check](/api-testing/websocket#check-messages-against-an-asyncapi-document) and for `testpion tests-from-spec`, which writes a realtime test per channel.

**Export ▸ AsyncAPI 3.0** goes the other way: a collection's connections become an AsyncAPI document, with a server per broker or server URL (a URL kept in a `{{variable}}` becomes a server variable), a channel per topic, event or path, the saved messages as examples with a schema inferred from them, and what each connection sends or reads as operations. From the terminal: `testpion export "Clinic events" -f asyncapi -o events.asyncapi.yaml`.

### Bruno

A Bruno collection comes over with its folders (in Bruno's order), requests, query and path parameters, bodies, auth, headers (disabled ones stay disabled; collection and folder headers are added to their requests), collection variables, docs and the environments in `environments/`. Secret variables arrive empty: set them again as secrets.

Bruno scripts **run as they are**: TestPion's script sandbox has Bruno's API next to Postman's, so `bru.setVar()`, `bru.getEnvVar()`, `req.setHeader()`, `res.getBody()`, `res('path')`, `test()` and `expect()` work. Collection and folder scripts become collection and folder scripts. The no-code parts are converted too:

- **Assertions** (`res.status: eq 200`, `res.body.id: isNumber`, `res.headers['content-type']: contains json` …) become tests with the same names; a plain status check becomes a status check.
- **vars:post-response** (`token: res.body.token`) sets the variable from the response for the requests after it, and **vars:pre-request** sets request variables.

From the terminal, give the folder: `testpion import ./my-bruno-collection -w my-workspace`.

The other way works too: **Export ▸ Bruno collection folder…** (or `testpion export "My API" --format bruno --out ./bruno/my-api`) writes the collection as a Bruno folder, with the workspace's environments (secret variables by name only). Status and JSONPath `equals` / `exists` checks become Bruno assertions; scripts that came from Bruno go back as they were, and TestPion (`pm.*`) scripts are marked, since Bruno runs its own script API.

**Import…** in the workspace menu (top bar) accepts the same files. A TestPion workspace export opens as a new workspace, and anything else (a Postman, Insomnia, Bruno or Hoppscotch file, OpenAPI, HAR) is added to the open workspace.

**From a link:** paste a URL in the Import dialog's link box and press **Import link**: an OpenAPI URL (`https://petstore3.swagger.io/api/v3/openapi.json`), a file on GitHub, GitLab or Bitbucket (the file page is fine, TestPion downloads the raw file), or a Postman collection's API link. Links must be public http(s) URLs of at most 20 MB; for a private file, download it and import the file.

The CLI can import too, from a file or a link: `testpion import openapi.yaml -w my-workspace`, `testpion import https://petstore3.swagger.io/api/v3/openapi.json -w my-workspace`.

## Export

**Export** in a collection's toolbar offers these formats (and **.http file**, described [above](#http-files)):

- **TestPion collection (.json)**: the collection file as it is stored in the workspace.
- **OpenAPI 3.1 (.yaml)**: a description of the collection's HTTP requests for API documentation tools, code generators or a spec review: paths and methods (`{{id}}` and `:id` segments become path parameters), query and header parameters, request bodies with an example and an inferred schema, saved examples as documented responses, folders as tags and the auth in use as security schemes. Parameter values that hold `{{variables}}` are left out. GraphQL requests are not included. From the terminal: `testpion export "My API" --format openapi -o openapi.yaml`.
- **Postman collection v2.1**: for Postman, Newman or any tool that reads Postman collections. It includes folders, requests, params and path variables, headers, bodies (raw, form, multipart, file, GraphQL), auth (bearer, basic, API key, OAuth 1.0, OAuth 2.0, AWS Signature, Digest), collection and request scripts, collection variables, descriptions, saved examples and the *follow redirects* / *TLS verification* settings.

Postman has no place for some TestPion features. When they are left out, a message lists them:

- Assertions: a `status` check becomes a `pm.test(...)` in the request's test script, and other assertion types are skipped.
- JWT auth and the per-request Cookies table (its cookies are sent as a `Cookie` header instead).

Importing an exported file back into TestPion gives the same collection, and the round trip is tested. A collection exported in **TestPion's format** also carries its gRPC calls and WebSocket / Socket.IO / MQTT connections (`savedItems`); importing the file puts them back in the imported collection (an id the workspace already uses gets a new one, so nothing is replaced). Postman's format has no place for them, so a Postman export says how many it left out. **Environments → Export** writes an environment in Postman's environment format. Secret variables are exported with an empty value and type `secret`, because their values stay in your OS credential store.

From the CLI:

```bash
testpion export "Veterinary API" -o vet.postman_collection.json          # Postman v2.1 (default)
testpion export "Veterinary API" -f testpion -o vet.collection.json
testpion export-environment Staging -o staging.postman_environment.json
```

## Examples

An example is a saved response of a request, like Postman's examples. Examples show what an endpoint returns without sending the request, for instance a success and an error case. A [mock server](/api-testing/mock-servers) serves them over HTTP.

- **Save a response:** send a saved request, then click **Save as example** above the response and give it a name. The request must be in a collection. A new request opens the Save dialog first.
- **Browse:** in the request tree, the chevron before a request lists its examples. The request's **Examples** tab lists them with their status. Select one to see its headers and body. Rename or delete it with the buttons at the top.
- **Safe to commit:** examples are stored in the collection file, so sensitive data is masked when you save one. `Set-Cookie`, `Authorization` and token headers become `REDACTED`, and so do sensitive JSON fields (`access_token`, `password` …) and known secret values. Headers that only describe one transfer (`Date`, `Content-Length` …) are dropped. Bodies over 512 KB and truncated previews can't be saved as examples.
- Examples are saved to the collection straight away and don't mark the request as changed. Saving the request keeps its examples.

In the collection file an example looks like this:

```json
{
  "id": "ex-patient-missing",
  "name": "Patient not found",
  "status": 404,
  "statusText": "Not Found",
  "headers": [{ "key": "content-type", "value": "application/json" }],
  "body": "{ \"error\": \"not_found\" }",
  "request": { "method": "GET", "url": "{{baseUrl}}/patients/999" }
}
```

`request` is optional. It records the request that produced the response when that differs from the saved request.

## Documentation

Collections document themselves, like Postman's API documentation:

- **Request docs:** each request has a **Docs** tab. Write Markdown on the left and see the preview on the right. The text is saved with the request.
- **Collection docs:** the collection's **Docs** tab renders the whole collection as one page. It starts with the collection description, then a table of contents, then every folder and request: method and URL, description, auth, path variables, query parameters, headers, body and saved examples. Click **Edit description** to write the collection description, with a live preview. Click **Save** to keep it.
- **Secrets stay out:** values of sensitive headers, parameters, variables and body fields are shown as `••••••` or `REDACTED`. References like `{{accessToken}}` are shown as written, since they are not secrets.
- **Export Markdown** downloads the page as a `.md` file, ready for a wiki, a README or a static site. The CLI does the same: `testpion docs "Veterinary API" -o API.md`.
- **Export HTML** saves one self-contained web page, like Postman's published documentation. It has a sidebar of requests with search, copy buttons on code, and light and dark themes. It loads nothing from the internet, so you can host it anywhere (GitHub Pages, an intranet, a shared drive) or email it. HTML in descriptions is shown as text and never runs, and secrets are masked. From the terminal: `testpion docs "Veterinary API" --html -o api.html`.

Markdown is rendered with GitHub-flavoured syntax (tables, fenced code, task lists) and sanitised: scripts and event handlers are removed, and links open in your browser.

## Folders

Choose **Edit folder** in a folder's **⋯** menu to set up everything its requests share:

- **Scripts:** a pre-request and a post-response script that run for every request in the folder, including requests in sub-folders. The order is: collection script, outer folders' scripts, this folder's script, then the request's own script. It is the same for sending from a tab, the Collection Runner and `testpion run-collection`.
- **Variables:** visible to the requests inside. An inner folder's value wins over an outer folder's. Request variables and iteration data rows win over folder variables, and folder variables win over collection and environment variables.
- **Authorization:** requests set to *Inherit* use the nearest folder's auth, or the collection's.

Folders with scripts or variables show a dot in the tree. Folder scripts and variables are exported to and imported from Postman v2.1 (`event` and `variable` on folders).

## Collection Runner

The Collection Runner works like Postman's. It runs a whole collection or one folder, one request at a time and in order. Open it from the **Run** tab or button of a collection, or choose **Run collection** or **Run folder** in the **⋯** menu of the request tree.

| Setting | What it does |
|---|---|
| Run | The whole collection or a single folder |
| Requests | Tick the requests to include (all by default). In a long list, the filter narrows it by name, folder or method, and **Select all** / **Deselect all** act on what it shows. **Only GET** ticks just the requests that read (GET, HEAD): a smoke run that changes nothing. From the terminal: `testpion run-collection "My API" --method GET` |
| Environment | Variables used for the run |
| Iterations | How many times to run the requests (defaults to the number of data rows, or 1) |
| Delay | Pause between requests, in milliseconds |
| Data | A CSV or JSON file, a SQLite database with a query, or a PostgreSQL / MySQL database (**Database…**: its URL, `{{variables}}` allowed, and a query); files in the workspace's `datasets/` folder are listed next to *Select file* (its tables are listed; click one to use it). Each row becomes one iteration. Use `{{column}}` in requests, or `pm.iterationData.get('column')` in scripts. Click the file name to preview its rows |
| Keep variable values | Values set with `pm.environment.set()` and similar are saved as [current values](./rest.md#scripts) after the run. Turn this off to throw them away |
| Stop on first failure | End the run when a request fails or errors |

**gRPC calls and WebSocket / Socket.IO / MQTT connections** saved in the collection run too, after its requests in every iteration, and they're listed (and can be unticked) with the requests. A gRPC call passes when the server answers OK (code 0), with the call's saved `.proto` files or its server-reflection descriptor; a connection passes when the server accepts it, and its saved message (event, or publish) is sent. A folder run includes only the folder's requests. The same applies to `testpion run-collection`, monitors and the `run_collection` MCP tool.

Variables set by a script carry over to the requests that follow. A token saved by **Get access token** is used by later requests that inherit bearer auth `{{accessToken}}`. Collection-level and [folder-level](#folders) scripts run before each request's own scripts.

To control the order from scripts:

```js
// jump to a request by name or id
pm.execution.setNextRequest('List patients');
// end the current iteration
pm.execution.setNextRequest(null);
// in a pre-request script: skip this request (reported as skipped)
pm.execution.skipRequest();
```

`postman.setNextRequest()` works too. An iteration stops after 1,000 requests, so a `setNextRequest` loop can't run forever.

To run a collection from a terminal or CI, use [`testpion run-collection`](../cli/reference.md#run-collection). It runs the same way and also accepts Postman collection and environment files, like Newman.

Results stream into the panel on the right, with checks, errors and a trace for each request. Earlier runs are listed under **Previous runs**, and every run is saved with its HTML, Markdown, JUnit and JSON reports. With more than one iteration, each result is prefixed with its iteration number, for example `#2 Patients / List patients`.

:::
