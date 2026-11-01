---
title: "Work as a team"
description: "Share one TestPion workspace with your team through git: set it up, invite a teammate, fill in secrets, see what others changed, and keep merges calm."
---

# Work as a team

::: tip In short
A TestPion workspace is a folder of plain files, so your team shares it through git. This page is the path from one person to many. **About 10 minutes.**
:::

## What is shared and what is not

Requests, environments, tests and flows are shared through git. Secret values are not. Each person types their own, and they stay on that person's computer.

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
- **Your team's changes** on Home shows what others changed in the last two weeks, in words (*Ana, 2 hours ago: Search: URL*).
- Rest the pointer on an item in the explorer to see who changed it last.

## Comments next to the item

A question about a request, a test file, an evaluation or a monitor belongs next to it, not in a chat nobody finds again. Open the item, open the **Info** panel on the right, and write under **Comments for your team**: *Why does this send X-Trace twice?* The comment is signed with your git name and dated, and saved in the workspace under `comments/` (one small file per item, so two people commenting on different items never conflict). Commit and push it like anything else; a teammate who pulls sees it next to the same item, and the Git view names the change *Comments for the team*. **Mark as settled** greys a comment and takes it out of the open list (*Show 1 settled* brings it back); the bin removes it for good (Undo in the message puts it back). Home lists what your team is still asking under **Your team is asking**, newest first; the item's name opens it.

From the command line or an agent: `testpion item comment list request:<collectionId>:<requestId>`, `item comment add <item> "text"`, `item comment resolve <item> <id>` (`--reopen` undoes it), `item comment delete`, and `testpion item comment open --json` for every open comment of the workspace, newest first. An item is written `kind:id` (`request:<collectionId>:<requestId>`, `test:tests/smoke.yaml`, `saved:evaluations:<id>`, `monitor:<id>`) or as a `testpion://` link. Nothing is sent anywhere; a comment is as private as the repository.

## When two people changed the same thing

Different requests merge by themselves. If you both changed the same request, TestPion shows both versions side by side and you choose.

## Next

- [Keep your workspace in git](/getting-started/git): every setting and button.
- [Secrets](/security/secrets): where values live and how CI gets them.
- [When something does not work](/getting-started/troubleshooting).
- [Glossary](/getting-started/glossary): words you may not know.
