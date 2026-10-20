---
title: "Keep your workspace in git"
description: "Put a TestPion workspace in a git repository: what is committed, the Git view (changes by meaning, commit, branches, pull and push), the secret guard, merging collections request by request, request history, the CLI, AI agents and CI."
---

::: v-pre

# Keep your workspace in git

A TestPion workspace is a folder of plain JSON and YAML files, so it can live in a git repository: on its own, or in a folder of your code repository (for example `api-tests/`). Your team reviews changes to requests in pull requests, CI runs the tests from the same files, and secrets never get committed.

TestPion uses the **git installed on your computer**. It brings your SSH keys, your sign-in (Git Credential Manager on Windows, the keychain on macOS), commit signing and hooks. Install git from [git-scm.com](https://git-scm.com) if you don't have it, then restart TestPion.

## What is committed, and what isn't

| Committed (shared with your team) | Stays on this computer |
|---|---|
| `workspace.json`, `collections/`, `environments/`, `tests/`, `library/`, `specs/`, datasets | Run results (`runs/`, `reports/`, `baselines/`), traces and payloads |
| Variable names and non-secret values | **Secret values** (in the OS secret store, never in a file) |
| `.gitignore` and `.gitattributes` written by TestPion | The local database (`database.sqlite`), `.local/` (save counters, per-computer state), `trash/` |

Every file TestPion writes is in a **stable form**, so saving an item without changing it changes nothing in git, and two people editing different items merge cleanly:

- keys in a fixed order (an item's id and name first, the rest sorted), the same on every computer;
- no volatile field: a collection keeps its save counter and time in `.local/`, a library item has no `updatedAt`;
- LF line endings and exactly one final newline, on Windows too (a test file you edit keeps your text and only gets LF and the final newline);
- lists keep the order you see (MCP servers, environment variables, requests).

| What | File | Stable form |
|---|---|---|
| Collections, folders, requests (HTTP, GraphQL, SOAP) | `collections/<id>.json` | yes |
| Environments | `environments/<id>.json` | yes |
| Workspace settings and variables | `workspace.json` | yes |
| Saved gRPC calls, connections, prompts, load tests, evaluations, monitors | `library/<kind>.json` | yes |
| MCP servers, AI providers | `mcp-servers.json`, `providers.json` | yes |
| HTTP Debugger rules | `debugger/rules.json` | yes |
| Test files and flows | `tests/**/*.yaml` | your text; LF and a final newline |
| API definitions, datasets, script packages, MCP mocks, .proto files | `specs/`, `datasets/`, `packages/`, `mocks/`, `protos/` | your file, never rewritten by the app |

An older file is read as it is and written in the stable form the next time its item is saved; nothing is rewritten when you open the workspace.

## Step 1: Put the workspace in git

Pick one:

- **A new repository for the open workspace.** Open the **Git** view (the rail's **More…**, or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Go to Git*) and click **Initialize repository**. TestPion runs `git init`, writes `.gitignore` and `.gitattributes`, and sets up merging by request (see [Merging](#merging-collections-request-by-request)).
- **Connect to a remote.** In the Git view click **Connect to a remote…** (or **⋯ ▸ Change remote…** later) and paste the URL of an empty repository, for example `https://github.com/team/api-tests.git` or `git@github.com:team/api-tests.git`.
- **Clone a repository that already holds a workspace.** Open the workspace switcher (top left) and click **Clone**, or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Clone Workspace from Git…*. Paste the URL, choose a parent folder; TestPion clones into a folder named after the repository and opens the workspace. When the workspace is in a sub-folder (`api-tests/`), it is found; when the repository holds several, you choose one.
- **A workspace in your code repository.** Create the workspace in a folder of the checkout (**New**, then *in a folder*), or **Open folder** for one that is there already. TestPion only looks at the workspace folder: the rest of the repository is never listed or committed by it.
- **From a terminal:** `git init` in the workspace folder, then `testpion git setup` (writes the git files and registers the merge driver; safe to run again).

An existing workspace you started before this version: workspace switcher ▸ **⋯ ▸ Make ready for git** (or `testpion git setup`) adds the git files and tidies the collection files once.

## Step 2: Sign in to the remote

There is nothing to set up in TestPion: git signs in the way it does in a terminal.

- **HTTPS (GitHub, GitLab, Bitbucket, Azure DevOps):** run `git push` (or `git clone`) once in a terminal; the credential manager asks you to sign in in the browser and remembers it. TestPion's pushes and pulls then work.
- **SSH:** add your public key to your account (`ssh-keygen -t ed25519`, then paste `~/.ssh/id_ed25519.pub` in the website's SSH keys page) and use the `git@…` URL.

When git can't sign in, TestPion says so in plain words ("Git could not sign in to the remote") instead of waiting for a password.

## Step 3: Work with the Git view

The **Git** view shows the branch and remote at the top, then:

- **Changes, by item.** Each row names what changed, not the file it is in: an icon for its kind, a change mark, the item's name and what changed in words (the file's path is the muted text beside it, and Stage / Discard act on the file). *MCP server Weather: URL, environment (added TOKEN)*, *AI provider OpenAI: model, headers (added X-Team)*, *Prompt Greeting: moved, settings*, *API definition petstore.json: 2 operations added, 1 breaking change*, *Dataset users.csv: 12 rows added, column dob removed*, *Workspace settings: variables (added region)*. A file that holds several items (a collection, the MCP servers) is a header with its items under it. The down arrow of the Changes list saves them as Markdown by item, or as a patch. What changed, file by file in words, for requests, environments and flows: *HTTP basics ▸ Requests & responses ▸ GET with query parameters: URL, headers (0 → 1)*, *environment Staging: added baseUrl*, *Checkout ▸ pay: body, if, checks (1 → 2)*, *Connection Echo socket: renamed from …* (saved gRPC calls, connections, prompts and monitors one by one). Click a change to open it where it is edited: a request in its own editor (REST, SOAP, GraphQL), a folder or collection's settings, an environment, a gRPC call or a connection, a test file or the flow step; right-click for **Open in new tab** and **Copy link** ([Finding your way around](/getting-started/finding-your-way)); **Compare** shows a changed request, a flow step, the collection's settings or an environment side by side, part by part: the last commit and now. Click a file name for its line diff. **Stage** / **Unstage** per file, **Discard** (back to the last commit; new files are deleted, after a confirmation) per file or all.
- **Commit.** Write a message, or click **Write message** and the AI assistant writes one from the changes (it sees the changes' meaning, never secret values). With nothing staged, **Commit** commits every change of the workspace.
- **History.** The latest commits of the workspace.

The rest of the app shows git too:

- **Status bar:** the branch, `↑2` commits to push, `↓1` to pull, `• 3` changed files. Click it to open the Git view.
- **Explorer:** every changed row carries a mark: **M** changed, **A** added, **D** deleted, **R** renamed, **!** conflict. It is on requests, folders and collections, gRPC calls and connections, environments, test files and flows, MCP servers, AI providers, prompts, load tests, evaluations, monitors, API definitions and datasets. A folder and a section header (*MCP servers*, *Datasets* …) show how many changes are inside, as a number.

### Flows, step by step

A test or flow file under `tests/` is compared by meaning too, step by step (a step is known by its `id`):

- **Steps added, removed or renamed**: *Checkout ▸ receipt: step* added; a step whose id changed but whose content did not is *renamed* (*was cart*); a new `name:` is *renamed from "Cart"*.
- **Steps changed, with the parts**: *request line* (method, URL), *params*, *headers*, *cookies*, *auth*, *body*, *extract*, *checks (1 → 2)*, *if* (`if:` / `when:`), *forEach* (`repeat:` / `forEach:`), *scripts*, *sub-flow*, and settings such as *retries* or *timeout* by name.
- **Connections**: *Checkout ▸ connections: added login → pay, removed cart → pay* (the `dependsOn` edges; those of added or removed steps go without saying).
- **The file**: *flow Checkout: expose (MCP tool), output, steps reordered*, and **rearranged** when only the designer's `layout:` moved: dragging steps on the canvas is never reported as a change to what runs. A change to comments or formatting alone is *formatting or comments*.

**Compare** on a step shows it part by part; on the flow line, the file's settings and its list of steps with what each waits for. The same meaning goes into pull-request descriptions (**Pull request** in the Git view), `testpion diff --json` / `--markdown` and the `git_diff` MCP tool (`file` + `itemId` = a step id for one step side by side).

### The secret guard

Before every commit TestPion checks for secrets **typed into** the workspace: a bearer token in a header, a password in basic auth or in a body field, a variable that holds a key in plain text, an MCP server's env or headers, a provider API key. It finds them by their name and by their shape (a JWT, a `Bearer` token, a private key, a provider key such as `sk-…`, `ghp_…` or `AKIA…`, a connection string with a password), so a variable named `dbUrl` that holds `postgres://app:…@db/clinic` is found too: the same detector that keeps secrets out of [workspace exports](/security/privacy#exports). When it finds one, nothing is committed and the list says where:

> **Not committed: 2 secrets are typed into the workspace**
> environment Staging, variable apiKey (environments/staging.json) …

Fix them by making them **secret variables** (the lock icon: their values move to the OS secret store) or by using `{{variables}}`, then commit again. **Commit anyway** is there for demo values you mean to share.

The same check runs in the terminal: `testpion git check` (exit code 1 when something is found), and `testpion git hook install` adds a git **pre-commit hook** so a plain `git commit` is checked too (an existing hook of yours is never overwritten).

## Step 4: Branches, pull and push

- **Branch button** (top of the Git view): switch to another branch (a remote branch becomes a local one that tracks it), **New branch…** (your uncommitted changes come along), **Rename** the current branch, or **Delete a branch** (a branch with commits no other branch has asks once more).
- **Fetch** sees what the remote has; **Pull** brings in your team's commits; **Push** sends yours (the first push of a branch sets where it goes).
- **Pull & push.** When your team pushed commits you don't have and you have commits to push, **Push** becomes **Pull & push** and a strip says *Your team pushed 2 commits. Pull before pushing.* (with **Pull & push** and **Pull**). Pull & push pulls with a merge (collections merge request by request, see [Merging](#merging-collections-request-by-request)) and then pushes, so two people changing the same collection never get stuck at a refused push. If someone pushes in between, it pulls once more and pushes again. When the same request was changed on both sides it stops before pushing: the **Conflicts** list opens with *Resolve the conflicts, commit, then Push*. A push the remote refused anyway says so in a message with **Pull & push** as its button.
- **Background fetch.** While a workspace in git with a remote is open, TestPion fetches quietly every 5 minutes (and when you open the Git view), so the **Pull** count, the strip and a small count on the rail's **Git** icon (on **More…** while Git is not shown on the rail) show your team's new commits before you push. It never asks you to sign in (a remote that needs it is skipped and noted in the log) and never runs during a pull or push. Change the interval, or turn it off with 0, in **Settings ▸ Git**.
- **Uncommitted work during a pull.** When git would refuse to pull because of changes you have not committed, TestPion sets them aside (`git stash`), pulls, and puts them back; the message says *Your uncommitted changes were set aside and put back*. Putting them back merges collections request by request too, so an unsaved-to-git edit of one request survives a pull that changed another request of the same collection. If your change and the pulled one touch the same request, the file is listed under **Conflicts**. Open request tabs with unsaved edits are named before a pull: pull anyway (a request the pull changes then asks which version to keep) or save them first.
- **Pull request:** on a branch other than the default, the Git view shows **Pull request**. It opens GitHub, GitLab, Bitbucket or Azure DevOps with the branch selected and, on GitHub and GitLab, the description filled with the branch's changes by meaning.

After a pull or a branch switch the app reloads the changed collections, environments and tests by itself. A change made outside TestPion (a `git pull` in a terminal, another editor) shows up the same way, with a message saying what changed.

TestPion knows its own saves by the file and what it wrote into it, not by the time: a file another program changes right after TestPion saved it (an editor that saves on focus, a formatter, an AI agent running `testpion` in a terminal) is still reported and shown. Files that TestPion writes itself (a test file saved from the editor or through `tests.write`, generated tests, a dataset, an import) show up in every list at once, with no message. (Inside the app, every such change arrives as one `data.changed` event naming the RPC, the kinds and the paths it wrote; see [Every write says what it changed](/architecture/design#cloud-ready-design).)

## Merging collections request by request

Two people who change **different requests** of the same collection never get a conflict: TestPion merges collection files by the id of each request and folder, not by lines of JSON. Environments merge the same way, variable by variable, library files (saved gRPC calls, connections, prompts) item by item, and the lists of MCP servers and AI providers server by server (the order is yours, with what the other side added after its neighbour). A request added on one side and another added on the other side both end up in the file; a request moved, renamed or edited on one side keeps that change.

This is a git **merge driver**. `.gitattributes` has `collections/*.json merge=testpion` (and the same for `environments/`, `library/`, `mcp-servers.json` and `providers.json`; `workspace.json.bak-*` and `*.tmp-*` are ignored), and **Initialize repository**, opening a workspace that is in git, or `testpion git setup` registers it in the repository's git config (`git config merge.testpion.driver`). It works for `git merge` and `git pull` in a terminal too.

A **real conflict** is the same request (or the same collection setting) changed differently on both sides, or a request changed on one side and deleted on the other. The file then keeps your version with every other change merged in, and the Git view lists the file under **Conflicts**:

- **Compare…** (collection files) shows each conflict side by side: the request (or setting) as it was before, your version and theirs, part by part (request line, params, headers, auth, body, scripts, checks), with the parts that differ marked. Choose **Mine** or **Theirs** per conflict (or Keep all mine / Take all theirs), then **Resolve with these choices**: every change that did not conflict, from both sides, stays.
- **Keep mine** / **Take theirs** settles the file. In a collection file only the requests changed on both sides take the side you choose; every other change from both sides stays. Other files are taken whole from that side. In a terminal: `testpion git resolve collections/payments.json --theirs` (or `--ours`).
- **Cancel the pull** goes back to before the pull.
- When every file is settled, **Commit** finishes the merge.

**Items open while files change.** When a pull, a branch switch or another editor changes something you have open (a REST, SOAP or GraphQL request, a saved gRPC call or connection, an MCP server's settings, a monitor being edited), the editor shows the new version by itself. If you have unsaved edits there, TestPion asks first, the same question everywhere: **Keep mine** (saving then replaces the new version with yours) or **Take the new version**. Several changes at once ask one question at a time.

## History, restore, discard, stage and who changed what, for every item

Every item of a versioned kind has a **Git** group in its menu (right-click, or the **⋯** button), and the same buttons sit on its row in the **Git view**:

| In the menu | What it does |
|---|---|
| **History in git…** | The commits that changed *this item*, newest first, each with what it changed. Click one to see it side by side with now. **Restore this version** shows what would change, writes just that item, and offers **Undo**. The other tab, **Who changed what**, names for each field the author, commit and date of its last change ("not committed yet" for a change you have not committed). |
| **Discard changes…** | Throws away the uncommitted change of *this item only*. A second MCP server, another request or a different prompt changed in the same file stays as it is. A new item is removed; a new file is deleted. Undo puts it back. |
| **Stage changes** | Stages the file the item is in. A file that holds several items stages as one file: the message says which other changed items come along. |

This works for requests and folders, collections, environments, test files and flows, API definitions, datasets (a database is restored whole), MCP servers, AI providers, saved gRPC calls and connections, prompts, load tests, evaluations and monitors. The menu items are greyed out ("No uncommitted changes") for an item git does not see a change in.

Things worth knowing:

- Restore and Discard write the item in the same stable form the app always writes, so they never make a file change more than the item. Line endings follow the file: a `core.autocrlf` repository keeps its CRLF working copies.
- Every restore and discard is kept for undo in `.local/git-undo/` (git ignores it; the newest 30 are kept). Undo is the toast, `Ctrl+Z`, `testpion git undo`, or the MCP tool `git_undo`.
- Nothing outside the workspace is ever written, and a workspace that is a folder of a bigger repository works the same.
- Without git installed, the Git view and every command say so plainly ("Git is not installed") and change nothing.

### Set changes aside

**Set changes aside…** (Git view) takes every uncommitted change of the workspace away under a name ("Before the pagination rewrite"); the workspace goes back to the last commit. The list shows each stash by name, branch and date, and by item when opened. **Put back** brings the changes in again (and removes the entry; if they clash with what is there now they appear in the conflict list and the entry is kept), **Drop** deletes it for good. Command line: `testpion git stash push -m "name"`, `list`, `show`, `apply`, `pop`, `drop`.

## When a merge conflicts: every kind of file

After a pull that stops on conflicts, the Git view lists the conflicted files with **Resolve…**. What the screen shows depends on the file:

- **Collections, environments, library files, MCP servers, AI providers, the workspace settings and the Debugger rules** are merged by meaning: item by item, and inside an item changed on both sides, field by field. Fields only one side changed are merged for you; the screen lists only the fields that clash (`request.url`, `data.prompt` …).
- **Test and flow files, API definitions, mocks, datasets** are text: the lines both sides changed differently are *hunks*, each named by the step or item it is in ("near step create-order"); everything else merged.
- **A database or an image** cannot be merged: you take one side whole, with both sizes shown.

For each conflict choose **Keep mine**, **Keep theirs** or **Edit** (for an item or a field the value as JSON, for a hunk the lines to keep). The file is written in the stable form and marked resolved; commit to finish the pull. On the command line: `testpion git conflicts [file] [--json]` lists the keys, `testpion git resolve <file> --pick key=theirs --edit key=<value>` settles them, `testpion git conflicts --resolve ours|theirs` settles every file the same way.

## The commit scans what is staged

When you press **Commit**, the files that will be committed (the staged ones, or all changes when nothing is staged) are scanned for secrets *as they are staged*, not as they are in the working folder, with the detector the exports use: collections (headers, auth, variables), environments and workspace variables, MCP servers (every header and environment value), providers, saved items, test files, API definitions, datasets and the shape of keys, private keys and passwords in any other text file.

- A **certain** secret (a secret name with a typed value, or a value shaped like a provider key) refuses the commit. The message names the item and the variable to use ("MCP server Weather: headers.Authorization, use `{{WEATHER_AUTHORIZATION}}`"). There is no "commit anyway" for these: put the value in a secret variable, or unstage the file. **Fix** does it for collections, environments and workspace variables and stages the fix.
- A **probable** secret is listed and can be committed after a confirmation (`--allow-secrets` on the command line).
- Fixing the working file is not enough until the fix is staged: the scan reads the index.

`testpion git check --staged` runs the same scan; the pre-commit hook still checks the working folder.

## History of a request, a collection or an environment (the original page)

Right-click a request in the explorer (or **⋯**) ▸ **History in git…**: the commits that changed this request (commits that changed only other requests are left out), each compared with the request as it is now, part by part. Select one and **Restore this version**: only this request changes, as a new change for you to commit; nothing in git history is rewritten. A collection's menu and an environment's menu have **History in git…** too: there the whole collection or environment goes back.

## From the command line

Every git feature has a CLI command with `--json` for scripts. `-w` picks the workspace (default: the one in the current folder).

```bash
testpion git setup              # .gitignore, .gitattributes, tidy collection files, merge driver
testpion git status             # branch, ahead / behind, changed files
testpion git changes            # what changed, by meaning
testpion git status --by-item   # the same rows as the Git view: "MCP server Weather", "Dataset users.csv" …
testpion git status --by-item --kind mcp-server dataset --json   # only some kinds, for scripts
testpion git diff collections/payments.json
testpion git check              # secrets typed in? exit 1 if any
testpion git commit -m "Add payment tests"      # refuses when a secret is typed in
testpion git log --file collections/payments.json
testpion git branch                         # -m new-name renames this branch; -d / -D deletes one
testpion git switch -c feature/payments
testpion git pull               # exit 1 when it stopped on conflicts
testpion git sync               # pull & push: exit 0 pushed or up to date, 1 conflicts (listed), 2 errors
testpion git conflicts                      # each conflict, part by part, with its key
testpion git resolve collections/payments.json --theirs   # settle a conflict (or --ours)
testpion git resolve collections/payments.json --pick item:req-12=theirs   # a choice per conflict
testpion git push
testpion diff origin/main HEAD --markdown       # the changes between two commits, as Markdown
```

## AI agents

The workspace's MCP server (see [Use from AI agents](/ai-testing/mcp-server)) has git tools:

| Tool | What it does |
|---|---|
| `git_status` | Branch, ahead / behind, changed files. |
| `git_changes` | What changed, item by item, named like the app (`MCP server Weather`, `Dataset users.csv: 12 rows added`), with the registry `kind`, `details`, the item's `ref` and `link`, and the file; filter with `kind` or `file`. The same rows as the Git view and `testpion git status --by-item --json`. |
| `git_diff` | The changes by meaning (requests, environments, flow steps and connections); with `from` / `to`, between two commits (`markdown: true` for a pull-request comment). |
| `git_log` | Commits of the workspace, a file or a collection. |
| `git_sync` | Pull & push in one step; returns `pushed`, `up-to-date`, `pulled-nothing-to-push`, or `conflicts` with the files (nothing is pushed then). Not available on a read-only server. |
| `git_propose_commit` | Stages the changes and saves the agent's commit message as a proposal (after the secret check). It does **not** commit: the message appears in the Git view's commit box for you to review and commit. Not available on a read-only server. |

## In CI: test every pull request

A pull request that changes the workspace gets its tests run and a comment that lists what it changes. GitHub Actions:

```yaml
# .github/workflows/api-tests.yml
name: API tests
on: pull_request
permissions: { contents: read, pull-requests: write }
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # the base branch, for the diff
      - uses: actions/setup-node@v4
        with: { node-version: 24 }
      - run: git clone --depth 1 --branch v0.51.0 https://github.com/nasimuddin-dev/testpion.git "$RUNNER_TEMP/testpion" && cd "$RUNNER_TEMP/testpion" && npm ci && npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli
      - name: What the pull request changes
        run: |
          T="node $RUNNER_TEMP/testpion/packages/cli/bin/testpion.js"
          { echo "### Changes to the API tests"; $T diff "origin/${{ github.base_ref }}" HEAD --markdown -w api-tests; } > comment.md
      - name: Run the tests
        run: node "$RUNNER_TEMP/testpion/packages/cli/bin/testpion.js" run -w api-tests -e Staging -r console junit -o test-results
        env:
          TESTPION_SECRET_ENV_STAGING_APIKEY: ${{ secrets.STAGING_API_KEY }}
      - name: Comment on the pull request
        if: always()
        run: |
          echo "" >> comment.md
          echo "Tests: ${{ job.status }}. Reports are in the run's artifacts." >> comment.md
          gh pr comment ${{ github.event.pull_request.number }} --body-file comment.md
        env: { GH_TOKEN: ${{ github.token }} }
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: test-results, path: test-results }
```

GitLab CI, the same idea:

```yaml
api-tests:
  image: node:24
  rules: [{ if: $CI_PIPELINE_SOURCE == "merge_request_event" }]
  script:
    - git clone --depth 1 --branch v0.51.0 https://github.com/nasimuddin-dev/testpion.git /tmp/testpion && (cd /tmp/testpion && npm ci && npm run build -w @testpion/shared -w @testpion/core -w @testpion/cli)
    - git fetch origin "$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"
    - node /tmp/testpion/packages/cli/bin/testpion.js diff "origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME" HEAD --markdown -w api-tests | tee changes.md
    - node /tmp/testpion/packages/cli/bin/testpion.js run -w api-tests -e Staging -r console junit -o test-results
  artifacts:
    when: always
    paths: [test-results, changes.md]
    reports: { junit: test-results/junit.xml }
```

Secret values come from the CI system's secrets as `TESTPION_SECRET_…` variables; see [CI/CD](/test-runner/ci-cd) for their names and for generating a pipeline file.

## What a workspace from someone else can do

A workspace is data, but two things in it reach outside the app, and both ask first:

- **Programs:** a `stdio` MCP server is a command the workspace starts on your computer. The first **Connect** shows the command line and asks (Run once / Always for this workspace).
- **Your environment:** `{{$env.NAME}}` reads only the OS environment variables you list in **Settings ▸ Privacy**; a request that reads another one says so instead of sending it.

Requests themselves can call any URL, as in any API client: review a pull request's changes (the Git view lists them by meaning) as you would review code.

## Team workflow, in short

1. One person makes the workspace ready for git, commits and pushes.
2. Everyone else clones it (**Clone** in the workspace switcher) and signs in to the remote once with git.
3. Work on a branch, commit with the secret guard on, push (**Pull & push** when the team pushed first; `testpion git sync` in a terminal), open a pull request (the button fills in the changes).
4. CI runs the tests and comments with the changes; reviewers read requests, not JSON.
5. Pull often: the Git view tells you when the team pushed (it fetches in the background). Different requests merge by themselves, uncommitted work is set aside and put back; the same request changed twice asks you to keep one side.

:::
