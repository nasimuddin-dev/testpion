# Fiddler gap backlog (HTTP Debugger vs Fiddler Classic and Fiddler Everywhere)

Date: 2026-10-28. Owner request: the Debugger gets all the features of the HTTP Debugger app and of Fiddler. The HTTP Debugger app is already covered by `planning/http-debugger.md` (all phases done); this file is the Fiddler remainder. Nothing here is built yet.

## 1. Method, sources, limits

Method: read Telerik's public pages (summarised, not copied), then read TestPion's code and docs to build the "what exists" column. "In flight" = being delivered today by other agents (capture-all one click, quick filters, inspector tabs Params/Cookies/Overview/Error, certificate trust by hash, autosave privacy, MCP `debugger_capture` / `debugger_certificate`); do not duplicate that work.

Sources actually read (all fetched 2026-10-28):
- https://www.telerik.com/fiddler/fiddler-everywhere (feature overview, trial)
- https://www.telerik.com/fiddler/fiddler-classic (positioning: free, Windows, maintenance mode)
- https://www.telerik.com/support/whats-new/fiddler-everywhere/release-history (version list; 8.3.0 on 2026-10-20, 8.2.0 2026-09-29, 8.1.0 2026-08-31, 8.0.x July)
- Search summaries of the 8.x release notes (8.0: Agent Inspector, MCP traffic capture, one-click MCP setup, Protobuf inspector; 8.1: group sessions by domain or application, QUERY method in Composer; 8.2: scripting (beta, C#) and host remapping; 8.3: custom inspectors built for Classic, sanitization fixes)
- https://www.telerik.com/fiddler/fiddler-everywhere/documentation/scripting/scripting-overview (hooks, one active script, Monaco editor, compile and guardrail checks)
- https://www.telerik.com/fiddler/fiddler-everywhere/documentation/capture-traffic/host-remapping
- https://www.telerik.com/fiddler/fiddler-classic/documentation/knowledgebase/quickexec
- https://www.telerik.com/blogs/debugging-with-fiddler-everywhere-collaborative-debugging (shared snapshots, notes, comments)
- Search result snippets only (pages themselves not opened): Map Manual Response, AutoResponder reference, FARX rules archives, importing Classic settings, Fiddler Jam launch material, price-change blog, Charles/Proxyman/mitmproxy comparisons (proxyman.com, alternativeto.net, HN thread).

Limits (could not verify):
- The pricing page returned 404 and the docs host moved (301 to telerik.com/fiddler/...); the Rules overview and "what is Fiddler Everywhere" docs 404ed. So **tier assignment is unverified**: I found Free, Pro and Enterprise in 2024 price material and no "Business" tier. Per-feature Pro-only flags below are marked "?" unless the overview page said it.
- Everywhere throttling, breakpoints and exact rule action list: not read directly (Classic's are well known; Everywhere's rule builder lists header, body, status, redirect, map-local style actions per the search snippets).
- Fiddler Jam: only 2021-22 material (shareable capture link, optional password, masking of sensitive values, one-click open in Everywhere); current status unknown.
- Fiddler Echo, Fiddler Cap, Test Studio integration, Everywhere "Reporter": nothing current found; omitted from the matrix.
- Charles / Proxyman / mitmproxy: only marketing-level facts (map local/remote, breakpoints, repeat with iterations and concurrency, scripting). Kept short.
- Classic feature list is from my knowledge plus the QuickExec page; menus (Rules, Tools) not re-read.
- TestPion claims were checked in code on `main` at 21b58cfa, except where marked "(doc)" = from docs/api-testing/http-debugger.md only.
- The CLI command is `testpion debug` (not `debugger`); MCP tools are `debugger_*` (capture, exchange, exchanges, rules, session, stats, save_to_collection) plus `flow_from_exchanges`, `git_share_session`, `rag_capture_dataset`.

## 2. What TestPion has today (verified)

| Area | Where |
| --- | --- |
| Forward proxy, HTTP/1.1, HTTP/2 (ALPN), CONNECT sniffing, WebSocket frames, SSE events, gRPC decode with workspace protos | `packages/core/src/debugger/proxy.ts`, `frames.ts`, `grpc.ts` |
| HTTPS decryption, per-host leaf certs, root cert create/trust/remove/export/regenerate, keep-encrypted hosts | `certificate.ts`, `debug.certificate`, `debug.decrypt` |
| Capture helpers: system proxy (restore on stop), browser with own profile, terminal with env, LAN + QR + phone page, reverse proxy for one API | `capture.ts`, `debug.systemProxy/openBrowser/openTerminal/lan`, `record/recorder.ts` |
| Grid: columns #, Offset, Duration, Method, Version, URL, Status, Type, Size, Speed, Application, Domain, IP, User, PID; sort, hide columns, multi-select | `components/debugger/DebuggerGrid.tsx` |
| Filters: text (+ in bodies), application, domain, type, method, status, bookmarked, presets, hide tunnels, quick chips (in flight) | `DebuggerView.tsx`, `quick-filter.ts` |
| Rules kinds: only, ignore, highlight, modify (request/response headers, whole body replace, delay), reply (status, headers, body, delay), redirect (host + scheme), breakpoint (request or response); profiles in `debugger/rules.json`; presets; hit counters; "what would happen to a URL" | `rules.ts`, `DockRules.tsx`, `DebuggerRules` component |
| Inspectors: Header, Content, Raw, JSON tree, Hex, Auth, gRPC, Frames, Events; Params, Cookies, Overview, Error (in flight) | `ExchangePanes.tsx`, `ExchangeExtras.tsx` |
| Dock panels: Timeline, Summary, Structure, Performance/Statistics, Convert (URL, Base64, hex, HTML, JWT, timestamp, JSON) | `Dock.tsx`, `DockInsights.tsx` |
| Row actions: Open as request, Resend, Compare two exchanges, copy URL/cURL/headers, save body, bookmark, delete, Ask AI (`explain-exchange`), Create flow, Save to collection, Save as test, RAG dataset | `DebuggerGrid.tsx` menu, `DebuggerView.tsx:255` |
| Sessions: save/open HAR in `debugger/`, SAZ import, HAR/JSON/CSV export, AutoSave every minute, history entry per capture, masked git share (`debugger/shared/`) | `session.ts`, `har.ts`, `saz.ts`, `share-session.ts` |
| Incoming (mock server hits) tab | `DebuggerGrid.tsx:492` |
| CLI `testpion debug` (--json, --rules, --decrypt, -w, --save-collection, -o har), `flow from-har` | `packages/cli/src/commands/` |
| MCP: `debugger_capture/exchange/exchanges/rules/session/stats/save_to_collection`, `flow_from_exchanges`, `git_share_session` | `packages/core/src/mcp-server/`, `docs/public/llms.txt` line 18, 89, 122 |

Not found in code: any bandwidth or latency throttle (only a fixed delay), upstream/gateway proxy setting, client certificates, SAZ or FARX export, user-defined columns, session comments, image/XML/HTML body views, a scripting hook, a command bar, connection-abort or random-fault actions, TLS version/cipher display, QUIC handling.

## 3. Parity matrix

Legend for TestPion: Yes / Partial / No / In flight. Gap column = FG id.

### Capture and setup
| Feature | Classic | Everywhere (tier) | TestPion | Gap |
| --- | --- | --- | --- | --- |
| System proxy capture | Yes | Yes (Free ?) | Yes, `capture.ts` | - |
| Capture a browser / terminal | Partial (launch IE/Chrome) | Yes | Yes, `debug.openBrowser/openTerminal` | - |
| One-click capture all + HTTPS | Yes | Yes | In flight | - |
| Network-adapter capture (programs that ignore the proxy) | No | Beta | No (doc says such programs are not captured) | FG-14 |
| Process filter / crosshair "any process" | Yes | Partial (app grouping 8.1) | Partial: Application column, filter, Capture only rule | FG-16 |
| Pause listing without stopping the proxy (F12) | Yes | Yes | No (Stop stops the proxy) | FG-13 |
| Extra listen port / reverse proxy | `!listen` | Reverse proxy | Yes (reverse proxy for one API) | - |
| Upstream proxy ("gateway") and bypass list | Yes | Yes | No | FG-9 |
| Host remapping (hosts file replacement) | HOSTS tool | Yes, 8.2 | Partial: redirect rule sends host, path kept; no preserve-host, protocol or port control, no OS hosts import | FG-4 |

### Traffic list and columns
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Core columns (#, result, protocol, host, URL, body, caching, content type, process, comments, custom) | Yes | Yes | Partial: no Caching, Content-Encoding, Comments, custom columns | FG-12, FG-17 |
| Group by domain or application | No | 8.1 | Partial: Structure panel groups by domain | FG-17 |
| Comment / mark / colour a session | Yes | Notes | Partial: bookmark and rule highlights only | FG-11 |
| Find sessions / select by (type, header, status, host, size) | Yes | Filters + search | Partial: filter box + rules; no "select matching" | FG-3 |
| QuickExec command box | Yes | No | No | FG-3 |
| Keyboard shortcuts | Many | Some | Yes (arrows, Enter, Delete, F5, F6, Ctrl+F, Ctrl+E) | - |

### Inspectors
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Headers, Raw, Cookies, Hex, JSON, Auth, Params | Yes | Yes | Yes (Cookies/Params in flight) | - |
| Image view | Yes | Yes | No | FG-8 |
| XML tree, HTML/WebView preview | Yes | Partial ? | No | FG-8 |
| Caching inspector | Yes | ? | No | FG-10 |
| TLS / certificate details | Partial (Certificates tab) | Yes | No | FG-10 |
| Statistics / timeline | Yes | Yes | Yes (Timeline, Summary, Performance) | - |
| Protobuf, MessagePack, SignalR, Socket.IO | No (extensions) | Yes (Protobuf 8.0, others) | Partial: gRPC only | FG-19 |
| GraphQL | No | listed ? | No (graphql is in `textLike` only) | FG-20 |
| Custom inspectors | .NET extension | Classic inspectors in 8.3 | No | Not planned (see FG-21) |
| Agent / LLM traffic inspector, MCP traffic | No | Yes, 8.0 | No | FG-18 |

### Filters
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Filters tab (host, process, URL, header, flags, size, method, status, content type) | Yes | Yes, saved filters | Yes (rules `only`/`ignore` + presets) | - |
| Hide CONNECTs, hide 304 | Menu | Filter | Partial: hide tunnels; no 304 toggle | FG-15 |

### Rules, AutoResponder, breakpoints
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Header add/remove | Script | Rule | Yes | - |
| Auto-reply canned response | Yes | Yes | Yes | - |
| Reply from a file / folder (Map Local), regex with groups | Yes | Yes | No (inline body only) | FG-6 |
| Map Remote with path rewrite, URL replace | `urlreplace`, regex AR | Yes | Partial (host only) | FG-6 |
| Regex find/replace in body, status rewrite | Script | Rule | No (whole-body replace only) | FG-7 |
| Breakpoints on request/response, by URL/status/method | Yes | Yes | Yes (rule); no one-click "break on all requests" | FG-5 |
| Fault actions: drop connection, timeout, % failure, truncate | Script | ? | No | FG-7 |
| Throttling / modem speeds | Menu | ? | No (delay only) | FG-1 |
| Rule export/import (FARX) | Yes | Yes | Partial: own JSON in `debugger/rules.json` (git) | FG-22 |
| Rule presets | Menu | Presets | Yes | - |
| Disable caching, strip/force encodings, UA switcher, require proxy auth | Menu | Presets | Partial: header/no-cache preset only | FG-15 |

### Composer and replay
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Composer (build, send) | Yes | Yes + saved collections | Yes: whole request editor, collections | - |
| Reissue / reissue and edit / unlock | Yes | Replay | Yes (Resend, Open as request) | - |
| Reissue N times, in parallel, selected in order | Yes (Reissue sequentially) | ? | No | FG-2 |
| QUERY method etc. | - | 8.1 | Verify in request editor (not checked) | - |
| API testing / OpenAPI import | No | Yes | Yes (core product) | - |

### Sessions and sharing
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Save/load SAZ | Yes | Yes | Import SAZ only; HAR both ways | FG-22 |
| HAR import/export | Yes | Yes | Yes | - |
| Compare two sessions | WinDiff | Beta | Compare two exchanges; not two captures | FG-12b (see FG-23) |
| Shared sessions with notes and comments | No | Yes (Pro ?) | Partial: masked git share, no comments | FG-24 |
| Jam-style bundle for support | - | Jam product | No | FG-24 |
| AutoSave | Yes | Yes | Yes (privacy changes in flight) | - |

### Scripting and extensibility
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| FiddlerScript (OnBeforeRequest/Response, custom columns, menu items) | Yes | - | No | FG-21 |
| C# scripting hooks incl. WebSocket message and cert validation | - | Beta 8.2 | No | FG-21 |
| Extensions (.NET) | Yes | no | No | Not planned |
| Embeddable engine (FiddlerCore) | Yes | - | Partial: `@testpion/core` + CLI + MCP, not documented as an SDK | FG-25 |

### HTTPS
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Decrypt, trust root, skip hosts | Yes | Yes | Yes (trust-by-hash in flight) | - |
| Client certificate for servers that need one | Yes | ? | No | FG-9b (in FG-9) |
| Ignore server cert errors | Option | Option | Yes (`insecureUpstream`; UI exposure unchecked) | - |
| Custom CA / own root | Option | "coming" | No | FG-9 |

### Remote and mobile
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| LAN capture + cert download page + QR | Yes | Yes | Yes | - |
| Android emulator / end-user machine capture | - | Yes (by request access) | No | Not planned until cloud (FG-24) |

### Protocols
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| WebSocket frames | Yes | Yes | Yes | - |
| Edit/inject/break WebSocket frames | Script | Hook | No | FG-26 |
| SSE | Partial | Yes | Yes | - |
| gRPC | Extension | Yes | Yes | - |
| HTTP/2 | Yes | Yes | Yes | - |
| HTTP/3 / QUIC | No | No (believed) | No; no QUIC-off flag on browser launch found | FG-27 (note) |

### Performance tools
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Throttle / modem simulation | Yes | ? | Delay only | FG-1 |
| Timing breakdown, statistics | Yes | Yes | Yes | - |
| Cache analysis | Caching inspector | ? | No | FG-10 |

### Reporting and collaboration, integrations
| Feature | Classic | Everywhere | TestPion | Gap |
| --- | --- | --- | --- | --- |
| Reports / export CSV, Excel | Partial | Yes | CSV, JSON, HAR | - |
| IDE/AI assistant via MCP | No | Yes (8.0) | Yes (MCP server, 7 debugger tools) | - |
| AI chat assistant on traffic | No | Yes | Yes (Ask AI explain) | - |
| SSO, policies, offline install | No | Enterprise | Cloud version later | Not planned |
| Test automation hook | Test Studio | ? | CLI/MCP, flows from capture | - |

## 4. Gaps

Size: S <= 1 day, M <= 3 days, L <= 1-2 weeks. Every item ships with: CLI `--json`, an MCP tool (or a new action on `debugger_rules` / `debugger_exchanges`), a line in `docs/public/llms.txt`, a docs paragraph in `docs/api-testing/http-debugger.md`, unit tests in `tests/unit`, and an e2e plan in `apps/desktop/e2e/plans` (named below). UI uses shared components (Menu, Dialog, DockPanel, Tabs), sentence case, one place per action.

### P0 (a Fiddler user misses these on day one)

**FG-1 Network speed simulation (throttle).** Fiddler: modem-speed menu limits bandwidth and adds latency to every session. TestPion: a fixed delay only (`rules.ts` modify `delayMs`). Why: "does it fail on a slow phone connection" is the first thing people test; a delay does not make a large body slow. Proposal: add `throttle: { downKbps, upKbps, latencyMs }` to modify rules (scope by match) plus a global Network speed menu in the Capture bar (Off, 3G, Slow 3G, Edge, custom); implement as a pacing Transform in `proxy.ts` for request and response streams; presets in `rules.ts` PRESETS. CLI `testpion debug --throttle 3g`, MCP `debugger_rules` action `add` with `throttle`. Size M. Risk: pacing on 5,000-row perf budget (apply only to throttled exchanges). Tests: unit with a fake clock (bytes per second within 10%); e2e `debugger-throttle`. Dependencies: touches `proxy.ts` hot path; sequence after the perf branch merges.

**FG-2 Replay many: reissue N times, in parallel, selected in order.** Fiddler: reissue sequentially, edited, repeated. Charles: repeat with iterations and concurrency. TestPion: Resend one row. Why: reproduce a flaky failure or a rate limit. Proposal: row menu Resend gets a submenu "Resend 10 times", "Resend selected in order", "Resend…" (dialog: count, concurrency, delay, stop on first failure); engine `debugger/replay.ts` uses the existing send path, results land in History and in a small result table (status counts, min/p50/max time) with Open as request. CLI `testpion debug replay <id> --times 10 --concurrency 2 --json`; MCP `debugger_replay`. Size M. Risk: accidental load on a real server: cap 200 and ask once for non-local hosts. Tests: unit (counts, stop-on-failure); e2e `debugger-replay`. Conflicts: none.

**FG-3 Find, select and a command bar.** Fiddler: Find Sessions, Select by (type, header, status, host, size), QuickExec (`?text`, `>size`, `=status`, `@host`, `bpu`, `cls`, `select`, `urlreplace`). TestPion: filter box and rules, no "select every row matching" and no command line. Why: speed for power users and agents. Proposal: Edit ▸ Select matching… dialog (same condition editor as the Highlight rule editor, `RuleCondition` in `rules.ts`) that selects rows (then Delete, Save to collection, Create flow work on them); a command bar inside the existing command palette (Ctrl+K) with a "Debugger:" prefix grammar mapped to existing actions (no second implementation): `?text` filter, `>200kb`, `=404`, `@host`, `bp url`, `clear`, `hosts`. CLI `testpion debug exchanges --where "status>=400" --json` (extends `debugger_exchanges` filters); MCP: same filter DSL. Size M. Risk: grammar creep; keep to 10 verbs, documented. Tests: unit grammar parser; e2e `debugger-select`. Dependencies: in-flight quick filters (reuse `quick-filter.ts`, and fix its OR/AND finding first).

**FG-4 Host remapping.** Fiddler Everywhere 8.2: map a host (optional port) to another host, IP and port; protocol override (auto, http, https); preserve-host (original Host header and SNI kept); import from the OS hosts file; global on/off; Classic had the HOSTS tool. TestPion: redirect rule `{host, scheme}`, path kept, nothing said about Host header. Proposal: a "Host remapping" dialog under Capture (table: from, to, protocol, preserve host, enabled) stored as a rule kind `remap` (or fields on `redirect`: `preserveHost`, `port`, `ip`) in `rules.json`, so git-tracked and profile-switchable; import hosts file read-only (disabled rows). Preserve-host affects `proxy.ts` upstream `Host` header and `servername`. CLI `testpion debug remap add api.test=localhost:3000 --keep-host`, MCP `debugger_rules` kind `remap`. Size S-M. Risk: TLS name mismatch handling (only for the remapped connection, as Fiddler does). Tests: unit (Host header and SNI under both settings); e2e `debugger-remap`.

**FG-5 One-click automatic breakpoints.** Fiddler Rules ▸ Automatic Breakpoints (before requests, after responses, only on POST, only on 4xx/5xx), `bpu`/`bps`/`bpv` in QuickExec. TestPion: breakpoint rule exists but needs an editor. Proposal: a Breakpoints split button in the filter strip (Off, Every request, Every response, Only POST, Only errors, Custom…) that creates/removes one managed rule named "Auto breakpoint" (visible in the Rules panel); also a "Resume all" button when several are held. CLI/MCP: `debugger_rules` action `breakpoints` {mode}. Size S. Risk: users forget breakpoints on (rules bar already warns). Tests: unit; e2e extends `debugger-workbench`. This is also Quick win Q1.

**FG-6 Map local (reply from a file or folder) and URL rewrite.** Fiddler AutoResponder: answer from a file or folder, regex match with capture groups (`regex:.../$1`), `urlreplace`. TestPion: reply body is inline text. Proposal: `reply.file` (workspace-relative path or folder + path mapping) with content-type from extension; `redirect.rewrite: { from: regex|glob, to: "$1" }` for path changes (Map Remote). Files are read at request time (live edit). Guard: only inside the workspace folder (cloud-safe, no arbitrary path read). Row menu: "Reply with a file…". CLI/MCP via `debugger_rules` fields. Size M. Risk: path traversal, so resolve inside the workspace and refuse `..`. Tests: unit (traversal, regex groups, folder mapping); e2e `debugger-map-local`.

**FG-8 Content-aware body views.** Fiddler: ImageView, XML tree, WebView (HTML render), SyntaxView, form/multipart view. TestPion: text, JSON tree, Raw, Hex. Proposal: add tabs by content type on the response side using the existing Tabs strip: Image (png/jpg/gif/webp/svg shown with size and dimensions), XML tree, HTML preview in a sandboxed iframe with scripts off and network blocked by CSP, Form/Multipart parts table (Params in flight covers urlencoded only). Binary download via Save content exists. Size M. Risk: preview must not execute content (sandbox="" and `<meta http-equiv=CSP>`); never load remote subresources. Tests: unit (type routing); e2e `debugger-views`. MCP: `debugger_exchange` already returns bodies; add `view: "xml"|"image-meta"` info (dimensions, type) only.

**FG-9 Gateway (upstream proxy), custom CA and client certificates.** Fiddler Options ▸ Gateway: forward through a corporate proxy, bypass list; client certificate for mutual TLS; HTTPS options. TestPion: connects direct (`upstream-guard.ts` only guards addresses). Why: on a corporate network nothing works without a gateway; day-one blocker. Proposal: Capture ▸ Connections… dialog: upstream proxy (system, none, manual `host:port`, auth), bypass list, extra CA files, client certificates per host (reuse the Certificates store that already exists for requests: `list_certificates` MCP). Engine: `proxy.ts` upstream agent using `https-proxy-agent` style tunnelling. CLI flags `--upstream http://proxy:3128 --no-upstream-for "*.local"`. Size L. Risk: proxy auth secrets (keep in secret store, redact), SSRF guard interplay. Tests: unit with a fake upstream proxy; e2e `debugger-upstream`.

### P1 (strong value)

**FG-7 Rewrite and fault actions.** Fiddler: Script and Rules for regex replace, status rewrite, drop, delay. Charles-style fault injection. TestPion: whole body replace, delay. Proposal: modify rule gains `replaceBody: [{find, replace, regex}]`, `setStatus`, and a fault `action`: abort connection, never respond (timeout), truncate at N bytes, fail X% of requests. Chaos from the traffic of a real app is the TestPion pitch for "does my app handle failures". UI: rule editor fields; presets "Drop connection", "Timeout", "Fail 20%". MCP via `debugger_rules`. Size M. Risk: the proxy must clean sockets on abort (soak test). Tests: unit; e2e `debugger-faults`.

**FG-10 TLS and caching inspectors.** Fiddler: Certificates tab, Caching inspector (freshness, validators, "would a browser cache this"). TestPion: none (no TLS version/cipher captured). Proposal: record `tlsVersion`, `cipher`, `alpn`, server cert subject/issuer/expiry/chain on exchanges (upstream socket in `proxy.ts`); new "Connection" section in Summary; "Caching" section computed from headers (Cache-Control, ETag, Expires, Age) with a plain-words verdict. Why: "why did this fail" is often an expired cert or a stale cache. Size M. Tests: unit (caching verdicts table); e2e extends `debugger-workbench`. MCP: fields on `debugger_exchange`.

**FG-11 Comments, marks, colours.** Fiddler: Comment, Mark, session flags, notes in shared snapshots. TestPion: Bookmark. Proposal: per-exchange `note` (text) and `mark` (colour) set from the row menu and a Comments column; saved in HAR as `comment` (field exists in `har.ts`, verify round trip). MCP `debugger_exchange` action `annotate`. Size S. Tests: unit HAR round trip; e2e short plan.

**FG-12 Custom columns and missing columns.** Fiddler: Columns ▸ add column from a header or flag. Proposal: Columns menu gets "Add column from header…" (name, request or response) and built-ins Caching, Content-Encoding, Client port, Protocol, TLS, Comments; stored per workspace. Size S-M. Tests: unit; e2e extends `debugger-workbench`.

**FG-13 Pause capture.** Fiddler: F12 toggles capturing without detaching. Proposal: "Pause" in the capture bar: the proxy keeps forwarding but stops listing; MCP `debugger_capture` action `pause|resume`. Size S.

**FG-15 Menu presets pack.** Fiddler Rules menu: Hide 304s, Disable caching, Remove all encodings, Apply GZIP, User-Agents menu (Chrome, Firefox, iPhone, bot…), Require proxy authentication. Proposal: add presets to `PRESETS` in `rules.ts` and a "User agent" submenu in Change this traffic; Hide 304s as a quick filter chip. Size S. Tests: unit on preset shapes.

**FG-17 Group by domain / application in the grid.** Everywhere 8.1. Proposal: Group by menu in the grid (None, Domain, Application, Connection) with collapsible groups; virtualised list must keep 33 ms budget, so group headers are rows in the same virtual list. Size M. Risk: perf; measure with `perf-debugger`.

**FG-18 AI traffic inspector (LLM and MCP calls).** Everywhere 8.0 added an agent inspector, MCP traffic capture and cache recommendations. TestPion fits this strongly. Proposal: recognise OpenAI, Anthropic, Gemini, Ollama and MCP JSON-RPC bodies; an "AI call" tab: messages, tools, model, token usage, cost estimate, streamed (SSE) output reassembled, prompt-cache hit hints; Ask AI is pre-filled with that view; MCP traffic view lists tool calls by name. MCP `debugger_ai_calls`. Size L. Risk: provider formats change (keep a small adapter table in `packages/core/src/debugger/ai-calls.ts`, tolerant parse). Tests: unit with sample bodies per provider; e2e `debugger-ai-calls`.

**FG-19 Binary protocol decoders.** Protobuf (without .proto: field-by-field, already done for gRPC), MessagePack, SignalR, Socket.IO frames. Size M. Reuse the Convert panel decoders.

**FG-20 GraphQL view.** Operation name and type in a URL suffix/column, variables, query formatted, errors array highlighted. TestPion has GraphQL elsewhere (`graphql_operation` MCP) so reuse the parser. Size S-M.

**FG-22 SAZ export and FARX rules import.** Fiddler: archives and rule archives; Everywhere imports Classic settings. TestPion: SAZ import only. Proposal: Export as SAZ (zip of raw request/response files; reverse of `saz.ts`) and Import Fiddler rules (.farx) mapped to rule kinds with a report of what could not be mapped. CLI `testpion debug export --saz`, `debug rules import --farx`. Size M (FARX format unverified; a spike first, risk: format not publicly documented).

**FG-23 Compare two captures.** Diff two sessions: requests added, removed, status or timing changed, matched by method + URL pattern. Why: "what changed between the green and the red run". Reuse Compare of exchanges. UI: Session ▸ Compare with… MCP `debugger_session` action `diff`. Size M. Tests: unit on matching; e2e `debugger-session-diff`.

**FG-24 Share and support bundle (Shared Sessions and Jam equivalent).** Local first: Session ▸ Share… creates one file (`.tpbundle`: masked HAR, active rules, environment facts such as app version, OS, proxy settings, optional notes) that a colleague or support opens in their TestPion (extends `git_share_session`). Comments per exchange travel inside (FG-11). Online link and team comments wait for the cloud version. Size M. Open question Q2.

**FG-14 Capture programs that ignore the proxy.** Everywhere has a beta network-adapter mode. TestPion's docs list the limitation. Proposal: research spike (S) on Windows per-process redirection (WinDivert needs a signed driver; an alternative is launching a program with `HTTP_PROXY`/`--proxy-server` flags, which exists) and a "Launch a program through the proxy…" action for .NET (`DOTNET_SYSTEM_NET_HTTP_USESOCKETSHTTPHANDLER`/proxy env) and Java (`-Dhttp.proxyHost`) that sets the right switches. Full adapter capture: P2, XL. Size S for the launcher.

### P2 (nice to have)

**FG-16 Process picker** (crosshair equivalent): a list of running processes with connections to pick as Capture only. Size S; the Application filter covers most use.
**FG-21 JS rule scripts (replaces FiddlerScript).** A `tp.*` scripting API: `onRequest(ctx)`, `onResponse(ctx)`, `onWebSocketMessage`, `onSessionCompleted`, in a sandbox (Node `vm` / the existing script sandbox used for request scripts, with timeout and sync-only like Everywhere's guardrails), one file per script in `debugger/scripts/` (git-tracked), editor with the existing Monaco-based script editor, ordering and a global switch. Size L. Risk: security (no `require`, no fs, time limit 50 ms per hook; same sandbox as collection scripts). Do after FG-6/FG-7 prove the declarative rules; anything scripts do that rules cannot is the evidence for the API. MCP `debugger_scripts` (list, set, enable, test against an exchange). Not planned: .NET FiddlerScript syntax, custom inspector/extension DLLs, `FiddlerObject` UI calls.
**FG-25 Engine as SDK** (FiddlerCore equivalent): document `@testpion/core` debugger API (start proxy, rules, events) and a Node example; Size S.
**FG-26 WebSocket frame rules**: break, modify or drop frames; send a frame into an open connection. Size M.
**FG-27 QUIC note**: browser launch adds `--disable-quic` (Chromium) so HTTP/3 does not bypass the proxy; Firefox pref `network.http.http3.enable=false`. Size S (could be Quick win Q6).
**FG-28 Large-session mode**: files over 5,000 exchanges spill to disk (needs scalability work already in review files; not Fiddler-driven).

### Not planned (with the TestPion-native equivalent)
| Fiddler feature | Reason | Equivalent |
| --- | --- | --- |
| FiddlerScript syntax, `FiddlerObject`, .NET extensions and custom inspector DLLs | .NET only | FG-21 JS scripts with a `tp.*` API |
| Fiddler Classic Windows hooks (WinINET restore, "Tools ▸ Windows Internet Explorer Options") | Windows legacy | System proxy switch exists |
| Fiddler Jam hosted link, Everywhere cloud sync, SSO, policies, offline licence | Needs the hosted service | FG-24 local bundle now, cloud version later |
| Test Studio / Telerik integrations | Vendor products | Flows, CLI, MCP |
| Remote capture of end-user machines | Needs agent + cloud | Not before cloud |

## 5. Quick wins (each <= 1 day)

| ID | Item | Where |
| --- | --- | --- |
| Q1 | One-click automatic breakpoints (FG-5) | filter strip split button, `rules.ts` |
| Q2 | Pause listing (FG-13) | proxy `listing` flag + MCP action |
| Q3 | Menu presets: Hide 304s, User agent submenu, remove encodings (FG-15) | `PRESETS` in `rules.ts`, Change this traffic menu |
| Q4 | Comments and marks on exchanges (FG-11) | HAR `comment`, row menu, column |
| Q5 | `--disable-quic` / Firefox pref when opening a browser (FG-27) | `capture.ts` browser args |
| Q6 | Image preview tab (first slice of FG-8) | `ExchangePanes.tsx` |
| Q7 | Copy as PowerShell / fetch / HTTPie from the row (Fiddler and Proxyman have curl and code snippets; `parse_request_snippet` exists the other way) | row Copy menu |
| Q8 | Header as a column (first slice of FG-12) | `DebuggerGrid.tsx` columns |
| Q9 | Document the engine as an SDK and CLI cookbook (FG-25) | docs |

## 6. Release grouping

| Release | Items | Theme |
| --- | --- | --- |
| 0.55 | Finish in-flight work; FG-5, FG-13, FG-15, FG-11, FG-27 | Fiddler day-one menu parity, cheap |
| 0.56 | FG-1 throttle, FG-4 host remap, FG-6 map local and rewrite, FG-7 faults | Traffic shaping (the rules that make testing real) |
| 0.57 | FG-2 replay, FG-3 select and command bar, FG-12 columns, FG-17 grouping | Power-user speed |
| 0.58 | FG-8 body views, FG-10 TLS and caching, FG-20 GraphQL, FG-19 decoders | Inspectors |
| 0.59 | FG-9 gateway/client certs, FG-22 SAZ/FARX, FG-23 session compare, FG-24 bundle | Enterprise and sharing |
| 0.60 | FG-18 AI traffic inspector, FG-21 JS scripts, FG-14 launcher | Differentiators |

Order logic: FG-9 is P0 but L and touches the proxy core; if the owner knows users behind corporate proxies, pull it to 0.56.

## 7. What TestPion does that Fiddler does not (verified in code)

| Claim | Evidence |
| --- | --- |
| Ask AI on an exchange (explain, why failed), with redaction first | task `explain-exchange` in `packages/core/src/ai/tasks/registry.ts`; `DebuggerView.tsx:255` |
| Create a test flow from captured traffic (ids and tokens linked as variables, noise dropped, secrets to variables) | `CreateFlowDialog.tsx`, MCP `flow_from_exchanges`, CLI `flow from-har` |
| Captured traffic to saved requests in a collection with variables | MCP `debugger_save_to_collection`, `testpion debug --save-collection` |
| RAG dataset from capture | MCP `rag_capture_dataset`, `packages/cli/src/commands/rag-capture.ts`, row menu "Create RAG dataset" |
| Rules as git-tracked files with profiles; masked share of a session via git | `debugger/rules.json`, `share-session.ts`, MCP `git_share_session` |
| Full CLI with `--json` and MCP server over the same engine (Fiddler has MCP for IDEs since 8.0, but no CLI-first engine) | `packages/cli/src/commands`, `mcp-server/` |
| Incoming tab: requests received by TestPion's mock servers shown next to captured traffic | `DebuggerGrid.tsx:492` |
| Reverse proxy to collection with responses as examples | `record/recorder.ts`, docs |
| Redaction by default on every view and export (no "include secrets" option) | docs, `har.ts` |
| Saved Debugger sessions appear in History with what they became | `capture-history.ts` |
| gRPC decoded with the workspace's own .proto files | `grpc.ts` |

Not claimed: "free" (Classic is free), "open source" (unchecked), "faster" (no benchmark against Fiddler).

## 8. Open questions for the owner

1. Is Windows-only per-process capture (programs that ignore the system proxy) worth an L investment, or is the launcher with the right proxy switches (FG-14, S) enough?
2. Should "share a session" stay local (a bundle file plus git, FG-24) until the cloud version exists, or do you want a hosted share link as the first cloud feature?
3. Is a JS scripting API (FG-21) wanted at all, or should declarative rules (FG-6, FG-7) be the ceiling to keep the Debugger simple and safe?
4. Which comes first for your users: corporate gateway and client certificates (FG-9) or the AI traffic inspector (FG-18)?
5. Should throttling (FG-1) be a global "Network speed" switch only, or also a per-rule setting (more power, more UI)?
6. May rules and sessions travel in a Fiddler-compatible format (SAZ export, FARX import, FG-22) even though FARX is not publicly specified and needs reverse engineering from sample files?
