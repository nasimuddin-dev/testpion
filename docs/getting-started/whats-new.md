---
title: "What's new: how to use it"
description: "What's new in TestPion 0.50, 0.49, 0.48, 0.47 and 0.46, step by step: workspace exports with everything and no secrets, imports that list what to check, AI that explains and fixes a failed run and finds out why a test is flaky, AI that writes integration flows from a collection, verified checks and tests, what is sent, Local only and cost caps, a calmer rail with More…, your own keyboard shortcuts, compact density, Undo instead of confirmations, JSONPath suggestions and Diff vs previous, a visual flow designer, a Terminal, one production guard, and the behaviour changes to read before upgrading."
---

::: v-pre

# What's new: how to use it

The options added in 0.50, 0.49, 0.48, 0.47 and 0.46, each with the steps to use it and a link to the full reference. Where it makes sense, an option also works from the terminal (`testpion …`, with `--json`) and for AI agents (an MCP tool of `testpion mcp-server`). **Read the behaviour changes of [0.50](#behaviour-changes-in-0-50), [0.49](#behaviour-changes-in-0-49), [0.48](#behaviour-changes-in-0-48), [0.47](#behaviour-changes-in-0-47) and [0.46](#behaviour-changes-read-before-upgrading) before upgrading.** The 0.45 additions follow [below](#what-was-new-in-0-45); older ones are in the [changelog](/changelog).

## What's new in 0.50: nothing lost, nothing leaked {#whats-new-in-0-50}

0.50 makes moving work in and out of TestPion safe: a workspace export holds everything it needs and no secret, an import says what it could not bring over instead of guessing, and nothing you delete or import over is gone for good.

- **Export a whole workspace** with its API definitions, datasets, mocks and protos, every typed-in secret replaced by a `{{variable}}` and listed ([steps](#workspace-export-files)).
- **Imports that tell you what did not come over**: unsupported auth, Insomnia template tags and scripts, Bruno scripts and `.env`, GraphQL schemas, each with a note naming the request ([steps](#import-fidelity), [Import fidelity](/getting-started/import-fidelity)).
- **An import never overwrites an API definition**: both are kept, with **Replace instead** ([steps](#spec-keep-both)).
- **Delete an MCP server with Undo**, and find it, a replaced API definition or a deleted dataset in **Recently deleted** ([steps](#mcp-server-undo)).
- **The Collections sidebar shows each request once**: rows no longer repeat or vanish when two collections share request ids, and dragging a row leaves no ghost behind ([details](#sidebar-rows)).

### Behaviour changes in 0.50 {#behaviour-changes-in-0-50}
- **Workspace exports hold more, and never a secret.** They now include the files of `specs/`, `datasets/`, `mocks/` and `protos/` (a file over 10 MB, or past 50 MB in all, is left out and named). A token, password or key typed into a collection's auth or headers, every MCP server header and `env` value (except names such as `Content-Type` or `NODE_ENV`), a password in a connection string and a provider key become `{{variables}}`; the message after export lists each one, and the import lists the **values needed**. Set them as secret variables of an environment on the other computer.
- **The export file is called `<workspace name>.testpion.json`** (it was `.apsworkspace.json`, which still imports), and `testpion workspace export` writes it without `-o`.
- **Importing an API definition no longer overwrites one of the same name.** A different document is saved beside it as `specs/<name>-2…`; **Replace instead** in the message (or `testpion import --replace-spec`) puts it in the old one's place, and the old one goes to Recently deleted.
- **Deleting an MCP server no longer asks first**: it goes at once with **Undo**, like every other item that can come back, and Recently deleted keeps it for 30 days.
- **An unsupported auth imports as No auth, never inherit.** A Postman, Insomnia, Bruno or Hoppscotch request with Hawk, NTLM, EdgeGrid, ASAP, WSSE, netrc or another scheme TestPion doesn't have used to inherit its folder's auth, so it could send credentials it was never meant to. It now sends **No auth**, with a disabled `X-Imported-Auth-<Scheme>` header and a note: set it up by hand.
- **Imported Bruno scripts are written with `tp.*`** (`bru.setVar` → `tp.collectionVariables.set` …); `req`, `res` and `test` still run as in Bruno, and **Export ▸ Bruno collection folder** writes `bru.*` back.
- **Every import lists its notes**: *Check after import (N notes)* in the app, up to 20 in `testpion import` (all in `notes` with `--json`), and `notes` in the MCP tool `import_definition`.

### Export a whole workspace, nothing lost and nothing leaked {#workspace-export-files}
1. **File ▸ Export ▸ Workspace…**, **Export** in the workspace switcher, or the Collections sidebar's **Export** icon ▸ *The whole workspace*. The file is called `<workspace name>.testpion.json`.
2. It holds the collections, environments, tests, saved items and MCP servers, and now the files of `specs/`, `datasets/` (a SQLite dataset too), `mocks/` and `protos/`. A file over 10 MB is left out and named in the message, never dropped silently.
3. Read the message after export: it lists every secret it replaced. A token typed into a collection's auth or a header, an MCP server's header or `env` value, a database password in a connection string, a provider key: each becomes a `{{variable}}` (`Bearer {{PETSTORE_MCP_AUTHORIZATION}}`), and its value stays on your computer. Names that never hold a secret (`Content-Type`, `Accept`, `NODE_ENV` …) are kept as they are.
4. **Import** the file on the other computer: it opens as a new workspace, and the message lists the **values needed**. Set them as secret variables of an environment.

<figure class="aps-screenshot">
  <img src="/images/export-workspace.jpg" alt="The Export dialog with The whole workspace chosen: the file name, what it holds and that secret values are replaced by variables" width="1440" height="900" loading="lazy">
</figure>

Terminal: `testpion workspace export <workspace> [-o file] [--json]` (`--json` returns `replaced: [{ kind, item, field, variable }]` and `notes`). ([Export](/api-testing/collections#export-the-whole-workspace), [Privacy: exports](/security/privacy#exports))

### Imports that tell you what did not come over {#import-fidelity}
1. Import a Postman, Insomnia, Bruno or Hoppscotch collection as before (**Import** ▸ **Choose file…**, **Bruno folder…**, a link or pasted text; `testpion import`).
2. Read the **Check after import** message: it names each request whose auth, template tag or script needed a change (`testpion import --json` lists every note under `notes`).
3. Look for a disabled `X-Imported-Auth-…` header: the request's auth scheme isn't in TestPion yet, so it sends **No auth** (never the parent's) until you set it up.
4. Insomnia `{% response %}` chaining becomes a variable such as `{{insomnia_log_in_access_token}}`, set by the post-response script of the request it comes from: send that request first (or run the collection in order).
5. For a Bruno folder with a `.env`, activate the *Bruno .env* environment (or any imported one): its secret values are in the secret store. A GraphQL schema file (`.graphql`) becomes a request for `{{graphqlUrl}}`: set that variable. What each importer maps: [Import fidelity](/getting-started/import-fidelity).

<figure class="aps-screenshot">
  <img src="/images/import-notes.jpg" alt="After importing a Postman collection with a Hawk request: the message Check after import (1 note) names the request, set to No auth with a disabled X-Imported-Auth-Hawk header" width="1440" height="900" loading="lazy">
</figure>

### Importing an API definition never overwrites one {#spec-keep-both}
1. Import an OpenAPI or AsyncAPI document whose name the workspace already has (for example a newer version of `specs/petstore.openapi.yaml`).
2. TestPion keeps both: the new document is saved as `specs/petstore-2.openapi.yaml`, its requests check that file, and the message says *Saved as specs/petstore-2.openapi.yaml*. The same document imported again is not copied.
3. Click **Replace instead** in the message to put the new document in the old one's place: the old one goes to **Recently deleted** (30 days), and the new collection's contract checks follow.

Terminal: `testpion import openapi.yaml -w <workspace>` keeps both and prints the same note; `--replace-spec` replaces at once.

### Delete an MCP server with Undo {#mcp-server-undo}
1. In the Collections sidebar, an MCP server's ⋯ ▸ **Delete** removes it at once (no question first); a connected server is disconnected.
2. Click **Undo** in the message (or press <kbd>Ctrl</kbd>+<kbd>Z</kbd>) within 8 seconds: the server comes back in its place in the list, with its settings, and reconnects if it was connected.
3. Later, click **Recently deleted** (the icon beside the sidebar's Filter box): it keeps deleted collections, datasets, MCP servers and API definitions replaced by an import for 30 days, with **Restore** (`testpion trash list` / `trash restore`).

<figure class="aps-screenshot">
  <img src="/images/recently-deleted.jpg" alt="The Recently deleted dialog of the Collections sidebar listing a deleted MCP server and an API definition, each with Restore" width="1440" height="900" loading="lazy">
</figure>

### One row per request in the Collections sidebar {#sidebar-rows}
- Two collections may hold requests with the same id (a copied collection file, an import, an older examples update). The sidebar now tells them apart, so no row is shown twice or goes missing.
- Imports, moves and copies between collections, and examples updates, give a fresh id to a request whose id is already taken.
- A second copy of an example collection left by an older version (such as two *Live streams (SSE)*) is merged back into one when the examples workspace is updated; the copy is kept in **Recently deleted**.
- Dragging a row shows one small chip with its name, and the row never stays behind as a ghost.

<figure class="aps-screenshot">
  <img src="/images/examples-sidebar.jpg" alt="The TestPion Examples workspace in the Collections sidebar: each example collection listed once, Live streams (SSE) open with its three requests" width="1440" height="900" loading="lazy">
</figure>

## New since 0.49 {#new-since-0-49}

### Save any response or result {#save-any-output}
1. Every response and result has the same **down arrow** at the right end of its bar. This covers the response body and every response tab, gRPC, GraphQL, WebSocket, MQTT and Kafka logs, MCP tool results, run results, timelines, data-run grids, load results, the evaluation matrix, the console, the log, the terminal, Problems and the HTTP Debugger.
2. **Click it** to save in the default format, or open **▾** to choose one: JSON, CSV, HTML, Markdown, HAR, JUnit, ZIP, raw bytes and more. The **Save as** dialog opens in the folder you last used, and the message after saving has **Show in folder** and **Open**.
3. **Copy** sits next to the arrow.
4. **Logs and reports are saved with secrets masked.** Choose **▾ ▸ Include secrets…** to keep them. TestPion asks first.
5. <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> saves the output you are in.

Big bodies and long result lists are written straight from disk, with progress and **Cancel**. ([Save and export results](/getting-started/save-and-export-results))

## What's new in 0.49 {#whats-new-in-0-49}

### Behaviour changes in 0.49 {#behaviour-changes-in-0-49}
- **`testpion run-collection` records what it ran** (on a collection of the workspace): the collection, the requests and folders picked, the iterations. The app's **Run again** and **Run in CI…**, `ci --run last` and the triage now find its saved requests.
- **Attempt to fix and the triage obey the production guard**: in an environment marked as production, **Attempt to fix** asks first like any run (`testpion ai attempt-fix --allow-production`), and the MCP tool `ai_attempt_fix` refuses it unless the server was started with `--allow-production`.
- **A fix is not applied over a newer file**: when the test file or saved request changed after a proposal was made, applying it says *it changed since the proposal was made* instead of overwriting your edit.
- **A damaged run file says so**: a run whose `summary.json` or results cannot be read is named as damaged, with what to do, instead of a parser error.

### Explain and fix a failed run with AI {#ai-triage}
1. On a failed run, open its ⋯ (or right-click it in **Runs**, or the failed run in **Problems** or Home's *Needs attention*) ▸ **Explain and fix failures with AI…**.
2. The dialog says how many failures and groups there are (the same failed check, status and endpoint are one group), the model and the token estimate. Add a hint if you like, choose **Metadata only** to send no body values, then **Explain and fix**.
3. The review lists the **causes** — each with its kind (*test is stale*, *API regression*, *auth* …), a confidence and the evidence: the failing request and response, the failed check, what changed since the test last passed — and the **fixes**, each verified on the failing and the last passing response (*passes now; it follows an API change*). Pick a **Safer:** form when one is offered (TestPion's own update, such as `type $.id = "string"` for an id the server makes up); a bug report has **Copy**.
4. **Apply selected fixes**, then **Rerun the affected tests** (or **Undo**).

Terminal and CI: `testpion ai triage [--run last] [--privacy metadata] [--no-ai] [--apply]`, and `--triage` on `test`, `run` and `run-collection` (a *Triage* section, `triage.md`, and a *Triage (AI)* section in the reports; the exit code stays the run's). Agents: `ai_triage_run`, then `ai_apply_proposal`. ([Explain and fix failures](/ai-testing/ai-features#explain-and-fix-failures-triage))

### Find out why a test is flaky {#ai-flaky}
1. A flaky test (it passes and fails without a change) is listed in **Problems**; its ⋯ ▸ **Why is this flaky?** (also in a result's **History** tab when it flipped).
2. **Analyse**: TestPion reads the test across runs (pass rate, flips, retries, times, statuses) and how its failing responses differ from passing ones; the model names the pattern (*timing*, *shared state*, *rate limit* …) with evidence and a fix — a wait with `until:`, a stable check, isolated data. A retry is only a last resort and is flagged; skipping or quarantining the test is never offered.
3. **Attempt to fix** applies the fix and runs the test 5 times: *Stable: passed 5/5*, *Still flaky* or *Failing*. **Keep the fix**, or **Undo**.

Terminal: `testpion ai run analyze-flaky --item test:jobs/report.yaml`, then `testpion ai attempt-fix <id>`. Agents: `ai_analyze_flaky`, then `ai_attempt_fix`. ([Why is this flaky?](/ai-testing/ai-features#why-is-this-flaky))

### Generated tests that need fewer repairs {#ai-script-reference}
**Generate tests** now gives the model the exact `tp.*` script API, read from the script sandbox itself, and a script that misuses it goes back naming the right member (`tp.response.json().id` for a field read from the raw `tp.response.body`, `tp.response.json()` for `pm.response.json()`, `to.be.ok` for `toBeTruthy()`). In the review, what TestPion changed in the model's answer is listed as *notes*. ([The script API, from the sandbox](/ai-testing/ai-features#verification))

## What's new in 0.48 {#whats-new-in-0-48}

### Behaviour changes in 0.48 {#behaviour-changes-in-0-48}
- **Suggest assertions, Generate tests and Describe a request open a review** instead of adding their result at once: each item was checked first (against the response, or in the sandbox); tick what you want, then **Add to the checks**, **Add to the Post-response script** or **Open as a new request**. Generated tests are added after your own script.
- **AI features need a model you set up**: your Claude key or a provider of the workspace in **Settings ▸ AI assistant** (a local Ollama or LM Studio works offline). **Local only** there refuses cloud models.
- **AI calls can be capped**: tokens per call, tokens per day and cost per day (**Settings ▸ AI assistant ▸ Limits**); a call over a cap is refused before anything is sent. The CLI, MCP agents and CI are counted and capped too.
- **More is masked before anything reaches a model**: credentials found by their shape (JWTs, Bearer tokens, private keys, provider API keys, `?access_token=`) and personal data (e-mail addresses, phone numbers, card numbers, IBANs; **Mask personal data** turns that off).


### Let AI write an integration flow from a folder {#ai-flow-from-collection}
1. In the explorer, right-click a collection or a folder ▸ **Generate integration flow with AI…** (or, on an empty flow's canvas, **Generate with AI**).
2. Check the folder, add a hint if you like (*also test pagination*), choose **Metadata only** to send no body values, read the estimate, then **Generate**.
3. The flow opens on a canvas preview marked *AI-generated*: its steps (your saved requests, in create → read → update → delete order, values passed between them), the model's assumptions, what TestPion dropped, and the badges (*parsed · linted*, *every variable is extracted before it is used*, *2/2 steps pass on a mock*). Edit the YAML, **Try on mock**, **Regenerate** with a hint, or **Accept** — then **Run now**.

Terminal: `testpion flow generate --collection "Veterinary API" --folder Patients [--apply] --json`. Agents: `flow_generate`, then `ai_apply_proposal`. ([Let AI write the flow](/test-runner/integration-testing#let-ai-write-the-flow))

### Suggested checks and tests are proven first {#ai-verified-checks}
1. Send a request, then **Suggest assertions** or **Generate tests** on the response: the review opens by itself.
2. Each check ran against this response and the previous one; a check that pins a changing value (an id, a time) is unticked or flagged with **Safer:** forms (`exists`, `type`, a format `regex`) — click one to use it. Each `tp.test` ran in the sandbox; a failing one is unticked with its message.
3. **Run now** sends the request again and checks everything once more; **Add to the checks** / **Add to the Post-response script** adds what is ticked (your own script is kept).

Terminal: `testpion ai run suggest-assertions --item request:<collection>:<request> --json`. Agents: `ai_run_task` with `task: "suggest-assertions"`. ([Proposals](/ai-testing/ai-features#proposals-review-accept-undo))

### See what an AI action sends, before it is sent {#ai-what-will-be-sent}
1. Next to any AI button (*Explain with AI*, *How to fix (AI)*, *Generate* …) click the **eye** icon, **What will be sent…** (in the assistant panel it is in the header).
2. Read the model (and whether it stays on this computer), each section of the context with its tokens, what was masked, the estimate and the exact messages.
3. Switch **Full (redacted)** / **Metadata only** / **Names only** to send less; **Send** goes ahead with that level.

Terminal: `testpion ai run explain-error --context @error.json --dry-run`. Agents: `ai_run_task` with `dryRun: true`. ([What is sent](/ai-testing/ai-features#what-is-sent-and-how-to-see-it-first))

### Keep AI on this computer, and cap what it costs {#ai-local-only-and-caps}
1. **Settings ▸ AI assistant**: choose a provider of the workspace such as **Ollama (local)** or **LM Studio (local)**, then turn on **Local only** — a cloud model is refused before anything is sent.
2. Under **Models per task**, pick a cheaper model for *Small tasks* and the best one for *Large tasks*.
3. Under **Limits**, set tokens per call, tokens per day or cost per day. **AI Lab ▸ Usage ▸ AI features** shows today's calls, tokens and cost, and what is left.

CLI/CI: `TESTPION_AI_LOCAL_ONLY=1`, `TESTPION_AI_MODEL_SMALL` / `_LARGE`, `testpion ai usage --json`. Agents: `ai_usage`.

### Review AI changes before they are applied {#ai-proposals}
1. Ask for something that changes files, for example **API coverage ▸ Suggest tests with AI** (tests for the coverage gaps). Suggested checks and tests on a response open [the review at once](#ai-verified-checks); a flow has [its own review](#ai-flow-from-collection).
2. The answer ends with **N proposed changes** and the verification badges (*passes on the current response*, *parsed · linted · 4 steps*, *2/2 tests pass*). Click **Review**.
3. Untick what you don't want (failing items start unticked), open an item to see its diff, then **Accept selected** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) — **Undo** in the message puts it back — or **Regenerate** with a hint, or **Discard**.

Terminal: `testpion ai run design-flow -q "…" --path flows/x.yaml`, then `testpion ai apply <id>` (`ai undo <id>`). Agents: `ai_run_task`, then `ai_apply_proposal` after the user agrees.

## What's new in 0.47 {#whats-new-in-0-47}

### Behaviour changes in 0.47 {#behaviour-changes-in-0-47}
- **A single click on a request opens a preview tab** (in italics) that the next click replaces; double-click, <kbd>Enter</kbd> or an edit keeps it. Saved AI prompts, environments and saved Debugger sessions open in tabs the same way.
- **The rail shows five views** (Home, Collections, Tests, Environments, History) and **More…** for the others, so <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>3</kbd> is now **Tests** (it was the Debugger). Right-click the rail ▸ **Show every view** for the old rail.
- **Deleting something you can get back no longer asks**: it goes at once, with **Undo** in the message (8 seconds) and <kbd>Ctrl</kbd>+<kbd>Z</kbd>.
- **Flow steps written with a nested `request:` now get the file's `defaults: auth:`** (before, they were sent without it).
- **The AI Lab's Model comparison has its own prompt**, apart from the Playground's tabs.

### Choose what the rail shows {#choose-what-the-rail-shows}
1. The rail shows five views: Home, Collections, Tests, Environments and History. Click **More…** under them for the others (Debugger, Monitors, Load, AI Lab, Evaluations, Traces, Git).
2. Right-click a rail item: **Hide from the rail**, **Move up** / **Move down**, **Show on the rail ▸** a view from More…, **Show every view** or **Reset the rail**.
3. A view opened from More… stays on the rail while it is open; right-click it ▸ **Keep on the rail** to keep it.
4. <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> follow the shown views in their order (by default 3 is Tests). The choice is this computer's. [Choose what the rail shows](/getting-started/finding-your-way#choose-what-the-rail-shows)

### Filter a response by JSONPath, with suggestions; Diff vs previous {#response-filter-and-diff}
1. Send a request. In the body's **Filter with JSONPath**, type `$.` or a key name: the field lists the response's own paths (arrays as `[*]`); <kbd>Enter</kbd> takes one, the tree shows the matches and their count. A wrong path says what is wrong.
2. Send it again and pick **Diff vs previous** in the response's actions: status, time, headers and the body field by field against the previous response (this session, else History). [Diff vs previous](/api-testing/rest#diff-vs-previous)
3. Agents and scripts: `testpion history diff <before> <after> --json`, MCP `compare_responses`.

### Change the keyboard shortcuts {#change-the-keyboard-shortcuts}
1. **Settings ▸ Keyboard** (or <kbd>?</kbd> ▸ **Change the keys…**, or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Keyboard Shortcuts: Change the Keys…*) lists every shortcut; search by name or keys.
2. Click a shortcut and press the new keys. A clash names the command that has them (**Use it here** swaps); reserved keys are refused with the reason. ↺ resets one, **Reset all** every one.
3. **Export…** / **Import…** move your keys to another computer as JSON. [Change the keys](/getting-started/keyboard-shortcuts#change-the-keys)

### Compact density {#compact-density}
1. **Settings ▸ Appearance ▸ Density ▸ Compact**, then **Save settings** (or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Density: Switch Compact / Comfortable*).
2. Every view gets tighter spacing, smaller fields, row heights and small text; **Comfortable** goes back. Kept for this computer, applied from the first paint.

### Undo instead of “Are you sure?” {#undo-instead-of-confirmations}
1. Delete a request, folder, collection, environment, dataset, monitor, MCP server, saved prompt, example …: it goes at once.
2. Click **Undo** in the message (8 s) or press <kbd>Ctrl</kbd>+<kbd>Z</kbd> outside a text field: it comes back with its id, in its place. [Deleting and Undo](/getting-started/finding-your-way#deleting-and-undo)
3. Deletes that can't be undone (Delete for good, git branches, history, runs, test files) still ask.

### A badge for undefined variables {#undefined-variables-badge}
1. Type a `{{variable}}` that the active environment doesn't define into a request: the environment switcher (top bar and status bar) shows a red count.
2. Click it ▸ **Add {{name}} to** *(the active environment)*…: give it a value (and **Also add to** the other environments); the count goes. [Undefined variables](/api-testing/environments#undefined-variables)

### Files written by anyone show up at once {#files-show-up-at-once}
1. Save a test file from the editor, generate tests from an API definition, or let an AI agent write one (`testpion` in a terminal, the MCP server): the Tests list shows it straight away, without a "changed outside" message for TestPion's own saves.
2. A file another program changes right after TestPion saved it (an editor that saves on focus, a formatter, a `git pull`) is still reported and shown: TestPion tells its own saves by what it wrote, not by the time. [Git](/getting-started/git)

### Inherited auth in the flow designer {#inherited-auth-in-flows}
1. Give a test file `defaults: auth:` and open its **Flow** tab; select an HTTP step that has no auth of its own.
2. **Authorization** shows **Inherit from defaults** and what it is (*Uses Bearer token: {{token}} (from defaults)*), not "No auth". **Override** gives the step its own copy; **No auth** sends this step without it. A step written with a nested `request:` inherits it too. [Design a flow](/test-runner/integration-testing)

### Capture sessions in History {#capture-sessions-in-history}
1. In the HTTP Debugger, **Save to collection…**, **Create flow…** or **Session ▸ Save session…**.
2. **History ▸ Kind ▸ Capture sessions** lists each one: how many exchanges, the hosts, through the proxy or the reverse proxy, and what it became; **Open** opens the collection, the flow or the saved session.
3. Agents and scripts: `testpion history list --kind capture --json`, MCP `history_list` (`kind: capture`). [Sessions](/api-testing/http-debugger#sessions)

### The reverse proxy fills the Debugger's grid {#reverse-proxy-in-the-grid}
1. **Debugger ▸ Capture ▸ Reverse proxy for one API…**, start it and point your client at the local address.
2. The requests appear in the dialog and in the Debugger's grid, marked **reverse** (*Reverse proxy* in the Application column and filter): select them, **Create flow**, **Save to collection**, **Export as HAR** as with any capture. [Reverse proxy for one API](/api-testing/http-debugger#reverse-proxy-for-one-api)

### Tabs for prompts, environments and Debugger sessions; preview tabs for requests {#more-tabs}
1. A single click on a request in Collections opens a **preview** tab (in italics) that the next click replaces; double-click, <kbd>Enter</kbd> or an edit keeps it.
2. Saved AI prompts, environments and saved Debugger sessions open in tabs the same way, each with its own unsaved changes; the **Model comparison** keeps a prompt of its own. The Debugger's **Live capture** tab stays; a saved session opens beside it (**Add to the live capture** copies it in). [Open an item](/getting-started/finding-your-way#open-an-item)

### A guided tour of the first loop {#guided-tour}
1. In a new workspace, Home opens a short tour by itself (once per workspace): **Next** (or <kbd>→</kbd>) shows where to **Send**, **Save**, **Save as test**, **Run** and **Run in CI**; **Show me** opens what the step builds on; <kbd>Esc</kbd> or **Skip tour** ends it.
2. **Get started ▸ Take the tour** brings it back, at the first step not done yet. [Get started](/getting-started/finding-your-way#get-started)

### Small things {#small-things-0-47}
- The response body's **Pretty / Table / Raw / Preview / Visualize** switch, the Console's filter, the WebSocket view's protocol, a trace's payload view, an MCP tool result and collection docs use the one shared switch (labelled words, the same look everywhere).
- A `rail`, `keybindings` or `density` value of the wrong shape in `settings.json` never stops the app: it starts with the default for that one.
- Quick Open, the command palette and search: <kbd>Enter</kbd> opens the row the keyboard is on, even when the list opens under a resting mouse pointer.

## What's new in 0.46

**Flows, designed and run anywhere**
- A **visual flow designer** in every test file's **Flow** tab: a Start node with its trigger and inputs, a searchable block picker, conditions, loops, scripts, sub-flows, polling, Finally and parallel groups, sticky notes and frames, drag and drop from Collections, History and the Debugger. [Design a flow](#design-a-flow-on-a-canvas)
- **Debug a flow**: run history on the canvas, breakpoints, a variables timeline, run from here / to here, pinned responses, replay a failed run. [Debug a flow](#debug-a-flow)
- **Record a flow** from the HTTP Debugger, and **Arazzo 1.0** import and export. [Record a flow](#record-a-flow-from-the-http-debugger)
- **Deploy** a flow: on a schedule (monitors now run test files), behind a webhook (`testpion serve flows`), as an MCP tool, in CI. [Deploy a flow](#deploy-a-flow-behind-a-webhook)
- **At scale**: once per data row, in several environments side by side, as a load test's scenario, and a timeline with its critical path as one HTML file. [Run a flow at scale](#run-a-flow-at-scale-per-data-row-per-environment-under-load-on-a-timeline)

**Finding your way**
- **Quick Open** (<kbd>Ctrl</kbd>+<kbd>P</kbd>), **Problems** (<kbd>F8</kbd>), recent places with names, breadcrumbs and **Reveal in sidebar**, preview tabs, an **Info** panel, links to any item (`testpion://open`, `testpion open`), one tab strip and one menu vocabulary everywhere. [Find your way around](#find-your-way-around)
- A **Terminal** in the bottom panel (<kbd>Ctrl</kbd>+<kbd>&#96;</kbd>) with `testpion` ready to use. [Terminal](#a-terminal-in-the-bottom-panel)
- Every shortcut on one page: [Keyboard shortcuts](/getting-started/keyboard-shortcuts).

**Safer and smoother everyday work**
- **One production guard** on every send and run path, with a frame around the window. [Production](#production-one-guard-on-every-path)
- **Save as test…** everywhere, **Also add to** the other environments, variable sources on hover, **Keep mine / Take the new version** in every editor, **Save to collection** from the Debugger, **Run in CI…** from a run. [Everyday editing](#everyday-editing)
- **Git: Pull & push** in one step, with a background fetch. [Git](#git-pull-push)

**AI and agents**
- **Evaluations as a matrix** against a baseline, and `testpion eval compare` for CI. [Matrix](#compare-evaluation-runs-as-a-matrix)
- **AGENTS.md** written from the live workspace. [AGENTS.md](#agents-md-from-the-live-workspace)
- **One contract for every MCP tool** and **one JSON envelope for the CLI**. [Behaviour changes](#behaviour-changes-read-before-upgrading)
- **Toolsets** to design an agent's tools on an MCP mock, **Datasets** in the sidebar, flows exposed as MCP tools. [Also in 0.46](#also-in-0-46)

## Behaviour changes — read before upgrading {#behaviour-changes-read-before-upgrading}

1. **Writes to production need consent.** An environment marked as **production** is now guarded on every path, not only REST tabs. **A CI pipeline, a monitor or a script whose environment is marked as production now fails its data-changing steps** (POST, PUT, PATCH, DELETE, GraphQL mutations, gRPC calls that are not reads, realtime messages, MCP tool calls, `tp.sendRequest`) with *"… is a production environment: POST … needs confirmation"*. Add **`--allow-production`** to `testpion test`, `run`, `run-collection`, `send`, `load`, `eval run`, `serve flows` and `monitor add / run / start`. Reads still run without it, so a smoke run against production keeps working. Monitors on a production environment change data only once saved again with consent (the app asks; `testpion monitor add … --allow-production`). Agents need a server started with `--allow-production` **and** `allowProduction: true` on each call. For a pipeline: `testpion ci … --allow-production`, the GitHub Action's `allow-production: true`, or tick **Allow data-changing requests to the production environment** in the app's CI dialog. [Production](/api-testing/environments#production)
2. **`--json` prints one envelope.** Every command's `--json` output is `{ schema_version, command, status, data, errors, warnings, metrics }`. **A script that reads `--json` output must read `.data`**: it is exactly what the command printed before (`testpion collections --json | jq '.data'`). Errors are in the envelope too (`status: "error"`, `errors: [{ code, message, hint, retryable }]`), and with `--json` stdout holds only JSON. `serve flows --json` and `debug --json` now print `--jsonl` lines (`{ type, data }`) instead of `{ event, … }`. The `test-results/data-run.json` and `env-matrix.json` files of generated CI pipelines are envelopes too. [JSON output](/cli/reference#json-output-dry-runs-and-scripts)
3. **MCP tools keep one contract.** Tools that delete or overwrite (`delete_request`, `git_sync`, `collection_tidy`, `write_test_file` with `overwrite` …) need `confirm: true`; without it they change nothing and say what they would do (clients with elicitation are asked instead). Lists page at 100 items (`limit`, `cursor`, `nextCursor`); big results are concise unless `response_format: "detailed"`; id parameters are `run_id` style (the old names still work). [How every tool behaves](/ai-testing/mcp-server#how-every-tool-behaves)
4. **Smaller ones:** a wrong argument to a subcommand exits `2` (it exited `1`); Postman and Insomnia imports convert `pm.*` to `tp.*` unless you tick **Keep pm.\* in scripts** (`--keep-pm`); saved gRPC calls and connections always belong to a collection (loose ones were moved into one named after their folder); the Debugger's **Edit & Submit** is **Open as request**, and the reverse proxy for one API is **Capture ▸ Reverse proxy for one API…**; the Load view's own production switch is gone (the guard asks); Developer Tools moved to <kbd>F12</kbd> on Windows and Linux.

## Design a flow on a canvas

1. In **Tests**, pick **+ ▸ New flow (designer)**: the file opens in its **Flow** tab with **Add a step**, **Create from a collection** and **Generate with AI**.
2. **Create from a collection** adds a request, or a folder's requests in order, each waiting for the one before it, with ids and tokens of their saved examples extracted.
3. Drag the dot on a step's right edge onto another step to connect them (`dependsOn`); the connection shows the variables that flow along it, and a step reading a variable nothing provides is marked **!**.
4. Select a step to edit it on the right: URL, headers, body, auth, **Extract**, **Checks**, **Waits for**. **Run flow** (or **Run step**) lights the steps up; **Undo** takes back any change.
5. The file stays plain YAML (the Editor tab shows every change); `testpion flow edit <file> --op '<json>'` and the `flow_add_step`, `flow_connect`, `flow_update_step`, `flow_remove_step` MCP tools make the same edits.
6. More blocks in **Add step**: a **Condition** with a true and a false output (the branch not taken is skipped), **For each** / repeat (`forEach:`, `repeat:`; the node shows **× 3**), a **Script**, a **Sub-flow** (another file as one step; refused for cycles and more than five levels), a **Log**, and the flow's **Output**, which exposed flows return to agents. `if:` on any step runs it only when true.

[Design a flow](/test-runner/integration-testing#design-a-flow)

A flow now starts at a **Start** node: its trigger (Manual, Schedule, Webhook, MCP tool, CI) and **+ Add input** for the values a run starts with; an empty flow offers **Add blocks**, **API example**, **Create from collection**, **Record from the Debugger** and **Generate with AI** right on the canvas. Click a step's output dot (or **+ Block**) for a searchable block picker that also finds your saved requests and other flows, and **Deploy** shows where the flow runs: a schedule, a webhook the app serves (`POST …/hooks/<name>`), an MCP tool, CI. [Design a flow](/test-runner/integration-testing#design-a-flow)

The canvas got comfortable: sticky notes in Markdown (double-click the empty canvas) and coloured frames around steps (**Frame selection**), both kept in the file's `layout:`; a minimap for flows of more than 8 steps; <kbd>Ctrl</kbd>+<kbd>F</kbd> to find a step; hover a step to see its last response; a problems strip that lists unset variables, steps that can never run and cycles as you edit (click one to select its step; `testpion lint` and `testpion flow -e <env>` say the same); <kbd>Ctrl</kbd>+<kbd>K</kbd> on the canvas lists its actions first; dragged steps line up with guides, snap to a grid, and **Align** / **Distribute** arrange a selection. [Design a flow](/test-runner/integration-testing#design-a-flow)

Build a flow by dragging: saved requests and whole folders from the Collections explorer, History entries, Debugger exchanges and tests onto the canvas (on a step, a branch, a connection or the empty canvas), with the values one step reads from another's response extracted for you, and one Undo for the whole drop. The canvas works like a drawing app: <kbd>Shift</kbd>+drag selects with a box, <kbd>Ctrl</kbd>+<kbd>A</kbd> / <kbd>Esc</kbd> select all / none, the middle button, <kbd>Space</kbd>+drag and a trackpad pan, notes can be selected and deleted, and right-click menus on steps, connections, the canvas and group labels. **Deploy** ▸ **CI** sets up CI for the one flow, with data rows, an environment matrix and an HTML timeline. [Design a flow](/test-runner/integration-testing#design-a-flow)

Arazzo workflows in and out: **Import** an Arazzo 1.0 document and each workflow becomes a flow file under `tests/arazzo/` (its OpenAPI documents are found in `specs/`); right-click a flow in **Tests** ▸ **Export as Arazzo…** for the way back (`testpion flow export <file> --arazzo`). In the **Git** view a changed flow reads step by step (*Checkout ▸ pay: body, if*; *connections: added login → pay*), and dragging steps shows as *rearranged*. [Arazzo workflows](/test-runner/integration-testing#arazzo-workflows-import-and-export) · [Flows in git](/getting-started/git#flows-step-by-step)

## Debug a flow

1. In a flow's **Flow** tab, **History** lists its runs; select one to colour the canvas with its results and see each step's request, response and variables, with a **variables timeline** slider over the steps.
2. Right-click a step: **Add breakpoint** (<kbd>F9</kbd>), then **Debug**: the run pauses before it, the inspector shows the variables (change them for this run), then **Continue**, **Step over** or **Stop**.
3. **Run from here** reuses the earlier steps' data from the selected or latest run; **Run to here** runs a step with only what it waits for.
4. **Pin last response** answers a step from a kept response in the designer's runs (never in the CLI, CI or monitors); **Replay with this run's data** re-runs a failed run from its first failing step on its own data.
5. `testpion flow runs <file>`, `testpion test <file> --from <step> --seed-run <runId>` and the `flow_runs` MCP tool do the same from the terminal and for agents.

[Debug a flow](/test-runner/integration-testing#debug-a-flow)

## Record a flow from the HTTP Debugger

1. In the **HTTP Debugger**, select the exchanges of a scenario (a login, then the calls that use its token) and pick **Create flow from selection…**; or **Flow ▸ Record a flow…**, use your app, and **Stop recording**.
2. The dialog shows the steps and the values passed between them (*token from step 1 → Authorization in step 3*); untick what you don't need, name the file and pick the environment.
3. **Create** opens the flow in the designer: ids and tokens are extracted, each step waits for the steps it uses, noise is left out and secrets are variables to set. `testpion flow from-har <file.har>` and the `flow_from_exchanges` MCP tool do the same.

[Record a flow](/test-runner/integration-testing#record-a-flow)

## Deploy a flow behind a webhook

1. Give the flow a webhook: `testpion flow edit orders/new-order.yaml --webhook /hooks/new-order --webhook-secret '{{ORDER_HOOK_SECRET}}'` (or write `webhook: { path: /hooks/new-order, secret: "{{ORDER_HOOK_SECRET}}" }` in the file).
2. Serve it: `testpion serve flows -e Staging` listens on `http://127.0.0.1:4020` and prints each flow's URL.
3. POST a JSON body: its fields are the flow's inputs (checked against `expose.inputs`), and the answer is the flow's `output:` with each step's status and the run id (`422` with the failing step when one fails, `401` without the secret).

To run it on a schedule instead, a monitor can now run a test file: `testpion monitor add "Orders" --test-file orders/new-order.yaml --every 15m`, **Monitors ▸ New monitor ▸ A test file or flow**, or `save_monitor` with `testFile`. `flow_deploy_status` (and `tests.deployStatus` in the app) says where a flow is deployed: a monitor, its webhook, an MCP tool, a CI pipeline; `flow_webhook_set` sets the webhook for an agent. [Deploy a flow](/test-runner/integration-testing#deploy-a-flow)

## Run a flow at scale: per data row, per environment, under load, on a timeline

1. Open a flow in **Tests**, right-click its tab ▸ **Run with data…** (or the table icon next to **Run**), pick a CSV / JSON / JSONL file, a SQLite database or a database URL with a query, and **Run per row**: the flow runs once per row with the row's columns as variables (`{{email}}`, `{{$row.email}}`, `{{$index}}`). The **Runs** tab shows a grid of rows (status, time, failing step, values), live; **Failed** filters, a row opens its steps. `testpion test <file> --data users.csv [--json]`.
2. **Run in several environments…** ticks dev, staging, prod … and shows step × environment with the steps and values that differ marked. `testpion test <file> --env-matrix dev,staging`.
3. In **Load**, pick **Test file (a flow)** as the target: every virtual user runs the whole flow; results per step and per run of the flow. `testpion load --test-file <file>`.
4. Any run's **Timeline** tab draws each step's bar, the waits and the **critical path**; **Save as HTML** writes it as one file to share. `testpion flow report <file> --html out.html`.

Agents: `flow_data_run`, `flow_env_matrix`, `flow_scale_result`, `flow_timeline`, and `load_test` with `test_file`. [Run a flow at scale](/test-runner/integration-testing#run-a-flow-at-scale)

## Find your way around

1. **Quick Open** (<kbd>Ctrl</kbd>+<kbd>P</kbd>): the items you opened lately, any item by name as you type, and by first character **>** commands, **@** the focused editor, **#** environments and variables, **?** help; <kbd>Ctrl</kbd>+<kbd>K</kbd> opens it on commands, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> on environments. `testpion search`, `search_workspace`.
2. **Problems** in one place: the status bar counts what is failing (files that can't be read, monitors, the latest run with failures and errors told apart, certificates, flaky tests); a click opens the **Problems** tab of the bottom panel, <kbd>F8</kbd> / <kbd>Shift</kbd>+<kbd>F8</kbd> step through them, and Home's **Needs attention** is the same list. `testpion problems --json`.
3. **Back**, **Forward** and **Recent places** name what you had open ("GET List patients · Veterinary API"); Home's **Pick up where you left off** lists the items you opened lately, of every kind; <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>T</kbd> reopens the tab you closed last, in any tab bar.
4. Every item view starts with the same **breadcrumb** (*Collection › Folder › Request*, *Monitors › Nightly*, API definitions, datasets, MCP servers, load tests, evaluations); a folder segment shows it in the sidebar, the sidebar follows the tab you switch to, and every tab has **Reveal in sidebar**.
5. **Tabs** work the same everywhere: request tabs, test files, monitors, and now load tests and evaluations share one tab strip and one right-click menu (**Rename**, **Close tab**, **Close other tabs**, **Close tabs to the right**, **Close all tabs**, plus what the view adds); a single click in a list opens a **preview** tab (in italics) that the next click replaces, a double-click keeps it.
6. The right edge holds **Info** and the **Assistant** in one pinnable panel: Info shows the item on screen — its variables and where each comes from, its file and git state, the runs that included it, **Copy as cURL**. Agents: `item_info`.
7. Everything opens in its own view, the same way from everywhere: a search hit, a change in **Git**, **History ▸ Open** (a GraphQL query, an MCP tool call or a prompt comes back with what was sent), a toast (**Open run**, **Open test file**, **Open collection** …), a result (the test file at the step, or the saved request). Something deleted or renamed since says so, with the nearest thing still there. **Copy link** gives a `testpion://open` link that opens the item in the app; `testpion open <ref>` does it from a terminal, and tool results and `--json` output name items with a `ref` (`resolve_ref` looks one up).
8. The **Console**, **Traces** and **History** link to each other: a Console line names its saved request, History entry, trace and run (with **Open as request**); History's right-click menu opens the request and the trace.
9. The environment is one picker everywhere: the top bar, the status bar, the Collection runner and monitors (Load says which one it runs against); every run shows its environment as a badge (PRODUCTION in red), and run results for agents and `--json` name their `environment`.
10. One word per action and one menu order everywhere (**Open**, **Open in new tab**, **Open as request**, **Run again**, **Rerun failed**, **Save as test…**, **Delete…**); right-click menus match the ⋯ menus; <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>9</kbd> follow the rail (1 Home, 2 Collections, 3 Debugger, 4 Tests …). The request editors lost their hidden old sidebars: the Collections explorer is their one sidebar.
11. **Rerun last run** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>) runs the latest run again as it ran; `run_tests` results carry a `ref` and take `step` to run one again.
12. Home's **Get started** follows the first loop — send, save, save as test, run, run in CI — ticked from what the workspace holds, each button opening what the step builds on; walk-throughs for debugging a failing test, capturing traffic and git follow.

[Finding your way around](/getting-started/finding-your-way) · [Keyboard shortcuts](/getting-started/keyboard-shortcuts)

## Production: one guard on every path

1. In **Environments**, turn on **Production** for an environment. While it is active, a thin frame in its colour runs around the window.
2. Send a POST to it, run a GraphQL mutation, a gRPC call that is not a read, a message on an open WebSocket / Socket.IO / MQTT / Kafka connection or an MCP tool call: the app asks before it is sent. Reads (GET, HEAD, OPTIONS, queries) are sent without asking.
3. Run tests, a flow, a collection, an evaluation, a load test, a monitor's **Run now** or flows behind webhooks: the app asks once, saying how many requests change data ("Run Shop (14 requests, 5 change data)?"); **… and don't ask again** keeps the answer for the session.
4. The question comes from the backend, so nothing can skip it. CLI: `--allow-production`; agents: `allowProduction: true` on a server started with `--allow-production`; monitors: consent when you save one.

[Production](/api-testing/environments#production)

## Everyday editing

- **Save as test…** is in every place that names a request: the ⋯ at the end of an editor's breadcrumb line, the Collections menu (a folder or collection becomes one test file: **Create test file from folder…**), History, the HTTP Debugger's rows, the MCP view and the AI Playground; the toast after it has **Run now** and **Open test file**. `testpion test from-request "Collection/Folder/Request"`; `save_test` takes any item `ref`. [Tests](/test-runner/overview)
- **A new variable goes to the other environments** when you want: the variable popover's **Also add to** (empty, or **Copy the value**), and the Environments view asks after saving new variables. Hovering any field with `{{variables}}` shows where each comes from. `testpion env set … --also-in Staging,Production`, `set_environment_variable` with `alsoIn`. [Environments](/api-testing/environments#also-add-to-the-other-environments)
- **After a pull, every open editor follows its file**: GraphQL requests, gRPC calls, connections, MCP servers and monitors show the new version, and ask **Keep mine** / **Take the new version** when you have unsaved edits. [Git](/getting-started/git)
- **The HTTP Debugger saves traffic as requests**: select exchanges and **Save to collection…** (a folder per host or path; addresses become collection variables, secrets variables you set, never saved). `testpion debug --save-collection`, `debugger_save_to_collection`. [HTTP Debugger](/api-testing/http-debugger#save-to-a-collection)
- **A run goes to CI in one click**: its ⋯ has **Run in CI…** (preselected with what it ran and its environment) and **Copy CLI command**. `testpion ci github --run last`; `ci_config` takes `runId`. [CI/CD](/test-runner/ci-cd)
- **Imports speak `tp.*`**: importing from Postman or Insomnia converts scripts to `tp.*` (the import says how many); tick **Keep pm.\* in scripts** (`testpion import --keep-pm`) for a collection you also use in Postman. `pm.*` still runs, and exporting to Postman turns `tp.*` back into `pm.*`. [Import](/api-testing/collections#import)
- **Side panels can be unpinned**, as in Visual Studio: the **Snippets** of a request's Scripts tab, the **Examples** list and the Debugger's dock fold into a tab on the edge and slide over the content on hover. In a script, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> inserts a snippet by name. [Scripts](/api-testing/rest#scripts)
- **Saved requests of every kind belong to a collection**: saving a gRPC call or a connection asks for its collection like a REST request. [Collections](/api-testing/collections)
- Empty lists and panes offer their next step (Save this load test, New monitor, New request …).

## Also in 0.46

- **Toolsets**: an MCP mock's **Tools** tab designs an agent's tools (schema, canned or scripted answers, **Try**, **Serve**, **Generate with AI**). [Design a toolset](/mcp/mocking#design-a-toolset)
- **Datasets in the sidebar**: a dataset opens in a preview tab with its column types; edit it, run a collection with it or use it in a test. [Datasets](/test-runner/datasets#in-the-app)
- **Flows as MCP tools**: an `expose:` block makes a test file or suite a tool agents call (**Expose as MCP tool…**, `testpion flows`). [Your flows as tools](/ai-testing/mcp-server#your-flows-as-tools)
- **A `{{variable}}` with no value in a URL's host** stops the request before it is sent: *{{baseurl}} has no value*, with **Did you mean {{baseUrl}}?** and **Add baseurl to Development**.
- Text fields grow with their text; JSON inside a text value opens as a tree; JSON Lines, CSV and raw HTTP are coloured in every code view; **Pretty** lays out HTML and XML; the window opens maximised.
- **Faster and sturdier**: the window shows in about 0.6 s, scripts run several times faster, a 9,000-request explorer and 5,000-row Debugger stay smooth, long sessions release what they no longer need, and a broken file is listed with its problem instead of breaking the view.

## Compare evaluation runs as a matrix

1. Run an evaluation per variant (a prompt, a model), or one run with several models.
2. In **Evaluations**, pick **Matrix** above the results: cases are rows, variants columns, each cell the case's score (✓ / ✗ without scores). **+ Add a run…** adds a column, **×** removes one.
3. Pick a **Baseline** run: cells turn red where the case regressed (stopped passing, or the score dropped by more than ±0.05) and green where it improved, with the change (`−0.12`); missing and new cases are marked. Each column head counts its regressions ▼ and improvements ▲.
4. Narrow with the chips (**Failed**, **Regressed**, **Improved**, **Missing**), a tag (a dataset record's `tags`) or **Find a case**; sort by score, biggest drop or most failures, or click a column head.
5. Click a cell for the case: input, output, expected and the judge's reasoning, with **Baseline** for the baseline's answer.

In CI: `testpion eval compare <run> --baseline <run>` exits 1 on regressions beyond `--threshold` (`--max-regressions`, `--fail-on-missing`, `--json`); `testpion eval matrix <runs…> --json` prints the matrix a page at a time. Agents: `eval_compare` and `eval_matrix`. [Compare runs as a matrix](/ai-testing/evaluations#compare-runs-as-a-matrix)

## AGENTS.md from the live workspace

1. **Settings ▸ AI agents ▸ Write AGENTS.md** (tick **Also CLAUDE.md** and **Also a Cursor rule** for those agents), or `testpion agents init --targets agents,claude,cursor`.
2. AGENTS.md describes this workspace for coding agents: its collections, environments (names only), tests and flows, the commands with their exit codes, the MCP server, how to add a request, test or flow, and the secrets and production rules.
3. Write it again after the workspace changes: only the part between the `testpion` markers is replaced, your own text stays; the result says which files were created, updated, unchanged or skipped.

Agents: `agents_init`. [AGENTS.md](/ai-testing/mcp-server#agents-md)

## A terminal in the bottom panel

1. Press <kbd>Ctrl</kbd>+<kbd>&#96;</kbd> (or the **Terminal** tab next to Console and Logs): Windows PowerShell opens in the workspace folder (macOS and Linux: your login shell). The drop-down next to **+** offers PowerShell 7, Command Prompt and Git Bash when they are installed.
2. Type `testpion --version`: the app's own command line is on the `PATH`, nothing to install, and `TESTPION_WORKSPACE` names the workspace.
3. Selecting copies, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> or right-click pastes, links open; up to 8 terminals, each kept with its output while the panel shows something else.
4. **Run in terminal** (the terminal icon next to **Copy** in Settings ▸ AI agents and an MCP toolset's Serve box) types a command there for you to check and run. Command palette: **Terminal: New**, **Terminal: Focus**.

[Terminal](/getting-started/terminal)

## Git: Pull & push

1. Commit, then open **Git**. When your team pushed first, the **Pull** button shows how many commits, the rail's Git icon has a count, and a strip says *Your team pushed 2 commits. Pull before pushing.*: TestPion fetches quietly in the background every 5 minutes (**Settings ▸ Git**, 0 turns it off).
2. Click **Pull & push**: the team's commits are merged (collections request by request) and yours are pushed in one step. If the same request was changed on both sides, the **Conflicts** list opens instead and nothing is pushed: resolve, commit, then Push.
3. Uncommitted changes no longer block a pull: they are set aside, the pull runs, and they are put back.
4. In a terminal `testpion git sync` (exit 1 lists the conflicts); for AI agents the MCP tool `git_sync`.

[Keep your workspace in git](/getting-started/git#step-4-branches-pull-and-push)

## What was new in 0.45

The 0.45 additions, each with its steps. The 0.44 ones (the HTTP Debugger, Git compare and conflicts, the API definition tabs, test data, secrets from a secret manager) are in the [changelog](/changelog) and their reference pages.

### An AI provider that says what is missing

1. Open **AI Lab ▸ Providers**: cloud providers without a saved key are marked **needs an API key**.
2. Run a prompt against one anyway: nothing is sent; the result says **No API key for OpenAI**, why, and where to add it, with **Add the key** — it opens the provider with its key field ready. In the CLI and CI the key comes from `TESTPION_SECRET_PROVIDER_<ID>_APIKEY`.
3. A provider's errors say what to do by status: a key not accepted (401), no access to the model (403), no credit left or rate-limited (429), an unknown model or base URL (404), a problem on their side (5xx).
4. **Est. cost** without a price shows **Set a price…**, which opens the price table with the row ready; a price set for `gpt-4o-mini` also prices `gpt-4o-mini-2024-07-18`. The **Usage** tab offers the same.
5. A test can limit the time to the first token: `{ type: first-token, max: 800 }` (`ttft` works too).

[AI Lab](/ai-testing/overview)

### RAG checks judged claim by claim

1. In a RAG test (or an evaluation's evaluators), give the check a judge: `{ type: faithfulness, judge: { provider: openai, name: gpt-4o-mini } }`. The same works for `context-precision`, `context-recall` and the new `answer-correctness` (the answer's facts against the reference, as F1).
2. Run it. The judge splits the answer (or the reference, or the documents) into items and gives each a verdict with its evidence; the score is the share that held, so every score can be followed back to the claims behind it.
3. In the result, the check lists what did not hold first — claims **not supported**, documents **not useful**, facts **missing** — then what did, each with its evidence; a failing check opens the list. The items are in `metadata.items` of the JSON report and over MCP.
4. `context-entity-recall` needs no model: the reference's names, numbers and dates found in the retrieved context.

[RAG evaluation](/ai-testing/rag)

### Review results, grow the dataset

1. A finished run opens its first failure by itself. The chips above the results count **Failed**, **Passed**, **Skipped** and **To review**; each row shows its lowest check score; ↑ ↓ (or J K) move through the results.
2. On a result, **👍** or **👎** records your verdict (press again to clear it) and **Note** says why. A 👎 on a passing result means the checks missed something; a 👍 on a failing one that a check is too strict. Rated results leave **To review**. Reviews live beside the run in `runs/<id>/reviews.json`.
3. In the Playground, when an answer is right, **Add to dataset** keeps the inputs and the answer (as `expected`) as a case in a JSONL dataset; **Evaluations ▸ Dataset** lists it.
4. Terminal: `testpion history review <runId> [resultId] --good|--bad --note "…"`, `testpion datasets --add <name> --row '{…}'`. Agents: `run_reviews`, `review_result`, `add_dataset_row`.

[Evaluations](/ai-testing/evaluations#reviewing-results)

### An integration suite from an API definition or a collection

1. Open a definition in **API definitions** and, in its **Preview**, **Generate tests ▸ Integration flows**; or, on a collection, **Export ▸ Integration flows**.
2. One flow per resource lands in `tests/<api>/flows/`: create it, read it back, update it, see it listed, delete it, see it gone — each step depending on the one before, the created id flowing between them, names given a random part so the flow runs again; the login first, saving `{{accessToken}}`. `tests/<api>-integration.suite.yaml` runs them all.
3. The message names the environment variables to set (`baseUrl`, `clientId`, `clientSecret` …). Set them, review the bodies, then run the suite: `testpion run --suite <api>-integration -e <environment>`.
4. Terminal: `testpion integration-suite specs/clinic.yaml` or `testpion integration-suite "Clinic API"`. Agents: `generate_flows`.

[The test runner](/test-runner/overview#an-integration-suite-from-an-api-definition-or-a-collection) · [Integration testing](/test-runner/integration-testing)

### Debugger: choose what to capture

1. Open **Debugger** and click **Capture**: **a browser** opens Chrome, Edge, Firefox or Brave through the proxy with a profile of its own (only that window is captured); **a terminal** opens one with `HTTP_PROXY` set (only what runs in it); **a phone or another computer** shows the QR code; **everything on this computer** sets the system proxy (named as such, restored when you stop). The proxy starts on its own.
2. **Start capturing** alone starts the proxy for a program you point at it yourself; the address in the empty state copies with a click. **Capture ▸ Proxy port…** changes the port.
3. Nothing is captured until you choose, and other programs are not affected. The filters fit one row with the search box first; the number columns say their unit; the **HTTPS** menu's lock says whether HTTPS is decrypted; the button at the foot of the tool rail shows each tool's name.

[HTTP Debugger](/api-testing/http-debugger)

### First steps

1. **Home** shows **Get started**: send a request, create or import a collection, add an environment, run a test — each a button, ticked from what the workspace holds, gone once all are done (or **Hide**).
2. An empty **Collections**, **Traces** or **History** says what it is for and offers the first action.

### For AI agents

1. `testpion mcp-server --profile minimal` lists only the tools of the common jobs, for agents that load every listed tool into their context (Cursor, Copilot, Cline); Claude Code loads tools on demand and does well with the full list. **`search_tools`** finds a tool by what you want to do, and any tool it names can be called.
2. `testpion agent-info` prints, as one JSON object, what an agent needs on this machine: the workspace, the commands with their exit codes, the environment variables, the MCP setup and the docs.
3. `lint-tests` takes paths the way `testpion test` does (`tests/ai/rag.yaml` or `ai/rag.yaml`).

[MCP server](/ai-testing/mcp-server) · [CLI reference](/cli/reference)

:::
