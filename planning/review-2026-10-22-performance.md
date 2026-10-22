# Performance review (non-UI) — 2026-10-22

Read-only review of the engine (`packages/core`), `packages/shared`, the CLI (`packages/cli`), the desktop backend (`apps/desktop/backend`), the Electron main process (`apps/desktop/electron`) and the MCP server (`packages/core/src/mcp-server`) at commit `4d4b21a8`, against the quality bar "clean and super fast in all cases". The renderer was audited yesterday (`planning/ui-audit-2026-10-21-performance.md`); its backend items F-26/F-28/F-30/F-32/F-33/F-35 are done and not repeated. Everything below cites `file:line` of the current tree; measurements were taken today on the owner's machine (Node 26.5.1, Windows 11, other agents running) with the fresh build of 07:35 and are marked as such. Scratch files (profiles, the 1,000-request collection, the local server) are in the session scratchpad, not in the repo.

Severity: **P0** breaches a budget, or blocks the Electron main thread / event loop for more than 50 ms in a realistic case · **P1** measurable waste · **P2** hygiene. "Gate" names the test that would pin the fix.

## 0. Summary

- Two existing gates misbehaved today: `tests/unit/git-perf.test.ts` **failed** its 700 ms status budget (1,057 ms, median of three, 300 changed of 9,000 items) when run next to four other perf files, and passed in the first run of ten files; `tests/unit/core-scale.test.ts` "runs more than a thousand requests in one go" **failed once** with `passed 2599 ≠ 2600` (a dropped or failed request in a 2,600-request local run; not reproduced). Both need a quiet rerun before release.
- The runner's per-request cost is **~2.2 ms** of CPU above the server's latency (1,000 requests with a 2-line `pm.test` script: 2.81 s run, p50 0.6 ms server) and **~70 %** of it is QuickJS (`runScriptOnce` 2.7 s inclusive of 5.3 s profiled). Traces at `--trace all` add **1.5 ms per request** (1,000 synchronous `writeFileSync` + SHA-1 + SQLite rows).
- The desktop backend runs on Electron's UI thread (`apps/desktop/electron/main.ts:372`, `:302-307`): every synchronous item below (trace batches, fsync'd variable saves, prune `rmSync`s, `Atomics.wait` rename retries, load-test percentile sorts) is UI jank, not just CPU.
- CLI: `--version`/`--help` **135-170 ms** (the fast path works; `node -e 0` is ~147 ms on this box); any real command **320-500 ms** to the first line of work (bundle 4.9 MB; 264 ms of CPU, of which 77 ms is evaluating `dist/bundle.js`, 30 ms undici + `node:dns` pulled in at startup, 10 ms `buildProgram`). Unbundled fallback: 1.4 s warm, **27.8 s** on a cold disk cache (first run today).
- MCP server: **~580 ms** from spawn to `initialize` warm (2.5 s cold), `tools/list` **336 KB** for 202 tools (10-20 ms warm, 375 ms the first time), tool calls 4-66 ms on the examples workspace. Creating the server scans every test file under `tests/` for `expose:` blocks (67 ms of the 332 ms server construction on the examples; grows with the workspace).
- Electron main bundle `dist-electron/main.cjs` is **17.4 MB** (+30.6 MB map, excluded from the package); evaluating the sibling `cli.cjs` (16.5 MB) costs **310-340 ms** in-process, 192 ms of it V8 compile (`wrapSafe`) that `boot.cjs`'s compile cache removes on the second start, 28 ms reading the file. 1.2 MB of zod, 0.6 MB each of kafkajs / node-forge / grpc-js / mysql2, 0.54 MB iconv-lite are in it.

### Measurements

| What | Result (today) | Budget / reference |
|---|---|---|
| `testpion --version` / `--help` (fast index) | 132-202 ms / 147-173 ms | `cli-fast-path.test.ts`: quick < full / 2.5 (holds: 135 vs 320-500) |
| `testpion --version`, full CLI, bundle | 323-499 ms; CPU profile 264 ms total | — |
| `testpion --version`, full CLI, unbundled (`TESTPION_UNBUNDLED=1`) | 1,409 ms warm, **27,799 ms** first (cold cache) | — |
| `testpion collections --json` (examples) | 381-453 ms | — |
| `testpion run-collection` 1,000 GET + `pm.test` script, local server, `--trace none`, json reporter | wall 3,414 ms; run 2,810 ms; p50 0.6 ms / p95 1.1 ms server | `core-scale`: 10,000 requests < 5,000 ms (in-process, no scripts) |
| same, `--trace all` | wall 4,947 ms (+1.5 ms per request) | — |
| results.jsonl / report.json for that run | 5.39 MB / 5.40 MB (5,385 bytes per row; `output` = 4,803 bytes) | — |
| MCP `initialize` after spawn | 565-583 ms warm; 2,538 ms cold | `scale-hot-paths`: `createTestPionMcpServer` < 500 ms (6 ms measured in-process) |
| MCP `tools/list` | 336,273 bytes, 202 tools; 8-13 ms warm, 375 ms first | — |
| MCP `list_collections` / `search_workspace` / `list_environments` | 34-42 ms / 26-66 ms / 4-11 ms | — |
| `git status --porcelain=v2 --branch -z -uall` on this repo (2,341 files) | 83-94 ms | — |
| `git-perf`: status by item, 300 changed of 9,000 | **1,057 ms (FAIL)** in a 5-file run; passed in a 10-file run | < 700 ms |
| `git-perf-batch`: 300 modified files | 2 git processes, 1,066 ms; 5,000 new files 1,009 ms, longest block 16/31/16 ms | ≤ 3 spawns; block < 50 ms |
| `scale-hot-paths` | listCollections (10k requests) 32.5 ms; getCollection ×50 41.5 ms; listHistory page 1.8 ms, deep offset 1.1 ms, failed-only 5.6 ms (100k rows); historyByCollection 10.4 ms | all well inside |
| `import-perf` | Postman 3.5 MB (10k requests) and Insomnia 8.3 MB pass | preview < 1,500 ms, apply < 3,000 ms, heap < 400 MB |
| `watcher-scale` | 20,000-file open returns in 51 ms | < 500 ms |
| `require('dist-electron/cli.cjs')` in-process (16.5 MB) | 310-340 ms (192 ms compile, 28 ms read, 19 ms `__init`) | — |

## 1. Hot paths per operation

### 1a. Send one request from the app (`apps/desktop/backend/send.ts:36-211`)

Per send, in order, on the main thread: `requireEnvironment` → `listEnvironments()` (`send.ts:41` → `storage/env-edit.ts:14` → `workspace.ts:344-352`: readdir + parse + normalise **every** environment file; the frozen `environmentView` cache at `workspace.ts:244-251` is bypassed here) · `be.context` → `createEngineContext` (`engine.ts:98` `syncCustomMetrics` stat walk, `:110` environmentView readdir+stat per env file, `:115` collectionView, `:123` `getMcpServers`, `:131` `getProviders`) · the HTTP send (`client.ts`) with a payload file for **every** body (`client.ts:565-569`: `mkdirSync` + `createWriteStream` even for a 50-byte body) · `runChecks` · one QuickJS pass **per script** (collection, each folder, request; `send.ts:124-137`), each with the whole `bodyPreview` stringified into the VM (`:130`) · `saveTrace` (`workspace.ts:520-524` → `writeDerived` sync `writeFileSync` + SHA-1 fingerprint `fsutil.ts:400-408` + `addTrace`) · `addHistory` (`metastore.ts:479-498`, prepared) with a `SELECT COUNT(*)` prune every 200 inserts and on the **first** insert of every process (`:461-462`; `inserts` starts at 0) · `recordCertificate` · the console entry, which re-parses, deep-copies and pretty-prints the full request and response bodies before clipping to 16 KB (`send.ts:184-191`, `:202-203`) · the RPC result carrying `bodyPreview` (≤ 2 MB), `json` (parsed again), `prepared` and all SSE events (`:211`) through structured clone. Each `tp.environment.set` in a script does an atomic write with `fsyncSync` of `current-values.json` (`current-values.ts:69` → `writeJson`; wired at `backend.ts:605-611`).

Count for a plain JSON send with one test script that sets one variable: 1 readdir + N env parses (requireEnvironment) + 1 readdir + N stats (environmentView) + `.local/meta.json` parse + providers + mcp-servers parses + `metrics/` stat walk; 1 mkdir + 1 payload file create/write/close; 1 trace `writeFileSync` + SHA-1; 2 SQLite inserts (+ `COUNT(*)` once per 200); 1 temp file + fsync + rename (+ SHA-1) for the variable; 3 JSON.parse of the body (client `json`, `safeBody` ×1 per side, prelude `jsonBody()` per assertion) and 3 pretty-prints (console ×2 + trace summary). None is individually slow for a small body; all of it scales with body size and runs on the UI thread.

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| S-1 | P1 | `send.ts:41` → `env-edit.ts:14-16` → `workspace.ts:344-352` | `requireEnvironment(be.ws, …)` lists and parses every environment file per send (text cached, parse not: `fsutil.ts:412-418`); `engine.ts:110` then reads the frozen view too. | `requireEnvironment` through `environmentView` (`workspace.ts:244`) or a shared `listEnvironmentsView()` keyed by the same signature. | `core-hot-paths`: 100 sends with 20 environments parse 0 files after the first. |
| S-2 | P1 | `client.ts:565-569`; `send.ts:90`, `:300` | Every interactive HTTP/GraphQL response is spooled to `payloads/resp-*.bin` (sync `mkdirSync` + stream open/close) even when it fits the 2 MB preview; history keeps up to 20,000 such files. | Spool only when `truncated` (size > `maxPreviewBytes`); keep the preview as the body otherwise. | Unit: a 1 KB response leaves no file in `payloads/`. |
| S-3 | P1 | `send.ts:300`, `:328`; `metastore.ts:461-469`, `:557-559` | GraphQL sends pass `payloadDir` but `addHistory` gets no `payloadPath`, so the file is never pruned or cleared: a disk leak of one file per GraphQL send. | Pass `payloadPath: r.response.payloadPath` (or no `payloadDir` for GraphQL). | Unit: after 10 GraphQL sends + `clearHistory`, `payloads/` is empty. |
| S-4 | P1 | `send.ts:184-191`, `:202-203`; `send.ts:342` (GraphQL) | `safeBody` = `JSON.parse(bodyPreview)` → `redact` (deep copy) → `JSON.stringify(…, null, 2)` for request and response, then `clipConsole` keeps 16 KB; `response.json` is already parsed. For a 2 MB body: 2 parses, 2 deep copies, ~3 MB of pretty text per send, all discarded. | Pretty-print from `response.json`, redact only a bounded slice, or clip the raw text first and pretty-print the clipped part. | Unit: console entry for a 2 MB body < 5 ms. |
| S-5 | P1 | `current-values.ts:69`; `backend.ts:605-611`, `:760` | `cv.set` → `writeJson` = temp file + `fsyncSync` + rename + SHA-1 per variable set, on the main thread; app collection runs keep `persistVariable` on unless `keepVariableValues === false`, so a token-refresh script = one fsync per request. | Debounce like `CookieJarStore` (`cookie-jar.ts:294-306`), flush at run end / close. | Integration: a 200-request app run with a setting script fsyncs ≤ 2 times. |
| S-6 | P2 | `fsutil.ts:400-409`; `workspace-watcher.ts:25` | `writeDerived` hashes every trace (and `runs/*` summaries) for own-write detection although `traces/` and `runs/` are in the watcher's `IGNORED_TOP`. | Skip `recordOwn` under ignored roots. | — |
| S-7 | P2 | `send.ts:211` | The RPC result carries `bodyPreview` and `json` of the same body plus up to 10,000 SSE events already streamed on `http.sse`. | Return `json` only when the renderer asks (it parses the preview itself) and drop `events` from the final result. | e2e: `http.send` result for a 2 MB JSON ≤ 2.1 MB serialised. |
| S-8 | P2 | `metastore.ts:461-464` | Prune runs a `COUNT(*)` on the first insert of every process (CLI: every invocation) and prepares the `SELECT … LIMIT` anew each time; at the cap it `rmSync`s ~200 files synchronously inside the send (`:469`). | Start `inserts` at 1 or use `MAX(rowid)`; cache the statement; delete files async. | — |
| S-9 | P2 | `workspace.ts:293-297` (`readScriptPackage`) | `existsSync` + `readFileSync` per `tp.require` per script run, uncached (`send.ts:20`). | mtime-keyed cache. | — |

### 1b. Run a collection of 1,000 requests

Measured per-request overhead ≈ 2.2 ms (CLI, `concurrency: 1` by design, `collection-run.ts:230`). From the CPU profile of the 1,000-request run (5.3 s sampled, 0.4 s idle): `runScriptOnce` 2,716 ms inclusive (QuickJS wasm ≈ 2.3 s), `executeHttpAttemptOn` 370 ms, `exec`/`runOne`/`executeStep` ≈ 300 ms, `Writable.write` 165 ms (results.jsonl), `redact` 48 ms + `summarize` 24 ms self, module load ≈ 300 ms.

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| R-1 | **P0** | `runner.ts:294-313` (`traceBatch`), `backend.ts:777-779`, `cli/src/run.ts:210-214`; `workspace.ts:520-524`; `fsutil.ts:392-409` | At `--trace all` the trace batch (up to 500, `runner.ts:318`) runs `saveTrace` for each **inside** `meta.batch` (one SQLite transaction): 500 sync `writeFileSync` + `Buffer.from` + SHA-1 + `JSON.stringify` + INSERT in one synchronous block. Measured 1.5 ms per trace in the CLI → a full batch ≈ **750 ms** holding the write lock and, in the app, the UI thread. | Write trace files with `fs.promises` outside the transaction (keep only INSERTs in `batch`); skip the fingerprint (S-6). | `runner-trace-queue.test.ts`: a 500-trace batch blocks the event loop < 50 ms (measure with a `setInterval` lag probe like `git-perf-batch.test.ts:131`). |
| R-2 | P1 | `runner.ts:280-282`, `:330-331`, `:236`; `:235` | `dep(r.id).resolve(…)` creates a Deferred for **every** result and `statusById`/`seen` keep every id for the whole run, whether or not anything `dependsOn` it. Data-driven runs (1,000 requests × N iterations) hold N×1,000 promises + map entries until the end. | Create deferreds only for ids named in some `dependsOn`; keep `statusById` only for those. | `core-scale`: heap growth for 10,000 steps already gated (< 120 MB); add a 100,000-iteration dry run with a 150 MB cap. |
| R-3 | P1 | `execute.ts:421` (`:329`, `:374`, `:536`, `:660` same), `:120-123`; trace `tracer.ts:83-87` | `summarize(svc.redactor.redact(response.json ?? bodyPreview))`: a full deep copy and `JSON.stringify(…, null, 2)` of up to 1 MB per step to keep 4,000 characters. Measured 72 ms self for 1,000 × 2.6 KB bodies; linear in body size. | Summarise from `bodyPreview` text (cut first, redact the slice); redact `json` lazily. | Unit: `executeTest` on a 1 MB JSON body allocates < 100 KB for `output`. |
| R-4 | P1 | `execute.ts:251-264`; `sandbox.ts:380` | The script input carries the body twice (`response.body: ctx.text` and `data.body: ctx.body`) and is `JSON.stringify`'d into the VM per pass; the prelude re-parses `res.body` on every `jsonBody()` / `response.json()` call (`prelude.ts:337`, `:454`). The app runs the collection, folder and request scripts as separate passes (`send.ts:124`). | Pass the body once (text) and let the prelude parse lazily, memoised per pass; one VM pass with the three scripts concatenated under separate closures. | Unit: 20 `pm.response.json()` calls parse once. |
| R-5 | P1 | `runner.ts:265`, `execute.ts:118-123`; reports | A result row is 5.4 KB of which `output` (pretty body, 4,000 chars) is 4.8 KB: 1,000 requests = 5.4 MB results.jsonl + 5.4 MB report.json; the app shows 500 chars (`backend.ts:784`). 100k results = 540 MB on disk and the same again to index (`run-results.ts:121-131`). | Cap `output` at ~1,000 chars (or store compact JSON, pretty-print on display); keep the full body in the trace when traced. | Unit: a result row for a 50 KB body ≤ 1.5 KB. |
| R-6 | P2 | `sandbox.ts:366-372`, `:379-381`, `:422-427` | Per script: `reset` rebuilds every prelude object, `check` verifies intrinsics, plus `JSON.parse` of the output; ≈ 2.3 ms of QuickJS per 2-line script. Intrinsic to the design; the lever is fewer passes (R-4) and skipping the test-script VM entirely when a request has no script (already done: `sandbox.ts:359`). | — | Promote the number: `core-scale` could log ms/script. |
| R-7 | P2 | `collection-run.ts:56-60`, `:180-181` | Setup discovery scans backwards per (request, variable) and `queue.shift()` is O(n); `setNextRequest` does two `findIndex` per jump. ~1,000 × V × 1,000 worst case for a rerun. | Index maps by id/name; last-setter map per variable. | — |

### 1c. Import 10,000 requests

The `import-perf` gate passes (Postman 3.5 MB, Insomnia 8.3 MB; preview < 1.5 s, apply < 3 s, heap < 400 MB) and `import-workspace-perf` counts `listCollections` calls (≤ 1-2) and files written (≤ 31). Not covered by gates:

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| I-1 | P1 | `import/reimport.ts:142-148`, calls at `:176`, `:200`, `:275`, `:311`, `:314`; `:254-258` | `locate()` walks the whole tree per node and is called from 6 places; `applyReimport` runs `planReimport` and then `findUpdateTarget` again (re-reads the store) and deep-clones the collection twice via `JSON.parse(JSON.stringify())`. A 10k-node re-import ≈ 6 × 10k × ~5k node visits. | One id → {node, list, index} map per tree; pass the target from the plan. | `import-perf`: re-import of the 10k Postman file < 3 s. |
| I-2 | P2 | `import/thunder-import.ts:240-241`, `:258`; `yaak-import.ts:116-117`; `postman-versions.ts:284-301`, `:76`; `opencollection-import.ts:39`; `bru.ts:192`; `insomnia-import.ts:161` | Per-folder `filter`/`find`/`some` over all requests or files: O(folders × items). Insomnia v4 already uses a `children` map (`insomnia-import.ts:271-276`). | Group by parent once. | Add Thunder/Yaak/Bruno 10k fixtures to `import-perf`. |
| I-3 | P2 | `import/inputs.ts:145-154` | Folder imports are assembled into objects, stringified to one text and parsed again by the importer (Yaak: YAML → object → JSON → object). | Pass the object. | — |
| I-4 | P2 | `backend/handlers/import.ts:34-47` | Up to 8 previews × "up to 200 MB of text" kept 30 min; expiry only on the next remember. Uploads arrive base64 → Buffer → text (3 copies). | Keep only paths/offsets for files on disk; shorter TTL; a timer. | Unit: `rememberSession` drops expired entries on a timer. |

### 1d. Git status with 9,000 items

`git.ts:211` uses `status --porcelain=v2 --branch -z --untracked-files=all -- .` (right flags); `git-perf-batch` holds spawns to ≤ 3 per refresh and blocks < 50 ms (16/31/16 ms measured); repo roots are cached (`git.ts:150-159`). Raw `git status` on this 2,341-file repo is 85 ms, so the 1,057 ms "by item" figure is dominated by reading 300 blobs and the semantic diff, and by machine load.

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| G-1 | **P0** | `tests/unit/git-perf.test.ts:16`, `:86-91` | Budget breach today: 1,057 ms vs 700 ms (median of 3) when 5 perf files run in parallel; 1,066 ms for the same work in `git-perf-batch` (2 processes). Passed in the earlier 10-file run. The gate is at the edge on a loaded box. | Rerun alone before release; then either give it `TESTPION_PERF_SLACK` like `import-perf.test.ts:11` or make the work cheaper (G-2, A-1). | Existing. |
| G-2 | P1 | `git/semantic.ts:479-493` | `listedItems` for a library/MCP/provider file without `itemId`: `find` per id over both lists, run for `flat(x)` and `flat(y)`, with `JSON.stringify` of both sides per id: O(n²) with n = items in the file (a 9k-item library ≈ 120 M comparisons). | Two `Map`s by id; compare once. | `git-perf`: a 9,000-item library change describes < 100 ms. |
| G-3 | P1 | `git/merge.ts:167-176` | `theirs.slice(0,i).reverse().find(p => order.includes(p.id))` then `order.splice(order.indexOf(…))`, plus `order.includes` per node: O(T² · O). 500 requests added by theirs to a 1,000-request folder ≈ 250 M steps. | A `Set` of `order` and an index map. | Unit: merge of 2 × 5,000-item folders < 100 ms. |
| G-4 | P2 | `git/item-address.ts:190-191`, `:204-209` | Staging one item clones the whole collection twice (`JSON.parse(JSON.stringify())`) and canonicalises it 3 more times. | One clone; canonicalise once. | — |
| G-5 | P2 | `backend/handlers/git.ts:84-101` | `git.changes` always runs `git.status` + remote + `describeGitChanges` of every changed file (cached by signature inside); the renderer's double call per save is UI F-25. | — (F-25) | — |

### 1e. Workspace open

`WorkspaceStore` constructor: 9 `mkdirSync`, `openMetaStore` (WAL, `busy_timeout`, migration), `adoptLooseRequests` (`workspace.ts:64-102`); `ws.current` (`handlers/workspace.ts:82-88`) parses every environment; the watcher's initial walk is time-sliced (51 ms before return for 20,000 files); schedulers and the examples update are deferred (`backend.ts:280-283`). Nothing eager stands out; `ws.current` → `listEnvironments()` is the same per-call parse as S-1.

### 1f. CLI startup

`bin/testpion.js` answers `--version`/`--help` from `fast-index.json` (135-170 ms ≈ bare Node) and loads `dist/bundle.js` (4.9 MB ESM, third-party left as imports) with the V8 compile cache for everything else: 264 ms CPU for `--version` through the full program.

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| C-1 | P1 | `bin/testpion.js:41-56`; `scripts/cli-bundle.mjs:25-42` | The bundle is the whole CLI + core: 77 ms to evaluate `bundle.js` (`__init` 19 ms, module body 15 ms, `buildProgram` 10 ms with `registerRagCommands` 3.6 ms, `registerGitCommands` 3.1 ms, RAG prompt tables), plus **undici (15 ms) and `node:dns` (16 ms) loaded at startup** (`net/proxy.ts` / `net/policy.ts` imports reached from `core/index.ts`), plus `acorn`, `vm.createContext`, `crypto` algorithms — before any command runs. Every real command pays ≈ 250 ms over bare Node. | Register commands with lazy action loaders (`import()` per command module, as commander allows); keep `undici`/`dns`/`acorn` behind first use (the `lazyUndici` getter exists, `client.ts:127`, but `proxy.ts`/`policy.ts` import eagerly). | `cli-fast-path`: `testpion collections --json` on the examples < 300 ms best-of-3 on an idle box; a module census (`--cpu-prof` or `process.moduleLoadList.length` ≤ N) for `collections`. |
| C-2 | P1 | `bin/testpion.js:43-47` (fallback) | When the bundle is stale (any `tsc` rebuild of one package), the ~1,000-file load is 1.4 s warm and was **27.8 s cold** today. Dev pain only; the npm package always has the bundle. | Make `npm run build -w @testpion/core` also refresh the CLI bundle, or warn once when falling back. | — |
| C-3 | P2 | `commander` `lib/option.js:327` (`splitOptionFlags` 3.3 ms), `buildAllowedFlags` 2.9 ms | Option parsing of ~70 commands × options at startup. Follows from C-1. | — | — |

### 1g. MCP server

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| M-1 | P1 | `testpion-mcp.ts:104-108`; `tool-contract.ts:386-408`; `tool.ts:66-69` | `tools/list` is **336 KB** for 202 tools (largest: `flow_add_step` 6.4 KB, `ci_config` 4.6 KB, `rag_run` 4.6 KB); the full profile is the default. Hosts that load every tool into context pay this per session; the first list took 375 ms (lazy zod/JSON-schema work in the SDK), 10 ms after. | Default to `profile: 'minimal'` for stdio hosts that are not known to support `search_tools`, or trim descriptions/alias properties (`tool-contract.ts:390-396` adds snake_case aliases to every property). | `mcp-tool-contract.test.ts`: `tools/list` JSON ≤ 200 KB; minimal ≤ 40 KB. |
| M-2 | P2 | `testpion-mcp.ts:89`; `tools/flow-tools.ts:139`; `runner/exposed-flows.ts:112-120` | `createTestPionMcpServer` calls `exposedFlows(store)` at construction: a `TestFileScanner` pass over every file under `tests/` (YAML parse of each on the first scan; 67 ms of the 332 ms construction on the examples, in the startup profile). Linear in the number of test files; blocks `initialize`. | Scan lazily on the first `tools/list`, or only files whose text contains `expose:` (a cheap `includes` before `parseYaml`). | `scale-hot-paths`: construction with 5,000 test files < 200 ms (today's gate uses a workspace with no tests). |
| M-3 | P2 | startup profile: `mcpServer` 230 ms inclusive, `wrapModuleLoad` 280 ms | The MCP SDK (zod, `zod-to-json-schema`) is loaded as CJS from `node_modules` on every start — 2.5 s cold, 580 ms warm end-to-end. | Bundle the SDK into `bundle.js` (it is external today, `cli-bundle.mjs:38`) so the compile cache covers it. | `cli-fast-path`-style timing for `mcp-server` to `initialize` < 700 ms warm. |

## 2. Algorithms

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| A-1 | P1 | `storage/search.ts:196-200`; `:60-72` | Quick Open lowercases `title` and `text` of **every** indexed doc on every query (test files up to 200 KB each) and `definitionDocs()` re-stats every file per call. 10k docs × MBs of text per keystroke (the renderer debounces, the work per call stays). | Store lowercased text in `IndexedDoc` at index time; reuse the stat signature. | `core-scale` search gate exists (< 5 s); add "10 queries over 10k docs < 300 ms". |
| A-2 | P1 | `debugger/frames.ts:29`; `debugger/grpc.ts:57` | `buf = Buffer.concat([buf, chunk])` per chunk while a frame/message is incomplete: quadratic. A 50 MB WebSocket frame in 64 KB chunks copies ~20 GB. | Collect chunks, concat once when the length is known. | Unit: a 50 MB frame in 64 KB chunks parses < 200 ms. |
| A-3 | P1 | `debugger/frames.ts:103-104`; `protocols/http/sse.ts:33-36` | SSE parsers do `rest += chunk; rest.split(/\r\n|\n|\r/)` over the whole pending buffer per chunk: quadratic in the length of one long `data:` line. | Scan from the last searched offset. | Unit: a 10 MB single-line event in 16 KB chunks < 100 ms. |
| A-4 | P1 | `runner/flow-steps.ts:189` → `shared/src/flow-graph.ts:330-336` | `stepLine` splits the whole file and compiles 1-2 `RegExp`s per step, then tests every line: 500 steps × all lines per Flow Designer refresh. | Split once, build a name → line map. | Unit: 500-step file < 10 ms. |
| A-5 | P2 | `util/concurrency.ts:58`, `:104-110` | `queue.shift()` and `indexOf`+`splice` on cancel are O(n); `RateLimiter.acquire` filters all `reqTimes` of the last minute per call. | Ring buffer / head index; a counter window. | — |
| A-6 | P2 | `runner/runner.ts:488-489`, `:571-572`; `debug-hooks.ts:76-85`; `execute.ts:152` | `tracker.raw()` and `vars.clone()` copy every scope per step (O(V) per request). | Snapshot only on change (version counter). | — |
| A-7 | P2 | `storage/metastore.ts:841-847` (JSONL fallback only) | `historyByCollection` filters + sorts the whole history per collection. | Group once. | — |
| A-8 | P2 | `storage/variable-refactor.ts:175-176` | `structuredClone` of freshly parsed collections plus two full stringifies each. | Work on the parsed object. | — |

## 3. I/O and SQLite

SQLite (`metastore.ts`): WAL, `synchronous=NORMAL`, `busy_timeout=10000`, `cache_size=-16000` (`:358-359`); tables `history` (v2 columns `collection_id`, `request_id`, `status_ok`), `runs`, `traces`, `ai_calls`, `judge_cache`, `meta`; indexes `history_ts`, `history_kind_ts`, `history_collection_ts`, `history_request_ts`, `runs_started`, `traces_start`, `ai_calls_at`, `judge_cache_at`, and `history_trace` created lazily (`:542`). Hot inserts use the `stmt()` cache (`:348`); traces are queued and batched (`runner.ts:284-324`). `scale-hot-paths` shows pages and aggregates in 1-10 ms at 100k rows. Gaps:

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| D-1 | P1 | `storage/storage-usage.ts:93-104`; `handlers/requests.ts:116-121`; `metastore.ts:591` | `deleteRunsBefore`: `listRuns({limit: 100_000})`, then per run a synchronous recursive `sizeOf` walk + `rmSync` + an autocommitted `deleteRun` (statement prepared anew each time), all on the main thread. 2,000 old runs ≈ seconds of frozen UI. | Async sliced walk (the one `storage.usage` already uses, `:40-57`), one transaction for the rows, `rm` with `fs.promises`. | Unit: deleting 500 runs blocks the loop < 50 ms per slice. |
| D-2 | P1 | `storage/fsutil.ts:362-385` (`renameWithRetry`) | `Atomics.wait(sleepBuf, 0, 0, wait)` on Windows EPERM/EBUSY: up to ≈ 1.45 s of **synchronous** sleep in the main thread per atomic save when an indexer/AV holds the file. | Async rename with retries for callers that can await (saves from RPC handlers); keep the sync path for shutdown. | Unit with a locked file: the loop is not blocked > 50 ms. |
| D-3 | P1 | `runner/sql-exec.ts:289-291` | One `new Worker(SQLITE_WORKER, { eval: true })` per SQL query: a worker start (tens of ms), DB open, one statement, terminate. RAG SQL metrics over N samples pay it N times. | A worker pool per database key with an idle timeout. | Unit: 100 queries on one dataset < 500 ms. |
| D-4 | P2 | `storage/collection-timing.ts:17-20`; `handlers/requests.ts:110` | `listHistory({limit: 2000, requests: true})` non-brief (`SELECT *` with `doc`, JSON.parse per row) over **all** collections, filtered by `collectionId` in JS; the `history_collection_ts` index is unused. | Pass `collectionId` to the query (indexed) and `brief`-ish columns (`json_extract(doc,'$.responseMeta.timing')`). | `scale-hot-paths`: `collectionTiming` at 100k rows < 20 ms. |
| D-5 | P2 | `metastore.ts:504-516`, `:473-477` | Text filters are `LIKE '%q%'` over 4 columns with no FTS; a full page triggers a second full scan for `COUNT(*)`. `search.ts` calls `listHistory({query})`, `listTraces`, `listRuns` per keystroke and ignores the total. | A `countTotal: false` option for search; FTS5 if history search matters. | — |
| D-6 | P2 | `metastore.ts:529`, `:534`, `:545`, `:550-551`, `:571`, `:591`, `:646`, `:651`, `:476` | `this.db.prepare` per call instead of `stmt()`; `getTrace` is called up to 300× by search's `loadTraceAsync`. | Use `stmt()` (template the dynamic parts). | — |
| D-7 | P2 | `metastore.ts:609`, `:627` | `requestStats`/`historyByCollection` read `json_extract(doc, '$.responseMeta.checksOk')` over up to 5,000 rows per collection (parses the `doc` blob). | A `checks_ok` column like `status_ok` (v3 migration). | — |
| D-8 | P2 | `log/logger.ts:99-108`; `backend.ts:252`, `:563` | `fileSink` does `statSync` + `appendFileSync` per record; at TRACE level that is two sync fs calls per RPC. Default level is INFO (`backend.ts:251`), so only when turned up. | A `WriteStream` with a byte counter. | — |
| D-9 | P2 | `runner/monitors.ts:336-343`; `load/history.ts:54-61` | Append then re-read and split the whole results file per record. | Keep a line count; rewrite only when it is known to exceed `KEEP*2`. | — |
| D-10 | P2 | `runner/datasets.ts:312-314`; `fsutil.ts:241-271` | `appendDatasetRow`: `appendFileSync` + `noteOwnChange` (whole-file read + SHA-1) + `countLines` (whole-file stream): O(n) per appended row, so a loop of appends is O(n²). | Stat-based own-change note for appends; cached line count. | Unit: 1,000 appends to a 10 MB dataset < 1 s. |
| D-11 | P2 | `workspace-watcher.ts:72-80`; `fsutil.ts:319-345` | Every own save hashes the bytes in `commit()` and the watcher hashes the file again on the event (`readFileSync` + SHA-1, up to 8 MB). | Record `size:mtime` after the rename and compare stat first. | — |
| D-12 | P2 | `runner/run-results.ts:121-131` | While a run writes, each page/filter call re-indexes the whole `results.jsonl` (mtime/size changed), `JSON.parse` of every line including the 4.8 KB `output`. | Index incrementally from the last offset; extract `id/name/status` with a cheap scanner. | `_perf-tests-1000` style unit: paging a live 50k-line file 10× < 200 ms. |
| D-13 | P2 | `runner/test-history.ts:149-164`, `:23-53`; `workspace.ts:576-593` | `latestResults` parses every line of up to 30 results files without a needle and without stopping early; `failedTestIds` reads a whole results file synchronously. | Needle prefilter (`"status":"failed"`), stop when all names are found. | — |
| D-14 | P2 | `metastore.ts:719-747`, `:770-790`, `:892-902` (JSONL fallback) | Per-insert append, O(n) `splice` at the cap, linear `find`s, compaction only on close (UI F-35 covers the caps). | — | — |

## 4. Memory

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| Mem-1 | P1 | `debugger/proxy.ts:207-213`, `:382`; `:658-660` | Proxied request bodies are buffered whole with no cap (`collectWhole`); held responses are collected whole (`Number.MAX_SAFE_INTEGER`), converted to a string and back (`Buffer.from(whole.text ?? '', 'utf8')`: three copies, and a UTF-8 round trip that corrupts binary bodies when a modify rule applies). | Cap at the session body budget; keep bytes, apply text edits only to text bodies. | `debugger-proxy.test.ts`: a 100 MB upload through a rule keeps RSS growth < 2× its size; a binary held response is byte-identical. |
| Mem-2 | P1 | `debugger/grpc.ts:71-72` | `gunzipSync`/`inflateSync` with no `maxOutputLength` on the proxy path (compare `transfer/zip.ts:282`). A small bomb expands without limit, synchronously. | `maxOutputLength: 64 MB` (the 512 KB body cap makes most of it unnecessary anyway). | Unit: a 1 KB → 1 GB gzip message is rejected. |
| Mem-3 | P1 | `debugger/session.ts:46`; `proxy.ts:176`, `:500`, `:624`, `:767` | The 200 M-character budget counts bodies only; frames, SSE events and gRPC messages (500 × 64 KB per direction per exchange) are outside it: ~32 MB per streaming exchange, 5,000 exchanges allowed. | Count frames/events/messages in `size()`. | `debugger-session.test.ts` budget test with 1,000 WebSocket exchanges. |
| Mem-4 | P1 | `backend/handlers/debugger.ts:672`; `:279`, `:824-835` | Deep search lowercases every request and response body (up to the 200 MB budget) per query; saved sessions load with `readFileSync` + base64 decode + `JSON.parse` in one synchronous step. | Case-insensitive search without copies (regex with `i`, or a lowercased shadow kept per exchange); async load in slices. | e2e (UI F-15 pairs with it): deep search over 5,000 exchanges < 300 ms, no copy. |
| Mem-5 | P2 | `protocols/http/client.ts:551-556`, `:585-602`; `send.ts:95` | SSE events capped at 10,000 by count, not bytes; `onChunk` forwards every decoded chunk unbounded; a body exists as chunks + concatenated Buffer + string + parsed object at once (then again in `ctx.body`/`text`). | Byte cap for events and chunks; drop `chunks` after concat. | Unit: 10,000 × 1 MB SSE events stay under a 64 MB cap. |
| Mem-6 | P2 | `runner/runner.ts:357-364` | Up to 100 step responses kept with both `text` (≤ 256 K chars) and parsed `body` for `--from`/seed runs. | Keep text only, parse on demand. | — |
| Mem-7 | P2 | `fsutil.ts:418-419`, `:436` | The 64 MB text budget does not count `parsedCache` (frozen parsed documents, 3-10× the text). | Estimate parsed size (text length × 4) in the same budget. | — |
| Mem-8 | P2 | `backend/handlers/debugger.ts:267-285`, `:320-357` (UI F-36) | Up to 4 saved-session views in addition to the live session; autosave re-serialises everything every 60 s while dirty. | — | — |

## 5. Process / IPC

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| P-1 | P1 (design) | `electron/main.ts:372`, `:302-307`, `:349-367` | The whole backend (`new Backend`) lives in the Electron main process; every RPC is `await be.invoke` on the UI thread. Every sync item in §1-§4 is therefore a dropped frame, and load-test latencies include UI stalls. The window is created first and the backend after `ready-to-show` (good), but the work never leaves the thread. | Move the backend into a `utilityProcess` (MessagePort RPC; the `web-server.ts` bridge is already host-agnostic per the cloud-ready memory) — or at least load tests and the debugger proxy. | e2e: a 2,000 rps local load test for 30 s keeps the renderer's max frame < 50 ms. |
| P-2 | **P0** | `util/stats.ts:33`; `load/load.ts:456-468`; `load.ts` snapshots (`gen.stats()` and the per-request recorders) | `stats()` copies and sorts **all** samples (`this.buf.slice(0, this.n).sort()`) and the ticker calls `snapshot(false)` every second, so a 30-minute 5k-rps test sorts ~9 M floats per second on the UI thread (hundreds of ms per tick, growing). `secLat` is reset per tick, but the cumulative recorders are not. | HDR/log-bucket histogram for live snapshots; exact sort only at the end (or an incremental P² estimator). | `load-safeguards.test.ts`: 5 M recorded samples, 10 snapshots < 100 ms total. |
| P-3 | P1 | `protocols/http/socket-timing.ts:102`, `:108`, `:137` | Connection-timing waiters cap at 200 and every `sendHeaders` event scans the set: > 200 VUs lose `connection` data (new-vs-reused counts undercounted) and each request costs an O(200) scan. | Key waiters by the request object (`WeakMap`) instead of a set scan. | Unit: 1,000 concurrent requests all report `connection`. |
| P-4 | P2 | `net/proxy.ts:120`; `load/load.ts:362`, `:471` | All VUs share the base pool (`connections: 256` per origin): above 256 VUs over HTTP/1.1 the queue inside undici counts as server latency, silently. | Size a pool to the VU count for load tests and say so. | Unit: 400 VUs → pool connections ≥ 400. |
| P-5 | P2 | `protocols/http/client.ts:448-461` | Load tests go through WHATWG `fetch` (Headers/Response/web streams + full `prepareHttpRequest` per request); `undici.request` is 2-3× cheaper per call. | A lean `request()` path for `discardBody` sends. | `load-safeguards`: ≥ N rps against a local echo server on one core. |
| P-6 | P2 | `debugger/proxy.ts:930`, `:934`; `:324`, `:511`, `:606`, `:763` | A new `createSecureContext` per CONNECT tunnel (re-parses the leaf PEM each time) and, with extra CAs, the full CA array in every `https.request` options (a new agent key hashed per request). | Cache the context per host; one `https.Agent` with a cached CA context. | — |
| P-7 | P2 | `debugger/proxy.ts:291`, `:1019-1025`; `:606` | HTTP/2 upstream sessions outlive `close()`; the upstream `timeout: 60_000` has no listener (a stalled upstream never ends the exchange). | Close `h2Sessions` in `close()`; handle `'timeout'`. | Integration: after stop, no open handles. |
| P-8 | fine | `backend.ts:194-195`, `:628`, `:761`, `:784` | Events are batched (`console`/`log` 50 ms, `run.events` 100 ms with compact results, `debug.exchange` ids only). | — | — |

## 6. Network stack

Already right: one shared keep-alive pool (`net/proxy.ts:120`: 256 connections, 10 s keep-alive) set as the global dispatcher; special-option pools cached by key, ≤ 32 LRU, closed on settings change (`client.ts:85-121`); HTTP/2 negotiated by default (`http1Only` opts out), version remembered per origin (bounded 500, `client.ts:73-82`); compression decoded streaming by undici; bodies streamed with a preview cap and spooled with backpressure (`client.ts:560-571`); one `AbortController` + timer per attempt, cleared in `finally` (`client.ts:353-389`); uploads via `openAsBlob`; `discardBody` for load tests; NTLM's one-connection pool is deliberate. Remaining:

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| N-1 | P2 | `net/policy.ts:136`, `:146` | No DNS cache: every new pooled connection and, with private-network blocking, every redirect hop does a `getaddrinfo` on libuv's 4-thread pool (shared with file I/O). Matters at load-test ramp-up. | A small TTL cache (`cacheable-lookup`-style) honouring the policy check. | Unit: 1,000 lookups of one host hit the resolver once. |
| N-2 | P2 | `net/proxy.ts`, `net/policy.ts` imports | undici and `node:dns` are loaded at CLI startup (30 ms) even for commands that never send (C-1). | Lazy. | C-1 gate. |
| N-3 | fine | `client.ts:398-403` | — | — | — |

## 7. CLI and MCP output sizes

Covered in §1f/§1g (C-1..C-3, M-1..M-3). `--json` outputs are paged (`util/page.ts`, `core-scale` "comes back in pages"); `run-collection` has no `--json` (it is `--jsonl` per event + reporters), which is fine but worth a line in `llms.txt` since an agent will try `--json` first (the error is clear: "Did you mean --jsonl?").

## 8. Build / bundle

| # | Sev | Where | Evidence | Fix | Gate |
|---|---|---|---|---|---|
| B-1 | P1 | `apps/desktop/scripts/esbuild-options.mjs:2-14`; `build-main.mjs:10-15`; `dist-electron/main.cjs` 17.4 MB, `cli.cjs` 16.5 MB (maps 30 MB each, excluded by `electron-builder.yml:22`) | Everything is bundled into one CJS file: own code 4.6 MB, zod 1.2 MB, undici 1.1 MB, QuickJS 0.8 MB, graphql 0.7 MB, kafkajs 0.6 MB, node-forge 0.6 MB, grpc-js 0.6 MB, mysql2 0.6 MB, iconv-lite 0.5 MB, node-html-parser 0.4 MB, mqtt 0.4 MB, MCP SDK 0.3 MB, electron-updater 0.2 MB, aws-ssl-profiles 0.2 MB … Evaluating `cli.cjs` in-process: 310-340 ms (192 ms compile, 28 ms read); `boot.cjs` turns on the compile cache so the second app start pays mostly the read + `__init` (~50-60 ms), but the first start after every update pays all of it, and the Terminal's `TestPion --cli` pays the 16.5 MB every time it is not cached. No duplicate packages (checked with a metafile). | `splitting: true` with `format: 'esm'` (or keep CJS and `external` the heavy protocol/database deps: kafkajs, mysql2, pg, mqtt, grpc-js, node-forge, graphql, iconv-lite — they are `await import()`ed in core already) so they load on first use; `sourcemap: 'external'` is fine (not shipped). `web-server.cjs` was not in `dist-electron/` today (built after the listing or skipped). | Build check: `main.cjs` ≤ 8 MB; a `scripts/bundle-report.mjs` printing the top 20 packages from the metafile on every build. |
| B-2 | P2 | `scripts/cli-bundle.mjs` | The CLI bundle is good (third-party external, compile cache); the MCP SDK + zod could be inside it (M-3). | — | — |

## 9. Top 10, ranked

1. **P-2 Load tests sort every latency sample every second on the UI thread** (`util/stats.ts:33`, `load/load.ts:461-468`) — histogram for live snapshots, exact stats at the end; gate in `load-safeguards`.
2. **R-1 Trace batches do 500 sync file writes + SHA-1 inside one SQLite transaction** (`runner.ts:294-313`, `workspace.ts:524`, `fsutil.ts:400-408`) — measured 1.5 ms per trace → ~750 ms blocks; write files async outside the transaction, drop the fingerprint for ignored folders (S-6).
3. **G-1 `git-perf` breached its 700 ms budget (1,057 ms) under parallel load; `core-scale` lost one request of 2,600 once** — rerun alone; add `TESTPION_PERF_SLACK` to `git-perf`; fix G-2/G-3 so the budget has room.
4. **S-5 One fsync'd atomic write per `tp.environment.set`** (`current-values.ts:69`, `backend.ts:605-611`) — debounce like the cookie jar; a 1,000-request app run with a setting script is 1,000 fsyncs on the UI thread.
5. **S-4 + R-3 Full-body parse/deep-copy/pretty-print to keep 16 KB (console) or 4,000 chars (results)** (`send.ts:184-191`, `execute.ts:421`, `:120-123`) — cut first, then redact; also shrinks results.jsonl (R-5: 5.4 KB per row).
6. **B-1 17.4 MB Electron main bundle with every protocol and database driver inside** (`esbuild-options.mjs`, `build-main.mjs`) — 310-340 ms to evaluate uncached; split or externalise the lazy deps; a size gate.
7. **S-1 + S-2 Per send: every environment parsed twice, and a payload file for every body** (`send.ts:41`, `workspace.ts:344`, `client.ts:565-569`) — use the frozen views; spool only truncated bodies; fix the GraphQL payload leak (S-3).
8. **C-1 Every CLI command pays ~250 ms of module work before starting** (`bundle.js` eval 77 ms, undici + dns 30 ms, `buildProgram` 10 ms) — lazy command modules and lazy network imports; a startup gate for `collections --json`.
9. **M-1 + M-2 MCP `tools/list` is 336 KB and server construction scans every test file** (`testpion-mcp.ts:104`, `tool-contract.ts:390-396`, `flow-tools.ts:139`) — minimal profile by default or trimmed schemas; lazy flow scan; a size gate.
10. **Mem-1..4 + A-2 Debugger proxy: unbounded request bodies, UTF-8 round trip on held responses, `gunzipSync` without a limit, quadratic frame concat, deep search copying 200 MB per query** (`proxy.ts:207-213`, `:658-660`, `grpc.ts:71`, `frames.ts:29`, `handlers/debugger.ts:672`) — caps, byte-preserving edits, `maxOutputLength`, concat-once, copy-free search.

Then: D-1 (`deleteRunsBefore` sync), D-2 (`Atomics.wait` up to 1.45 s), D-3 (worker per SQL query), I-1 (re-import `locate` per node), A-1 (search lowercases everything per query), R-2 (a Deferred per result), P-3/P-4 (load-test waiter cap and pool size), R-4 (body stringified into the VM twice, three VM passes per app send).

## 10. What is already fast

- CLI `--version`/`--help` at bare-Node speed from `fast-index.json`; the bundle + V8 compile cache for the rest; the fast-path gate holds a 2.5× ratio.
- `listCollections` of 10,000 requests in 32 ms, `getCollection` ×50 in 41 ms (text cache + frozen parsed views, `fsutil.ts:412-470`); the watcher opens 20,000 files in 51 ms, time-sliced, with stat-first fingerprints and own-write detection.
- SQLite: WAL + `synchronous=NORMAL` + `busy_timeout`, denormalised and indexed `history` v2 columns, prepared hot statements, amortised pruning by rowid in a transaction; 100k-row pages in 1-6 ms, `historyByCollection` in 10 ms.
- Runner: backpressured source (2× concurrency), one results `WriteStream` with a shared drain wait, aggregator keeps counts + samples only, traces queued off the test path, reports streamed from `results.jsonl` once per format (`report/reports.ts:296-311`), results paged by byte offsets.
- Network: one keep-alive pool, HTTP/2 by default, cached special pools (32, LRU), streamed bodies with a preview cap and disk spooling with backpressure, timers and listeners always cleared, `discardBody` for load tests.
- Git: `--porcelain=v2 -z -uall` in one process, 2 processes per 300-file refresh, rows remembered by blob/size/time, 5,000 new files read without blocking > 31 ms, repo-root cache.
- Backend events batched (`console`/`log` 50 ms, `run.events` 100 ms compact, `debug.exchange` ids only); the schedulers and the examples update deferred past first paint; monitor result parses cached by mtime; `stats-cache` keyed by file signatures.
- Bounded caches everywhere I looked (dispatchers 32, ALPN 500, rules regex 200, leaf certs 2,000, `BoundedMap` 500, text cache 64 MB, git roots 500, results indexes 4).

## 11. Gates to add (one line each)

- `load-safeguards.test.ts`: 5 M recorded samples, 10 snapshots < 100 ms (P-2); 400 VUs → pool ≥ 400 (P-4); 1,000 concurrent requests all carry `connection` (P-3).
- `runner-trace-queue.test.ts`: a 500-trace flush blocks the event loop < 50 ms (R-1); a 1 MB body yields a result row ≤ 1.5 KB (R-5).
- `desktop-backend.test.ts`: 200-request app run with a setting script fsyncs ≤ 2× (S-5); a 1 KB response leaves no `payloads/` file (S-2); 10 GraphQL sends + clear leave `payloads/` empty (S-3); console entry for a 2 MB body < 5 ms (S-4).
- `core-hot-paths.test.ts`: 100 sends with 20 environments parse 0 environment files after the first (S-1).
- `cli-fast-path.test.ts`: `collections --json` on the examples < 300 ms best-of-3 and a module census (C-1); `mcp-server` to `initialize` < 700 ms warm (M-3).
- `mcp-tool-contract.test.ts`: `tools/list` ≤ 200 KB full, ≤ 40 KB minimal (M-1); `scale-hot-paths`: construction with 5,000 test files < 200 ms (M-2).
- `git-perf.test.ts`: `TESTPION_PERF_SLACK` like `import-perf` (G-1); a 9,000-item library change described < 100 ms (G-2); merge of 2 × 5,000-item folders < 100 ms (G-3).
- `debugger-proxy.test.ts`: 100 MB upload through a rule < 2× RSS and a byte-identical held binary response (Mem-1); a gzip bomb rejected (Mem-2); a 50 MB frame in 64 KB chunks < 200 ms (A-2); deep search over 5,000 exchanges without copies (Mem-4).
- A build gate: `dist-electron/main.cjs` ≤ 8 MB with a per-package report (B-1).
- `import-perf.test.ts`: re-import of the 10k Postman file < 3 s (I-1); Thunder/Yaak/Bruno 10k fixtures (I-2).
