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

## When two people changed the same thing

Different requests merge by themselves. If you both changed the same request, TestPion shows both versions side by side and you choose.

## Next

- [Keep your workspace in git](/getting-started/git): every setting and button.
- [Secrets](/security/secrets): where values live and how CI gets them.
- [When something does not work](/getting-started/troubleshooting).
- [Glossary](/getting-started/glossary): words you may not know.
