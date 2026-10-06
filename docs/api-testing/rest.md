---
title: "REST and HTTP testing"
description: "Build and test HTTP requests: methods, bodies, cookies, streaming, large responses, mTLS and proxies."
---

::: v-pre

# REST and HTTP

## Body: completion from the API definition

When the workspace holds an API definition (**Import** an OpenAPI / Swagger document, or save one under `specs/`), a JSON body is completed and checked against the operation the request maps to (its method and URL, `{{variables}}` resolved from the active environment): the editor offers the fields, says which are required, and marks a wrong type or an unknown field. A line above the body says which definition and operation the schema comes from. The same schemas drive the gRPC message editor (from the service's .proto) and the MCP tool arguments (from the tool's input schema).

## Requests

- Any method, including custom ones.
- **Params, headers and cookies** use key/value tables, each row with its own toggle.
- **Cookie jar:** cookies set by responses are kept per workspace and sent with later matching requests. Open the **Cookies** dialog with the cookie button next to Send. See [Cookies](/api-testing/cookies).
- **Body types:** JSON, XML, text, HTML, form URL-encoded, multipart (text and file fields), and binary file. Files are streamed from disk.
- **Settings:** timeout, **retries**, redirects, proxy, disabling TLS verification (development only), and client certificates (mTLS). Retries (up to 5) repeat a request after a network error, a timeout, `429` or a `5xx`, waiting 500 ms, then twice as long each time (at most 10 s, or what `Retry-After` says). POST and PATCH are repeated only when the connection failed, because the server may already have acted on them. They apply everywhere the request runs: sends, collection runs, monitors and the CLI; the response shows **N attempts** when it took more than one.
- **Postman-style request settings** (the request's **Settings** tab), saved with the request so collection runs, monitors and the CLI use them too:

  | Setting | What it does |
  |---|---|
  | HTTP version | **Auto** (HTTP/2 over https when the server supports it) or **HTTP/1.1** |
  | Enable SSL certificate verification | Off accepts any certificate (development servers only) |
  | TLS versions | Oldest and newest TLS version allowed in the handshake; the others are disabled |
  | Cipher suites | OpenSSL cipher names in order of preference |
  | Automatically follow redirects, Maximum number of redirects | Follow 3xx responses, up to a limit (default 20) |
  | Follow original HTTP method | Keep POST (and its body) on a 301/302 instead of switching to GET; a 303 is always GET |
  | Follow Authorization header | Keep the Authorization header when a redirect goes to another host (removed by default) |
  | Remove referer header on redirect | Drop the Referer header from redirected requests |
  | Encode URL automatically | Off sends query values and path variables as typed (spaces and non-ASCII are still escaped) |
  | Disable cookie jar | Neither send jar cookies nor store the response's cookies (the Cookies tab still applies) |

  Responses are always parsed strictly (invalid HTTP headers are rejected). Postman's "use server cipher suite order" is a server-side TLS option with no client equivalent.
- **HTTP/2:** over `https://`, HTTP/2 is offered (ALPN) and used when the server supports it; the response shows an **HTTP/2** badge (and `httpVersion: "2"` in `--json` output). Turn on **HTTP/1.1 only** in the request's Settings for servers or proxies that misbehave with HTTP/2. Plain `http://` uses HTTP/1.1.

## Proxy

**Settings ▸ Proxy** chooses how TestPion reaches the network:

- **Use the environment variables** (the default): `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, like curl.
- **Use this proxy**: a proxy URL, an optional user name and password, and a list of hosts that bypass it. The bypass list uses `NO_PROXY` rules: host names (subdomains included), `.domain` suffixes, `host:port`, IP addresses, or `*`. The password is kept in the OS secret store, never in the settings file.
- **Don't use a proxy.**

The proxy applies to requests, `pm.sendRequest`, OAuth token calls, AI providers, MCP over HTTP, remote datasets, and WebSocket and Socket.IO connections (tunnelled with CONNECT). A request's own proxy (its **Settings** tab) wins. gRPC reads the environment variables itself.

The CLI always uses the environment variables. Set `TESTPION_NO_PROXY=1` to connect directly instead.

## Certificates

If your company inspects TLS traffic, or an API uses a private certificate authority, HTTPS requests fail with a certificate error until TestPion trusts that CA. **Settings ▸ Certificates** has two options:

- **Trust the certificates installed in the operating system**: the Windows certificate store, the macOS keychain or the Linux CA bundle. A corporate root certificate is usually already there.
- **Extra CA certificates**: paste PEM blocks or add `.pem` / `.crt` files. TestPion shows each certificate's name, issuer and expiry before you save.

These apply wherever the proxy does. A request that turns off TLS verification ignores them. From the terminal, use `TESTPION_USE_SYSTEM_CA=1`, `TESTPION_CA_FILE=ca.pem`, or Node's `NODE_EXTRA_CA_CERTS`.

## Paste a request from the browser

In the browser's devtools, right-click a request on the **Network** tab, choose **Copy**, and pick any of:

- **Copy as cURL (bash)** or **Copy as cURL (cmd)**
- **Copy as fetch** or **Copy as fetch (Node.js)**
- **Copy as PowerShell** (`Invoke-WebRequest`, also `Invoke-RestMethod`)

An [HTTPie](https://httpie.io) or xh command works too, e.g. `http POST api.test/pets name=Rex age:=3 Authorization:'Bearer tok'`: `name=value` is a JSON field (a form field with `--form`), `name:=json` raw JSON, `name==value` a query parameter, `Name:value` a header, `field@file` a file; `-a` / `-A bearer`, `--verify=no` and `--timeout` are read, and `:3000/path` means localhost.

Then paste it into TestPion:

- **Into the URL bar:** the current tab is replaced with the pasted request.
- **Anywhere else in the REST view** (with no text field focused), for example right after opening a new tab with **Ctrl/Cmd+V**: an unchanged new tab is filled, otherwise the request opens in a new tab named after its method and path, such as `POST /v1/pets`.

The method, URL, query parameters, headers, cookies, body (JSON, form, multipart, XML or text), basic and bearer auth, and curl options such as `-k`, `-L`, `--proxy` and `--max-time` are all imported. HTTP/2 pseudo headers (`authority`, `method`, `path`, `scheme`) that PowerShell snippets include are dropped. Pasted secrets, such as an `Authorization` header or session cookie, are only in the unsaved tab: move them into a [secret variable](/api-testing/environments#secrets) before you save the request.

## Sidebar

The left sidebar of the REST view has three panes, like Postman's:

- **Collections:** the request tree, with a filter, **Import** and **New collection**. Every row has the same buttons: **+** (*New HTTP request*) and **⋯** on collections, **⋯** on folders and requests, and a right-click opens the same menu. An empty collection offers **New HTTP request**. Below the collections, **MCP servers** and **API definitions** have a **+** and a **⋯** too, and folders of their own: **⋯ ▸ New folder**, then **Move to folder** on a server or definition.
- **Environments:** click an environment to make it active. **Edit** opens it, and **+** creates one.
- **History:** your recent HTTP requests grouped by day, with a filter. Click one to open it in a new tab.

The sidebar remembers the pane you last used.

## Tabs and history

Each request opens in a tab. A dot on a tab means it has unsaved changes.

When more tabs are open than fit, the tab bar doesn't scroll. It shows your pinned tabs and the tabs you used most recently, and a **+N** button on the right lists the others (as in Postman or VS Code). Pick one from the list to bring it into the tab bar; the least recently used tab moves into the list. The list also has **Close N hidden tabs**. Right-click a tab (or middle-click to close it) for:

- **Pin tab:** pinned tabs move to the front, show a pin, have no close button, and are kept by the bulk close actions. Unpin from the same menu.
- **Rename…** (or double-click the tab): renames the tab; a saved request is renamed in its collection too.
- **Duplicate tab:** an unsaved copy of the request, opened next to it.
- **Close tab**, **Close other tabs**, **Close tabs to the right**, **Close all tabs:** you are asked once if any of the closed tabs has unsaved changes.

**Close several tabs at once** from any of these:

- **File** menu: **Close Tab** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>W</kbd>), **Close Other Tabs**, **Close All Tabs** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd>), and **New Request Tab** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>T</kbd>).
- The **⋯** button at the right end of the tab bar.
- The command palette (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd>): *Close Tab*, *Close Other Tabs*, *Close All Tabs*.

Pinned tabs are kept by these commands; you are asked once if any closed tab has unsaved changes. On macOS, **Close Window** in the File menu is <kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>W</kbd>.

Open tabs, including pins, are restored when the app starts. You can close every tab: the editor then shows **New request** and **Describe with AI**, and stays empty after a restart until you open something.

**History** lists every request you sent, newest first, grouped by day (*Today*, *Yesterday*, weekday, then date). Search by name, URL, method or status, filter by kind or to *Failed* responses, and double-click an entry (or click **Open**) to open it in a new tab. Select an entry and Ctrl/⌘+click another to compare the two responses (status, time, header changes and a field-by-field body diff). Each row has a small bar of its duration next to the others. History stores redacted request metadata only. **HAR** exports the HTTP and GraphQL entries shown (after your search and filter) as a HAR file that browser devtools, Charles, Fiddler and other API tools open; secret headers, parameters and known secret values are masked. From the terminal: `testpion history export-har -w my-workspace -o history.har`.

## Responses

**Response layout.** The response goes beside the request when there is room, or below it on a narrower window (*Auto*). The layout button at the right of the tabs (also Settings ▸ Appearance and the command palette) sets *Side by side* or *Response below* for every editor: HTTP, GraphQL, gRPC and MCP tools. Each layout remembers its own size. When the request's tabs (Params, Headers, Body …) don't fit, **»** lists them all.

The status, duration, size, headers, cookies and a timeline are always shown. The timeline is a waterfall of prepare, DNS lookup, TCP connect and TLS handshake (on a new connection), waiting for the first byte (TTFB) and download, with the server's address, the TLS version and cipher, the certificate (subject, issuer, valid until, days left), or *Reused connection* when the request went over an open one. The Trace tab (and OpenTelemetry export) shows the phases as spans of the request. `testpion send <url> -i` prints the same phases, `--json` and the `send_request` MCP tool return them as `timing` (`dnsMs`, `tcpMs`, `tlsMs`, `ttfbMs`, `downloadMs`, `reusedConnection`). **Save as example** keeps the response with the request (see [Examples](/api-testing/collections#examples)). For the body:

<figure class="aps-screenshot">
  <img src="/images/rest-timeline.jpg" alt="The Timeline of a response: a new connection, TCP connect, waiting for the first byte and download as a waterfall, with Explain with AI" width="1440" height="900" loading="lazy">
</figure>

- **Pretty** is a virtualised JSON tree. Click a key to copy its JSONPath.
- **Table** appears when the JSON is an array of objects, or holds one up to three levels deep (such as `items`, `data.users`; the largest is used; GraphQL responses have it too): a column per key, click a header to sort (again to reverse), and filter rows by any cell. The first 500 rows are shown; **Copy CSV** copies every matching row. **Chart** (when a column holds numbers) draws one bar per row: choose the number and the label column; sorting and filtering apply. **Save as dataset** writes the rows to `datasets/<name>.csv` in the workspace (never overwriting), where the Collection Runner lists them next to *Select file* (agents use the same file with `run_collection`'s `data`).
- **Raw** is a virtualised text view with search.
- **Preview** renders HTML in a sandboxed frame.
- **JWT** appears when the body or a header holds a JSON Web Token (an `access_token`, `id_token` or `Authorization` value): its header and claims, when it was issued and when it expires (*expires in 58 min*, or *expired 2 h ago*). The signature is not verified. A `jwt` check (see [Assertions](/test-runner/assertions)) tests the same in a test; `testpion jwt <token>` and the `decode_jwt` MCP tool decode one outside the app.

The full body is streamed to `payloads/` on disk. The viewer only holds a preview, 2 MB by default and configurable in Settings. Larger bodies show a *truncated* badge; **Save response** exports the complete file.

## Compare across environments

The **Compare across environments** button (next to **Send**) sends the open request with two environments, one after the other, and shows the differences:

- status and time;
- every changed JSON field (added, removed, changed, or a different type), or a line diff for text;
- header changes.

Use it to check that Staging and Production answer the same way. Both are real requests: scripts, auth and checks run as usual, and a production environment gets a warning first.

From the terminal: `testpion env diff Staging Production --request "List patients" -w my-workspace [--json]` (exit 1 when the responses differ). AI agents: `compare_request_across_environments`.

## Checks from the response

To find something in a big response, type a JSONPath in **Filter with JSONPath** above the tree (for example `$.items[*].name` or `$..id`): the tree then shows only the matches.

In the **Pretty** view of a JSON response, click a key to open its menu:

- **Copy JSONPath** copies the key's path (like `$.items[0].id`).
- **Save to variable…** keeps the field in a variable for later requests (a token from a login, an id from a create). It adds a line such as `pm.environment.set('accessToken', pm.response.json().access_token);` to the request's test script, so the value is updated after every send, and sets it right away in the active environment (the globals when no environment is selected). Use it as `{{accessToken}}`.
- **Equals** checks the field has its current value.
- **Exists** checks the field is there.
- **Is a …** checks the field's type (string, number, array …).
- For arrays, **Has N items** and **Is not empty**.

Each choice adds a check to the request's **Tests** tab. Save the request to keep it; collection runs, monitors and CI then check it every time.

## Server-Sent Events

A `text/event-stream` response (live feeds, notifications, streaming LLM APIs) is shown **event by event while it arrives**: time, event type, id and data, newest at the bottom. Click an event to see its data in full (JSON as a tree), and filter by type, id or data.

- The stream stays open for as long as the server sends it: the request timeout applies only until the response starts.
- **Stop** ends the stream and keeps the events received so far, marked *stopped*.
- When the response ends, it opens on the **Events** tab. The raw text is on **Body**.
- Up to 10,000 events are kept per response.
- AI agents using [`testpion mcp-server`](/cli/reference#mcp-server) get the parsed events from `send_request`.

## Response history and compare

For a saved request, the response panel has a **History** tab: every response you sent from the app, newest first, with its status, time, size and when it was sent.

- Above the list, a **Response time** chart shows the recent responses oldest to newest, with the median, p95 and slowest time; failed responses are red dots. Hover a point for details, click it to open that response.
- Click a response to view its body.
- To see what changed, tick two responses and click **Compare selected**, or use the compare button on a row to compare it with the response before it.
- The comparison shows the status and time change, then the **body** field by field: each change is listed with its JSON path (`$.items[2]`, `$.total` …) as **added**, **removed**, **changed** or a **type** change. Text bodies get a line-by-line diff.
- It also shows **header** changes. Headers that change on every response (`date`, request ids and similar) are hidden behind a link, so they don't hide real differences.

Response bodies come from the payload files in the workspace (up to 2 MB each are compared). Responses sent before version 0.6.4 have no link to their saved request, so they don't appear here.

**For AI agents and scripts:** `testpion history list --request "List patients" --json`, `testpion history stats --request "List patients" --json` (the numbers of the Response time chart) and `testpion history diff <before> <after> --json` in the CLI, and `request_history`, `response_time_stats` and `compare_responses` on the [MCP server](/ai-testing/mcp-server). In these, the values of sensitive fields such as tokens and passwords are masked.

## Scripts

Pre-request and post-response scripts use the Postman script API under two names: **`tp`** (TestPion's name) and **`pm`** (Postman's). They are the same object, so write whichever you prefer, or mix them: `tp.test(...)`, `pm.test(...)`, `tp.environment.set(...)` all work. Scripts from imported Postman collections run unchanged. They run in a [sandbox](../security/privacy.md#script-sandbox) without file or network access. The **Snippets** list next to the editor inserts common scripts (written with `tp`), and the editor autocompletes both `tp.` and `pm.`.

- **Import from Postman:** scripts are kept as they are (`pm.*`). To switch a whole collection to `tp.*`, right-click it (or use its **⋯**) and choose **Convert scripts to tp.\***; **Convert scripts to pm.\*** goes back. You see how many scripts change before anything is saved. The CLI equivalent is `testpion scripts convert --to tp -w <workspace> [--collection <name>] [--dry-run] --json`.
- **Export to Postman** (and `testpion export`): `tp.*` is converted to `pm.*`, because Postman only knows `pm`. Only code changes; text in strings and comments, regular expressions and properties such as `obj.tp` are left alone. A script that declares its own `tp` variable is exported unchanged.

Pre-request:

```js
tp.variables.set('nonce', tp.uuid());
const sig = CryptoJS.HmacSHA256(tp.request.body.toString(), tp.environment.get('secret')).toString(CryptoJS.enc.Base64);
tp.request.headers.upsert({ key: 'X-Signature', value: sig });
```

Post-response:

```js
tp.test('Status code is 200', () => tp.response.to.have.status(200));
tp.test('Returns patients', () => {
  const body = tp.response.json();
  tp.expect(body.items).to.be.an('array').that.is.not.empty;
  tp.expect(body.items[0]).to.have.property('species');
});
tp.environment.set('patientId', tp.response.json().items[0].id);
```

### Supported API

| Area | API |
|---|---|
| Tests | `pm.test`, chai-style `pm.expect(…).to.…` (`equal`, `eql`, `deep`, `a`/`an`, `include`, `property`, `lengthOf`, `above`/`below`, `oneOf`, `keys`, `match`, `jsonSchema`, `not`, `true`/`false`/`null`/`ok`/`empty` …), JSON Schema checks with `pm.response.to.have.jsonSchema(schema)` or `tv4.validate(data, schema)` (validated with Ajv: draft-07 keywords and formats), legacy `tests["name"] = bool` |
| Response | `pm.response.code`, `.status`, `.responseTime`, `.headers.get()`, `.json()`, `.text()`, `pm.response.to.have.status/header/body/jsonBody`, `pm.response.to.be.ok/success/error/json`, legacy `responseCode`, `responseBody` |
| Request | `pm.request.method`, `pm.request.url` (`toString()`, `update()`, `getHost()`, `getPath()`, `getQueryString()`, `query.get/has/add/upsert/remove`, … or assign a string), `.headers.add/upsert/remove/get`, `.body.toString()/update()` |
| Variables | `pm.variables`, `pm.environment`, `pm.collectionVariables`, `pm.globals` (`get/set/unset/has/clear/toObject/replaceIn`; `replaceIn` also fills dynamic variables such as `{{$randomFirstName}}`), `pm.iterationData` |
| Other | `pm.info`, `pm.cookies`, `pm.cookies.jar()` (`get`, `getAll`, `set`, `unset`, `clear`), `pm.execution.setNextRequest`, `pm.execution.location` (collection, folders and request; `.current` is the request), `pm.sendRequest`, `pm.visualizer.set/clear`, `postman.setNextRequest`, `postman.setEnvironmentVariable` / `clearEnvironmentVariable` / `getResponseHeader` / `getResponseCookie` (and the globals versions), `xml2Json` (XML and SOAP responses, as in Postman), `setTimeout` / `setInterval` (the callbacks run after the script, in delay order, without waiting), `pm.response.size()`, `pm.expect.fail()`, `CryptoJS` (hashes, HMAC, Base64/Hex/Utf8), `btoa`/`atob`, `require('crypto-js')`, `require('tv4')`, `require('ajv')` (`new Ajv().compile(schema)`), `require('chai')`, `require('xml2js')`, `require('csv-parse/lib/sync')`, lodash as `_` or `require('lodash')`, `cheerio` (HTML with CSS selectors: `const $ = cheerio.load(pm.response.text()); $('title').text()`, `.find`, `.attr`, `.each`, `.map` …), `moment` (formatting, `add`/`subtract`, `startOf`/`endOf`, `diff`, comparisons; times are UTC), `console.log` |
| Bruno | Scripts imported from [Bruno](/api-testing/collections#bruno) run with Bruno's API: `bru.getEnvVar` / `setEnvVar` / `getVar` / `setVar` / `interpolate` / `setNextRequest` / `runner.skipRequest`, `req.getUrl` / `setHeader` / `getBody` / `setBody` …, `res.status` / `res.body` / `res.getBody()` / `res.getHeader()` / `res('path')`, `test()` and `expect()` |

**Script packages** (`pm.require`) are shared modules for scripts, like Postman's package library: code you'd otherwise copy into many requests (signing, token handling, common checks). Open **Scripts ▸ Packages…** to create and edit them; each is a CommonJS module in the workspace's `packages/` folder (`packages/@clinic/auth.js` for `@clinic/auth`), so they're versioned with the workspace and run the same in the app, the CLI and monitors.

```js
// packages/@clinic/auth.js
module.exports = {
  bearer(token) {
    return 'Bearer ' + token;
  },
};

// in a pre-request script
const auth = tp.require('@clinic/auth');
tp.request.headers.upsert({ key: 'Authorization', value: auth.bearer(tp.environment.get('token')) });
```

A package can `pm.require` other packages and `require()` the built-in modules; each is loaded once per script run. Postman collections that use packages work once the packages are added with the same names.

**`pm.sendRequest`** sends another HTTP request from a pre-request or test script, for example to fetch a token first:

```js
tp.sendRequest({
  url: tp.variables.replaceIn("{{baseUrl}}/auth/token"),
  method: "POST",
  header: { "Content-Type": "application/json" },
  body: { mode: "raw", raw: JSON.stringify({ client_id: tp.environment.get("clientId") }) }
}, (err, res) => {
  if (err) return console.error(err.message);
  tp.environment.set("accessToken", res.json().access_token);
  tp.request.headers.upsert({ key: "Authorization", value: "Bearer " + res.json().access_token });
});
```

- The request is a URL string or a Postman request object (`url`, `method`, `header` as a list or map, `body` with `mode: "raw"` or `"urlencoded"`). As in Postman, `{{variables}}` are not resolved automatically: use `pm.variables.replaceIn()`.
- The response has `code`, `status`, `responseTime`, `headers`, `json()` and `text()`. On a network error, the callback gets `err` and `null`.
- Without a callback, `pm.sendRequest` returns a promise, and scripts may use `await` at the top level, as in newer Postman scripts:

  ```js
  const res = await tp.sendRequest(tp.variables.replaceIn("{{baseUrl}}/auth/token"));
  tp.environment.set("accessToken", res.json().access_token);
  ```

  A failed request rejects the promise (use `try` / `catch`).
- `pm.test` takes async functions (`pm.test('name', async () => { … await … })`) and Postman's `function (done) { … done(); }` style (a `done` that is never called fails the test); `pm.test.skip(name, fn)` lists a test as skipped without running it.
- Requests share the run's cookie jar, time out like other requests, and appear in the [Console](#console) under the script's request, whether the request was sent from a tab or by a run (they are also recorded as `sentRequests` in the run's results).
- **How it works:** the sandbox is synchronous, so the script runs, its requests are sent, then the script runs again from the start with the responses, and callbacks run immediately (an `await` on a request that hasn't been sent yet waits for the next run). Only the last run's variables, tests and logs count. So a request made inside a callback also has its callback run inside, before later callbacks. Keep scripts deterministic around `pm.sendRequest` (avoid a random URL per run). A script may send at most 20 requests.

**`pm.vault`** (Postman Vault) works with TestPion's secret variables: `await pm.vault.get("apiKey")` reads the variable `apiKey` (keep it a [secret variable](./environments.md#secrets)), `pm.vault.set` / `unset` change the environment, and `{{vault:apiKey}}` in a request resolves like `{{apiKey}}`.

### Visualize responses (`pm.visualizer`)

As in Postman, a test (post-response) script can turn a response into an HTML view with a [Handlebars](https://handlebarsjs.com/guide/) template:

```js
const template = `
<table>
  <tr><th>Name</th><th>Species</th></tr>
  {{#each items}}
    <tr><td>{{name}}</td><td>{{species}}</td></tr>
  {{/each}}
</table>`;
tp.visualizer.set(template, tp.response.json());
```

After you send, the response body opens on **Visualize** (next to Pretty and Raw). The example workspace's **List patients** request has one; the **Snippets** list has *Visualize the response as a table*.

- `pm.visualizer.set(template, data)` renders `template` with `data` (anything JSON-serialisable). If several scripts (collection, folder, request) call it, the last call wins. `pm.visualizer.clear()` removes it.
- Handlebars' built-in helpers work (`#each`, `#if`, `#with`, `lookup`, …), plus `{{json value}}` to print a value as JSON. `{{…}}` output is HTML-escaped. Use `{{{…}}}` only for HTML you trust.
- **Scripts and charts work**, like in Postman: a template can load a chart library from a CDN (`https://cdn.jsdelivr.net`, `https://cdnjs.cloudflare.com` or `https://unpkg.com`) and read its data with `pm.getData((err, data) => …)` (or `tp.getData`). For example:

  ```js
  const template = `
    <canvas id="c" height="120"></canvas>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      tp.getData((err, data) => {
        new Chart(document.getElementById('c'), {
          type: 'bar',
          data: { labels: data.items.map((p) => p.name), datasets: [{ label: 'Age', data: data.items.map((p) => p.age) }] },
        });
      });
    </script>`;
  tp.visualizer.set(template, tp.response.json());
  ```
- **Security:** the visualization runs on its own isolated origin (`tpviz://` in the desktop app), in a sandboxed frame that can't reach the app, its storage or your data. It can't make network requests, so nothing leaves your machine; only scripts from those CDNs (and inline scripts) load, and images and fonts must be inline. Hosts that can't serve the isolated page fall back to a sanitised, script-free view.

**Current values:** values set with `pm.environment.set`, `pm.collectionVariables.set` or `pm.globals.set` are kept on this machine as *current values* and override the stored values. They're never written to workspace files. Sensitive ones (tokens, passwords, secret variables) are encrypted. You can see and reset them under **Environments**.

## AI help

With an assistant model set in **Settings → AI Assistant** (a local model works offline), the request builder can draft work for you. Everything the AI produces is labelled and shown to you first. Nothing is sent or run on its own.

- **Describe a request** (sparkles button next to Send): write what you want in plain words, for example *create a patient named Biscuit, a dog, owned by customer 123*. A new tab opens with the method, URL, headers and body filled in. The assistant only sees the **names** of your variables, so it writes `{{baseUrl}}` and `{{accessToken}}` instead of real values.
- **Generate tests** (above a response): the assistant writes `pm.test(...)` checks for the response's status, fields, types and timing and appends them to the Post-response script, headed by an *AI-generated* comment. Send again to run them. Imports the sandbox doesn't support are removed.
- **Explain** (above a 4xx or 5xx response): opens the assistant with what the error means, the likely cause and how to fix the request.
- **Suggest assertions** proposes TestPion checks (YAML) for the response.

Context sent to the model is redacted first (sensitive headers, fields and secret values are masked) and trimmed to the first few thousand characters of the body.

## Editor help

The code editors (bodies, scripts, GraphQL, messages, prompts) complete `{{variables}}` and highlight unknown ones in red (see [Typing variables](./environments.md#typing-variables)). In scripts, type `pm.` or `tp.` for the API with its documentation, and pick a ready-made snippet (`pm.test` status, JSON field, header, body text, JSON Schema, response time; `pm.environment.set`; `pm.sendRequest` …). JSON editors that have a schema, such as MCP tool arguments in raw JSON and gRPC messages, complete field names and values and flag mistakes as you type.

## Console

The **Console** is Postman's console: a log of every request with its script output. Open it with **Console** in the status bar or <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>C</kbd> (<kbd>⌘</kbd>+<kbd>⌥</kbd>+<kbd>C</kbd> on macOS). It shares the bottom panel with the application **Logs**.

- Each line shows the time, method, URL, status, duration and size. GraphQL operations sent from the GraphQL view are marked **GraphQL** (their request shows the query and variables). Requests from runs (the test runner and the Collection Runner) are marked **run**, and failed checks, including GraphQL `errors`, are counted.
- **MCP** lines: connecting to a server (`CONNECT`, with its URL or command line), tool calls (`CALL`, with the arguments and the result), resource reads (`READ`) and prompts (`PROMPT`).
- **WebSocket** lines: `CONNECT` (with the handshake headers and subprotocols), each message you send (`SEND`), and `CLOSE` with how long the connection was open and how many messages were sent and received. Received messages stay in the WebSocket view's message log, so a busy stream doesn't flood the console.
- `console.log`, `console.info`, `console.warn` and `console.error` output from pre-request and test scripts appears under its request, marked `pre ›` or `test ›`.
- Click a request sent from a tab to expand it and see the request and response headers and bodies (up to 16,000 characters each).
- **All / Errors / With logs** and the filter box narrow the list. The trash button clears it. The console keeps the last 500 requests until the app closes and is never written to disk.
- Everything is redacted before it reaches the console: sensitive headers, sensitive JSON fields, known secret values, and values you typed into sensitive headers or body fields, even when a server echoes them back.

See also [authentication](./authentication.md), [environments](./environments.md) and [collections](./collections.md).

:::
