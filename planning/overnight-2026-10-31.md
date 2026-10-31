# Overnight loop, 2026-10-30 evening to 2026-10-31 08:30 (non-cloud)

v0.55.5 was released and installed first. Everything below is committed and pushed to `main` after it, and **not released**.

## What was built

| Area | What |
|---|---|
| Team | Home card "Your team's changes", `git activity`, Invite a teammate, a toast when the team pushed, a note for your team on Home (`workspace note`, also in AGENTS.md), secrets to fill in (Needs attention, `secrets --missing`, an Environments banner), "Who are you?" for a computer without a git identity (`git identity`, doctor) |
| RAG bots | Right/Partly/Wrong on retrieved documents (`rag label document`), Map by meaning (R-12, `rag map`), Which document mattered? (R-11, `rag ablate`; the bot's request takes `"documents": "{{documents}}"`), the demo RAG server answers from given documents |
| AI quality | Save as a prompt version (from Try a prompt), what changed between prompts (word diff, `eval version-diff`), dataset health (`eval lint`, notes under Test cases), monitors that run a prompt or agent evaluation (fail on a pass-rate drop, spend cap, cost per month), Monitor on a schedule… and Run in CI… in an evaluation's menu, Needs attention for a pass-rate drop, latest result in the evaluations list, agent report says which tools were never called |
| MCP | `testpion mcp --lint` and a "For AI agents" section on Server info: how easy a server's tools, prompts and resources are for an agent |
| OpenAPI | two information notes: parameter without a description, operation without a documented failure |
| Docs | When something does not work, Work as a team, features and CLI reference updated, AI answer guide gets "watch it every night" |

## State

- Unit and integration tests: 582 files, 5235 tests, all green (last run 07:15).
- UI regression: 178 of 182 plans on the last full run. The four that failed are fixed or environmental: `apidef-lint` and `rag-trend` (plan fixes, pass alone), `datasets` and `wf-run-ci` (read the OS clipboard, which Windows refuses overnight: `Get-Clipboard` fails). `flow-qa` "wheel zoom is smooth" and `perf-debugger` are slow-frame flakes that pass alone.
- The MCP verbose tool list is exactly at its cap: trim wording in `packages/core/src/mcp-server/tool-docs.ts` before adding an MCP option. `rag ablate` is therefore CLI and RPC only.

## To release

1. Choose the version (0.56.0 is the honest size). `docs/public/llms.txt` and some docs say "Since 0.55.6": replace with the chosen version (`grep -rn "Since 0.55.6" docs`).
2. Add a "What's new in 0.56" section to `docs/getting-started/whats-new.md`.
3. Follow the cut-release skill: `python scripts/release.py 0.55.5 <new> <notes>` (the Unreleased changelog body is the notes), tag, push, watch the build, install.
4. Run `datasets` and `wf-run-ci` while the screen is unlocked (clipboard).

## Still yours

- Cloud integration (B-42) is the last item and has not been started.
- The `NPM_TOKEN` secret, code-signing certificates, revoking the pasted OpenAI key, and approval to clean `%TEMP%\tp-*`.
