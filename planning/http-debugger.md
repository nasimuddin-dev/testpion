# HTTP Debugger: plan

Owner (2026-10-05): "Add one menu named HTTP Debugger or something and try to add all the features this has: https://www.httpdebugger.com/features".

A new view, **Debugger**, in the rail under Requests: the traffic of other programs (a browser, an app under test, a Node server, an AI agent, an MCP server) flows through TestPion's local proxy and is listed, inspected, filtered, highlighted, modified, replied to, replayed, saved, and offered to agents. It reuses what exists: the recorder (`record/recorder.ts`, a reverse proxy), the response viewer, the timeline, the HAR export, the Redactor, the MCP server.

## Their features → ours

| HTTP Debugger | TestPion | Phase |
|---|---|---|
| Capture traffic of other programs (HTTP, HTTPS, HTTP/2) | A local **forward proxy** (`127.0.0.1:<port>`); the program points at it (`HTTP_PROXY`, browser proxy settings, `--proxy-server`). HTTPS through a **TestPion root certificate** the user installs once (generated per computer, kept in the data folder), else CONNECT tunnels are listed by host only. | 1 (HTTP), 2 (HTTPS) |
| Grid with quick filters (application, domain, content type, text) | The grid; filters by host, method, status, content type, text; the "application" column from the proxy's client port → process (Windows: `netstat`/`Get-NetTCPConnection`; macOS/Linux: `lsof`), best effort. | 1 |
| Filter rules (block before display) | Rules of kind **ignore** (host / URL pattern / application). | 3 |
| Highlight rules (errors, slow, large, custom) | Rules of kind **highlight** (status ≥ 400, time > n ms, size > n, pattern) → row colour; defaults on. | 3 |
| Per-request Summary / Content / Timeline | The response viewer (body with syntax highlighting, headers, cookies, timeline with connection phases, JWT, size, compression) for the selected row; the request side too. | 1 |
| WebSocket frames, SSE events, gRPC messages | WebSocket frames through the proxy (direction, size, payload); SSE events; gRPC (HTTP/2 + protobuf: method, stream id, decoded with the workspace's .proto files when they match). | 4 |
| Edit & resubmit | **Open in a request tab** (the exchange becomes a REST request) and **Resend**. | 1 |
| Modify headers, auto-reply, redirect TCP connections | Rules of kind **modify** (add / set / remove request or response headers, by pattern), **reply** (a canned status + body, or a mock collection's example), **redirect** (host:port → host:port). | 3 |
| Session views: top content types, top domains, largest requests, structure tree | A **Statistics** tab: by content type, by host, largest, slowest; a **Tree** tab (host / path with counts and bytes). | 2 |
| Context menu: copy, bookmark, filter, highlight, modify, auto-reply, redirect, save, delete | The row's ⋯ menu (uniform NodeMenu): Copy URL / as cURL, Bookmark, Filter by host, Highlight, Add a rule (modify / reply / redirect / ignore), Save to collection, Delete. | 2–3 |
| Bookmarks | A star on rows; a Bookmarked filter. | 2 |
| Save / restore sessions | Sessions saved as HAR (+ TestPion extras) in `debugger/`; open one later; the Record dialog's "Save as collection" stays. | 2 |
| Fiddler import (SAZ, HAR) | HAR import (exists); SAZ (a zip of raw request/response files) import. | 4 |
| Export: Excel, XML, JSON, CSV, TXT | HAR (exists), CSV, JSON, Markdown of the grid; Excel = CSV. | 2 |
| URL / Base64 / Hex converter | A small **Decode** panel (URL, Base64, hex, JWT, timestamp) in the tools menu. | 4 |
| HTTP/2 connection tree | Connections view: per connection its streams. | 4 |
| Rules profiles | Rule sets saved per workspace (`debugger/rules.json`), switchable. | 3 |
| MCP server for agents | Tools: `debugger_capture` (start / stop), `debugger_exchanges` (list with filters), `debugger_exchange` (one, with bodies), `debugger_rules` (list / add / remove), `debugger_stats`; the CLI: `testpion debug --port 8888 [--save session.har] [--json]`. | 1 (list), 3 (rules) |
| Dark / light themes | Already. | – |

## Security

- The proxy listens on 127.0.0.1 only; a setting allows the LAN (for a phone or another computer) with a warning.
- The root certificate is created on this computer, never leaves it, and the Settings page shows how to remove it.
- Bodies pass the Redactor before anything is saved or shown to an agent; captures are not committed (`debugger/` in .gitignore).
- Rules that change traffic are listed in the view at all times (a bar: "2 rules active"), and off when the view is closed unless pinned.

## Phases

- **DBG-1 Proxy and grid** (L): forward proxy (HTTP; HTTPS as opaque CONNECT), the view with grid, filters, per-request viewer, open in a tab / resend, application column, `testpion debug`, MCP list tools, docs, e2e with a local client program.
- **DBG-2 Sessions, statistics, bookmarks, export** (M).
- **DBG-3 Rules** (L): ignore, highlight, modify, reply, redirect; profiles; the rules bar; MCP rule tools.
- **DBG-4 HTTPS, streams, imports** (XL): the root certificate and MITM, WebSocket / SSE / gRPC capture, SAZ import, the decode panel, HTTP/2 tree.
