---
title: "Work as a team"
description: "Share one TestPion workspace with your team through git: set it up, invite a teammate, fill in secrets, see what others changed, and keep merges calm."
---

# Work as a team

::: tip In short
A TestPion workspace is a folder of plain files, so your team shares it through git. This page is the path from one person to many. **About 10 minutes.**
:::

## What is shared and what is not

Requests, environments, tests, flows and the comments you leave on items (`comments/`) are shared through git. Secret values are not: each person types their own, and they stay on that person's computer. So do the problems you snoozed and the mock servers' state.

## Set it up once

1. Open the **Git** view and press **Initialize repository**.
2. Press **Fix git setup** once. It keeps secrets and machine-only files out of git and lets two people edit one collection without conflicts.
3. Connect a remote address (GitHub, GitLab or another host) and press **Push**.
4. On Home, press **Add a note for your team**. Write what a newcomer needs, for example *Start with Staging. Ask Ana for the key.* The note travels with the workspace.

## Bring a teammate in

1. In the Git view, open **⋯** and choose **Invite a teammate…**.
2. Copy the message and send it. It holds the install link, the clone address and the steps.
3. Your teammate installs TestPion, chooses **Clone**, and pastes the address.
4. If git asks for a sign-in, it is the same one they use in a terminal.

The first time they commit, TestPion asks for their name and e-mail if git has none yet.

## Fill in the secrets

After a clone, every secret is empty on the new computer. Home shows **Needs attention** with each environment that has secrets without a value. Click it, type the values, and press **Save**.

From a script or CI, `testpion secrets --missing` lists them with the variable that gives each one to the command line.

## Work day to day

- Change a request, then **Commit** with a short message, then **Pull & push**.
- Turn on **Pull my team's commits by itself** in **Settings ▸ Git** to stay current without thinking about it.
- **Your team's changes** on Home shows what others changed in the last two weeks, in words (*Ana, 2 hours ago: Search: URL*). With a `CODEOWNERS`, each change carries the teams whose files it touched (*@org/payments*), and `testpion git activity --owner @org/payments` lists one team's.
- Rest the pointer on an item in the explorer to see who changed it last.

## Who owns what

When several teams share one workspace, the repository's `CODEOWNERS` (TestPion writes a starter one: the Git view, `testpion git codeowners`; tick **One line per collection and per tests folder**, or `--per-collection`, so each team can own its own collections and test folders) says who reviews each part. TestPion reads it back: the **Info** panel of an item says *Owned by @org/payments* and *Last changed by Ana 2 days ago* (from git), `testpion item owners <item>` prints the same, and a problem under **Needs attention** starts with the owners of what it is about (*@org/payments: Monitor "Checkout" is failing*), so a shared Problems list reads as a to-do per team (`testpion problems --json` carries `owners`). To see one team's problems only, pick the team in the Problems panel's **Owner** select (it appears when problems have owners; **Group by ▸ By owner** or **By tenant** sorts the whole list that way), run `testpion problems --owner @org/payments`, or ask an agent for `what_needs_attention` with `owner`. The **Info** panel of a monitor or an environment says *Tenant Acme* (`testpion item owners` prints it too). A problem about a tenant (a monitor running in one of its environments, a token or secret of one of them) carries the tenant too: the Problems panel's **Tenant** select and `testpion problems --group Acme` keep one tenant's. The same for comments: **Your team is asking** on Home names the team that owns each item, and `testpion item comment open --owner @org/payments` lists one team's.

## Team conventions

A team that shares a workspace agrees on how things are named and filed. Write the agreement in `conventions.yaml` next to `workspace.json` (`testpion workspace conventions --init` writes it with every rule explained and off): a pattern collection names must match (`^[a-z]+-[a-z-]+$`: *payments-invoices*), one for request names, one for environment names; every environment in a group (a tenant); every collection with an owner in `CODEOWNERS`; every monitor with an alert webhook and an environment. What breaks a rule is a warning under **Needs attention** (group *Team conventions*: *Collection "Scratch" has no owner in CODEOWNERS*), `testpion workspace conventions` lists it (exit 1 when there is one, for CI), and `what_needs_attention` carries it as `kind: "convention"`. The file is shared through git like the rest of the workspace, so the rules are the team's, not one computer's. The AGENTS.md that `testpion agents init` writes repeats the rules in words, so a coding agent names and files things the team's way.

## Comments next to the item

A question about a request, a test file, an evaluation or a monitor belongs next to it, not in a chat nobody finds again. Open the item, open the **Info** panel on the right, and write under **Comments for your team**: *Why does this send X-Trace twice?* The comment is signed with your git name and dated, and saved in the workspace under `comments/` (one small file per item, so two people commenting on different items never conflict). Commit and push it like anything else; a teammate who pulls sees it next to the same item, and the Git view names the change *Comments for the team*. **Mark as settled** greys a comment and takes it out of the open list (*Show 1 settled* brings it back); the bin removes it for good (Undo in the message puts it back). A request with open comments shows a small speech bubble and the count on its row in the tree. Home lists what your team is still asking under **Your team is asking**, newest first; the item's name opens it.

From the command line or an agent: `testpion item comment list request:<collectionId>:<requestId>`, `item comment add <item> "text"`, `item comment resolve <item> <id>` (`--reopen` undoes it), `item comment delete`, and `testpion item comment open --json` for every open comment of the workspace, newest first. An item is written `kind:id` (`request:<collectionId>:<requestId>`, `test:tests/smoke.yaml`, `saved:evaluations:<id>`, `monitor:<id>`) or as a `testpion://` link. An AI agent uses the MCP tool `team_comments` (`open` first, to read what the team asks; `add` to answer in the thread). Nothing is sent anywhere; a comment is as private as the repository.

## Several tenants in one workspace

::: v-pre
When one team tests the same API for several customers or deployments (Acme's and Globex's instances of one product), a tenant is an environment **group**: give each tenant's environments the same group name and everything knows the tenant. The picker and the lists show *Acme ▸ Staging*; **New tenant from Acme…** copies a whole group for a new customer; a flow runs for every tenant at once (`--env-matrix group:Acme`); a monitor can run in **every environment of a group**, one row per tenant in the list, the status page and the alerts, from one definition; `testpion monitor status --group Acme` writes one tenant's status page; `{{$group}}` and `{{$environment}}` name the tenant inside a request; a problem about a tenant carries it (the Problems panel's **Tenant** select, `testpion problems --group Acme`); and the `no-leak` check with `otherEnvironments: true` fails a response that holds another tenant's values. Nothing of one tenant reaches another's run, result or export, and a change made for every tenant is made once. Details: [Groups](/api-testing/environments#groups-tenants-customers-deployments), [Monitors](/test-runner/monitors).
:::

## When two people changed the same thing

Different requests merge by themselves. If you both changed the same request, TestPion shows both versions side by side and you choose.

## Next

- [Keep your workspace in git](/getting-started/git): every setting and button.
- [Secrets](/security/secrets): where values live and how CI gets them.
- [When something does not work](/getting-started/troubleshooting).
- [Glossary](/getting-started/glossary): words you may not know.
