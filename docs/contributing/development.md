---
title: "Development guide"
description: "Set up a development environment, run tests and build the app."
---

::: v-pre

# Development

```bash
npm install
npm run build          # shared → core → cli → desktop
npm test               # unit and integration tests (vitest)
npm run typecheck
npm run e2e -w @testpion/desktop   # the UI regression suite in the real Electron app (apps/desktop/e2e/plans)
npm run dev            # Electron
npm run dev:web        # browser + local bridge
node examples/servers/demo-servers.mjs   # local REST/GraphQL/LLM/WebSocket demo servers
```

Every feature ships with an implementation, unit tests, integration tests, documentation and an example. A UI feature also gets a plan in `apps/desktop/e2e/plans/`; a CLI command prints its `--json` output through the envelope (`packages/cli/src/output.ts`); a new MCP tool follows the tool contract (`packages/core/src/mcp-server/tool-contract.ts`: paging, `response_format`, `confirm: true` for deleting or overwriting) and is added to the pinned tool list in `tests/integration/workspace-run.test.ts`.

## AI features

A new AI task is an entry in `packages/core/src/ai/tasks/registry.ts` (its prompt in `prompts.ts`; changing a prompt bumps the task's `version`) with golden cases in `tests/ai/`, which run with the mock provider in `npm test`: no key and no network. To see how the prompts do with a real model, run the same cases live (never in CI by default):

```bash
AI_EVAL_LIVE=1 TESTPION_AI_PROVIDER=ollama TESTPION_AI_MODEL=llama3.2 npx vitest run tests/ai   # prints a scorecard per task
```

The UI plans and the documentation screenshots use the offline mock with scripted answers (`x-mock-rules` on a mock provider: a regular expression on the last user message and the answer); see `apps/desktop/e2e/plans/ai-flow-from-collection.cjs` and `apps/desktop/scripts/capture-steps.cjs`. See [AI features](/ai-testing/ai-features#the-prompts-are-tested-for-contributors).

## Hardening of the packaged app

`electron-builder.yml` sets Electron fuses in the installed binary: it can't be started as a plain Node.js runtime (`ELECTRON_RUN_AS_NODE`), doesn't read `NODE_OPTIONS`, ignores `--inspect` and only loads the app from its archive. Check a packaged build with `npm run package:dir -w @testpion/desktop`, then start `release/win-unpacked/TestPion.exe`.

## The npm package

`npm run pack:cli` (`scripts/pack-cli.mjs`) builds the `testpion` npm package: the CLI with `packages/core` and `packages/shared` bundled by esbuild into one file, and the third-party modules the bundle imports as ordinary dependencies, with the version ranges the workspace packages ask for. It writes `dist/npm/testpion/` and `dist/npm/testpion-<version>.tgz`; `--json` prints a summary.

The release workflow's *Publish the CLI to npm* job publishes the tarball with provenance when the repository has an `NPM_TOKEN` secret (an npm automation or granular token allowed to publish `testpion`). Without the secret it skips with a notice; a version already on npm is left as it is.

## Code signing (not set up yet)

The installers are unsigned: Windows SmartScreen and macOS Gatekeeper warn on first launch, and updates are checked by their hash only. Signing needs certificates the project doesn't have yet. When it does:

- **Windows:** an OV/EV code-signing certificate, or Azure Trusted Signing. With a `.pfx`, add the repository secrets `WIN_CSC_LINK` (the file, base64) and `WIN_CSC_KEY_PASSWORD` and pass them as environment variables to the *Package* step of `.github/workflows/release.yml`; electron-builder then signs the app and the installer. With Azure Trusted Signing, set `win.azureSignOptions` in `electron-builder.yml` instead.
- **macOS:** an Apple Developer ID Application certificate. Add `CSC_LINK` (the `.p12`, base64), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as secrets and pass them to the *Package* step; in `electron-builder.yml` remove `identity: "-"`, set `hardenedRuntime: true` and `notarize: true`.
- In both cases remove `CSC_IDENTITY_AUTO_DISCOVERY: "false"` from the workflow, and try it on a pre-release tag first.
- Afterwards, drop the "isn't code-signed yet" notes from the Windows and macOS installation pages.

:::
