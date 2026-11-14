# TestPion planning

Internal plans and backlogs for the next stages of TestPion. Not published with the docs site (that is `docs/`).

| Plan | What it covers |
|---|---|
| [git-integration.md](git-integration.md) | Workspaces in git: git-friendly files, an in-app Git panel, smart merging, AI and CLI |
| [cloud-teams.md](cloud-teams.md) | **The cloud plan (2026-11-13):** the cloud holds only accounts, teams, the workspace registry and permissions; content stays in git and everything runs on the user's computer. Backlog TC-… |
| [cloud-platform.md](cloud-platform.md) | The earlier, larger cloud design (sync, cloud runners, server storage): replaced by cloud-teams.md, kept for reference |
| [subscriptions.md](subscriptions.md) | Plans (Free, Pro, Team, Enterprise), what each includes, limits, billing and licensing |
| [roadmap.md](roadmap.md) | The order of the work across the three plans, milestones and dependencies |

## Ground rules (from the owner)

1. **Every non-cloud feature comes first.** Git Phase 1–3 is local and can start any time. Cloud work (and everything that needs an account) starts only when the owner says so; when the local feature backlog is done, remind the owner to start it.
2. **AI-first.** Every feature is usable by AI agents without the GUI: a CLI command with `--json`, a tool in `testpion mcp-server`, an entry in `llms.txt` and the docs, and AI assistance in the app where it helps (with human review).
3. **Cloud-ready.** The UI talks only through the RPC bridge; the engine stays host-agnostic behind the `WorkspaceStore` / `MetaStore` / `SecretStore` interfaces; anything that sends requests, runs scripts or starts processes is safe on a shared server.
4. **Uniform UI.** One shared component per pattern; every new screen gets an end-to-end regression plan (`apps/desktop/e2e/plans`).
5. **The local app stays complete and free.** Nothing that works locally today moves behind a paywall. Paid plans sell collaboration, hosting and scale.

## How backlog items are written

Each item has an id (`GIT-…`, `CLD-…`, `SUB-…`), a size, its dependencies, and acceptance criteria. Sizes: **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks, **XL** more than 2 weeks (split it before starting). Status: `[ ]` to do, `[~]` in progress, `[x]` done (with the date and commit).

Every item is done when: the feature works in the app and in the web bridge; unit / integration tests and an e2e plan cover it; the CLI / MCP / `llms.txt` surface exists; the docs are updated; and the cloud impact is noted.
