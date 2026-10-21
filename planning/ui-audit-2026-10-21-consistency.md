# UI consistency audit, 2026-10-21

Status: audit (read-only), 2026-10-21, tree at `ed57eb43`. Owner rule: one shared component per UI pattern, identical in every
view (memory `uniform-ui.md`). Paths are relative to `apps/desktop/src` unless they start with `tests/` or `planning/`.
Line numbers are from the tree on 2026-10-21. Every finding below was verified by reading the code quoted; nothing is
inferred from names alone. The app was not driven for screenshots (the findings are structural, in the source).

Severity: **P0** a visible bug · **P1** the same pattern done two ways · **P2** polish.

Guard tests that exist today and what they cover (so the gaps below are the ones they miss):
`tests/unit/vocabulary.test.ts` (retired words, node-menu literals in 17 node views, jargon, menu order),
`tests/unit/no-hex-colours.test.ts` (hex in Tailwind utilities only: `text-[#…]`; **a hex in a JS string or a `style`
is not caught**, its NOT_YET list is empty), `tests/unit/empty-states.test.ts` (`<Empty>` uses `actions`, nine titles must
offer a step), `tests/unit/uniform-segmented.test.ts` (no hand-made mode button rows), `tests/unit/library-tabs.test.ts`
(three tab views draw `NoOpenItems`), `tests/unit/menus-doc.test.ts` (node menus in the docs).

## Contents

- A. Rows of lists and trees (TreeRowShell vs hand-rolled)
- B. Selection, status and kind colours (light/dark)
- C. Tab strips
- D. Toolbars, filter bars and count rows
- E. Copy controls
- F. Loading, empty and error states
- G. Header rows, section titles and heights
- H. Labels and capitalisation
- I. Delete / rename affordances and ad-hoc menus
- J. Keyboard and accessibility
- K. Density and overflow
- Top 10, ranked

---

## A. Rows of lists and trees

The one row is `components/TreeRowShell.tsx` (⋯ button, right-click, Shift+F10, F2, Delete, `*`, Enter, rename field,
drag source, `role="treeitem"`, tooltip when cut, Delete keeps the focus on the next row). It is used by the explorer,
`FolderList` (Monitors, Load, Evaluations, Playground, RAG), Tests, Environments, History and Providers. These lists
draw their own rows instead:

### A1. Traces list rows (P1)

`views/TracesView.tsx:170-194`: a `<div onContextMenu>` around a `<button onClick onKeyDown>` plus a `NodeMenu`
placed absolutely. The row handles only `F10+Shift` / `ContextMenu` (`:177`); no `role="treeitem"`, no Enter-to-open,
no Delete key, no drag, no `data-node-id`, and the keyboard goes nowhere after a delete. Its sibling view History
(`views/HistoryView.tsx:285-327`) is the same shape of data on `TreeRowShell` with `tall` rows, so the two "recent
things" lists look and behave differently (History rows are `data-tree-row` with `aria-level`; Traces rows are not
part of any tree for a screen reader). `TracesView.tsx` is in the vocabulary test's NODE_VIEWS list but the test only
checks label literals, so this went unnoticed.

Owner: `TreeRowShell` (as HistoryView does: `kind="trace"`, `tall`, `ctx={() => traceMenu(t)}`).
Guard: in `tests/unit/vocabulary.test.ts` extend the NODE_VIEWS check: every file in NODE_VIEWS must import
`TreeRowShell` or `FolderList`, and must not contain `onContextMenu=` or `role="treeitem"` of its own.

### A2. MCP protocol trace rows (P1)

`views/McpView.tsx:605-618`: `VirtualList` rows are plain `<button … className={cx('… hover:bg-hover', sel?.id === e.id
&& 'bg-accent/10')}>` with no menu, no keys, no row semantics; the only way to copy or download an event is the whole
list's `OutputActions` (`:596`). The selection colour is `bg-accent/10` (see B1).

Owner: `TreeRowShell` with `kind="mcp-event"` (or the lighter `menu={false}` variant it already supports), selection
`bg-accent-soft`. Guard: same as A1 (add `views/McpView.tsx` to NODE_VIEWS).

### A3. Collections view's collection list (P1)

`views/CollectionsView.tsx:222-227`:

```tsx
<button key={c.id} onClick={() => setSel(c.id)} className={cx('w-full text-left px-3 py-2 border-b border-line/60', sel === c.id ? 'bg-accent/10' : 'hover:bg-hover')}>
```

No ⋯, no right-click, no F2/Delete, no drag, although the same collections in the explorer
(`components/CollectionTreeRows.tsx`) have the full node menu (Run, Export, Settings, Delete…). A person who
right-clicks here gets the browser's nothing.

Owner: `TreeRowShell kind="collection"` with `ctx` from the same `buildNodeMenu` context the explorer uses.
Guard: as A1 (add `views/CollectionsView.tsx`).

### A4. Git history commits (P2)

`views/GitView.tsx:487-504`: `<ul aria-label="Commits">` of `<button … hover:bg-hover … bg-accent/10>`. No menu
(Copy hash, Reveal in history, Compare with… would belong there), no keys. Lower priority: a commit is not a node
kind. Owner: `TreeRowShell` with `menu={false}` for the look, or `ProblemList`'s `RowMenu` pattern if a menu is added.

### A5. Trace span rows (P2)

`components/TraceView.tsx:93-108`: `<button … h-7 … bg-accent/10>` per span, no menu, no keys, the name column a
fixed `w-[38%]` (see K2). Owner: `TreeRowShell menu={false} depth={depth}` (gives `aria-level`, the one hover and
selection colours). Guard: a grep test that `bg-accent/10` is not used as a row background (see B1).

### A6. Console entries (P2)

`components/ConsolePanel.tsx:138-152`: own expandable rows (`<button … aria-expanded>`), own right-end layout,
`w-14` / `w-16` fixed columns. The Debugger has the same data in `DebuggerGrid`. Owner: keep (it is an output log, not
a node list), but its selection/hover classes should come from the row tokens (B1).

---

## B. Selection, status and kind colours (light/dark)

### B1. Two selected-row colours (P1)

`TreeRowShell.tsx:137` paints the active row `bg-accent-soft` (a token: `styles.css:30` light `oklch(0.955 …)`,
`:92` dark `oklch(0.3 …)`). `DebuggerGrid.tsx:403` also uses `bg-accent-soft`. Every hand-rolled row uses
`bg-accent/10` instead: `views/TracesView.tsx:171`, `views/McpView.tsx:610`, `views/CollectionsView.tsx:223`,
`views/GitView.tsx:491`, `components/TraceView.tsx:96`, `components/ScriptsPanel.tsx:109`, `components/CodeModal.tsx:76`,
`components/Shell.tsx:569` (quick open). `accent/10` is the accent at 10 % alpha over whatever is behind it, so the
selected row is a different colour in the two trees of one window, and lighter on `bg-panel` than on `bg-bg`.

Owner: `TreeRowShell` (A1-A5), or for non-row lists a `rowClass(active)` helper next to `rowActionClass` in `ui.tsx`.
Guard: `tests/unit/no-hex-colours.test.ts` gets a second rule: `bg-accent/10` and `bg-accent/15` are not allowed in
`views/**` and `components/**` outside `ui.tsx` (today: 8 files).

### B2. KIND_COLORS in TraceView are hex, in both themes (P1)

`components/TraceView.tsx:15-33`:

```ts
const KIND_COLORS: Record<string, string> = { http: '#0969da', graphql: '#e535ab', llm: '#8250df', mcp: '#bf8700', tool: '#d4a72c', evaluation: '#1a7f37', test: '#6e7781', script: '#57606a', internal: '#8c959f' };
…
if (phase === 'download') return '#2da44e';
return KIND_COLORS[s.kind] ?? '#888';
```

These are GitHub-light colours used as `style={{ background }}` (`:99`, `:103`), so in dark mode the waterfall bars are
the only element whose palette does not change; `graphql` here is `#e535ab` while the GraphQL badge everywhere else is
`var(--k-graphql)` (`styles.css:65`, dark `:117`), `mcp` is `#bf8700` (amber) while `--k-mcp` is a teal. The hex test
does not see it because the colours are JS strings, not utility classes (`HEX_UTILITY` matches `text-[#…]` only).

Owner: `styles.css` tokens: `--k-graphql`, `--k-mcp`, `--k-ai` (llm), `--k-script`, `--k-dataset` exist; add
`--k-http`, `--k-tool`, `--k-evaluation`, `--k-test`, `--k-internal` and map `spanColor` to `var(--k-*)` (the
`color-mix(in oklab, #0969da 45%, transparent)` for DNS/TCP/TLS phases becomes `color-mix(in oklab, var(--k-http) 45%,
transparent)`).
Guard: extend `no-hex-colours.test.ts` to also match `'#[0-9a-f]{3,8}'` string literals in `.tsx` under `components/`
and `views/`, with an allow-list that must only shrink. Justified entries today: `monaco.ts` (editor themes, one per
theme), `components/TerminalPanel.tsx:93-118` (two xterm ANSI palettes, one per theme, xterm reads hex only, `:74`
says so), `lib/drag-ref.ts:51-53` (`var(--panel2, #333)` fallbacks for a detached drag image),
`views/EnvironmentsView.tsx:355` (`<input type="color">` default value, data not styling). Not justified:
`components/TraceView.tsx` (this finding).

### B3. Two dim overlays (P1, light mode)

`components/ui.tsx:438` (Modal) and `components/Shell.tsx:684` (the confirm dialog) dim the window with
`bg-[var(--overlay)]` (`styles.css:52` light `oklch(0.16 0.06 272 / 0.42)`, `:106` dark). The command palette and the
quick-open dialog use `bg-black/30` (`components/Shell.tsx:424`, `:543`). In light mode the palette's backdrop is a
flat grey-black, the Modal's a tinted navy, one on top of the other when a palette opens over a dialog.

Owner: the `--overlay` token. Guard: grep test `bg-black/` and `bg-white/` are not used outside `ui.tsx` (the `bg-white`
on the HTML-preview iframes in `ResponseViewer.tsx:215-221` and the QR code box `DebuggerTools.tsx:488` are justified
and go on the allow-list).

### B4. Status dots: three sizes, two shapes (P2)

`views/TracesView.tsx:179` `w-1.5 h-1.5 rounded-full bg-ok|bg-bad`; `views/HomeView.tsx:414` `w-2 h-2 rounded-full
bg-ok`; `components/ScriptsPanel.tsx:103` `w-1.5 h-1.5 rounded-full bg-ok`; `components/ProblemList.tsx:67` `w-2 h-2
rounded-full` + `DOT[severity]`; `components/TraceView.tsx:99` `w-2 h-2 rounded-sm`. Owner: a `StatusDot tone size`
in `ui.tsx` next to `Badge`. Guard: grep test for `rounded-full bg-(ok|bad|warn)` outside `ui.tsx`.

### B5. Kind badges: raw ids in two views, words in a third (P2)

`views/TracesView.tsx:187` `<Badge>{t.kind}</Badge>` and `views/HistoryView.tsx:301` `<Badge>{e.kind}</Badge>` show
`http`, `graphql`, `mcp` lowercase in the default tone; `components/ConsolePanel.tsx:40,146` has its own
`KIND_LABEL = { graphql: 'GraphQL', mcp: 'MCP', websocket: 'WebSocket' }` with tones `accent`/`judge`;
`components/ActivityCharts.tsx:28` has a second `KIND_LABEL` map; `views/HistoryView.tsx:44` a third list `KINDS` for
its Select. Owner: `KIND_INFO` in `packages/shared/src/item-kinds.ts:149` (already imported by `FolderList.tsx:3`)
plus the `.kind-*` classes. Guard: grep test `const KIND_LABEL` appears in no file under `apps/desktop/src`.

---

## C. Tab strips

Seven implementations of "a row of tabs":

| Where | Component | Height | Look | `role=tablist` | Arrow keys |
|---|---|---|---|---|---|
| view/section tabs (26 files) | `ui.tsx` `Tabs` `:208` | `min-h-10`, tab `h-10` | underline | yes, **no `aria-label`** | no |
| editor tabs, library tabs | `DocTabStrip.tsx:210-228` | `h-9` | document tabs | yes | F2 only (`:238`) |
| bottom panel | `Shell.tsx:280-285` | bar `h-8`, tab `h-6` | pill `bg-hover` | **buttons are `role="tab"` with no `tablist` parent** | no |
| terminals | `TerminalPanel.tsx:520-534` | bar `h-8`, tab `h-6` | pill | yes | no |
| scripts pre/post | `ScriptsPanel.tsx:107-113` | vertical | `bg-accent/10 text-accent` | yes | no |
| sidebar panes | `SidebarShell.tsx:31-47` | `h-7` | `bg-bg shadow-sm border` | yes | no |
| mode switches | `Segmented` `ui.tsx:540` | `py-1` | `bg-accent/15` | radiogroup | native |

### C1. Three hand-made pill tab strips (P1)

`Shell.tsx:282`, `TerminalPanel.tsx:522-537` and `ScriptsPanel.tsx:109` each draw their own tab button with its own
active classes (`bg-hover text-fg` / `bg-hover text-fg` / `bg-accent/10 text-accent font-medium`). The
`uniform-segmented` test's regex (`<div className="flex rounded-md border border-line overflow-hidden…`) does not match
them. Owner: `Tabs` with a `variant="pill"` (or `Segmented`, for the bottom panel: it is a choice of one of four).
Guard: extend `tests/unit/uniform-segmented.test.ts`: a `role="tab"` attribute may appear only in `ui.tsx`,
`DocTabStrip.tsx` and `SidebarShell.tsx`.

### C2. `Tabs` has no accessible name and no arrow keys (P1)

`ui.tsx:208`: the props are `tabs, value, onChange, className, right`: no `label`, so all 26 strips are unnamed
tablists (`DocTabStrip` and `SidebarShell` take a `label`). `onClick` only (`:261`): no ←/→/Home/End, the WAI-ARIA tabs
pattern every other tablist in the app also lacks. Owner: `Tabs` gets `label: string` (required) and a `keys` handler
shared with `DocTabStrip` (`lib/key-commands.ts`). Guard: a unit test that every `<Tabs` tag in `views/**` and
`components/**` has `label=` (same scanner as `empty-states.test.ts`).

---

## D. Toolbars, filter bars and count rows

### D1. Filter inputs: three heights, half without a name (P1)

Heights: `h-6 min-h-6 text-xs` (`views/McpView.tsx:594`, `views/GraphQLView.tsx:675`, `views/WebSocketView.tsx:634`,
`components/ConsolePanel.tsx:106`, `components/JsonView.tsx:399`, `components/EvalMatrix.tsx:371`,
`components/debugger/ExchangePanes.tsx:240`), `h-7 min-h-7 text-sm` (`views/TestsView.tsx:737`,
`views/TestsRunsList.tsx:38`, `components/Explorer.tsx:688`, `components/SidebarPanes.tsx:30,113`,
`components/mcp/ToolsPanel.tsx:102`, `components/JsonTable.tsx:81`, `components/RunPanel.tsx:290`), and the default
field (`views/TracesView.tsx:139`, `views/HistoryView.tsx:226`, `components/rag/RagMetricMatrix.tsx:323`).
`styles.css:380` already defines `.field.field-sm` (24 px) but only `WebSocketView.tsx:634` and `SseEvents.tsx:68`
use it; the others hand-write `h-6 min-h-6`.

No `aria-label` (placeholder only): `TracesView.tsx:139`, `HistoryView.tsx:226`, `McpView.tsx:594`,
`GraphQLView.tsx:675`, `WebSocketView.tsx:634`, `JsonTable.tsx:81`, `ToolsPanel.tsx:102`, `SidebarPanes.tsx:30`,
`SidebarPanes.tsx:113`, `RunPanel.tsx:290`, `JsonView.tsx:400`. The other half has one.

Owner: a `FilterInput` in `ui.tsx` (`size: 'sm' | 'md'`, `label` required, the search icon, Esc clears) used by
every list bar, and `OutputToolbar`'s `filter` slot for output bars. Guard: unit test: every `placeholder="Filter…"` /
`"Search…"` / `"Find…"` input is a `<FilterInput` (or has `aria-label=`), and no `h-6 min-h-6` literal on an `<Input`.

### D2. Select-as-filter vs Segmented vs checkbox for the same choice (P2)

"Only the failed ones": `views/HistoryView.tsx:235-237` and `views/TracesView.tsx:146-148` are a native
`<input type="checkbox">` with the words "Failed" / "Errors"; `components/ConsolePanel.tsx:95-105` is a `Segmented`
All / Errors / With logs; `views/DebuggerView.tsx:697-704` a `Select` Any status / 2xx … / Errors. Native checkboxes
appear 43 times in views and components while `Toggle` exists (`ui.tsx:191`); the checkbox has no shared look (the
native box). Owner: `Segmented` for ≤ 4 exclusive values, `Toggle` for a boolean; `Select` only for a long list.
Guard: grep test counting `type="checkbox"` outside form dialogs must not grow (a shrinking allow-list by file).

### D3. Count rows: `plural()` vs hand-rolled plurals (P2)

`views/HistoryView.tsx:253`: `{total.toLocaleString()} {total === 1 ? 'entry' : 'entries'}`;
`components/ai/ProposalReview.tsx:177`: `{proposal.items.length} item{proposal.items.length === 1 ? '' : 's'}`;
`components/AssistantPanel.tsx:332` and `components/ExportBundleDialog.tsx:171` the same by hand. Everything else
uses `plural()` (`lib/format.ts:1`, from `@testpion/shared`; 60+ call sites). Owner: `plural(n, 'entry', 'entries')`.
Guard: grep test `=== 1 ? '' : 's'` and `=== 1 ? '…' : '…ies'` appear nowhere under `apps/desktop/src`.

### D4. A native `<select>` inside an output bar (P2)

`components/Shell.tsx:330` (AppLogs): `<select className="bg-transparent" …>` while every other bar uses the shared
`Select` (`ui.tsx:160`, `.field` look). Owner: `Select className="field-sm"`. Guard: grep test `<select ` appears
only in `ui.tsx`.

---

## E. Copy controls

The shared control is `OutputActions` → `OutputDownload` (`components/output/OutputDownload.tsx:149`: an `IconButton
label="Copy {what}"` with `data-output-copy`, then Download, then ▾ with Copy as ▸). It is in 36 files. These copy
buttons are private:

### E1. Four feedback mechanisms for "copied" (P1)

- toast "Copied the …" via `copyText` (`lib/clipboard.ts:5`): `JsonView.tsx:418` (`IconButton label="Copy"`),
  `mcp/ToolsetEditor.tsx:284`, `VarInput.tsx:299`, `RecordDialog.tsx:79`, `DebuggerTools.tsx:107,230,241,490`,
  `debugger/ExchangePanes.tsx:70,242`, `GitCodeownersDialog.tsx:58`, `DebuggerView.tsx:449`;
- a tick for 1.2-1.5 s via `useCopied` (`lib/clipboard.ts:16`): `TraceView.tsx:206-234` (PayloadBox's own
  `<button aria-label="Copy the …" className="p-1 rounded …">`), `AgentsPanel.tsx:157-159` ("Copied" label swap),
  `CiDialog.tsx:142-144` ("Copied" label swap);
- a DOM-built button that rewrites its own `textContent` to "Copied" (`AssistantPanel.tsx:385-394`), with
  `navigator.clipboard.writeText` directly, no error toast;
- bare `navigator.clipboard.writeText` with no feedback at all: `views/GraphQLView.tsx:137`, `FeedbackDialog.tsx:93`,
  `FlowDeploy.tsx:74`, `RecordDialog.tsx:42`, `lib/request-copy.tsx:22`.

Owner: `copyText` for every copy (one toast), `OutputActions` for every pane that shows a body (TraceView's
PayloadBox header `:213-237` should be an `OutputHeader` with `spec` = the payload, like the span tabs `:130` already
are). Guard: grep test `navigator.clipboard.writeText` appears only in `lib/clipboard.ts` and
`components/output/output-core.ts`; `useCopied` has no importer outside `ui.tsx` (or is deleted).

### E2. Icon-only `Button`s with `title` and no accessible name (P1)

`components/DebuggerTools.tsx:107`, `:230`, `:241`: `<Button size="sm" variant="ghost" icon={<Copy size={12} />} …
title="Copy" />` with no children and no `aria-label`: nameless for a screen reader and no tooltip (Button has no
Tooltip; `IconButton` has both). Owner: `IconButton label="Copy the line"`. Guard: unit test: a `<Button` whose tag
ends in `/>` (no children) must carry `aria-label=`.

---

## F. Loading, empty and error states

### F1. Loading: Empty-with-a-title, a Spinner, or text (P1)

`views/TracesView.tsx:207` `<Empty title="Loading…" />`, `components/RunPanel.tsx:486` `<Empty title="Loading…" />`,
`components/RunCharts.tsx:203` `<Empty title="Loading…" />`, `components/DebuggerRules.tsx:517` `<Empty
title="Comparing…" />`: an empty-state card, in `text-fg font-semibold text-[1.05rem]`, for a wait. Elsewhere a wait
is `<Spinner />` in a centred box (`views/TestsView.tsx:985`, `Shell.tsx:295`), or the text `Loading…`
(`components/EvalMatrix.tsx:172,391`), or `Estimating …` (`views/EvaluationsView.tsx:92`), or the shared
`AiBusyLine` (`components/ai/ai-run.tsx:129`: Spinner + words + `role="status"`). Owner: `AiBusyLine` generalised to
`Busy` in `ui.tsx` (Spinner, words, `role="status"`), and `Empty` refusing a title that ends in `…`. Guard: grep test
`<Empty title="[^"]*…"` matches nothing; the string `'Loading…'` appears only inside `Busy`.

### F2. Empty text as a plain `<p>` / `<div>` instead of `Empty` (P2)

`views/GitView.tsx:485` `No commits yet.`, `views/MonitorsView.tsx:542` `No runs yet. …`,
`components/TraceView.tsx:153` `<div className="p-4 text-muted text-sm">Select a span</div>` (its twin
`views/McpView.tsx:626` is `<Empty title="Select an event" />`), `components/DebuggerTools.tsx:291` `No frames yet.`,
`components/CollectionOverview.tsx:211`, `components/CollectionTreeRows.tsx:305`, `components/FlowDesignerParts.tsx:370,418`,
`components/CookiesModal.tsx:131`, `components/MoveVariablesDialog.tsx:110`, `components/RunWithDataDialog.tsx:173`,
`components/RightPanel.tsx:179`, `components/ConsolePanel.tsx:132`. Some of these are rightly small (a one-line note
inside a form); the view-level ones (GitView, MonitorsView, TraceView, DebuggerTools) are not. Owner: `Empty` (with
`actions`, per WF-18). Guard: extend `empty-states.test.ts` MUST_ACT-style list with `No commits yet`, `No runs yet`,
`Select a span`, `No frames yet`.

### F3. Errors: inline red text, Callout, Callout+alert (P1)

Inline `text-bad` text with no role: `views/SettingsView.tsx:410`, `views/MonitorsView.tsx:696` (in the footer),
`views/EvaluationsView.tsx:91`, `views/rest/EnvCompareDialog.tsx:95`, `components/CiDialog.tsx:329`,
`components/EnvCompare.tsx:105`, `components/EvalMatrix.tsx:394`, `components/DebuggerRules.tsx:517`,
`components/WorkspaceMenu.tsx:319`. `Callout tone="bad"` without `role="alert"`: `CreateFlowDialog.tsx:101`,
`ExportBundleDialog.tsx:162`, the RAG dialogs (`RagCaptureDialog:220`, `RagCalibration:241`, `RagConnectDialog:306`,
`RagTestsetDialog:228,245`, `RagEstimateDialog:68`, `RagTryDialog:224`, `RagResultViews:145,333`).
`Callout tone="bad" role="alert"`: `ai/ai-run.tsx:139` (`AiErrorPanel`), `GitFixDialog.tsx:96`,
`GitItemHistoryBody.tsx:39`, `GitSecretsPanel.tsx:73`, `AskSearchDialog.tsx:358`. `views/McpView.tsx:592` has its own
`ErrorPanel`; `views/GraphQLView.tsx:576` another `ErrorPanel` (from `Results.tsx:97`, a Callout block).
A dialog footer should use `FooterHint` (`ui.tsx:464`, `role="status"`) for the reason a button is disabled, and a
`Problem` for an error after a try.

Owner: one `Problem` (= `Callout tone="bad" block role="alert"`, what `AiErrorPanel` is minus the AI setup action),
exported from `ui.tsx`. Guard: grep test: `className="text-sm text-bad"` / `text-xs text-bad` on a `div`/`p`/`span`
that renders `{error}` must not exist; `<Callout tone="bad"` must carry `role="alert"` (or be `<Problem`).

---

## G. Header rows, section titles and heights

### G1. Bar heights: h-7, h-8, h-9, h-10, h-11, h-12 (P1)

The one-line header of a pane (`flex items-center … border-b border-line`):

- `h-7`: `components/ProblemsPanel.tsx:37`, `components/Shell.tsx:325` (AppLogs), `components/debugger/DebuggerGrid.tsx:358`
- `h-8`: `components/ConsolePanel.tsx:93`, `components/TerminalPanel.tsx:518`, `components/Shell.tsx:280` (bottom tabs),
  `components/PinnablePanel.tsx:216`, `components/FlowRunDock.tsx:17`, `components/ResponseDiffPanel.tsx:68`,
  `components/TraceView.tsx:213`, `components/debugger/ExchangePanes.tsx:238`, `views/GraphQLView.tsx:490,627`,
  `views/TestsView.tsx:991`
- `h-9`: `components/output/OutputFrame.tsx:66` (**OutputHeader, the declared one**), `components/ResponseViewer.tsx:156`,
  `components/TraceView.tsx:76`, `components/DocTabStrip.tsx:210`, `components/ExamplesPanel.tsx:86`,
  `components/ResponseHistory.tsx:165`, `components/CollectionRunner.tsx:452`, `components/mcp/McpPanels.tsx:312`,
  `components/CookiesModal.tsx:109`, `views/McpView.tsx:593`, `views/GrpcView.tsx:400,550`, `views/GraphQLView.tsx:579`
- `h-10`: `ui.tsx:244` (Tabs), `components/Explorer.tsx:659`, `views/HistoryView.tsx:344,359`,
  `components/AssistantPanel.tsx:153`, `components/CollectionDocs.tsx:43`, `components/mcp/ToolsPanel.tsx:122`,
  `components/mcp/ToolsetEditor.tsx:406`, `views/GrpcView.tsx:449`
- `h-11`: `views/CollectionsView.tsx:245`, `components/FlowCanvasParts.tsx:331`
- `h-12`: `components/Shell.tsx:113` (top bar), `views/HomeView.tsx:133` (Card header), `components/AttentionCard.tsx:20`

The four panels of the bottom dock have three heights: Problems `h-7`, Logs `h-7`, Console `h-8`, Terminal `h-8`,
while the strip above them is `h-8` with `h-6` pills. Switching Problems → Console moves the content edge by 4 px.

Owner: `OutputHeader` (`h-9`) for every output pane, `Tabs` (`h-10`) for every tab bar, and two tokens
`--bar-h` / `--bar-h-sm` in `styles.css` for the rest. Guard: grep test: `h-(7|8|9|10|11|12)\b.*border-b border-line`
on a `div` is allowed only in `ui.tsx`, `OutputFrame.tsx`, `DocTabStrip.tsx`, `Shell.tsx:113`; everything else uses
`OutputHeader` / `Tabs` / a `Bar` component.

### G2. Section titles: `SectionTitle` vs 30 hand-written uppercase labels (P2)

`SectionTitle` (`ui.tsx:585`: `h-10 px-3 text-[0.72rem] uppercase tracking-[0.08em] text-muted font-semibold`). Hand
written: `views/MonitorsView.tsx:502` (`text-xs font-medium … tracking-wide`, the only `font-medium`),
`views/DebuggerView.tsx:905,915,937,958`, `views/GraphQLView.tsx:627` (`tracking-wider`), `components/Results.tsx:113`
(`tracking-wider`), `components/charts.tsx:43`, `components/DebuggerTools.tsx:102,229,240,374`,
`components/DebuggerRules.tsx:219,329`, `components/debugger/CreateFlowDialog.tsx:110,139,160`,
`components/debugger/DockInsights.tsx:368`, `components/debugger/ExchangePanes.tsx:320`,
`components/FlowDesignerParts.tsx:642`, `components/ProblemList.tsx:57`, `components/KeyboardSettings.tsx:125`,
`components/RunsOverview.tsx:195`, `views/HistoryView.tsx:278` (day header). Three letter-spacings (`0.08em`,
`tracking-wide`, `tracking-wider`), three sizes (`text-xs`, `text-[11px]`, `text-[0.7rem]`, `text-[0.72rem]`).
Owner: `SectionTitle` with a `size="sm"` (no height, for inside a card). Guard: grep test `uppercase tracking-` only
in `ui.tsx`.

---

## H. Labels and capitalisation

Sentence case is the rule (every `LABEL` in `lib/vocabulary.ts` is sentence case). Title case survives in:

### H1. Title-case strings a person reads (P1)

- `views/DebuggerView.tsx:674,680,686`: `<option value="">All Applications</option>`, `All Domains`, `All Types` next
  to `Any method` (`:692`) and `Any status` (`:698`) in the same bar; History says `All` (`:228`), Traces `All kinds`
  (`:141`).
- `views/rest/RequestEditor.tsx:61,65`: `Query Params`, `Path Variables` (section labels).
- `views/RestView.tsx:266` `label: 'Open Settings'`, `views/ai/Providers.tsx:144` `>Open Settings<`,
  `views/ai/common.tsx:250` `'Open Providers'`, `components/ApiPreviewPanel.tsx:126` `'Open Tests'` (the view names
  are `Settings`, `Providers`, `Tests`: sentence case would be "Open settings" only if the word is not the view's
  name; the owner should decide once and the test enforce it).
- `components/ScriptsPanel.tsx:153` `'Insert Snippet…'`, `components/debugger/DockRules.tsx:112-113` `'Filter Out'`,
  `'Capture Only'`, `components/debugger/DockInsights.tsx:92-102` `Selected Items`, `Total Time (sec)`,
  `Total Size (kb)` (Fiddler's words copied), `components/DebuggerTools.tsx:170,179` `'Hex Decode'`, `'Hex Encode'`.
  (`Claude Code`, `Azure Pipelines`, `Akamai EdgeGrid` are product names and fine.)

Owner: `lib/vocabulary.ts` (`LABEL`), and the filter bars' "All …" wording as one helper `allOf('applications')`.
Guard: extend `tests/unit/vocabulary.test.ts` with a sentence-case rule over `label: '…'`, `label="…"`,
`<option>…</option>` and `>Text<` literals: a second capitalised word that is not in an allow-list of proper nouns
(AI, API, CI, MCP, URL, JSON, HTTP, CLI, SSE, TLS, GraphQL, gRPC, WebSocket, OpenAPI, Postman, Bruno, Claude Code,
Azure Pipelines, …) fails.

### H2. The same action, two names in one view (P1)

`views/CollectionsView.tsx:187-189` (the collection row's Export) vs `:299-304` (the header's Export button):
`'as Postman collection v2.1'` / `'as Bruno collection folder…'` vs `'Postman collection v2.1'` / `'Bruno collection
folder…'`; the dialog `components/ExportDialogBody.tsx:17` says `'Bruno collection folder'` without the ellipsis.
And the header Export menu duplicates the collection's node menu's Export (`LABEL.exportSubmenu`,
`lib/node-menu.ts`), so a collection has two export menus with different item lists.

Owner: one `exportItems(collectionId)` in `lib/node-menu-actions.ts` used by the node menu, the header button and
the row. Guard: grep test that `'Postman collection v2.1'` (and each export label) appears once under `apps/desktop/src`.

### H3. "Delete" in six shapes (P2)

`LABEL.delete` is `'Delete…'` and `vocabulary.test.ts` only forbids `label: 'Delete', icon: <Trash2`. Still in use:
`views/MonitorsView.tsx:484` `'Delete monitor'` (PageHeader menu; the sidebar row of the same monitor says
`Delete…`), `views/TestsView.tsx:835` `label="Delete file"` (IconButton), `components/ExamplesPanel.tsx:118`
`"Delete example"`, `components/mcp/ToolsetEditor.tsx:479` `"Delete this response"`, `components/DebuggerRules.tsx:118`
`'Delete this profile'`, `components/FlowDesignerMenus.tsx:145,205` `'Delete connection'`, `'Delete note'`,
`views/CollectionsView.tsx:310-314` a red ghost `Button` in the header (text-only, no ellipsis). Owner: `LABEL.delete`
in menus; `IconButton label={LABEL.delete}` for a row action; the noun goes in the confirm dialog's title, not the
label. Guard: extend the vocabulary test: `label: 'Delete [a-z]` and `label="Delete [a-z]` fail outside an allow-list.

---

## I. Delete / rename affordances and ad-hoc menus

### I1. Where "delete the open item" lives differs per view (P1)

- Monitors: PageHeader ⋯ menu (`views/MonitorsView.tsx:484`), via `deleteWithUndo`.
- Collections: a red ghost `Button` in the header (`views/CollectionsView.tsx:310-331`), via `deleteWithUndo`.
- MCP servers: an ad-hoc `Menu` on an `IconButton label="More server actions"` (`views/McpView.tsx:348-360`,
  `LABEL.delete` → `removeCurrent()`); not the `MoreMenu` component (`ui.tsx:595`) though it is the same thing
  (`MoreHorizontal size={15}` here, `16` in MoreMenu).
- Environments: `MoreMenu` fed by `buildNodeMenu('environment', …)` (`views/EnvironmentsView.tsx:393-400`): the right
  model, the only view doing it.
- Load tests, Evaluations, Playground prompts, RAG targets: no delete in the editor at all; only the sidebar row's menu.
- Tests: `IconButton label="Delete file"` in the tree row's actions (`views/TestsView.tsx:835`).

Owner: `PageHeader menu={buildNodeMenu(kind, ctx)}` (what Environments does), for every item editor. Guard: a unit test
that every view with a `LibraryTabStrip` or `ItemBreadcrumb` also calls `buildNodeMenu(` for its header menu.

### I2. Ad-hoc `Menu items={[…]}` in views (P2)

`views/CollectionsView.tsx:284-305` (Tools, Export), `views/DebuggerView.tsx:483-488` (Flow), `:508-530` (HTTPS),
`:710-729` (Presets), `views/EnvironmentsView.tsx:385-388` (Export), `views/McpView.tsx:355-359`, `views/RestView.tsx:562`
(the method picker: a menu that is a `Select` in GraphQL/gRPC). These are not node menus so the vocabulary test is
silent, but their items are not in `LABEL` and their icons are chosen per call (`Download` for Export in Collections
and Environments, but `Send` for Postman). Owner: items declared next to `LABEL` (an `ACTION` table with icon + label),
`Menu` only assembling. Guard: `label: '` literals in `views/**` must reference `LABEL.` or an `ACTION.` entry
(allow-list the data-driven ones: method names, filter presets, branches).

### I3. Rename in place: TreeRowShell vs a `role="button"` span (P2)

`views/CollectionsView.tsx:250-260`: a `<span role="button" tabIndex={0} … cursor-text title="Double-click to rename"
onDoubleClick onKeyDown F2|Enter>` with `InlineRename` beside it, `w-72` fixed. Tabs do it in `DocTabStrip.tsx:261`,
rows in `TreeRowShell.tsx:167`. Owner: a `RenameableTitle` in `TreeParts.tsx` wrapping `InlineRename` (used by the
collection header, the environment header and PageHeader titles). Guard: grep test `cursor-text` appears only in
`TreeParts.tsx` and the flow note editor.

---

## J. Keyboard and accessibility

### J1. Lists without the shared keys (P1)

`treeKeys` (`components/TreeParts.tsx`, ↑/↓, Home/End, typeahead, ←/→) is attached in Environments, Providers,
Tests, History, TestsRunsList, the explorer, FolderList and CollectionVariablesPane. Missing on: Traces
(`views/TracesView.tsx:164-196`: `VirtualList` of buttons, Tab is the only way down the list), MCP protocol trace
(`views/McpView.tsx:605`), Collections list (`views/CollectionsView.tsx:221-227`), Git commits (`views/GitView.tsx:487`),
Trace spans (`components/TraceView.tsx:88-111`), Console entries. Owner: A1-A5 (TreeRowShell + `treeKeys` on the
container, `role="tree"` on the `VirtualList` as History does at `:272`). Guard: unit test: every `<VirtualList` whose
`render` returns a `TreeRowShell` has `role=` and `label=`; every `onKeyDown={treeKeys}` container has it.

### J2. Tablists without arrow keys and a bottom strip without a tablist (P1)

See C1/C2: `Shell.tsx:280` is a `div` with no `role="tablist"` around four `role="tab"` buttons (invalid ARIA: a
tab must be inside a tablist); none of the seven strips handle ←/→. Owner: `Tabs`. Guard: as C1/C2.

### J3. Dialogs (OK) and popovers (OK)

`Modal` (`ui.tsx:434`) is Radix: Esc, focus trap, click outside. The hand-rolled dialogs handle Esc themselves
(`Shell.tsx:439`, `:559`, `WorkspaceMenu.tsx:143`, `VarInput.tsx:232`); `EnvQuickLook` and `FlowDeploy` use Radix
Popover. No gap found; the `role="alertdialog"` confirm (`Shell.tsx:684`) is the one confirm (`store.ts:558`
`confirmAction`), `window.confirm` is not used anywhere.

### J4. Focus rings

`styles.css` applies `:focus-visible` globally (not re-verified per element); no component overrides `outline-none`
on a focusable without an alternative except `Shell.tsx:434` (the palette input, inside a bordered box: acceptable)
and `OutputHint` (`OutputToolbar.tsx:13`: `outline-none` with `focus-visible:text-fg` only, a colour change is a weak
ring on a 13 px icon). P2: give `OutputHint` the standard ring.

---

## K. Density and overflow

### K1. Header rows that can clip the `OutputActions` control (P1)

`views/McpView.tsx:593-597`: `<div className="flex items-center gap-2 px-2 h-9 border-b border-line text-xs">` with a
`w-48` Input, a count and `OutputActions`: no `min-w-0`, no `overflow-clip`, no `OutputBarStart`, so in a narrow
Split the control is pushed out of the bar (the exact case `OutputFrame.tsx:22-31` documents for other bars).
`views/MonitorsView.tsx:501-504` (`flex items-center gap-2 mb-1`) and `views/TracesView.tsx:155-162` (has `min-w-0`,
good) are the same row done three ways. Owner: `OutputHeader` (`OutputFrame.tsx:62`). Guard: grep test: a tag that
contains `<OutputActions` must be `OutputHeader`, `Tabs right=`, or carry `data-output-header` / `min-w-0 overflow-clip`.

### K2. Fixed widths that do not scale with density or font size (P2)

`components/TraceView.tsx:98` `w-[38%]` name column (long span names truncate at 38 % whatever the pane width;
the bars get 62 % even in a narrow pane); `views/McpView.tsx:598,610` `grid-cols-[70px_22px_1fr_80px_70px]` twice
(header and rows kept in sync by hand); `views/CollectionsView.tsx:247` `w-72` rename field, `:253` `max-w-[24rem]`
name; `views/HomeView.tsx:280` `max-w-[1400px]`; `components/ConsolePanel.tsx:142,150,151` `w-14`/`w-16` columns.
`components/TraceView.tsx:83` hides the trace id below `xl` (`hidden xl:inline`), the only `hidden xl:` in the app;
elsewhere the rule is "truncate, full text in the tooltip". Owner: a `Columns` grid helper for the MCP trace (one
template string), `ch`-based or `min-w-0 flex-[2]` for TraceView, and `truncate` instead of `hidden xl:`. Guard: grep
test `hidden (sm|md|lg|xl):` appears nowhere under `views/**` (today `HomeView.tsx:457,490`, `TraceView.tsx:83`,
`CollectionOverview.tsx:269,274`, `MessageRate.tsx:41`, `Shell.tsx:138,153,161`).

### K3. Icon sizes (P2)

Histogram over views + components: `12` ×342, `13` ×320, `14` ×313, `16` ×76, `11` ×40, `18` ×35. Inside
`IconButton` alone: 12, 13, 14, 15, 16 (`McpView.tsx:351` 15, `ui.tsx:601` MoreMenu 16, `TracesView.tsx:151` 14,
`ConsolePanel.tsx:120` 13, `TerminalPanel.tsx:536` 11). `Button` already picks 12/13 from `size` (`ui.tsx:26`);
`IconButton` lets the caller choose. Owner: `IconButton` takes `icon` (like `Button`) and sizes it: 14 at `h-8`, 13 at
`h-7`, 12 at `h-6`. Guard: unit test: no `<IconButton …><X size={n}` child with `n` outside the component.

### K4. Text sizes (P2)

Arbitrary sizes in use: `text-[0.7rem]` ×30, `text-[11px]` ×29, `text-[10px]` ×17, `text-[0.72rem]` ×9,
`text-[0.82rem]` ×6, `text-[0.65rem]` ×6, plus `0.68rem`, `9.5px`, `0.78rem`, `0.8rem`, `0.75rem`, `0.6rem`, `0.64rem`,
`11.5px`, `13px`. `0.7rem` ≈ `11.2px` and `0.72rem` ≈ `11.5px` sit next to `11px` and `11.5px`: four spellings of one
size, and the px ones do not follow the font-size setting. Owner: two utilities in `styles.css` (`.text-2xs` = 0.72rem,
`.text-3xs` = 0.65rem). Guard: grep test `text-\[\d+(\.\d+)?px\]` appears nowhere under `apps/desktop/src`.

---

## Top 10, ranked

1. **B2** TraceView `KIND_COLORS` hex in both themes, off-palette vs `--k-*` (P1, visible in dark mode) — tokens;
   widen `no-hex-colours.test.ts` to JS string literals.
2. **A1 + J1** Traces list rows are hand-rolled next to History's `TreeRowShell` rows: no keys, no tree semantics, no
   drag (P1) — `TreeRowShell`; NODE_VIEWS must import it.
3. **B1** Two selected-row colours (`bg-accent-soft` vs `bg-accent/10`) across 8 files (P1) — row tokens; grep test.
4. **G1** Six header heights, three inside the bottom dock alone (P1) — `OutputHeader`/`Tabs`/bar tokens; grep test.
5. **C1 + C2 + J2** Three hand-made pill tab strips, `Tabs` has no `label` and no arrow keys, bottom strip has no
   `tablist` (P1) — `Tabs variant="pill" label=`; `role="tab"` only in three files.
6. **F3** Errors shown three ways, nine of them unannounced inline red text (P1) — `Problem` (Callout bad + alert).
7. **E1 + E2** Four copy-feedback mechanisms and nameless icon-only copy buttons (P1) — `copyText` + `OutputActions`;
   `clipboard.writeText` only in `lib/clipboard.ts`.
8. **D1** Filter inputs in three heights, eleven without an accessible name (P1) — `FilterInput`.
9. **I1 + H3** "Delete the open item" in six places and six labels (P1) — `PageHeader menu={buildNodeMenu(...)}` as
   Environments does; `LABEL.delete`.
10. **H1 + H2** Title-case strings (`All Applications`, `Query Params`, `Open Settings`) and one action named two ways
    in one view (Collections export) (P1) — `LABEL`; sentence-case rule in `vocabulary.test.ts`.

Then the P2 group in one pass each: B3 overlays, B4 dots, B5 kind labels, D3 plurals, D4 native select, F1 loading,
F2 plain empties, G2 section titles, I2 ad-hoc menus, I3 rename title, K1-K4 widths/icons/text sizes.
