# Master roadmap: one item-kind registry, then everything on top

Status: plan, 2026-10-17. Nothing in it is built. It merges seven plans into one sequence of releases that an engineer or
an agent can run release by release:

- `planning/menus-uniform.md` (the P0 ghost row, then `buildNodeMenu` / `NODE_KINDS`)
- `planning/export-import.md` (G1–G7, the bundle, `BUNDLE_KINDS`)
- `planning/git-everything.md` (every kind under git, the core kind registry)
- `planning/import-compat.md` (IMP-1xx/2xx, `ImportDocument`)
- `planning/ai-features.md` (what is left: AI-4, AI-6, AI-8, AI-9, AI-10, AI-11, AI-12, and the leftovers of AIB-1/6/9/10)
- `planning/rag-testing.md` (RAG-1 … R4)
- `planning/workflow-ux.md` (the leftovers in files other agents had open)

It also follows the memory notes `ui-gap-hunt`, `next-ai-flow-from-collection`, `uniform-ui`, `quality-bar`,
`cloud-ready-design` and `cloud-last`.

Owner instruction: *"considering all the things, do make the changes"*. That means build all of it as one coherent
system, not as four registries and three import paths.

Starting point: v0.48.1 is released. **v0.49.0 (AI release 2a: triage, flaky analysis, script reference) is being
finished by another agent now.** This plan starts after 0.49.0 ships. Line numbers are from the tree on 2026-10-17;
the ones in §1.7 were re-checked against the code for this plan.

---

## 0. Executive summary (one page)

### 0.1 Release table

An agent-day is one agent working one day. Wall time assumes the parallel lanes in §3, plus about 2 days per release
for the release process.

| Release | Headline | Items (ids from the plans) | Estimate |
|---|---|---|---|
| **0.50** | Nothing lost, nothing leaked | MENU-P0 ghost row; fixes from the UI audit after 0.49; EX-G1, G2, G3, G5, G6 (spec, MCP server); IMP-FIX-1 Postman auth never `inherit`; IMP-FIX-2 Insomnia template tags and v5 scripts; IMP-FIX-3 Bruno `tp.*` lines and `.env`; IMP-FIX-4 GraphQL SDL; SEC-1 one shared secret detector; make-room splits | 9 agent-days, about 1.5 weeks |
| **0.51** | Integration testing, finished | AI-4 (+ "From a spec" source), AI-10 Tidy with AI, FL-1…FL-8 flow leftovers incl. the dataset-driven Flow view edit bug, WFL-1…WFL-9 workflow-ux leftovers in TestsView / RunPanel / FlowDesigner / Shell | 10 agent-days, about 1.5–2 weeks |
| **0.52** | One registry, one menu | REG-1…REG-6 (registry in adapter mode, no behaviour change), MENU-1…MENU-3 (`buildNodeMenu`, Expand/Collapse everywhere, every list), dataset folders, make-room (rpc-params, MCP tool index) | 11 agent-days, about 2 weeks |
| **0.53** | Export and import anything | EX-A2…EX-A5 (per-kind Export… / Import…, bundle v1, simple preview, undo, CLI, `workspace import` = G7 part), the rest of the trash kinds, stdio servers imported disabled, MENU-4 (keys, multi-select, `menus --json`) | 10 agent-days, about 2 weeks |
| **0.54** | Everything it uses | EX-B1…EX-B6 (dependency-aware ExportDialog, full conflict engine with Merge, Requires panel, drag-and-drop of bundles, MCP bundle tools, Postman zip and Bruno folder with extras, `describe_bundle`), G4 import into this workspace | 9 agent-days, about 1.5–2 weeks |
| **0.55** | Switch from Postman, Insomnia or Bruno (import-compat A1) | IMP-101…IMP-105, IMP-108, IMP-113 (part 1), D7 "Migrate from…", foreign formats through the one preview, legacy writer removed | 10 agent-days, about 2 weeks |
| **0.56** | Scripts and auth that just work (import-compat A2) | IMP-106 (AST converter, `tp.execution.runRequest`), IMP-107, IMP-109, IMP-110 (EdgeGrid, Hawk, NTLM), IMP-111, IMP-112, IMP-113 (part 2), IMP-114; IMP-205 Postman key as a stretch item | 11 agent-days, about 2 weeks |
| **0.57** | Everything under git (1) | GE-A1…GE-A6: git layer driven by the registry, stable serializers, per-kind diff and rows, ChangeMark everywhere, generated `.gitattributes`, the gap matrix made strict | 9 agent-days, about 1.5–2 weeks |
| **0.58** | Everything under git (2) | GE-B1…GE-B5 (history / restore / discard / stage by item, conflicts for every kind, staged-blob secret scan, CLI/MCP), GE-C1, GE-C2 (Fix git setup, textconv, LFS at 50 MB, track by reference, Share session) | 11 agent-days, about 2 weeks |
| **0.59** | Security, drift, scripts | AI-8, AI-9, AI-6, AIB-10 (the "… with AI" registry and a setting that hides AI), AIB-6 month-to-date, AIB-9 goldens + `npm run ai-evals`; AI-12 as a stretch item | 10 agent-days, about 2 weeks |
| **0.60** | RAG R1a: connect and measure for free | RAG-1, RAG-2, RAG-3, RAG-5, RAG-5b, the free part of RAG-9, CLI/MCP part of RAG-10 | 12 agent-days, about 2 weeks |
| **0.61** | RAG R1b: judge the triad, custom metrics | RAG-4, RAG-6, RAG-6b, RAG-7, RAG-8, the rest of RAG-9 and RAG-10 | 12 agent-days, about 2 weeks |
| **0.62** | RAG R2: every LLM-judged metric | R2 scope of rag-testing §5 | 12 agent-days, about 2 weeks |
| **0.63** | RAG R3: conversations, agents, safety, images | R3 scope | 12 agent-days, about 2 weeks |
| **0.64** | RAG R4: generate, calibrate, operate | R4 scope + AI-11 | 10 agent-days, about 2 weeks |
| **0.65** | Refactor and cleanup (no features) | Remove the adapters and aliases, dedupe, split files near their caps, lower the ceilings, re-measure perf, leaks and soak | 8 agent-days, about 1.5 weeks |
| after | Backlog, then the cloud reminder | import-compat B (IMP-201…208), export C (`uses`), GE-C3 CODEOWNERS, AI-7, AI-13…15, local leftovers (http-debugger) | per owner |

Total: about 166 agent-days, which is 6–7 months at 2–3 parallel agents (the release process adds about 2 days of
wall time per release). The cut list in §5.2 says what goes first if
time is short.

### 0.2 The registry in 10 lines

1. One **kind id** per thing a user sees (`collection`, `request`, `mcp-server`, `spec`, `dataset`, `monitor`,
   `grpc-call` …). It is the ItemRef kind wherever one exists. The 30 kinds are listed in §1.5.
2. **The static half** is `packages/shared/src/item-kinds.ts` (`KIND_INFO`). It is browser-safe data: label, icon,
   ItemRef mapping, storage layout, folder model, the view that opens it, watch kinds, git merge mode, size policy, and
   a complete **capability map**.
3. **The engine half** is `packages/core/src/kinds/` (`registerKind`). Each kind file holds the facets: identity and
   listing, `resolve`, the canonical serializer, `describeChange` and `parts`, merge, secrets, `uses` (dependency
   edges) and `rewriteRefs`, bundle export/import, import mapping, and ops (rename, duplicate, move, remove/restore
   through the trash).
4. **The UI half** is `apps/desktop/src/lib/node-menu.ts`. `buildNodeMenu` reads the capabilities. Kind files under
   `lib/node-menu-kinds/` add only the items that belong to one kind. Section, folder and category nodes are generated
   from the kind, never hand-written.
5. **Every capability is declared** as `true`, `{ na: reason }` or `{ planned: '0.57' }`. A missing entry is a type
   error. A `planned` marker fails CI once that release is reached. A `true` without its implementation fails the
   completeness test.
6. **One answer per question.** `kindOfPath` (lexical, the same on every OS) replaces the path regexes in git, the
   watcher and `refOfWorkspacePath`. `kind.resolve` replaces the `item-refs.ts` switch. `KIND_INFO.opens` replaces the
   `ref-target.ts` tables. Labels come from `KIND_INFO`.
7. **One secret detector** (`packages/core/src/security/secrets.ts`): key-name rules plus value patterns. git check,
   the bundle export, `redactForAi` and the import report all use it. Each kind's `secrets.scan` says where to look.
8. **One transfer pipeline.** Foreign parsers produce an `ImportDocument`. It lowers to bundle entries, then goes to
   the one planner (preview, conflicts, remap), then to apply (one transaction, one undo journal, one
   `data.changed`).
9. **One merge function per strategy** (`by-id`, `fields`, `text`, `binary-ours`). The git merge driver, the
   conflict screen and the bundle's Merge choice all call it.
10. **Adapter first.** 0.52 makes today's tables derived from the registry, with snapshot tests that prove nothing
    changed. Features then move onto it release by release, and 0.65 deletes the shims.

### 0.3 The first three actions

1. **Confirm the ghost-row cause before writing the fix** (0.50, lane A). On the installed app, with a copy of the
   profile (memory `repro-installed-app.md`), run the menus-uniform repro and the discriminators:
   - `elementsFromPoint` and `querySelectorAll('[data-node-id=…]').length`;
   - a CDP screenshot compared with a desktop screenshot.

   This decides whether the cause is the drag image or duplicate keys. Both fixes ship anyway; the result decides
   which test must reproduce it.
2. **Make room and write the safety nets first** (0.50, day 1). None of this changes behaviour:
   - move `exportBundle`/`importBundle` out of `packages/core/src/storage/workspace.ts` (891 of 900 lines) into
     `storage/workspace-bundle.ts`;
   - move `VirtualList` out of `components/ui.tsx` (1,096 of 1,200) into `components/VirtualList.tsx`, re-exported;
   - write `packages/core/src/security/secrets.ts`, joining the key-name rules of `git-guard.ts` with the value
     patterns of `util/redact.ts`, with its fixtures.

   Every 0.50 lane builds on these.
3. **Start the three 0.50 lanes in parallel**, each owning its files (§3, release 0.50):
   - A: tree and drag;
   - B: export, trash and secrets;
   - C: importers.

   Freeze only after the UI-gap audit.

---

## 1. The shared foundation: one item-kind registry

### 1.1 What each plan proposed

| Plan | Name | Where | What it holds |
|---|---|---|---|
| menus-uniform §2 | `NODE_KINDS`, `buildNodeMenu` | `apps/desktop/src/lib/node-menu.ts` (UI) | capabilities `container, runnable, monitorable, ciRunnable, testable, flowable, linkable, renamable, duplicable, movable, deletable, favorite`; per-kind menu contributions; section, folder and category kinds |
| export-import §4.2 | `BUNDLE_KINDS`, `BundleKind` | `packages/core/src/bundle/kinds.ts` | `list, describe, dependencies, exportItems, identity, importItems, rewriteRefs`; kinds `collection, environment, spec, dataset, mcp-server, mcp-mock, test, library:<kind>, proto, script-package, provider` |
| git-everything §4a | `WorkspaceKind` | `packages/core/src/kinds/registry.ts` + `packages/shared/src/item-kinds.ts`, capabilities to the UI over RPC `kinds.list` | files/glob/layout, serializer, `items`, `refOf`, `describeChange`, `parts`, merge, secrets, size, capabilities `versioned, exportable, importable, restorable, trash`; kinds `saved:<kind>` |
| import-compat §4a | `ImportDocument` item kinds | `packages/core/src/import/map/` | `fromImport()` / `toExport()` per kind; request kinds by protocol |
| rag-testing §4c | `MetricDef` registry | `packages/core/src/eval/rag/metric-registry.ts` | metrics (not workspace items); custom metrics are workspace **files** (`metrics/*.yaml`); `library/rag-targets.json` |
| workflow-ux WF-02 | `refTarget`, `LIBRARY_VIEW` | `apps/desktop/src/lib/ref-target.ts` | "the one table of where a kind opens" |

### 1.2 Conflicts between the plans, and how this plan resolves them

| # | Conflict | Resolution |
|---|---|---|
| C1 | Three registries in three places (UI `NODE_KINDS`, core `BUNDLE_KINDS`, core `kinds/`) | **One registry with three halves.** Static data in `packages/shared/src/item-kinds.ts` (the renderer may import it: `@testpion/shared` is built for the browser, `architecture.test.ts:81`). Engine facets in `packages/core/src/kinds/`. UI contributions in `apps/desktop/src/lib/node-menu-kinds/`. `bundle/kinds.ts` becomes a filter over the registry (`kinds({ facet: 'bundle' })`). |
| C2 | git-everything wanted the UI to read capabilities over RPC (`kinds.list`) | Capabilities are **static**, so the UI imports them from shared: no round trip and no loading state for a menu. RPC `kinds.list` exists only for **workspace-dependent** facts (is this a git repo, is LFS on, which libraries exist) and for CLI/MCP. |
| C3 | Kind names: `saved:<kind>` (git), `library:<kind>` (export), `{kind:'saved', library}` (ItemRef), `prompt`/`load-test` (menus), `test-file`/`test-folder`/`history-entry` (menus) | **Canonical ids are nouns, equal to the ItemRef kind wherever one exists** (`request`, `collection`, `monitor`, `mcp-server`, `spec`, `dataset`, `test`, `flow`, `run`, `history` …). The `saved` ItemRef splits by library into `grpc-call`, `ws-connection`, `prompt`, `load-test`, `evaluation` and `rag-target`; the ItemRef wire format is unchanged (`savedItemRef(library, id)`). `library:<lib>`, `saved:<lib>`, `test-file` and `history-entry` are accepted as **aliases** in CLI flags, bundle manifests and MCP inputs. Folders, sections and categories are **node** kinds generated from an item kind (`folder:spec`, `section:mcp-server`), not item kinds. |
| C4 | Two preview/plan engines: the bundle's `bundle/plan.ts` and import-compat's `Planner → ImportPlan` | **One planner** (`packages/core/src/transfer/plan.ts`). Foreign parsers produce an `ImportDocument`, which `lowerToEntries()` turns into the same entry set a bundle reader yields. The preview, conflicts, remap, apply, undo and report are shared. A Postman file and a `.testpion.zip` open the same ImportDialog. |
| C5 | Two stores for reports: `.local/imports/<id>.json` (journal) and `.local/import-reports/<id>.json` | One folder per import: `.local/imports/<id>/journal.json` and `.local/imports/<id>/report.json`. "Undo import" and "Import report" read the same id. |
| C6 | CLI: `--on-conflict skip\|replace\|keep-both\|merge` (export) vs `--on-clash rename\|replace\|skip` (import) | `--on-conflict` with the bundle vocabulary (Keep both = rename). `--on-clash` and `rename` are accepted as aliases. |
| C7 | When `testpion import` previews: export says "preview when stdout is a TTY, refuse without `--apply` in `--json` mode"; import D5 says "preview by default for several files, a zip or a folder" | One rule. A **single foreign file** applies as today (backwards compatible) unless `--preview` is given. A **bundle, several files, a zip or a folder** previews by default and needs `--apply`. With `--json`, those inputs need an explicit `--preview` or `--apply`, so an agent must choose. |
| C8 | MCP: `import_definition {preview}` (import) vs `import_bundle_preview/apply` (export) | `import_preview` (any format, bundles included) returns a `planId`; `import_apply {planId, decisions}` (destructive, confirmed); `import_undo`; `get_import_report`; `export_bundle`; `export_collection {format}`; `describe_bundle`. `import_definition` stays as the one-shot convenience (back-compat) and is documented as such. |
| C9 | Menu groups: menus puts "History in git…" in `open`; git adds a `git` group; menus puts "Import config" in `tools` on `mcp-section`; export puts Import… in `create` | Group order `create · open · tree · run · share · tools · git · edit · danger`. The `git` group (History in git…, Compare with last commit, Discard changes…, Stage) moves "History in git…" out of `open`. **Import…** lives in `create` on containers; the config formats (`.mcp.json`, `claude_desktop_config.json`, `.vscode/mcp.json`) are choices inside the ImportDialog, not menu items. |
| C10 | Three secret detectors: `git-guard.ts` key names, `util/redact.ts` value patterns (AIB-2), export's planned `bundle/secrets.ts` | **One** `packages/core/src/security/secrets.ts` (built in 0.50). It has key-name rules, value patterns (JWT, Bearer/Basic, provider key prefixes, private keys, `user:pass@`, connection strings) and a confidence (`high` / `low`). `redactForAi`, `findCommittableSecrets`, the bundle strip pass and the import report call it. Each kind's `secrets.scan` only says where values live in that kind. |
| C11 | Dataset "reference mode" (bundle: path, size, sha256, columns, 20 sample rows) vs git "track by reference" (`datasets/<name>.ref.json`) | **One format**: `datasets/<name>.ref.json` `{ path \| url, sha256, bytes, columns, rows, sample[≤20] }`. A bundle in reference mode writes exactly this file, and git commits it. |
| C12 | Size thresholds 5 MB (git warn), 10 MB (bundle embed), 50 MB (git LFS offer, dataset edit limit), 100 MB (GitHub refuse) | One `size` facet with named thresholds: `gitWarnBytes`, `bundleEmbedBytes`, `gitLfsBytes`, `gitRefuseBytes`. All are settings with these defaults, and every surface reads the facet. |
| C13 | Undo after delete: UX-R5 restores some kinds in the UI by saving a snapshot again (`putBack`, MCP servers included); export G6 wants core trash for spec, mcp-server, library items, tests, mocks, protos | **Core trash for every kind whose storage is a file or an item in a file** (`trash` capability). The UI's Undo calls `trash.restore`, so the CLI, MCP and the cloud host can restore too. Nested nodes (requests, folders) keep the collection-snapshot undo (`{ na: 'restored from the collection snapshot by Undo' }`). |
| C14 | `data.changed` kinds: today 9 strings (`collections`, `mcp`, `specs`, `tests` …), datasets reported as `tests` by the watcher and as `datasets` by handlers; git wants canonical kinds | `KIND_INFO.watch = { legacy, canonical }`. From 0.52 the event carries **both** (`kinds: ['tests', 'dataset']`), so every listener keeps working. 0.57 moves the listeners to the canonical kinds, and 0.65 drops the legacy strings. |
| C15 | `.apsworkspace.json` → `*.testpion-workspace.json` (G5, now) vs `.testpion.zip` / `.testpion.json` (bundle, later) | Go straight to `<name>.testpion.json` in 0.50, so there is one rename instead of two. The content is still the legacy `testpion-workspace` shape until 0.53. The reader sniffs `format`, never the extension. |
| C16 | The bundle merges a collection "with the merge driver's logic, bundle as theirs, no base" | A `by-id` merge with `base = undefined` is defined: both-added items with different content become a conflict row, and nothing is ever deleted. It is the same function with the same tests (`git-merge.test.ts` gains the no-base cases). |
| C17 | menus-uniform lists `toolset` as a FolderList kind; toolsets are `mocks/*.mcp-mock.yaml` files edited in `ToolsetEditor`, with no list | Kind `mcp-mock`, with section `{ na: 'opened from its MCP server' }`, git `text`, export as a dependency of its server, and trash. |
| C18 | The ItemRef comment says `debugger/sessions/<name>.har`; the code writes `debugger/<name>.har` | The registry's `capture` storage is `debugger/<name>.har`; the ignore glob becomes `debugger/**/*.har`; the comment is fixed in 0.52. |
| C19 | rag-testing numbers its releases v0.49–v0.52; ai-features put AI-6 in its release 2 and AI-10 in release 3 | The owner's order wins: RAG is 0.60–0.64, AI-10 is 0.51 and AI-6 is 0.59. |
| C20 | import-compat says "export-import.md and git-everything.md do not exist yet" | Stale. Its §4a registry is the one in this plan, and its `fromImport`/`toExport` adapters are the import facet. |
| C21 | Datasets have no folders; menus decided "dataset folders" | **Virtual folders** in `library/dataset-folders.json`, the same as `spec-folders` and `mcp-folders`. Files never move, so `dataset:` paths in tests, bundles and git stay stable. |
| C22 | The dataset ItemRef is `{ name }` (the path under `datasets/`); the bundle id is a workspace-relative path | The registry id is the path under the kind's root (`datasets/x.csv` → id `x.csv`); `paths.pathOf(id)` gives the workspace path. Both forms parse. |

### 1.3 Where it lives, and who owns what

```
packages/shared/src/item-kinds.ts            KindId, Capability, CapabilityState, ItemKindInfo, KindStorage, KIND_INFO,
                                             kindOfRef, kindOfPath (lexical), kindAliases; no fs, no Node
packages/core/src/kinds/
  types.ts                                   ItemKindDef<T> and its facets (below)
  registry.ts                                registerKind, kind, kinds({facet, capability}), kindForPath, completeness()
  paths.ts                                   kindPath(kind, rel): the lexical check of storage/test-path.ts, generalised to every root
  collection.ts folder.ts request.ts         one file per kind (≤ 250 lines each); library kinds share library-kind.ts
  environment.ts workspace.ts test.ts spec.ts dataset.ts proto.ts script-package.ts
  mcp-server.ts mcp-mock.ts provider.ts library-kind.ts (grpc-call, ws-connection, prompt, load-test, evaluation, monitor, rag-target)
  metric.ts (0.61) debugger-rules.ts capture.ts records.ts (run, history, trace, exchange, proposal, baseline) ref-only.ts
  index.ts                                   registers all; imported once by the engine context
packages/core/src/security/secrets.ts         the one detector (C10)
packages/core/src/transfer/                   plan.ts (one planner), apply.ts, journal.ts, remap.ts, graph.ts (uses closure)
packages/core/src/bundle/                     write.ts, read.ts, schema, legacy.ts, limits.ts (format only)
packages/core/src/import/doc/                 ImportDocument types, lower.ts; map/ (auth, body, templates, settings, examples, vars, scripts)
apps/desktop/src/lib/node-menu.ts             MENU_GROUPS, buildNodeMenu, nodeMenuShape
apps/desktop/src/lib/node-menu-kinds/*.ts     per-family UI contributions (collection, library, explorer sections, tests, records)
apps/desktop/src/lib/tree-state.ts            useTreeOpen, setSubtree
apps/desktop/src/components/TreeRowShell.tsx  the one row: ⋯, right-click, keys, rename, drag source, drop target, ChangeMark slot
```

Ownership rules (they keep layers and agents apart):

- **Shared** owns names, labels, icons, storage layout, capabilities and path classification. It has no behaviour that
  needs a store.
- **Core kind files** own everything that reads or writes a kind's data. No other module may branch on a kind or match
  a kind's path, except through `kind(…)`. This is enforced by the grep test in §1.9 once the adapters are gone.
- **The UI** owns only menu items and view routing payloads. A view never re-derives a capability.
- `MetricDef` (RAG) stays its own registry: metrics are computations, not workspace items. The **custom metric file**
  is an item kind (`metric`), so it gets git, export, trash and menus like everything else.

### 1.4 The interface

```ts
// packages/shared/src/item-kinds.ts — browser-safe, data only

export type KindId =
  // collections and what they hold
  | 'collection' | 'folder' | 'request'                       // request variants: http, soap, graphql (protocol)
  | 'grpc-call' | 'ws-connection'                              // library/grpc.json, library/websocket.json (+ MQTT, Kafka, Socket.IO)
  // workspace files
  | 'environment' | 'workspace' | 'test' | 'flow'              // flow = variantOf 'test'
  | 'spec' | 'dataset' | 'proto' | 'script-package'
  | 'mcp-server' | 'mcp-mock' | 'provider'
  | 'prompt' | 'load-test' | 'evaluation' | 'monitor' | 'rag-target'
  | 'metric' | 'debugger-rules' | 'capture' | 'baseline'
  // records (not workspace files)
  | 'run' | 'history' | 'trace' | 'exchange' | 'proposal'
  // ref-only (addressable, no storage of their own)
  | 'variable' | 'test-case' | 'certificate' | 'git-file' | 'doc' | 'mock';

export type Capability =
  | 'open' | 'open-new-tab' | 'link' | 'container' | 'rename' | 'duplicate' | 'move' | 'favorite' | 'delete' | 'trash'
  | 'run' | 'monitor' | 'ci' | 'test-file' | 'flow' | 'ai'
  | 'export' | 'import' | 'uses'
  | 'versioned' | 'git-history' | 'git-discard' | 'git-stage'
  | 'secret-scan' | 'watch' | 'search';

/** true = supported and implemented; na = never applies (the reason is shown in docs and the report); planned = not yet, fails CI from that release on. */
export type CapabilityState = true | { na: string } | { planned: `0.${number}` };

export type KindStorage =
  | { layout: 'file-per-item'; dir: string; ext: readonly string[] }         // collections/<id>.json, environments/<id>.json
  | { layout: 'nested'; in: KindId }                                          // folder, request inside a collection file
  | { layout: 'items-in-file'; file: string; key: string }                    // mcp-servers.json servers[], providers.json providers[]
  | { layout: 'library'; library: string }                                   // library/<library>.json { folders, items }
  | { layout: 'raw-document'; dir: string; glob: string; binary?: string }    // specs/, datasets/, protos/, packages/, mocks/, metrics/
  | { layout: 'single-file'; file: string }                                   // workspace.json, debugger/rules.json
  | { layout: 'record'; where: 'meta' | 'runs' | 'traces' | 'local' | 'memory' }
  | { layout: 'ref-only' };

export interface ItemKindInfo {
  id: KindId;
  ref: ItemKind;                       // the ItemRef kind ('saved' for library kinds)
  library?: string;                    // for ref 'saved' and library storage: 'grpc', 'ai-prompts' …
  variantOf?: KindId;                  // flow → test
  aliases: readonly string[];          // 'library:grpc', 'saved:grpc', 'test-file' …
  label: string; plural: string; icon: string; searchLabel?: string;   // replaces ITEM_KIND_LABEL, LIBRARY_LABEL, search.ts labels
  storage: KindStorage;
  folders: 'nodes' | 'dirs' | { virtual: string } | 'none';            // virtual: library holding folder names (spec-folders …)
  parent?: KindId;                     // folder/request → collection; grpc-call → collection (optional link)
  opens: { view: string } | { dialog: string } | 'external' | 'none';  // ref-target.ts reads it
  watch: { legacy: string; canonical: string } | 'none';
  git: { merge: 'by-id' | 'fields' | 'text' | 'binary-ours' | 'none'; ignored?: boolean; textconv?: boolean };
  size?: { gitWarnBytes?: number; bundleEmbedBytes?: number; gitLfsBytes?: number; gitRefuseBytes?: number };
  bundle?: { dir: string; defaultSelected: boolean; modes?: readonly ('embed' | 'reference')[] };
  capabilities: Readonly<Record<Capability, CapabilityState>>;
}

export const KIND_INFO: Readonly<Record<KindId, ItemKindInfo>>;
export function kindOfRef(ref: ItemRef): ItemKindInfo;                       // 'saved' → by library
export function kindOfPath(path: string): { kind: KindId; id?: string } | undefined;   // lexical; `/` and `\` alike
```

```ts
// packages/core/src/kinds/types.ts — engine facets (Node; host-agnostic: storage only through WorkspaceStore / MetaStore / SecretStore)

export interface ItemKindDef<T = unknown> {
  info: ItemKindInfo;

  // identity and listing (every kind with storage)
  list(store: WorkspaceStore, opts?: { folder?: string; parentId?: string }): ItemSummary[];   // id, name, folder, path, size, parentId
  read?(store: WorkspaceStore, id: string): T | undefined;
  resolve(store: WorkspaceStore, ref: ItemRef): RefResolution;                  // replaces the item-refs.ts switch
  refOf(id: string, sub?: { itemId?: string; step?: string }): ItemRef;
  paths?: { pathOf(id: string): string; idOfPath(path: string): string | undefined };  // via kinds/paths.ts (lexical)

  // storage and change (versioned kinds)
  serializer?: { read(text: string): T; write(value: T): string };              // canonical; absent = raw document, never rewritten
  items?(file: unknown): Array<{ id: string; name: string; value: unknown; folder?: string }>;  // items-in-file, library, collection
  change?: { describe(before?: unknown, after?: unknown): string[]; parts?(item: unknown): Record<string, string> };
  merge?(base: string | undefined, ours: string, theirs: string, res: MergeResolutions): MergeResult | undefined;

  // safety
  secrets?: { scan(value: T, at: string): SecretFinding[]; fix?(value: T, f: SecretFinding[], ctx: SecretFixContext): Promise<T> };

  // dependencies
  uses?(store: WorkspaceStore, id: string): Edge[];                              // { to: ItemRef | { kind, name }, via }
  rewriteRefs?(value: T, remap: Remap): T;

  // transfer
  bundle?: {
    exportEntries(store: WorkspaceStore, ids: string[], ctx: ExportCtx): AsyncIterable<BundleEntry>;  // secrets stripped (ctx.report)
    identity(entry: BundleEntry): { id: string; name: string; hash: string };   // normalised hash: secrets blanked, canonical form
    importEntries(store: WorkspaceStore, entries: BundleEntry[], plan: PlanRows, remap: Remap): Promise<Applied[]>;
  };
  importMap?: { fromImport(item: ImportItem, ctx: MapContext): T; toExport?(value: T, ctx: ExportMapContext): ExportItem };

  // lifecycle (one implementation for UI, CLI, MCP and the cloud host)
  ops?: {
    rename?(store: WorkspaceStore, id: string, name: string): Promise<void>;
    duplicate?(store: WorkspaceStore, id: string): Promise<string>;
    move?(store: WorkspaceStore, id: string, folder: string): Promise<void>;
    remove(store: WorkspaceStore, id: string): Promise<TrashRecord>;              // through trash when info.capabilities.trash === true
    restore(store: WorkspaceStore, rec: TrashRecord): Promise<void>;
  };
}
```

```ts
// apps/desktop/src/lib/node-menu.ts — UI half
export const MENU_GROUPS = ['create', 'open', 'tree', 'run', 'share', 'tools', 'git', 'edit', 'danger'] as const;
export type NodeKind = KindId | `section:${KindId}` | `folder:${KindId}` | 'category' | 'selection';
export interface NodeKindUi { kind: NodeKind; contribute?: Partial<Record<(typeof MENU_GROUPS)[number], (n: TreeNode, c: MenuCtx) => MenuItem[]>> }
export function buildNodeMenu(node: TreeNode, ctx: MenuCtx): MenuItem[];   // pure; shared groups come from KIND_INFO capabilities
export function nodeMenuShape(kind: NodeKind): string[][];                 // for tests, docs, `testpion menus --json`, MCP ui.menuShape
```

### 1.5 Every kind to register

The **Cap.** column shows the notable capability states; every kind declares all 27. **R** is the release where the
kind's last `planned` marker is cleared.

| Kind | ItemRef | Storage | Folders | Git merge | Export | Trash | Sidebar / view | Cap. notes | R |
|---|---|---|---|---|---|---|---|---|---|
| `collection` | collection | `collections/<id>.json` (canonical `collectionFileContent`) | nodes | by-id | yes | yes (today) | Collections | reference implementation | 0.52 |
| `folder` | folder | nested in collection | nodes | via collection | as a selection | na: collection snapshot Undo | Collections | container | 0.52 |
| `request` (http, soap, graphql) | request | nested | — | via collection | as a selection | na: snapshot Undo | Collections | favorite, run, monitor, ci, test-file, flow | 0.52 |
| `grpc-call` | saved/grpc | `library/grpc.json` (`collectionId`) | virtual (library folders) | by-id | yes (with protos) | 0.53 | in the collection tree | uses: proto, collection | 0.53 |
| `ws-connection` (WS, MQTT, Kafka, SIO) | saved/websocket | `library/websocket.json` | virtual | by-id | yes | 0.53 | in the collection tree | | 0.53 |
| `environment` | environment | `environments/<id>.json` | none | by-id (variables) | yes | yes | Environments | secret values never in the file | 0.57 |
| `workspace` (settings + workspace variables) | environment{scope:'workspace'} | `workspace.json` | none | fields (0.57) | in whole-workspace bundles | na: one per workspace | Environments ▸ Workspace | `updatedAt` leaves the file in 0.57 | 0.57 |
| `test` | test | `tests/**/*.{yaml,yml,json}` | dirs | text (designer writes canonical) | yes (+ datasets, specs, sub-flows, servers) | 0.53 | Tests | variants test file and suite | 0.53 |
| `flow` | flow | variant of `test` | dirs | text | yes | 0.53 | Tests (canvas) | `variantOf: test` | 0.53 |
| `spec` | spec | `specs/**` raw (+ `specs/asyncapi/`) | virtual `spec-folders` | text | yes (file or zip) | **0.50** (G6) | API definitions | rename/delete arrive in 0.52 (missing today) | 0.52 |
| `dataset` | dataset | `datasets/**` raw (CSV, JSON, JSONL, md, SQLite binary) | virtual `dataset-folders` (0.52) | text / binary-ours | yes: embed ≤ 10 MB / reference | yes (today) | Datasets | size facet; `.ref.json` | 0.58 |
| `proto` | git-file | `protos/**` raw | dirs | text | as a dependency of gRPC calls | 0.53 | na: opened from its gRPC call | | 0.53 |
| `script-package` | git-file | `packages/<name>.js` | none | text | as a dependency (`tp.require`) | na: deletion asks (kept question) | Settings | | 0.57 |
| `mcp-server` | mcp-server | `mcp-servers.json` `servers[]` | virtual `mcp-folders` | by-id (0.57) | yes + `.mcp.json` / Claude / VS Code | **0.50** (G6) | MCP servers | `disabled` flag (0.53); secrets in `env`/`headers` | 0.57 |
| `mcp-mock` (toolset / mock) | git-file | `mocks/*.mcp-mock.yaml` | none | text | as a dependency of its server | 0.53 | na: opened from its server | | 0.53 |
| `provider` | provider | `providers.json` `providers[]` | none | by-id (0.57) | opt-in (E5) | 0.53 | AI Lab ▸ Providers | key always a template | 0.57 |
| `prompt` | saved/ai-prompts | `library/ai-prompts.json` | virtual | by-id | yes | 0.53 | AI Lab ▸ Playground | | 0.53 |
| `load-test` | saved/load-tests | `library/load-tests.json` | virtual | by-id | yes (+ collection) | 0.53 | Load | | 0.53 |
| `evaluation` | saved/evaluations | `library/evaluations.json` | virtual | by-id | yes (+ dataset, prompt; rag-target from 0.60) | 0.53 | Evaluations | | 0.53 |
| `monitor` | monitor | `library/monitors.json` | virtual | by-id | yes (+ collection; environment by name) | 0.53 | Monitors | | 0.53 |
| `rag-target` | saved/rag-targets | `library/rag-targets.json` | virtual | by-id | yes (+ request) | yes | AI Lab ▸ RAG | registered on day one (0.60) | 0.60 |
| `metric` (custom RAG metric) | **new** `metric {metricId}` (0.61) | `metrics/*.yaml` raw | none | text | yes | yes | AI Lab ▸ RAG ▸ Metrics | `custom/<id>` namespace | 0.61 |
| `debugger-rules` | git-file | `debugger/rules.json` | none | by-id (0.57) | yes | na: edited in place | Debugger ▸ Rules | secrets scan (header rewrites) 0.58 | 0.58 |
| `capture` (Debugger session) | capture | `debugger/<name>.har`, ignored; `debugger/shared/*.har` tracked (0.58) | none | ignored / text for shared | HAR (exists) | na: sessions are local | Debugger session tabs | Share session (0.58) | 0.58 |
| `baseline` | — | `baselines/*.json`, ignored by decision | none | none | na | na | — | owner decision G-1 | 0.52 |
| `run` | run | `runs/<id>/` | none | none | na (report export exists) | na: Delete asks | Tests ▸ Runs | record | 0.52 |
| `history` | history | MetaStore | none | none | na (HAR export) | na | History | record | 0.52 |
| `trace` | trace | `traces/` | none | none | na | na | Traces | record | 0.52 |
| `exchange` | exchange | Debugger (memory / session) | none | none | na | na | Debugger | record | 0.52 |
| `proposal` | — | `.local/ai/proposals/<id>.json` | none | none | na | na: expires | review dialogs | record | 0.52 |
| `variable`, `test-case`, `certificate`, `git-file`, `doc`, `mock` | same | ref-only | — | — | na | na | per `opens` | addressable only | 0.52 |

Folder-only libraries (`mcp-folders`, `spec-folders`, the new `dataset-folders`, and the library folders inside
`library/*.json`) are **not kinds**. They are the `folders` facet of their kind. This also fixes the "Saved item"
title they get in the Git view today: `LIBRARY_LABEL` lacks them (git-everything §1 row 5).

### 1.6 Nodes that are not items

`buildNodeMenu` generates these from an item kind, so a new kind gets them for free:

- `section:<kind>`: the Explorer section header, a FolderList header, the Tests header.
  - Groups: **create** (New <noun>, New folder, Import…), **tree** (Expand all, Collapse all for the whole section),
    **tools** (kind-specific: Open MCP inspector, Lint all …).
  - The empty-area right-click opens this menu.
- `folder:<kind>`: every folder of every kind.
  - create: New <noun> here, New folder.
  - tree.
  - run: Run all, for kinds with `run`.
  - share: Export folder…
  - edit and danger: Rename folder, Duplicate folder, Move to…, Delete folder… (always with Undo).
- `category`: the protocol rows in a collection (REST, SOAP …): create, tree, Run collection.
- `selection`: several nodes (0.53). Delete N… (one Undo), Move N to…, Copy N links, Create test file from N…, Create
  flow from N…, Export N…

### 1.7 Migration: every table and switch to replace

The **Phase** column: **A** = adapter (0.52; same output, now derived from the registry), **M** = migrated with its
feature, **D** = deleted in 0.65.

| # | Today (file:line) | Replaced by | Release / phase |
|---|---|---|---|
| 1 | `packages/shared/src/item-ref.ts:56` `ITEM_REF_FIELDS` | stays (wire format); the completeness test checks every `ItemKind` has a registry kind | 0.52 test |
| 2 | `item-ref.ts:85` `ITEM_KIND_LABEL` | derived from `KIND_INFO.label` | 0.52 A |
| 3 | `item-ref.ts:112` `LIBRARY_LABEL` | derived; folder libraries are not labels (fixes "Saved item") | 0.52 A; the label fix is 0.57 M |
| 4 | `item-ref.ts:132` `refOfWorkspacePath` | `kindOfPath` (same results for tests/datasets/specs in 0.52; adds mcp-servers.json, providers.json, mocks, packages in 0.57) | 0.52 A, 0.57 M |
| 5 | `apps/desktop/src/lib/ref-target.ts:21,24` `PROTOCOL_VIEW`, `LIBRARY_VIEW`; `:27-83` `refTarget` switch | `KIND_INFO.opens` + one payload function per kind with special payloads (request, collection, environment, test, run) | 0.52 A |
| 6 | `packages/core/src/storage/item-refs.ts:106-208` `resolveItemRef` switch | `kind(ref).resolve` | 0.52 A |
| 7 | `packages/core/src/storage/search.ts:125` labels; the `libraryKinds()` loop | `KIND_INFO.searchLabel`; the `search` capability | 0.52 A |
| 8 | `packages/core/src/git/semantic.ts:16` `SemanticChange.kind`; `:34-43` `refOfChange`; `:52-73` `libraryChanges`; `:178-189`, `:233-239`, `:318`, `:339` path regexes | `kindForPath` + `kind.change.describe` + `kind.items`; `SemanticChange.kind` becomes `KindId` (old values kept as `group`) | 0.52 A (existing kinds), 0.57 M (new kinds) |
| 9 | `packages/core/src/git/git.ts:6` `MERGED_BY_MEANING` | `kinds().filter(k => k.info.git.merge === 'by-id' \|\| … 'fields')` | 0.57 M |
| 10 | `packages/core/src/git/merge.ts:178-185` shape dispatch in `mergeWorkspaceTexts` | dispatch by `kindForPath(path).merge` (the path is passed in) | 0.52 A (same three kinds), 0.57 M (MCP servers, providers, rules, workspace) |
| 11 | `packages/core/src/storage/git-files.ts:8-33` `GITIGNORE_LINES`, `GITATTRIBUTES_LINES` | generated from `KIND_INFO.git` | 0.57 M |
| 12 | `packages/core/src/storage/workspace-watcher.ts:20-35` `IGNORED_TOP`, `changeKind` | `kindOfPath` + `watch.legacy` (0.52), `watch.canonical` added (0.57) | 0.52 A, 0.57 M, 0.65 D (legacy) |
| 13 | `apps/desktop/src/lib/data-changed.ts:8` `FileKind` | imported type from shared (`WatchKind`) | 0.52 A |
| 14 | `packages/core/src/storage/trash.ts:15` `TrashKind`, `:30` `DIRS` | table-driven in 0.50 (adds `spec`, `mcp-server`), then `kind.ops.remove/restore` | 0.50 M, 0.52 A, 0.53 M |
| 15 | `packages/core/src/storage/template-update.ts:40` `mergeKind` | registry | 0.57 M |
| 16 | `packages/core/src/storage/git-guard.ts:47-90` `findCommittableSecrets`, `:163` `fixCommittableSecrets` | `security/secrets.ts` (0.50), then per-kind `secrets` facets over staged blobs | 0.50 M, 0.58 M |
| 17 | `packages/core/src/storage/workspace.ts:570-597` `exportBundle`, `:600` `libraryKinds`, `:614-630` `WorkspaceBundle`, `:844-866` `importBundle` | moved to `storage/workspace-bundle.ts` (0.50, plus G1), then `bundle/` + `transfer/` over the registry; `exportBundle()` becomes "select everything" | 0.50 move, 0.53 M |
| 18 | `packages/core/src/runner/collection-realtime.ts:121` `COLLECTION_ITEM_KINDS` | `kinds().filter(k => k.info.parent === 'collection' && k.info.storage.layout === 'library')` | 0.52 A |
| 19 | `packages/core/src/import/workspace-import.ts:59-173` (writes straight to the store) | `transfer/apply.ts` | 0.53 M (bundles), 0.55 M (foreign formats) |
| 20 | `packages/core/src/import/importers.ts:22-51` `detectFormat`, `:428-497` `importAny`; `other-tools.ts` | parsers → `ImportDocument` → `lowerToEntries` | 0.55 M |
| 21 | `apps/desktop/src/components/TreeParts.tsx:20` `RowMenu`, `:42` `TreeHeader`, `:85` `TreeFolderRow`, `:160` `folderMenuItems`, `:201` `moveToFolderItem`, `:382` `NodeMenu` | `node-menu.ts` + `TreeRowShell`; `NodeMenu` becomes a thin lazy wrapper | 0.52 M |
| 22 | `apps/desktop/src/components/CollectionTree.tsx:608`, `:636`, `:673`, `:727`, `:793`, `:1021` (menus); the row-key function (`:910` in the plan) | registry kinds (`collection`, `folder`, `category`, `folder:grpc-call`, `grpc-call`/`ws-connection`, `request`); scoped `rowKey` | 0.50 (keys), 0.52 M |
| 23 | `apps/desktop/src/components/Explorer.tsx:42` `Section`, `:103` `Row`, `:307-312` library loads, `:422` `datasetMenu`, `:487` `moveMenu`, `:540` `serverMenu`, `:559` confirm delete, `:567-584` folder libraries, `:603` / `:623` folder menus, `:740-868` sections | `section:<kind>` nodes, `TreeRowShell`, kind contributions; reload by touched kinds | 0.50 (`:559` → Undo), 0.52 M, 0.57 M (reload) |
| 24 | `apps/desktop/src/components/FolderList.tsx:99-112` menus, `:132-133` private drag mime, `:171` header | `kind` prop + `buildNodeMenu`, `setDragRefs` | 0.52 M |
| 25 | `views/MonitorsView.tsx:266/283`, `views/LoadView.tsx:249/260`, `views/EvaluationsView.tsx:168/179`, `views/ai/Playground.tsx:167` (`itemMenu`) | kind contributions (`monitor`, `load-test`, `evaluation`, `prompt`) | 0.52 M |
| 26 | `views/TestsView.tsx:574-585`, `:631`, `:1000`, `:1067`; `views/HistoryView.tsx:186`; `views/TracesView.tsx:91`; `views/GitView.tsx:432/456/465`; `views/EnvironmentsView.tsx:246/257/328/333/388`; `components/SidebarPanes.tsx:51/107`; `views/ai/Providers.tsx:80/108`; `components/ProblemList.tsx:32` | kinds `test`, `folder:test`, `run`, `history`, `trace`, `git-file`, `environment`, `provider`; `problem` is a UI node kind | 0.52 M (Tests, History, Traces, Environments, Providers), 0.53 M (Git, Problems) |
| 27 | `apps/desktop/src/lib/vocabulary.ts:5,27,30` `MENU_GROUPS` (documentation only) | the enforced `MENU_GROUPS` in `node-menu.ts`; `LABEL` grows | 0.52 M |
| 28 | `apps/desktop/src/lib/git.ts:26-31` `items: Map<itemId, change>`; `ChangeMark` only at `CollectionTree.tsx:1018` | `useGitMarks()` keyed by `itemRefKey`, with container counts; the `TreeRowShell` slot | 0.57 M |
| 29 | `components/GitItemHistoryBody.tsx:21`; `backend/handlers/git.ts:179-205` (`git.history`, `restoreFile`, `restoreItem` only for collections and environments) | by ref through `kind.items` / `kind.serializer` | 0.58 M |
| 30 | `packages/core/src/mcp-server/git-tools.ts:54-61` (refs always `git-file`) | `kind.refOf` | 0.57 M |

### 1.8 The adapter phase (0.52): introduce the registry without changing behaviour

1. **Freeze today's answers as snapshots first.** This commit touches only `tests/`. The new
   `tests/unit/kind-equivalence.test.ts` records:
   - `ITEM_KIND_LABEL`, `LIBRARY_LABEL`, `LIBRARY_VIEW` and `PROTOCOL_VIEW`;
   - `refTarget(ref)` for one ref of every `ItemKind`, with each `TargetOptions` combination;
   - `resolveItemRef` over a fixture workspace (`tests/fixtures/kinds/workspace/`, one item of every kind);
   - `changeKind` over a list of 60 paths (every top folder, ignored files, temp files, nested datasets);
   - `refOfWorkspacePath` over the same paths;
   - `describeGitChanges` over a scripted fixture repo (a commit, then edits to every tracked kind);
   - `mergeWorkspaceTexts` over the merge matrix that exists today;
   - `GITATTRIBUTES_LINES` and `GITIGNORE_LINES`;
   - `exportBundle()` of the fixture workspace (keys sorted);
   - the search hits for five queries;
   - the trash kinds and `COLLECTION_ITEM_KINDS`.
2. **Add the registry.** `item-kinds.ts` and `kinds/**` declare every kind of §1.5. Facets that do not exist yet are
   `{ planned: '0.5x' }`, and the behaviour that does exist is wrapped, not rewritten. Example: `collection.change.describe`
   calls today's `collectionChanges`.
3. **Derive one table per commit.** Each commit turns one old table into a function over the registry and keeps its
   exported name, so call sites do not change. Each commit must leave the snapshots byte-identical. A snapshot change
   in an adapter commit means the commit is wrong, never that the snapshot is.
4. **The completeness test** (§1.9) goes in with `planned` allowed.
5. **Only after that, in the same release**, the menus move onto the registry (MENU-1…3). That is the first
   intentional behaviour change, reviewed through the `nodeMenuShape` snapshots.
6. Each later release replaces a `planned` with `true` when its facet lands, and deletes the old code path in that
   release. 0.65 deletes the shims that remain: the legacy watch strings, the `LIBRARY_LABEL` and `SemanticChange.kind`
   compatibility fields, and the `saved:` / `library:` aliases in internal code (they stay accepted as input).

### 1.9 The capability-completeness test

`tests/unit/kind-capabilities.test.ts` iterates `KIND_INFO`, the core registry and `ITEM_KINDS`.

**Coverage.**

- Every `ItemKind` maps to exactly one registry kind (`kindOfRef`).
- Every core kind has a `KIND_INFO` entry, and the reverse.
- Every alias is unique.

**Declared.**

- `Record<Capability, CapabilityState>` makes a missing capability a compile error.
- The test also fails on an empty `na` reason, or one under 12 characters ("n/a" is not a reason).
- All `na` reasons are written to `tests/unit/__snapshots__/kind-capabilities.snap`, so adding or changing an
  exemption shows up in review.

**Planned.** A `{ planned: '0.57' }` fails once `package.json` version is 0.57.0 or higher. A planned item can
therefore not silently outlive its release.

**`true` means implemented.** Each capability maps to a check:

| Capability | The test asserts |
|---|---|
| `versioned` | storage is not `record` / `ref-only`; `git.merge` ≠ `none`; a `serializer` or `raw-document` layout; `change.describe`; a generated `.gitattributes` line when merge ≠ `text`; `kindOfPath(sample)` returns the kind; a round trip (read → write → read → write byte-identical) on `tests/fixtures/kinds/<kind>/` |
| `merge` (via `git.merge` by-id / fields) | `kind.merge` combines different-item edits and conflicts on same-item edits, on the kind's fixture triple |
| `trash` | `ops.remove` then `ops.restore` gives a byte-identical file, and the item resolves again |
| `export` / `import` | `bundle.exportEntries` → `importEntries` into an empty workspace → export again gives an identical normalised hash; no fixture secret appears in the entries |
| `uses` | `uses()` on the fixture returns the documented edges; `rewriteRefs` with a remap leaves no dangling ref (`resolve` over every edge) |
| `secret-scan` | one positive and one negative fixture per kind |
| `watch` | `changeKind(samplePath)` returns `watch.legacy`, and (from 0.57) the canonical kind |
| `link` / `open` | `resolve` works on the fixture; the UI test (`tests/unit/kind-ui.test.ts`, shared + `ref-target.ts`) gets a target from `refTarget` |
| `rename`, `duplicate`, `move`, `delete`, `container`, `run`, `monitor`, `ci`, `test-file`, `flow`, `export`, `import`, `git-*`, `favorite`, `ai` | `buildNodeMenu(fakeNode(kind), fakeCtx)` contains the item the capability implies: Rename; Duplicate; Move to…; Delete… last; Expand all and Collapse all; Run; Monitor on a schedule…; Run in CI…; Create test file…; Generate integration flow with AI…; Export…; Import… on the section; the git group when `ctx.repo`; Add to favorites; the "… with AI" item from the AI registry (0.59) |
| `search` | the fixture item is found by its name through `ws.search` |

**No back doors.** A grep test fails on `switch (ref.kind)`, `case 'mcp-server'`, or path regexes for `collections/`,
`environments/` and `library/` outside `packages/core/src/kinds/**`, `packages/shared/src/item-kinds.ts` and an
explicit allow-list. The allow-list lists the adapters and shrinks each release. It is empty in 0.65.

**Fixtures.** A kind with storage needs `tests/fixtures/kinds/<kind>/`. A missing fixture is a failure, not a skip.

### 1.10 Services built once on top of the registry

| Service | Module | First used by |
|---|---|---|
| Secret detector (key names + value patterns + confidence) | `packages/core/src/security/secrets.ts` | 0.50 G2 export strip, git check; 0.55 import report; 0.58 staged-blob scan |
| Lexical path safety for every kind root (generalises `storage/test-path.ts`: no `node:path` decisions, `/` and `\`, drive letters, UNC, `..`, NUL, reserved names, case clashes) | `packages/core/src/kinds/paths.ts` | 0.50 G3 spec import; 0.53 bundle reader (zip-slip); 0.55 folder/zip imports |
| Size policy | `KIND_INFO.size` + settings | 0.53 dataset embed; 0.58 git warnings / LFS |
| Trash for every deletable file kind | `kind.ops.remove/restore` + `trash.ts` | 0.50 spec, mcp-server; 0.53 the rest |
| Watch kinds | `kindOfPath` + `watch` | 0.52 (legacy), 0.57 (canonical) |
| Dependency graph (`uses` closure, missing edges, cycles) | `packages/core/src/transfer/graph.ts` | 0.54 ExportDialog; 0.57 "what uses this" in the Info panel (cheap reuse) |
| One merge function per strategy | `packages/core/src/git/merge.ts` (by-id, fields) + `merge-text.ts` (hunks) | git (today), bundle Merge (0.54), conflicts for every kind (0.58) |

---

## 2. Dependency graph and order

### 2.1 What blocks what

```
0.49 ships
  └─ 0.50  MENU-P0 ghost row ─────────────────────────┐ (TreeRowShell later reuses the drag helpers)
           SEC-1 secret detector ── G2 ───────────────┼─► 0.53 bundle strip ─► 0.55 import report ─► 0.58 staged scan
           trash table (G6) ───────────────────────────┼─► 0.52 kind.ops ─► 0.53 all trash kinds
           workspace-bundle.ts move + G1 ──────────────┼─► 0.53 legacy reader reads the G1 `files`
           IMP-FIX-1..4 (in today's importers) ────────┴─► 0.55 port to parsers keeps their tests green
  └─ 0.51  AI-4, AI-10, FL-*, WFL-*   (independent of the registry; AI-10 hooks into the import report in 0.55)
  └─ 0.52  REG (adapter) ─► MENU-1..3 ─► 0.53 per-kind Export/Import items, MENU-4 multi-select
                    │                    └─► 0.54 dependency-aware export (needs `uses` facets)
                    │                          └─► 0.55 ImportDocument lowers to bundle entries (needs the planner from 0.53/0.54)
                    │                                └─► 0.56 converter, auth, model fields (folder headers/settings)
                    └─► 0.57 git layer on the registry (needs serializers + TreeRowShell ChangeMark slot from 0.52)
                          └─► 0.58 item-level ops, conflicts, staged secret scan (needs SEC-1 + per-kind secrets)
  └─ 0.59  AI-8 / AI-9 / AI-6 / AIB-10 (AIB-10 "… with AI" items need the menu registry from 0.52)
  └─ 0.60–0.64 RAG (rag-target and metric kinds register on the registry; metric files get git/export/trash for free)
  └─ 0.65  refactor: deletes every adapter listed in §1.7 phase D
```

### 2.2 Reorders forced by dependencies

The owner's order holds. Six items move between releases, and each move has a reason:

1. **Foreign formats through the bundle preview** move from export B (0.54) to import-compat A1 (0.55). They need the
   `ImportDocument` lowering, which is IMP-101.
2. **Part of G6 (trash for `spec` and `mcp-server`) ships in 0.50** with the other fixes. The rest of the trash kinds
   ship in 0.53. MCP delete with Undo (a menus decision) needs a core restore, and the owner put the trash fix in the
   first fix wave.
3. **The shared secret detector (part of git B §4e) moves to 0.50.** G2 (MCP secrets leaking into exports) cannot be
   fixed properly without one detector. A second detector would have to be removed later.
4. **MENU-4 (multi-select, keys) rides with 0.53**, as the owner decided ("multi-select next release").
5. **G7 (`testpion workspace import` and the MCP tools)** splits over 0.53 (CLI) and 0.54 (MCP). It was not in the
   owner's fix list, and it needs the bundle reader.
6. **IMP-FIX-2 includes the core of IMP-107** (`{% response %}` chaining for the common body/JSONPath case) in 0.50.
   "Template tags left literal" is a silent break; anything not converted gets a note there. The full IMP-107 stays in
   0.56.

### 2.3 Hot files and how to avoid collisions

Rules for every release:

1. **One owner per hot file per release.** The lane table of each release names it. Another lane that needs a change
   there sends it to the owner, or waits for the owner's commit.
2. **Make room first.** A release that must add code to a file near its cap starts with a no-behaviour-change
   extraction commit, reviewed and merged before the feature lanes start.
3. **New modules over growing switches.** A new kind, tool, handler, command or menu item is a new file that registers
   itself. Registry-driven code removes the switch it replaces, so registry work shrinks the hot files.

| File | Lines now / cap | Touched in | Rule |
|---|---|---|---|
| `packages/core/src/storage/workspace.ts` | 891 / 900 | 0.50, 0.53, 0.57 | 0.50 moves the bundle code to `workspace-bundle.ts`; 0.57 moves serializers to kind files. Net shrink. |
| `packages/core/src/model/types.ts` | 879 / 900 | 0.53 (`disabled`), 0.56 (auth, folder fields), 0.60 (RAG) | New types in `model/auth.ts` (0.56 moves `AuthConfig` there with a re-export), `model/http-settings.ts`, `model/rag-types.ts`; types.ts only gets optional fields. |
| `packages/core/src/mcp-server/testpion-mcp.ts` | 1,484 / 1,500 | every release with tools | 0.52 adds `mcp-server/tool-modules.ts` (one array import). New tools only in modules: `kind-tools.ts`, `bundle-tools.ts`, `import-tools.ts`, `git-item-tools.ts`, `security-tools.ts`, `drift-tools.ts`, `script-tools.ts`, `rag-tools.ts`. |
| `apps/desktop/backend/backend.ts` | 1,381 / 1,450 | every release with RPCs | Registration lines only; handlers in `handlers/kinds.ts`, `bundle.ts`, `import.ts`, `git-items.ts`, `security-tests.ts`, `rag.ts`. |
| `apps/desktop/backend/rpc-params.ts` | 335 | every release | 0.52 splits it per domain (`rpc-params/<domain>.ts` + an index), so lanes stop colliding. |
| `packages/cli/src/commands/data.ts` | 958 / 1,300 | 0.53–0.56 | 0.53 adds `commands/bundle.ts`; 0.55 moves `import`/`export` out into `commands/import.ts` and `export.ts`. |
| `apps/desktop/src/components/ui.tsx` | 1,096 / 1,200 | 0.50 (VirtualList), 0.52 (lazy Menu) | 0.50 moves `VirtualList` (and its density scaling) to `components/VirtualList.tsx`; 0.52 moves `Menu`/`MenuItems` to `components/Menu.tsx`. Both re-exported. |
| `apps/desktop/src/components/CollectionTree.tsx` | 1,039 / 1,200 | 0.50, 0.52, 0.57 | 0.50 (lane A) owns it for drag and keys. 0.52 moves its menus out (registry) and its rows onto `TreeRowShell`. Net shrink. |
| `apps/desktop/src/components/Explorer.tsx` | 884 / 1,200 | 0.50 (MCP delete), 0.52, 0.53, 0.57 | 0.52 replaces `Section`/`Row`/menus with generated section nodes (shrinks by about 300 lines). Owned by the menus lane in 0.52 and 0.53. |
| `apps/desktop/src/components/FolderList.tsx` | 257 | 0.52 | menus lane |
| `apps/desktop/src/components/TreeParts.tsx` | 492 | 0.52, 0.53 | menus lane; `treeKeys` grows in 0.53 |
| `apps/desktop/src/views/TestsView.tsx` | 1,115 / 1,200 | 0.51, 0.52 | 0.51 starts by extracting `TestsTree.tsx` and `TestsRunsList.tsx`; one owner per release. |
| `apps/desktop/src/components/FlowDesigner.tsx` | 1,168 / 1,200 | 0.51 | 0.51 extracts the toolbar and the generate/review glue (`FlowDesignerToolbar.tsx`) before any leftover lands. |
| `apps/desktop/src/components/FlowDiagram.tsx` | 1,136 / 1,200 | 0.51 (FL-7 if the bug is there) | Extract before editing; touch only for FL-7. |
| `apps/desktop/src/store.ts` | 541 | avoid | Tree state goes to `lib/tree-state.ts`, kinds to shared; nothing new in the store. |
| `apps/desktop/src/components/Shell.tsx` | 700 | 0.51 (Search → Quick Open, WFL) | One owner in 0.51; untouched otherwise. |
| `apps/desktop/src/App.tsx` | 608 | 0.54 (window drop, File menu), 0.55 | 0.54 adds `components/WindowDrop.tsx`; 0.55 only registers more formats there. |

---

## 3. Releases

### 3.0 The process of every release (the owner's, not optional)

Before the freeze:

1. Build the scope in the lanes below, running unit and integration tests per lane. **No e2e between features**
   (memory `regression-at-the-end.md`).
2. **UI-gap audit** (memory `ui-gap-hunt.md`). One agent drives the real app with real input (`__t.real.*`) through
   every view. It looks for:
   - pattern inconsistencies (menus, labels, icons, order, empty/error/loading states, tabs);
   - keyboard and focus gaps (menu key, F2, Delete, Esc);
   - visual defects (overflow and overlap, light and dark, compact density, narrow windows);
   - disabled items without a reason;
   - accessibility.

   Findings go to `planning/ui-audit-<date>.md`. A fix agent fixes them in the **shared** component, with a test that
   enumerates all kinds.

Then:

3. **Freeze.**
4. **Full regression agent.** Unit, integration, `npm run e2e`, and the perf plans within their ceilings. Also a short
   soak with no steady growth, and the robustness checks: bad RPC input gets a normalised error, the suite logs no
   console errors, and edge-case workspaces load (memory `quality-bar.md`).
5. **Docs agent.** The release's docs, `whats-new.md`, the CLI and MCP references.
6. **Audit-fix agent.** Fixes what the regression and the docs pass found.
7. `scripts/release.py`, then screenshots.
8. **Commit with explicit paths only.** Never `-a`, never `docs/public/llms.txt`, and use the GitHub no-reply identity
   (memories `no-commit-all`, `commit-identity`).
9. Tag, push, and wait for CI to be green on Windows, macOS and Linux.
10. Install (PowerShell `/S`; skill `install-and-verify`), run `e2e --exe`, and send the owner a short summary.

**Never run the installed-app suite while the owner is testing** (memory `no-e2e-while-owner-tests.md`). Start each
release only when the owner says go (memory `credit-use.md`).

**Lessons from the last releases, applied to every test written in this plan:**

- **Path checks are lexical.** Never let `node:path` decide what is absolute or inside a root (`C:\x` is a file name on
  Linux); use the `storage/test-path.ts` style, through `kinds/paths.ts`. Fixtures use `/` and are compared after
  normalising line endings.
- **Poll by a completion signal, never by time:** `run.finished`, the `data.changed` epoch, an own-writes batch
  settling, or a toast with a known id. No `sleep` in tests. An e2e run that idle-hangs means an Electron error box;
  read `events.log` (memory `e2e-hang-error-box.md`).
- **AI tests use the mock provider.** Live runs are opt-in (`AI_EVAL_LIVE=1`, `TESTPION_LIVE_JUDGE`) and only the owner
  runs them with their key. **No agent uses any API key.**
- **No test depends on the order of OS events or the case-sensitivity of the file system.** Case-clash logic is
  tested through the lexical function on every OS.
- **E2E uses real input** (`__t.real.*`: right-click, ⋯, keys), never a synthetic `onSelect`.

### Release 0.50: Nothing lost, nothing leaked

**Scope.**

- **MENU-P0** (menus-uniform P0-1). Run the repro and discriminators first. Then:
  - the `setDragRefs` drag-image chip;
  - `VirtualList keepIndex`, and `setDrag` deferred to `requestAnimationFrame`;
  - `useDragSession`, the window-level drag cleanup;
  - drop actions deferred with `setTimeout(…, 0)` (tab strip, flow canvas, collection drop);
  - a collection-scoped `rowKey` plus a dev-only duplicate-key assert;
  - fresh node ids on import collisions (`importers.ts:475`);
  - `contain: layout paint` on the list.
- **AUDIT-0.49.** Fixes from the full-view UI audit run right after 0.49 ships (ui-gap-hunt), in shared components.
- **EX-G1.** The workspace export includes `specs/`, `datasets/`, `mocks/` and `protos/`, as a `files[]` section in the
  legacy JSON. Text is utf8 and binary is base64. A file over the cap is listed in `notes[]`, never dropped silently,
  and the 5 MB test-file skip becomes a note. The dialog text (`ExportDialogBody.tsx:82`) says exactly what is
  included. `importBundle` restores `files[]` through `kinds/paths.ts`.
- **EX-G2.** No literal secret in any export. SEC-1 strips them: MCP `headers` and stdio `env` values are replaced by
  `{{variables}}` or secret references, as are collection literal tokens and DB URLs with a password. The export
  answer lists what was replaced (UI toast + CLI + `--json`). Deny by default for MCP `headers`/`env`, except clearly
  non-secret keys (`Content-Type` …).
- **EX-G3.** An OpenAPI/AsyncAPI import never overwrites `specs/<slug>…`. The default is **Keep both** (`-2` suffix),
  with a toast: "Saved as specs/x-2.yaml · Replace instead". Replace moves the old file to the trash.
- **EX-G5.** The default file name becomes `<name>.testpion.json` (decision C15).
- **EX-G6 (part).** Trash kinds `spec` and `mcp-server`, table-driven (`trash.ts:15,30`). MCP server Delete becomes
  Undo instead of the confirm dialog (`Explorer.tsx:559`). The UI's Undo calls `trash.restore`, and a connected server
  reconnects on Undo.
- **IMP-FIX-1** (part of IMP-102/110). An unknown Postman/Insomnia/Bruno auth (`hawk`, `ntlm`, `edgegrid`, `asap`,
  `wsse`, `netrc`, anything new) becomes `{ type: 'none' }` plus a **disabled** placeholder header naming the lost
  scheme, plus an import note. It is **never `inherit`**. `jwt` maps to TestPion's JWT auth.
- **IMP-FIX-2** (part of IMP-107/111):
  - Insomnia v5 request scripts (`scripts.preRequest` / `afterResponse`) are read.
  - Plain-JS scripts without `insomnia.` are kept runnable, not commented out.
  - `{% uuid %}`, `{% now %}`, `{% faker %}` and `{% timestamp %}` map to dynamic variables; `{% base64 %}` and
    `{% hash %}` become a pre-request line.
  - `{% response 'body' … %}` with a JSONPath to an earlier request is chained: the referenced request's test script
    sets the variable.
  - Every other tag gets a note, and the request is flagged (no silent literal).
  - `{{ _['a-b'] }}` is handled.
  - v5 folder headers are flattened with a note, as Bruno's are today (real folder headers arrive in 0.56).
- **IMP-FIX-3** (part of IMP-106/111):
  - Bruno `brunoVars` writes `tp.*`, and Bruno scripts go through `importScriptsToTp`, so the import returns a
    `scripts` summary.
  - The collection `.env` is read: `readBrunoFolder` allows exactly `.env`. Its values go to the secret store, and
    `{{process.env.X}}` becomes `{{X}}` in a "Bruno .env" environment.
  - The missing values are listed as "values needed".
- **IMP-FIX-4.** `graphql-sdl` (detected, no importer case) imports as a GraphQL endpoint request plus the schema.
- **SEC-1.** `packages/core/src/security/secrets.ts` with fixtures, used by `git-guard.ts` and `util/redact.ts`
  (same findings as today, plus value patterns with a confidence).
- **Make room.** `storage/workspace-bundle.ts` and `components/VirtualList.tsx`.

**Lanes and files.**

| Lane | Owns | Notes |
|---|---|---|
| A — tree and drag | `lib/drag-ref.ts`, `components/VirtualList.tsx` (new), `components/ui.tsx` (the extraction only), `CollectionTree.tsx`, `EditorTabs.tsx` / `DocTabStrip.tsx` / `FlowDrop.tsx` (drop deferral) | Do the repro on the installed app (copy of the profile) first. |
| B — export, trash, secrets | `storage/workspace-bundle.ts`, `storage/workspace.ts` (the move), `security/secrets.ts`, `storage/git-guard.ts`, `util/redact.ts`, `storage/trash.ts`, `import/workspace-import.ts` (G3), `backend/handlers/workspace.ts` (G5), `components/ExportDialogBody.tsx`, `Explorer.tsx` (`:559` only) | Lands SEC-1 on day 1–2; G2 depends on it. |
| C — importers | `import/importers.ts` (including `:475`), `import/other-tools.ts`, `import/bru.ts`, `scripts/bruno.ts`, `import/dotenv.ts`, `import/import-scripts.ts`, `import/graphql-sdl` (new) | Only notes, no new report UI: the toasts and CLI notes that exist today. |
| D — audit fixes | the shared components the audit names | Coordinates with A on `ui.tsx`; starts after the audit, before the freeze. |

**Tests.**

- Unit:
  - `virtual-list-keys.test.ts` and `drag-ref.test.ts`, as in menus-uniform;
  - `secrets.test.ts`: every pattern, one positive and one negative, with confidence;
  - `workspace-export.test.ts`: G1 round trip of the fixture workspace with specs, a CSV, SQLite, a mock and a proto;
    a grep for every fixture secret over the export (G2); notes for capped files;
  - `spec-import-keep-both.test.ts`;
  - `trash.test.ts` for spec and mcp-server;
  - `import-auth-unknown.test.ts`: every unknown auth, for Postman, Insomnia and Bruno, gives `none` + placeholder +
    note;
  - `insomnia-templates.test.ts`: each tag, chaining, and the v5 script fixture;
  - `bruno-env.test.ts`: `.env` to the secret store, `process.env` mapped, no `pm.` in the output;
  - `graphql-sdl-import.test.ts`.
- e2e (at the regression only):
  - new `tree-ghost` (the 600-row workspace, every assertion of the plan);
  - `import-collections` extended (a Postman Hawk request, an Insomnia v5 file with scripts and `{% response %}`, a
    Bruno folder with `.env`);
  - `undo-delete` extended (MCP server Undo).
- Perf: `perf-large-workspace` unchanged at 9,000 rows. The workspace export of the perf fixture takes at most 10% more
  than today with `files[]`.

**Docs.**

- `whats-new.md`: what the export now includes, secrets replaced, Keep both for specs, MCP Undo, import fixes.
- `docs/api-testing/collections.md` (export), `docs/ai-testing/mcp-server.md` (delete and undo).
- An import fidelity note in `docs/getting-started/` (until the migration guides of 0.56).

**Risks.**

- The drag-image fix depends on Windows OLE behaviour, so it must be verified on the installed app.
- The secret strip can over-replace. Mitigation: a deny-by-default list with an allow-list of known non-secret keys,
  and the stripped list shown before writing.

**Definition of done.**

- The ghost cannot be reproduced on the installed app.
- An export, then an import into a new workspace, keeps specs, datasets, mocks and protos, and holds no fixture secret.
- No spec file is overwritten silently.
- No import maps an unknown auth to `inherit`, and no Insomnia tag stays literal without a note.
- CI is green on 3 OS.

### Release 0.51: Integration testing, finished

**Scope.**

- **AI-4 Tests from an OpenAPI spec, gap-driven.**
  - **Start:** `writeTestsFromSpec`.
  - **Categories:** happy / boundary / negative / auth.
  - **Acceptance filter:** a case must parse, run twice with a stable result (against a mock), and add a covered
    operation or status.
  - **Never invented:** every request is validated with `findOperation` / `validateAgainstOpenApi`; invented
    operations are dropped with a note.
  - **UI:** "Fill coverage gaps with AI" in the coverage dialog and the API preview, with coverage before → after
    computed, not claimed; a **"From a spec"** source in `FlowGenerateDialog`.
  - **CLI and MCP:** `testpion generate tests --spec … --ai [--gaps-only] [--apply] [--json]`; MCP `generate_tests
    { ai: true }`.
- **AI-10 Import cleanup / Tidy with AI…** on any collection (right-click, and after an import).
  - **Deterministic first:** `collection-tidy.ts`, `variable-refactor.ts`, `suggestedExtracts`, script conversion.
  - **The model** only proposes names, folder grouping and chaining.
  - **Every change** is a proposal item.
  - **Surfaces:** `testpion tidy --ai [--apply] [--json]` and MCP `tidy_collection { ai: true }`.
  - **Later:** the hook into the Compatibility report ("Fix with AI") lands in 0.55.
- **FL-1** Per-step diff against the deterministic draft in `FlowProposalReview` (AI-1 left).
- **FL-2** The GitHub Action job summary reads `triage.md` (AI-2 left).
- **FL-3** Tests view generators: assertions and tests from a run result's stored response (AI-3 left).
- **FL-4** A "Prefer stable checks" setting (AI-3 left).
- **FL-5** AI prompts: closing the last tab no longer leaves nothing (the last tab never closes).
- **FL-6** Investigate the `core` e2e flake: root cause, then a fix with a completion-signal wait.
- **FL-7** **The dataset-driven Flow view edit bug.** Reported by the owner through the coordinator, with no write-up
  in the plans. The steps:
  1. Reproduce in the Flow view with a data-driven flow (`dataset:` rows).
  2. Write down what is lost or mis-applied.
  3. Fix the root cause in the shared flow-edit path (`applyFlowEdit`).
  4. Add a unit test and an e2e step.
- **FL-8** (stretch) MCP sampling as the model when none is configured (AIB-1 left).
- **WFL-1…WFL-9.** The workflow-ux leftovers "in excluded files":
  - `EnvBadge` in the Tests and flow run headers (WF-05);
  - `runCiMenuItems` in the run headers' ⋯ (WF-09);
  - `noteClosedTabs` for test files (WF-10);
  - `ItemBreadcrumb` in the Tests view and flow views (WF-11);
  - `LABEL.rerunFailed` and `LABEL.delete` (WF-13);
  - follow outside changes for tests and flows (WF-15);
  - `RefLink`s at `TestsView.tsx:876`, `FlowDesigner.tsx:714,743`, `RunPanel.tsx:404` and `TerminalPanel.tsx:103`
    (WF-02);
  - refs on the FlowDesigner toasts (WF-04);
  - Delete with Undo for test files (UX-R5);
  - Ctrl+Shift+F folded into Quick Open, with icons for environment, spec and dataset hits (WF-01 / WF-02 in
    `Shell.tsx`).

**Lanes and files.**

| Lane | Owns |
|---|---|
| A — AI-4 + FL-1 | `packages/core/src/openapi/*`, `packages/core/src/ai/tests-from-spec-ai.ts` (new), `components/ai/FlowGenerateDialog.tsx`, `components/ApiCoverageDialog.tsx`, `mcp-server/openapi-tools.ts`, CLI `commands/generate.ts` |
| B — AI-10 + FL-2 | `packages/core/src/ai/tidy-ai.ts` (new), `runner/collection-tidy.ts`, `mcp-server/tidy-tools.ts` (new), `action.yml`, CLI `commands/tidy.ts` |
| C — Tests and flow UI | **the make-room extraction first** (`TestsTree.tsx`, `TestsRunsList.tsx`, `FlowDesignerToolbar.tsx`), then `TestsView.tsx`, `RunPanel.tsx`, `FlowDesigner*.tsx`, `FlowProposalReview.tsx` (FL-1's UI, coordinated with A through its props), FL-3/4/5/7, WFL-1…8 |
| D — Shell | `Shell.tsx`, `lib/quick-open.ts` (WFL-9), FL-6 |

**Tests.**

- AI, all on the mock provider:
  - `tests/ai/tests-from-spec.test.ts`: invented endpoint dropped; boundary from min/max; an enum misuse; coverage
    delta computed; the stability filter drops a flaky case;
  - `tests/ai/tidy-ai.test.ts`: host → `{{baseUrl}}`; token → secret variable; duplicates merged; one undo step.
- Unit: one test per FL and WFL item.
- e2e:
  - `ai-spec-tests.cjs` (coverage dialog → review → Accept → coverage up);
  - `ai-tidy.cjs`;
  - a step for FL-7 in `flow-designer.cjs`;
  - the existing `wf-*` plans updated.
- Perf: AI-4 context for a 300-operation spec stays within its token budget, and preparing it takes 500 ms or less.

**Docs.** `test-runner/integration-testing.md`, `ai-testing/ai-features.md` (spec tests, Tidy with AI), the CLI and MCP
references, `whats-new.md`.

**Risks.** TestsView and FlowDesigner are near their caps: extract first. AI-4 stability needs a mock built from the
spec's examples, so cases without examples get a schema-generated body (`generate-dataset`).

**Definition of done.**

- From a spec, gaps → reviewed tests → coverage visibly up.
- Tidy with AI works on an imported Postman collection.
- No "Left in excluded files" item remains in workflow-ux.
- FL-7 is fixed with a test.
- CI is green on 3 OS.

### Release 0.52: One registry, one menu

**Scope.**

- **REG-1** Equivalence snapshots (§1.8 step 1).
- **REG-2** `packages/shared/src/item-kinds.ts` and `packages/core/src/kinds/**`: every kind of §1.5, with the facets
  that exist today wrapped.
- **REG-3** Tables derived from the registry (§1.7 rows 2, 4–8, 10, 12–14, 18 in phase A). Snapshots unchanged.
- **REG-4** The completeness test with `planned` markers, and the grep test with its allow-list.
- **REG-5** AI-first surfaces: RPC `kinds.list` (workspace-dependent facts), CLI `testpion kinds [--json]`, MCP
  `list_kinds`. Each kind's capabilities, `na` reasons and storage, so agents know what every item offers.
- **REG-6** Make room: the `rpc-params/` split, `mcp-server/tool-modules.ts`, `components/Menu.tsx`.
- **MENU-1** (phase 1):
  - `lib/node-menu.ts`, the enforced `MENU_GROUPS` (C9 order), the `LABEL` additions and retired labels;
  - `NodeMenu` as a lazy wrapper;
  - CollectionTree migrated first (the collection menu's content unchanged apart from order);
  - Copy as ▸ submenu (M4);
  - "Convert scripts to pm.*" moves to Export ▸ For Postman (pm.*) (M1).
- **MENU-2** (phase 2):
  - `lib/tree-state.ts`, with migration of `aps.tree.open`, `aps.explorer.sections.v2` and `aps.folders.<id>`;
  - Expand all and Collapse all on every container and section header, placed before Run (M2);
  - Explorer sections as `section:<kind>` nodes;
  - kinds MCP, spec and dataset;
  - the `xfolder` menu;
  - Favorites without a variant;
  - the empty-area menu;
  - **spec Rename / Delete / Lint / Generate tests / Reveal file / Copy path** (missing today);
  - **dataset folders**, virtual (M5, C21): `library/dataset-folders.json` and the backend.
- **MENU-3** (phase 3):
  - FolderList with a `kind` (Monitors, Load, Evaluations, Prompts);
  - the Tests tree, History, Traces, Environments and SidebarPanes (no variant), Providers;
  - Delete with Undo everywhere (through `kind.ops` / trash);
  - `setDragRefs` in FolderList (the private mime goes);
  - `TreeRowShell`, with an empty ChangeMark slot ready for 0.57.

**Lanes.**

| Lane | Owns | Order |
|---|---|---|
| A — core registry | `packages/shared/src/item-kinds.ts`, `packages/core/src/kinds/**`, the adapter commits in `item-ref.ts`, `item-refs.ts`, `search.ts`, `semantic.ts`, `merge.ts`, `workspace-watcher.ts`, `trash.ts`, `collection-realtime.ts`, `ref-target.ts`, `data-changed.ts`; REG-5 handler / CLI / MCP modules | REG-1 on days 1–2; `item-kinds.ts` merged by day 2 (B builds on it) |
| B — menus core | `lib/node-menu.ts`, `lib/node-menu-kinds/*`, `lib/tree-state.ts`, `components/TreeRowShell.tsx`, `TreeParts.tsx`, `CollectionTree.tsx`, `Explorer.tsx`, `components/Menu.tsx`, `lib/vocabulary.ts` | `buildNodeMenu` API plus CollectionTree by day 4 |
| C — every list | `FolderList.tsx`, `MonitorsView`, `LoadView`, `EvaluationsView`, `ai/Playground`, `TestsView` (tree and runs), `HistoryView`, `TracesView`, `EnvironmentsView`, `SidebarPanes`, `ai/Providers`; dataset-folders backend (`handlers/collections.ts` dataset part) | Starts on day 4, on B's API |
| D — make room | `rpc-params/`, `tool-modules.ts` | Days 1–2, then joins C |

**Tests.**

- Unit:
  - `kind-equivalence.test.ts` (unchanged across the release);
  - `kind-capabilities.test.ts`;
  - `node-menu.test.ts`: every kind in group order; containers have Expand/Collapse all; `link` has Copy link;
    `delete` puts Delete… last; labels in `LABEL`; a `nodeMenuShape` snapshot per kind;
  - `vocabulary.test.ts`: no node-menu literals outside `node-menu*`;
  - `tree-state.test.ts`: migration from the 3 old keys, workspace scoping;
  - `dataset-folders.test.ts`.
- e2e:
  - new `menus-uniform` (every kind of the plan's list; right-click and ⋯; Shift+F10 comes in 0.53; Expand all at
    depth; persistence across a reload; the empty area; comfortable, compact and dark screenshots);
  - updated `wf-context-menus`, `row-actions`, `tabs-uniform`, `_look`, `body-schema`.
- Perf: `buildNodeMenu` takes 1 ms or less per kind (unit benchmark); opening a menu at 9,000 rows takes 33 ms or less
  (`perf-large-workspace` step); the 9,000-row tree's numbers stay within today's ceilings.

**Docs.**

- `getting-started/finding-your-way.md` "Menus": the group order and a per-kind table **generated** from
  `nodeMenuShape`.
- `api-testing/collections.md`, `ai-testing/mcp-server.md`, `whats-new.md` (Run moved after Expand all; Copy as ▸).
- CLI `kinds`, MCP `list_kinds`.
- Screenshots: `rail-more`, `info-panel`, a new `menus-uniform.jpg`.

**Risks.**

- **The registry refactor changes behaviour.** Mitigation: snapshots first, one table per commit, and the menus change
  only after the adapters are proven.
- **Tree-state migration loses remembered open folders.** Mitigation: read the old keys once, plus a migration test.
- **Longer menus.** Mitigation: at most 18 items per menu (asserted by the test), and Copy as ▸.

**Definition of done.**

- Every tree and list node menu comes from `buildNodeMenu`.
- Every container has Expand all and Collapse all.
- The adapters are proven by unchanged snapshots.
- `testpion kinds --json` lists every kind with its capabilities.
- The grep allow-list holds only the adapters.

### Release 0.53: Export and import anything

**Scope.**

- **EX-A2** Per-kind **Export…** (share group) and **Import…** (create group on sections) on every kind with
  `export` / `import`:
  - MCP servers: bundle, and `.mcp.json` / `claude_desktop_config.json` / `.vscode/mcp.json` both ways. Secrets become
    variables on the way in.
  - API definitions: the file as it is, a zip, or a bundle.
  - Datasets: Import data file… with a row preview and a clash choice; export of the file or a zip.
  - Library kinds; test files and folders (bundle + Arazzo); environments.
- **EX-A3** `packages/core/src/bundle/`:
  - the format: manifest schema `packages/core/schemas/bundle-v1.schema.json`, zip and JSON, `formatVersion`;
  - a streaming writer and reader;
  - safety limits: zip-slip through `kinds/paths.ts`, ratio and total caps, 20,000 entries, no symlinks, case clashes
    refused, `sha256` checked;
  - `legacy.ts`, which reads every old workspace-bundle name, including the 0.50 `files[]`;
  - the bundle facet on every exportable kind.
- **EX-A4** `transfer/plan.ts` and `transfer/apply.ts`, first version:
  - preview actions `create` / `identical` / `conflict`, with one global choice (Skip / Keep both);
  - the default is **Keep both** (E3);
  - a re-import is a no-op (idempotent by normalised hash);
  - the journal and **one-step Undo import**.
- **EX-A4** also: trash kinds for `library-item` kinds, `test`, `mcp-mock`, `proto` and `provider` (the rest of G6).
- **EX-A5** CLI:
  - `testpion export <collection> --with … | --all | --kind … --format …`;
  - `testpion import <file> --preview | --apply --on-conflict … | --undo <id>` (rule C7);
  - `testpion bundle inspect`;
  - `testpion workspace import` (G7, CLI part);
  - `--legacy` writes the old JSON (kept in 0.53 and 0.54, E8).
- **Imported stdio MCP servers start disabled** (E4). New optional `McpServerConfig.disabled`. The preview lists the
  command; Connect and "Connect all" skip disabled servers; Enable is one click.
- **Datasets:** embedded at 10 MB or less, otherwise ask, with reference preselected (E2); DB datasets are always
  references; `.ref.json` (C11).
- **Providers:** excluded by default from selections, included in whole-workspace export (E5; flagged in §4).
- **MENU-4** (phase 4):
  - keys `*`, Shift+F10 and the ContextMenu key, plus typeahead;
  - `role="tree"` / `treeitem`;
  - **multi-select** (`useTreeSelection`, the `selection` node: Delete N with one Undo, Move N, Copy N links, Export N,
    Create test file / flow from N);
  - CLI `testpion menus --json` and MCP `ui.menuShape`.
- **Git view and Problems** rows on `buildNodeMenu` (the rest of row 26 in §1.7).

**Lanes.**

| Lane | Owns |
|---|---|
| A — bundle core | `packages/core/src/bundle/**`, `transfer/**`, the kind bundle facets in `kinds/**`, `storage/workspace-bundle.ts`, `trash.ts`, `commands/bundle.ts` (new), `commands/data.ts` (`import` / `export` flags only), `commands/workspace.ts` |
| B — UI entries | the Export/Import contributions in `lib/node-menu-kinds/*`, `components/ImportDialog.tsx` (the existing `views/rest/dialogs.tsx` `ImportModal` gains a simple preview step), `components/ExportDialogBody.tsx` (format step), the MCP config import form, the dataset import form, `handlers/bundle.ts` |
| C — menus phase 4 | `TreeParts.tsx` (`treeKeys`), `lib/tree-selection.ts`, `TreeRowShell.tsx`, `GitView.tsx`, `ProblemList.tsx`, CLI `commands/menus.ts`, MCP `kind-tools.ts` |

**Tests.**

- Unit:
  - per kind, a bundle round trip and a property test (fast-check) on collections, environments, library items and
    servers;
  - idempotence (the second import is all `identical`, no mtime changes);
  - the conflict matrix (Skip / Keep both × kind);
  - Undo byte-identical;
  - the secrets grep over every fixture bundle;
  - the legacy fixtures from `examples/` (the `testpion-` / `protolens-workspace` names);
  - the `.mcp.json` / Claude / VS Code readers and writers;
  - `disabled` honoured by Connect all.
- Malicious fixtures `tests/fixtures/bundles/evil/` (the full list in export-import §4.10). Each is refused, and
  nothing is written outside the workspace.
- CLI integration: `--preview --json` validated against its schema, exit codes, the `--json` without a choice rule.
- e2e: `export-import-bundle` part 1 (section Export/Import for MCP `.mcp.json`, datasets CSV, specs; a workspace
  bundle round trip; Undo import); `menus-uniform` + Shift+F10 + multi-select.
- Perf: export of the 9,000-request fixture as a zip in 2 s or less, preview in 1.5 s or less, apply in 3 s or less;
  memory flat while streaming.

**Docs.** New `docs/api-testing/export-import.md`; `collections.md`, `environments.md`, `ai-testing/mcp-server.md`,
`cli/reference.md`, `keyboard-shortcuts.md` (the new keys), `features.md`, `whats-new.md`; the bundle schema under
`docs/public/schemas/`.

**Risks.**

- A secret detector miss leaks a secret. Mitigation: deny-by-default for MCP, the strip list shown, fixture greps.
- Zip handling across OSes. Mitigation: lexical paths only, and case-clash tests through the function.
- Multi-select touches every tree. Mitigation: one shared hook, plus the e2e plan.

**Definition of done.**

- Every section and item with data has Export… and Import….
- A workspace survives export, then import, with nothing lost.
- A re-import changes nothing, and Undo import restores the state byte for byte.
- No bundle contains a secret.

### Release 0.54: Everything it uses

**Scope.**

- **EX-B1** `uses` and `rewriteRefs` facets on every kind. The edges:
  - `openapi spec:` paths;
  - `dataset:`;
  - `server: { name }`;
  - `mockFile`;
  - sub-flows;
  - `collectionId`, and a monitor's `selection` and environment;
  - `tp.require`;
  - proto files;
  - ItemRefs in notes.

  `transfer/graph.ts` computes the closure, the missing edges and the cycles. The **ExportDialog** has the kind tree
  with "included because X uses it", a Missing list, the embed/reference switch per dataset, a summary of stripped
  secrets, scripts and production flags, and the format step. **"Export with everything it uses…"** goes on every
  collection, folder and test file.
- **EX-B2** The full conflict engine:
  - per-row Skip / Replace (to the trash) / Keep both / **Merge** (collections and folders through the one by-id merge,
    C16);
  - a diff link (semantic diff for collections, text diff for specs);
  - the "refs rewritten" count;
  - remap for every reference type;
  - a post-apply dangling-ref check.
- **EX-B3:**
  - the **Requires** panel (variables, secrets typed straight into the secret store, OS env, missing items);
  - **drag and drop** of `.testpion.zip` / `.json` on the window (`components/WindowDrop.tsx`);
  - File ▸ Export ▸ (Collection…, Collection with everything it uses…, Environment…, Bundle…, Workspace…) and File ▸
    Import…;
  - Home Import;
  - `testpion://import?file=` (desktop);
  - the Workspace menu: Import **into this workspace or as a new workspace** (G4).
- **EX-B4** MCP tools in `mcp-server/bundle-tools.ts`: `export_bundle`, `import_preview`, `import_apply` (confirmed),
  `import_undo`, `describe_bundle` (C8). Plus `tool-docs.ts` entries.
- **EX-B5** Postman export as a **zip with extras** (E6): the collection, `specs/`, datasets (JSONL → JSON array),
  environments, `.mcp.json`, Arazzo files for flows, a README, and the lost-kind notes. The Bruno folder export gets
  the same extras.
- **EX-B6** `describe_bundle`, deterministic (what is inside, what it needs, what it will run, risky items), plus an
  optional AI paragraph (small tier, mock provider in tests).
- The `--legacy` writer is announced as removed in 0.55.

**Lanes.** A: `transfer/**`, `uses`/`rewriteRefs` in `kinds/**`. B: `components/ExportDialog.tsx`, `ImportDialog.tsx`,
`WindowDrop.tsx`, `App.tsx` (the drop + File menu registration), `menu-commands.ts`, `WorkspaceMenu.tsx`, `HomeView`
Import. C: `bundle-tools.ts`, `postman-export.ts` / `bru-export.ts` extras, `describe_bundle`.

**Tests.**

- Unit:
  - the closure (shared specs counted once, sub-flow cycles, missing edges);
  - remap of every edge type in export-import §1.3, then `resolve` over all of them;
  - the conflict matrix with Merge;
  - Replace via the trash and Undo;
  - the Postman zip read back (the collection unchanged, notes list the lost kinds);
  - the Bruno folder with extras read by `readBrunoFolder`.
- MCP: `import_apply` needs a `planId` from a preview.
- e2e: `export-import-bundle` part 2 (right-click ▸ Export with everything it uses ▸ the tree shows spec, dataset and
  server ▸ a new workspace ▸ drag the file ▸ 0 conflicts ▸ Apply; re-import all Identical; change one request ▸
  Conflict ▸ Keep both ▸ Undo).
- Perf: preview of a 9,000-request bundle with 3,000 conflicts in 1.5 s or less; the dialog tree is virtualised.

**Docs.** `export-import.md` (dependencies, conflicts, Merge, Requires, MCP tools), `cli/reference.md`,
`ai-testing/mcp-server.md`, screenshots of the ExportDialog tree and the ImportDialog preview.

**Risks.**

- Merge diverges from git. Mitigation: one function and one test suite.
- A remap misses a reference type. Mitigation: the post-apply resolve check, and property tests.

**Definition of done.**

- "Export with everything it uses" carries a collection's specs, datasets, servers, flows and environments, and
  re-imports elsewhere with zero dangling refs.
- Every conflict has a per-row choice.
- Agents can do the whole loop over MCP.

### Release 0.55: Switch from Postman, Insomnia or Bruno (import-compat A1)

**Scope.**

- **IMP-101** `packages/core/src/import/doc/` with `ImportDocument` and `ImportFinding`. Postman, Insomnia, Bruno and
  Hoppscotch are ported to small parsers plus the shared mappers in `import/map/` (auth, body, templates, settings,
  examples, vars). The port is **behaviour-preserving first**: every existing import test and the 0.50 fix tests stay
  green. `lowerToEntries()` feeds the one planner (C4).
- **IMP-102** No silent drops: every unmapped field becomes a finding with the original kept (redacted).
- **IMP-103** The **Compatibility report**:
  - shared component, the ImportDialog's report tab;
  - reopenable from the collection header ▸ Import report;
  - stored in `.local/imports/<id>/report.json` (C5);
  - download as JSON or Markdown;
  - CLI `--report`, `testpion import-report`, MCP `get_import_report`;
  - "Fix with AI" opens AI-10's proposal (from 0.51) on the report's leftovers.
- **IMP-104** The foreign-format preview **is** the bundle preview:
  - target (new collection, or merge into one);
  - keep or flatten folders;
  - environments;
  - **values needed** typed straight into the secret store;
  - clash choices with the C6 vocabulary;
  - scripts (convert / keep pm.*);
  - one Undo import.
- **IMP-105** Drag and drop of files, folders and `.zip` (through `WindowDrop.tsx`); multi-file pick; folder pick for
  any tool.
- **IMP-108** Dynamic variables: all 118 Postman names, checked by a test against the fixture list; Thunder and
  Hoppscotch forms in the template mapper.
- **IMP-113 (part 1)** The corpus under `tests/fixtures/import/<tool>/<case>/` with golden `expected.json`, the hostile
  inputs, and the 10k performance test.
- **D7** "Migrate from…" on Home: the same dialog, with the tool preselected and short export instructions.
- **D5 / C7** CLI defaults. `import` and `export` move out of `commands/data.ts` into `commands/import.ts` and
  `export.ts`. The `--legacy` writer is removed (the reader stays).

**Lanes.** A: `import/doc/**`, `import/map/**`, the parser ports (Postman, Hoppscotch). B: the Insomnia and Bruno
parser ports. C: the report component, ImportDialog steps, Home "Migrate from…", `WindowDrop` formats,
`mcp-server/import-tools.ts`, CLI `import.ts`. A and B share `import/map/**`: A owns it, and B sends changes through A.

**Tests.** Golden per importer (`UPDATE_GOLDEN=1`), `import-hostile.test.ts`, `tests/perf/import-10k.test.ts` (parse +
plan in 2 s or less, apply in 5 s or less, heap 300 MB or less), report persistence, Undo through the trash. e2e:
`import-collections` (drag a Postman file → preview → import → report counts → open a converted request → run against
the demo server → tests pass; Undo).

**Docs.** `docs/migrate/compatibility.md` (first version, generated from the capability tables), the ImportDialog
screenshots, `cli/reference.md`, `ai-testing/mcp-server.md`, `whats-new.md`.

**Risks.** The port regresses an importer. Mitigation: the goldens are recorded from the **old** importers before the
port, and the port must reproduce them, apart from the findings it adds.

**Definition of done.**

- Every import of Postman, Insomnia, Bruno and Hoppscotch shows a preview and a report.
- Nothing unmapped is silent.
- Drag and drop works for files, folders and zips.
- One dialog serves bundles and foreign files.

### Release 0.56: Scripts and auth that just work (import-compat A2)

**Scope.**

- **IMP-106** `scripts/convert/`:
  - acorn with positional edits;
  - scope-aware (a local `pm` stays local, and the rest of the script is still converted);
  - a per-script result and line findings;
  - coverage table `convert/coverage.ts` (the source for the docs and tests);
  - Postman legacy, Insomnia, `bru.*` / `req` / `res`, `pw.*` (Hoppscotch) → `tp.*` (D1; `--keep-pm` stays);
  - shim fills: `bru.sendRequest`, `bru.getSecretVar`, `bru.cookies`, and the `req.setTimeout` lift;
  - **`tp.execution.runRequest(name)`** (D4), in the sandbox prelude and the runner. AI-6's `scriptReference()` picks
    it up automatically, because it reads the sandbox.
- **IMP-107** All Insomnia (and Yaak-style) template tags, response chaining with policies → a flow suggestion, and
  `{% prompt %}`.
- **IMP-109** Model fidelity (D6): folder description, folder and collection **headers** and **settings**
  (`protocolProfileBehavior`, Bruno `settings`), `disableCookies`, `encodeUrl`, OAuth 2 implicit / device / refresh /
  prefix / audience. The new types go in `model/http-settings.ts` and `model/auth.ts` (types.ts cap). This ripples into
  the runner, editors, the merge driver (the `fields` merge takes new keys), and the Postman/Bruno/OpenAPI exporters.
- **IMP-110** Auth (D2): **EdgeGrid** and **Hawk** as signers (like AWS v4), **NTLM** with its multi-round handshake
  in the HTTP layer, ASAP via JWT, and WSSE as a header generator. A typed `unsupported` holder keeps any other scheme
  for the round trip.
- **IMP-111** Bruno:
  - **OpenCollection YAML** (the default since Bruno 3.1);
  - `settings`, `body:file`, `example`, the `http` custom method;
  - oauth1, ntlm, wsse, edgegrid;
  - gRPC and WebSocket items;
  - collection post-response vars.

  Insomnia:
  - folder scripts and headers (now real fields);
  - `api_spec` → `specs/`;
  - unit tests → test scripts;
  - v5 gRPC and WebSocket items;
  - settings;
  - the cookie jar.
- **IMP-112** Postman:
  - the data-dump zip;
  - globals → workspace globals;
  - secrets listed as values needed;
  - all of `protocolProfileBehavior`;
  - collection v1.
- **IMP-113 (part 2)** A behavioural script corpus of 200 or more snippets. Each runs in the sandbox before and after
  conversion, with the same pass/fail results and the same variables set.
- **IMP-114** Migration guides `docs/migrate/postman.md`, `insomnia.md`, `bruno.md`, `others.md`, and the generated
  compatibility matrix.
- **Stretch: IMP-205.** URL import of a GitHub/GitLab repo or tree, Postman public links, and the **optional Postman API
  key** (D3: typed by the user, kept in the secret store, never logged). If it does not fit, it goes to the backlog
  with import-compat B.

**Lanes.** A: `scripts/convert/**`, the sandbox prelude (`tp.execution.runRequest`), runner hooks. B: `model/auth.ts`,
the auth signers and NTLM (`protocols/http/**`), auth editors. C: `model/http-settings.ts`, the folder fields in the
runner, editors (folder settings tab), exporters, merge tests. D: the parser fidelity work (IMP-111/112) on A1's
parsers.

**Tests.**

- The behavioural script corpus.
- Signer test vectors: the EdgeGrid and Hawk published examples, and NTLM against a local test server.
- Folder headers and settings honoured by the runner, and their round trip through Postman/Bruno export.
- OpenCollection fixtures and the Postman dump fixture.
- e2e: an Insomnia file with chaining runs green against the demo server; a Bruno OpenCollection folder imports and
  runs.

**Docs.** The migration guides, `api-testing/auth.md` (the new auth types), `scripting` reference
(`tp.execution.runRequest`), `whats-new.md`.

**Risks.**

- NTLM's handshake in the HTTP layer and on a cloud host. Mitigation: a cut candidate (§5.2), behind a capability
  check.
- Model changes ripple everywhere. Mitigation: each field is its own item with runner, editor, exporter and merge
  tests.

**Definition of done.**

- A Postman, Insomnia or Bruno user imports a real collection and its scripts and auth run as they did.
- The report shows only what truly has no equivalent.

### Release 0.57: Everything under git (1)

**Scope.**

- **GE-A1** The git layer is driven by the registry (§1.7 rows 8–12, 15, 30 in phase M): `semantic.ts`, `merge.ts`,
  `MERGED_BY_MEANING`, a generated `git-files.ts`, the canonical watch kinds (the legacy strings are still emitted),
  `template-update.ts`.
- **GE-A2** Stable serializers:
  - library items lose `updatedAt` (moved to `.local/meta.json`; nothing in the UI reads it), with fixed key order;
  - MCP servers `{ schemaVersion, servers }` with fixed keys and user order kept;
  - providers;
  - environments' key order;
  - `workspace.json` without `updatedAt`;
  - debugger rules;
  - the flow designer's canonical YAML, with integer layout coordinates.

  Writers are canonical from this release. Existing files are rewritten **once** by Fix git setup, with its own commit
  message (decision G-2), never silently on open. A round trip per kind.
- **GE-A3** Semantic diff and Git view rows (name, kind icon, details, Compare) for MCP servers, providers, specs (the
  OpenAPI diff engine of `OpenApiDiffDialog`), datasets (rows and columns), tests, packages, rules and metrics; filter
  chips by kind.
- **GE-A4** `useGitMarks()` keyed by ref, with container counts. **ChangeMark on every row** of every tree and list,
  and on section headers, through the `TreeRowShell` slot.
- **GE-A5** `.gitignore`: `workspace.json.bak-*`, `debugger/**/*.har`, `*.tmp-*`. `.gitattributes` generated, with the
  merge driver for `mcp-servers.json`, `providers.json` and `debugger/rules.json`. The watcher ignores HAR. The
  `LIBRARY_LABEL` "Saved item" fix.
- **GE-A6** The `versioned` capability goes strict: no `planned` left for it.
- Listeners on canonical kinds: the Explorer reloads only the touched sections; AI Lab, Load, Evaluations, Monitors and
  Providers subscribe with `touchesFiles`.

**Lanes.** A: `packages/core/src/git/**`, `kinds/**` (serializers, describe, merge), `storage/git-files.ts`,
`git-ready.ts`, `workspace-watcher.ts`. B: `views/GitView.tsx`, `lib/git.ts` (`useGitMarks`), `TreeRowShell.tsx` slot,
`components/ChangeMark.tsx`. C: the listeners in views (`Explorer.tsx` reload), `mcp-server/git-tools.ts`.

**Tests.**

- A round trip per kind.
- Merge-driver tests per kind (different items combine, same item conflicts, both add, delete vs edit), including a
  **mixed-version driver** check: an older driver given an MCP file must fall back to a line merge, not corrupt it.
- `describeGitChanges` snapshots (new kinds added; old kinds unchanged).
- e2e `git-everything` part 1: edit an MCP server URL → mark on the row and the section count → the Git view row with
  its icon → Compare; the same for an API definition and a dataset row.
- Perf: `git.changes` at 9,000 items in 200 ms or less warm. Status is cached by the `data.changed` epoch, the
  description by `(path, blob sha)`, and unchanged files are never parsed. Marks are passed as primitives.

**Docs.** `getting-started/git.md` "What is in git, per kind" and the canonical rewrite; `whats-new.md` (teammates on
mixed versions: see §5.1).

**Definition of done.** Every versioned kind has a mark, a named row, a semantic diff and a by-meaning merge where its
strategy says so, and the gap matrix is strict for `versioned`.

### Release 0.58: Everything under git (2)

**Scope.**

- **GE-B1** History, restore and discard by ref for every kind (backend, `GitItemHistory`, the menus' `git` group with
  a disabled reason when unchanged). Discard has Undo.
- **GE-B2** Stage by item (the index blob built through the serializer, with a "what will be committed" preview),
  commit by item or kind, the stash UI ("Set changes aside" / "Put back"), and blame "last changed by" in the Info
  panel.
- **GE-B3** The conflict screen for every kind: `by-id`, `fields`, `text` per hunk, and `binary-ours` (sizes and row
  counts shown).
- **GE-B4** The staged-blob secret scan over every kind, through SEC-1 and the per-kind `secrets.scan`:
  - fixes for MCP servers, providers, library items and test steps;
  - the allowlist `.testpion/secrets-allow.json` (committed and reviewed);
  - **high confidence blocks the commit, low confidence warns** (G-3);
  - a PII-column warning for datasets, offering synthetic data instead.
- **GE-B5** CLI and MCP parity:
  - CLI: `git status --kind`, `git history <ref>`, `git restore <ref> --rev`, `git discard <ref>`, `git stage <ref>`,
    `git setup --fix`;
  - MCP: `git_history`, `git_restore` / `git_discard` (confirmed), `git_setup_check` in `git-item-tools.ts`.
- **GE-C1** The Fix git setup wizard:
  - missing ignore and attribute lines;
  - driver and textconv;
  - tracked files that should be ignored (untracked with `git rm --cached`);
  - untracked files that should be shared;
  - non-canonical files;
  - files over the size policy;
  - the pre-commit hook.
- **GE-C2:**
  - the textconv diff driver;
  - the size policy (warn at 5 MB, **LFS offered at 50 MB**, refused at 100 MB or more without LFS; G-4);
  - track-by-reference datasets (`.ref.json`, C11);
  - HAR sessions ignored, with **Share session** writing a redacted copy to `debugger/shared/` (G-5).
- **WF-03 / UX-R6 leftovers** (workflow-ux): git conflicts and secrets in a commit appear in Problems; the other
  editors (GraphQL, gRPC, WebSocket, MCP) publish their variables to the undefined-variable badge.

**Lanes.** A: core git ops (`git/git.ts`, `git/stage-item.ts`, `git/blame.ts`, `git/stash.ts`), `kinds/**`
items/serializers. B: `security/secrets.ts` scanners per kind, `git-guard.ts` → staged scan, `fixCommittableSecrets`
extended. C: UI (`GitConflictDialog`, `GitItemHistoryBody`, menus' git group, the Info panel blame, the stash UI, the
wizard). D: CLI and MCP modules.

**Tests.**

- Stage-by-item exactness: the committed tree equals the expected blob for every kind (property test).
- The conflict screen per strategy.
- Secret fixtures: one positive and one negative per kind and per value pattern, high vs low confidence, the allowlist.
- The wizard on a deliberately broken repo.
- e2e `git-everything` part 2: History after a commit, Discard from the row menu, and a conflict on `mcp-servers.json`
  from a bare-remote teammate resolved per server.

**Docs.** `getting-started/git.md` (item operations, secrets policy, LFS, Share session), the CLI and MCP references.

**Risks.** Item staging could lose a change. Mitigation: round trips, the preview, and a cut candidate (§5.2), with
history, restore and discard kept.

**Definition of done.** Every versioned kind can be reviewed, restored, discarded and merged per item, and no
high-confidence secret can be committed.

### Release 0.59: Security, drift, scripts

**Scope.**

- **AI-8 Security tests** ("AI to understand, deterministic to decide"):
  - identities A and B as environment variable **names**;
  - a fixed catalogue: BOLA, broken authentication, BOPLA / mass assignment, BFLA, excessive data exposure;
  - deterministic verdicts;
  - destructive methods off by default, an allow-list of test environments, an "authorised testing only" note;
  - surfaces: `testpion security generate`, MCP `generate_security_tests` (`mcp-server/security-tools.ts`).
- **AI-9 Contract drift:**
  - deterministic drift from `validateAgainstOpenApi` over History, a HAR or the Debugger;
  - the AI explains and proposes a spec patch or test updates;
  - the patch is verified by re-linting and re-validating the same traffic (the drift must disappear);
  - surfaces: `testpion openapi drift`, MCP `contract_drift`.
- **AI-6 Script helper:**
  - ✦ Write / Explain / Fix in the script editor;
  - every result runs in the sandbox against the last response before it is offered (`scriptReference()` and
    `scriptApiProblems()` from 0.49);
  - surfaces: `testpion ai script`, MCP `write_script`.
- **AIB-10:**
  - one registry for the right-click **"… with AI"** items: the `ai` capability plus an AI action table, so the menus,
    the CLI and MCP list and the docs are generated from it;
  - **a setting that hides every AI action**.
- **AIB-6:** the month-to-date line in Settings.
- **AIB-9:**
  - 10–30 golden inputs per task from the fixture workspaces;
  - `npm run ai-evals` on TestPion's own eval engine (live runs are opt-in and the owner's).
- **Stretch: AI-12** natural-language search over History, Runs and Traces (the model only produces the filter).

**Lanes.** A: AI-8 (`ai/security-tests.ts`, `SecurityReviewDialog.tsx`). B: AI-9 (`ai/drift.ts`, `openapi/**`). C:
AI-6 + AIB-10 (`components/ai/ScriptAssist.tsx`, `lib/ai-actions.ts`, `node-menu.ts` (the `ai` group hook),
`AiSettingsPanel.tsx`). D: AIB-9, AIB-6.

**Tests.** All on the mock provider:

- AI-8: a fixture API with a seeded BOLA, where the verdict is a finding, and a correct API, where it is not.
- AI-9: a drift fixture where the patch removes the drift.
- AI-6: a wrong script repaired, and the sandbox verification.
- AIB-10: hide-all removes every ✦ item (enumerated over the registry).
- e2e: `ai-security-tests.cjs`, `ai-drift.cjs`, `ai-script-helper.cjs`.

**Docs.** `ai-testing/security-tests.md`, `api-testing/contract-drift.md`, the scripting page, `ai-features.md`.

**Definition of done.** Security tests and drift patches are proposed, verified and reviewed. Script help works offline
against the stored response. One setting hides every AI action.

### Releases 0.60–0.64: RAG testing (`planning/rag-testing.md`)

These follow rag-testing §5, renumbered (C19). Owner defaults are recorded in §4:

- RAG lives under Evaluations, with an AI Lab ▸ RAG tab;
- no judge means a setup error, never a silent mock;
- R1 is split in two;
- monitors use local and free metrics by default.

Each RAG release keeps rag-testing's file layout (`eval/rag/**`, each file under 400 lines; new modules for types,
handlers, CLI and MCP, given the caps).

| Release | Scope | Gates |
|---|---|---|
| **0.60 R1a** | RAG-1 (model, mapping, capture for HTTP JSON, SSE, WebSocket, MCP; presets OpenAI-compatible, LangServe, LlamaIndex; offline records), RAG-2 (Connect UI, click-to-map, saved targets: **registers the `rag-target` kind**), RAG-3 (column mapper; Ragas / DeepEval / CSV / BEIR / NVIDIA import), RAG-5 (every non-LLM family), RAG-5b (read-only SQL executor + `datacompy-score`), the free half of RAG-9 (samples × metrics pivot, thresholds, aggregates), CLI `rag targets\|connect\|probe\|metrics\|run\|compare\|import` and MCP for those | the demo `examples/servers/rag-server.mjs`; each non-LLM metric's worked example as a unit test; SQL guard tests refused before any DB call; matrix page in 50 ms or less |
| **0.61 R1b** | RAG-4 (judge service: routing, structured output, cache, ledger, caps, estimate, juries, swap), RAG-6 (the triad), RAG-6b (Ragas parity names, `aspect_critic`, rubrics), RAG-7 (custom metrics `judge`, `rule`, `formula` as `metrics/*.yaml`: **registers the `metric` kind**, so git, export, trash and menus come for free), RAG-8 (picker, presets, Try on one sample), the rest of RAG-9 and RAG-10 | golden mock-judge cases per prompt version; the ledger records judge spend; no-judge run errors with the setup hint |
| **0.62 R2** | every LLM-judged metric of types 1, 3, 4, 7; `sql-equivalence`; custom kinds `checklist`, `embedding-set`, `script` (sandbox); gRPC / Socket.IO capture and the remaining presets; two-phase runs, `shortCircuit`, repeat-N; paired-bootstrap compare; JUnit / HTML / CSV export; `hallucination` becomes lower-is-better | Ragas parity suite (25 of 29); script sandbox limits |
| **0.63 R3** | multi-turn targets and type 9, type 10 agent metrics, type 12 multimodal (content parts in every provider, vision probe, image consent and limits; images as data by default, pending the owner), type 8 judged safety, `dag` built-in and custom kind, `reward-score` | every catalogue row runnable; the Ragas list complete (29 of 29) |
| **0.64 R4** | test-set generation (the `rag-answerable` verifier, a reviewed proposal), capture from traffic, **AI-11** (eval case generation, rubric drafting, judge calibration: κ, TPR/TNR, disagreements → examples), monitors with RAG evaluations and judge budgets, CI templates and Action inputs, perf hardening | 5,000 × 10 with the mock judge in 3 min or less at concurrency 16, core memory 400 MB or less |

The lanes of each RAG release follow rag-testing §4i: core model, engine, AI tasks, RPC handlers, renderer components,
then CLI and MCP. The only hot files are `EvaluationsView.tsx`, `AiLabView.tsx` and `EvalMatrix.tsx`, one owner each.

### Release 0.65: Refactor and cleanup (no features)

**Scope.**

- Delete every phase-D shim in §1.7: the legacy `data.changed` strings, the `SemanticChange.kind` compatibility field,
  the derived-table re-exports nobody imports, and the grep allow-list (it must be empty).
- Dedupe helpers: the three `kv` helpers and four auth mappers in the importers (if any survived 0.55), duplicated
  undo paths, duplicated label tables.
- Split every file within 10% of its cap: FlowDesigner, FlowDiagram, TestsView, ui.tsx, CollectionTree, backend.ts,
  testpion-mcp.ts. **Lower the ceilings** in `architecture.test.ts` to the new sizes.
- One mechanism per concern: data refresh, undo, drag, menus, tabs, AI entry points. Audit for leftovers.
- Re-measure perf, leaks (soak) and startup. Full regression **before and after**, with numbers in the summary.

**Definition of done.**

- No adapter is left.
- The ceilings are lower than in 0.64.
- Perf is equal or better on every plan.
- Then **remind the owner**: all non-cloud features are done, apart from the backlog they choose; ready to start the
  cloud integration? (memory `cloud-last.md`).

---

## 4. Decisions recorded

The defaults below are the ones the coordinator gave the owner, and this plan builds on them. **Flag** marks a default
that conflicts with another plan, or needs a specific implementation choice the owner should see.

| # | Area | Decision | Default chosen | Lands in | Notes / flag |
|---|---|---|---|---|---|
| M1 | Menus | Where "Convert scripts to pm.*" goes | Export ▸ For Postman (pm.*)…; "Convert scripts to tp.*" stays in tools | 0.52 | Consistent with D1 and tp-not-pm. From 0.54 it is the Postman format of the one ExportDialog. |
| M2 | Menus | Group order | Expand/Collapse all **before** Run; the full order is C9, with the new `git` group | 0.52 | **Flag:** the git plan's `git` group is placed between tools and edit; "History in git…" moves there from open. |
| M3 | Menus | MCP server delete | Undo, no dialog | 0.50 | Implemented through **core trash** (C13), not the UI snapshot of UX-R5. A connected server reconnects on Undo. |
| M4 | Menus | Copy-as items | `Copy as ▸` submenu | 0.52 | — |
| M5 | Menus | Dataset folders | Yes | 0.52 | **Flag:** implemented as virtual folders (`library/dataset-folders.json`, C21), so `dataset:` paths never change. |
| M6 | Menus | Multi-select | Next release | 0.53 | — |
| E1 | Export | Bundle or nesting | Bundle, not nesting; ownership semantics optional | 0.53–0.54 | The `uses` association (export C) is in the backlog. |
| E2 | Export | Dataset mode | Embedded at 10 MB or less, otherwise ask with reference preselected; DB datasets always reference | 0.53 | The reference file is `.ref.json`, shared with git (C11). |
| E3 | Export | Default conflict choice | Keep both | 0.53 | The same word as import-compat's "rename" (C6). |
| E4 | Export | Imported stdio MCP servers | Start disabled until reviewed | 0.53 | **Flag:** needs a new `McpServerConfig.disabled` field (types.ts, git key order, "Connect all"). Legacy workspace bundles go through the same path, so their stdio servers also arrive disabled. This is a behaviour change, named in What's new. |
| E5 | Export | Providers in bundles | Excluded by default | 0.53 | **Flag (conflict):** today's "Export workspace" includes providers (keys are refs). Excluding them from a whole-workspace export would be a regression. This plan excludes them from **selections** and pre-ticks them for **whole-workspace** export. Owner to confirm. |
| E6 | Export | Postman export | Zip with extras (specs, datasets, environments, `.mcp.json`, Arazzo, README) | 0.54 | — |
| E7 | Export | File extension | `.testpion.zip` / `.testpion.json` | 0.50 (name), 0.53 (format) | **Flag:** G5's interim `.testpion-workspace.json` is skipped (C15). No double-click file association: a compound extension cannot be registered reliably, so it is drag-and-drop and File ▸ Import. |
| E8 | Export | Legacy workspace JSON | Writer kept 2 releases behind `--legacy`; reader forever | 0.53, 0.54; removed 0.55 | — |
| G-1 | Git | Baselines | Stay ignored | — | Registered as kind `baseline`, `git.ignored`. |
| G-2 | Git | Canonical rewrite of existing files | Once, through Fix git setup, with its own commit | 0.57 | Writers are canonical from 0.57, so a saved file is canonical anyway; the bulk rewrite is the wizard's. |
| G-3 | Git | Secret findings | High confidence blocks the commit, low warns; reviewed allowlist | 0.58 | Today everything blocks; the change is named in What's new. |
| G-4 | Git | Large datasets | Warn at 5 MB, LFS offered at 50 MB, refused at 100 MB or more without LFS; track by reference | 0.58 | One size facet (C12). |
| G-5 | Git | HAR sessions | Ignored, with an explicit Share session | 0.58 | Ignore glob `debugger/**/*.har` (C18). |
| G-6 | Git | One file per request | Not built (GIT-303 stands) | — | Import still **reads** Postman v3 / OpenCollection multi-file folders (backlog / 0.56). |
| D1 | Import | Scripts | Always convert to `tp.*`, with the existing alias as the safety net; `--keep-pm` stays | 0.50 (Bruno lines), 0.56 (AST) | — |
| D2 | Import | Auth types | Build EdgeGrid, Hawk, NTLM; ASAP via JWT; WSSE as a header generator; a typed `unsupported` holder otherwise | 0.50 (never inherit), 0.56 | NTLM is the riskiest piece, and the first cut if time is short. |
| D3 | Import | Postman API key | Optional, typed by the user, in the secret store | 0.56 stretch (IMP-205) | **Flag:** its item (IMP-205) belongs to import-compat B. It is scheduled as a stretch item in 0.56, else the backlog. |
| D4 | Import | `bru.runRequest` / `tc.runRequest` | Add `tp.execution.runRequest(name)` | 0.56 | — |
| D5 | Import | CLI default for several files, a zip or a folder | Preview first | 0.55 | Harmonised with the bundle rule (C7). |
| D6 | Import | Folder headers and settings | Real model fields | 0.56 | **Flag:** types.ts is at 879 of 900, so the fields go in new modules. They touch the runner, editors, merge, and three exporters. |
| D7 | Import | Placement | "Migrate from…" on Home | 0.55 | — |
| R-1 | RAG | Placement | Under Evaluations, plus an AI Lab ▸ RAG tab | 0.60 | — |
| R-2 | RAG | Default judge | The large tier; no judge means an error with a setup hint (one release keeps the old default as a setting) | 0.61 | — |
| R-3 | RAG | `hallucination` | Becomes lower-is-better in R2; `faithfulness` unchanged | 0.62 | — |
| R-4 | RAG | Python interop | Ragas / DeepEval export and import only, no bridge | 0.60–0.62 | — |
| R-5 | RAG | Custom metric sharing | Workspace files plus import/export | 0.61 | Through the bundle (kind `metric`), so `rag metric import/export` is a thin wrapper. |
| R-6 | RAG | R1 size | Split into R1a and R1b | 0.60, 0.61 | — |
| R-7 | RAG | Monitors | Local and free metrics by default | 0.64 | — |
| R-8 | RAG | Images to the judge | Not answered yet; proposed: as data | 0.63 | **Open:** ask the owner before 0.63. |
| P-1 | Process | AI tests | Mock provider; live runs opt-in by the owner; no agent uses API keys | all | — |
| P-2 | Process | Commits | Explicit paths, never `docs/public/llms.txt`, the no-reply identity | all | — |
| P-3 | Process | Order | Ghost row → security / data loss → flow → registry + menus → export/import → import-compat A → git → AI-8/9/6 → RAG → refactor | all | Kept; the moves in §2.2 are all forced by dependencies. |

---

## 5. Risks and cuts

### 5.1 The biggest risks

| Risk | Where | How the plan reduces it |
|---|---|---|
| **The registry refactor breaks behaviour** | 0.52 | Snapshots of every old table are written before any change, then one derived table per commit with the snapshots byte-identical. Menus change only after the adapters are proven. The `planned` markers keep the gaps honest. The grep allow-list makes stragglers visible. The adapters stay until 0.65, so a late-found difference has a fallback. |
| **Workspace migrations** (tree-state keys; library `updatedAt` to meta; the canonical rewrite; new `disabled` and folder fields; dataset folders; data.changed kinds) | 0.52, 0.53, 0.56, 0.57 | Every migration is **additive or one-time and explicit**: old keys are read once; the canonical rewrite happens only through Fix git setup, with its own commit; new fields are optional and older versions ignore unknown keys; data.changed carries legacy and canonical kinds for two releases. Each migration gets a test on a copy of the examples workspace and of the owner-style large workspace. **Mixed versions in one team:** an older TestPion re-adds `updatedAt` on save. The serializer strips it on read, so the churn stops once everyone upgrades; What's new says so. |
| **The merge driver** (new kinds; no-base merge for bundles; older drivers meeting new attributes) | 0.54, 0.57, 0.58 | One function per strategy with one test suite shared by git and the bundle. The per-kind merge tests and the completeness test require a fixture triple. A **mixed-version test** checks that an older driver falls back to a line merge, never corrupts, for `mcp-servers.json` / `providers.json`. MCP display order is kept (ours' order, theirs' additions appended), as the library merge does. |
| **`git status` speed on 9,000 items** | 0.57, 0.58 | Status is cached by the `data.changed` epoch. The semantic description is cached per `(path, blob sha)`, and unchanged files are never parsed. Container counts are computed once per change, not per row. Marks are primitives into memoised `TreeRowShell`s. The 200 ms warm budget is in the perf suite as a ceiling that fails the run. |
| **Test flakiness across OSes** | every release | Lexical path checks everywhere (`kinds/paths.ts`). Completion-signal waits only. Line-ending normalisation in goldens. No dependence on case-sensitivity or on the order of file-system events. Temp workspaces per test. The mock AI provider. CI on 3 OS before every tag. A flake is a bug with a root cause (FL-6 starts with the known `core` flake). |
| **Secret leakage through export or git** | 0.50, 0.53, 0.58 | One detector; deny-by-default for MCP `headers`/`env`; the stripped list shown before writing; fixture-secret greps over every bundle and commit test. |
| **Malicious bundles and imports** | 0.53, 0.55 | Hard limits, lexical paths, no symlinks, checksums, nothing executes on import (scripts never evaluated, stdio servers disabled, mocks not started, no URL fetched), and the hostile fixture suites. |
| **Scope: about 6–7 months** | all | The cut list below, and a release table that can stop after any release with a coherent product. |

### 5.2 What to cut or defer if time is short (the first cut first)

1. **Import-compat B** (Thunder, Yaak, HTTPie, Postman v3, exporters to Insomnia and OpenCollection, re-import by
   provenance). Already in the backlog.
2. **Export C** (`uses` association, ownership). Already in the backlog.
3. **Git polish:** the CODEOWNERS generator, textconv, Share session, blame. Keep history, restore, discard and
   conflicts.
4. **RAG R3 multimodal and DAG, then R4 test-set generation.** Keep R1a, R1b and R2: connect, free metrics, the triad,
   judged metrics, custom metrics.
5. **AI-12, then AI-9.** Lower value than AI-8 and AI-6.
6. **Item-level staging (GE-B2).** The riskiest git piece. Keep stage by file and discard by item.
7. **NTLM** (D2). Keep EdgeGrid and Hawk; an NTLM request then imports with the typed `unsupported` holder and a
   finding.
8. **Menus typeahead and the `*` key.** Keep Shift+F10 and multi-select.
9. **Postman data dump and v1.** Keep v2.x and environments.

**Never cut:**

- the ghost-row fix;
- the security and data-loss fixes;
- the registry adapter with its equivalence snapshots and completeness test;
- per-kind Export/Import and bundle v1;
- "no silent drops" and the import report;
- git ChangeMark and per-kind diff;
- the perf gates and the release process.

---

## Appendix A: where each plan item lands

| Plan | Items → release |
|---|---|
| menus-uniform | P0-1 → 0.50; phases 1–3 → 0.52; phase 4 → 0.53 |
| export-import | G1, G2, G3, G5, G6 (spec, mcp-server) → 0.50; G6 rest, G7 CLI, release A → 0.53; G4, G7 MCP, release B → 0.54; release C → backlog |
| git-everything | release A → 0.57; release B + C1/C2 → 0.58; C3 (CODEOWNERS) → backlog; the secret detector (§4e core) → 0.50 |
| import-compat | IMP-102/107/110/111 slices (IMP-FIX-1…4) → 0.50; IMP-101…105, 108, 113a → 0.55; IMP-106, 107, 109…112, 113b, 114 → 0.56; IMP-205 → 0.56 stretch; IMP-201…208 and release C → backlog |
| ai-features | AI-4, AI-10 → 0.51; AI-1/2/3 leftovers (FL-1…4) → 0.51; AIB-1 leftover (FL-8) → 0.51 stretch; AI-6, AI-8, AI-9, AIB-6/9/10 leftovers → 0.59; AI-12 → 0.59 stretch; AI-11 → 0.64; AI-7, AI-13…15 → backlog |
| rag-testing | R1 → 0.60 + 0.61; R2 → 0.62; R3 → 0.63; R4 → 0.64 |
| workflow-ux | the "Left in excluded files" items, WF-01/02 Shell leftovers, UX-R5 test files → 0.51; UX-R6 for the other editors, WF-03 (git conflicts / secrets / lint in Problems) → 0.58 (the git and secret work makes them cheap) |
| memory notes | ui-gap-hunt audit before every freeze (§3.0); quality-bar perf, soak and robustness in every regression; cloud-ready: everything in core and over RPC, `WorkspaceStore` only; cloud-last: reminder after 0.65 and the chosen backlog |
