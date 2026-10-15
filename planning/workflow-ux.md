# Workflow and UI coherence: plan

Owner (2026-10-09): "re-think all the UI combination and interaction to each other's UI, do research and improve the workflow of the application." Scope: **the whole app**, meaning every view and how it reaches and is reached from the others. Flows get no more weight than any other area.

This plan **connects features that already exist**. It adds as few new surfaces as possible. Every item follows the ground rules in [README.md](README.md):
- **Uniform UI:** one shared component per pattern.
- **AI-first:** CLI `--json`, an MCP tool and `llms.txt` for every capability.
- **Cloud-ready:** the UI talks only through RPC.
- **E2E:** every item has an e2e plan in `apps/desktop/e2e/plans`.

Ids are `WF-…`. Sizes: S ≤ 1 day, M 2–4 days, L 1–2 weeks. **QW** marks a quick win (S, low risk, no new concept).

---

## 1. The app as it is (2026-10-09, `main` at 18ba48e plus work in progress)

### 1.1 Frame

The frame is `App.tsx` plus `components/Shell.tsx`.

| Area | What it is | Evidence |
|---|---|---|
| Top bar | Menu, logo, **Workspace menu**, **Back / Forward / Recent places**, **Search** box (Ctrl+Shift+F), **Environment picker**, **Env quick look** (eye), **Commands** (Ctrl+K), AI assistant, Settings | `Shell.tsx` `TopBar` ~236-300 |
| Rail | Home · **Collections** (a toggle: it returns to the last request editor and shows the Explorer) · Debugger, Tests, Monitors, Load · AI Lab, Evaluations · Environments, History, Traces, Git · Settings. The request editors (REST, GraphQL, gRPC, WebSocket, MCP) are *not* on the rail. | `Shell.tsx:58-77` (`NAV`), `:86` (`RAIL`) |
| Explorer | The Collections tree plus MCP servers, API definitions and datasets. Shown **only in request views**. | `App.tsx:449`, `Explorer.tsx:1-6` |
| Tab strip | `EditorTabStrip`, shown **only in request views**. Tests and Monitors use `DocTabStrip`. Every other view has no tabs. | `App.tsx:455`, `TestsView.tsx:577`, `MonitorsView.tsx` |
| Per-view sidebar | `SidebarShell` (segmented panes "Saved · Environments · History/Runs") in Tests, Monitors, Load, Evaluations and AI Playground. The request views still build one, but it is inside `Split collapsed`, which is never rendered (dead code). | `SidebarShell.tsx`, `RestView.tsx:601`, `GraphQLView.tsx:417`, `GrpcView.tsx:271`, `ui.tsx:622` |
| Bottom panel | Console · Logs · Terminal. The status bar has buttons for Console and Logs only, not Terminal. | `Shell.tsx` `LogsPanel`, `StatusBar` |
| Right side | The AI assistant (a fixed `w-80` column). Debugger Summary, Snippets and Examples use `PinnablePanel`. | `App.tsx` assistant boundary, `PinnablePanel.tsx`, `ExamplesPanel.tsx:54`, `ScriptsPanel.tsx:138` |
| Status bar | Environment (a dot and name, **not clickable**), MCP count, Git segment (opens Git), Debugger segment (opens Debugger), activity, secret backend, metadata backend, Console, Logs, Feedback | `Shell.tsx` `StatusBar` |
| Finders | **Two**: `SearchDialog` (Ctrl+Shift+F) finds *items*; `CommandPalette` (Ctrl+K) finds *commands*, "Go to …" and "Switch Environment". **Ctrl+P is unbound.** | `Shell.tsx` `SearchDialog` / `CommandPalette`, `App.tsx:304-309, 346-415` |
| Navigation history | Back and forward (Alt+←/→, mouse buttons) and a Recent places menu. Labels name only the view and kind ("REST · request"), never the item. | `store.ts:150-207`, `Shell.tsx` `placeLabel` / `NavButtons` |
| Cross-view routing | `openIntent(view, payload)` plus each view's intent handler | `store.ts` `Intent`, `openIntent` |

### 1.2 Shared state

- **Global:** `workspace`, `environment` (one active environment, stored per workspace id), `settings`, `nav`, `explorerOpen`, `bottomTab`, `assistant`, and the single dialogs (ci, record, apiCoverage, variableUsages, openapiDiff, feedback). Source: `store.ts` `AppState`.
- **Not shared:**
  - Selection: what is "current" is not known outside each view.
  - Which run, request or file is in focus.
  - A cross-view problem list.
  - Recently opened *items*. The nav stack holds payloads but not names.
- **How runs choose an environment:**
  - Tests, Load, Evaluations and flows use the active one. Source: `TestsView.tsx:337`, `LoadView.tsx:179`, `EvaluationsView.tsx:140`.
  - The Collection runner has its own `<Select>`, which defaults to the active one. Source: `CollectionRunner.tsx:57-59, 232`.
  - Monitors store one per monitor.

### 1.3 Cross-link matrix: who can open whom today

Built from `grep openIntent` over `apps/desktop/src`. ✔ = linked, ◐ = partly, ✘ = missing.

| From → To | Request editor | Test file / run | Monitor | Env | History | Trace | Debugger | Git |
|---|---|---|---|---|---|---|---|---|
| Collections tree | ✔ open | ✘ (no "Save as test", no "Runs that include this") | ✔ "Monitor on a schedule…" | – | ✘ | ✘ | ✘ | ✔ "History in git…" |
| Request editor | – | ◐ "Save as test file…" **only in the tab's right-click menu** (`EditorTabs.tsx:344`) | ✘ | ✔ var popover | ✘ (the history pane went with the old sidebar) | ✘ | ✘ | ✘ |
| Tests run result | ✘ **the file path is plain text** (`RunPanel.tsx:404`) | ✔ other runs (`TestHistory.tsx:47`) | ✘ | ✔ "add variable" fix (`Results.tsx:47`) | ✘ | ✔ inline Trace tab | ✘ | ✘ |
| Collection runner result | ✘ | ✔ rerun failed | ✘ | – | ✘ | ✔ inline | ✘ | ✘ |
| Monitor | ✘ request rows are not clickable (`MonitorRequests.tsx`, no handlers) | ✔ "Open run" (`MonitorsView.tsx:490`) | – | ✘ | ✘ | ✘ | ✘ | ✘ |
| Monitor alert toast | – | ✘ **no action** (`lib/monitor-alerts.ts:64`) | ✘ | – | – | – | – | – |
| History | ◐ HTTP and gRPC only; **GraphQL, MCP and LLM open an empty editor** (`HistoryView.tsx:158-160`) | ✘ | – | – | – | ✔ (`:271`) | – | – |
| Traces | ✘ (`TraceView.tsx` has no links) | ✘ | ✘ | – | ✘ | – | – | – |
| Console (bottom) | ✘ | ✘ (a "run" badge only, `ConsolePanel.tsx:118`) | – | – | ✘ | ✘ | – | – |
| Debugger | ✔ "Edit & Submit" / "Open" (`DebuggerView.tsx:185`) | ✔ Create flow → Tests | – | – | – | – | – | – |
| Debugger → collection | ✘ no "Save to collection" for selected rows, although `planning/http-debugger.md` promised it. "Record traffic" is a *separate* reverse-proxy dialog (`RecordDialog.tsx`). | | | | | | | |
| Git view | ◐ **HTTP and GraphQL only** (`GitView.tsx:95`); gRPC, WebSocket, tests, environments and monitors are not openable | ✘ | ✘ | ◐ secrets panel only (`GitView.tsx:577-588`) | – | – | – | – |
| Search hit | ◐ gRPC, WebSocket and SOAP collection items are indexed as `graphql` and open in GraphQL (`packages/core/src/storage/search.ts:54`, `Shell.tsx` `SearchDialog.open`) | ✔ | ✔ | ◐ variables only, not environments | ✔ | ✔ | ✘ | ✘ |
| Home "Needs attention" | ✔ | ✔ | ✔ | – | – | – | – | – |

### 1.4 Pattern inventory: the same job done differently

| Pattern | Variants found | Evidence |
|---|---|---|
| Tab strip | `EditorTabStrip` (requests), `DocTabStrip` (Tests, Monitors), none elsewhere (Load, Evaluations, AI, Debugger, Environments, History, Traces, Git) | §1.1 |
| View header | A big title, subtitle and actions in Debugger and Monitors. A breadcrumb in REST, GraphQL, gRPC and WebSocket (`RequestBreadcrumb`), but not MCP, Tests, Load or Evaluations. Tests uses "Editor / Runs" tabs instead. | screenshots `docs/public/images/debugger.jpg`, `monitors.jpg`, `tests.jpg`, `rest.jpg` |
| "Open this elsewhere" | "Open in tab" (Explorer, Monitors), "Open" (History, Debugger toolbar), "Edit & Submit" (Debugger row), "Open in editor" (flow designer), "Open run" (Monitors), "Open the request" (Mock panel) | `Explorer.tsx:406`, `DebuggerGrid.tsx:289`, `FlowDesigner.tsx:574`, `MockPanel.tsx:123` |
| Routing an item to its view | Re-implemented 6 times, each covering a different subset: `SearchDialog.open`, `AttentionCard`, `GitView.openItem`, `GitView.openFinding`, `HistoryView` open, `run-notifications` | `Shell.tsx` `SearchDialog`, `AttentionCard.tsx:20-27`, `GitView.tsx:92-97, 577-588`, `HistoryView.tsx:156-162` |
| Save as test | Tab right-click only (REST, GraphQL, gRPC, WebSocket). A toolbar button in the AI Playground (`Playground.tsx:184`). | |
| Production guard | REST only (`RestView.tsx:60-80`). Load has its own toggle (`LoadView.tsx:390`). GraphQL mutations, gRPC, WebSocket and MQTT publish, MCP tool calls, test runs, the collection runner, flows and monitors don't ask. | `grep isProduction` |
| Environment surfaces | Top-bar picker, quick look, status-bar label (inert), `EnvironmentsPane` in 10 sidebars, Home card, Environments view, Collection runner select | `grep EnvironmentsPane` |
| Empty state API | `Empty actions=[…]` vs `Empty action={<Button>}` (`CookiesModal.tsx:139`). Many dead-end empty states have **no next action**: Load "No saved load tests", Evaluations "No saved evaluations", gRPC "No saved requests", WebSocket "No saved connections", Playground "No saved prompts", Home "Nothing sent yet", Monitors "Select a monitor", Evaluations "No runs yet". | `grep "<Empty"` |
| Right-click menus | A rich uniform `NodeMenu` in Collections (`CollectionTree.tsx:1110-1130`). Lists without right-click: History, Traces, the Runs list, Git changes, Load and Evaluations saved lists (⋯ only). | `grep onContextMenu` |
| Side panels | `PinnablePanel` (Snippets, Examples, Debugger dock), a fixed column (Assistant), `SidebarShell` (per view), Explorer | |
| Palette commands | Duplicates: "New Request" and "New HTTP Request"; "New MCP Test" and "Add MCP Server"; "Open Collection" just changes view. There is no command for Save as test, Open related, Rerun last run or Reveal in sidebar. | `App.tsx:350-406` |
| Shortcuts help | "Ctrl+Alt+1…9: Go to a view (REST, GraphQL, WebSocket …)", but the numbers follow `NAV` while the rail hides the request editors. The 2nd rail icon (Collections) has no number, Debugger is Ctrl+Alt+7, and Load, AI and the Workspace views have none. Ctrl+\` (terminal) is not listed. | `ShortcutsDialog.tsx:20`, `Shell.tsx` `Sidebar` (`NAV.indexOf`) |

---

## 2. Research summary (what good apps do)

Collected 2026-10-09.

- **One finder, two modes.**
  - VS Code: Ctrl+P quick open for items, Ctrl+Shift+P (or `>`) for commands, with `@`, `:` and `#` prefixes.
  - Postman: Ctrl+K search with type filters; `>` in the search bar runs commands; Ctrl+Shift+A searches open *and recently closed* tabs.
  - Hoppscotch's Spotlight and Yaak's palette merge items and commands. Yaak: "every action starts as a command".
  - Insomnia: Ctrl+P quick switch across requests and environments; Ctrl+Shift+E switches environment.
  - Sources: https://code.visualstudio.com/docs/reference/default-keybindings · https://learning.postman.com/docs/getting-started/basics/navigating-postman.md · https://docs.hoppscotch.io/documentation/features/spotlight.md · https://yaak.app/changelog/2024.6.0 · https://developer.konghq.com/insomnia/keyboard-shortcuts/
- **Results link back to the source.**
  - The Postman Runner opens a result's request in a tab and keeps a separate **Errors** tab (network, request, script) apart from failed tests. Its rerun options are "Run Again", "New Run" and "Automate Run" (schedule, CLI or CI).
  - The Postman Monitor console log opens the request.
  - VS Code Test Explorer: a double-click opens the test and shows the failure inline; it has "Rerun failed", and a Problems panel with F8 for the next problem.
  - The JetBrains Services tool window links test results to their source.
  - Sources: https://learning.postman.com/docs/running-collections · https://learning.postman.com/docs/monitoring-your-api/viewing-monitor-results/ · https://code.visualstudio.com/docs/debugtest/testing · https://www.jetbrains.com/help/idea/http-client-in-product-code-editor.html
- **Reveal in sidebar.**
  - Bruno issue #5159: the tree doesn't expand to the open request, so nested requests get lost.
  - Postman tabs have "Reveal in Sidebar", plus preview (italic) vs pinned tabs.
  - Source: https://github.com/usebruno/bruno/issues/5159
- **Context-aware right panel.**
  - Postman: Variables in scope with their source, Info, Code, Comments, AI.
  - Insomnia: Alt+Shift+U shows a variable's source and value.
- **Environment safety is an unmet need.**
  - Postman and Yaak environment colours are cosmetic.
  - The research found no client with a confirm-before-send guard for production. TestPion has one, but only for REST.
  - People ask for a production warning, and for "add a variable to one environment → offer to add it to the others". Sources: the Yaak feature board and the HN Yaak launch thread (https://hn.svelte.dev/item/43185836).
- **Capture into requests.**
  - Postman Interceptor sessions land in History.
  - Multi-select, then "Save to collection", with folders by domain or endpoint.
  - Source: https://learning.postman.com/docs/use/capturing-request-data/interceptor/
- **Home:** "Pick up where you left off" and "Needs your attention" (Postman).
- **Status bar as a tool hub:** Console, Terminal, Runner, Cookies, Find/Replace and the branch are all in the footer (Postman, VS Code).
- **CI parity:** every client has a CLI that runs the same files (bru, inso, kreyac, tc, hopp). Postman's "Automate Run" goes from a run straight to CLI or CI.
- **Complaints to avoid:**
  - bloat and too many surfaces
  - lost tabs
  - can't find a request
  - sending to production by mistake
  - runner results that don't link back
  - AI "fix test" that weakens assertions (Ministry of Testing, DZone)

---

## 3. Core loops: clicks today vs proposed

### (a) Explore → save → test → CI

| Step | Today | Proposed |
|---|---|---|
| Send a request | Rail Collections, then "+", then HTTP, URL, Send (4) | Same, or Ctrl+P `>new http` (WF-01) |
| Save | Ctrl+S, then pick a collection (2) | Same |
| Make it a test | **Right-click the tab**, then "Save as test file…" (hidden; 2 once found) | A visible **Save as test** in the request toolbar ⋯ and in the tree's NodeMenu, the same in every protocol (WF-07) (1-2) |
| Run it | Rail Tests, find the file, Run (3) | The toast after saving: "Run now · Open test" (WF-07) (1) |
| Put it in CI | Tests ⋯, "Run in CI…", then re-select what to run (3+) | From the run header: **Run this in CI…**, preselected with this run's selection, plus **Copy CLI command** (WF-09) (1) |

### (b) Debug a failing test or monitor → fix → rerun

| Step | Today | Proposed |
|---|---|---|
| Notice | A monitor toast with no action; the Home card if you happen to go there | A **Problems** badge in the status bar and a toast with "Open run" (WF-03, WF-04) |
| Find the failing step | Monitor, Open run, Tests Runs tab, result (3-4) | Problems, then the item (1) |
| See request and response | The result's Input/output tab (1) | Same |
| Go to the source | **Not possible**: the file path is text; you hunt in the Tests tree or the collection (4+) | **Open source** on every result: the test file at that step, the request in its collection, or the flow block (WF-08) (1) |
| Fix and rerun just that | Edit, then rerun the whole file, or "Rerun failed" for the whole run | **Run again** on the result; "Rerun last run" (Ctrl+Shift+R) (WF-08) (1) |

### (c) Capture traffic → requests or flows

| Step | Today | Proposed |
|---|---|---|
| Capture | Debugger: Start capturing (1). Or the separate Record dialog (palette only). | The Debugger is the one capture surface; Record becomes its "Reverse proxy" capture mode (WF-12) |
| Turn into requests | One row at a time ("Edit & Submit" opens an unsaved tab), or export HAR then import (5+) | Multi-select, then **Save to collection…** (folders by host or path), next to "Create flow" (WF-12) (2) |

### (d) Environments and secrets everywhere

| Step | Today | Proposed |
|---|---|---|
| See what is active | Top-bar picker; the status bar shows it but is inert | The status-bar segment opens the same picker; an `EnvBadge` on every run surface (WF-05) |
| Switch | Top-bar picker, or Ctrl+K "Switch Environment" (2) | Same, plus Ctrl+Shift+E (WF-05) |
| Avoid production accidents | REST only | **One guard for every send and run path**: GraphQL mutations, gRPC, WebSocket and MQTT, MCP tool calls, test, flow and collection runs, monitors (WF-06) |
| Find a variable's source | Hover popover; Variable usages dialog | The same popover in every editor, plus "Also add to the other environments" (WF-14) |

### (e) Collaborate through git

| Step | Today | Proposed |
|---|---|---|
| See changes | The Git view, by meaning (good) | Same |
| Open a changed item | HTTP and GraphQL only | Every kind, through `openRef` (WF-02) |
| After a pull | REST tabs ask "Keep mine / Take the new version" (`RestView.tsx:196`) | Every editor asks the same (WF-15) |

### Every other view: where it plugs in

| View | Today's gaps | Items |
|---|---|---|
| Home | Its "Recent requests" are HTTP history only; Needs attention shows only on Home; empty cards without actions | WF-03, WF-10, WF-18, WF-22 |
| Collections, Explorer | No "Save as test" or "Runs that include this"; no reveal-on-tab-switch | WF-07, WF-11 |
| REST, GraphQL, gRPC, WebSocket, MCP | Save as test hidden; production guard REST-only; breadcrumb missing in MCP; dead sidebars | WF-06, WF-07, WF-11, WF-21 |
| API definitions, datasets | No breadcrumb; not in search as their own kinds | WF-02, WF-11 |
| Environments, secrets | Status bar inert; no Ctrl+Shift+E; no add-to-all | WF-05, WF-14 |
| Tests, flows, runner | Result → source missing; no per-result rerun; no Run → CI | WF-08, WF-09 |
| Monitors | Toast without action; request rows inert | WF-04, WF-08 |
| Load | No tabs; empty state with no action; its own production toggle | WF-06, WF-18, WF-19 |
| AI Lab, Evaluations | No tabs; empty states; case result → source | WF-08, WF-18, WF-19 |
| History | GraphQL, MCP and LLM open empty; no right-click | WF-13, WF-16 |
| Traces | No links out | WF-16 |
| Debugger, mocks | No save-to-collection; two capture concepts; "Edit & Submit" naming | WF-12, WF-13 |
| Git | Opens HTTP and GraphQL only | WF-02 |
| Settings | Reached three ways (rail, top bar, Ctrl+,): fine; Agents setup only from the palette | WF-01 |
| Bottom panel | No Terminal button; no Problems; Console entries inert | WF-03, WF-16, WF-17 |
| Side panels | Assistant is not pinnable; no context panel | WF-20 |

---

## 4. Improvements

### P0: the connective tissue (do these first; most later items use them)

#### WF-02 `openRef`: one resolver for "open this thing" · M · foundation
- **Problem:** six hand-written routing tables, each covering a different subset (§1.4). That is why:
  - gRPC and WebSocket search hits open in GraphQL;
  - Git can't open most kinds;
  - History opens empty editors for GraphQL, MCP and LLM;
  - run results can't open their source.
- **Change:**
  - Add `apps/desktop/src/lib/open-ref.ts` with:
    - `type ItemRef = { kind: 'request' | 'test' | 'flow-step' | 'run' | 'result' | 'monitor' | 'environment' | 'variable' | 'history' | 'trace' | 'exchange' | 'saved' | 'spec' | 'dataset' | 'mcp-server' | 'provider' | 'git-file'; …ids }`
    - `openRef(ref, { reveal?, newTab? })`
    - `refLabel(ref)`
  - Route every collection node kind (REST, SOAP, GraphQL, gRPC, WebSocket) to its own editor.
  - Replace the six tables with `openRef` plus small `refOf…` adapters for: search hits, attention items, git semantic changes, secret findings, history entries, run results, trace spans and Console entries.
- **Also fix** `packages/core/src/storage/search.ts:54`:
  - index gRPC, WebSocket and SOAP nodes under their real kind;
  - index environments, API definitions and datasets as hits of their own.
- **Shared component:** `<RefLink to={ref}/>`. It is the one inline link that names and opens an item, with the item's icon and name, and a right-click menu: Open · Open in new tab · Reveal in sidebar · Copy link. Use it everywhere an item is mentioned in text: run results, Console, traces, the Git list, toasts, Problems.
- **AI-first:**
  - Use the same `ItemRef` shape in MCP tool results and CLI `--json`. Add a `ref` field to `run_tests`, `recent_failures`, `what_needs_attention`, `git_status` and `debugger_exchanges`.
  - Add a `testpion://open?ref=…` deep link and `testpion open <ref>`, so an agent or the CLI can bring the app to an item.
- **Verify:** `e2e/plans/open-ref.cjs`.
  - Search a gRPC item and land in gRPC.
  - Open a WebSocket item from Git changes.
  - A History GraphQL entry opens with its query.
  - Every `RefLink` in a run result opens its source.
- *Built (2026-10-09):*
  - **`ItemRef`** in `packages/shared/src/item-ref.ts` (host-agnostic, ids only): 22 kinds (`request` with `protocol?`, `collection`, `folder`, `saved` (library + itemId: gRPC calls, connections, prompts, load tests, evaluations), `monitor`, `environment`, `variable`, `test`, `flow`, `test-case`, `run`, `history`, `trace`, `exchange`, `mcp-server`, `provider`, `spec`, `dataset`, `mock`, `certificate`, `git-file`, `doc`), with `toItemRef` (validation), `itemRefUrl` / `parseItemRefUrl` (`testpion://open?kind=…&…`), `parseItemRef` (also `kind:id`), `itemRefKey`, `RefResolution`.
  - **`resolveItemRef`** (core `storage/item-refs.ts`): exists? name, protocol filled in; when gone, why plus `next` (the collection of a deleted request, the Tests view …). Indexed: per-file id maps rebuilt only when the file's mtime/size changed, metadata DB by id, a stat for files. 9,000 requests: ~0.05 ms per lookup after the first (unit test), `ref.resolve` RPC in `_perf-explorer-9000` step `open-ref-9000`.
  - **Window:** `lib/ref-target.ts` (the one kind → view table, pure, unit-tested for every kind; `historyEditorTarget` for History ▸ Open), `lib/open-ref.ts` (`openRef(ref, { newTab, noReveal, reveal, edit })`, `resolveRef`, `refLabel`, `reportUnopenable` / `reportIfGone` (a toast with the nearest thing as its action), `copyRefLink`, `watchOpenLinks`; requests resolve from an O(1) index over the explorer outline, everything else with one `ref.resolve` call), `components/RefLink.tsx` (`<RefLink to={ref}/>`, `refIcon`, `refMenu`: Open · Open in new tab · Reveal in sidebar · Copy link).
  - **Fixed:** search indexes requests under their protocol (SOAP marked, unknown node kinds no longer listed as GraphQL) plus environments, API definitions and datasets; Git lists library files item by item and every change opens through its `ref`; History ▸ Open reopens GraphQL (query + variables), MCP (server, tool, arguments), LLM (Playground prompt), HTTP, gRPC, WebSocket entries; REST and GraphQL hand a request of the other protocol to `openRef` and report a gone one; secret findings, Variable usages and Security review open GraphQL requests in GraphQL.
  - **Migrated:** AttentionCard, GitView (changes, findings, `file` intent), HistoryView, Explorer, CollectionsView, SidebarPanes, EnvQuickLook, VarInput, VariableUsagesDialog, SecurityReviewDialog, CollectionOverview, CollectionVariablesPane, RequestBreadcrumb, Results (AddKeyButton), TestHistory, MonitorsView, ApiCoverageDialog, CreateFlowDialog, menu-commands, run-notifications, monitor-alerts (toast: Open run / Open monitor). What stays `openIntent` is actions (new, run, import, export, tab commands, settings tabs, unsaved drafts from a spec or exchange).
  - **Not yet migrated (files other work had open):** `Shell.tsx` `SearchDialog.open` (and its `icons` for the new `environment`, `spec`, `dataset` hits; until then those hits do nothing on click) and the environment picker's "Manage environments…"; `TestsView.tsx:876`; `FlowDesigner.tsx:714, 743`; `TerminalPanel.tsx:103`; `RunPanel.tsx:404` (file path as text → `RefLink`).
  - **AI-first:** `ref` in `run_tests`, `recent_failures`, `what_needs_attention`, `git_status`, `git_diff` / `git changes`, `debugger_exchanges`, search hits, `testpion history list --json`; MCP tool `resolve_ref`; `testpion open <ref>` (`--json`, `--print`, `--no-check`; exit 2 when gone); `agent-info` lists it.
  - **Deep link:** the installer registers `testpion://` (`electron-builder.yml` `protocols`), the packaged app `setAsDefaultProtocolClient` (from source with `TESTPION_REGISTER_LINKS=1`); a link that starts the app is queued (`backend/open-links.ts`, `app.takeOpenLinks`), later ones arrive through `second-instance` / `open-url` as the `app.openLink` event.
  - **Docs:** `getting-started/finding-your-way.md` (new), `whats-new.md`, `getting-started/git.md`, `cli/reference.md` (`open`), `ai-testing/mcp-server.md` (`ref`, `resolve_ref`). `llms.txt` still needs `resolve_ref` and `testpion open`.

#### WF-01 Quick Open (Ctrl+P), one palette for items and commands · M
- **Problem:**
  - Two finders, so an item and a command can't be found together.
  - Ctrl+P is free.
  - The palette has duplicates (§1.4).
  - Recent items aren't offered.
- **Change:**
  - One `CommandPalette` with **modes by prefix**, VS Code / Postman style:
    - none: items, with recent items first
    - `>`: commands
    - `@`: inside the current item (request tabs, test steps, flow blocks)
    - `#`: environments and variables
    - `?`: help
  - Ctrl+P opens it empty. Ctrl+K opens it in `>` mode (today's behaviour). Ctrl+Shift+F opens it in full-text search mode (`ws.search`), so `SearchDialog` becomes a mode, not a second dialog.
  - Every item opens through `openRef`.
  - Remove the duplicate commands and name them "Verb Object" consistently (WF-13).
- **Shared component:** the existing `CommandPalette` in `Shell.tsx`, so there is one list look.
- **AI-first:** an MCP tool `search_workspace` and `testpion search <q> --json` over the existing `ws.search` (`backend/handlers/workspace.ts:194`), returning `ItemRef`s.
- **Verify:** `e2e/plans/quick-open.cjs`.
  - Ctrl+P, type a request name, Enter.
  - `>run` runs a command.
  - `#prod` switches the environment.
  - An empty query lists the last 5 opened items.
- *Built (2026-10-09):*
  - **Modes:** `lib/quick-open.ts` (pure: `parseQuickQuery(q, base)`, `quickOpenRows`): items (nothing typed: recent; text: `ws.search` hits, debounced, an older answer never replacing a newer one), `>` commands, `@` the focused editor's commands (`focusedScriptEditor` / `focusedPaletteCommands`), `#` environments (switch) and variables (open), `?` help (reopens in a mode). The mode it opens in is what plain text searches, so Ctrl+K still finds commands by typing.
  - **One palette:** `components/QuickOpen.tsx` drives the existing `CommandPalette` through three additive props (`initialQuery`, `resolve`, `onQueryChange`; Shell.tsx otherwise untouched). Ctrl+P (items), Ctrl+K and the top bar's Commands (commands), Ctrl+Shift+E (environments); `store.paletteQuery` holds the mode.
  - **Recent items:** `lib/recent-items.ts` (per workspace through `scopedKey`, newest 30, names and ids only): `openRef` records every open and forgets a ref that turned out gone. WF-10 reuses it.
  - **AI-first:** MCP `search_workspace` (ref-tools.ts, one index per server) and `testpion search <words> [--json] [-n]`.
  - **Not done here:** Ctrl+Shift+F still opens `SearchDialog` (Shell.tsx, being migrated by the terminal agent); folding it into Quick Open is a Shell change. Duplicate commands were removed in WF-13.
  - **Tests:** `tests/unit/quick-open.test.ts` (modes, rows, `testpion search --json`); pinned MCP tool list updated; e2e `wf-quick-open.cjs` (recent first, find by name → gRPC, `>` / `#`, Ctrl+K typing).
  - **Docs:** `finding-your-way.md`, `cli/reference.md` (`search`), `mcp-server.md`, `whats-new.md`.

#### WF-03 Problems: one place for what is failing · M
- **Problem:**
  - Failures are scattered across Tests runs, monitor results, Collection runner runs, flow runs, Evaluations, environment files that can't be read, Git conflicts, secrets in a commit and API lint.
  - Home "Needs attention" (`AttentionCard.tsx`) and the `what_needs_attention` MCP tool already compute most of this, but only Home shows it.
- **Change:**
  - A **Problems** tab in the bottom panel next to Console, Logs and Terminal: a list grouped by source. Each row is a `RefLink` with a severity icon, an age, and the actions Open source · Run again · Ask AI.
  - A status-bar badge "⚠ 3" toggles it.
  - F8 / Shift+F8 go to the next and previous problem.
  - Home "Needs attention" becomes the same list, limited to the top 5.
  - Separate **failure** (an assertion) from **error** (network, TLS, script, timeout) in run summaries and here, as the Postman Runner does.
- **Shared component:** `ProblemList` (new: a `VirtualList` of `RefLink` rows), used by the bottom panel and Home.
- **AI-first:**
  - The backend is `what_needs_attention`; add `testpion problems --json`.
  - "Ask AI" passes the ref and the failure.
  - An AI change that edits or removes a check is shown as a before/after diff for human review, never applied silently (the known Postbot "fix test" failure mode).
- **Verify:** `e2e/plans/problems.cjs`.
  - A failing test file and a failing monitor both appear.
  - F8 moves through them.
  - Open source lands on the step.
- *Built (2026-10-13):*
  - **Core:** `storage/attention.ts` items carry `group`, `type` (`failure` / `error` / `warning`) and `at`; environment and collection files that can't be read come first (kind `file`); the latest run says "2 failed, 1 error (network, TLS, timeout or script)". The list is bounded at the source (a few per kind), so `ProblemList` is a plain list, not a `VirtualList`.
  - **UI:** `lib/problems.ts` (`useProblems`, keyed by the open workspace and read again on `run.finished`, `monitor.result`, `data.changed`; `stepProblem` for F8 / Shift+F8; `askAboutProblem`), `ProblemList` (rows are `RefLink`s with severity icon, age and Open · Run again · Ask AI, the same in ⋯ and right-click), `ProblemsPanel` (the bottom panel's Problems tab), `StatusBarTools` (the count badge, Terminal, a Tools menu). Home's Needs attention is `ProblemList` limited to 5. `useRpc` gained `scope` (a workspace switch reads again).
  - **AI-first:** `testpion problems` (alias of `attention`, `--json` with the type); Ask AI passes the problem's message, kind, type and ref (never values) to the assistant's triage. An AI edit to a check still goes through the assistant's reviewed diff (no silent apply); nothing new was needed for it.
  - **Not done:** Git conflicts, secrets in a commit and API lint are not in the list yet (they have their own views); the Tests view's run summary split is the canvas agent's (`TestsView.tsx`).
  - **Tests:** `tests/unit/problems.test.ts`; e2e `wf-problems.cjs` (badge → grouped panel with the broken environment file first, F8 opens it, Home is the same list).
  - **Docs:** `finding-your-way.md` (Problems), `cli/reference.md` (`problems`), `whats-new.md`.

#### WF-04 Every notification has a next action · S · **QW**
- **Problem:** the monitor-failed toast (`lib/monitor-alerts.ts:64`) and the certificate-expiry toast (`:44`) have no action. Run notifications do (`lib/run-notifications.ts:32`).
- **Change:**
  - `toast()` takes an optional `ref`, and its action label comes from `refLabel` ("Open run", "Open monitor").
  - Use it for every toast that refers to an item.
- **Verify:** extend the monitors e2e plan: a failing monitor's toast "Open run" opens the run.
- *Built (2026-10-09):*
  - **The shared toast API:** `toast(text, kind, action)` (store.ts) takes `ToastAction = { label, onClick } | { ref, label?, newTab? }`, one or two (the second as sonner's secondary button). A ref action opens through `openRef` (loaded on first use: no import cycle) and is labelled from its kind by `refOpenLabel` (shared `item-ref.ts`, with `refNoun`: "Open run", "Open monitor", "Open test file", "Open MCP server", "Open gRPC call"). `notifySystem(title, body, { ref, tag })` is the one system notification: clicking it focuses the window and opens the ref.
  - **Toasts given their item:** a monitor that fails (Open run) or recovers / could not run (Open monitor) and its system notification; an expiring certificate (Open certificate(s), Settings ▸ Certificates); a finished run's notification; a duplicated collection; a moved request or folder; a saved test (MCP tool call, Playground, fuzz findings, AsyncAPI tests: `refOfWorkspacePath` in shared turns `tests/…`, `datasets/…`, `specs/…` into refs); rows saved as a dataset; a case added to a dataset; variables moved to environments (the first); a variable added from its popover; History ▸ Open of an entry with nothing to send (Show in History). Toasts that only confirm what is on screen (Saved, Settings saved) keep no action.
  - **Left in excluded files:** `FlowDesigner.tsx` toasts (pinned step, Manual trigger) carry no item ref; `TestsView.tsx` "No runs to export yet" is not about an item.
  - **Tests:** `tests/unit/save-test-everywhere.test.ts` (labels, `refOfWorkspacePath`); e2e `wf-save-as-test.cjs` step `monitor-toast-opens-run` (a failing monitor's toast, Open run → the run in Tests) and the save toasts' Open test file.
  - **Docs:** `getting-started/finding-your-way.md` (toasts), `whats-new.md`.

#### WF-05 The environment everywhere, the same way · S · **QW**
- **Problem:**
  - The status-bar environment is inert.
  - There is no switch shortcut.
  - Run headers don't show the environment the same way everywhere.
  - The Collection runner select looks different from the top-bar picker.
- **Change:**
  - Extract `EnvironmentPicker` (`Shell.tsx`) into a shared `EnvSelect` (variants: top bar, inline). Use it in:
    - the status bar (a click opens the menu)
    - the Collection runner
    - the monitor editor
    - Load
  - Ctrl+Shift+E (Insomnia's binding) opens the palette in `#` mode.
  - Every run header shows an `EnvBadge` (a colour dot; PRODUCTION in red): Tests, Collection runner, Monitors, Load, Evaluations, flow runs.
- **Shared components:** `EnvSelect`, `EnvBadge`.
- **AI-first:** every run's JSON reports `environment` (check `run_tests`, `run_collection`, `run_monitor`, `load_test`, `run_evaluation`).
- **Verify:** `e2e/plans/env-everywhere.cjs`. Switch from the status bar; a run header shows the badge.
- *Built (2026-10-13):*
  - **Shared:** `components/EnvSelect.tsx`: `EnvSelect` (variants `topbar`, `status`, `inline`; the same menu, production marked, unreadable files disabled with why, Manage environments…) and `EnvBadge` (dot, name, PRODUCTION), plus `envColor`.
  - **Used in:** the top bar and the status bar (`Shell.tsx`), the Collection runner's field and its results header (the environment a run was started with while it runs, then the recorded one; the list reloads on `run.finished`), the monitor editor and a monitor's header, Load ("Runs against …"), Evaluations' run rows. Ctrl+Shift+E opens Quick Open in `#` mode (WF-01).
  - **Left in excluded files:** the Tests view's and flow runs' headers (`TestsView.tsx`, `RunPanel.tsx`, `FlowDesigner*.tsx`) belong to the canvas agent: they should render `<EnvBadge name={summary.environment} />`.
  - **AI-first:** `run_tests`, `run_evaluation` (through `recordedRun`), `run_collection`, `run_monitor` and `load_test` return `environment` (`null` when none); `testpion monitor run --json` and `testpion load --json` too; the CLI's test and eval JSON reports already carried it in the summary.
  - **Tests:** `tests/unit/env-everywhere.test.ts`; e2e `wf-env-everywhere.cjs` (switch from the status bar, Ctrl+Shift+E lists environments, the Collection runner's header badge); `environment-picker.cjs` still passes.
  - **Docs:** `finding-your-way.md` (The environment, the same way everywhere), `whats-new.md`.

#### WF-06 One production guard for every send and run path · S–M
- **Problem:**
  - `confirmProductionSend` is REST-only (`RestView.tsx:60-80`).
  - GraphQL mutations, gRPC, WebSocket and MQTT publish, MCP tool calls, test, flow and collection runs, and a monitor's "Run now" all hit production silently.
  - The research found no other client with this guard at all, so making it complete is a differentiator.
- **Change:**
  - Move the guard to `lib/production-guard.ts` and call it from every sender.
  - Runs ask once per run: "Run 14 requests (5 change data) against Production?"
  - Keep "Send and don't ask again" for the session.
  - Add a thin border in the production colour around the window while a production environment is active.
- **Shared component:** the existing `ask()` dialog through one helper.
- **AI-first:**
  - An `allowProduction` flag (as `load_test` has) on `send_request`, `run_tests`, `run_collection` and `mcp_call_tool`, plus `--allow-production` in the CLI.
  - When an agent targets production through the app's MCP server, the person approves it in the existing `McpClientRequests` prompt.
- **Verify:** `e2e/plans/production-guard.cjs`. A GraphQL mutation, a test run and a monitor's Run now each prompt; GET does not.
- *Built (2026-10-09):*
  - **Three layers, one rule.** `packages/shared/src/production.ts` (the vocabulary: `ProductionAsk`, `PRODUCTION_CONFIRMATION`, `isDataChangingMethod`, `productionAskOf`, `productionAskText`); `packages/core/src/net/production-guard.ts` (consent as an AsyncLocalStorage: `allowProductionFor`, `productionAllowed`, the CLI's `setProductionAllowedByDefault`; `productionRefusal`; `isGraphQLMutation`, `isGrpcReadMethod`; `assertProductionStep`).
  - **Engine:** `createEngineContext({ allowProduction })` (default: the consent of the call it is created in) puts a `production` gate in `ExecServices`; `executeTest` refuses every data-changing step (HTTP non-read method after pre-request scripts, GraphQL mutation, gRPC non-read, realtime with messages to send, MCP tool call) of an unconsented production context: the step fails with *needs confirmation*, the run goes on, nothing is sent. Direct senders outside `executeTest` check too: the MCP server's ad-hoc `send_request`, `grpc_call`, `realtime_exchange`; `testpion send <url>`; the backend's `http.send` after pre-request scripts.
  - **Backend boundary:** `apps/desktop/backend/production-guard.ts`, called by `Backend.invoke` for every RPC: a table of the 22 sending/running methods (`http.send`, `http.compareEnvironments`, `gql.send`, `grpc.send`, `wsock.send`, `sio.emit`, `mqtt.publish`, `kafka.produce`, `mcp.call`, `col.run`, `col.rerunFailed`, `tests.run`, `tests.rerunFailed`, `tests.flowRun`, `tests.dataRun`, `tests.matrixRun`, `eval.run`, `eval.runDraft`, `load.start`, `flows.webhooks.start`, `monitor.run`, `monitor.save`) says what each would do; without `allowProduction: true` a data-changing send or any run is refused before the handler runs, with the ask (a collection run counts its requests and the ones that change data). Connections remember the environment they were opened with (and MCP servers their `readOnlyHint` tools). `allowProduction` is a checked common RPC param. Load tests take the guard's consent, never the config's; the Load view's own toggle is gone.
  - **Monitors:** `MonitorData.allowProduction` is derived by the host when saving (asked; kept while the environment stays), never taken from the payload; `executeMonitor` runs with it, so scheduled runs change production only with consent (reads still run).
  - **Window:** `api.ts` `call()` hands a refusal to one recovery (`setCallRecovery`); `lib/production-guard.ts` asks with the shared `ask()` dialog ("Send to Production?" / "Run against Production?", "… and don't ask again" per workspace, environment and kind for the session; concurrent refusals share one question) and calls again with `allowProduction: true`. Every view gets it with no code of its own (REST's `confirmProductionSend` removed). `components/ProductionFrame.tsx`: the thin frame in the environment's colour.
  - **AI-first:** MCP `withProductionConsent` (tool.ts) adds `allowProduction` to every write tool with an `environment` (and `run_monitor`); it counts only on a server started with `--allow-production`. CLI: `--allow-production` on `test`, `run`, `run-collection`, `load`, `send`, `eval run`, `serve flows`, `monitor add/run/start` (`SENDING_COMMANDS`); without it reads still run.
  - **Scripts:** `tp.sendRequest` is guarded too: `scriptRequestSender` requires its context's `production` gate (a required key: no caller can forget it; a unit test scans every caller), and the backend asks before a send whose own, folder or collection scripts call `tp.sendRequest` ("its scripts send requests too").
  - **CLI message:** the refusal names the way out in every host: "… needs confirmation (the app asks; from the CLI add --allow-production; an agent passes allowProduction: true)". `CHANGELOG.md` leads Unreleased with it as a behaviour change for CI pipelines.
  - **Not done:** the person's approval through `McpClientRequests` for the app's own MCP server: that server runs headless in its own process, so consent is the explicit per-call flag.
  - **Tests:** `tests/unit/production-guard.test.ts` (rule, consent propagation, engine refusal, every guarded method refused/allowed via `guardProduction` plus a scan that fails when a new sending RPC is not guarded, invoke, pre-request script, monitor consent and schedule, MCP schema + `send_request`, CLI `send` / `run-collection`); e2e `wf-production-guard.cjs` (frame, POST asks: Cancel sends nothing / Send sends, GET does not ask, GraphQL mutation + don't-ask-again, collection run asks once with its counts).
  - **Docs:** `api-testing/environments.md#production`, `rest.md`, `performance/load-testing.md`, `test-runner/monitors.md`, `cli/reference.md`, `ai-testing/mcp-server.md`, `whats-new.md`. `llms.txt` still needs `allowProduction` / `--allow-production`.

#### WF-07 "Save as test" visible and identical in every editor · S · **QW**
- **Problem:**
  - In request editors "Save as test file…" exists only in the tab's right-click menu (`EditorTabs.tsx:344`).
  - The AI Playground has a button for it.
  - The Collections `NodeMenu` has no test action at all.
- **Change:**
  - Add "Save as test…" to:
    - the request toolbar ⋯ (REST, GraphQL, gRPC, WebSocket, an MCP tool call)
    - the Collections `NodeMenu` (on a folder: "Create test file from folder")
    - the Debugger row menu
    - History entries
  - After saving, a toast offers Run now · Open test.
- **Shared component:** `NodeMenu` (`CollectionTree.tsx:1110`). Add a **test** group to its standard order: create · open · run · *test* · configure · copy · organize · delete.
- **AI-first:** `save_test` exists; add `testpion test from-request <collection>/<request> --json`.
- **Verify:** `e2e/plans/save-as-test.cjs`, run once per protocol.
- *Built (2026-10-09):*
  - **One action:** core `runner/test-from-ref.ts`: `saveTest(store, input)` / `testFileOfInput` where input is an editor's request (`{ source }`, `TestSource` now also `mcp` and `llm`) or an item `{ ref }`: a request (its own scripts and checks, {{variables}} kept), a folder or a whole collection (one file, a `tests:` list, a test per request; a collection adds its gRPC calls and connections, through the run's own `savedGrpcCallToTest` / `savedConnectionToTest`), a saved gRPC call or connection, a History entry (the saved request it came from while it exists, else what was sent: HTTP, GraphQL, gRPC, MCP, LLM). Free file names (`-2` …). Gone items say so.
  - **RPC:** `tests.saveFrom { name?, source? | ref?, assertions? }` answers `{ path, tests, name, ref }`; `mcp.saveTest` delegates to it.
  - **Window:** `lib/save-test.ts`: `saveAsTest(target)` (name prompt, the RPC, a toast with **Run now** (tests.run with the active environment, then the run opens; production asks) and **Open test file**), `saveAsTestItem(target)` / `saveAsTestMenuItem(handler)` (one label and icon: "Save as test…", "Create test file from folder…", "Create test file from collection…"). Used by: the Collections `NodeMenu` (a new **test** group: create · open · run · *test* · configure · copy · organize · delete) on requests, folders and collections; saved gRPC calls and connections in the Explorer; the request editors' breadcrumb line, which gained the item's ⋯ (`RequestBreadcrumb actions`: REST, GraphQL, gRPC, WebSocket); the tab right-click menu ("Save as test file…" → "Save as test…"); History (row right-click and ⋯, the detail header's ⋯: Open · Open request · Open trace · Save as test… · Delete); the HTTP Debugger's row menu (the whole exchange as the request); the MCP tools panel and the AI Playground buttons (they wrote YAML themselves before).
  - **AI-first:** MCP `save_test` takes `ref` (or `collection` + `request`) and returns `tests` and the file `ref`; CLI `testpion test from-request "Collection/Folder/Request" | <ref> [-n name] [--json]` (`commands/test-from.ts`; reads `-w`/`--json` with the parent `test`'s options).
  - **Tests:** `tests/unit/save-test-everywhere.test.ts` (every kind of item, gone items, RPC, MCP, CLI); e2e `wf-save-as-test.cjs` (request and folder menus, the editor ⋯, History's menu, the toast's Open test file); `row-actions.cjs` expectations gained the test group.
  - **Docs:** `test-runner/overview.md`, `cli/reference.md` (`test from-request`), `ai-testing/mcp-server.md` (`save_test`), `whats-new.md`. `llms.txt` still needs `testpion test from-request` and `save_test`'s `ref`.

#### WF-08 Run result ↔ source round trip · M
- **Problem:**
  - Results show the file as plain text (`RunPanel.tsx:404`).
  - You can't open the step, the request or the flow block, and you can't rerun one result.
  - The same holds for:
    - Collection runner results
    - monitor request rows (`MonitorRequests.tsx`)
    - Evaluations cases
- **Change:**
  - The `ResultDetail` header gets `RefLink`s: "tests/rest/patients.yaml › Create a patient", and the collection request when the step came from one.
  - It also gets the actions:
    - **Open source**
    - **Run again** (this result only)
    - **Debug this step** (opens the flow designer at the step with a breakpoint; debugging landed in 18ba48e)
    - **Ask AI**
  - Every run header gets "Run again". The palette gets "Rerun last run" (Ctrl+Shift+R).
  - Monitor request rows and Collection runner request rows link to their request.
- **Shared component:** `RunPanel` / `ResultDetail`. They already serve Tests, the Collection runner and Monitors, so the change lands once.
- **AI-first:** `run_tests` takes `{ file, step }` to rerun one step; results carry `ref` (WF-02).
- **Verify:** `e2e/plans/run-roundtrip.cjs`. Fail a check, Open source (lands on the step), fix it, Run again (passes).
- *Built (2026-10-09, the shared pieces; the result header in `RunPanel.tsx` is the canvas agent's):*
  - **What a run ran:** `RunSummary.origin` (`RunOrigin`: test files with grep/tags, or a collection with selection/iterations), written by `Backend.startRun` for test and collection runs.
  - **Result → source:** core `runner/result-source.ts`: `resultSourceRefs` (the saved request of a collection run — the result id is `<request>@<iteration>` — and the test file at the step), `requestIdOfResult`, `testsPathOf`; `runs.results` answers every result with `refs`; monitor request stats carry `ref` (`MonitorRequests` rows are `RefLink`s); the Collection runner's request rows are `RefLink`s (a saved gRPC call / connection as `saved`).
  - **Run again:** `runAgainPlan(summary, resultIds?)` + RPC `runs.runAgain { runId | "last", resultIds? }` (the run's own environment unless given; production-guarded); `lib/run-again.ts` `runAgain()` (opens the new run); palette **Rerun Last Run** and Ctrl+Shift+R (listed in the shortcuts).
  - **AI-first:** `run_tests` results carry `ref`; `run_tests { paths: [file], step }` runs one test or step.
  - **For the canvas agent (RunPanel / TestsView / FlowDesigner):** the result header shows `<RelatedRefs refs={result.refs} />` (already in `runs.results`) plus **Run again** = `runAgain(runId, [result.id])` and the run header's **Run again** = `runAgain(runId)`; **Debug this step** and **Ask AI** are theirs.
  - **Tests:** `tests/unit/run-again.test.ts`; e2e `wf-run-again.cjs` (Ctrl+Shift+R, the runner's request link).
  - **Docs:** `finding-your-way.md`, `mcp-server.md`, `whats-new.md`.

### P1: consistency and speed

#### WF-09 Run → CI in one click · S · **QW**
- The run header ⋯ gets:
  - "Run this in CI…", which opens `CiDialog` preselected with the run's files, suite, collection, folders and environment;
  - "Copy CLI command" (`testpion run … --env X --reporter junit`). This is Postman's "Automate Run".
- Files: `RunPanel.tsx`, `CiDialog.tsx`, `store.ts` (`CiRequest` gets `environment`).
- Verify: an e2e step checks that the copied command matches the run.
- *Built (2026-10-13):*
  - **Core:** `ciTargetOfRun` (`runner/result-source.ts`, from the run's origin through `runAgainPlan`: test files with their grep / tags, or the collection with the folders and requests it picked; iterations are not carried and a `note` says so) and `finishedRun` (a run by id or `last`). `CiTarget` gained `grep` and `tags` (`-g`, `-t` in the command).
  - **Backend:** `runs.ci` → `{ request, command, note? }` (the dialog's preselection and the local `testpion` command); `runs.runAgain` uses `finishedRun` too.
  - **UI:** `lib/run-ci.ts` (`runInCi`, `copyRunCommand`, `runCiMenuItems` for any run header's ⋯); the Collection runner's results header has the ⋯; palette: Run Last Run in CI…, Copy CLI Command of Last Run. `LABEL.runInCi` / `LABEL.copyCliCommand`. `CiRequest` gained `grep` / `tags`, passed by `CiDialog`.
  - **Left in excluded files:** the Tests view's and flow runs' headers (`RunPanel.tsx`, `TestsView.tsx`) should add `...runCiMenuItems(runId)` to their ⋯.
  - **AI-first:** `ci_config` takes `runId`; `testpion ci <provider> --run <id|last>`.
  - **Tests:** `tests/unit/run-ci.test.ts` (target, command quoting, `runs.ci`, MCP and CLI agree); e2e `wf-run-ci.cjs` (the copied command matches the run; Run in CI shows the same command).
  - **Docs:** `test-runner/ci-cd.md`, `finding-your-way.md`, `cli/reference.md`, `mcp-server.md`, `whats-new.md`.

#### WF-10 Recent items, and a nav history that names things · S · **QW**
- Recent places (`Shell.tsx` `placeLabel`) shows "REST · request". Store `refLabel` with each `NavLocation`, so it shows "GET List patients · Veterinary API".
- Keep a per-workspace **recent items** list (the last 30 `ItemRef`s), used by:
  - Ctrl+P with an empty query
  - Home "Pick up where you left off", replacing "Recent requests" (HTTP history only today)
  - File ▸ Open recent
- Add "Reopen closed tab" (Ctrl+Shift+T) in every tab strip.
- Files: `store.ts` (`record`, `NavLocation`), `Shell.tsx` (`NavButtons`), `HomeView.tsx`, `EditorTabs.tsx`, `DocTabStrip.tsx`.
- Verify: open 3 items; Recent and Home show their names.
- *Built (2026-10-13):*
  - **Names:** `NavLocation.label`. The store names a place when it records it, through a hook that `lib/open-ref.ts` installs (`setPlaceNamer`): `refOfPlace` reads the item from the intent payload and `placeName` gives "GET List patients · Veterinary API" (a request with its method and collection) or "Nightly · Monitor". `openRef` refines it with the resolved name (`labelPlace`). Shell's `placeLabel` shows the label (one line).
  - **Recent items:** `lib/recent-items.ts` (per workspace via `scopedKey`) is now also a store (`useRecentItems`); an item opened any way (explorer click, tab, link) joins it when the window can name it. One item per request whatever the protocol hint (`sameItem` / `itemKey`). Home's "Recent requests" became **Pick up where you left off** (falls back to the requests sent while nothing was opened yet); Quick Open with nothing typed; **File ▸ Open Recent…** (and the palette) opens Quick Open on them.
  - **Reopen closed tab:** `lib/closed-tabs.ts` (per workspace, newest 20, saved items only). Noted where a tab really closes: REST's `closeTabs` (after the unsaved-changes question), `useSingleEditorTab` (GraphQL, gRPC, WebSocket, MCP, API definitions, datasets, through `refOfEditorItem`), the Monitors strip. Ctrl+Shift+T, the palette, **File ▸ Reopen Closed Tab** (the menu shows the key; the window handles it, so the browser version has it too) and every `DocTabStrip` menu (one shared item).
  - **Left in excluded files:** the Tests view's strip (`TestsView.tsx`) should note its closed files with `noteClosedTabs([{ ref: { kind: 'test', path }, label }])`.
  - **Tests:** `tests/unit/recent-places.test.ts`; e2e `wf-recent.cjs` (Recent places names, Home's list, Ctrl+Shift+T); `tabs-uniform.cjs` expects the new menu item.
  - **Docs:** `finding-your-way.md`, `whats-new.md`.

#### WF-11 A breadcrumb and Reveal in sidebar in every item view · M
- **Problem:**
  - `RequestBreadcrumb` appears in 4 of 5 request editors only.
  - Tests, Monitors, Load, Evaluations, MCP, API definitions and datasets each title themselves differently (§1.4).
  - Bruno #5159 shows the cost when the tree doesn't follow the tab.
- **Change:**
  - Generalise `RequestBreadcrumb` into `ItemBreadcrumb(ref)` at the top of every item view. Examples:
    - collection › folder › request
    - tests › folder › file › step
    - Monitors › name
  - Clicking a segment reveals it in the sidebar. The last segment carries the item's `NodeMenu`.
  - The tab right-click menu gets "Reveal in sidebar".
  - Switching tabs expands and scrolls the tree to the item.
  - The large Debugger and Monitors headers keep their actions and take the same breadcrumb line.
- **Shared component:** `ItemBreadcrumb`.
- **Verify:** `e2e/plans/breadcrumbs.cjs`.
- *Built (2026-10-14):*
  - **Shared:** `components/ItemBreadcrumb.tsx` (segments that open an item, only reveal it, or go to a view; the item's own ⋯ at the end); `RequestBreadcrumb` is now that with a request's segments (its folders reveal in the sidebar). `revealInSidebar(ref?)` (`lib/open-ref.ts`): sets `store.reveal { id, nonce }`, opens the explorer (from another view: the request editor used last); the Explorer passes `revealId` to `CollectionTree`, which opens the collection, category and folders on the way and scrolls to the row (a collection, folder, request or saved gRPC call / connection); a target named before the tree mounted is revealed at once.
  - **Used in:** REST, GraphQL, gRPC, WebSocket (through `RequestBreadcrumb`), MCP, API definitions, datasets, Monitors (above the large header, which keeps its actions), Load and Evaluations. Switching request tabs reveals the tab's item; the request tab menu and `RefLink`'s menu have **Reveal in sidebar** (`LABEL.revealInSidebar`).
  - **Left in excluded files:** the Tests view (`TestsView.tsx`: *Tests › folder › file › step*) and flow views should render `ItemBreadcrumb`; the Debugger's header takes it when its sessions get tabs (WF-19).
  - **Tests:** `tests/unit/recent-places.test.ts` (reveal); e2e `wf-breadcrumbs.cjs` (segments, folder segment reveals, tab switch follows, tab menu, monitor breadcrumb); `core`, `row-actions`, `tabs-uniform` still pass.
  - **Docs:** `finding-your-way.md`, `whats-new.md`.

#### WF-12 One capture surface: Debugger → collection and flow · M
- Add multi-select in `DebuggerGrid` and **Save to collection…**:
  - pick a collection, then folders by host or path;
  - secrets become `{{variables}}` through `lib/save-variable.ts`;
  - it sits next to "Create flow".
- The Record dialog (reverse proxy) becomes a capture mode of the Debugger: Capture ▸ "Reverse proxy for one API". The palette command opens that mode, so there is one concept instead of two.
- Each capture session gets a History entry, as Postman Interceptor does.
- AI-first: a `debugger_save_to_collection` MCP tool (a sibling of `flow_from_exchanges`), plus `testpion debug --save-collection`.
- Verify: extend the debugger e2e plan. Capture 3, select 2, save, and they appear in the Explorer.
- *Built (2026-10-14):*
  - **Core:** `runner/collection-from-exchanges.ts` (`collectionFromExchanges`): the same reading as a recorded flow (core `flowFromExchanges`, unchanged: its YAML is read back), as saved requests. A folder per host / first path segment / none; a new collection or added to one (in a folder); origins become collection variables (an existing one keeps its value); secrets become variables listed in `secrets`, never saved; an extracted value is kept by the producing request's test script in a collection variable (`tp.collectionVariables.set(…, tp.response.json()?.…)`).
  - **Backend / AI-first:** `debug.saveToCollection` (shares `exchangesOf` and `environmentOf` with `debug.createFlow`; a data-changing method); MCP `debugger_save_to_collection` (beside `flow_from_exchanges`, from captured ids / since or a HAR file; shares the exchange choice with it); `testpion debug --save-collection [name] | --to <collection> --group`.
  - **UI:** `SaveToCollectionDialog` (collection, folder or name, grouping); **Save to collection…** next to Create flow in the grid's row menu (multi-select: "Save 2 selected to collection…") and the Flow menu. The toast opens the collection; a second one names the secrets to set. The reverse proxy (`RecordDialog`) is a capture mode: **Capture ▸ Reverse proxy for one API…**; the status bar's Tools, the palette and the Collections header go to the Debugger and open it (`lib/capture.ts`).
  - **Not done:** a History entry per capture session (History has no "session" kind yet; sessions are listed and autosaved in the Debugger's Session menu), and folding the reverse proxy's exchanges into the Debugger's grid (it still lists them in its own dialog and saves through `record.save`, which also keeps responses as examples).
  - **Tests:** `tests/unit/capture-to-collection.test.ts` (grouping, secrets never saved, a token through a collection variable, adding to a collection, the MCP tool from a HAR); the pinned MCP tool list; e2e `wf-capture-to-collection.cjs` (capture 3, select 2, save, in the explorer; the Capture menu).
  - **Docs:** `api-testing/http-debugger.md`, `mcp-server.md`, `cli/reference.md`, `whats-new.md`.

#### WF-13 One vocabulary and one menu order · S · **QW**
Labels:

| Action | Label |
|---|---|
| Open an item | "Open" |
| Open in a new tab | "Open in new tab" |
| Debugger "Edit & Submit" | "Open as request" |
| A cross-item open | "Open " + the target's `refLabel` noun |
| Run | "Run" |
| Rerun | "Run again" |
| Rerun failed | "Rerun failed" |
| Delete | "Delete…" |

Also:
- Every list gets the same right-click menu as its ⋯ menu: History, Traces, the Runs list, Git changes, Load and Evaluations saved lists.
- Every menu uses the `NodeMenu` group order.
- Remove the duplicate palette commands (`App.tsx:350-406`).
- Fix the shortcuts:
  - Ctrl+Alt+N follows the *rail* order, and the rail tooltips show it;
  - list Ctrl+\` and Ctrl+Shift+\` in `ShortcutsDialog.tsx`.
- Shared component: move `NodeMenu` out of `CollectionTree.tsx` into `TreeParts.tsx`, so every list uses it.
- Verify:
  - a unit test that scans menu labels for the retired variants;
  - `e2e/plans/context-menus.cjs`.
- *Built (2026-10-09):*
  - **Vocabulary:** `lib/vocabulary.ts` (`LABEL`: Open, Open in new tab, Open as request, Run, Run again, Rerun failed, Delete…; `RETIRED_LABELS`; `MENU_GROUPS`). "Open in tab" → **Open** (+ **Open in new tab** on requests), Debugger "Edit & Submit" → **Open as request**, every deleting menu item → **Delete…** (`menuKeys` finds it for the Delete key). `refOpenLabel` (WF-04) gives the cross-item "Open run / Open trace / Open request".
  - **One menu:** `NodeMenu` moved from `CollectionTree.tsx` to `TreeParts.tsx` (exported, the group order documented there; a `test` group from WF-07; `onOpenNewTab`). Right-click = ⋯ on History (WF-07/16), Traces (Open · Open run · Copy link) and the Git view's changed files (Open · Show the line diff · Stage/Unstage · Discard…); the saved lists (`FolderList`) already had it.
  - **Palette:** removed the duplicates "New Request" (= New HTTP Request), "New MCP Test" (= Add MCP Server) and "Open Collection"; "New GraphQL Request", "Open History", "New Evaluation".
  - **Shortcuts:** `lib/rail.ts` (`railOrder(NAV)`, `railShortcut`, `railTarget`): Ctrl/Cmd+Alt+1…9 follow the rail (2 = Collections: the last request editor with its sidebar); the rail's tooltips (two small edits in `Shell.tsx`) and the shortcuts list say the same; Ctrl+\` and Ctrl+Shift+\` listed.
  - **Left in excluded files:** `RunPanel.tsx` "Re-run failed" (→ `LABEL.rerunFailed`), `TestsView.tsx` file menu "Delete" (→ `LABEL.delete`) and the Runs list's right-click.
  - **Tests:** `tests/unit/vocabulary.test.ts` (retired words, Delete…, group order, rail order); e2e `wf-context-menus.cjs`; `row-actions`, `datasets`, `rename-environments`, `tab-strip-scroll` expectations updated.
  - **Docs:** `getting-started/finding-your-way.md#menus-and-shortcuts`, `api-testing/collections.md`, `api-testing/http-debugger.md`, `whats-new.md`.

#### WF-14 Variables: source on hover everywhere, and "also add to the other environments" · M
- The `VarPopoverHost` popover (a variable's value and which scope it comes from) works in every `VarInput`: GraphQL, gRPC, WebSocket, MCP, Load, the monitor editor and the test editor.
- Adding a variable to one environment offers "Also add to: Staging, Production (empty / copy the value)". This was asked for on HN; `MoveVariablesDialog` already has the UI pieces.
- Files: `VarInput.tsx`, `EnvironmentsView.tsx`, `lib/save-variable.ts`.
- AI-first: `set_environment_variable` gets `alsoIn: string[]`.
- Verify: an e2e step.
- *Built (2026-10-09):*
  - **Source on hover, everywhere:** `VarPopoverHost` (the one popover host) now also listens to `pointerover` on every input and text area that is not a variable-highlighting field (`VarInput` has its own): one `inspectVariables` lookup per value and environment (a `WeakMap`, no DOM bloat; the vars cache answers repeats), the field's own tooltip kept above "name = value (scope)" lines; values over 20,000 characters are left out (bodies are code editors). Double-click opens the popover as before. The MCP server URL (both forms) and a monitor's alert webhook became `VarInput`s (highlighting, click, autocomplete).
  - **Also add to the other environments:** core `addVariablesToEnvironments(store, from, keys, to, { copy, secrets })` (`storage/env-edit.ts`): adds only what is missing, never overwrites, empty or copied, secrets stay secret (value copied secret store to secret store; without one, added without a value). RPC `vars.setInEnvironment { alsoIn, copy }` (answers `also`) and `vars.addToEnvironments`.
  - **Shared component:** `components/AlsoAddTo.tsx`: `AlsoAddTo` (environment chips with production marked, "Copy the value") in the variable popover for a variable not defined yet, and `AlsoAddDialog` after saving an environment whose new variables other environments lack (Environments view).
  - **AI-first:** MCP `set_environment_variable` takes `alsoIn` and `copyValues`; CLI `testpion env set … --also-in Staging,Production [--copy] [--json]`.
  - **Tests:** `tests/unit/also-add-variables.test.ts` (core, RPC, CLI); e2e `wf-variables.cjs` (popover chips → added in both, hover tooltip, the Environments view's dialog).
  - **Docs:** `api-testing/environments.md` (hover, "Also add to the other environments"), `cli/reference.md`, `ai-testing/mcp-server.md`, `whats-new.md`. `llms.txt` still needs `--also-in` and `alsoIn`.

#### WF-15 Open tabs follow file changes in every editor · S
- Generalise the REST "Keep mine / Take the new version" prompt (`RestView.tsx:196`) through a `useExternalChange(ref)` hook to GraphQL, gRPC, WebSocket, MCP, test files and monitors. It fires after a git pull or an external edit.
- Verify: an e2e step changes the file on disk while its tab is open.
- *Built (2026-10-09):*
  - **One mechanism:** `lib/follow-changes.ts` (pure: `followChanges(options, decide)`, the app-wide one-question-at-a-time queue, a repeat for the same item and version dropped) and `lib/external-change.ts` (`useExternalChange({ kinds, items, read, take, keep })` over the watcher's `workspace.changedOnDisk`, options read through a ref so it subscribes once and unsubscribes with the editor; `askKeepOrTake` — the one dialog). Decisions use what the editor held before the read, so editors whose comparison data is refreshed by the read (libraries) decide right; an item closed meanwhile is left alone.
  - **Editors:** REST (its own effect replaced), GraphQL (a persisted `base` snapshot in its draft, set on open, save, take, keep), gRPC calls and WebSocket / MQTT / Kafka connections (`useLibrary().reload` now answers the library; kind `library`), MCP servers (kind `mcp`; the form no longer resets silently when the saved list changes), the monitor editor (kind `library`, its interval too).
  - **Left in excluded files:** test files and flows (`TestsView.tsx`, `FlowDesigner*.tsx`): the hook is ready (`kinds: ['tests']`, read with `tests.read`); not wired there.
  - **Tests:** `tests/unit/follow-changes.test.ts`; e2e `wf-external-changes.cjs` (GraphQL: clean follows, dirty asks, Take the new version drops the edits); `outside-changes.cjs` still passes.
  - **Docs:** `getting-started/git.md`, `whats-new.md`.

#### WF-16 Console, Traces and History link to each other · S · **QW**
- **Console entries** get `RefLink`s to their saved request, their run (`e.run`) and their trace, plus "Open as request".
- **Traces** get Open request · Open run · Open history entry in the span header (`TraceView.tsx`).
- **History:** GraphQL, MCP and LLM entries open with their payload (fixes `HistoryView.tsx:158-160`).
- Everything goes through `openRef`.
- Verify: `e2e/plans/console-traces-links.cjs`.
- *Built (2026-10-09):*
  - **Console:** the console code moved out of `backend.ts` into `backend/console-log.ts` (`ConsoleEntry`, `pushConsole`, `consoleProtocol`, `consoleFromResult`, `consoleRefs`, `clipConsole`). Every entry carries `refs: ItemRef[]`: a send (HTTP, GraphQL; failed ones too) its saved request, History entry and trace; an MCP tool call its History entry and trace; a run's request its run (with `resultId`), its trace and, in a collection run, the saved request (from the result id `<request>@<iteration>`).
  - **Traces:** `traces.get` adds `refs` (the History entry through the new `MetaStore.historyOfTrace`, indexed on first use only, and its saved request; the run from the trace's `runId`), one call as before.
  - **Shared component:** `RelatedRefs` (RefLink.tsx): the line of `RefLink`s plus **Open as request** for a History entry, used by the Console's expanded line and the trace header (`TraceView`).
  - **History:** WF-02 had the payloads; its rows now have the right-click / ⋯ menu (Open · Open request · Open trace · Save as test… · Delete), the detail header the same ⋯.
  - **Tests:** `tests/unit/console-trace-links.test.ts`; e2e `wf-console-traces-links.cjs` (Console links → trace → History entry → Open request).
  - **Docs:** `api-testing/rest.md#console`, `getting-started/finding-your-way.md`, `whats-new.md`.

#### WF-17 Status bar as the tool hub · S · **QW**
- Terminal gets a button beside Console and Logs.
- The Problems badge (WF-03).
- The environment segment becomes clickable (WF-05).
- A "Tools" menu with Cookies, Find & Replace (`ReplaceDialog`), Record and Certificates, as in Postman's footer.
- Verify: an e2e click on each.
- *Built (2026-10-09 → 10-14):* `components/StatusBarTools.tsx` (WF-03): the Problems badge (toggles the Problems tab), **Terminal** (when the platform has a shell; toggles the Terminal tab and focuses it), and **Tools** (Cookies…, Find & replace in a collection…, Reverse proxy for one API… — the Debugger's capture mode since WF-12 —, Certificates); the environment segment is `EnvSelect variant="status"` (WF-05). All bottom-panel buttons toggle the same way (`toggleBottom`). **Tests:** e2e `wf-status-bar.cjs` (a click on each: the tabs, the environment menu, each tool opens what it names). **Docs:** `finding-your-way.md` (Problems).

### P2: polish and debt

#### WF-18 Empty states always offer the next step · S · **QW**
Give every dead-end `Empty` an action:

| Empty state | Actions |
|---|---|
| Load "No saved load tests" | "New load test", "From a request…" |
| Evaluations "No saved evaluations" | "New evaluation" |
| gRPC "No saved requests" | "Import .proto" |
| WebSocket "No saved connections" | "New connection" |
| Playground "No saved prompts" | "New prompt" |
| Home "Nothing sent yet" | "New request", "Import" |
| Monitors "Select a monitor" | "New monitor" |

Also:
- Unify the API: `actions=[]` only; drop `action=` (`CookiesModal.tsx:139`).
- Verify: a unit test that flags `<Empty` without `actions` in list-level empty states (with an allow-list for "Select a …" states inside split panes).
- *Built (2026-10-09):*
  - **One API:** `Empty` lost `action` (an element); `EmptyAction` takes `items` for a menu button (New request ▸ …), so every next step is a button of the same look. Moved: `NoOpenTabs` (New request menu, Describe with AI), Cookies (Add domain), AI Providers (the Claude-key link became an action).
  - **Dead ends given their step:** Load "No saved load tests" (Save this load test), Evaluations "No saved evaluations" (Save this evaluation) and "No runs yet" (Run this evaluation), Playground "No saved prompts" (Save this prompt), Home "Nothing sent yet" (New request, Import), Monitors "Select a monitor" (New monitor). The saved lists' "New" is "save what is on screen" in these editors, hence the labels. gRPC / WebSocket "No saved …" went with the dead sidebars (WF-21).
  - **Tests:** `tests/unit/empty-states.test.ts` (no `action=` anywhere; the plan's dead ends carry `actions`).
  - **Docs:** `whats-new.md`.

#### WF-19 One tab model for every view that opens items · L
- **Today:**
  - Tests and Monitors use `DocTabStrip`.
  - Load, Evaluations, AI prompts, Environments and Debugger sessions have no tabs, so opening a second item replaces the first.
- **Change:**
  - Move them onto the `EditorTabStrip` / `useDocs` model.
  - Add preview (italic, replaced on the next single-click) vs pinned tabs, as VS Code and Postman do.
- Do it per view, after WF-11.
- Verify: per-view e2e.
- *Built (2026-10-14), in part:*
  - **Shared:** `DocTabStrip` tabs take `preview` (italics; double-click or **Keep open** keeps them: `onKeep`). `lib/library-tabs.ts` (`useLibraryTabs`, with the pure `openTab` / `closeTabs`): the tabs of a view whose items live in a library, each with its own draft (`persisted(...).forDoc`), the open tabs per workspace (draft-store, scoped); an edit keeps a preview tab; the first, empty, unsaved tab is reused. `components/LibraryTabStrip.tsx` draws it with DocTabStrip and notes closed tabs for Ctrl+Shift+T. `FolderList` gained `onOpen` (double-click, Enter) beside `onSelect` (a click previews). `persisted()` exposes `defaults` (what a new tab starts from).
  - **Moved onto it:** Load (load tests) and Evaluations.
  - **Not moved yet:** AI prompts (the Playground and Compare share one draft through `useDraft`: per-tab drafts need Compare decoupled first), Environments (an edit-in-place list, not documents) and Debugger sessions (a session replaces the capture; tabs need several sessions open at once). Preview tabs for request tabs (REST) are not done either: REST's tab model lives in `RestView`.
  - **Tests:** `tests/unit/library-tabs.test.ts`; e2e `wf-library-tabs.cjs` (preview replaced, double-click keeps, per-tab edits, Evaluations' strip); `eval-matrix`, `evaluation-dataset` still pass.
  - **Docs:** `finding-your-way.md`, `whats-new.md`.

#### WF-20 Right side: one pinnable host and a context panel · M
- The AI assistant becomes a `PinnablePanel` (today a fixed `w-80` column in `App.tsx`).
- Add a context **Info** panel for the open item:
  - Variables in scope (with their source)
  - File and git status
  - Last runs
  - Code snippet
  - Assistant
- It is the same for a request, a test file or a monitor (the Postman right context bar).
- Snippets, Examples and the Debugger dock keep `PinnablePanel`.
- Verify: an e2e test pins and unpins and checks that the state persists.
- *Built (2026-10-14):*
  - **Shared:** `components/RightPanel.tsx`: `RightPanel` is one `PinnablePanel` (id `right`; starts unpinned as an edge tab; pin and width kept) with **Info** and **Assistant** (a Segmented switch, kept); asking the assistant switches to it and slides it open (`revealKey`). `AssistantPanel` takes the host's width. `ContextInfo` reads the item on screen (`useCurrentItemRef`: the active editor tab's item, else the recorded place through `refOfPlace`), only while the panel is shown.
  - **Info:** the `{{variables}}` the item uses with value (secrets masked) and source in the active environment (unset ones marked), its file with its git state (a link to the Git view's diff), the last runs that included it, and Copy as cURL for a request. Backend `ref.info` (core `storage/item-info.ts`, `itemInfo`: the file, the item's text, runs matched by a collection run's origin or a test run's files, a folder run or an all-tests run included); MCP `item_info` (variable names, without values).
  - **Kept:** Snippets, Examples and the Debugger dock stay their own `PinnablePanel`s.
  - **Tests:** `tests/unit/item-info.test.ts` (request: file, variables with sources, runs; test file: a folder run includes it; the MCP tool); pinned MCP tool list; e2e `wf-right-panel.cjs` (edge tab, Info for the open request, pin kept, the assistant inside); `ai-assistant`, `pinnable-panel` still pass.
  - **Docs:** `finding-your-way.md` (The Info panel), `mcp-server.md`, `whats-new.md`.

#### WF-21 Remove the dead per-editor sidebars · S · **QW**
- These files build `SidebarShell` panes inside `Split collapsed`, which never renders them (`ui.tsx:622`):
  - `RestView.tsx:601-695`
  - `GraphQLView.tsx:417-470`
  - `GrpcView.tsx:271-300`
  - `WebSocketView.tsx:312-335`
  - `McpView.tsx:281-330`
- Delete them, so the Collections Explorer is the single sidebar of the request editors.
- Verify: the existing request-editor e2e plans pass.
- *Built (2026-10-09):* the `Split sidebar collapsed` + `SidebarShell` blocks are gone from `RestView`, `GraphQLView`, `GrpcView`, `WebSocketView` and `McpView` (≈300 lines), with the state only they used (REST's filter / favourites / side pane, GraphQL's side and tree filter, the live-collections sets, `serverSummary`) and their imports; their "No saved …" empty states went with them. The Collections explorer is the request editors' one sidebar. Verified by typecheck and the request-editor e2e plans (core, keyboard, row-actions, wf-*).

#### WF-22 An onboarding path that follows the loops · S
- Extend Home "Get started" (today 4 steps) to loop (a): Send → Save → Save as test → Run → Run in CI.
- Loops (b), (c) and (e) become optional cards that start the matching walk-through in the Examples workspace.
- Each step completes from real events (as today), and its button opens through `openRef`.
- Verify: an e2e test on a fresh profile.
- *Built (2026-10-14):*
  - **Core:** `storage/onboarding.ts` (`onboardingProgress`): Send (History), Save (a request in a collection), Save as test (a file under tests/), Run (a run), Run in CI (a GitHub / GitLab / Azure / Jenkins file that runs testpion, in the workspace folder or a repository up to 3 levels above); each step carries the ref its button opens (the history entry, the saved request, the test file, the run). Backend `ws.onboarding`.
  - **UI:** `lib/onboarding.ts` (`LOOP_STEPS`, `runStep` through `openRef`; CI opens the Run in CI dialog with the test file; `WALKTHROUGHS` for loops b, c and e: open the Examples workspace then the Tests view or the Debugger; git opens the Git view; each with its guide as a doc ref). Home's `GetStarted` shows the five steps and the walk-throughs; it is hidden once all are done or by Hide (as before), and never in the Examples workspace.
  - **Not done:** the walk-throughs open where each loop starts with its guide; there is no in-app step-by-step tour.
  - **Tests:** `tests/unit/onboarding.test.ts`; e2e `wf-onboarding.cjs` (a new workspace: five steps, walk-throughs, ticked from a saved and a sent request, Save as test opens the request).
  - **Docs:** `finding-your-way.md` (Get started), `whats-new.md`.

---

## 5. Order of work

1. **WF-02** `openRef` and `RefLink`. Everything else uses them.
2. **Quick wins in one pass:** WF-04, WF-05, WF-07, WF-09, WF-13, WF-16, WF-17, WF-18, WF-21.
3. **WF-08** run ↔ source, **WF-01** Quick Open, **WF-03** Problems, **WF-06** production guard.
4. **WF-10** recent items, **WF-11** breadcrumbs and reveal, **WF-12** capture, **WF-14** variables, **WF-15** external changes.
5. **WF-19** tabs, **WF-20** right panel, **WF-22** onboarding.

Each item lands with:
- its e2e plan;
- `docs/` updates: `getting-started/whats-new.md`, and a new "Finding your way around" page under `getting-started/`;
- an `llms.txt` entry for every new CLI command or MCP tool (`search_workspace`, `problems`, `open`, `debugger_save_to_collection`).

There is **one full regression at the end**, not between items.

## 6. Done when

- Every item named in the UI is a `RefLink` that opens through `openRef`. No view keeps its own routing table: `openIntent(` appears only in `open-ref.ts` and the views' intent handlers.
- Ctrl+P reaches any request, test, flow, monitor, environment, run or saved item in 3 keystrokes or fewer.
- From any failure (run, monitor, flow, Problems), the source is one click away, and "Run again" is one more.
- Every send or run against a production environment is guarded, in the UI and over MCP.
- The same action has the same label, icon and menu position in every view.
