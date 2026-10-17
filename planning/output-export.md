# Download and export every output: plan

Owner (2026-10-17): "For all the output of all types give a down arrow button to download or export the result of the output. For all types of output UI throughout the application, to make it user friendly and usable."

The owner's screenshot shows the REST response viewer's Body tab (JSON tree, Pretty/Raw, the toolbar "Expand all / Collapse all / Filter with JSONPath"). It has two problems:

- It has **no download**.
- Its toolbar is **broken**: "Expand all" is clipped on the left ("xpand all"), and the filter box and the hint "Click a key to copy its JSONPath, save it to a variable or check it" crowd and overflow each other (§3h).

Starting point: v0.48.1 is released and 0.49.0 is being finished. Line numbers are from the tree on 2026-10-17. Paths are relative to `apps/desktop/src` unless they start with `apps/`, `packages/` or `tests/`.

---

## 0. Summary

- **81 output surfaces** were found (36 in protocol response viewers and request tools, 47 elsewhere, minus 2 counted in both lists).
- **69 of them (85 %) have no way to save to a file.** Copy-only counts as "no download".
- **12 can save today, through 6 different mechanisms.** Three of those are broken or partial:
  - The response's "Save response" appears only when `payloadPath` is set, and saves raw bytes only.
  - The Tests view's runs list exports HTML only.
  - Debugger "Export as HAR" calls an RPC that does not exist (`app.saveText`), so it always falls back to a browser download.
- **No chart can be exported** (no PNG, SVG or CSV of its data). **No table can be saved as CSV**: JsonTable only copies CSV to the clipboard or saves it into `datasets/`.
- **One design**:
  - one `OutputDownload` control (a down-arrow split button);
  - one hook, `useOutputExport(source)`;
  - one shared registry of format builders;
  - one backend RPC family, `output.*`, that writes through the existing `saveOrDownload` (native dialog on desktop, download in the browser or cloud), streaming large outputs from the backend;
  - one `OUTPUT_SURFACES` registry with a completeness test, so a new output without a download fails CI.
- **Roadmap:**
  - **Patch (0.49.x, 1 agent-day):** the toolbar fix and the `app.saveText` fix.
  - **Release A (8 agent-days):** the component, registry and RPC, plus the response viewer, run results, console/logs and the matrices.
  - **Release B (9 agent-days):** the remaining surfaces, the CLI `--out/--format`, MCP "saved to file", and the redaction polish.

---

## 1. Inventory of output surfaces

Legend for **Today**:

- **—** nothing
- **C** copy to clipboard
- **S** save to file (the mechanism is named)

**Bar** is the component that renders the actions today. **Gap** is what the owner's request needs.

How saving works today:

- **Backend.** Every save is its own handler that calls `Backend.saveOrDownload(name, filters, write, read)` (`apps/desktop/backend/backend.ts:518-533`). On desktop it calls `host.saveDialog`, which is `dialog.showSaveDialog` (`apps/desktop/electron/main.ts:366`). Otherwise it returns base64 content, and refuses anything over 100 MB.
- **Renderer.** `finishSave()` and `downloadContent()` (`lib/files.ts:11-37`) finish the save. A few surfaces skip the backend and download a Blob themselves (`downloadContent`).
- **Copy.** Copying goes through `copyText` / `useCopied` (`lib/clipboard.ts:5,17`).
- **Icons.** `action-icons.tsx:69` already maps labels starting "Export…" or "Download…" to a download icon.
- **Shared bars.** `IconButton` is `components/ui.tsx:93`, `Tabs` (with a `right` slot) is `:196`, `Menu` is `:470`, `Segmented` is `:820`, `MoreMenu` is `:875`, and `OverflowActions` is `:904`. There is **no** `ResponseBar`: every viewer builds its own `h-9 border-b` header div.

### 1a. Response viewers and request tools

| # | Surface | file:line | Today | Bar | Gap |
|---|---|---|---|---|---|
| 1 | Response header (REST, SOAP) | `components/ResponseViewer.tsx:137-161` | S "Save response" → `http.saveBody` (`backend/handlers/requests.ts:86`), **only when `response.payloadPath`** is set (:124-132), raw only, name `response.json`/`.txt` | `OverflowActions` :161 | Always shown; raw / pretty / headers+body / HAR / cURL+response; smart filename |
| 2 | Body ▸ Pretty (JSON tree) | `ResponseViewer.tsx:204` → `JsonView.tsx:183-218` | C per node (JSONPath) | inline toolbar (broken, §3h) | Download (pretty / minified / the filtered matches) |
| 3 | Body ▸ Pretty (XML/HTML) / Raw | `ResponseViewer.tsx:220` → `JsonView.tsx` `RawView` | C | `IconButton` in RawView | Download |
| 4 | Body ▸ Table | `ResponseViewer.tsx:206` → `JsonTable.tsx:48` (Copy CSV :103-109, Save as dataset :116-126) | C (CSV), saves into `datasets/` | `Button` | CSV / TSV / JSON file |
| 5 | Body ▸ Preview (HTML) | `ResponseViewer.tsx:218` | — | — | .html |
| 6 | Body ▸ Visualize | `ResponseViewer.tsx:207-216` | — | — | .html (sanitised page) / PNG |
| 7 | Headers | `ResponseViewer.tsx:222,288` (KvTable) | — | — | Copy, .txt / .json / CSV |
| 8 | Cookies | `ResponseViewer.tsx:224-250` | — | — | Copy, CSV / JSON / Netscape cookies.txt |
| 9 | JWT | `ResponseViewer.tsx:251` → `JwtView.tsx:9` | — | — | Copy token / claims JSON (redacted by default) |
| 10 | Timeline | `ResponseViewer.tsx:252,331` | — | — | JSON / Markdown |
| 11 | Tests (checks + script console) | `ResponseViewer.tsx:253-278` | — | — | Markdown / JUnit / JSON |
| 12 | Stream | `ResponseViewer.tsx:279` | C | `IconButton` | .txt |
| 13 | Trace | `ResponseViewer.tsx:281` → `TraceView.tsx:51` (copy :189-216) | C | `Tabs` + raw button | trace JSON / OTLP JSON |
| 14 | cURL tab | `ResponseViewer.tsx:282` | C | `IconButton` | .sh / .ps1 |
| 15 | Response history (body) | `ResponseHistory.tsx:53,160-169` | C (Raw) | `IconButton` | download an old body |
| 16 | History compare | `ResponseHistory.tsx:174` | — | — | unified diff / Markdown |
| 17 | Diff vs previous | `ResponseDiffPanel.tsx:15,74` | — | `IconButton` | unified diff / Markdown / JSON |
| 18 | SSE events | `SseEvents.tsx:17,103`; `views/RestView.tsx:619` | C (one event) | `Button` | all events .jsonl / .txt (text/event-stream) / CSV |
| 19 | Code generation | `CodeModal.tsx:18,44-49` | C | `Button` | .sh / .py / .js … file |
| 20 | Cookie jar | `CookiesModal.tsx:39` | — | `IconButton` | JSON / cookies.txt (redacted by default) |
| 21 | PartsTable (multipart) | `PartsTable.tsx:26` | — | — | per part raw bytes |
| 22 | CodeBlock (read-only `<pre>`) | `CodeBlock.tsx:9` | — | — | Copy and download in its own corner (small: Copy only) |
| 23 | GraphQL response / Raw / Table / Tests | `views/GraphQLView.tsx:539-560` | C, CSV copy | own div + `Tabs` | as #1 (a payload is spooled, `backend.ts:943`, but never offered) |
| 24 | GraphQL subscription events | `GraphQLView.tsx:511-530` | — | own header | .jsonl |
| 25 | GraphQL SDL | `GraphQLView.tsx:638` | C | `IconButton` | .graphql |
| 26 | gRPC response, messages, metadata, trailers | `views/GrpcView.tsx:527-560` | C (grpcurl, request side :320) | own div + `Tabs` | JSON / .jsonl stream / grpcurl |
| 27 | WebSocket / Socket.IO / MQTT / Kafka log | `views/WebSocketView.tsx:591-640` (keeps 20,000 messages, :178) | — (Clear only) | own header | .jsonl / CSV / .txt; one message's payload |
| 28 | MCP tool result | `components/mcp/ToolsPanel.tsx:200-279` | C + S (renderer Blob, :209,231) | `Segmented` + `IconButton` | move onto the shared control (native dialog) |
| 29 | MCP resource read | `components/mcp/McpPanels.tsx:97,228-231` | — (a blob shows only "<binary N chars>") | `Button` | raw bytes with the resource's mime |
| 30 | MCP prompt output | `McpPanels.tsx:243,303-318` | — | `Button` | JSON / Markdown |
| 31 | MCP protocol trace | `views/McpView.tsx:593-640` | — | own filter bar | .jsonl (JSON-RPC log), redacted |
| 32 | MCP server info | `McpView.tsx:416` | — | — | JSON |
| 33 | MCP toolset snippets | `components/mcp/ToolsetEditor.tsx:281` | C | `IconButton` | file |
| 34 | API preview (schemas) | `ApiPreviewPanel.tsx:98,110,146` | — | `Button` | JSON / YAML |
| 35 | AsyncAPI preview (payloads, examples) | `AsyncPreviewPanel.tsx:72,76,89` | — | `Button` | JSON |
| 36 | Image / binary bodies | none (decoded as text in Raw) | — | — | raw bytes with Content-Type; new image viewer later (out of scope) |
| 37 | Request-tab response pane (container) | `views/RestView.tsx:615-632` | delegates to #1 | — | — |

### 1b. Runs, logs, reports, tables and charts

| # | Surface | file:line | Today | Bar | Gap |
|---|---|---|---|---|---|
| 38 | Console panel | `ConsolePanel.tsx:45` (`Shell.tsx:284`) | — | — | .log / .jsonl / HAR of its HTTP entries (redacted) |
| 39 | Terminal | `TerminalPanel.tsx:361` (copy on select :202,:559) | C | — | transcript .txt (ANSI stripped) |
| 40 | Problems | `ProblemList.tsx:47`, `ProblemsPanel.tsx:7` (AttentionCard copies Markdown, `AttentionCard.tsx:36`) | — | — | Markdown / JSON / CSV |
| 41 | Run panel | `RunPanel.tsx:53`, `ExportMenu` :203, :328-341 | S Export ▾ HTML / JSON / JUnit / Markdown → `runs.exportReport` (`backend/handlers/testing.ts:208`) | `Menu` + `Button` | becomes the shared control; + CSV, ZIP (all reports) |
| 42 | One result (ResultDetail) | `RunPanel.tsx:395` | — | `Tabs` | request + response as HAR / JSON |
| 43 | Checks / error panel | `Results.tsx:160` / `:88` | — | — | Markdown / JSON |
| 44 | Runs overview | `RunsOverview.tsx:228` | — | — | CSV / JSON |
| 45 | Flow run timeline | `RunTimeline.tsx:36,79` | S HTML → `tests.flowTimelineHtml` (`backend/handlers/flow-scale.ts:231`) | `Button` | onto the shared control; + JSON |
| 46 | Run charts | `RunCharts.tsx:197` | — | — | PNG / SVG / CSV of the series |
| 47 | Test history | `TestHistory.tsx:27` | — | — | CSV / JSON |
| 48 | Tests view runs list | `views/TestsView.tsx:1012-1017` (also :473) | S "Export report…" **HTML only** | row menu | all report formats |
| 49 | Collection runner results | `CollectionRunner.tsx:59` → RunPanel :484 | as #41 | — | as #41/#44 |
| 50 | Flow scale / data / matrix grids | `FlowScaleGrids.tsx:130,366,516` | — | — | CSV / JSON / HTML |
| 51 | Flow debug (history, variables timeline) | `FlowDebugParts.tsx:41,136` | — | — | JSON / CSV |
| 52 | Environment matrix | `EnvMatrix.tsx:22` | — | — | CSV / Markdown / JSON |
| 53 | Environment compare | `EnvCompare.tsx:35` | — | — | CSV / Markdown (secrets masked) |
| 54 | Load results, charts, status codes | `views/LoadView.tsx:86,528,570`; `LoadCharts.tsx:97,113` | — | — | JSON (= CLI `load --json`) / CSV / HTML / PNG |
| 55 | Load history | `LoadHistory.tsx:72` | — | — | CSV |
| 56 | Monitor runs, charts, requests | `views/MonitorsView.tsx:75,473`; `MonitorCharts.tsx:268`; `MonitorRequests.tsx:21` | — | — | CSV / JSON / PNG |
| 57 | Evaluations / EvalMatrix | `views/EvaluationsView.tsx:69`; `EvalMatrix.tsx:183` | one run through RunPanel | — | matrix CSV / Markdown / HTML |
| 58 | AI Lab Playground | `views/ai/Playground.tsx:24` | (save as test / eval case) | `Button` | answer .md / .json (with usage) |
| 59 | AI Lab Compare | `views/ai/Compare.tsx:12` | — | — | Markdown / CSV / JSON |
| 60 | AI usage / feature usage | `AiUsage.tsx:25`; `ai/AiFeatureUsage.tsx:14` | — | — | CSV / JSON |
| 61 | MCP usage | `McpUsage.tsx:17` | — | — | CSV |
| 62 | AI proposals / flow proposals / findings | `ai/ProposalReview.tsx:37` (copy :280); `FlowProposalReview.tsx:24`; `Findings.tsx:30` | C | plain button | Markdown / patch / JSON |
| 63 | AI analysis (triage, flaky) | `ai/AiAnalysisDialog.tsx:41` | — (core `triageMarkdown` exists, `packages/core/src/report/triage-report.ts:19`) | — | Markdown / JSON |
| 64 | Assistant answers | `AssistantPanel.tsx:36` (copy :418, code copy :357) | C | — | conversation .md / .json |
| 65 | Debugger sessions | `views/DebuggerView.tsx:249-256` | S HAR, but through the **missing** `app.saveText`, so always a Blob download | `Menu` (ToolRail) | fix; HAR (sanitized default) / CSV / JSON |
| 66 | Debugger grid | `debugger/DebuggerGrid.tsx:149` (copy :287-292; bodies :299-303 Blob) | C + S | `Menu` | selection as HAR / CSV; bodies via native dialog |
| 67 | Debugger exchange panes | `debugger/ExchangePanes.tsx:39` (copy :67,:237) | C | `Button` | raw request/response .txt / HAR |
| 68 | Debugger insights | `debugger/DockInsights.tsx:26,158,233,317` | — | — | CSV / JSON |
| 69 | History view | `views/HistoryView.tsx:135,211-215` | S HAR → `history.exportHar` (redacted) | `Button` | onto the shared control; + CSV / JSON |
| 70 | Traces view / trace payloads | `views/TracesView.tsx:78` (copy link :93; OTLP push `traces.exportOtlp`) | C | row menu | OTLP JSON file / JSON |
| 71 | Git changes / diffs / item history | `views/GitView.tsx:104`; `GitCommitPanel.tsx:55`; `GitItemDiffDialog.tsx:16`; `GitItemHistoryBody.tsx:27` | — (core `changesMarkdown`, `packages/core/src/git/semantic.ts:254`) | — | .patch / Markdown |
| 72 | API lint | `ApiLintPanel.tsx:31` | — | — | SARIF / JSON / Markdown |
| 73 | API fuzz | `ApiFuzzPanel.tsx:85` (save as tests :166) | — (core `fuzzMarkdown`, `openapi/fuzz.ts:339`) | `Button` | Markdown / JSON |
| 74 | API coverage | `ApiCoverageDialog.tsx:71,137` | S .md (Blob) | `Button` | onto the shared control; + JSON |
| 75 | Security review | `SecurityReviewDialog.tsx:19` | — | — | Markdown / JSON |
| 76 | OpenAPI diff | `OpenApiDiffDialog.tsx:71` | — | — | Markdown / JSON |
| 77 | Home dashboard, activity, latency charts | `views/HomeView.tsx:161,332` (workspace report HTML → `report.workspace`); `ActivityCharts.tsx:242`; `LatencyTrend.tsx:19`; `charts.tsx:19` (ChartCard) | S HTML report | `Button` | every ChartCard: PNG / SVG / CSV |
| 78 | Settings diagnostics | `views/SettingsView.tsx:286-292` | C | `Button` | .txt / .json |
| 79 | Variables table | `VariablesTable.tsx:10` | — | — | CSV / .env (secrets masked) |
| 80 | Collection docs | `CollectionDocs.tsx:15,45,48` | S Markdown (Blob) + HTML (`col.exportDocsHtml`) | `Button` | onto the shared control |
| 81 | Agents / Mock call log / Storage | `AgentsPanel.tsx:71` (copy :159); `MockPanel.tsx:32` (copy :108); `StoragePanel.tsx:19` | C / — | `Button` | the mock call log as .jsonl / HAR; storage report CSV |

Non-output surfaces that are left out: `QuickOpen.tsx:23`, `ai/AiAction.tsx:30` (a launcher), `FlowRunDock.tsx:14` (a container), and `MessageRate.tsx:16` (a badge).

### 1c. Counts

The counts are per view. Some rows above group 2–3 views (for example #54 and #81), so the row numbers do not add up to the totals.

| | Surfaces (per view) | Save to file today | Lacking a download |
|---|---|---|---|
| Responses and request tools (§1a, without the #37 container) | 36 | 2 (#1 conditional, #28 Blob) | 34 (11 copy only, 23 nothing) |
| Runs, logs, reports, tables, charts (§1b, per view) | 47 | 11 | 36 (9 copy only) |
| Counted in both lists (JsonTable, MCP tool result) | −2 | −1 | −1 |
| **Total** | **81** | **12** | **69 (85 %)** |

The 12 that save today use **six different mechanisms**:

1. `http.saveBody`
2. `runs.exportReport`
3. `tests.flowTimelineHtml`
4. `history.exportHar`
5. `report.workspace` / `col.exportDocsHtml`
6. Renderer Blob downloads that bypass the native dialog (ToolsPanel, ApiCoverageDialog, CollectionDocs Markdown, DebuggerGrid bodies, Debugger HAR)

They also use **five different button styles**:

- the "Export ▾" Menu
- an `OverflowActions` item
- a plain Button labelled "HAR"
- a "Download .md" button
- row-menu items

That breaks the uniform-UI rule even before the 69 gaps.

### 1d. What already exists to build on

- **Engine reporters** in `packages/core/src/report/reports.ts`:
  - `ReportFormat = json|junit|html|markdown` (:9)
  - `writeJsonReport` :45, `writeJUnitReport` :57, `writeMarkdownReport` :100, `writeHtmlReport` :238
- **Other exporters**:
  - `workspaceReportHtml` (`report/workspace-report.ts:49`)
  - `collectionMarkdown` and `collectionHtml`
  - `flowRunTimelineHtml` (`runner/flow-report.ts:114`) and `timelineHtml` (`packages/shared/src/flow-timeline.ts:225`), which is the themed self-contained HTML we reuse
  - `exchangesToHar` (`debugger/har.ts:65`) and `historyToHar` (`storage/history-har.ts:14`), both redacting
  - `apiCoverageMarkdown`, `fuzzMarkdown`, `changesMarkdown`, `triageMarkdown`
  - `rowsToCsv` (`runner/generate-dataset.ts:136`, datasets only: no injection guard)
- **Redaction** (`packages/core/src/util/redact.ts`):
  - `Redactor` :13 with `redact()` :63, `redactHeaders()` :42, `redactUrl()` :89 and `redactString()` :57
  - `maskSensitiveText()` :199
  - `redactForAi()` :233, which returns what was masked
  - The backend reaches it as `be.logger.redactor`.
- **Large bodies.** The renderer only gets `bodyPreview`, capped at `maxPreviewBytes`:
  - The cap is 2 MB by default (`packages/core/src/protocols/http/client.ts:23`) and 64 MB for GraphQL (`graphql.ts:72`).
  - Larger bodies set `truncated` (`client.ts:533`), and the full body is spooled to `payloads/resp-*.bin` (`backend.ts:729,943`).
  - SSE keeps at most 10,000 events (`client.ts:18`).
  - So the full output is already **in the backend, not the renderer**. The design keeps it that way.
- **CLI file output:**
  - `-o/--out` + `-r/--reporter` on `run-collection`, `test` and `eval run`
  - `report -f`
  - `-o <file>` on `workspace-report`, `export`, `docs`, `ci`, `history export-har`, `flow export`, `debug`
  - `--html` on `flow report`, `--markdown` on `openapi fuzz` and `coverage`, `--json <file>` on `load`
  - Everything else is `--json` / `--jsonl` to stdout only (`packages/cli/src/output.ts`, `contract.ts:16`). The commands with no `--out` include ai, git, history list/stats/diff, monitor, env matrix/diff, openapi-diff/lint, eval compare/matrix and load-history.
- **MCP truncation.** `packages/core/src/mcp-server/tool-contract.ts`:
  - `fitResult` :239 cuts long lists and strings.
  - The note at :412-424 says "Truncated — … To see more or less: response_format …" and adds a `truncated` field.
- **E2E dialog stub.** `apps/desktop/e2e/harness.cjs:19` replaces `dialog.showSaveDialog` when `E2E_STUB_SAVE` is set (a path, or `CANCEL`).

---

## 2. Research: how other tools do it

Vendor docs rarely state icons, default filenames or shortcuts. Where a claim could not be confirmed it says so.

| Tool | Placement and icon | Formats and choice | Large or binary | Redaction | Source |
|---|---|---|---|---|---|
| Postman | Response pane ⋯ "View more actions ▸ Save response to file" | the body; runner "Export results" is one raw JSON blob (users find it unreadable; readable reports come from Newman / Postman CLI reporters) | "Max response size in MB" setting (about 50 MB); "Send and Download" streams to disk; Hex/Base64 views for binary | none | learning.postman.com/docs/sending-requests/response-data/responses/ ; community.getpostman.com/t/collection-runner-export-results/9473 ; learning.postman.com/latest-v-12/docs/postman-cli/postman-cli-reporters |
| Postman console | Ctrl+Alt+C; Clear, filters; keeps 5,000 messages | no export; "select all + copy" copied only the visible rows (a known bug) | — | — | learning.postman.com/docs/sending-requests/response-data/troubleshooting-api-requests/ ; community.getpostman.com/t/copy-from-console-broken-only-partial-output-on-clipboard/9110 |
| Insomnia | Preview dropdown ▸ "Save Raw Response" | raw bytes, pitched "if the response is too large"; a plugin names files from Content-Disposition | historically hung on large binaries | — | docs.insomnia.rest/insomnia/responses ; insomnia.rest/plugins/insomnia-plugin-response-save |
| Bruno | Response actions: Download Response, Copy Response, Save as Example | "various formats such as HTML" | not documented | — | docs.usebruno.com/send-requests/res-data-cookies/res-data |
| Hoppscotch | Download and Copy in the response pane; ⋮ for examples | download asks for a format (JSON / XML) | not documented | — | docs.hoppscotch.io/documentation/getting-started/rest/response-handling |
| HTTPie (CLI) | `-o/--output FILE`; `-d/--download` guesses the filename like wget | body only | streams | — | manpages.opensuse.org/Leap-15.6/httpie/http.1.en.html |
| Chrome DevTools | **down-arrow "Export HAR (sanitized)…"** in the Network action bar, up-arrow Import next to it; right-click Copy ▸ Save all as HAR, Copy as cURL / fetch / PowerShell | HAR | — | **Sanitized is the default**: drops Cookie, Set-Cookie and Authorization. "With sensitive data" only after an opt-in setting (Chrome 130+) | developer.chrome.com/docs/devtools/network/reference ; support.posit.co/hc/en-us/articles/4413166624279 |
| Charles | File ▸ Export; right-click Copy cURL | CSV (summary), trace text, XML | — | — | charlesproxy.com/documentation/using-charles/export/ |
| Proxyman | right-click the selection or a domain node ▸ Export | HAR 1.2, CSV, Postman v2, raw body; **scope**: selection / domain / all | CLI `export-log --format` | warns that a HAR holds cookies and tokens | docs.proxyman.com/basic-features/import-export ; proxyman.com/posts/2019-08-16-Share-HTTPS-requests-with-HAR-file |
| Grafana | panel menu ▸ Inspect ▸ Data ▸ **Download CSV**; toggles "Formatted data" and "Download for Excel"; dashboard Export ▸ "Export as image" (preview, then download) | CSV / JSON (panel, data, DataFrame) / PNG | the PNG depends on the window size | — | grafana.com/docs/grafana/next/visualizations/panels-visualizations/panel-inspector/ ; grafana.com/docs/grafana/latest/dashboards/share-dashboards-panels |
| Datadog | widget menu: PNG / CSV / copy; Analytics More ▸ CSV | capped at 5,000 rows | — | — | docs.datadoghq.com/dashboards/widgets/ ; docs.datadoghq.com/product_analytics/charts/analytics_explorer/export/ |
| GitHub file view | top right: "Raw", copy icon (aria "Copy raw content"), **download icon (aria "Download raw file")** | raw | — | — | docs.github.com/en/repositories/working-with-files/using-files/viewing-and-understanding-files |
| VS Code | no documented save action for an Output channel (unverified) | — | — | — | — |

**CSV injection.** OWASP lists the dangerous leading characters as `=` `+` `-` `@`, Tab, CR and LF (and the full-width forms). The fix is to quote every field, double inner quotes, and prefix risky cells with `'`. A first-character check alone is not enough when separators or quotes inside a value open a new cell. Symfony switched from a tab prefix to `'` (CVE-2021-41270). Sources: owasp.org/www-community/attacks/CSV_Injection ; nvd.nist.gov/vuln/detail/CVE-2021-41270.

**Electron `dialog.showSaveDialog`** (electronjs.org/docs/latest/api/dialog):

- It returns `{canceled, filePath}`.
- `defaultPath` may be a directory plus a file name.
- `filters` take extensions without dots, with `'*'` meaning All Files.
- Pass the parent window to make it modal.
- The OS confirms overwrite (`showOverwriteConfirmation` on Linux).
- `dontAddToRecent` exists on Windows.

**Patterns we adopt:**

1. A **download icon at the top right of every output, next to Copy**, with a descriptive aria-label (GitHub, Chrome).
2. A **format choice at download time** (Hoppscotch, Proxyman, Grafana), with a sensible default on the plain click.
3. **Raw bytes streamed to disk** for big or binary bodies (Insomnia, Postman "Send and Download"). Never a giant string in the UI.
4. **Sanitized by default for logs and HAR**, with an explicit, labelled opt-in for sensitive data (Chrome 130+).
5. **Scope**: what you see (the filtered set) or everything (Proxyman). The copy and the export must cover the **whole** data set, not the rendered rows (Postman's console bug).
6. Charts get **PNG / SVG and the CSV of their data** (Grafana, Datadog).
7. **CLI parity**: `-o` / `--format` (HTTPie, Newman).

---

## 3. Design

### The design in 8 lines

1. **One control.** `<OutputDownload>` is a down-arrow split button: a click saves the default format, ▾ chooses a format, Copy sits next to it. It lives in `components/output/`, and every output surface uses it through **one hook**, `useOutputExport(source)`.
2. **Surfaces describe, they do not write.** Each surface passes `{ id, suggestedName, formats: [{ id, label, ext, mime, build }] }`. Builders come from **one registry** (`packages/shared/src/output/`): JSON pretty/min, raw, CSV/TSV with an injection guard, HTML, Markdown, XML, HAR, cURL, unified diff, JUnit, PNG/SVG, ZIP.
3. **Big data never visits the renderer.** A format is either **client** (a small in-memory view, at most 1 MB) or **source** (`{ kind: 'response' | 'run' | 'console' | …, ref }`). The backend builds source formats and streams them straight into the chosen file through the RPCs `output.save` / `output.progress` / `output.cancel` on top of `saveOrDownload`. That works the same on desktop, browser and cloud.
4. **The OS "Save as…" dialog always** (so no silent overwrite). It opens in the last folder used for this workspace and output kind. Afterwards a toast offers **Show in folder** and **Open**. Over 5 MB a progress line with Cancel appears.
5. **Secrets.** Log-like outputs export **redacted by default**, with a "Redacted" badge and a confirmed "Include secrets…". The raw response body is the user's own data: it exports raw, with a notice when the Redactor would have masked something, and with a production notice.
6. **Filenames** follow `<METHOD>-<name>-<yyyy-mm-dd-HHMM>-<status>.<ext>`, sanitised for Windows, macOS and Linux and kept within length limits. The server's Content-Disposition name wins for a raw body.
7. **Keyboard.** **Ctrl+Shift+S** downloads the focused output, as a rebindable command (`download-output`), listed in the shortcuts page and the palette ("Download output…"). Ctrl+Shift+C copies it.
8. **Registry and parity.** Every surface is an entry in `OUTPUT_SURFACES` and is marked `data-output="<id>"`. A completeness test fails when a marked surface lacks the control. The CLI gets `--out <file> --format …` on every result command, and MCP tools save big results into `exports/` and say "full output saved to …".

### 3a. The component, the hook and the format registry

**Files:**

| File | What |
|---|---|
| `packages/shared/src/output/formats.ts` | `OutputFormatId`, the builder registry, pure and browser-safe. Builders: `jsonPretty`, `jsonMin`, `jsonl`, `csv`, `tsv`, `markdownTable`, `markdownDoc`, `xml` (pretty, via the one formatter `lib/pretty` → moved to shared), `htmlDoc` (self-contained, themed: reuses the `timelineHtml` shell from `flow-timeline.ts:225`), `unifiedDiff`, `curl` (re-exports the existing snippet generator), `junit` (re-exports the core one through a shared type) |
| `packages/shared/src/output/csv.ts` | RFC 4180 writer (CRLF, every field quoted when it holds `"` `,` CR LF or a leading/trailing space), the **injection guard** (below), BOM option for Excel, TSV variant |
| `packages/shared/src/output/filename.ts` | `outputFileName(parts)`, `sanitizeFileName(name)` (§3d) |
| `packages/shared/src/output/surfaces.ts` | `OUTPUT_SURFACES` registry (§3f) |
| `packages/core/src/output/` | backend-only builders that need the workspace or full data: `har` (wraps `exchangesToHar` / `historyToHar`), `responseRaw` (streams the spooled payload), `runZip` (every report of a run plus `results.csv`), `consoleLog`, `tracesOtlp`, `chartCsv`. Each is `(store, ref, opts) => AsyncIterable<Uint8Array>` |
| `apps/desktop/backend/handlers/output.ts` | RPCs `output.save`, `output.copy`, `output.progress` (event), `output.cancel`, `output.formats` (for CLI/MCP discovery). This is a new module, because `backend.ts` is at 1450 of its ceiling (`tests/unit/architecture.test.ts:88`) |
| `apps/desktop/src/components/output/OutputDownload.tsx` | the control. A new module, because `ui.tsx` is at 1096 of the 1200 cap |
| `apps/desktop/src/components/output/use-output-export.ts` | the hook, focus registration for Ctrl+Shift+S, progress state |

**Builder contract (shared):**

```ts
export type OutputFormatId = 'json' | 'json-min' | 'jsonl' | 'raw' | 'text' | 'csv' | 'tsv' | 'html' | 'md' | 'xml' | 'har' | 'curl' | 'diff' | 'junit' | 'png' | 'svg' | 'zip' | 'otlp' | 'sarif';

export interface OutputFormat {
  id: OutputFormatId;
  label: string;            // "JSON (pretty)", "CSV for Excel"
  ext: string;              // without the dot
  mime: string;
  /** client: built in the renderer from what the surface holds (≤ 1 MB, else it must be a source format). */
  build?: () => Promise<Blob | string> | Blob | string;
  /** source: the backend builds and streams it (full data, never through the renderer). */
  source?: OutputSource;
  /** Which secrets policy applies (§3c). */
  redaction: 'redacted-default' | 'raw-notice' | 'none';
  default?: boolean;
}

export type OutputSource =
  | { kind: 'response'; payloadPath?: string; historyId?: string; traceId?: string; part: 'body' | 'pretty' | 'exchange' | 'har' | 'curl' }
  | { kind: 'run'; runId: string; part: 'html' | 'json' | 'junit' | 'md' | 'csv' | 'zip' }
  | { kind: 'console' | 'logs' | 'terminal'; filter?: unknown }
  | { kind: 'history' | 'traces' | 'debugger'; query?: unknown; ids?: string[] }
  | { kind: 'grid'; grid: string; ref: string }        // scale/data/env matrix, load, monitor, eval matrix rows
  | { kind: 'chart'; chart: string; ref: string };     // CSV of a chart's series (the PNG/SVG are client)

export interface OutputSpec {
  id: string;                      // the OUTPUT_SURFACES id ('response.body', 'run.report', 'console' …)
  suggestedName: string | (() => string);
  formats: OutputFormat[];
  copy?: () => string | Promise<string>;  // the Copy beside it (default: the default format when it is text and ≤ 5 MB)
  scope?: { visible: number; total: number; label?: string }; // "Filtered: 37 of 2,000 rows" → choose
}
```

**The hook:**

```ts
const out = useOutputExport(spec); // { download(formatId?), copy(), busy, progress, cancel, props }
<OutputDownload {...out.props} />  // or <OutputDownload spec={spec} /> for the common case
```

**The control** (one look everywhere):

- **Shape.** A split button: the `Download` icon (lucide `Download`, arrow over a tray, as on GitHub and Chrome), then `▾`. Next to it is a `Copy` IconButton.
  - Both are `h-7`, ghost, and sit in the surface's top-right action bar.
  - When the bar is narrow they fold into the `OverflowActions` ⋯ menu as **"Download ▸"** with the formats as a submenu. That is the existing overflow pattern, so no new folding logic.
- **Click.** A plain click saves the default format, or the last format chosen on this surface (remembered per surface id with `scopedKey`).
- **▾ menu, top section:** the formats. Each row shows its label, extension and an estimated size ("~48 MB"). The default has a check mark.
- **▾ menu, scope section** (when `scope` is given): "What is shown (37 rows)" or "Everything (2,000 rows)". The default is **everything**, which avoids Postman's console bug. The filtered set is one click away.
- **▾ menu, bottom section:** "Copy as…" with the text formats, and "Include secrets…" (§3c) where the policy is `redacted-default`.
- **Accessibility.**
  - The button's `aria-label` is "Download <what>" (for example "Download response body").
  - The menu button's label is "Choose a download format", with `aria-haspopup="menu"`.
  - Focus returns to the button when the dialog or menu closes.
  - The toast is announced through the existing live region.
- **Markers.** `data-output-download` on the control and `data-output="<id>"` on the surface root (§3f).
- **Kept outside the control:** the run panel's "Export ▾" Menu, the History "HAR" button, the Coverage "Download .md" button, the docs Export buttons and the MCP Save result button are **replaced** by the control. The old RPCs stay, and become `source` formats.

### 3b. Behaviour: saving, progress, big and binary outputs

- **One RPC.**
  - `output.save { surface, format, suggestedName, filters, source | content: { text } | { base64 }, redaction: 'default' | 'include-secrets' }` returns `{ path } | { download } | {}`.
  - It reuses `saveOrDownload`, so the desktop gets the OS dialog and the browser or cloud gets a download. The 100 MB browser cap stays, with a message that points to the CLI.
  - The missing `app.saveText` (`views/DebuggerView.tsx:253`) becomes a call to `output.save`.
- **Filters.** The format's extension comes first, then "All files (*)" (Electron filter rules).
- **`defaultPath`** is `join(lastFolder, suggestedName)`:
  - `lastFolder` is remembered **per workspace and per surface kind**, in the workspace's local meta, under `exports.lastFolder.<surface-kind>`, not in git.
  - The first time it is the OS Downloads folder.
  - With `dontAddToRecent` off, saved files appear in the OS recent list, which users expect.
- **No silent overwrite.**
  - The OS dialog confirms a replace.
  - In the browser fallback the browser adds its own " (1)".
  - The backend never writes to a path it did not get from the dialog.
- **Streaming.** `saveOrDownload` gains an async `write(dest, signal, onBytes)`. Source builders are `AsyncIterable<Uint8Array>` piped into `createWriteStream(dest)` with back-pressure.
  - **Response body:** `copyFile` of the spooled payload, as today.
  - **Pretty JSON of a 50 MB body:** a streaming pretty-printer over the payload, not `JSON.stringify` of a parsed copy.
  - **A 10,000-row grid:** rows are read from the run store and written as they come.
  - **Partial files.** The writer writes to `<dest>.part` and renames on success, so a cancel or failure leaves no half file.
- **Progress and cancel.**
  - Outputs over 5 MB, or taking more than 300 ms, show a slim progress line in the toast: "Saving response… 12 / 48 MB · Cancel".
  - It is driven by `output.progress { jobId, bytes, total }` events, at most 10 per second.
  - `output.cancel { jobId }` aborts the job and deletes the `.part` file.
- **After saving.** The toast reads "Response saved to C:\…\GET-patients-…json", with **Show in folder** and **Open**.
  - Show in folder needs a new optional `host.showItemInFolder` (Electron `shell.showItemInFolder`).
  - Open uses the existing `host.openPath`.
  - Both are hidden where the host has no shell (browser, cloud), which already downloaded the file.
- **Binary-safe.**
  - `raw` formats are bytes end to end: the spooled file, or base64 in `content`.
  - The extension comes from Content-Type: `image/png` → png, `application/pdf` → pdf, unknown → bin.
  - Text formats are UTF-8 without a BOM, except "CSV for Excel", which adds a BOM.
- **Client formats are capped.** A client builder that would produce more than 1 MB must be declared as a `source` format. A dev-mode assertion warns when it isn't. So no giant strings in the renderer, and the 33 ms two-frame budget holds.
- **Copy** goes through the same builders, capped at 5 MB. Over that, Copy is disabled with a tooltip: "Too large to copy (48 MB): download it instead".
- **Cloud-ready.**
  - The UI only names a **source** and a **format**. The host decides where bytes go: a file, a browser download, or a cloud object with a signed URL later.
  - No paths are read by the UI.
  - Multi-user: `exports/` and the remembered folder are per user.

### 3c. Privacy and secrets policy

| Policy | Surfaces | Default export | Opt-in |
|---|---|---|---|
| **redacted-default** | console, logs, terminal transcript, traces, history (HAR/CSV), debugger HAR/CSV, run reports, triage/flaky reports, AI conversation, MCP protocol trace, cookie jar, JWT claims, env compare, variables, settings diagnostics | Redactor (`redact`, `redactHeaders`, `redactUrl`) **plus** `maskSensitiveText` for credentials found by their shape (`packages/core/src/util/redact.ts:199`). PII masking is off by default for exports, since the user's own data stays theirs; it is a toggle in the ▾ menu. A **"Redacted"** badge sits next to the control. | ▾ "Include secrets…" opens a confirm dialog: "This file will contain N secret values (Authorization header, 2 secret variables). Anyone with the file can use them." → [Cancel] [Save with secrets]. It is remembered for **this one save only**. |
| **raw-notice** | response body (raw, pretty), GraphQL/gRPC/WS payloads, MCP tool/resource results, a debugger body | Raw, because it is the user's own data. When `redactForAi` (dry run, first 1 MB) would have masked something, a one-line note shows under the menu and in the toast: "Contains what looks like a token (access_token). Saved as is." | ▾ "Save redacted copy" |
| **production** (adds to either) | any output whose request ran against an environment marked production (`lib/production-guard.ts`) | as above | a notice in the menu and the toast: "From the production environment" |
| **none** | API lint, coverage, OpenAPI diff, generated code without secrets, charts | as is | — |

Rules:

- The badge and notice come from **one** function, `exportRedaction(surface, sample)`, so no surface invents its own.
- Redaction runs **in the backend** for `source` formats.
- For `client` formats, the renderer gets a redacted copy from the backend. The renderer has no Redactor, and secrets live in the backend.
- HAR follows Chrome:
  - Sanitized drops `Cookie`, `Set-Cookie` and `Authorization`, plus every field the Redactor flags.
  - "With sensitive data" is the opt-in.
- The policy is listed in the docs page and in `OUTPUT_SURFACES`, so CLI and MCP apply the same defaults (`--include-secrets` is needed to opt in).

### 3d. Filenames

`outputFileName({ method?, name?, status?, when = now, ext })`:

- **Pattern.**
  - Response: `GET-patients-2026-10-17-1405-200.json`.
  - Run: `run-<suite>-2026-10-17-1405-passed.html`.
  - Grids: `<view>-<name>-<date>.csv` (for example `env-matrix-patients-2026-10-17-1405.csv`).
  - Charts: `<chart>-<date>.png`.
- **Raw body.** For a raw body, the server's `Content-Disposition` filename (RFC 6266 `filename*` first) wins, sanitised. The extension comes from Content-Type when the name has none.
- **Sanitising.**
  - Replace `<>:"/\|?*` and control characters with `-`, and collapse runs of `-`.
  - Trim spaces and dots at both ends, because Windows drops a trailing dot.
  - Prefix `_` to the Windows reserved names `CON`, `PRN`, `AUX`, `NUL`, `COM1-9` and `LPT1-9`, with or without an extension.
  - NFC-normalise.
- **Length.** The base is cut to 120 UTF-8 bytes. The extension is always kept, and the whole name stays at most 200 bytes, well below the 255-byte file-name limit and Windows MAX_PATH.
- **Collisions.** The dialog shows the name and the OS asks before it replaces a file. Where no dialog exists (CLI `--out` into a directory, MCP `exports/`), a `-2`, `-3` … suffix is added. `--out <file>` overwrites, as curl and HTTPie do, and the help says so.
- **Time.** Local time, `yyyy-mm-dd-HHMM`, no seconds, sortable.

### 3e. Keyboard and command palette

- **Ctrl+Shift+S (⌘⇧S)** is **free**:
  - `lib/shortcuts.ts:26-44` (COMMANDS) does not use it.
  - The fixed rows (:60-135) don't use it.
  - `reservedCombos` (:232) doesn't use it.
  - `electron/app-menu.ts` doesn't use it.
  - Monaco's default keymap does not bind it.
  - It matches the "Save as…" convention.
- **The command.** Add `{ id: 'download-output', label: 'Download the focused output', combo: 'Mod+Shift+S' }` to `COMMANDS`. That makes it rebindable in Settings ▸ Keyboard (`KeyboardSettings.tsx`) and listed on the shortcuts page and in `ShortcutsDialog` automatically. Add `{ fixed: ['Mod+Shift+C'], text: 'Copy the focused output' }` to the Anywhere rows.
  - Conflict check: Ctrl+Shift+C is DevTools "inspect" in Chromium. That only applies when DevTools is open, and the app menu doesn't bind it. Verify in the e2e. If it clashes, drop it: copy stays on the button.
- **What "focused" means.**
  - `useOutputExport` registers the surface on focus-within and pointer-enter (the last one wins).
  - If none is registered, the **active editor tab's** primary output is used (the response body, the run report).
  - If there is none, a toast says "No output here to download".
- **Palette.** "Download output…" opens the format menu of the focused surface. "Download output as <format>" entries are generated from the focused spec.
- **Menu bar.** File ▸ "Download Output…" with the accelerator `CmdOrCtrl+Shift+S` and `registerAccelerator: false`, as Reopen Closed Tab does, so the renderer owns the key and rebinding works.
- **Docs.** Update `docs/getting-started/keyboard-shortcuts.md`.

### 3f. The surface registry and the completeness test

`planning/master-roadmap.md` §1 defines the **item-kind** registry (`packages/shared/src/item-kinds.ts`, `Capability`, `CapabilityState = true | { na } | { planned }`, and the completeness test `tests/unit/kind-capabilities.test.ts`, §1.9). Output surfaces are not item kinds, but they follow the same rules:

1. **Kinds.** Add the capability **`export-output`** to `Capability` (§0.2, `master-roadmap.md:207`). Record kinds that are outputs (`run`, `history`, `trace`, `exchange`, `proposal`, `capture`) declare it `true` once their surface ships, or `{ planned: '0.5x' }` until then. Workspace kinds declare `{ na: 'a definition, exported by Export… (bundle)' }`. The §1.9 check for `export-output` asserts that the kind's main surface id is in `OUTPUT_SURFACES` with at least one format.
2. **Surfaces.** `packages/shared/src/output/surfaces.ts`:

   ```ts
   export interface OutputSurfaceInfo {
     id: string;                       // 'response.body', 'response.headers', 'run.report', 'console', 'env.matrix', 'chart' …
     label: string;                    // "Response body"
     kind?: KindId;                    // the record kind it shows (run, history …)
     formats: readonly OutputFormatId[];
     default: OutputFormatId;
     redaction: 'redacted-default' | 'raw-notice' | 'none';
     cli?: string;                     // 'send --out', 'run-collection --out', 'env matrix --out' …
     mcp?: string;                     // the tool whose result is this output
     state: true | { na: string } | { planned: `0.${number}` };
   }
   export const OUTPUT_SURFACES: readonly OutputSurfaceInfo[];
   ```

3. **Markers.** Every output root gets `data-output="<id>"` (for example `<div data-output="response.body">`), and the control renders `data-output-download`.
4. **`tests/unit/output-surfaces.test.ts`** (static, fast):
   - **Marked means registered.** It finds every `data-output="…"` literal in `apps/desktop/src/**/*.tsx` and requires each to be in `OUTPUT_SURFACES`. Dynamic ids are not allowed: a grep for ``data-output={` `` fails the test.
   - **Registered means marked.** Every `OUTPUT_SURFACES` entry with `state: true` is marked in exactly one component file.
   - **Marked means the control is there.** A file that holds `data-output=` must also hold `<OutputDownload` or `useOutputExport(`.
   - **No private save paths.** Outside `components/output/**` and `lib/files.ts`, there must be no `downloadContent(` and no `call('…save…'` / `call('…export…'` save RPCs. The allow-list shrinks to empty in release B.
   - **Formats are real.** Every format id has a builder: a client builder in shared, or a source builder in core, checked through `output.formats`.
   - **Planned expires.** A `planned` state fails once `package.json` reaches that version, as in §1.9.
   - **Docs.** Every `na` reason is at least 12 characters, and all of them are snapshotted.
5. **A heuristic net for unmarked outputs:** the test also lists components that render `RawView`, `JsonTree`, `JsonTable`, `VirtualList` of result rows, `ChartCard`, `CheckList` or `<table>`. Each must either be inside a marked surface (static import graph: its parent file is marked) or be on a reviewed allow-list (`tests/unit/__snapshots__/output-surfaces.snap`). So a new results table can't slip in without a decision.
6. **E2E DOM check.** The plan `apps/desktop/e2e/plans/output-export.cjs` walks the views and asserts that every visible `[data-output]` contains a `[data-output-download]`.

### 3g. CLI and MCP parity

**CLI** (`packages/cli/src`): one shared option set, `addOutputOptions(cmd, { formats, default })`, in a new `packages/cli/src/output-file.ts`:

- **Flags.** `--out <file|dir>` and `--format <json|jsonl|csv|tsv|md|html|har|junit|raw|curl|diff|zip>`.
  - The format is inferred from the `--out` extension when `--format` is missing.
  - `--include-secrets` opts into secrets (redacted by default for the policies in §3c).
  - It uses the same shared builders as the UI, so the bytes are identical (tested).
- **Existing flags stay as aliases:** `-o/--out <dir>` + `-r` on run/test/eval, `--json <file>` on load, `--markdown <file>`, `--html <out>` on flow report, `-o <file.har>` on debug.
- **Added to:**

| Command | Formats |
|---|---|
| `send` / `request` | raw (default), json, har, curl, md |
| `test`, `run`, `run-collection`, `eval run` | html, json, junit, md, csv, zip (`--out dir` keeps today's behaviour) |
| `load` | json, csv, html, md |
| `history list`, `history diff` | json, csv, har / diff, md |
| `traces` | json, otlp |
| `debug` | har (sanitized default), csv, json |
| `flow report` | html, json, csv |
| `env matrix`, `env diff` | csv, md, json |
| `monitor runs` | csv, json |
| `eval compare` / `eval matrix` | csv, md, json |
| `openapi-diff`, `openapi-lint` | md, json, sarif |
| `ai usage`, `ai triage`, `ai flaky`, `git changes` | csv / md / md, patch |

- **Envelope.** With `--json` plus `--out`, the stdout envelope carries `{ savedTo, format, bytes, redacted }` and not the data. Agents read the file.

**MCP** (`packages/core/src/mcp-server`):

- **Tools whose result can be big** (`run_*`, `history_*`, `debugger_exchanges`, `traces_*`, `load_*`, `eval_*`, `send_request`) accept `save_to: 'exports'` and `format`. The tool writes `<workspace>/exports/<suggested-name>` (git-ignored, inside the workspace, never elsewhere: the path is resolved and checked with `isInside`). It returns `{ saved: 'exports/…', bytes, format, redacted }` plus a short summary.
- **Truncation note.** When `fitResult` (`tool-contract.ts:239`) truncates a result, the note at :412-424 gains: "Full output: call again with save_to: 'exports' (it is written to exports/<name>, N KB)". When `save_to` was given it says "Full output saved to exports/…".
- **Discovery.** A `list_output_formats` resource lists `OUTPUT_SURFACES` (id, formats, redaction, cli), which the llms.txt generator can also use. Do **not** edit `docs/public/llms.txt` by hand: it is generated.

### 3h. The JsonView toolbar glitch: cause and fix

The toolbar is `JsonView.tsx:185-217`, inside the body pane `ResponseViewer.tsx:197`, inside the `Split` pane `ui.tsx:666/680` (`min-w-0 overflow-hidden flex flex-col`).

**Causes, from reading the code.** The app was not run, as instructed. Verify with DevTools; the steps follow the fix.

1. **The filter is squeezed to 6 rem, and that crowds it into the hint.** The filter's wrapper is `flex flex-1 min-w-24 max-w-72` (:192). `flex-1` is `flex: 1 1 0%`, so in a wrapping flex line the browser places it by its **0 basis**, clamped to `min-w-24` (96 px).
   - The hint (:209) is `ml-auto … truncate` with an `auto` basis: its full text, about 400 px at text-xs.
   - So from the `@2xl` container width (42 rem, 672 px, where the hint appears) up to roughly 900 px, everything fits on **one** line only because the filter counts as 96 px.
   - The filter then grows only into what is left, often almost nothing. The result is a 96–120 px input whose placeholder "Filter with JSONPath, e.g. $.items[*].name" is cut off, right against the hint text.
   - In compact density, text-xs shrinks (`styles.css:157`), which moves the point but does not fix it.
2. **The input is taller than its row.** `.field` sets `min-height: var(--control-h)` (32 px, 28 px compact; `styles.css:344-353`). That overrides the `h-6` (24 px) on the SuggestInput (`JsonView.tsx:194`). The row is laid out for 24 px, and the input sticks out of the `py-1` toolbar, which looks crowded.
3. **"xpand all" is the pane scrolled sideways.** The `Split` panes are `overflow-hidden`. An `overflow: hidden` box is still **programmatically scrollable**, but it has no scrollbar to scroll it back. Two things in this toolbar make the pane's content wider than the pane:
   - The match/error span (:205) has no `truncate` or `max-w` and inherits `whitespace-nowrap`. A long "Not a valid JSONPath: …" message is wider than the line, so the toolbar overflows to the right.
   - The SuggestInput list (`SuggestInput.tsx:65`) is `absolute left-0 … w-max max-w-[min(32rem,80vw)]`. It is anchored at the input, which sits mid-row, so it reaches past the pane's right edge.

   When the user then types in the filter, focuses it, or moves through the suggestions, Chromium scrolls every ancestor, `overflow-hidden` ones included, to keep the caret or the active element visible. The Split pane gets a non-zero `scrollLeft`. The whole body shifts left by a few pixels, so "E" of "Expand all" is cut. It stays like that, because a hidden overflow has no scrollbar.

   The ResponseViewer header (`ResponseViewer.tsx:137`) is `overflow-hidden` too and can shift the same way.

**Fix** (shared components only, no per-view variants):

1. **The toolbar becomes the shared output toolbar** `components/output/OutputToolbar.tsx`, used by JsonTree, RawView, JsonTable and the other viewers:
   - It renders `left` (view tools: Expand all, Collapse all), `filter` (an optional input), `status` (the match count) and `right`: `<OutputDownload>` plus Copy, then the surface's `OverflowActions`.
   - Its layout is `flex items-center gap-2 min-w-0 overflow-clip`. `overflow: clip` cannot be scrolled programmatically, which ends the sideways shift.
   - Expand all and Collapse all become two **icon buttons** (`ChevronsUpDown` / `ChevronsDownUp`, the same icons as `TreeParts.tsx:465`), with labels in tooltips. On wide bars they show as text through `OverflowActions`, and on narrow bars they fold into ⋯.
2. **Filter sizing.** The filter wrapper becomes `flex-[1_1_14rem] min-w-40 max-w-96` (a real basis), so the line break and the space are decided by its true size, not 0.
3. **Status** becomes `min-w-0 truncate max-w-[40%]`, with the full error in `title`.
4. **The hint leaves the toolbar.** It moves into an **ⓘ IconButton** (`Info` icon, tooltip "Click a key to copy its JSONPath, save it to a variable or check it"), and the empty-filter placeholder carries a short form of it. Nothing competes with the filter any more.
5. **Small fields.** Add a `field-sm` modifier (`--control-h-sm: 24px`, compact 22px) in `styles.css` for toolbar inputs. The JSON filter, the WebSocket log filter and the MCP trace filter use it, instead of fighting `min-height` with `h-6`.
6. **The suggestion list** gets `max-w-[min(32rem,100%)]` and stays inside the surface. The longer-term fix is a portal, like `Menu`.
7. **Split panes and the ResponseViewer header** change from `overflow-hidden` to `overflow-clip` (`ui.tsx:666,680`; `ResponseViewer.tsx:137`). Chromium 90+ supports it, and Electron does. This fixes the same latent shift in every pane.
8. **Regression test** in e2e plan `output-export.cjs`:
   - Set the pane to 700 px and 1000 px wide, in both densities.
   - Type an invalid JSONPath and walk the suggestions.
   - Assert that the Split pane's `scrollLeft === 0`, that the toolbar's `scrollWidth <= clientWidth`, that the first button's `getBoundingClientRect().left >= pane.left`, and that the filter is at least 160 px wide.

**Verification steps (for the implementer).** In the running app, open DevTools on the clipped state and evaluate `[...document.querySelectorAll('.overflow-hidden')].filter(e => e.scrollLeft)`. That should list the Split pane. Then check the computed width of the filter span.

### 3i. Tests

| Kind | What |
|---|---|
| **Unit: builders** (`tests/unit/output-formats.test.ts`) | **CSV:** quotes, commas, CR/LF, empty versus null, unicode, BOM option; round-trip through a strict RFC 4180 parser gives the same cells. **Injection guard:** `=1+2`, `+1`, `-1`, `@SUM(…)`, `\t=`, `\r=`, full-width `＝`, and `a";=1+2` all come out quoted and prefixed with `'`; plain negative numbers like `-12.5` in a numeric column are kept as numbers (the guard skips cells that are a valid number, as OWASP allows, so the data stays usable; this is an owner decision, §5). **JSON:** pretty, min and jsonl round-trip. **HAR:** validates against the HAR 1.2 JSON schema (`tests/fixtures/har-1.2.schema.json`); sanitized has no Cookie / Set-Cookie / Authorization and no fixture secret. **Markdown tables:** escape `|` and newlines. **HTML:** self-contained (no external URL), escapes `<script>` in data, works in both themes. **Unified diff:** `git apply --check` on a fixture. **JUnit:** existing schema test. **ZIP:** lists the expected entries |
| **Unit: filenames** | reserved names, trailing dots, 300-character names, emoji, RTL, Content-Disposition `filename*=UTF-8''…`, collision suffixes |
| **Unit: streaming** | a 50 MB synthetic payload is pretty-printed through the streaming writer with memory growth under 64 MB (`process.memoryUsage().rss` delta), output equal to `JSON.stringify(JSON.parse(x), null, 2)` on a 1 MB sample; cancel leaves no `.part` file |
| **Unit: redaction** | for each policy: default output has no fixture secret; include-secrets has them; the raw-notice detection fires on a body with `access_token` |
| **Unit: surfaces completeness** | §3f.4–5 |
| **Unit: parity** | CLI `--out x.csv` and `output.save` with the same source give byte-identical files (env matrix, run CSV, history HAR) |
| **E2E** (`apps/desktop/e2e/plans/output-export.cjs`, real input through `real-input.cjs`, `E2E_STUB_SAVE=<tmp>/out.<ext>`, harness.cjs:19) | 10 representative surfaces: response body (JSON pretty, and raw of a 5 MB spooled body), response headers CSV, JsonTable CSV, SSE events jsonl, WebSocket log, run report ZIP, console log (redacted: the fixture token is absent), env matrix CSV, debugger HAR (sanitized), Home chart PNG (a valid PNG header, non-zero size). For each: click the down arrow, choose the format from ▾, assert the stubbed file's bytes and the toast; Ctrl+Shift+S on the focused body; `E2E_STUB_SAVE=CANCEL` gives no toast and no file; the "Include secrets…" confirm appears and works; plus the toolbar regression of §3h.8 |
| **Perf** (`apps/desktop/e2e/plans/_profile`-style, `TESTPION_PROFILE=1`) | exporting a 50 MB body: no main-thread long task over 50 ms in the renderer, frames stay within the 33 ms two-frame floor while the progress toast updates, renderer heap grows by under 10 MB (bytes never enter the renderer); a 10,000-row grid CSV in under 1 s; the open ▾ menu renders within one frame. Added to the perf budgets in the release gate (quality-bar) |
| **A11y** | the control has `aria-label` "Download …"; the menu button has `aria-haspopup`; Escape closes the menu and returns focus to the button; Tab order is Copy then Download then ▾; contrast in both themes; the toast is announced |

### 3j. Docs

- **New page** `docs/getting-started/save-and-export.md`, "Save and export results":
  - the down arrow, formats per surface (a table generated from `OUTPUT_SURFACES`), the redaction policy and "Include secrets…", filenames, Ctrl+Shift+S, big outputs and Cancel, the CLI `--out/--format`, MCP `save_to`
  - screenshots via `scripts/capture-steps.cjs`
- **Per-protocol mentions** (one line plus a link each):
  - `docs/api-testing/rest.md` (also replace the old "Save response" text)
  - `graphql/overview.md`, `api-testing/grpc.md`, `api-testing/websocket.md`, `mcp/*`
  - `test-runner/*` (run reports)
  - `api-testing/http-debugger.md` (sanitized HAR)
  - `docs/cli/reference.md` (the shared flags)
  - `getting-started/keyboard-shortcuts.md`
  - `security/*` (the redaction policy)
  - `features.md`, `whats-new.md`
- `llms.txt` is regenerated by its script, never edited.

---

## 4. Roadmap

This fits `planning/master-roadmap.md` as its own lane. "Nothing lost, nothing leaked" (0.50) is the natural home for release A, since it is a UI/leak release, but **that is the owner's call** (§5). Effort is in agent-days.

| Step | Scope | Effort |
|---|---|---|
| **Patch 0.49.x** | §3h toolbar fix (OutputToolbar skeleton without the download, `overflow-clip` on Split panes and the response header, `field-sm`, ⓘ hint, filter basis), the missing `app.saveText` → a real `output.save` text path, e2e regression | 1 |
| **Release A** | (1) shared `output/` builders + CSV guard + filenames + `OUTPUT_SURFACES` + completeness test (with a `planned` allow-list); (2) `handlers/output.ts` with streaming, progress, cancel, remembered folder, Show in folder; (3) `OutputDownload` + `useOutputExport` + `OutputToolbar` + Ctrl+Shift+S + palette + File menu; (4) surfaces: response viewer (#1–#14, #23, #26), JsonTable everywhere, SSE / WebSocket logs (#18, #24, #27), run panel / runs list / collection runner / runs overview / timeline (#41–#49, the old Export ▾ replaced), console / logs / terminal / problems (#38–#40), matrices and grids (#50, #52, #53, #57); (5) the redaction policy core (badge, Include secrets confirm, raw notice); (6) unit + e2e + perf; docs page | 8 |
| **Release B** | remaining surfaces: history, traces, debugger (grid, panes, insights, HAR sanitized default), MCP (#28–#33), AI Lab / usage / proposals / triage / assistant (#58–#64), git diffs (#71), API lint / fuzz / coverage / security / OpenAPI diff (#72–#76), charts PNG/SVG/CSV through ChartCard (#46, #54, #56, #77), settings / variables / docs / agents / mock / storage, code generation and CodeBlock, ApiPreview / AsyncPreview; CLI `--out/--format/--include-secrets` on the commands in §3g + the parity test; MCP `save_to` + truncation hint + `list_output_formats`; `export-output` capability states in the kind registry (with REG, 0.52); the allow-list emptied; per-protocol docs | 9 |
| **Total** | | about 18 agent-days (3–4 weeks of wall time with 2 lanes) |

**Risks:**

- **Uniformity drift.** Some surfaces might keep their own buttons. Mitigation: the completeness test's "no private save paths" check, and an allow-list that must be empty in B.
- **Memory with huge outputs.** Mitigation: source formats only above 1 MB, the dev assertion, and the perf gate.
- **Leaking secrets in reports** that users share. Mitigation: redacted by default, the confirm, and tests that check for the fixture token.
- **Over-redaction annoys users**, for example a body field called `token` that is test data. Mitigation: the raw body stays raw, and the masked list is shown with an "Include secrets…" path.
- **Ctrl+Shift+S expectations.** Users may expect "Save request as…". Mitigation: it is rebindable, and the palette has both.
- **`overflow-clip` side effects** in panes that relied on programmatic horizontal scroll. Mitigation: grep for `scrollLeft` (none found in panes), plus e2e.
- **The browser and cloud 100 MB cap.** Mitigation: a clear message that points to the CLI. In cloud, a signed-URL download later.
- **File-size ceilings** (`backend.ts` at 1450, `ui.tsx` near 1200). Mitigation: new modules only.
- **Chart PNG fidelity.** Charts are SVG today (`charts.tsx`). Serialise the SVG with inlined computed theme colours, then rasterise through an `OffscreenCanvas` at 2× scale. Test in both themes.

---

## 5. Owner decisions

1. **Default redaction for log-like outputs:** redacted by default with a confirmed "Include secrets…" (proposed), or raw by default with a notice?
2. **The raw response body:** raw with a notice (proposed), or redacted like everything else?
3. **The shortcut:** Ctrl+Shift+S for "Download output" (proposed; free today), or keep it for a future "Save request as…" and use Ctrl+Alt+S?
4. **Copy as CSV for every table** (headers, cookies, grids, matrices, usage): yes (proposed: the ▾ menu "Copy as…" gives it for free), or only Download?
5. **CSV injection guard:** prefix `'` on risky cells but keep plain numbers such as `-12.5` (proposed), or prefix every cell that starts with `-`, which is strict OWASP but breaks numbers in Excel?
6. **PII masking** in redacted exports: off by default (proposed), or on?
7. **Default scope** for filtered views: everything (proposed), or what is shown?
8. **Where it ships:** release A inside 0.50 "Nothing lost, nothing leaked", or as its own 0.49.x/0.50.x lane before the registry work. The toolbar patch ships first either way.
