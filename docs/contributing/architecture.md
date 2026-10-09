---
title: "Contributor architecture notes"
description: "Rules for contributors and AI coding agents working on the codebase."
---

::: v-pre

# Architecture notes for contributors

Follow the engineering rules in SRS §72. In particular:

- Keep protocol adapters independent of each other and keep UI state separate from execution state.
- Never block the renderer. Use bounded concurrency, stream data, and never hold unbounded payloads in memory.
- Never log secrets. Route every persisted artefact through the `Redactor`.
- Label AI-generated output (`source: 'ai-judge'`, *AI-generated suggestion* banners).

## The map, and what keeps it

```
packages/core        the engine, host-agnostic (Node): the same code runs in the CLI, the desktop app and a server later
  model/             the types of everything saved (types.ts) and the schema version
  storage/           workspaces on disk: collections, environments, tests, trash, git files, secrets, trust, watcher
  protocols/         http, graphql, grpc, websocket/socket.io/mqtt, mcp, sse: one client each, nothing shared between them
  runner/            test files, suites, the run loop, results, breakdowns, baselines, CI config
  eval/, ai/, load/  checks and evaluators, providers and the assistant's helpers, load tests
  import/            Postman, Insomnia, Bruno, OpenAPI, HAR, cURL/fetch snippets, save-request (secrets to variables)
  scripts/           the tp.* sandbox (QuickJS in WebAssembly): scripts never reach Node
  git/               git through the system git, changes by meaning, the merge driver
  mcp-server/        the workspace as MCP tools for agents: tool.ts (the contract), one module per subject, testpion-mcp.ts composes them
  index.ts           the public surface: everything the CLI and the app may use
packages/cli         commands over core (commands/*.ts), JSON output everywhere, exit codes 0 / 1 / 2 / 3
apps/desktop
  backend/           the app's RPC handlers over core (handlers/*.ts, one file per subject); backend.ts wires them and owns long-running state
  electron/          the window, menu, updater, preload (the context bridge), --mcp-server and --merge-driver modes
  src/               the renderer (React): talks to the backend only through api.ts (RPC); from core it takes types only
  e2e/               the UI regression suite (plans/*.cjs) and the profiler plan
docs/                the published site; planning/ is internal
```

Three rules, kept by `tests/unit/architecture.test.ts` (it runs with `npm test`):

1. **Boundaries.** Core imports no Electron, React or app code; the backend never imports the renderer; the renderer never imports Node, Electron, backend files or core at run time. The renderer is a web page that a cloud host will serve as it is.
2. **Big files do not grow.** `backend.ts`, `testpion-mcp.ts`, `cli/commands/data.ts`, `workspace.ts` and `types.ts` have a ceiling; a new MCP tool goes into the module of its subject (`git-tools.ts`, `workspace-edit-tools.ts`, …), a new RPC handler into `handlers/<subject>.ts`, a new CLI command into `commands/<subject>.ts`. Nothing else passes 1,200 lines.
3. **One place per feature, every host.** A feature is core logic + a CLI command with `--json` + an RPC handler + (when an agent would want it) an MCP tool, with the tool's name added to the pinned list in `tests/integration/workspace-run.test.ts`.

## Migrations

Workspace format changes need a new entry in `MIGRATIONS` (`packages/core/src/storage/workspace.ts`), a bump to `SCHEMA_VERSION`, and a test. Each migration upgrades exactly one version, and opening a newer format is refused rather than silently broken. The SQLite metadata schema has its own versioned migrations in `metastore.ts`.

:::
