# Process-wide state (cloud stage 1)

Everything that is still module-level mutable state in `packages/core/src`, `packages/shared/src` and `apps/desktop/backend`, with why it is safe when one process hosts many sessions (users), or the ticket that removes it. `tests/unit/two-sessions.test.ts` scans the sources and fails when a module-level `let`, array, `Map` or `Set` is neither

- marked on its own line with `// bounded: …` or `// registry: …` (a cache with a size limit, a table filled at start-up), nor
- a constant table (an ALL_CAPS name), a `WeakMap` keyed by a store, a lazy module loader (`let xMod: typeof import(…)`), nor
- listed below (`file#name`).

So adding process-wide state means choosing a row here on purpose. Classes:

| Class | Meaning |
|---|---|
| policy | Global by design: one rule for every user of the server (the operator's network safety policy, the CLI's defaults). |
| user-config | Belongs to one user or session. Must not be module state: the proxy and trusted certificates moved to the per-session `NetConfig` (stage 1 step 2); no row of this class is left. |
| sandbox | The in-thread script runtime: one per runner instance after stage 1 step 3 (`ScriptRunner`). |
| cache | A cache of something that is the same for every user (a parse of a file keyed by path, a version string); bounded or tiny. |
| seam | A hook a host or a test replaces once at start-up. |
| registry | Filled at start-up, read afterwards. |
| counter | An id source; ids only need to be unique inside one process. |
| lazy-load | A module loaded on first use (startup time); immutable afterwards. |
| desktop-only | Used only by the desktop shell; leaves the engine barrel for `@testpion/core/desktop` (step 4). |
| dev-bridge | The single-backend development bridge (`web-server.ts`); the cloud host is a session router instead. |
| app-services | Shared by design: `AppServices` (apps/desktop/backend/app-services.ts). |
| ticket | Still process-wide and on the list to move (named in the note); no row is left after stage 1. |

Per session already (checked by the test): the import previews (bounded in count, age and bytes by the host), settings, workspace and store, secrets, cookie jar, current values, variables, the run registry, controllers and calls in flight, connections (MCP, WebSocket, Socket.IO, MQTT, Kafka), mocks, the debugger session, console and log buffers, the "already told" set of blocked secret references (was a module `Set`), the fuzz runs (was a module controller).

Bounded caches that carry a `bounded:` note on their own line are not repeated here (about 50: the `fsutil` text and parsed caches, git roots, the dispatcher pool, the DNS cache, run-result indexes …). They are keyed by absolute path or origin, so one user never reads another's data; what they share is the memory budget (stage 2: a per-store `FileCache`).

| Where | Class | Note |
|---|---|---|
| `packages/core/src/ai/script-reference.ts#cached` | cache | The script API reference, immutable after the first build. |
| `packages/core/src/ai/script-reference.ts#ready` | cache | Same. |
| `packages/core/src/ai/tasks/run.ts#counter` | counter | Id source. |
| `packages/core/src/ai/tasks/run.ts#processCostCap` | policy | The CLI --max-cost (one command per process); a server passes the cap per call (withAiCostCap, AsyncLocalStorage). |
| `packages/core/src/debugger/programs.ts#waiting` | desktop-only | Windows process lookup; desktop only (moves to @testpion/core/desktop in stage 1 step 4). |
| `packages/core/src/debugger/programs.ts#snapshotTimer` | desktop-only | Same. |
| `packages/core/src/debugger/programs.ts#lastSnapshotStart` | desktop-only | Same. |
| `packages/core/src/debugger/programs.ts#snapshot` | desktop-only | Same. |
| `packages/core/src/debugger/programs.ts#processNames` | desktop-only | Same. |
| `packages/core/src/debugger/programs.ts#snapshotPending` | desktop-only | Same. |
| `packages/core/src/debugger/proxy.ts#idSeq` | counter | Monotonic id source (ids only need to be unique inside one proxy session). |
| `packages/core/src/debugger/rules.ts#patterns` | cache | Compiled RegExps of rule patterns; cleared at 200 (see `compiled` next to it). |
| `packages/core/src/eval/check-registry.ts#sortedTypes` | registry | Derived from the check registry. |
| `packages/core/src/eval/check-registry.ts#resolver` | registry | Set once by the host at start-up (provider resolver of the AI checks). Ticket: pass it in ExecServices (stage 2). |
| `packages/core/src/eval/rag/custom/compile.ts#lastSync` | cache | Last custom-metric sync (one folder); re-run when the stamp changes. |
| `packages/core/src/eval/rag/db-trust.ts#cache` | cache | The trusted-databases list of one file; re-read when its mtime changes. |
| `packages/core/src/eval/rag/sql-host.ts#host` | seam | The SQL runner a host injects at start-up. |
| `packages/core/src/eval/rag/testset/url-guard.ts#agent` | cache | One guarded http agent. |
| `packages/core/src/git/git.ts#knownVersion` | cache | The installed git version, read once. |
| `packages/core/src/import/script-pass.ts#convertedChars` | cache | Size counter of the bounded `converted` memo next to it. |
| `packages/core/src/net/policy.ts#current` | policy | The server-wide network safety policy (block private networks, host allow-list, process switch). Global by design: a server enforces it for every user. |
| `packages/core/src/net/policy.ts#originalLookup` | policy | The unpatched dns.lookup the guard wraps; set once by the first policy call. |
| `packages/core/src/net/policy.ts#resolver` | seam | The DNS function the guarded lookup calls; replaced only by tests. |
| `packages/core/src/net/process-policy.ts#allowed` | policy | May this process start programs: the operator TESTPION_ALLOW_PROCESSES switch, enforced for every user (global by design). |
| `packages/core/src/net/production-guard.ts#processAllows` | policy | The CLI default of the production consent; a call carries its own consent in AsyncLocalStorage (the pattern to copy). |
| `packages/core/src/net/proxy.ts#undici` | lazy-load | The loaded undici module. |
| `packages/core/src/net/proxy.ts#loading` | lazy-load | Same. |
| `packages/core/src/net/proxy.ts#loadTimer` | lazy-load | Same. |
| `packages/core/src/net/proxy.ts#defaultNet` | app-services | The NetConfig of the process: the CLI, the desktop app single session (setDefaultNet) and code outside any call use it; a server never replaces it, its sessions bring their own (withNet). |
| `packages/core/src/openapi/fuzz.ts#seq` | counter | Id source. |
| `packages/core/src/protocols/http/socket-timing.ts#waiting` | cache | Counter of the bounded waiters map next to it. |
| `packages/core/src/scripts/sandbox.ts#runtime` | sandbox | The QuickJS runtime of the in-thread script runner. Per runner instance after step 3 (ScriptRunner). |
| `packages/core/src/scripts/sandbox.ts#pooled` | sandbox | Same. |
| `packages/core/src/scripts/sandbox.ts#current` | sandbox | The options of the pass that is running; safe because a pass is synchronous. |
| `packages/core/src/scripts/script-runner.ts#processRunner` | seam | The script runner of the process (the CLI, or the desktop app when asked); a server session brings its own with withScriptRunner. |
| `packages/core/src/scripts/script-worker.ts#reqSeq` | counter | Id source of the one worker thread (module state of the worker, not of the host). |
| `packages/core/src/storage/fsutil.ts#textCacheBytes` | cache | Counter of the file text cache (64 MB, keyed by absolute path: tenants never see each other's data; the budget is shared). Ticket: per-store FileCache (stage 2). |
| `packages/core/src/storage/fsutil.ts#onBigFile` | seam | Hook a host sets to be told about a file read from disk each time; the last session to set it wins (a log line only). |
| `packages/core/src/storage/private-acl.ts#runner` | seam | Test seam for the Windows ACL command. |
| `packages/core/src/storage/private-acl.ts#platform` | seam | Test seam. |
| `packages/core/src/storage/private-acl.ts#user` | cache | The OS user name, read once. |
| `packages/core/src/storage/private-acl.ts#done` | cache | Folders already restricted to the user; bounded by the number of private folders (a handful). |
| `packages/core/src/util/ids.ts#poolAt` | counter | Random id pool cursor. |
| `packages/core/src/util/json-schema.ts#instance` | cache | One Ajv instance. |
| `packages/core/src/util/lazy-yaml.ts#lastText` | cache | One-entry parse memo (text to value); identical text gives an identical value for every user. |
| `packages/core/src/util/lazy-yaml.ts#lastValue` | cache | Same. |
| `packages/core/src/vars/external-secrets.ts#runner` | seam | Test seam for the secret-manager command runner. |
| `packages/shared/src/item-kinds.ts#globs` | cache | Compiled globs of the kind table (immutable after first use). |
| `packages/shared/src/output/formats.ts#CRC_TABLE` | cache | Lookup table (immutable). |
| `apps/desktop/backend/app-services.ts#shared` | app-services | The process's AppServices singleton: what sessions share by design. |
| `apps/desktop/backend/handlers/debugger-rules.ts#validKinds` | registry | Constant list. |
| `apps/desktop/backend/handlers/debugger.ts#epochSeq` | counter | Id source. |
| `apps/desktop/backend/open-links.ts#pending` | desktop-only | Deep links received before the window is up (the desktop shell). |
