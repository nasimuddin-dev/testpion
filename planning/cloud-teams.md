# TestPion Cloud: teams and permissions only (git holds the content)

Written 2026-11-13 from the owner's direction. It replaces the larger design in [cloud-platform.md](cloud-platform.md) (kept for reference: the items it names that are dropped here are listed at the end).

## The decision

- **The cloud holds only people and permissions:** accounts and profiles, organizations, teams and their members, a registry of workspaces (a name and a git URL), and who may do what on a workspace and on a collection.
- **Everything else stays in git:** collections, environments, tests, API definitions, mocks, runs. The cloud never stores, relays or reads them.
- **Everything runs on the user's computer:** sending requests, scripts, runs, monitors, mocks, git. The browser version is a page from the cloud talking to a TestPion engine on the same computer.
- **Cost is the constraint:** a static page, one small API, one small database. No file storage, no runners, no always-open connections, no email service at the start.

## What follows from it

1. **Git is the sync.** History, conflicts and backup are what the app already does with git (the Git view, the merge driver, the conflict screen). No sync service, no database copy of a workspace, no revisions of our own.
2. **The git host does the enforcing.** A person who can clone a repository can read and change all of it, whatever the cloud says. So the cloud's roles are applied to the git host by an app installed there (repository access, CODEOWNERS, branch protection), and the TestPion window follows the same roles as a convenience (a Viewer gets read-only editors).
   - Workspace read and write: enforced (repository access).
   - Collection **write**: enforced (CODEOWNERS and a required review on the protected branch).
   - Collection **read** inside one repository: cannot be enforced. A collection some members must not read lives in its own repository (a workspace of its own, sharing environments and API definitions through `shared` in workspace.json, built 2026-11-05).
3. **The model of [multi-team.md](multi-team.md) carries over unchanged:** a person is a git identity, a team is a CODEOWNERS owner `@org/team`, a tenant is an environment group. The cloud is where they are managed; the files stay as they are. No file gets a user id, a host name or a secret.
4. **The desktop app stays complete and works signed out.** Signing in adds the workspace list of your organizations and the roles; it never becomes required.

## Concepts

| Concept | Meaning | Where it lives |
|---|---|---|
| User | A person: name, picture, the git identities they commit with, their accounts on git hosts | Cloud |
| Organization | A company or a person; has members, teams, workspaces | Cloud |
| Team | Members of an organization; maps to a team on the git host and to a CODEOWNERS owner | Cloud, applied to the git host |
| Workspace entry | A name, a git URL, a default branch, the folder of the workspace in the repository | Cloud |
| Grant | A role for a user or a team on a workspace, or on a collection of it | Cloud, applied to the git host |
| Workspace content | Everything TestPion reads and writes today | Git only |

Roles: **Owner** (the organization: members, teams, delete), **Admin** (workspaces and grants), **Editor** (change and run), **Runner** (run, not change), **Viewer** (read). On the git host Editor is write access, Runner and Viewer are read access; the difference between those two exists only in the window.

## Architecture

```
Page (static, from a free host) ─┐
Desktop app ─────────────────────┼─ HTTPS ─ API (sign-in, organizations, teams, workspaces, grants, audit) ─ one small database
CLI / MCP ───────────────────────┘                 │
        │                                           └─ git host app (GitHub first): applies teams and grants
        └─ localhost ─ TestPion engine on the user's computer ─ git, requests, runs (as today)
```

- **API:** a new package in this repository (`apps/cloud`), stateless, a few tables. It answers "who am I, which organizations, which workspaces, what may I do"; clients keep the answer for the session and refresh it on focus, so it sees a few calls per person per day.
- **Sign-in:** GitHub, Google and Microsoft only (OAuth, written by us). No passwords, so nothing to store, reset or email.
- **Invitations:** a link the inviter copies and sends. Email comes later, if at all.
- **Tokens:** short-lived for the page and the app; named tokens with scopes for the CLI and MCP, kept in the OS keyring (the vault of 0.58).
- **The page and the engine:** the page is the same window code as the desktop app, built for the web bridge. It finds the engine on localhost, pairs once with a code the engine shows, and from then on the engine accepts that origin and that pairing only. Without an engine the page still shows the profile, teams, workspaces and grants.

## Backlog

Ids `TC-…`. Sizes and the definition of done are the ones of [README.md](README.md). Every item has its CLI command with `--json`, its MCP tool and its `llms.txt` lines.

### Phase 0: decisions and proof (before any account exists)

- [ ] **TC-001 Provider and price check** (S). Compare a serverless API with a bundled database against one small server, with today's prices for the expected size (100, 1,000, 10,000 users); the owner picks. *Accept:* a table in this file with monthly cost per size and what is free.
- [ ] **TC-002 Data model and API contract** (S). Tables (user, identity, organization, member, team, team member, workspace, grant, invitation, token, audit) and the API as an OpenAPI file in `apps/cloud`, tested by TestPion itself. *Accept:* the definition lints clean; a mock of it runs from the examples.
- [ ] **TC-003 Roles in the window, from a file** (M). The window and the engine take a role per workspace and per collection from the request context (`can`, built in cloud stage 1) and apply it: read-only editors, Run disabled for a Viewer, each disabled control saying why. Fed from a local test file for now. *Accept:* an e2e plan for Viewer, Runner and Editor; the CLI and MCP refuse the same actions with the same words. No cloud needed.
- [ ] **TC-004 Engine for a page on another origin** (M). The web bridge for real use: listens on localhost only, pairing code, an allow-list of one origin, a token per pairing, the browser's private-network preflight answered, a way to end a pairing. `testpion serve` starts it; the desktop app offers it in Settings. *Accept:* a page on another origin without a pairing gets nothing; a paired page passes the `core` e2e plan.

### Phase 1: accounts, organizations, teams

- [ ] **TC-101 API skeleton and database** (M). `apps/cloud`: migrations, health, rate limits, structured errors in the CLI's envelope, the audit table written by every change. Deploy from a workflow. Depends on TC-001, TC-002.
- [ ] **TC-102 Sign-in with GitHub, Google, Microsoft** (M). OAuth with PKCE, sessions, sign-out, the list of signed-in devices; an account can link several providers.
- [ ] **TC-103 Profile** (S). Name, picture, the git identities (name and email) the person commits with, so *Last changed by* and review labels name the same person everywhere. The email of a commit is matched, never shown to other organizations.
- [ ] **TC-104 Organizations and members** (M). Create, rename, delete; invite by link (expires, single use or counted); roles; remove a member; transfer ownership.
- [ ] **TC-105 Teams** (M). Create, rename, delete, add and remove members; a team's handle (`@org/team`) as used in CODEOWNERS.
- [ ] **TC-106 Tokens for the CLI and MCP** (S). `testpion login` (device code), `testpion logout`, `testpion whoami`; named tokens with scopes and an end date; kept in the OS keyring.
- [ ] **TC-107 Account page** (M). The static page: sign in, profile, organizations, members, teams, invitations, tokens, devices. Built from the shared components of the window.

### Phase 2: workspaces and permissions

- [ ] **TC-201 Workspace registry** (M). Add a workspace to an organization by git URL (and folder, default branch); rename, remove (the repository is untouched). *Accept:* nothing of the repository's content reaches the API (a test reads every request body).
- [ ] **TC-202 Grants** (M). A role for a user or a team on a workspace; on a collection of it (by collection id and name, taken from the client that has the checkout). The highest grant wins; an organization rule can cap it.
- [ ] **TC-203 GitHub app: repository access** (L). Installed on the organization's GitHub; a workspace's grants become team and collaborator access on its repository; a change in the cloud is applied within a minute; a change made by hand on GitHub is shown as a difference with *Apply* and *Take over*. Depends on TC-202.
- [ ] **TC-204 GitHub app: collection write** (M). Collection grants are written into CODEOWNERS (the writer of 0.5x, `testpion git codeowners`) as a pull request, and the default branch is checked for the protection that makes them count; the app says what is missing instead of changing branch rules silently.
- [ ] **TC-205 Share dialog** (M). One dialog for a workspace and for a collection: people, teams, role, who has access and through what; says plainly what is enforced by the git host and what only the window follows.
- [ ] **TC-206 Audit log** (S). Who changed which member, team or grant, when; search, export as CSV and JSON.
- [ ] **TC-207 Separate repository for a restricted collection** (M). *Move to its own workspace…*: creates the workspace entry, moves the collection with its history where git can, shares environments and API definitions back through `shared`. The answer to "these people must not read it".

### Phase 3: the apps signed in

- [ ] **TC-301 Desktop sign-in** (M). Sign in through the browser, come back to the app; the profile in the title bar; works offline with the last known roles and says how old they are.
- [ ] **TC-302 Cloud workspaces in the switcher** (M). The workspaces of your organizations next to the local ones; *Open* clones with the Git view's clone (credentials are the git host's, never the cloud's); a workspace already cloned is matched by its remote.
- [ ] **TC-303 Roles applied** (S). TC-003 fed from the cloud; a role that changed while the app is open applies at the next refresh, with a notice.
- [ ] **TC-304 CLI and MCP** (S). `testpion org`, `team`, `workspace list --cloud`, `grant`; MCP tools for the same reads, and writes behind the usual confirmation; a run in CI uses a token of a Runner.
- [ ] **TC-305 People in the window** (S). Owners, reviewers and *Last changed by* show the profile's name and picture where a git identity matches a member.

### Phase 4: the browser version

- [ ] **TC-401 Window as a hosted page** (M). The window built for the web bridge and published as static files with the account page; a version check between page and engine (`rpcVersion`, built) with a plain message when they differ. Depends on TC-004.
- [ ] **TC-402 Pairing flow** (S). *Connect to TestPion on this computer*: finds the engine, shows the code, remembers the pairing; when no engine answers, says how to start one and keeps the account pages usable.
- [ ] **TC-403 Engine-only installer** (M). A small download with the engine and no window (the CLI with `serve`, started at sign-in on request), for people who want only the browser version. The package-manager manifests of 0.58 gain an entry.
- [ ] **TC-404 What the page cannot do** (S). Native menus, file pickers, the updater and drag from the desktop get their web forms or a line saying where to do it; an e2e run of the suite against the page with a list of the plans that are skipped and why.

### Phase 5: later, each one decided on its own

- [ ] **TC-501 GitLab and Bitbucket** (L each). The same as TC-203 and TC-204 for another host.
- [ ] **TC-502 Email** (S). Invitations and notices by email, once there is a reason to pay for sending.
- [ ] **TC-503 Organization rules** (M). Allowed sign-in providers, who may create workspaces, a cap on roles for guests.
- [ ] **TC-504 Plans and billing** ([subscriptions.md](subscriptions.md), to be cut down to this design). Seats and teams are what a plan can count; nothing local moves behind it.
- [ ] **TC-505 SSO and SCIM** (L). For a paid plan that covers its cost.
- [ ] **TC-506 Browser without an engine** (XL). Read and edit through the git host's web API, send only to APIs that allow the page's origin. Needs storage behind async interfaces (stage 2 of [cloud-stage-1.md](cloud-stage-1.md)); only if people ask for zero install.

## Order and first step

Phase 0 first: TC-003 and TC-004 are local, useful on their own and need no account or provider. TC-001 and TC-002 run beside them. Then phases 1 to 4 in order; each ends with the full regression.

## Open decisions (owner)

1. **Provider** (after TC-001). Recommended: a serverless API with its bundled database.
2. **Is restricting who can change a collection enough,** or must some members be unable to read some collections? Assumed here: change is enough, and TC-207 covers the rest.
3. **Git hosts at the start.** Assumed: GitHub only.
4. **Is a one-time local install acceptable for the browser version?** Assumed: yes (TC-506 is the alternative).
5. **Name and domain** of the hosted page, and whether a person without an organization gets a personal space.

## Dropped from cloud-platform.md

Database `WorkspaceStore` and server `MetaStore` (CLD-003, CLD-004), the operation log and sync service (CLD-002, CLD-301), presence and live editing (CLD-303), cloud runners, monitors and mocks (CLD-401 to CLD-405), the hosted MCP server (CLD-406), public links served by us (CLD-204), comments stored in the cloud (CLD-304: comments stay files in git). From stage 2 of cloud-stage-1.md only what the window needs stays (typed handlers, permission table); async stores wait for TC-506.
