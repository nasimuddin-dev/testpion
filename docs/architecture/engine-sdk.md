---
title: "The engine as an SDK"
description: "Use @testpion/core from Node: start the Debugger proxy, give it rules and scripts, read the traffic as events and HAR. Plus a cookbook of CLI one-liners for the same jobs."
---

# The engine as an SDK

The desktop app, the CLI and the MCP server are three doors into one engine, `@testpion/core`. The engine is an ES module for Node 20 or newer, so a script, a test or a service can use it directly: start a capture proxy, give it rules, read what went through. This page is for the **HTTP Debugger** (the same idea as Fiddler's FiddlerCore); the other parts of the engine (sending requests, running tests and flows, mocks) are exported from the same package.

```bash
npm install @testpion/core      # or use the workspace packages in this repository: npm run build
```

Two entry points:

| Import | What is in it |
| --- | --- |
| `@testpion/core` | Everything that is safe on a server: the proxy, rules, scripts, sessions, HAR, readers. |
| `@testpion/core/desktop` | What only makes sense on someone's own computer: the root certificate for HTTPS decryption, the system proxy setting, opening a browser or a terminal that uses the proxy. A server never imports it. |
| `@testpion/shared` | Pure readers that run anywhere (also in a browser): `exchangeView` (image, XML, form, GraphQL, AI call, MessagePack, Protobuf, caching, TLS…), `aiCallOf`, `graphqlOf`, `cachingOf`. |

## Start a proxy

```js
import { startDebuggerProxy } from '@testpion/core';

const proxy = await startDebuggerProxy({
  port: 8899, // omit for any free port
  rules: () => rules, // read for every request: edit the array and the next request sees it
  onExchange: (e, phase) => { // 'request' | 'response' | 'update'
    if (phase === 'response') console.log(e.method, e.url, e.status, e.durationMs + ' ms');
  },
});
// point a program at it: HTTP_PROXY=http://127.0.0.1:<proxy.port>
console.log(proxy.url, proxy.exchanges.length);
await proxy.close();
```

`examples/sdk/debugger-proxy.mjs` in the repository is a complete, runnable version of this page (`node examples/sdk/debugger-proxy.mjs` after `npm run build`).

The options you will use most:

| Option | What it does |
| --- | --- |
| `port`, `lan` | The port; `lan: true` lets a phone or another computer use the proxy (it must pair with the secret in `proxy.pairingSecret`). |
| `rules()` | The active rules, asked for every request. |
| `onExchange(e, phase)` | Told when an exchange starts, when its response is in, and when something learned later changed it (the program that sent it). |
| `session` | A `DebuggerSession` to capture into (keeps bodies within a memory budget); a new one by default. `proxy.exchanges` is its list. |
| `decrypt` | `{ leafFor(host), enabled(host) }` to read HTTPS: `leafFor` returns a certificate for the host signed by the TestPion root (`ensureRootCertificate` and `leafSigner` in `@testpion/core/desktop`); the program must trust the root. |
| `speed()` | The Network speed switch (`parseNetworkSpeed({ preset: '3g' })`). |
| `workspaceRoot()` | The folder that map-local replies and script files are read from. |
| `onBreakpoint(e, phase)` | Return a promise: the exchange is held until it resolves with edits (or nothing). |
| `listing()` | Return `false` to forward without listing (the app's Pause). |

## Rules are data

A rule is a plain object, so a rules file is JSON you can generate, keep in git and review:

```js
const rules = [
  { id: 'a', name: 'Staging', enabled: true, kind: 'modify', match: { host: 'api.example.com' }, requestHeaders: [{ op: 'set', name: 'x-env', value: 'staging' }] },
  { id: 'b', name: 'Offline users', enabled: true, kind: 'reply', match: { url: '*/users' }, reply: { status: 200, file: 'mocks/users.json' } },
  { id: 'c', name: 'Flaky payments', enabled: true, kind: 'fault', match: { host: 'pay.example.com' }, fault: { action: 'error', status: 503, percent: 20 } },
];
```

Kinds: `ignore` (filter out), `only` (capture only), `highlight`, `modify` (headers, bodies, find and replace, status, delay), `reply` (a canned response, or a file or folder of the workspace), `redirect` (another host, a path rewrite), `remap` (a host at another address), `fault` (drop, timeout, truncate, error), `frame` (WebSocket frames), `breakpoint` and `script`. `match` takes `host`, `url` (a glob or a `/regular expression/`), `method`, `application` and a `where` condition on a grid column. `describeRule(rule)` says what a rule does in a sentence; `checkRuleShape(rule)` says in words why a rule cannot work (it returns `undefined` when it can). Check a rule before you hand it to the proxy.

## Rule scripts

When the declarative kinds are not enough, a rule of kind `script` runs JavaScript on each matching request and response:

```js
{ id: 'd', name: 'Block admin, patch 500s', enabled: true, kind: 'script', match: { host: 'api.example.com' },
  script: { code: `
    function onRequest(ctx) {
      if (ctx.request.url.includes('/admin')) ctx.reply(403, { error: 'blocked' });   // the server never sees it
      ctx.request.headers['x-trace'] = 'on';
    }
    function onResponse(ctx) {
      if (ctx.response.status === 500) ctx.response.status = 503;
    }` } }
```

* `ctx.request`: `method`, `url`, `host`, `headers` (lower-case names), `body` (text, or `undefined` for a body that is not text or is over 1 MB). `onResponse` also gets `ctx.response`: `status`, `headers`, `body`. Change the fields to change what is sent on.
* `ctx.reply(status, body, headers)` answers by itself; `ctx.delay(ms)`, `ctx.highlight(color)`, `ctx.ignore()` and `console.log(...)` do what they say.
* **Sandbox**: the same QuickJS engine that runs collection scripts, with no network, no files, no modules from disk and no secrets or environment. A hook has 100 ms by default (`script.timeoutMs`, 10 to 2000) and 16 MB. A hook that throws or runs out of time is skipped for that exchange and the traffic goes on unchanged (the exchange's `rules` list names the failure).
* Scripts run in the engine's script worker pool when the host set one (`setDefaultScriptRunner`), so a slow script never holds up the proxy's other traffic.
* `script.file` reads the script from the workspace (`debugger/scripts/auth.js`) instead of holding the text in the rule, which keeps scripts reviewable in git.
* Try one before you switch it on: `testRuleScript(rule, exchange, true, workspaceRoot)` runs both hooks on a captured exchange and returns what the script would do, in words, without sending anything.

## Read what was captured

An exchange (`DebuggerExchange`) carries the request and response (headers, text bodies, kept bytes for images and binary protocols), timings (`sendMs`, `waitMs`, `durationMs`), the program behind it (`application`, `pid`), the TLS connection (`connection`), WebSocket `frames`, server-sent `events`, gRPC messages, and the names of the rules that acted on it (`rules`). The bodies are the real ones; mask them before they leave the machine (`new Redactor().redact(...)`, `redactString`).

```js
import { exchangesToHar, exchangesFromHar, writeHarFile, Redactor } from '@testpion/core';
import { exchangeView, aiCallOf } from '@testpion/shared';

const har = exchangesToHar(proxy.exchanges, new Redactor()); // secrets in headers and URLs masked
await writeHarFile('session.har', proxy.exchanges, new Redactor()); // written in slices; never half a file
const again = exchangesFromHar(har); // HAR (and SAZ with exchangesFromSaz) back into exchanges

exchangeView(again[0], 'graphql'); // { ok, data, text }: the same readers the window, the CLI and the MCP tool use
aiCallOf(again[0]); // an LLM or MCP call: model, messages, answer, tokens, a cost estimate
```

## CLI cookbook

Everything above is also a command, with `--json` for scripts. Each of these is one line you can paste into a CI job or give to an agent.

```bash
# capture
testpion debugger capture -p 8899 -o session.har --json        # a JSON line per exchange; Ctrl+C saves the HAR
testpion debugger capture --decrypt --system-proxy --yes      # the whole computer, HTTPS included
testpion debugger capture --rules debugger/rules.json         # the workspace's rules, re-read when the file changes
testpion debugger capture --throttle 3g                       # pace the traffic: modem, edge, slow-3g, 3g, slow-4g

# change the traffic
testpion debugger remap api.test=localhost:3000 --keep-host   # reach a host at another address
testpion debugger rule --add '{"kind":"fault","match":{"host":"pay.test"},"fault":{"action":"error","status":503,"percent":20}}'
testpion debugger script add debugger/scripts/auth.js --host api.test   # a JavaScript rule, read from the workspace
testpion debugger script test auth.js session.har '#3'        # what the script would do to the third exchange; sends nothing
testpion debugger presets --add no-cache --rules debugger/rules.json

# read a capture
testpion debugger show session.har '#3'                       # which views fit the response
testpion debugger show session.har <id> --view graphql --json # operation, query, variables, errors
testpion debugger show session.har <id> --view ai --json      # an LLM or MCP call: model, tokens, cost, the answer
testpion debugger show session.har <id> --view caching        # would a browser cache it, in words
testpion debugger annotate session.har <id> --note "retry storm" --mark red

# assert on traffic in CI (jq on the JSON lines of a capture)
testpion debugger capture -p 8899 -o traffic.har              # run your tests with HTTP_PROXY=http://127.0.0.1:8899, then press Ctrl+C
jq -e '[.log.entries[] | select(.response.status >= 500)] | length == 0' traffic.har
```

For agents the same engine is the MCP server (`testpion mcp-server`): `debugger_capture`, `debugger_exchanges`, `debugger_exchange` (with `view`), `debugger_rules`, `debugger_scripts`, `debugger_session` and `debugger_save_to_collection` (keep captured traffic as saved requests), described in [MCP tools](/mcp/tools). `testpion agent-info --json` lists every command an agent can use.

## What the SDK is not

* It does not start a window, install a certificate or change the system proxy unless you import `@testpion/core/desktop` and call it.
* The proxy is a library, not a daemon: it lives in your process and ends with it. For a long-running capture on a server, run `testpion debugger capture` under your process manager.
* The API follows the app's versions. Types ship with the package (`dist/index.d.ts`), and the shapes on this page (rules, exchanges, events) are the ones the app saves to disk, so they change only with a note in the changelog.
