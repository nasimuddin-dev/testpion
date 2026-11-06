# Several teams, and several tenants, in one workspace (non-cloud)

The owner asked (2026-11-01) to think about a multi-team environment. TestPion's model stays git-based and local: a team is the people who commit to the same repository; there is no server, no accounts, no permissions of its own. What several teams need, then, is to **tell their things apart, know who owns what, and not get in each other's way**, with git doing the sharing and the access control (branch rules, CODEOWNERS reviews).

## What exists

- Everything is a plain file merged by item (collections request by request), so two teams rarely conflict; conflicts are settled item by item in the app or with `git_resolve`.
- `CODEOWNERS` written by TestPion (`testpion git codeowners`, the Git view): the reviewer of each file.
- Comments next to items (`comments/`), a note for the team on Home, Your team's changes, Waiting on origin/main, secrets to fill in, Who are you?.
- Production guard per environment; secret values never in the files; snoozes and mock state stay on each computer.

## Gaps, in build order

1. **Owners on the item** (done 2026-11-01). The Info panel says *Owned by @payments-team* from CODEOWNERS, and *Last changed by Ana, 2 days ago* from git; `ref_info` / `testpion item owners` say the same; a problem of Needs attention names the owner (*@payments-team's monitor "Checkout" is failing*) so a shared Problems list reads as a to-do per team.
2. **Filter by team** (done 2026-11-01: the Problems panel's Owner select, `testpion problems --owner`, `what_needs_attention { owner }`; 2026-11-05: the Collections tree shows owners and filters by `@team`, `testpion collections --owner`). The Problems panel, Home's Needs attention and `testpion problems --owner @payments-team` show one team's problems; the Collections tree groups collections by owner on request (a Group by ▸ Owner like the Debugger's).
3. **Alerts to the owner** (done 2026-11-01). A monitor's webhook text starts with the owners of what it runs (`@payments-team`), so a shared Slack channel pages the right people; a per-team webhook can be a `{{variable}}` of the environment already.
4. **A workspace per team with shared pieces** (environments done 2026-11-05: `shared` in workspace.json, `testpion workspace share`, the shared badge; `specs`, `datasets` and libraries not built). Teams that want separate repositories still share environments and API definitions: a workspace can reference another folder (a git submodule or a sibling checkout) for `environments/` and `specs/` read-only (`shared:` in workspace.json). The app shows them greyed with the source's name; secrets are still per computer. (Design only; one day of work.)
5. **Team conventions as lint** (done 2026-11-01 as `conventions.yaml` next to workspace.json; `testpion workspace conventions [--init]`; Needs attention group "Team conventions"). A conventions file the lint reads: required tags, naming of collections (`<team>-<service>`), an owner for every folder; `testpion lint --conventions` and the Problems list say what breaks them. (Half a day.)
6. **Activity by team** (done 2026-11-01: each commit carries its teams' names on Home; `testpion git activity --owner`, `git.teamActivity { owner }`).

## Shared pieces across workspaces (design, not built)

Item 4 above, written down so the cloud version and the next loop build the same thing:

- `workspace.json` gets `shared: [{ "path": "../platform-shared", "kinds": ["environments", "specs"] }]`: a relative path to another workspace folder (a sibling checkout or a git submodule) and which of its folders are read. Only `environments`, `specs`, `datasets` and `library/<name>` can be shared; collections and tests stay the workspace's own (they are what a team owns).
- Reading: `WorkspaceStore.listEnvironments()` appends the shared folder's environments after its own, each with `shared: "platform-shared"` (the folder's name) and `readOnly: true`; same for `listSpecs`. An id clash keeps the workspace's own item and lists the shared one as a problem (*shared environment Staging has the same id as yours*).
- Writing: `saveEnvironment` on a shared item throws `ValidationError: "Staging" is shared from platform-shared: change it there`; the app shows shared rows greyed with the source's name and no editor, the Compare and Copy-across targets exclude them.
- Secrets stay per computer and per workspace: a shared environment's secret variables are read from this workspace's secret store under the shared environment's id (nothing of the source workspace's store is read).
- Git: the shared folder is the other repository's business; `git status` here never shows its files; Your team's changes names the source when a change came from it only if the folder is a submodule (then `git submodule status` says what moved).
- CLI and agents: `testpion env list` prints `(shared from platform-shared)`; `list_environments` carries `shared`; `testpion workspace share add ../platform-shared --kinds environments,specs` writes the entry; `--json` everywhere.
- Cloud: a shared reference becomes a link between two hosted workspaces of one organisation; the files do not change, the server resolves `path` to the other workspace.

About a day of work: the store (two list methods and two guards), the Environments and API definitions views (greyed rows, no editor), the CLI command, tests with two fixture workspaces, docs. Not started because every team the owner described so far shares one repository.

## Several tenants

A tenant here is a customer or an instance of the same API (Acme's and Globex's deployments of one product), tested by one team from one workspace. The on-prem rules: one tenant's values never reach another's run, result or export; a run says which tenant it was; a change made for every tenant is made once.

1. **Tenant = environment, grouped** (done 2026-11-01, New tenant from… included). An environment gets an optional `group` (*Acme*, *Globex*): the Environments list and the picker show *Acme ▸ Staging*, the status bar and run headers carry the group, `testpion env list` prints it. A new tenant is a copy of an existing group's environments (**Duplicate for a new tenant…**, `testpion env duplicate-group`). (Half a day.)
2. **Run for every tenant** (done 2026-11-01: `--env-matrix group:Acme`, `environmentGroup` on a monitor = one monitor per environment of the group). The environment matrix already runs one flow in several environments and compares; a group name as the matrix (`--env-matrix group:Acme`, **Run for every environment of Acme**) and a monitor per tenant from one definition (`tenants: [Acme, Globex]` on a monitor: one row per tenant in the list and the status page). (A day.)
3. **Nothing leaks** (done 2026-11-01: `no-leak` with `otherEnvironments: true`). The redactor already masks secrets by value; a tenant check adds: a response that holds another environment's values (ids, hosts, keys) fails a `no-leak` check across environments (`testpion env diff --request` compares responses already; the check makes it a test). History, traces and exports are per environment and say so in their names. (Half a day.)
4. **Tenant-scoped data** (done 2026-11-01: `{{$group}}`, `{{$environment}}`). Datasets per group (`datasets/acme/…` chosen by `{{group}}`), and `{{$group}}` as a built-in variable. (Small.)
5. **The cloud version (B-42, later):** tenants become organisations with their own workspaces, users and keys; nothing above assumes it, and all of it carries over, because a tenant is only an environment group in the files.

## The same model in the cloud (B-42 comes next)

The owner said the cloud version implements the same concept next. So the on-prem pieces are built on names the cloud will keep, and every one of them lives in a core module with the UI only talking RPC (`cloud-ready-design`):

| Concept | On-prem (today) | Cloud (next) | Where the rule lives |
|---|---|---|---|
| Who someone is | the git identity (`git identity`), the computer's user name | the signed-in user | `by` on a comment, `author` of a change, `resolvedBy`: a plain name string + optional e-mail, never a machine id |
| Team | the owners `CODEOWNERS` names for a file (`@org/payments`) | an organisation's team; CODEOWNERS is still read for repositories, and the team mapping adds members | `git/owners.ts`: `ownersOf(rules, path)`; `AttentionItem.owners`, `Ownership.owners` are the one shape |
| Tenant | an environment group (`group` on the environment; item 1 above) | an organisation / project; its environments keep the group | `environment.group`; runs, results, traces and exports carry `environment` + `group` |
| Workspace | a folder in git | a hosted workspace with the same files, synced | `WorkspaceStore` behind RPC; the cloud server is another host of the same backend |
| Per-person state | `.local/` (snoozes, mock state, drafts) | per-user state on the server | `.local/*` readers and writers take a store; the server swaps the store |
| Permissions | git branch rules and CODEOWNERS review | roles per team on the server | none in the files: the server enforces, the files stay the same |

Rule for every feature until then: no new file format carries a user id, a host name or a secret; a person is a name, a team is `@org/name`, a tenant is a group name. Then the cloud version maps each to its own records and the workspace files do not change.

Not planned: permissions inside the app (git's branch rules are the permission system), user accounts, presence or locking (git's merge by item makes locking unnecessary).
