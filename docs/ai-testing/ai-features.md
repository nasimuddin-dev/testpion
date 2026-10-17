---
title: "AI features: privacy, cost and review"
description: "How TestPion's own AI features work: your key or a local model, Local only, what is sent and how to see it first, privacy levels, proposals you review and apply, how they are verified, cost caps and the usage view, the same tasks from the CLI, MCP and CI, and how the prompts are tested."
---

::: v-pre

# AI features: privacy, cost and review

TestPion's AI features — explain an error or a response, suggest checks, write tp tests, write an integration flow from a collection, fix lint problems, write a commit message and more — all run through **one task runner** in the engine. The app, the CLI (`testpion ai …`, `testpion flow generate`), the MCP server (`ai_*` tools, `flow_generate`) and CI use the same 27 tasks, the same privacy rules, the same caps and the same usage log.

Three rules hold everywhere:

- **AI is an action you start.** Nothing runs on its own, and nothing is sent before you click (or call) it.
- **You see what is sent.** The model, whether it stays on this computer, every section of the context, what was masked and the estimate — before it is sent.
- **Nothing is saved until you accept it.** A generated check, test, flow or request is a *proposal*, checked by the engine first and shown in a review; **Undo** puts back what an accepted proposal replaced.

## What you get

| Where | AI action | What it gives |
|---|---|---|
| A request's response | **Suggest assertions**, **Generate tests** | Checks or `tp.test` scripts, each run against the response first ([below](#verification)) and reviewed before they are added. |
| Next to **Send** | **Describe a request** | A request from words, reviewed, then opened as a new unsaved tab. |
| Explorer: right-click a collection or folder | **Generate integration flow with AI…** | A flow file from its saved requests, tried on a mock and reviewed on a canvas ([Let AI write the flow](/test-runner/integration-testing#let-ai-write-the-flow)). |
| A flow's canvas | **Generate with AI** | The same, *from a collection or folder* or *described in words*. |
| Errors, failed tests, timelines, monitors, fuzz and security findings, API diffs, load tests | **Explain with AI**, **How to fix (AI)**, **Analyze with AI** | An answer in the assistant panel. |
| Anywhere | <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>J</kbd>, **Ask AI Assistant** (<kbd>Ctrl</kbd>+<kbd>K</kbd>) | A free question about what is on screen ([the assistant](/ai-testing/overview#talking-to-the-assistant)). |
| Git, Home | **Write message**, **What to fix first** | A commit message from the changes; the items of *Needs attention* in order. |

Every AI button is the same control: ✦ and its label, and beside it the **eye** — **What will be sent…**. Hovering the button shows the model, whether it stays on this computer and the token estimate.

## Set up a model

AI features need a model; without one they say so and offer **Set up AI** (nothing is sent). **Settings ▸ AI assistant**, then **Turn on the AI assistant** and choose one of:

- **Claude (Anthropic), with your API key** — paste the key, **Save key**: TestPion checks it with Anthropic, then keeps it in the OS secret store, never in a file. See [Your Claude API key](/ai-testing/overview#your-claude-api-key).
- **A provider of this workspace** — any provider of **AI Lab ▸ Providers**: a cloud one with its key, or a model on this computer: **Ollama (local)** (`http://127.0.0.1:11434`, no key) or **LM Studio (local)** (its OpenAI-compatible server on `http://127.0.0.1:1234/v1`, no key). With no provider selected, **AI Lab ▸ Providers** offers both (and the cloud ones) as one-click presets.

Then **Save settings**. A provider without its key answers with **Add the key**, which opens it in AI Lab ▸ Providers.

<figure class="aps-screenshot">
  <img src="/images/settings-ai.jpg" alt="Settings, AI assistant: the assistant on with the offline demo model, Models per task with Ollama (local) for small tasks and the demo model for large tasks, Local only turned on, What is sent by default set to Full (redacted), Mask personal data, and the Limits: tokens per call, tokens per day and cost per day" width="1440" height="900" loading="lazy">
</figure>

### Models per task

Under **Models per task**:

- **Small tasks** (explanations, triage, a commit message, a request or tool arguments) can use a cheaper or local model.
- **Large tasks** (checks, tp tests, flows, coverage tests, a GraphQL query, toolsets, OpenAPI fixes) can use the most capable one.

Both default to the assistant's model (*Same as the assistant*). `testpion ai tasks` lists each task's tier.

### Local only

**Local only: AI never leaves this computer** allows only Ollama, LM Studio or another OpenAI-compatible server on `127.0.0.1` / `localhost`, and the offline mock. A cloud model — or an Ollama on another host — is refused with *Local only is on: … would send the context off this computer*, **before anything is sent** — and before its API key is looked up, so a cloud provider without a key is refused for leaving the computer, not for the missing key.

### From the terminal and CI

The CLI reads the same settings, and the environment overrides them:

| Variable | Effect |
|---|---|
| `TESTPION_AI_PROVIDER` | The provider: a workspace provider's id or name, `ollama`, `mock`, `anthropic` (with `ANTHROPIC_API_KEY`), `openai-compatible` (with `OPENAI_API_KEY`), or `claude-app` (with `TESTPION_SECRET_APP_ANTHROPIC_APIKEY`). |
| `TESTPION_AI_MODEL` | The model, for every task. |
| `TESTPION_AI_MODEL_SMALL` / `TESTPION_AI_MODEL_LARGE` | The model of one tier. |
| `TESTPION_AI_LOCAL_ONLY=1` | Local only. |

`--provider` and `--model` on a command win over all of these. A workspace provider's key comes from `TESTPION_SECRET_PROVIDER_<ID>_APIKEY` (no keychain in CI). The MCP server uses the app's settings.

## What is sent, and how to see it first

The eye beside every AI button — **What will be sent…** — and the same icon in the assistant's header show, before anything leaves the computer:

- the **model**, whether it is a small or large task, and whether it **stays on this computer** (else *sent to* the provider);
- the **privacy level**, which you can switch there;
- each **section** of the context with its tokens, and how a large one was fitted (*sampled 20 of 340 items (first, last, failed, one of each shape)*, *shortened long texts*);
- what was **masked**, and where;
- the **token and cost estimate** (the price comes from **Settings ▸ Model pricing**; without one it says *no price set*);
- the exact **messages**.

**Send** goes ahead with the chosen level; **Cancel** sends nothing.

<figure class="aps-screenshot">
  <img src="/images/ai-what-will-be-sent.jpg" alt="What will be sent for Explain NetworkError: the local Ollama model for a small task, stays on this computer, the token estimate, the error and request sections, one value masked (query-credential), and the exact system and user messages with the access token replaced" width="1440" height="900" loading="lazy">
</figure>

From the terminal: `--dry-run` on `testpion ai run` and `testpion flow generate` prints the same and sends nothing. For agents: `dryRun: true` on `ai_run_task` and `flow_generate`.

### Privacy levels

| Level | What is sent |
|---|---|
| **Full (redacted)** (default) | Requests, responses and results, with secrets, tokens and personal data masked. |
| **Metadata only** | Methods, URLs without query values, statuses, names, and the *shape* of bodies (`{ id: number, items: [ {…} ×20 ] }`) — no body values. |
| **Names only** | Names, kinds and the structure; no URLs, bodies or values. |

The default is **Settings ▸ AI assistant ▸ What is sent by default**; each action can change it (the dialog, `--privacy full|metadata|names`, `privacy` for agents).

### Redaction

Always, at every level:

- **Secret values**: secret variables, keys the engine resolved, values of sensitive headers — wherever they appear.
- **Sensitive field names**: `password`, `authorization`, `token`, `apiKey`, `client_secret` … (the list in **Settings ▸ Privacy & security**).
- **Credentials found by their shape** in any field or text: JWTs, `Bearer` / `Basic` credentials, private keys, API keys of the big providers (OpenAI, Anthropic, AWS, Google, GitHub, Slack, Stripe, GitLab, npm, Hugging Face), and credential query parameters (`?access_token=…`, `?api_key=…`).
- **Personal data** (on by default; **Mask personal data** turns it off): e-mail addresses, phone numbers, card numbers (Luhn-checked) and IBANs (checksum-checked).

Variable *names* may be sent, so a generated request or flow can use `{{baseUrl}}`; their values never are. JSON is never cut mid-value: a large context is sampled and summarised to its shape instead.

## Proposals: review, accept, undo

A task that generates something — checks, tp tests, a flow, a test file, a request — returns a **proposal**: its items, each with its diff and the badges of the [verification](#verification) the engine did before you see it. Generating actions open the review by themselves.

<figure class="aps-screenshot">
  <img src="/images/ai-suggest-assertions.jpg" alt="Review of suggested assertions for Get patient: seven checks with their verification badges; the checks that pin the id and the owner id pass but are flagged as values that change, each offering Safer forms (type, exists); Run now, Close and Add to the checks" width="1440" height="900" loading="lazy">
</figure>

In the review:

- **Tick** the items to apply; an item that failed its verification starts unticked, with the problem said — never hidden. **Select all** / **None**.
- **Open** an item for its diff and the verifiers' details.
- **Safer:** on a check that pins a value that changes (an id, a time, a token) offers stable forms — `type`, `exists`, a format `regex` — and checks the one you pick again.
- **Run now** (checks and tests of a request) sends the request again, the usual way and under the production guard, and checks every item against the new response and the one before it.
- **Try on mock** (a flow) runs it against a mock built from the collection's saved examples.
- **Regenerate** asks again with a hint (*also test pagination*); **Discard** drops the proposal.
- **Accept selected** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>) — the button names what it does: **Add to the checks** (the request's Tests tab), **Add to the Post-response script** (added after your own script, never replacing it), **Open as a new request**. Changes made in the request editor are saved when you save the request; files are written at once, and the message offers **Undo**.

A flow is reviewed on a **canvas preview** instead, marked *AI-generated*, with its YAML (edit it there: **Check again** verifies the edit) — see [Let AI write the flow](/test-runner/integration-testing#let-ai-write-the-flow).

Accepting writes through the workspace's own writers (test files, the saved request's checks or script, a new request). Proposals are kept for a day in the workspace's `.local/ai/proposals/` (git-ignored, this computer only), so a proposal made in the app can be applied from the CLI (`testpion ai apply <id>`) or by an agent (`ai_apply_proposal`), and the other way round.

## Verification

Before a proposal is shown, its items are checked:

| Verifier | What it checks |
|---|---|
| `checks` | Each suggested check runs against the response it was written for **and the one before it** (the saved request's History): a check that passes now but failed before is unticked (*the value changes*); one that pins a generated value (a time, an id, a token) is flagged. Both offer **safer forms**. Without a stored response the item says *no response to check against*. |
| `script` | Each tp test runs in the sandbox against the response (no network), and against the previous one: *1/1 tests pass on the current and the previous response*. `pm.*` / `postman.*` fails (TestPion writes `tp.*`) and is sent back to be rewritten. |
| `test-file` | The test loader reads the file and the lint (keys, check types, `dependsOn`, cycles) finds no error. |
| `flow-refs` | Every `{{variable}}` a flow uses is extracted by an earlier step or is a known variable name. |
| `flow-vars` | (Flows from a collection.) Every `{{variable}}` is extracted by a step the step **waits for** (`dependsOn`, directly or through others), or is one your workspace has. |
| `flow-mock` | The flow runs against a mock server built from the collection's saved examples, every step pointed at the mock (no real server is called; auth and requests sent by scripts are left out). A collection without saved examples is not tried (*no mock*). |
| `json` / `yaml` | Generated JSON / YAML parses (and matches the tool's input schema, for MCP arguments). |

**Repairs.** A model's answer is structured output: JSON that must match the task's schema (the provider's JSON-schema mode where it has one). An answer that does not parse, does not match, or fails a verifier is sent back with the problem — up to twice. If it is still wrong you see the best attempt with the failing items unticked and *Still wrong after the repairs*. An answer cut at the output limit is not used: it says so instead.

**YAML made safe.** A value that starts with `{{` but is not quoted (`url: {{baseUrl}}/pets`, a YAML error models often make) is quoted before the file is checked, and the review says *Fixed N unquoted template values*. A YAML error that remains goes back with its likely cause in plain words (an unquoted `{{`, a tab, bad indentation, a key written twice).

**The format, from the source.** The flow and test prompts carry a compact reference of the test-file format made from the same schema and check registry the lint uses (the step keys, each check with an example, one complete flow), so the model is told exactly what the runner accepts; a check written in the wrong shape goes back with the right shape.

## Cost: estimates, caps and usage

- **Before sending**: the estimate in **What will be sent…**, in the flow dialog and on hover over an AI button (≈ tokens in, the most the answer may cost).
- **Caps**: **Settings ▸ AI assistant ▸ Limits** — **Tokens per call**, **Tokens per day** and **Cost per day ($)**, per workspace; empty is no cap. A call over a cap is refused with *Over an AI limit … Nothing was sent.* and **Change the limits**. The CLI, MCP and CI calls count and are capped too.
- **AI Lab ▸ Usage ▸ AI features**: calls, tokens and cost today and over 30 days, what is left of the daily caps, tokens per task, calls per model and per surface (*App*, *CLI*, *MCP agents*, *CI*), and the latest calls with their outcome (*ok*, *accepted*, *discarded*, *error*). The AI Lab's own prompts follow below it.

<figure class="aps-screenshot">
  <img src="/images/ai-feature-usage.jpg" alt="AI Lab, Usage: the AI features section with calls today, cost today, the last 30 days and tokens left today, tokens per task, the models and the surfaces the calls came from" width="1440" height="900" loading="lazy">
</figure>

Terminal: `testpion ai usage [--days 7] [--json]`; agents: `ai_usage`.

## From the terminal, agents and CI

The examples below are run in the [examples workspace](/getting-started/examples) (collection *Veterinary API*). Every command takes `--json` (the [JSON envelope](/cli/reference#json-output-dry-runs-and-scripts)) and `-w <workspace>`.

```bash
testpion ai tasks                                            # the 27 tasks: id, title, tier, whether it proposes
TESTPION_AI_PROVIDER=ollama testpion ai run explain-error --context @error.json --dry-run   # what would be sent
testpion ai run explain-test-failure --item run:<runId>:<resultId>   # an answer, streamed
testpion ai run explain-test-failure --item run:last                 # the newest finished run (as ci --run last)
testpion ai run suggest-assertions --item request:veterinary-api:req-get --json            # a proposal of verified checks
testpion flow generate --collection "Veterinary API" --folder Patients --dry-run           # the flow: what would be sent
testpion flow generate --collection "Veterinary API" --folder Patients                     # the flow, verified, proposed
testpion ai proposals                                        # the workspace's proposals (a day)
testpion ai apply ai-mvbu2qjg9a3b644187                      # write the ticked items (--items i1,i3 to choose)
testpion ai undo ai-mvbu2qjg9a3b644187                       # put back what it replaced
testpion ai usage                                            # today, 30 days, per task and model, the caps
```

`ai run` and `flow generate` only propose; `--apply` applies at once (`flow generate --apply` only when its verification did not fail). `suggest-assertions` is the same task as `generate-assertions`, `generate-tests` the same as `generate-pm-tests`. `ai run --item request:<c>:<r>` checks the suggestions against the request's latest response in History. See [`ai`](/cli/reference#ai) and [`flow generate`](/cli/reference#flow-generate).

A dry run prints:

```text
What will be sent — Explain an error
  model     Ollama / llama3.2 (small task, from env) · stays on this computer
  privacy   full
  estimate  ≈ 168 tokens in, up to 2,000 out · no price for this model (Settings ▸ Model pricing)
  section   error: 20 tokens
  section   request: 25 tokens
  masked    1: query-credential
```

### For AI agents (MCP)

Agents are models themselves, so the deterministic tools come first. For clients that want TestPion's configured model: `ai_list_tasks`, `ai_run_task` (an answer and a proposal with an id; `dryRun: true` shows what would be sent), `ai_proposals`, `ai_apply_proposal` (a separate call that asks the user to confirm; `dryRun: true` lists what would be applied), `ai_undo_proposal`, `ai_usage`, and `flow_generate` (an integration flow from a collection or folder, proposed; `noAi: true` for the draft without a model). See [Use from AI agents](/ai-testing/mcp-server#tools).

### In CI

A pipeline uses its own key (or a model on the runner) and is counted as *CI* in the usage:

```yaml
# GitHub Actions: propose an integration flow for review in the pull request
- run: npx testpion@0.48.0 flow generate --collection "Veterinary API" --folder Patients --json > flow-proposal.json
  env:
    TESTPION_AI_PROVIDER: anthropic
    TESTPION_AI_MODEL_LARGE: claude-sonnet-5-5
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Without a model set up, `flow generate` (and `flow_generate`) returns TestPion's deterministic draft with a note instead of failing; `--no-ai` asks for it on purpose.

## The prompts are tested (for contributors)

Each task has a versioned prompt (`packages/core/src/ai/tasks/`; a change to a prompt is a new version) and golden cases in `tests/ai/`, run with the mock provider in every `npm test`: the answer's shape, the verifiers, the repair loop, truncation, privacy levels, redaction (no secret reaches the provider) and proposal safety (paths stay under `tests/`). The mock answers with scripted rules: a regular expression on the last user message and the answer, or `responses` answered in turn to test a repair:

```ts
import { harness } from './harness.js';
const h = harness({ rules: [{ match: '"source"', responses: ['not json', JSON.stringify(flow)] }] });
```

`AI_EVAL_LIVE=1` runs the same cases against a real model and prints a scorecard per task; it is never run in CI by default and needs your own model:

```bash
AI_EVAL_LIVE=1 TESTPION_AI_PROVIDER=ollama TESTPION_AI_MODEL=llama3.2 npx vitest run tests/ai
```

## Troubleshooting

| You see | Why, and what to do |
|---|---|
| **The AI assistant is off** with **Set up AI** | No model is chosen: **Settings ▸ AI assistant**. CLI: `--provider` / `--model` or `TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL`. |
| **No API key for …** with **Add the key** | The provider needs its key: AI Lab ▸ Providers ▸ the provider ▸ API key. CLI/CI: `TESTPION_SECRET_PROVIDER_<ID>_APIKEY`. |
| **No model name given for provider …** | The provider has no default model: set one in AI Lab ▸ Providers, or pass `--model` / `TESTPION_AI_MODEL`. |
| **Local only is on: … would send the context off this computer** | Choose a model on this computer, or turn Local only off (unset `TESTPION_AI_LOCAL_ONLY`). It comes before **No API key for …**: a keyless cloud provider is refused for leaving the computer. |
| **Over an AI limit** with **Change the limits** | A per-call or per-day cap; nothing was sent. **AI Lab ▸ Usage** shows what is left today. |
| **Could not reach Ollama at http://127.0.0.1:11434/…** | The local model's server is not running (start Ollama, or LM Studio's server). |
| An item unticked with *fails on the current response* or *the value changes* | Its check does not hold; pick a **Safer** form, or **Run now** after fixing the request. |
| *Still wrong after the repairs* | The model could not fix its answer in two turns: **Regenerate** with a hint, choose a larger model for large tasks, or use a smaller folder. |
| *0/3 steps pass on a mock* (a warning) | The mock answers only with saved examples: a step whose request has none gets a 404. **Save as example** on its response, then **Try on mock**. |
| *The answer was cut at the output limit* | Ask a narrower question (or a smaller folder), or allow more output (`testpion ai run … --max-tokens`). |

:::
