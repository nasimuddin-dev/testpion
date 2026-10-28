---
title: "AI evaluation"
description: "Check LLM output with deterministic, semantic and AI-reviewer checks over streamed test cases, with regression baselines."
---

::: v-pre

# Evaluations

## Saved evaluations

An evaluation of type **Bot with sources** (RAG) sends the questions of its test cases to a bot you connect (HTTP, SSE, WebSocket, gRPC or an MCP tool) and scores the answers and the documents it retrieved; its **AI reviewer** (under **Options**) grades the checks that need one. See [RAG testing](/ai-testing/rag).

Save an evaluation (its test cases, prompt, model, options and checks) with **Save** next to **Run**, and it appears under **Saved** in the sidebar. Group evaluations in folders (**New folder**, drag and drop, or **Move to folder**); every list keeps its items in folders, and items that have none are in **General**. Right-click one to right-click one to **Run** it again, rename, duplicate or delete it (a delete happens at once, with **Undo** in the message). **Save** updates the evaluation you opened (it shows `Save*` when there are changes). **Save current evaluation** in a folder's menu saves a copy there. The **Runs** pane lists the runs of your evaluations, each with the environment it ran against (**PRODUCTION** in red); pick one to see its results.

Evaluations open in tabs, like requests: each tab keeps its own unsaved changes, a single click in the **Saved** list opens a preview tab (its name in italics) that the next click replaces, and a double-click keeps it. The first line of the view says where the evaluation is (*Evaluations › folder › name*), and its ⋯ has **Copy link**. See [Finding your way around](/getting-started/finding-your-way#open-an-item).

Saved evaluations are kept in the workspace file `library/evaluations.json`, so they're versioned and shared with the workspace (use `{{variables}}` rather than typed-in keys).

Run them without the app, e.g. in CI or from an AI agent:

```bash
testpion eval list                       # name, folder, model, cases, evaluators (--json)
testpion eval run "Intent classification" -e Staging --limit 50 -r console junit
```

`eval run` exits `1` when a case fails, writes the usual reports, and works with `--baseline` / `--save-baseline` for regression checks. Against an environment marked as [production](/api-testing/environments#production), data-changing requests need `--allow-production` (the app asks once per run). AI agents use the `list_evaluations` and `run_evaluation` tools of `testpion mcp-server`.

## In the editor

The first row has the evaluation's name, its type (**Prompt or chatbot** or **Bot with sources**), **Save** and **Run**. Under it, **Provider** and **Model** say what is tested. When no model is connected yet, a note says **Choose a model first** and offers **Use the offline demo model**: one click adds the demo model (no key, no network; its answers come from rules, so it is for trying things out) and **Run** works. When there are no test cases, **Add example cases** fills in a small set.

The expert settings are under **Options**, closed until you open them: **Randomness** (0 gives the same answer every time), **Run at once** (how many cases are sent together), **Try again on errors** and **Only the first … cases**; for a bot with sources also the **AI reviewer provider** and **AI reviewer model**. The tabs are **Test cases** (the data, with the **Expected answer column**), **Prompt** and **Checks**. Beside every check one sentence says what it decides.

## Try the sample

**AI Lab** opens on **Start**: "What do you want to check?" with a card for each job (answers are correct, which is better, answers come from my documents, nothing got worse, an agent uses tools), your latest runs with how many passed, and **Try the sample (offline)**. The sample adds the offline demo model, makes the evaluation *Sample: support intents* (ten support messages to sort into cancellation, refill, booking or other, checked with "the reply contains the expected answer"), runs it, and shows **10 of 10 passed**. Nothing leaves your computer and no key is needed. The demo model answers by rules, so the result shows how a run looks and says nothing about a real model; the result says **Offline demo** to keep that clear. The sample is put back as written each time you try it, so make your own with **Duplicate**.

```bash
testpion eval sample                 # make it and run it (--no-run only makes it, --json for scripts)
```

AI agents use the `eval_sample` tool of `testpion mcp-server`.

## Test cases as a table

The **Test cases** tab shows the cases as a table: one row per case, one column per field, cells you type in. Columns named in the prompt as `{{name}}` and the expected answer column are marked. **Enter** in the last row adds a case; **Add column** adds a field. **Paste cases…** takes cells copied from a spreadsheet, a CSV file, JSONL lines or a JSON list: it finds the columns, guesses which one is the input and which is the expected answer (you can change both), and adds the cases to the table or replaces it. **Edit as text** shows the same cases as the text of a file (JSONL, JSON, CSV or Markdown); **Load file…** reads one. The table stays quick with thousands of cases, and holds up to 20,000 (edit larger sets as text). A bot with sources keeps the text editor, with its import and column mapping.

## What is a good answer?

On the **Checks** tab of a prompt evaluation, tick what applies: *Matches the expected answer exactly*, *Contains a word or phrase*, *Matches a pattern*, *Is valid JSON*, *Similar meaning to the expected answer*, *Graded by an AI reviewer*. One sentence under each says what it decides. For each tick, **Try on case N** sends that case to the model and shows the reply, whether the check passed and why (an AI reviewer's reason when it grades), before you save anything. A check of fixed rules on the offline demo model is free and runs at once. A call to a paid model, and any check an AI reviewer grades, show what it costs first and send only when you press **Send**. The other checks, and the ones this evaluation already has, are under **More checks**.

```bash
testpion eval check "Intent classification" --type contains --expected "{{expected}}" --case 3
testpion eval check "Intent classification" --type llm-judge --criteria "Polite" --case 1 --dry-run
```

`--dry-run` says what would be sent and what it costs; a paid model needs `--yes`. AI agents use `eval_try_check` (`dry_run`, and `confirm: true` for a paid model).

## What a run costs, and the spend cap

Beside **Run** a line says what the run will cost before anything is sent: *20 cases · about $0.03 · ~40 s*. It comes from the cases, the prompt and your [price table](/ai-testing/model-pricing); a check an AI reviewer grades doubles the calls. The offline demo model and models on this computer are *free*; a model with no price says *cost unknown* with **Set a price…**.

A run on a paid model stops at a hard cap of **$1.00** (change it under **Options** as **Spend cap (USD)**; `0` means no cap). When it stops it says *Stopped at $1.00 after 14 of 20 cases. Raise the cap to continue.* A run that is estimated over **$0.50** (or 100 calls) asks once before it sends anything. The offline demo model has no cap.

```bash
testpion eval estimate "Intent classification" --json    # cases, calls, tokens, dollars, seconds, the cap and whether a run asks first
testpion eval run "Intent classification" --max-cost 2 --yes
```

`--yes` goes ahead past the question; `--max-cost` sets the cap (`0` for none). A run stopped at its cap exits with an error, so a pipeline never passes on part of the cases. AI agents use `eval_estimate`, and `run_evaluation` takes `max_cost_usd` and `confirm: true`.

## The result, and Run in CI

Above a run, one chip says how many passed (*17 of 20 passed*) with the cost and the time. **Run in CI…** opens the pipeline dialog with this evaluation chosen: the pipeline runs `testpion eval run "name" --baseline last-good --fail-on-regression --yes` and fails when a case got worse than the **last good run** (the last run of this evaluation that passed; the first run has none and becomes it). The model's key is a CI secret the dialog lists. The same file comes from `testpion ci github --evaluation "name"` or the `ci_config` tool with `evaluation`.

## Check types {#evaluator-types}

| Source | Checks |
|---|---|
| Deterministic | `exact-match`, `equals`, `contains`, `not-contains`, `regex`, `json-schema`, `json-path`, `type`, `length`, `threshold`, `latency`, `tokens`, `cost`, `is-json` |
| Heuristic | lexical `similarity` (cosine or token F1), RAG metrics, `refusal`, `no-leak` |
| Semantic | `similarity` with `method: embedding` using a provider's embeddings |
| AI reviewer | `llm-judge` (**Graded by an AI reviewer**) with a configurable `judge` model, `criteria` (the grading rule) and `threshold` |

Every check result carries its **source**, and the UI and reports label AI-judge results clearly. Judge runs record the provider, model, temperature, prompt version and a config hash so they can be reproduced. They are **not** treated as deterministic.

## Datasets

JSON, JSONL, CSV and Markdown tables, from a file or a URL (API response), or the rows of a SQLite query ([Datasets](/test-runner/datasets#sqlite-databases)). JSONL and CSV are streamed line by line, so datasets of any size never need to fit in memory; quoted CSV fields may contain commas and line breaks. In the app, the dataset editor loads a file with **Load file…**, or one of the workspace's `datasets/` files from the list next to it (a response's **Table ▸ Save as dataset** puts one there).

```yaml
name: Intent dataset
type: llm
model: { provider: openai, name: my-model, temperature: 0 }
prompt: "Classify as JSON {\"intent\": ...}: {{message}}"
dataset:
  path: ../../datasets/intents.jsonl
evaluators:
  - { type: exact-match, path: $.intent, expected: "{{expected}}" }
```

Each record's fields are available as variables in both the prompt and the evaluators.

**Grow a dataset from the Playground:** when an answer is right, **Add to dataset** (next to the result) adds the
prompt's inputs and the answer, as `expected`, to a JSONL file in `datasets/` (`playground-cases.jsonl` unless you
name another; it is made when missing). The file then appears in the Evaluations dataset list. From the terminal:
`testpion datasets --add intent-cases --row '{"message": "Cancel my booking", "expected": "cancellation"}'`; agents
use the `add_dataset_row` MCP tool.

## Reviewing results

A finished run (an evaluation or a test run) opens its first failure, or its only result, by itself. The filter
above the results counts what each choice holds: **Failed**, **Passed**, **Skipped** and **To review**. Each row
shows its lowest check score, so weak answers stand out even when they pass. **↑ ↓** (or **J K**) move through the
results.

Checks measure; a person decides. On a result, **👍** or **👎** records your verdict (press it again to clear it)
and **Note** says why. A 👎 on a passing result means the checks missed something, so add or tighten one; a 👍 on a
failing one means a check is too strict. Rated results leave **To review**, so a run can be reviewed to the end.
Reviews are kept beside the run (`runs/<id>/reviews.json`) and never change its results.

- Terminal: `testpion history review <runId>` lists the reviews; `testpion history review <runId> <resultId> --bad --note "rude tone"` rates one.
- Agents: `run_reviews` reads them (a good starting point for improving evaluators) and `review_result` adds one, marked as an agent's.

## Compare runs as a matrix

Run the same dataset through several variants (a saved evaluation per prompt or model, or one run with several models) and pick **Matrix** above the results: rows are the cases (the dataset records), columns the variants, and each cell the case's score (or ✓ / ✗ without scored evaluators) in that variant. The newest run of each evaluation is shown until you pick: **+ Add a run…** adds a column (up to 20 runs; a run with several models becomes a column per model) and **×** removes one. Cases line up by their record id, so runs of differently named evaluations compare case by case.

<figure class="aps-screenshot">
  <img src="/images/eval-matrix.jpg" alt="The evaluation matrix: ten cases as rows, three variants of an intent classifier as columns, a baseline picked, and the cases the desk-hint prompt got wrong in red with their score change" width="1440" height="900" loading="lazy">
</figure>

- **Baseline**: pick a run, and every cell is coloured against the baseline's cell of the same case: red when it **regressed** (it stopped passing, or its score dropped by more than the threshold, ±0.05 by default; a drop of exactly the threshold is not a regression), green when it **improved**, with the score change (`−0.12`). A case only in the baseline is **missing**, one only in the variant **new**. Each column head shows its pass count, mean score, regressions ▼, improvements ▲ and mean score change.
- **Filter chips** count what they show: **All**, **Failed** (a variant failed it), **Regressed**, **Improved** and **Missing** (with a baseline). **Every tag** narrows to the cases with a tag (a dataset record's `tags`: a list or `"billing, edge"`), **Find a case** to an id or name.
- **Sort** by case, lowest or highest score, biggest drop or gain, or most failures; clicking a column head sorts by that variant's score (again: the other way).
- **A cell opens the case**: its input, output, expected value and every check with the judge's reasoning (the same detail as a run's result), and **Baseline** shows the baseline's result for the same case beside it.

The backend keeps the matrix and the window asks for the rows on screen, so 5,000 cases × 10 variants scroll as fast as 50.

**Save the matrix.** The down arrow at the right end of the matrix's bar saves every case as it is filtered and sorted now (each variant's status, score and change) as CSV, JSON, Markdown or a self-contained HTML table; the backend writes the rows page by page, so a big matrix never passes through the window. A run's own results have the same arrow (HTML report, JSON, JUnit, Markdown, CSV, ZIP). See [Save and export results](/getting-started/save-and-export-results).

From the terminal and CI, `eval compare` exits `1` when more cases regressed than allowed:

```bash
testpion eval compare "Intent classification" --baseline run-mv7c0rww1bdf50ac3b --json   # the newest run of that name
testpion eval compare last --baseline main-nightly --threshold 0.1 --max-regressions 3 --fail-on-missing
testpion eval matrix "Intent v1" "Intent v2" "Intent v3" --baseline "Intent v1" --filter regressed --tag billing --json
```

Runs are named by id, `last` (the newest finished evaluation run: a saved evaluation's or one with scored checks; a run still going, a stopped run, a collection run or a monitor's is passed by) or name (the newest finished run of that name). The report lists the regressions (a lost pass first, then the biggest drop), improvements, missing and new cases, and per variant the pass rate and mean score change; `passed` is what the exit code says. AI agents use the `eval_compare` and `eval_matrix` MCP tools (`eval_matrix` with `run` and `result` returns one cell's full result).

## Regression

With no run open (or after **Overview of all runs** in the Runs list), the Evaluations view shows the earlier runs: pass rate and duration by run, and **Scores by run**, one small chart per evaluator with its mean score in each run (green from 0.7), to see whether a model, prompt or pipeline is getting better or worse. `testpion history scores` prints the same and agents use the `score_trend` MCP tool.

Save a run as a **baseline**, then compare later runs against it using thresholds for latency (+%), tokens (+%) and score drop. New failures, score drops and metric regressions are highlighted. In the app (**Baselines** on a finished run), *Compare with* also lists earlier runs, to see what changed since then without saving a baseline; AI agents do the same with the `compare_runs` MCP tool. In CI:

```bash
testpion test tests/ai --baseline main --fail-on-regression
```

:::
