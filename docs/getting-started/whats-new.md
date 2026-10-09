---
title: "What's new: how to use it"
description: "Step by step: AI providers that say what is missing, RAG checks judged claim by claim, reviewing results and growing datasets, an integration suite from an API definition or a collection, the Debugger's capture-first flow, and what AI agents get."
---

::: v-pre

# What's new: how to use it

The options added in 0.45, each with the steps to use it and a link to the full reference. Every one also works from the terminal (`testpion …`, with `--json`) and for AI agents (an MCP tool of `testpion mcp-server`). The 0.44 additions (the HTTP Debugger, Git compare and conflicts, the API definition tabs, test data, secrets from a secret manager) are in the [changelog](/changelog) and their reference pages.

Side panels can be unpinned, as in Visual Studio: the request **Scripts** tab's **Snippets**, the **Examples** list and the Debugger's dock fold into a tab on the edge and slide over the content on hover, so a small screen keeps room to write. In a script, <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd> inserts a snippet by name. [Scripts](/api-testing/rest#scripts)

Importing from Postman or Insomnia converts scripts to TestPion's `tp.*` (the import says how many); tick **Keep pm.\* in scripts** in the Import dialog (`testpion import --keep-pm`) for a collection you also use in Postman. `pm.*` still runs, and exporting to Postman turns `tp.*` back into `pm.*`. [Import](/api-testing/collections#import)

Saved requests of every kind belong to a collection: saving a gRPC call or a connection asks for its collection like a REST request, and loose gRPC calls and connections were moved into collections named after their folders ("gRPC calls" or "Connections" without one) when the workspace was opened. [Collections](/api-testing/collections)

## An AI provider that says what is missing

1. Open **AI Lab ▸ Providers**: cloud providers without a saved key are marked **needs an API key**.
2. Run a prompt against one anyway: nothing is sent; the result says **No API key for OpenAI**, why, and where to add it, with **Add the key** — it opens the provider with its key field ready. In the CLI and CI the key comes from `TESTPION_SECRET_PROVIDER_<ID>_APIKEY`.
3. A provider's errors say what to do by status: a key not accepted (401), no access to the model (403), no credit left or rate-limited (429), an unknown model or base URL (404), a problem on their side (5xx).
4. **Est. cost** without a price shows **Set a price…**, which opens the price table with the row ready; a price set for `gpt-4o-mini` also prices `gpt-4o-mini-2024-07-18`. The **Usage** tab offers the same.
5. A test can limit the time to the first token: `{ type: first-token, max: 800 }` (`ttft` works too).

[AI Lab](/ai-testing/overview)

## RAG checks judged claim by claim

1. In a RAG test (or an evaluation's evaluators), give the check a judge: `{ type: faithfulness, judge: { provider: openai, name: gpt-4o-mini } }`. The same works for `context-precision`, `context-recall` and the new `answer-correctness` (the answer's facts against the reference, as F1).
2. Run it. The judge splits the answer (or the reference, or the documents) into items and gives each a verdict with its evidence; the score is the share that held, so every score can be followed back to the claims behind it.
3. In the result, the check lists what did not hold first — claims **not supported**, documents **not useful**, facts **missing** — then what did, each with its evidence; a failing check opens the list. The items are in `metadata.items` of the JSON report and over MCP.
4. `context-entity-recall` needs no model: the reference's names, numbers and dates found in the retrieved context.

[RAG evaluation](/ai-testing/rag)

## Review results, grow the dataset

1. A finished run opens its first failure by itself. The chips above the results count **Failed**, **Passed**, **Skipped** and **To review**; each row shows its lowest check score; ↑ ↓ (or J K) move through the results.
2. On a result, **👍** or **👎** records your verdict (press again to clear it) and **Note** says why. A 👎 on a passing result means the checks missed something; a 👍 on a failing one that a check is too strict. Rated results leave **To review**. Reviews live beside the run in `runs/<id>/reviews.json`.
3. In the Playground, when an answer is right, **Add to dataset** keeps the inputs and the answer (as `expected`) as a case in a JSONL dataset; **Evaluations ▸ Dataset** lists it.
4. Terminal: `testpion history review <runId> [resultId] --good|--bad --note "…"`, `testpion datasets --add <name> --row '{…}'`. Agents: `run_reviews`, `review_result`, `add_dataset_row`.

[Evaluations](/ai-testing/evaluations#reviewing-results)

## An integration suite from an API definition or a collection

1. Open a definition in **API definitions** and, in its **Preview**, **Generate tests ▸ Integration flows**; or, on a collection, **Export ▸ Integration flows**.
2. One flow per resource lands in `tests/<api>/flows/`: create it, read it back, update it, see it listed, delete it, see it gone — each step depending on the one before, the created id flowing between them, names given a random part so the flow runs again; the login first, saving `{{accessToken}}`. `tests/<api>-integration.suite.yaml` runs them all.
3. The message names the environment variables to set (`baseUrl`, `clientId`, `clientSecret` …). Set them, review the bodies, then run the suite: `testpion run --suite <api>-integration -e <environment>`.
4. Terminal: `testpion integration-suite specs/clinic.yaml` or `testpion integration-suite "Clinic API"`. Agents: `generate_flows`.

[The test runner](/test-runner/overview#an-integration-suite-from-an-api-definition-or-a-collection) · [Integration testing](/test-runner/integration-testing)

## Debugger: choose what to capture

1. Open **Debugger** and click **Capture**: **a browser** opens Chrome, Edge, Firefox or Brave through the proxy with a profile of its own (only that window is captured); **a terminal** opens one with `HTTP_PROXY` set (only what runs in it); **a phone or another computer** shows the QR code; **everything on this computer** sets the system proxy (named as such, restored when you stop). The proxy starts on its own.
2. **Start capturing** alone starts the proxy for a program you point at it yourself; the address in the empty state copies with a click. **Capture ▸ Proxy port…** changes the port.
3. Nothing is captured until you choose, and other programs are not affected. The filters fit one row with the search box first; the number columns say their unit; the **HTTPS** menu's lock says whether HTTPS is decrypted; the button at the foot of the tool rail shows each tool's name.

[HTTP Debugger](/api-testing/http-debugger)

## Git: Pull & push

1. Commit, then open **Git**. When your team pushed first, the **Pull** button shows how many commits, the rail's Git icon has a count, and a strip says *Your team pushed 2 commits. Pull before pushing.*: TestPion fetches quietly in the background every 5 minutes (**Settings ▸ Git**, 0 turns it off).
2. Click **Pull & push**: the team's commits are merged (collections request by request) and yours are pushed in one step. If the same request was changed on both sides, the **Conflicts** list opens instead and nothing is pushed: resolve, commit, then Push.
3. Uncommitted changes no longer block a pull: they are set aside, the pull runs, and they are put back.
4. In a terminal `testpion git sync` (exit 1 lists the conflicts); for AI agents the MCP tool `git_sync`.

[Keep your workspace in git](/getting-started/git#step-4-branches-pull-and-push)

## First steps

1. **Home** shows **Get started**: send a request, create or import a collection, add an environment, run a test — each a button, ticked from what the workspace holds, gone once all are done (or **Hide**).
2. An empty **Collections**, **Traces** or **History** says what it is for and offers the first action.

## For AI agents

1. `testpion mcp-server --profile minimal` lists only the tools of the common jobs, for agents that load every listed tool into their context (Cursor, Copilot, Cline); Claude Code loads tools on demand and does well with the full list. **`search_tools`** finds a tool by what you want to do, and any tool it names can be called.
2. `testpion agent-info` prints, as one JSON object, what an agent needs on this machine: the workspace, the commands with their exit codes, the environment variables, the MCP setup and the docs.
3. `lint-tests` takes paths the way `testpion test` does (`tests/ai/rag.yaml` or `ai/rag.yaml`).

[MCP server](/ai-testing/mcp-server) · [CLI reference](/cli/reference)

:::
