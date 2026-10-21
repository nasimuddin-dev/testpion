# UI audit 2026-10-21: user-friendliness gaps

Read-only audit of `apps/desktop/src` (renderer) at commit `ed57eb43`, by reading code. Every line number is from that
tree. Nothing was run; anything not checked in code is marked **unverified**. Audience: API/AI testers coming from
Postman/Insomnia/Bruno, and AI agents (every feature also CLI `--json` / MCP).

Severity: **P0** stuck or data loss · **P1** confusing · **P2** polish.

What is already good (so the fixes below are about adoption, not invention): `Empty` with `actions`/`steps`
(`components/ui.tsx:347`), `deleteWithUndo` (`lib/undo-delete.ts:22`), `confirmAction` (`store.ts:558`),
`toastError`/`attempt` (`store.ts:497`), `FooterHint` (`ui.tsx:464`), `copyText` (`lib/clipboard.ts:5`),
`TreeRowShell` adds a `title` only when a name is cut (`TreeRowShell.tsx:122-127`), the shortcut registry with a
docs-sync test (`lib/shortcuts.ts`, `tests/unit/shortcuts-list.test.ts`), the vocabulary denylist
(`tests/unit/vocabulary.test.ts`), and `tests/unit/empty-states.test.ts` (WF-18).

---

## 1. Empty states

158 `<Empty>` usages; 32 pass `actions`. Of the rest most are legitimate "select something on the left" or loading
placeholders. The ones below are first-run dead ends or error states with no next step.

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| P1 | `views/HomeView.tsx:422` | "No collections yet — Create one, or import from Postman or OpenAPI." (text only, on the Home dashboard) | Buttons: New collection, Import… (the sentence names the actions but offers none; the card header's "Manage" link goes to the view, not to the action) |
| P1 | `views/HomeView.tsx:442`, `components/SidebarPanes.tsx:74` | "No environments" + a definition | "New environment" action (the Environments view itself has one at `views/EnvironmentsView.tsx:440`; Home and the sidebar pane do not) |
| P1 | `components/CollectionVariablesPane.tsx:99` | "No collections yet" | New collection / Import actions |
| P1 | `views/DebuggerView.tsx:891` | "Nothing captured yet — Start the proxy and send some traffic…" | "Start the proxy" action (and a "Record…" alternative) |
| P1 | `views/GraphQLView.tsx:650-653` | "No schema loaded" with a raw `<Button>` inside the children | The same button through `actions` (the `Empty` doc says "no other kind of button"; the unit test only catches `action=`, not children buttons) |
| P1 | `views/TestsRunsList.tsx:102`, `components/RunsOverview.tsx:244`, `components/EvalMatrix.tsx:271`, `components/FlowDebugParts.tsx:70` | "No runs yet — Run a test file (▶ on its row, or Run all tests)" / "Run an evaluation…" | "Run all tests" / "Run" action (the text tells the user where to click instead of offering it) |
| P1 | `components/ExamplesPanel.tsx:43`, `components/MockPanel.tsx:138` | "No examples yet — Send the request, then click Save as example" | "Send" action; when the request is unsaved, "Save to collection…" |
| P1 | `views/GrpcView.tsx:475` | "Describe the service with .proto files" (two lines of rules) | "Add .proto file…" and "Use server reflection" actions |
| P1 | `views/LoadView.tsx:646` | "Configure and start a load test" + a list of metrics | "Start" action (disabled with the reason until a URL is set) |
| P2 | `views/WebSocketView.tsx:556`, `components/DebuggerRules.tsx:173`, `components/rag/RagDataPanel.tsx:49`, `components/mcp/McpPanels.tsx:265`, `views/GitView.tsx:241` | "No subscriptions", "No rules in this profile — Add a preset or a new rule", "No datasets yet — Generate…", "No prompts", "Git is not installed — Install it from git-scm.com" | The named action as a button (Add rule / Add preset; Generate test set; Open git-scm.com) |
| P1 | `components/ApiPreviewPanel.tsx:130`, `components/AsyncPreviewPanel.tsx:89`, `components/EnvMatrix.tsx:55`, `components/ResponseDiffPanel.tsx:82`, `components/ResponseHistory.tsx:94`, `views/ApiDefinitionView.tsx:219`, `views/DatasetView.tsx:170` | "Couldn't read/open the document" + the engine's message, no button | A Retry action and, where it applies, "Open the file" / "Reveal file" |

**Shared fix:** keep `Empty` as the one API; add a lint-style unit test (extend `tests/unit/empty-states.test.ts`) with two
rules: (a) a title starting with `No …`/`Nothing …`/`Couldn't …` must pass `actions`, unless it carries `data-dead-end`
with a one-line reason; (b) an `Empty` whose children contain `<Button` or `<LinkButton` fails (today only `action=` is
checked). Make the actions reusable: a `lib/empty-actions.ts` with `newCollection`, `importAction`, `newEnvironment`,
`sendRequest` so Home, the sidebar panes and the views offer the identical button.

## 2. Errors

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| P1 | `views/HistoryView.tsx:202-206` (`remove`), `views/DebuggerView.tsx:243-248` (`remove`) | `await call('history.delete' / 'debug.delete')` with no `attempt`/`toastError`: a failure is an unhandled rejection (the row stays, nothing is said) | Wrap in `attempt` like every other delete |
| P1 | `views/GraphQLView.tsx:412-417` | "Save as test file" with variables that are not valid JSON silently drops the variables (`catch { variables = undefined }`) | A warning toast ("Variables are not valid JSON: saved without them") or refuse with the parse error |
| P2 | `views/GraphQLView.tsx:137`, `components/RecordDialog.tsx:42` | The copy to the clipboard is `.catch(() => undefined)`, then the toast says "(copied)" regardless | Use `copyText` (it reports a refused clipboard) or drop "(copied)" when the copy failed |
| P2 | `components/AssistantPanel.tsx:391` | Code-block Copy button writes to the clipboard with no error handling and flips to "Copied" even on failure | `copyText` |
| P2 | `App.tsx:252` | "Run failed: <engine message>" for every run error; no action | A toast action "Open run" / "Open Logs" (the `ToastAction` with `ref` exists: `store.ts:48`) |
| P2 | `views/ai/common.tsx:99`, `views/ai/Providers.tsx:103` | "Could not list models: <message>" / "Connection failed: <message>" with no action | `toastAiError` already maps key problems to "Add the key" (`lib/ai-errors.ts:12`); use it here so the same error gets the same fix button |
| P2 | `lib/problems.ts:51` | "3/7 · <problem message>" toast for F8 navigation | Fine for power users; a first-time user does not know "3/7" is a Problems index: prefix "Problem 3 of 7" |

Verified positives: there are **no** bare `catch {}` around user actions in the renderer (153 catch sites are JSON/storage
guards or deliberate `.catch(() => undefined)` on optional reads); raw `String(e)` reaches a toast only through
`asError(e).message`, which is the engine's user-facing text, not a stack. Stack text is never rendered (grep `stack`
in toasts: none).

**Shared fix:** an ESLint rule (or a unit test over the source) that a `call('*.delete' | '*.clear' | '*.save' | '*.write')`
awaited inside an event handler must sit inside `attempt(...)` or a `try` with `toastError`; and a `toastError` option
`action: 'open-logs'` so every engine failure offers "Open Logs" by default.

## 3. Destructive actions, by item kind

Source of truth: `packages/shared/src/item-kind-list.ts` (`delete`/`trash` capabilities) and the call sites.

| Kind (registry label) | How it is deleted in the UI | Confirm? | Undo? | Verdict |
|---|---|---|---|---|
| Collection | `CollectionTree.tsx:172`, `CollectionsView.tsx:316` `deleteWithUndo` → Recently deleted | no | yes (8 s + trash 30 d) | consistent |
| Folder (in a collection) | `CollectionTree.tsx:188` `deleteWithUndo` (snapshot) | no | yes | consistent |
| Request / gRPC call / Connection | `Explorer.tsx:574`, `FolderList.tsx:143` `deleteWithUndo` | no | yes | consistent |
| Environment | `EnvironmentsView.tsx:83` `deleteWithUndo` → trash | no | yes | consistent |
| Test file (tree row, Delete key) | `TestsView.tsx:585` `deleteWithUndo` (text kept) | no (asks only when > 200 files) | yes | consistent |
| **Test file (editor toolbar "Delete file")** | `TestsView.tsx:835-841` `confirmAction` "This cannot be undone (unless the workspace is in git)" then `tests.delete` | yes | **no** | **P1 inconsistent**: the same file, two behaviours depending on where you click; the dialog text is also wrong (the tree path can undo it) |
| Dataset / API definition / MCP server / AI provider | `Explorer.tsx:326/410/513`, `undo-delete.ts:91`, `Providers.tsx:73` `deleteWithUndo` | no | yes | consistent |
| Monitor / Prompt / Load test / Evaluation | `MonitorsView.tsx:218`, `FolderList.tsx:143` | no | yes | consistent |
| Example (saved response) | `ExamplesPanel.tsx:123` `deleteWithUndo` | no | yes | consistent |
| Metric | `rag/CustomMetrics.tsx:190` confirm **and** undo | yes | yes | belt and braces; acceptable (says who uses it) |
| Script package | `ScriptPackagesDialog.tsx:56` confirm | yes | no | registry says so ("scripts may require it"); ok |
| **Debugger rule** | `DebuggerRules.tsx:211`, `debugger/DockRules.tsx:87` `debug.deleteRule` | **no** | **no** | **P1**: one click, gone, no message |
| **Debugger filter preset** | `DebuggerView.tsx:727` `debug.deleteFilterPreset` | no | no | **P2**: same |
| **Debugger rules profile** | `DebuggerRules.tsx:123` confirm "Its rules go with it." | yes | no | ok, but a profile is a file: could trash |
| **History entry** | `HistoryView.tsx:202` `history.delete` | **no** | **no** | **P1**: no message, no undo (registry: "records are cleared from their own view (Delete asks there)" — it does not ask) |
| **Captured exchange(s)** | `DebuggerView.tsx:243` `debug.delete` (multi-select) | **no** | **no** | **P1**: deleting a multi-selection is silent |
| History (clear all) | `HistoryView.tsx:243`, `StoragePanel.tsx:36` confirm | yes | no | ok (irreversible) |
| Debugger session (clear) | `DebuggerView.tsx:250` confirm | yes | no | ok |
| **Incoming requests (clear)** | `debugger/DebuggerGrid.tsx:490` `debug.clearIncoming` | **no** | no | P2: the outgoing side asks, the incoming side does not |
| **Recording (clear)** | `RecordDialog.tsx:106` `record.clear` | no | no | P2 |
| Console (clear) | `ConsolePanel.tsx:115` | no | no | P2 acceptable (a log), but Logs/Console/Terminal differ: Terminal "Kill" has no confirm either (`TerminalPanel.tsx:569`) |
| Cookie (one) | `CookiesModal.tsx:178-186` | no | no | P2: no toast either (`act` shows one only with a message) |
| Cookies (all / domain) | `CookiesModal.tsx:98/148` confirm | yes | no | ok |
| Git branch | `GitView.tsx:307-316` confirm (twice when unmerged) | yes | no | ok |
| Git stash | `GitStash.tsx:98` confirm | yes | no | ok |
| Runs older than N days | `StoragePanel.tsx:28` confirm | yes | no | ok |
| Workspace | `WorkspaceMenu.tsx:295` (`ws.delete`) | **unverified** (not read) | | |
| Recently deleted → Delete for good | `TrashDialog.tsx:47` confirm | yes | no | ok |

**Shared fix:** one rule in `lib/undo-delete.ts`'s doc already states it ("deletes that can be taken back: no confirm,
Undo; deletes that cannot: confirm"). Enforce it: a unit test over the source that every `call('<x>.delete…')` /
`'<x>.deleteRule'` / `'<x>.clear…'` is reached through `deleteWithUndo` or `confirmAction` (allow-list the few log
clears). Give the registry a `deleteMode: 'undo' | 'confirm' | 'silent'` per kind and make `buildNodeMenu` and the view
buttons read it, so the editor-toolbar "Delete file" cannot drift from the tree's Delete.

## 4. Feedback on long operations

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| P2 | `views/GitView.tsx:368-372, 468` | Push / Pull & push show a spinner (`loading`) but cannot be cancelled; a hung remote leaves the button spinning | A "Stop" that calls a `git.cancel` (engine support **unverified**) or at least a timeout message with "Open Logs" |
| P2 | `views/HistoryView.tsx:202`, `views/DebuggerView.tsx:243` | Delete has no busy state and no toast; a double click sends two deletes | Route through `deleteWithUndo` (toast + guards) |
| P2 | `components/CookiesModal.tsx:178` | Deleting one cookie: the row disappears, no message | "Deleted the cookie X" via `deleteWithUndo({ what })` (undo possible: `cookies.set` **unverified**) |
| P2 | `views/SettingsView.tsx:89` | "Save settings" is always enabled and looks the same whether or not anything changed; no `Mod+S`; leaving the view with unsaved edits loses them silently (no guard found: grep `dirty`/`unsaved` in `App.tsx`/`Shell.tsx` returns nothing for settings) | Disable until dirty with the `FooterHint` reason, `Mod+S` (the global handler in `hooks.ts:58` is per view and Settings does not register), and the same "Unsaved changes" dialog the request editors use (`RestView.tsx:336`) |

Verified positives: Send has Cancel (`RestView.tsx:599-601`), imports have Cancel (`ImportDialog.tsx:169/184`) and
Undo, AI runs have Stop (`ai/ai-run.tsx:77-83`), the status bar shows the activity (`setActivity`, `RestView.tsx:248`),
`Button loading` disables itself (`ui.tsx:30`).

**Shared fix:** a `useBusy(key)` hook returning `{ busy, run(fn) }` that sets `loading`, blocks re-entry, and reports
through `attempt`; replace the per-view `const [busy, setBusy]` pairs (grep: 30+ files).

## 5. Discoverability

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| **P1** | `components/ui.tsx:91-108` (`IconButton`) | Every disabled icon button has `disabled:pointer-events-none`, so its own `label` tooltip never shows while disabled; the user sees a greyed icon with no name and no reason (108 `Button`/`IconButton` sites pass `disabled` without a `title`; `FooterHint` is used in only 2 dialogs: `GitCodeownersDialog`, `rag/RagConnectDialog`) | A `reason` prop on `Button`/`IconButton`/`MenuItem`: when `disabled` and `reason` is set, render a wrapper `<span tabIndex=0 aria-describedby>` so the tooltip shows and screen readers read it; dialogs keep `FooterHint` |
| P1 | e.g. `ImportDialog.tsx:195` "Import" disabled, `GitView.tsx:424` "Commit" disabled, `EvaluationsView.tsx:340` "Run" disabled, `GrpcView.tsx:358` "Invoke", `MockPanel.tsx:94` "Start mock server", `RecordDialog.tsx:94` "Start recording", `TracesView.tsx:63/67` "Send", `MonitorsView.tsx:823` "Send test alert", `TerminalPanel.tsx:541` "New terminal" (no shell found) | A grey primary button and nothing else | The reason: "Choose a file or paste first", "Nothing changed", "Pick a dataset", "No request selected", "Save an example first", "Enter an http(s) URL", "Enter the endpoint", "Enter a webhook URL", "No shell was found: install PowerShell or bash" |
| P1 | `views/DebuggerView.tsx:313-314` | `Ctrl+F` focuses the filter and **`Ctrl+E` clears the whole session** (after a confirm) — neither is in the Shortcuts dialog (`lib/shortcuts.ts` has no Debugger group); `components/FlowDiagram.tsx:579` `Ctrl+F` likewise | A "Debugger" and "Flow designer" group in `lib/shortcuts.ts` (the docs test then keeps `keyboard-shortcuts.md` in step) |
| P2 | `components/CollectionRunner.tsx:339`, `ai/ProposalReview.tsx:165`, `ai/FlowProposalReview.tsx:192` | `Ctrl+Enter` runs/accepts, shown nowhere near the button | The combo in the button `title` (RestView does: "Send (Ctrl+Enter)") |
| P2 | `App.tsx` palette ids | The command palette has no "Recently deleted", "Clear history", "Cookies", "Start the proxy", "Record…" (only `m-record`), "Keyboard shortcuts" is there | Register the per-view top actions as palette commands from the same source as the view header's menu |
| P2 | `components/debugger/DebuggerGrid.tsx:285-286` | Menu items "Request body…"/"Response body…" disabled with no `title` (the `MenuItem.title` field exists for exactly this, `Menu.tsx:19`) | "This exchange has no request body" |
| P2 | `views/HomeView.tsx:334`, `components/Results.tsx:129` | The only in-app links to the docs are the Home card "Read the docs" and one in Results; no view, dialog or settings tab has a help link (grep `openDocs`: 2 call sites) | A `help` prop on `PageHeader` and `Modal` (`ui.tsx:661/434`) that renders one "?" link to the matching docs page (`DOCS_URL + page`); a table `lib/docs-pages.ts` view→page |

## 6. Forms

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| **P1** | `components/ui.tsx:434-458` (`Modal`) | The Close "×" is the first focusable element inside `DialogPrimitive.Content` and no `onOpenAutoFocus` is set; Radix focuses the first tabbable, so **every dialog that does not set `autoFocus` opens with focus on Close** — 54 of 67 dialog files have no `autoFocus` (list in the appendix). Typing goes nowhere; Enter closes the dialog | `Modal` passes `onOpenAutoFocus` that focuses the first `input, textarea, select, [data-autofocus]` in the body, else the footer's primary button; or render the Close button after the body |
| **P1** | 49 `Modal` files have neither `<form>` nor an `onKeyDown` (only 2 `<form>` tags in the renderer; e.g. `MoveDialog.tsx:59-62`, `RunWithDataDialog.tsx:96-97`) | Enter in a dialog's text field does nothing; the user reaches for the mouse | `Modal` accepts `onSubmit`: wraps the body in a `<form>` so Enter in any field triggers the primary action (and `Mod+Enter` in textareas) |
| P2 | `views/SettingsView.tsx:214-226` (Model pricing table), `views/LoadView.tsx:451` (method select) | Inputs with no `aria-label`, `placeholder` or `Field` | Header-cell `id` + `aria-labelledby`, or `aria-label` |
| P2 | `views/SettingsView.tsx:140` "Default timeout (ms)" | No hint, no default, no unit guidance; `Number('')` writes `0` (= no timeout? **unverified**) | Hint "0 waits forever; default 30000", `min`, and a "Reset to default" |
| P2 | `views/SettingsView.tsx:250` "Maximum virtual users" | No hint, no default | Hint with the default and why it exists (protects the machine) |
| P2 | `views/SettingsView.tsx:146` Log level | Hint "DEBUG/TRACE are safe to enable" — vocabulary is jargon-ish and the options are upper-case codes | Sentence-case options with a word each ("Debug (verbose)"), default marked |

Verified positives: `Field` wraps the control in a `<label>` (`ui.tsx:181`), so most settings inputs are labelled;
`FooterHint` exists for disabled-primary reasons; the Send bar has a descriptive placeholder (`RestView.tsx:595`).

## 7. Tooltips and labels

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| P2 | `components/DebuggerRules.tsx:192/200/211`, `components/DebuggerTools.tsx:107/230/241`, `components/RunPanel.tsx:353-354` | Icon-only `<Button icon=… title=… />` with no children and no `aria-label` (a `title` is not read reliably) | `IconButton label=…` (the uniform component) |
| P2 | `views/CollectionsView.tsx:310` | Icon-only `Button` with neither `title` nor `aria-label` | `IconButton` |
| P2 | 228 `truncate` elements without `title`/`aria-label` (e.g. `CollectionRunner.tsx:434` request path, `AlsoAddTo.tsx:38`, `ApiCoverageDialog.tsx:170`) — tree rows are fine thanks to `TreeRowShell` | Cut text with no way to read it | A `Truncate` component (or `useTitleWhenCut` hook extracted from `TreeRowShell.tsx:122`) that sets `title` only when `scrollWidth > clientWidth` |

## 8. Help and first-run

| Sev | Where | What the user sees | What they should see |
|---|---|---|---|
| P1 | all `views/*.tsx` | No view has a docs link (grep `openDocs`/`DOCS_URL`: Home card and `Results.tsx` only); the Electron Help menu has "Documentation" (`apps/desktop/electron/app-menu.ts:142`) to the docs root | See §5: `PageHeader help=` + `Modal help=`; walkthroughs already know their page (`lib/onboarding.ts:43-74`) |
| P2 | `components/GuidedTour.tsx` is the only `Coachmark` user | First-run guidance is the Home "Get started" card + tour; a user who lands in Debugger, Load or AI Lab first sees nothing | Per-view one-time `Coachmark` keyed `aps.seen.<view>` on the view's primary action |

## 9. Docs cross-check (5 max)

| Sev | Doc | Says | UI says |
|---|---|---|---|
| P2 | `docs/getting-started/git.md:338` | "Settings ▸ Privacy" | Tab is "Privacy & security" (`SettingsView.tsx:79`) |
| P2 | `docs/migrate/postman.md:18` | "Settings ▸ Data ▸ Export data" | This is Postman's own settings; say "Postman's Settings ▸ Data" so a reader does not look for a Data tab in TestPion |
| — | `docs/getting-started/finding-your-way.md:159-180` | "Delete…", "Delete folder…" | Matches `LABEL` (verified) |
| — | `docs/api-testing/http-debugger.md:85` | "Open as request" | Matches `LABEL.openAsRequest` (verified) |
| — | retired labels (`RETIRED_LABELS`) | none found in docs (grep) | ok |

---

## Ranked top 10

1. **P1 Dialog focus lands on the Close button** — `ui.tsx:434-458`, 54 dialog files. Fix in `Modal` (`onOpenAutoFocus` → first field or primary). Guard test: a unit test that `Modal` renders Close after the body or passes `onOpenAutoFocus`; e2e: open any dialog and assert `document.activeElement` is an input or the primary button.
2. **P1 Enter does not submit dialogs** — 49 `Modal` files without `<form>`/`onKeyDown`. Fix: `Modal onSubmit` wraps a `<form>`. Guard: unit test that every `Modal` with an `<Input` passes `onSubmit`.
3. **P1 Disabled controls give no reason** — 108 sites; `IconButton` cannot even show its label while disabled (`ui.tsx:98`). Fix: `reason` prop on `Button`/`IconButton`/`MenuItem` rendering a focusable tooltip wrapper; `FooterHint` for dialog primaries. Guard: unit test that a `disabled=` on Button/IconButton/MenuItem has `reason`/`title` or sits in a file using `FooterHint`.
4. **P1 Delete inconsistency per kind** — test file toolbar (`TestsView.tsx:835`) confirms with no undo while the tree undoes; history entries (`HistoryView.tsx:202`), captured exchanges (`DebuggerView.tsx:243`), debugger rules (`DebuggerRules.tsx:211`, `DockRules.tsx:87`) and filter presets delete silently with no undo and no error handling. Fix: `deleteMode` in the kind registry + `deleteWithUndo` everywhere. Guard: source test that every `'*.delete*'` call is inside `deleteWithUndo` or `confirmAction`.
5. **P1 Empty states that name an action but do not offer it** — Home collections/environments, Debugger stats, runs lists, examples, gRPC proto, Load, plus 7 "Couldn't read" states without Retry. Fix: shared `lib/empty-actions.ts`; extend `empty-states.test.ts` with the "No …/Couldn't … needs actions" rule and the "no `<Button` in children" rule (`GraphQLView.tsx:650`).
6. **P1 Debugger shortcuts undocumented, one destructive** — `Ctrl+E` clears the session (`DebuggerView.tsx:314`), `Ctrl+F` in Debugger and Flow designer. Fix: groups in `lib/shortcuts.ts`. Guard: a source test that every `ctrlKey||metaKey` + `key ===` handler outside Monaco maps to a registry row (grep-based, allow-list the editors).
7. **P1 Settings can be lost** — no dirty indicator, no `Mod+S`, no leave guard (`SettingsView.tsx:89`). Fix: reuse the request editors' "Unsaved changes" `confirmAction` through a shared `useUnsavedGuard(view, dirty)`; disable Save until dirty with a hint. Guard: e2e plan: change a setting, switch view, expect the dialog.
8. **P1 No docs link from any view or dialog** — fix: `PageHeader help=` / `Modal help=` + `lib/docs-pages.ts`. Guard: unit test that every id in `NAV` has a docs page and the page exists under `docs/`.
9. **P2 Silent failure paths** — `GraphQLView.tsx:412` drops invalid variables on save; `HistoryView`/`DebuggerView` deletes not wrapped in `attempt`; copy "(copied)" claims without checking. Fix: `attempt` rule (ESLint/source test) and `copyText` only.
10. **P2 Icon-only `Button`s and cut text without names** — 9 self-closing `Button icon=` (`DebuggerRules`, `DebuggerTools`, `RunPanel`, `CollectionsView:310`), 228 `truncate` without `title`. Fix: `IconButton` only for icon-only; a `Truncate` component reusing `TreeRowShell`'s measure. Guard: source test "no self-closing `<Button icon=`", and a `Truncate` adoption count that may only go up.

Also for AI agents (memory "ai-first-design"): the gaps above are UI-only; every action they wrap (delete, clear,
import, run) already has an RPC. The `deleteMode` per kind (item 4) should also surface in `testpion kinds --json`
and the MCP `kinds` tool so an agent knows which deletes are reversible before it calls them (**unverified** that the
kinds listing is exposed today).

## Appendix: dialog files with neither `autoFocus` nor `.focus()`

`components/ai/AiAnalysisDialog.tsx`, `AiPreviewDialog.tsx`, `DriftDialog.tsx`, `FlowGenerateDialog.tsx`,
`FlowProposalReview.tsx`, `ProposalReview.tsx`, `SecurityRunDialog.tsx`, `TidyImportDialog.tsx`;
`components/AlsoAddTo.tsx`, `ApiCoverageDialog.tsx`, `CiDialog.tsx`, `CodeModal.tsx`, `CollectionRunner.tsx`,
`debugger/CreateFlowDialog.tsx`, `debugger/SaveToCollectionDialog.tsx`, `DebuggerRules.tsx`, `DebuggerTools.tsx`,
`EnvCompare.tsx`, `EnvMatrix.tsx`, `ExportBundleDialog.tsx`, `ExportDialogBody.tsx`, `FlowDesignerParts.tsx`,
`FolderEditorBody.tsx`, `GenerateDataDialogBody.tsx`, `GitCodeownersDialog.tsx`, `GitConflictDialog.tsx`,
`GitFixDialog.tsx`, `GitItemDiffDialog.tsx`, `GitItemHistoryBody.tsx`, `ImportBundleDialog.tsx`,
`McpClientRequestDialog.tsx`, `MoveDialog.tsx`, `MoveVariablesDialog.tsx`, `OpenApiDiffDialog.tsx`,
`rag/RagCalibration.tsx`, `rag/RagCaptureDialog.tsx`, `rag/RagColumnMapper.tsx`, `rag/RagConnectDialog.tsx`,
`rag/RagEstimateDialog.tsx`, `rag/RagImportDialog.tsx`, `rag/RagResultViews.tsx`, `rag/RagSampleDetail.tsx`,
`rag/RagTestsetDialog.tsx`, `rag/RagTryDialog.tsx`, `RecordDialog.tsx`, `RunWithDataDialog.tsx`,
`ScriptPackagesDialog.tsx`, `SecurityReviewDialog.tsx`, `ShortcutsDialog.tsx`, `TidyDialog.tsx`, `TrashDialog.tsx`,
`VariableUsagesDialog.tsx`; `views/rest/EnvCompareDialog.tsx`, `views/TracesView.tsx`.

Some of these are read-only dialogs (diff, history, shortcuts) where focus on Close is acceptable; the ones with text
fields (Move, Run with data, Record, Import bundle, RAG connect/try/testset, Variable usages, Create flow, Save to
collection, CI) are the ones a user types into first.
