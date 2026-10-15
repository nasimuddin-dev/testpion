---
title: "Architecture overview"
description: "How TestPion is structured: core engine, desktop app, CLI, storage and security."
---

::: v-pre

# Architecture

```text
apps/desktop  (Electron + React + Monaco)   packages/cli  (testpion)   testpion mcp-server
      │  IPC → backend (production guard)            │                          │
      ▼                                              ▼                          ▼
             packages/core — the single execution engine
  protocols (HTTP · GraphQL · gRPC · WebSocket · Socket.IO · MQTT · Kafka · MCP) │ AI providers · agent loop
  variables · scripts (QuickJS/WASM) · checks & evaluators · tracer
  runner (streaming, bounded concurrency, retries, checkpoints, flows) · reports
  storage (workspace files · SQLite metadata · secret stores) · importers
```

- The desktop backend, the CLI and the MCP server (`testpion mcp-server`, or the installed app with `--mcp-server`) call the **same** engine, so test execution logic is not duplicated.
- An environment marked as **production** is guarded in one place per host: the desktop backend checks every RPC call that sends or runs before its handler runs and the window asks once; the CLI takes `--allow-production`; the MCP server needs `--allow-production` and `allowProduction: true` per call. The engine refuses data-changing steps without that consent ([Production](/api-testing/environments#production), [Design](./design.md#cloud-ready-design)).
- Every CLI `--json` output is one envelope, `{ schema_version, command, status, data, errors, warnings, metrics }`, written by `packages/cli/src/output.ts`; `--jsonl` streams events as `{ type, data }` lines ([JSON output](/cli/reference#json-output-dry-runs-and-scripts)).
- The React renderer never performs network or test execution. It sends RPC calls to the backend and receives batched events, throttled to about 50–100 ms, so high-frequency streams don't cause excessive renders.
- Electron uses `contextIsolation`, a sandboxed renderer and a strict CSP. The preload exposes only an RPC bridge.
- The UI is React 19 with Tailwind CSS v4 and Radix UI primitives, in the shadcn/ui style. Colours are OKLCH design tokens in `apps/desktop/src/styles.css`, with the TestPion blue → violet brand as the accent, and surfaces layered as chrome (top bar, navigation rail, status bar) → sidebars → work area → popovers. Dark and light themes share the same tokens. New UI reuses the primitives in `apps/desktop/src/components/ui.tsx` (`Button`, `Tabs`, `Badge`, `Modal`, `Menu`, `Empty`, `Split` with `sidebar` …).

## Storage

```text
workspace/
  workspace.json  (schemaVersion 1.0)   database.sqlite (history · runs · traces index)
  collections/  environments/  tests/  datasets/  providers.json  mcp-servers.json
  traces/  payloads/  runs/<runId>/{results.jsonl,summary.json,reports}  baselines/
```

Large payloads, traces and results are separate files and are never stored in SQLite rows. Writes are atomic (temp file, fsync, rename). A corrupted JSON file is preserved as `*.corrupt-<ts>` and reported instead of crashing. Workspace format [migrations](../contributing/architecture.md#migrations) run on open, and the pre-migration file is backed up.

See [execution engine](./execution-engine.md) and [plugin system](./plugin-system.md).

:::
