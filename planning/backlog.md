# TestPion backlog (owner requests, in build order)

The owner's standing instruction: create this backlog, then **implement the items one by one**, researching each first, and
keep **consistency** (one shared component/mechanism per pattern), **compatibility** (Postman, Insomnia, Bruno, git, all three
OSes), **performance** (the budgets in planning/ and the perf plans), **clean code** (caps, no duplication) and **user
friendliness** (clear messages, undo, preview before apply, keyboard route) in every item. The detailed build order and the
shared item-kind registry are in planning/master-roadmap.md (written by the architect pass; it wins over this list if they
differ). Status values: `todo`, `in progress`, `done (version)`.

## Process for every release

freeze → UI-gap-hunt audit → full regression agent → docs agent → audit-fix agent → release.py → screenshots → commit with
explicit paths (never docs/public/llms.txt, never `git add .`) → tag → push → **CI green on Windows, macOS and Linux** →
install on the owner's machine → short summary to the owner (they follow from mobile).

Lessons baked in: no OS-specific path semantics in validation (use storage/test-path.ts style checks), tests wait on
completion signals not timers, AI tests use the mock provider (the live scorecard is opt-in with the owner's key as an inline
environment variable only).

## Done

- Flow designer, canvas, Deploy/webhooks, scale runs, Terminal, openRef, Quick Open, Problems, preview tabs, rail, keyboard
  settings, density, undo toasts, production guard, per-workspace UI state (0.45.x–0.47.0).
- AI foundations, AI integration flow from a collection/folder, verified assertions/tests, `flow generate` (0.48.0/0.48.1).
- Failed-run triage, flaky-test analysis, tp.* script reference (0.49.0, in release).

## Backlog

### P0 · visible damage and silent data/security problems (fix first, design-independent)

| id | item | source | status |
|---|---|---|---|
| B-01 | **Ghost / repeated rows in the sidebar tree — ROOT CAUSE CONFIRMED (2026-10-17): duplicate React keys.** Tree rows are keyed by request id only (`CollectionTree.tsx:910`), and the examples workspace has request ids shared by several collections (`sse-wikimedia` in live-streams.json + streams.json; 7 `gq-*` ids in graphql.json + graphql-public.json), so React draws one row at several list positions and drops the others (owner screenshots 3–6). Fix: scope EVERY row key by collection id (and section/kind) in all trees (CollectionTree, FolderList, Explorer sections, Tests tree); a dev-mode duplicate-key warning + a unit test that renders a tree with two collections sharing ids; ids stay per-collection (cross-collection copies are legitimate) but import/duplicate/bundle import must remap ids on collision; dedupe the examples workspace data (why two 'Live streams (SSE)' collections?); keep the drag-image hardening (setDragImage chip, window drag cleanup, deferred drop actions, paint containment) as secondary; e2e `tree-ghost` with two collections sharing ids (every `[data-node-id]` unique + inside the scroll box) | menus-uniform.md P0-1 (cause revised) | todo — FIRST item |
| B-02 | Export Workspace silently omits specs/, datasets/, mocks/, protos/ and test files ≥ 5 MB (G1) | export-import.md | todo |
| B-03 | MCP server secrets (header tokens, stdio env) leak into exports (G2) | export-import.md | todo |
| B-04 | OpenAPI import silently overwrites a same-named spec (G3); default export name `apsworkspace` (G5); trash covers only collections/environments/datasets (G6) | export-import.md | todo |
| B-05 | Import: unsupported Postman auth (NTLM/Hawk/EdgeGrid/JWT/ASAP) silently becomes "inherit" → must become none + a finding | import-compat.md | todo |
| B-06 | Import: Insomnia template tags left literal, v5 YAML request scripts dropped, Bruno scripts not converted / `.env` skipped | import-compat.md | todo |
| B-07 | Flow view of a dataset-driven test file: canvas edits fail ("No step … in the flow") | 0.49.0 regression report | todo |
| B-08 | GitHub Action job summary does not read triage.md; AI prompts tab never closes the last tab; investigate the `core` e2e flake (stray input) | 0.49.0 reports | todo |

| B-09 | **Download / export for every output** (owner, 2026-10-17): one shared down-arrow `OutputDownload` control on EVERY output surface in the app (response body in every mode, headers, timeline, trace, console, run results, test/flow results and timeline, load results, evaluation and RAG matrices, AI results/proposals/triage/flaky reports, Debugger exchanges/sessions, history, monitors, git diffs, MCP tool results, WebSocket/SSE/MQTT/Kafka message logs, GraphQL/gRPC results, generated code, JWT/cookies, terminal output, …): format menu by content type (JSON/raw/CSV/HTML/XML/Markdown/HAR/cURL/patch/PNG/binary), Save as… through the OS save dialog, Copy, big outputs streamed, redaction choice for log-like outputs, filename templates; CLI/MCP parity (`--out`); plus fix the clipped "Expand all"/filter/hint toolbar in the JSON tree (owner screenshot 7). Research DONE: planning/output-export.md (81 surfaces, 69 without download; one OutputDownload split button + useOutputExport hook + shared format-builder registry + streaming output.save RPC + OUTPUT_SURFACES completeness test; Ctrl+Shift+S). Schedule: toolbar glitch fix (shared OutputToolbar, overflow-clip, filter basis, hint → ⓘ) + the missing `app.saveText` handler ride in release 0.50; Release A (component, registry, response viewer, JsonTable, SSE/WS logs, run results, console/logs/terminal/problems, matrices/grids, redaction policy, docs) = its own release right after 0.50; Release B (remaining surfaces, CLI --out/--format, MCP save_to) after that | owner request | todo |

### P1 · flow and integration testing (owner order: before RAG)

| id | item | source | status |
|---|---|---|---|
| B-10 | AI-4 tests from an OpenAPI spec, gap-driven (positive/negative/boundary/security) + "From a spec" in the flow generate dialog | ai-features.md | todo |
| B-11 | AI-10 import cleanup (Postman/curl/HAR → tidy collection + flows, variables, chaining) | ai-features.md | todo |
| B-12 | Flow leftovers: per-step diff vs the deterministic draft in the flow review; Tests-view generators from a run's stored response; "Prefer stable checks" setting | ai-features.md | todo |
| B-13 | AI-8 security tests (BOLA/auth/mass-assignment, deterministic verdicts) | ai-features.md | todo |
| B-14 | AI-9 contract drift explained (spec vs traffic) | ai-features.md | todo |
| B-15 | AI-6 tp.* script helper + one registry for right-click "… with AI" items + setting to hide all AI actions | ai-features.md | todo |

### P1 · consistency foundation (one registry for menus, export/import, git, import)

| id | item | source | status |
|---|---|---|---|
| B-20 | Item-kind registry (adapter phase, no behaviour change) + capability-completeness test | master-roadmap.md | todo |
| B-21 | Uniform node menus: `buildNodeMenu`, TreeRowShell, tree-state; Expand all/Collapse all on every container and section header; keyboard routes; Delete with Undo; defaults: pm.* conversion under Export ▸ For Postman, Expand/Collapse before Run, Copy as ▸ submenu, dataset folders; multi-select next | menus-uniform.md | todo |
| B-22 | Export/Import for every kind: bundle v1 (`.testpion.zip/.json`), per-section/per-item Export… Import…, collection-centred "Export with everything it uses…", preview + conflict choices (Keep both default), one-step undo, CLI `export --with` / `import --preview/--apply`, MCP tools; imported stdio MCP servers start disabled; providers excluded by default | export-import.md | todo |
| B-23 | Import compatibility release A: intermediate model, compatibility report, preview/undo, drag-and-drop, AST script converter v2 (always convert to tp.*), Insomnia tags/chaining, dynamic variables, EdgeGrid/Hawk/NTLM auth, Bruno OpenCollection YAML/.env, Postman data dump, corpus + golden tests, migration guides, "Migrate from…" on Home | import-compat.md | todo |
| B-24 | Import compatibility release B: Thunder Client, Yaak, HTTPie, Apidog, GraphQL schema, Postman v3/Native Git; exports to Insomnia/OpenCollection; repo/URL import; MCP `export_collection` / `convert_scripts` | import-compat.md | todo |
| B-25 | Everything under Git, release A: stable serializers for every kind, change marks on every row and section header, Git view rows by item name with semantic diff, `.gitignore`/`.gitattributes` fixes, merge driver for mcp-servers/providers | git-everything.md | todo |
| B-26 | Everything under Git, release B: per-item History/Restore/Discard/Stage/Blame/Stash, conflict resolution for every kind, staged-file secret scan, CLI/MCP parity | git-everything.md | todo |
| B-27 | Everything under Git, release C: "Fix git setup", readable-diff driver, LFS/track-by-reference for datasets, Share session, CODEOWNERS template | git-everything.md | todo |

### P2 · RAG testing (after the flow/integration and consistency work)

| id | item | source | status |
|---|---|---|---|
| B-30 | RAG R1: connect any endpoint (HTTP/SSE/WebSocket/gRPC/MCP) with click-to-map, datasets + Ragas/DeepEval import, judge service (cache, ledger, caps, no silent mock), all non-LLM + IR metrics, RAG triad, custom judge/rule/formula metrics, picker with presets + try-on-one-sample, samples×metrics matrix, CLI/MCP; Ragas names as aliases | rag-testing.md | todo |
| B-31 | RAG R2: all remaining LLM-judged retrieval/generation/claim-level metrics; custom checklist/embedding/script metrics; SQL metrics with the read-only executor | rag-testing.md | todo |
| B-32 | RAG R3: conversational, agent/tool, judged safety, multimodal, decision trees; every catalogue row runnable | rag-testing.md | todo |
| B-33 | RAG R4: test-set generation from documents, capture from traffic, judge calibration (kappa) + AI-11 evaluation authoring, monitor and CI polish | rag-testing.md, ai-features.md | todo |
| B-34 | AI-12 natural-language search over history/runs/traces | ai-features.md | todo |

### P3 · always on

| id | item | status |
|---|---|---|
| B-40 | UI-gap-hunt audit before every freeze; fix gaps in the shared component with an enumerating test | always |
| B-41 | Refactor + cleanup release after RAG: dedupe helpers, dead code, split big modules, one mechanism per concern, re-measure perf/leaks, full regression before/after, no new features | todo |
| B-42 | Cloud integration — only when the on-prem backlog above is exhausted: REMIND the owner | todo |

### Owner actions (not engineering)

- Add the `NPM_TOKEN` repository secret so the CLI package publishes to npm on release (currently skipped).
- Decide whether to merge the proposed additions into `docs/public/llms.txt` (kept uncommitted; proposals are in the scratchpad `llms-additions-*.md`).
- Revoke the OpenAI key pasted in chat for testing.
