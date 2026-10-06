# HTTP Debugger: plan

Owner (2026-10-05): "Add one menu named HTTP Debugger or something and try to add all the features this has: https://www.httpdebugger.com/features".

A new view, **Debugger**, in the rail under Requests: the traffic of other programs (a browser, an app under test, a Node server, an AI agent, an MCP server) flows through TestPion's local proxy and is listed, inspected, filtered, highlighted, modified, replied to, replayed, saved, and offered to agents. It reuses what exists: the recorder (`record/recorder.ts`, a reverse proxy), the response viewer, the timeline, the HAR export, the Redactor, the MCP server.

## Their features → ours

| HTTP Debugger                                                                               | TestPion                                                                                                                                                                                                                                                                                                 | Phase               |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Capture traffic of other programs (HTTP, HTTPS, HTTP/2)                                     | A local **forward proxy** (`127.0.0.1:<port>`); the program points at it (`HTTP_PROXY`, browser proxy settings, `--proxy-server`). HTTPS through a **TestPion root certificate** the user installs once (generated per computer, kept in the data folder), else CONNECT tunnels are listed by host only. | 1 (HTTP), 2 (HTTPS) |
| Grid with quick filters (application, domain, content type, text)                           | The grid; filters by host, method, status, content type, text; the "application" column from the proxy's client port → process (Windows: `netstat`/`Get-NetTCPConnection`; macOS/Linux: `lsof`), best effort.                                                                                            | 1                   |
| Filter rules (block before display)                                                         | Rules of kind **ignore** (host / URL pattern / application).                                                                                                                                                                                                                                             | 3                   |
| Highlight rules (errors, slow, large, custom)                                               | Rules of kind **highlight** (status ≥ 400, time > n ms, size > n, pattern) → row colour; defaults on.                                                                                                                                                                                                    | 3                   |
| Per-request Summary / Content / Timeline                                                    | The response viewer (body with syntax highlighting, headers, cookies, timeline with connection phases, JWT, size, compression) for the selected row; the request side too.                                                                                                                               | 1                   |
| WebSocket frames, SSE events, gRPC messages                                                 | WebSocket frames through the proxy (direction, size, payload); SSE events; gRPC (HTTP/2 + protobuf: method, stream id, decoded with the workspace's .proto files when they match).                                                                                                                       | 4                   |
| Edit & resubmit                                                                             | **Open in a request tab** (the exchange becomes a REST request) and **Resend**.                                                                                                                                                                                                                          | 1                   |
| Modify headers, auto-reply, redirect TCP connections                                        | Rules of kind **modify** (add / set / remove request or response headers, by pattern), **reply** (a canned status + body, or a mock collection's example), **redirect** (host:port → host:port).                                                                                                         | 3                   |
| Session views: top content types, top domains, largest requests, structure tree             | A **Statistics** tab: by content type, by host, largest, slowest; a **Tree** tab (host / path with counts and bytes).                                                                                                                                                                                    | 2                   |
| Context menu: copy, bookmark, filter, highlight, modify, auto-reply, redirect, save, delete | The row's ⋯ menu (uniform NodeMenu): Copy URL / as cURL, Bookmark, Filter by host, Highlight, Add a rule (modify / reply / redirect / ignore), Save to collection, Delete.                                                                                                                               | 2–3                 |
| Bookmarks                                                                                   | A star on rows; a Bookmarked filter.                                                                                                                                                                                                                                                                     | 2                   |
| Save / restore sessions                                                                     | Sessions saved as HAR (+ TestPion extras) in `debugger/`; open one later; the Record dialog's "Save as collection" stays.                                                                                                                                                                                | 2                   |
| Fiddler import (SAZ, HAR)                                                                   | HAR import (exists); SAZ (a zip of raw request/response files) import.                                                                                                                                                                                                                                   | 4                   |
| Export: Excel, XML, JSON, CSV, TXT                                                          | HAR (exists), CSV, JSON, Markdown of the grid; Excel = CSV.                                                                                                                                                                                                                                              | 2                   |
| URL / Base64 / Hex converter                                                                | A small **Decode** panel (URL, Base64, hex, JWT, timestamp) in the tools menu.                                                                                                                                                                                                                           | 4                   |
| HTTP/2 connection tree                                                                      | Connections view: per connection its streams.                                                                                                                                                                                                                                                            | 4                   |
| Rules profiles                                                                              | Rule sets saved per workspace (`debugger/rules.json`), switchable.                                                                                                                                                                                                                                       | 3                   |
| MCP server for agents                                                                       | Tools: `debugger_capture` (start / stop), `debugger_exchanges` (list with filters), `debugger_exchange` (one, with bodies), `debugger_rules` (list / add / remove), `debugger_stats`; the CLI: `testpion debug --port 8888 [--save session.har] [--json]`.                                               | 1 (list), 3 (rules) |
| Dark / light themes                                                                         | Already.                                                                                                                                                                                                                                                                                                 | –                   |

## Fiddler Everywhere's features → ours

Owner (2026-10-06): "also add all features from the Fiddler". What HTTP Debugger does not have, mapped:

| Fiddler Everywhere | TestPion | Phase |
|---|---|---|
| System proxy capture (sets the OS proxy for you) | **Capture system traffic**: a switch that sets the OS proxy to TestPion's (Windows: WinINET / registry; macOS: `networksetup`; Linux: GNOME / env) and restores it on stop or exit. | 2 |
| Browser capture (opens a browser with the proxy) | **Open a browser**: launches Chrome / Edge / Firefox with `--proxy-server` and a throw-away profile. | 2 |
| Terminal capture (a shell with the proxy set) | **Open a terminal** with `HTTP_PROXY` / `HTTPS_PROXY` set, and a one-line command to copy for an existing shell. | 2 |
| Remote device / Android capture | LAN mode (exists in the proxy) + a QR code with the proxy URL and the root certificate download page. | 4 |
| HTTPS decryption | The root certificate (DBG-4). | 4 |
| HTTP/2, WebSockets, SignalR, MessagePack, SSE, gRPC, Protobuf | DBG-4 (WebSocket / SSE / gRPC); MessagePack and SignalR decoded as payload formats. | 4 |
| Inspectors: headers, body, cookies, raw, hex, auth, TLS / certificate | The viewer: headers, body (JSON tree, text), cookies, **Raw** (the wire text), **Hex** for binary, **Auth** (Basic decoded, Bearer JWT decoded with expiry), TLS version and certificate for decrypted traffic. | 2 (raw, hex, auth), 4 (TLS) |
| Timings, sizes, statistics, overview | Statistics (exists) + an **Overview** tab: requests per second over time, status mix, by host. | 2 |
| Find in traffic | The filter box searches URLs, headers and bodies. | 2 |
| Compare traffic | **Compare** two exchanges (the response diff of the History view reused). | 3 |
| Filters with saved presets | Filter presets saved per workspace. | 3 |
| Session snapshots, AutoSave, import / export | Sessions in `debugger/` (HAR + extras), AutoSave of the live session every minute, open / export. | 2 |
| Rules: modify headers / bodies, redirect, auto-responder, presets, breakpoints | Rules (DBG-3) + **breakpoints**: a rule that pauses a matching request (or response) for editing before it goes on; **presets** (add a header, CORS, slow down, offline, mock a host). | 3 |
| Reverse proxy | The recorder (exists): a reverse proxy in front of one API. | – |
| Composer, replay, saved composer requests | The request editor (exists): Open as a request, Resend, Save to a collection. | 1 |
| Share snapshots and rules with a team | Sessions and rules are files in the workspace: git (exists). | 2–3 |
| MCP for IDEs, an AI debugging assistant, sanitisation before the model | The MCP tools (DBG-1) + **Ask the assistant** on an exchange (why did this fail? what changed?), redacted first (exists). | 1, 2 |
| Fiddler Classic settings import | SAZ and rules import (DBG-4). | 4 |
| Keyboard shortcuts | ↑ ↓ select, Enter opens, Delete removes, Ctrl+F finds, Ctrl+E clears. | 2 |
| SSO, policies, compliance | The cloud version (planning/cloud). | – |

## Security

- The proxy listens on 127.0.0.1 only; a setting allows the LAN (for a phone or another computer) with a warning.
- The root certificate is created on this computer, never leaves it, and the Settings page shows how to remove it.
- Bodies pass the Redactor before anything is saved or shown to an agent; captures are not committed (`debugger/` in .gitignore).
- Rules that change traffic are listed in the view at all times (a bar: "2 rules active"), and off when the view is closed unless pinned.

## Phases

- **DBG-1 Proxy and grid** (L): forward proxy (HTTP; HTTPS as opaque CONNECT), the view with grid, filters, per-request viewer, open in a tab / resend, application column, `testpion debug`, MCP list tools, docs, e2e with a local client program.
- **DBG-2 Capture helpers, sessions, inspectors** (L, done 2026-10-06): system proxy switch, open a browser / terminal with the proxy, the lines for a shell, sessions in `debugger/` with AutoSave and HAR import / export (`debugger_session` for agents), Raw / Hex / Auth inspectors, the overview (requests over time, status mix), find in bodies, keyboard shortcuts, Ask the assistant (`explain-exchange`).
- **DBG-3 Rules** (L): ignore, highlight, modify, reply, redirect, breakpoints; presets and profiles; filter presets; compare two exchanges; the rules bar; MCP rule tools.
- **DBG-4 HTTPS, streams, imports** (XL): the root certificate and MITM, WebSocket / SSE / gRPC capture, SAZ import, the decode panel, HTTP/2 tree.
