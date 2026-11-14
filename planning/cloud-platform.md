# TestPion Cloud

A hosted version of TestPion for teams: sign in, create an organization and teams, share workspaces and collections with permissions, work on the same collection together, run tests and monitors in the cloud, and keep using the desktop app (offline-first) with everything in sync.

> **Replaced on 2026-11-13 by [cloud-teams.md](cloud-teams.md):** the owner chose a cloud that holds only people and permissions, with all content in git. This file is kept for reference.
>
> **Not started on purpose.** Per the owner, every non-cloud feature comes first. This plan is the design to start from when the owner says so.

## Principles

1. **The desktop app stays complete and works offline.** The cloud adds collaboration, hosting and scale; it never becomes required for local work.
2. **One engine.** `packages/core` runs in the desktop app, the CLI and the cloud. The cloud is another host behind the same RPC surface (`apps/desktop/backend`), with server storage behind the existing interfaces.
3. **Secrets never leave a user's machine unless they choose a shared vault.** Synced data references secrets; values stay local (OS secret store) or in an encrypted team vault.
4. **Least privilege by default,** every action audited, every tenant isolated.
5. **AI-first:** every cloud capability has an API, a CLI command and an MCP tool, with per-user tokens and scopes.

## Concepts

| Concept | Meaning |
|---|---|
| **User** | A person with an account (email + password, Google / GitHub / Microsoft sign-in; SSO on Enterprise). |
| **Organization** | The billing and admin unit (a company or a person). Has members, teams, workspaces, a plan. A user can belong to several. |
| **Team** | A group of members inside an organization (e.g. "Payments QA"); permissions can be given to a team instead of each person. |
| **Workspace** | As today: collections, environments, tests, library, mocks, specs. In the cloud it belongs to an organization (or a user's personal space). Visibility: private (only invited), team, organization, public (read-only link). |
| **Collection** | Can be shared on its own, with its own permissions (narrower or wider than its workspace, never wider than the organization allows). |
| **Environment** | Shared environment (variables); secret variables are references; values come from each user's current values or a team vault. |
| **Role** | A set of permissions given to a user or team on an organization, workspace or collection. |

## Roles and permissions

Built-in roles (custom roles on Enterprise):

| Permission | Owner | Admin | Editor | Runner | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|
| Billing, plan, delete organization | ✓ | | | | |
| Members, teams, SSO, audit log | ✓ | ✓ | | | |
| Create / delete workspaces | ✓ | ✓ | ✓¹ | | |
| Share, change permissions | ✓ | ✓ | ✓² | | |
| Edit requests, collections, tests, environments | ✓ | ✓ | ✓ | | |
| Run requests, collections, tests; use mocks | ✓ | ✓ | ✓ | ✓ | |
| Create monitors, scheduled runs | ✓ | ✓ | ✓ | | |
| See the team vault's secret values | ✓ | ✓ | per vault | per vault | |
| View, comment, export | ✓ | ✓ | ✓ | ✓ | ✓ |

¹ if the organization allows members to create workspaces. ² up to their own level.

Permission is resolved as: organization role → workspace grant (user or team) → collection grant; the highest grant wins, except that an organization policy can cap it (e.g. "no public links", "guests are Viewers").

**Guests:** people outside the organization invited to one workspace or collection (e.g. an API consumer), Viewer or Runner only, count toward plan limits.

## Architecture

```
Desktop app ─┐                       ┌── API (RPC + REST) ── same handlers as the desktop backend
Browser app ─┼── HTTPS / WebSocket ──┤
CLI / MCP ───┘                       ├── Sync service (changes, presence, conflicts)
                                     ├── Runner service (sandboxed workers: requests, scripts, collection runs, monitors, load)
                                     ├── Identity (accounts, OAuth / SSO, tokens), Billing (subscriptions, entitlements)
                                     └── Storage: Postgres (metadata, permissions, audit), object storage (run results, payloads),
                                                  secret vault (KMS-encrypted), search index
```

- **Hosts:** the same RPC handlers run in an API service with a `CloudBackend` that supplies a per-request context (user, organization, workspace, permissions) instead of the desktop's single user. Handlers check permissions through one guard (`can(user, action, resource)`).
- **Storage interfaces:** `WorkspaceStore` gets a database implementation (documents per collection / environment / test with ids and revisions); `MetaStore` (history, runs, traces) on Postgres + object storage; `SecretStore` becomes per-user (current values) plus team vaults.
- **Runners:** requests, scripts and runs execute in isolated workers (containers or VMs) with CPU / memory / time limits, the network policy that exists today (no private / metadata addresses), egress allowlists per organization, and optional **self-hosted runners** (a small agent run by the customer inside their network, for internal APIs; Team and Enterprise).
- **Regions:** EU and US data residency (Enterprise picks); backups, point-in-time recovery.

## Sync and collaboration

- **Offline-first desktop:** the desktop keeps the full workspace on disk (as today) and syncs changes as **operations on ids** (add / update field / move / delete) with a revision per item. When online, it pushes its operations and pulls others'; independent edits merge automatically (the same id-based logic as the git merge driver, GIT-301); the same field changed by two people becomes a visible conflict to resolve.
- **Real-time in the browser and desktop when online:** presence ("Ana is editing Create invoice"), live updates of the tree and open requests, soft locks per request while someone types, comments on requests and runs.
- **Git-backed workspaces (optional):** a cloud workspace can mirror a git repository (GitHub App / GitLab): cloud edits become commits, pushes become cloud changes (see git-integration.md, CLD-602).
- **Version history:** every change kept with who and when; restore any item; diff between versions (the same semantic diff as the Git panel).

## Security and compliance

- Accounts: email verification, strong passwords + breached-password check, 2FA (TOTP, passkeys), session management, device list.
- Organization security: SSO (SAML / OIDC), SCIM provisioning, enforced 2FA, IP allowlists, domain capture, audit log export, data retention policies.
- Data: encryption in transit and at rest; team vault secrets encrypted with per-organization keys (KMS); secrets never in logs, history or AI prompts (the existing redactor runs server-side too).
- Abuse and safety: rate limits, request quotas per plan, runner isolation, SSRF guards (existing network policy), malware-free uploads (file type / size limits), public-link controls.
- Compliance path: SOC 2 Type II and GDPR (DPA, data export and deletion); a security page and a vulnerability disclosure policy (private vulnerability reporting is already on in GitHub).

## Backlog

### Phase C0: foundations (can start before accounts, still local)
- [ ] **CLD-001 Permission-aware RPC context** (M). Every handler receives a context (user, scope) and calls `can(...)`; the desktop supplies an all-allowed local user. *Accept:* no handler reads globals; tests run with a restricted context.
- [ ] **CLD-002 Operation log per item** (L). Changes to collections / environments / tests are recorded as operations with item revisions (also powers undo, history and the git work). Depends on GIT-101.
- [ ] **CLD-003 Database `WorkspaceStore`** (XL). Postgres implementation behind the interface; the same store test-suite passes against files and the database.
- [ ] **CLD-004 Server `MetaStore` and object storage** (L). Runs, traces, history, payloads.
- [ ] **CLD-005 Per-user `SecretStore` and team vault** (L).

### Phase C1: accounts and organizations
- [ ] **CLD-101 Identity service** (L). Sign up / in (email, Google, GitHub, Microsoft), verification, password reset, 2FA, sessions; API tokens with scopes for the CLI and MCP.
- [ ] **CLD-102 Organizations, members, invitations** (M). Create organization, invite by email or link, roles, remove, transfer ownership.
- [ ] **CLD-103 Teams** (M). Create teams, add members, give a team a role on workspaces.
- [ ] **CLD-104 Desktop sign-in** (M). Sign in from the desktop app (browser hand-off), choose organization, see cloud workspaces next to local ones in the workspace switcher; works offline after.
- [ ] **CLD-105 CLI and MCP sign-in** (S). `testpion login` (device code), tokens in the OS secret store; `--org`, `--workspace` flags.

### Phase C2: sharing and permissions
- [ ] **CLD-201 Cloud workspaces** (L). Create in the cloud or upload a local workspace ("Move to cloud" keeps a local copy in sync); private / team / organization visibility.
- [ ] **CLD-202 Share dialog** (M). Share a workspace or a single collection with people, teams or a link; role per grant; who has access list; uniform dialog for both.
- [ ] **CLD-203 Permission enforcement in the UI** (M). Read-only editors for Viewers, Run-only for Runners, disabled actions with an explanation (uniform component).
- [ ] **CLD-204 Public read-only links** (M). Published collection docs (the existing Markdown/HTML docs) and "Run in TestPion" buttons; organization policy can forbid.
- [ ] **CLD-205 Guests** (S). External people on one workspace / collection.

### Phase C3: sync and collaboration
- [ ] **CLD-301 Sync service** (XL). Push / pull operations, revisions, conflict detection; desktop offline queue; e2e with two app instances.
- [ ] **CLD-302 Conflict resolution UI** (M). Reuses the git conflict screen (GIT-302).
- [ ] **CLD-303 Presence and live updates** (L). Who is here, who edits what, live tree updates (WebSocket).
- [ ] **CLD-304 Comments and mentions** (M). On requests, collections and run results; notifications by email / in app.
- [ ] **CLD-305 Version history and restore** (M).

### Phase C4: cloud execution
- [ ] **CLD-401 Cloud runner workers** (XL). Sandboxed execution of requests, scripts and collection runs; quotas; network policy; results stored server-side.
- [ ] **CLD-402 Cloud monitors** (L). The existing monitors run on a schedule in the cloud, from chosen regions, with alerts (email, Slack, Teams, webhook, PagerDuty).
- [ ] **CLD-403 Self-hosted runner agent** (L). For internal networks; registers with the organization; runs jobs pulled from the cloud.
- [ ] **CLD-404 Cloud mock servers** (M). Public HTTPS URLs for the mock server, GraphQL mock and MCP mock.
- [ ] **CLD-405 Scheduled collection runs and CI webhooks** (M).
- [ ] **CLD-406 Hosted MCP server** (M). `https://mcp.testpion.dev/<org>/<workspace>` with OAuth, so AI agents can use a team workspace with the user's permissions.

### Phase C5: organization administration
- [ ] **CLD-501 Admin console** (L). Members, teams, roles, workspaces, usage, plan; security settings.
- [ ] **CLD-502 Audit log** (M). Who did what, when, from where; search and export.
- [ ] **CLD-503 SSO (SAML / OIDC) and SCIM** (L). Enterprise.
- [ ] **CLD-504 Policies** (M). Enforce 2FA, allowed sign-in methods, public links, guests, IP allowlist, data retention.
- [ ] **CLD-505 Custom roles** (M). Enterprise.

### Phase C6: integrations
- [ ] **CLD-601 Notifications** (M). Slack, Microsoft Teams, email, webhooks for monitors, runs and comments.
- [ ] **CLD-602 Git-backed cloud workspaces** (L). GitHub App / GitLab integration (see git-integration.md).
- [ ] **CLD-603 API catalog** (L). Organization-wide list of APIs (from specs and collections) with owners, coverage and health.

## Open decisions (owner)

1. Hosting: one multi-tenant service first (simplest) and a single-tenant / on-prem edition later for Enterprise?
2. Real-time editing model: soft locks per request (simpler) or field-level collaborative editing (CRDT)?
3. Product name for the hosted app and the domain (`testpion.dev`?), and whether personal cloud workspaces exist on Free.
