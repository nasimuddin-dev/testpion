# AI Lab and Evaluations: a task-oriented redesign (research and design, 2026-10-28)

Status: proposal. Nothing in the code was changed. Owner's complaint: "AI Lab and Evaluation are not user friendly and practical oriented."

## 1. Sources, method, limits

Method: read the code behind both rail items, the docs, the two current screenshots (`docs/public/images/ai-lab.jpg`, `evaluations.jpg`) and the last e2e run's screens (`tp-e2e-final/rag-evaluation/12-…png`, `15-…png`); then read the product docs of the tools below. Click counts in section 2 are counted from the code and screenshots (not measured with a stopwatch).

Code read: `apps/desktop/src/components/nav.tsx`, `lib/rail.ts`, `views/AiLabView.tsx`, `views/EvaluationsView.tsx`, `views/ai/{Playground,Compare,Rag,Providers}.tsx`, `components/AssertionEditor.tsx`, `components/rag/{MetricPicker,starter,RagEstimate}.ts(x)`, `components/EvalMatrix.tsx`, `lib/vocabulary.ts`, `tests/unit/vocabulary.test.ts`, `docs/ai-testing/{overview,evaluations,agents}.md`, `docs/getting-started/first-ai-test.md`, `docs/public/llms.txt`, `e2e/plans/{ai-*,eval-matrix,evaluation-dataset,rag-*}.cjs` (names only).

Web pages actually read (summarised in own words):
- https://www.promptfoo.dev/docs/getting-started/
- https://docs.langchain.com/langsmith/evaluation-quickstart
- https://www.braintrust.dev/docs/start/eval-ui
- https://langfuse.com/docs/evaluation/overview
- https://arize.com/docs/phoenix/evaluation/evaluation
- https://developers.openai.com/api/docs/guides/evals
- https://deepeval.com/docs/getting-started
- https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/ (only lists metrics; no plain explanations on that page)
- https://hamel.dev/blog/posts/evals/ (practitioner guidance)
- Search results (headlines and snippets only) on Anthropic Console Evaluate (docs.anthropic.com eval-tool; claude.com/resources/articles/evaluate-prompts) and on practitioner research (arXiv 2604.16304, "Results-Actionability Gap").

Could not verify: the Anthropic Evaluate page itself (fetch returned a different page; facts below come from search snippets, an "ideal output" field was not confirmed), Google AI Studio / Vertex evaluation, Humanloop, PromptLayer, Vellum, TruLens, Postman AI, Bruno, Insomnia (not fetched; no claims are made about them). No research was found that targets "evaluation tooling for non-ML developers" specifically; the closest is the CHI-paper abstract on practitioners (19 interviews). OpenAI's Evals platform is announced as read-only on 2026-10-31 and shut down 2026-11-30 (per its page): treat it as a pattern source only.

## 2. Today: what exists and how it feels

### 2.1 Map

| Where | What | File |
|---|---|---|
| Rail: **AI Lab** and **Evaluations** | Both are hidden under **More…** on a new install (`RAIL_DEFAULT_SHOWN` = home, collections, tests, environments, history) | `lib/rail.ts:16` |
| AI Lab tabs, in this order | Providers, Playground, Model comparison, RAG, Usage. A workspace with no provider opens on Providers | `views/AiLabView.tsx` |
| Providers | Left list + a form: kind, base URL, API key, key reference (advanced), default model, embedding model, region, API version, 4 rate limits. Empty state offers presets; Mock is "(no key)" and one click | `views/ai/Providers.tsx:225-245` |
| Playground | Saved prompts / Environments / History side panel; tabs Prompt template, System, Structured output, Evaluators; Temperature, Top P, Max tokens, Seed; Run; Save; "Save as test…"; result tabs Output, JSON, Evaluation, Rendered prompt; "Add to dataset" | `views/ai/Playground.tsx` |
| Model comparison | One prompt, one input, several models, one table (latency, tokens, cost, valid JSON, checks), fastest and cheapest marked. No dataset | `views/ai/Compare.tsx` |
| RAG tab | Segmented: RAG targets, Metrics (custom metric files), Data (generate test set from documents, capture from real calls); "Connect a RAG system" dialog (request, probe, click-to-map) | `views/ai/Rag.tsx`, `components/rag/*` |
| Usage | AI features usage + prompts usage | `components/AiUsage.tsx` |
| Evaluations | Left: Saved evaluations / Environments / Runs. Main: name, type select (**Prompt / LLM** or **RAG** only), Save, Run N cases; provider+model (or RAG target + Connect + judge provider/model); Temp., Workers, Retries, Limit; sub-tabs Dataset / Prompt / Evaluators (RAG: Metrics); results pane Run / Matrix / Metrics | `views/EvaluationsView.tsx` |
| Dataset tab | Radio JSONL / JSON / CSV / MD, "expected field" text input, Load file…, "or a workspace dataset…", RAG: Import…, Map columns…, Export as…; a raw code editor plus a read-only preview table | `EvaluationsView.tsx:437-530` |
| Evaluators tab | One flat "add check" list with about 45 types in 8 groups (Body, AI, RAG, Safety, Response, GraphQL, Agent...); only some have a hint | `components/AssertionEditor.tsx:28-65` |
| RAG Metrics tab | Catalogue of 138 metrics, presets (RAG triad, Ragas core, DeepEval RAG, NVIDIA RAG, Free…), badges "no model / judge / embeddings", estimate line "≈ 4 judge calls for 2 samples" | `components/rag/MetricPicker.tsx` |
| Results | Run panel (shared `RunPanel`), Matrix (`EvalMatrix.tsx`: variants, baseline, filter chips, sort, case drawer), RAG Metrics matrix, Runs overview with pass rate and trend charts | `components/EvalMatrix.tsx`, `components/rag/RagMetricMatrix.tsx` |
| Elsewhere (not in either view) | Agent tests (`type: agent`, YAML only, checks tool-called / tool-sequence…), Tests view `tests/ai/*.yaml`, spec tests, triage, flaky analysis, AI usage caps, Settings > AI assistant, MCP toolsets (MCP view) | `docs/ai-testing/agents.md`, `views/McpView.tsx` |
| CLI / MCP | `testpion eval list/run/compare/matrix`, `rag …` (many), MCP `list_evaluations`, `run_evaluation`, `eval_compare`, `eval_matrix`, `rag_*` | `docs/public/llms.txt:67,130` |
| Existing e2e plans | `ai-foundations, ai-assistant, ai-agents (that is Settings > agents, not agent tests), ai-flow-from-collection, ai-review, ai-spec-tests, ai-tidy-import, ai-triage, eval-matrix, evaluation-dataset, rag-author/calibrate/capture/custom-metric/evaluation/metrics/r3/testset/trend, rail` | `apps/desktop/e2e/plans/` |

What is good and must be kept: the Mock provider (offline), the sample "Intent classification" dataset in the example workspace, `EvalMatrix` (baseline, regressed filter, 5,000 rows), RAG estimate before judged runs, verdict caching ("running again costs nothing"), result review with thumbs, CLI/MCP parity, "What will be sent…" privacy preview.

### 2.2 Five real paths (first time, a person who has not seen the app)

Counted: a click on a control, or a typed field. "Decisions" are choices the person must understand.

| Job | Path today | Clicks | Decisions | Result |
|---|---|---|---|---|
| a. Test my prompt on 20 cases (no key) | More… > AI Lab (opens on Providers) > "Mock … (no key)" > More… > Evaluations > (the sample draft is a 3-case classifier; edit the JSONL in a code editor; set format radio; set "expected field"; Prompt tab; Evaluators tab > add check from a 45-item list > fill path/expected) > provider select (empty by default, Run is disabled with reason) > model text box > Run | about 9 for the untouched sample; about 18 for own prompt and 20 cases | provider, model id, data format, expected field name, check type, JSON path, threshold | Per-case list with checks; no "17 of 20" sentence; cost not shown for LLM runs |
| b. Compare two prompts or two models, which is better/cheaper/faster | Models: AI Lab > Model comparison (one input only, no dataset). Prompts over a dataset: Save evaluation > duplicate > edit prompt > save > run both > Matrix > "+ Add a run…" > pick baseline | 6 (models, one case); about 16 (prompts, dataset) | which of two tools to use, what a baseline is | Matrix with score colours; the two tools do not share cases |
| c. RAG bot: grounded and right documents retrieved | AI Lab > RAG > Connect a RAG system (request, Probe, click the answer, click the contexts, save) > Evaluations > type RAG > target > judge provider + model > Metrics tab > preset > (estimate dialog) > Run > Matrix / Metrics | about 25 | target, JSONPath mapping, judge, 138 metrics, gold ids, thresholds | Metrics matrix, powerful, but every name is a term of art |
| d. Did my change make anything worse? (CI) | Save evaluation > Run > open run > Baselines > save baseline > CLI `testpion eval run … --baseline` or `eval compare … --fail-on-regression`; the pipeline file comes from the separate Run in CI dialog (Tests menu), which is not offered from an evaluation | about 8 in the app + docs reading + CLI | what a baseline is, thresholds, which command | Works, but no one place says "put this in CI" |
| e. Agent that calls tools: right tools, right arguments | No UI authoring. Write a `type: agent` YAML test by hand (docs/ai-testing/agents.md), run from the Tests view or CLI. Evaluations "type" select has no Agent option; the checks exist in the flat list under "Agent" | not reachable by clicking; a text file | YAML schema, mock tools, MCP servers | Trace in a run; discoverable only by reading docs |

### 2.3 Where a newcomer stalls (ranked, worst first)

1. **Hidden by default.** Both views sit under More…; the first place the Home page mentions AI Lab is one sentence. (`lib/rail.ts:16`)
2. **No answer to "what do I do here?"** AI Lab opens on Providers (a settings form), Evaluations opens on a raw JSONL editor. No cards by task, no sample button. The Run pane empty state is a paragraph about "bounded concurrency, retries and rate limiting".
3. **The pass/fail answer is missing.** After a run there is a list of rows with 1.00 scores; no headline ("17 of 20 passed"), failures are not first, "To review 10" shows on a fully passed run (see `evaluations.jpg`).
4. **Test cases are code.** Cases are authored in a text editor with a format radio and an "expected field" name box; no table, no paste-from-spreadsheet, no "generate cases". A wrong format shows a warning callout after the fact.
5. **"Good answer" is a 45-item flat list** ("Body, AI, RAG, Safety, Response, GraphQL…") with mixed vocabulary ("Exact match", "Similarity ≥", "LLM-as-judge", "Token F1 ≥", "Groundedness (faithfulness)", "Faithfulness (judge)" which are two different checks). Many have no one-sentence hint. No live "try this check on one case".
6. **Two tools for comparison, two for evaluating.** Model comparison (one input) vs Matrix (dataset); Playground evaluators vs Evaluations vs Tests > `tests/ai`. They do not share cases or checks.
7. **Cost is invisible for LLM runs.** RAG shows an estimate; a prompt evaluation shows nothing before Run, no spend cap. Playground shows "Est. cost –" and a "Set a price…" link, so with no price table the cost is always a dash.
8. **Expert settings up front.** Temp., Workers, Retries, Limit (four number boxes), judge provider and model, always visible above the dataset.
9. **RAG is a second app.** Targets, mapping, probing, gold ids, 138 metrics, calibration; the first useful result takes about 25 clicks and every term is expert vocabulary.
10. **Agent evaluations cannot be created in the UI**, and CI is a CLI recipe, not a button.
11. Smaller: the evaluation type select says "Prompt / LLM"; the dataset tab says "records" and "fields available as `{{field}}`" while the prompt tab says "Variables"; "Provider" appears in three places with three meanings (AI provider, judge provider, RAG target); the sample draft has no provider so the first Run is disabled; errors name the engine ("stops before the first question") rather than the fix.

### 2.4 Vocabulary

Rules in force: one word per action, sentence case in screens (native menu in OS Title Case), `JARGON` list in `lib/vocabulary.ts` kept out of strings by `tests/unit/vocabulary.test.ts` (it scans string literals in `src`). Proposal: add the left column words that must be gone from labels (not from docs for experts) to a new `AI_JARGON` list next to `JARGON`, checked the same way, with a small allow-list for the expert panel.

| Current term | A developer or tester expects | Proposed plain term (with the one-sentence hint) |
|---|---|---|
| Evaluations / Evaluators | Tests, checks | **Checks** ("A check decides whether one answer is good.") |
| Dataset / records / fields | Test cases, table of examples | **Test cases** ("Each case is one input and, if you have one, the answer you expect.") |
| expected field | Expected answer | **Expected answer** column |
| Prompt / LLM (type) | Prompt or chatbot | **Prompt or chatbot** |
| RAG / RAG target | Knowledge-base bot / my bot | **Bot with sources** ("A bot that answers from your documents.") / **My bot** |
| Judge, LLM-as-judge | AI reviewer | **AI reviewer** ("A second AI model reads each answer and grades it by your rule.") |
| rubric / criteria | Rule in words | **Grading rule** (plain sentence you write) |
| Faithfulness / Groundedness | Is it made up? | **Answer backed by sources** ("Every claim in the answer is supported by the documents the bot found.") |
| Answer relevance | On topic | **Answers the question** |
| Context recall by id / precision by id | Right documents found | **Found the right documents** / **Found only useful documents** (by document id) |
| Context recall / precision | same, graded by AI | same names, "(AI reviewer)" tag |
| Token F1 | Word overlap | **Words in common with the expected answer** |
| ROUGE-L | Order-aware word overlap | **Wording close to expected answer** |
| Similarity ≥ (lexical/embedding) | Similar meaning | **Similar meaning** (method hidden under Options) |
| Matches snapshot | Same as last time | **Same as the saved answer** |
| Temp. | Randomness | **Randomness** (0 = the same every time) |
| Workers | Parallel requests | **Run at once** |
| Retries | Retry on error | **Try again on errors** |
| Limit | First N cases | **Only the first … cases** |
| Matrix | Compare table | **Compare runs** |
| Baseline | Reference run | **Compare against** ("the run to measure change from") |
| Toolset / tool-called / tool-sequence | Tool calls | **Tool checks:** "calls tool X", "never calls tool X", "calls these in this order", "arguments are valid" |
| Metrics (RAG) | Quality measures | **Quality checks** (the 138 are the catalogue, 5 per preset) |
| Playground | Try a prompt | **Try a prompt** (tab) |
| Model comparison | Compare models | **Compare models** |
| Providers | Connections | **Models and keys** |
| To review | Not yet looked at | **Not reviewed** (hidden when nothing has a verdict yet) |

## 3. Research: what makes evaluation approachable elsewhere

### 3.1 Per product (own words; read pages only)

| Product | First run | Authoring a case and a "good answer" | Results | Cost and CI |
|---|---|---|---|---|
| promptfoo | `init` can copy a working example; a browser setup flow also exists. One YAML: prompts with variables, providers, tests | Each test is variables plus optional assertions (contains, model-graded rubric, code); outputs can be eyeballed with no assertion | `view` web viewer: prompt × model × test side by side; pass/fail per assertion; export JSON/HTML/CSV | The docs warn that cost and latency assertions do not cap spend and quote call counts (45 calls plus grading) |
| LangSmith | Quickstart: dataset, target function, evaluators | Dataset rows hold an input and an optional reference output; can be started from the Playground | Experiments table of input, reference, output; row detail; compare experiments | CI via SDK (not read) |
| Braintrust | Playground: add provider key, write system + user message with an input variable | Upload CSV and map columns to input and expected by drag | Rows with responses and scores; add a second prompt as a second task and see both side by side; a built-in scorer needs one click | Experiments saved from code (not read in depth) |
| Langfuse | Datasets of real production examples; experiments run in UI, SDK or CI | Judges can be calibrated against human labels | Score analytics and trends; shareable comparison; a threshold break can fail a CI build | CI gate documented |
| Arize Phoenix | Pre-built evaluators for RAG and tool-calling agents; UI evaluators attached to datasets without code | LLM judges return a label that maps to a number | Every judgment returns an explanation by default; evaluator traces show the exact judge prompt | n/a |
| OpenAI Evals | Dashboard or API: define record shape, upload JSONL, add a grader (string check) | A run combines eval, prompt, model and file | Pass and fail counts overall and per criterion, token usage; report link | Webhooks on finish; the product is being retired (see §1) |
| Anthropic Console (snippets only) | Evaluate tab; needs a prompt with variables | Add cases by hand, import CSV, or have Claude generate them from an editable description of the need | Run all cases in one click; side by side across prompt versions; experts grade on a 5-point scale | n/a |
| DeepEval | A test case (input, actual output, expected) and a metric with a 0 to 1 threshold | Metric names in plain terms; threshold 0.5 as default | pytest-like run; a viewer shows scores and reasons | pytest style makes CI natural |
| Ragas | Lists RAG metrics (faithfulness, context precision, context recall, response relevancy), explained on separate pages | | | |
| Practitioner guidance (hamel.dev, arXiv 2604.16304 snippet) | | Start from pass/fail, not a 1 to 5 scale; read the data; build a viewer that shows everything for one case on one screen; turn recurring failures into checks | Results often fail to become actions ("results-actionability gap") | Judge agreement: measure precision and recall, not raw agreement |

### 3.2 Patterns that make them usable (to adopt)

1. **Start from a working example**, not an empty form (promptfoo init, Braintrust sample CSV).
2. **A case is a table row**: input and expected answer as columns; CSV upload with column mapping; generating cases is a first-class button (Anthropic Console, snippets).
3. **One-click first check**: a default check (exact or contains) that is already on, so Run works (Braintrust).
4. **Pass or fail first, score second**: counts overall and per check (OpenAI report); binary labels recommended by practitioners.
5. **Explanations travel with scores**: the judge says why (Phoenix, DeepEval reasons).
6. **Comparison is the same screen with one more column** (Braintrust second task; promptfoo matrix), not another tool.
7. **A viewer of one case on one screen** with input, output, expected, each check and the reason (Hamel; TestPion's matrix drawer already does this).
8. **Cost shown as call counts and dollars before running**, since cost assertions do not cap spend (promptfoo warns). Add a cap.
9. **CI is a threshold on a number**, with a one-line command (Langfuse, DeepEval).
10. **Trust the judge only when checked**: a calibration sample against human labels (Langfuse, Hamel). TestPion already has `rag calibrate`.

### 3.3 Mistakes to avoid

- Metric names without a sentence ("faithfulness" alone). Ragas' own page lists names and defers meaning to other pages: do not copy that.
- A kitchen-sink list of metrics (practitioners reported confusing the quality they care about with the metric available); offer 3 to 5 per goal, and a catalogue under "More checks".
- A 1 to 5 or 0 to 1 score with no pass line; always show the pass line.
- Config forms in front of the answer (concurrency, retries) before the first result.
- Cost checks that run after the money is spent.
- Two separate places for one-case and many-case comparison.
- Treating the AI reviewer's grade as ground truth: label every AI-graded result as such (TestPion already does; keep it).

## 4. Jobs to be done

| Id | Job (the user's words) | Outcome in one sentence |
|---|---|---|
| J1 | "Is my prompt or chatbot answering correctly? Test it on 20 cases." | Paste or generate 20 cases, say what a good answer is, and see "17 of 20 passed" with the 3 failures on top. |
| J2 | "Which prompt or model is better, cheaper, faster?" | Run the same cases on two or more variants and read one comparison with winner, cost and speed. |
| J3 | "My knowledge-base bot: grounded in sources, right documents retrieved?" | Connect the bot once, run the same cases and read two verdicts: answers backed by sources, right documents found. |
| J4 | "Did my change make anything worse? Stop me before merging." | Save the evaluation with a pass line; one copied command or file runs it in CI and fails on regressions. |
| J5 | "My agent calls tools: right tools, right arguments?" | Describe the expected tool calls per case and see which cases called the wrong tool or arguments. |
| J6 (research: common) | "I changed the prompt; what changed in every answer?" | Diff against the previous run: which cases flipped and how the answer text changed. |
| J7 (research: common) | "Make me test cases from what I have." | Cases drafted by AI from the prompt, an API spec or collection, documents, or real traffic, reviewed by a person before saving. |
| J8 (research: common) | "Can I trust the AI reviewer?" | Grade 10 answers yourself and see how often the AI reviewer agrees (reuses `rag calibrate`). |

## 5. The redesign

### 5.1 Information architecture

One rail item, **AI quality** (replaces two rail items; **AI Lab** remains the name of the whole group in the command palette and docs for continuity). It is shown by default. Inside, left to right tabs:

| Tab | Holds | Reuses |
|---|---|---|
| **Start** (default) | "What do you want to check?" cards (section 5.2); recent runs with their headlines; the sample button | `Empty`, `RunsOverview` |
| **Checks** | Saved evaluations (the folder tree), the editor, the report | `EvaluationsView` (becomes the editor), `TreeRowShell`, `ItemBreadcrumb` |
| **Try a prompt** | Today's Playground, one case at a time; "Save as checks" turns it into an evaluation with this case as case 1 | `Playground` |
| **Compare** | Today's Model comparison, now a mode of Checks (see 5.6); this tab becomes a shortcut that opens Checks in compare mode with the typed input as case 1 | `Compare`, `EvalMatrix` |
| **Bots with sources** | Today's RAG tab, unchanged inside, reached from the cards; progressive disclosure keeps the 138-metric catalogue under "More checks" | `Rag`, `components/rag/*` |
| **Models and keys** | Providers + Usage (usage becomes a section) | `Providers`, `AiUsage` |

Migration rules: `ViewId` `ai` and `evaluations` stay as aliases for one release (intents `useIntent('ai', …)` and the `eval` palette command still route); saved files and CLI names do not change; e2e plans keep their selectors (data attributes) because the editor and matrix components are moved, not rewritten.

### 5.2 Entry page (Start)

```
+--------------------------------------------------------------------------------------+
| AI quality      [Start]  Checks  Try a prompt  Compare  Bots with sources  Models and keys |
+--------------------------------------------------------------------------------------+
|  What do you want to check?                                  [ Try the sample (offline) ]|
|                                                                                      |
|  +-----------------------+ +-----------------------+ +-----------------------+       |
|  | Answers are correct   | | Which is better?      | | Answers come from my  |       |
|  | Test a prompt or      | | Two prompts or models | | documents             |       |
|  | chatbot on many cases | | on the same cases:    | | Sources used, right   |       |
|  |                       | | best, cheapest,       | | documents found       |       |
|  | [Start]  ~2 minutes   | | fastest  [Start]      | | [Start]               |       |
|  +-----------------------+ +-----------------------+ +-----------------------+       |
|  +-----------------------+ +-----------------------+ +-----------------------+       |
|  | Nothing got worse     | | An agent uses tools   | | Make test cases for me|       |
|  | Run in CI, fail on    | | Right tools, right    | | From a prompt, a spec,|       |
|  | regressions [Start]   | | arguments   [Start]   | | documents, traffic    |       |
|  +-----------------------+ +-----------------------+ +-----------------------+       |
|                                                                                      |
|  Recent                                                                              |
|  Intent classification   17 of 20 passed   $0.04   2.1 s   2 min ago     [Open]      |
|  Clinic bot              Sources 91 %  Documents 80 %   yesterday        [Open]      |
|  No model connected?  Using the offline demo model. [Connect a real model]           |
+--------------------------------------------------------------------------------------+
```

Rules: every card starts the wizard with its goal preset; every disabled control says why; with no model connected the page says "Using the offline demo model" and everything still works (the Mock provider is added automatically on first use of the sample, one click not three).

### 5.3 First run: the sample in three clicks

1. **Try the sample (offline)** (Start). It creates "Sample: support intents" (Mock provider, 10 cases, "answer contains expected" check), and runs it.
2. The report card (5.5) opens with "10 of 10 passed", then a second sample variant with two deliberate failures "Sample: with mistakes" is offered: **See what a failure looks like**.
3. **Make this one mine** keeps the shape and opens the wizard at step 1 with its case table.

No key, no network. The e2e metric is ≤ 3 clicks from a fresh profile to a report.

### 5.4 The wizard (three steps; one screen each; the same editor stays open afterwards)

Step 1 "What are you testing?" (prompt text or a connected bot or an endpoint, plus a model); step 2 "Your cases"; step 3 "What is a good answer?". The right column always shows the estimate and **Run** is available from step 2 on (a default check is on). Experts can skip to the full editor ("Open the full editor").

```
Step 1 of 3  What are you testing?                       Estimate: 20 cases, about $0.03, ~40 s
 ( ) A prompt     (•) A prompt with {{variables}}      Model [ Claude Sonnet 5.5 v ]  (or "Offline demo")
 +--------------------------------------------------------------+
 | Classify the customer message as cancellation, refill, ...   |
 | Customer: {{message}}                                        |
 +--------------------------------------------------------------+
 Variables found: message          ( ) A bot with sources   ( ) An endpoint of my API
 [ Back ]                                           [ Next: your cases ]   [ Skip to run ]

Step 2 of 3  Your cases        20 cases   [Paste from spreadsheet] [Load file…] [Generate with AI…]
 +----+-----------------------------+-------------------+------------+
 | #  | message (input)             | Expected answer   | Tags       |
 +----+-----------------------------+-------------------+------------+
 | 1  | Cancel my appointment       | cancellation      | cancel     |
 | 2  | I need a refill             | refill            | pharmacy   |
 | .. | (editable cells; Enter adds a row; paste CSV or JSONL anywhere)             |
 +----+-----------------------------+-------------------+------------+
 Tip: 5 to 20 cases are enough to start. Add the cases that went wrong before.
 [ Back ]                                            [ Next: good answer ]

Step 3 of 3  What is a good answer?       (tick what applies; each shows one sentence)
 [x] Matches the expected answer exactly     "The reply equals the Expected answer column."
 [ ] Contains a word or phrase               "The reply includes the text you give."
 [ ] Matches a pattern                       "The reply fits a pattern you give (regular expression)."
 [ ] Is valid JSON of this shape             "The reply is JSON with the fields you list."
 [ ] Similar meaning to the expected answer  "Close in meaning, even if the words differ."
 [ ] Graded by an AI reviewer                "A second model grades each reply by a rule you write."
 [ ] Uses the right tools                    "Calls the tools and arguments you expect."
 Live preview on case 1 -->  Reply: {"intent":"cancellation"}   Result: passed   [ Try the next case ]
 [ Back ]                                   [ Run 20 cases · about $0.03 ]
```

An AI reviewer check opens a rule box with a starter sentence ("The reply is polite and does not promise a refund") and shows the grading of case 1 as the preview, with the reviewer's reason. The reviewer's model is under Options.

### 5.5 Results as one report card (the single shared component `RunReport`, used by Checks, Compare and Bots with sources)

```
 Intent classification  ·  run 3  ·  Sonnet 5.5  ·  Development                [Run again] [Save] [v]
+--------------------------------------------------------------------------------------+
|  17 of 20 passed      Cost $0.04      Average 2.1 s      Slowest 5.9 s    vs last run: +2 passed |
|  [#################....]  85 %   pass line 80 %  OK to merge                      trend: ▂▄▅▇ |
+--------------------------------------------------------------------------------------+
|  By check:  Matches expected  17/20     Valid JSON  20/20     AI reviewer "polite"  19/20  |
+--------------------------------------------------------------------------------------+
|  Filter: [Failed 3] [Changed since last run 2] [All 20] [Not reviewed]   Find a case [   ]|
|  ✗ case-7   "Can you refill the flea…"  expected refill   got booking    [Why?]  [👍👎]  |
|  ✗ case-12  ...                                                           [Why?]        |
|  ✗ case-15  ...                                                           [Why?]        |
|  ✓ case-1 … (collapsed: 17 passed)                                                       |
+--------------------------------------------------------------------------------------+
|  case-7  Input | Reply | Expected | Checks with reasons | Diff vs last run | Trace        |
|  Why did this fail? (AI)  "The reply named a booking because the message mentions a visit"|
|  [ Add to cases ] [ Make this a check ] [ Open in Try a prompt ]                          |
+--------------------------------------------------------------------------------------+
```

Behaviours: failures first and the run opens on the first failure (already true for runs); the headline is a sentence also exposed as `summary` in CLI/MCP; "Why did this fail?" uses the AI reviewer's stored reason when there is one and an `AiAction` task otherwise (preview of what is sent, review, cost); "Changed since last run" is the existing regressed/improved filter (`EvalMatrix`) fed with the previous run automatically; trend is the existing per-check chart (`RunsOverview scores`). "To review" is hidden until the first verdict.

### 5.6 Comparing (one mode of Checks)

A "Compare" button on the Variants row adds a column. A variant is a prompt version, a model, or both. Cases are shared, so changing the cases changes every column.

```
 Compare: Intent classification      Variants: [A: current prompt, Sonnet 5.5 x] [B: shorter prompt, Haiku 4.5 x] [+ Add]
+--------------------------------------------------------------------------------------+
|                     A: current          B: shorter prompt      Winner                |
|  Passed             17 of 20            15 of 20               A  (+2)               |
|  Cost per 20 cases  $0.04               $0.01                  B  (4x cheaper)       |
|  Average time       2.1 s               0.9 s                  B  (2.3x faster)      |
|  Summary: B is 4x cheaper and 2.3x faster but fails 2 more cases. Look at those 2.   |
+--------------------------------------------------------------------------------------+
|  Case            A                          B                         Change         |
|  case-7   ✓ refill                    ✗ booking                      ▼ got worse     |
|  case-9   ✗ other                     ✓ refill                       ▲ got better    |
|  [ Show only cases where they differ ]   [ Open case: input, both replies side by side ]|
+--------------------------------------------------------------------------------------+
 No "overall best": the table names the winner per row (the tool already refuses a universal ranking).
```

The one-case Compare tab keeps working by opening this with one case. The matrix (`EvalMatrix.tsx`) is the table; the new part is the three summary rows and the sentence, computed in core so the CLI and MCP print the same words.

### 5.7 Bots with sources and agents

- **Bots with sources:** a second wizard, steps: Connect (preset or paste a cURL; the existing probe and click-to-map), Cases (generate from documents, capture from real calls, import), Checks as **two goals** instead of 138 metrics: "Answers are backed by sources" and "Right documents are found", each expanding to its one-to-three metrics and a preview. A preset line "Quality checks: 5 selected (the standard set)" and **More checks** opens the existing `MetricPicker`. Cost line uses `RagEstimate`.
- **Agent that uses tools:** the wizard's step 1 offers "An agent with tools"; step 2 adds columns "Should call" (tool + arguments) and "Should not call"; step 3 shows tool checks with the same live preview. Persisted as the existing `type: agent` file so CLI/CI/MCP are unchanged. A mock tool editor reuses `components/mcp/ToolsetEditor.tsx`.

### 5.8 Cost, time and spend cap

- **Beside Run, always:** "Run 20 cases · about $0.03 · ~40 s" (LLM: tokens × price table, calls from cases × variants; RAG: existing `RagEstimateView`). With no price: "cost unknown, Set a price…" opening the price row (existing link).
- **Spend cap** in Options with default "Stop at $1.00" for a real provider and none for offline; reaching it stops the run and says "Stopped at $1.00 after 14 of 20 cases. Raise the cap to continue." (extends `maxJudgeCostUsd` which exists for RAG).
- A run over $0.50 or over 100 calls asks once (the pattern of `RagEstimateDialog`).

### 5.9 Save, CI and regressions

- **Save** is a name and a folder (existing). **Pass line:** "Fail when fewer than 80 % pass or any case got worse than the last good run" (a baseline in plain words: **Last good run**).
- **Run in CI** (button in the report and in the saved check's menu): a dialog showing the one-line command, `testpion eval run "Intent classification" --baseline last-good --fail-on-regression --json`, a Copy button, and **Create the workflow file** for GitHub Actions / GitLab / Azure / Jenkins (reuses `CiDialog`, preselected with the evaluation; adds the secrets line for the provider key, `TESTPION_SECRET_PROVIDER_<ID>_APIKEY`).
- The report in CI prints the same headline sentence.

### 5.10 Progressive disclosure

Visible by default: name, what is tested, model, cases, good answers, Run + estimate. Under **Options** (collapsed, remembered per evaluation): Randomness, Run at once, Try again on errors, Only the first N cases, spend cap, AI reviewer model, expected-answer column name, data format. Under **More checks**: the full 45-check list and the 138-metric catalogue. Under **Trust the AI reviewer**: calibration.

### 5.11 Cross-cutting rules

- UI only via RPC, host-agnostic: the wizard, estimate, headline, "why", variants summary all come from core RPCs (`eval.estimate`, `eval.summary`, `eval.variantsSummary`, `eval.sample`, `eval.generateCases`); the view holds no logic that the CLI cannot reach (cloud-ready).
- AI-first: every new RPC has a CLI `--json` form and an MCP tool, and one line in `docs/public/llms.txt` (the file is editable by the owner's authorisation). Generated cases and generated checks are proposals reviewed with the existing `ProposalReview` before saving; the preview shows exactly what is sent (`AiPreviewDialog`).
- One shared component per pattern: `RunReport` (headline, by-check strip, failures list), `CaseTable` (the one editable table, used for cases and for RAG records), `GoodAnswerPicker`, `CostLine`, `VariantsBar`. The old Run panel header, Runs overview and RAG matrix header adopt them; no per-view variants.
- Disabled controls say why (already the rule; the Run button keeps `reason`); every empty state says what to do with one button.
- Menus: native menu OS Title Case ("Run in CI…"), everything else sentence case.

## 6. Backlog

Sizes: S ≤ 1 day, M ≤ 3 days, L ≤ 1 to 2 weeks. Capacity rule: at most half of a release is AI items; the plan below has 3 to 5 AI items per release alongside Fiddler work (FG items queued 0.55 to 0.60).

### 6.1 Quick wins (each S)

| Id | Change for the user | Notes (files) | Test |
|---|---|---|---|
| AU-1 | AI Lab and Evaluations visible in the rail on a new install; the Home card "Check an AI answer" opens them | `lib/rail.ts` `RAIL_DEFAULT_SHOWN` (existing users keep their rail: `railModel` already protects them); `HomeView` card | unit `rail`, e2e `rail.cjs` |
| AU-2 | Plain names: Evaluators→Checks, Dataset→Test cases, Temp.→Randomness, Workers→Run at once, Retries→Try again on errors, Limit→Only the first… cases, "Judge …"→"AI reviewer …", type select "Prompt or chatbot / Bot with sources" | `EvaluationsView.tsx`, `AssertionEditor.tsx` labels, `MetricPicker`; add `AI_JARGON` to `lib/vocabulary.ts` and the unit test; keep ids and data attributes so plans still match | unit vocabulary; update text selectors in `evaluation-dataset`, `rag-evaluation` |
| AU-3 | One sentence beside every check and metric name (the existing `hint` field is filled for all 45; plain names for the RAG ones) | `AssertionEditor.tsx` `hint`, `MetricPicker` rows | unit: every type has a hint; e2e `rag-metrics` reads one |
| AU-4 | **Try the sample** button on the Run pane empty state and on the AI Lab Providers empty state: adds Mock, loads 10 cases, runs, opens the report | reuse the sample from the example workspace; RPC `ai.sample` (new), CLI `testpion eval sample`, MCP `eval_sample` | e2e new plan `ai-try-sample` (≤ 3 clicks) |
| AU-5 | Run shows its price: "Run 20 cases · about $0.03" for prompt evaluations, "cost unknown, Set a price…" when no price | `components/ai/AiEstimateLine.tsx`, core pricing used by the Playground, Run button label | unit estimate; e2e step in `evaluation-dataset` |
| AU-6 | Expert fields (Randomness, Run at once, Try again, Only the first, AI reviewer provider/model) collapse into **Options** | `EvaluationsView.tsx:380-415`; the `RagJudgeOptions` pattern | e2e `evaluation-dataset` opens Options |
| AU-7 | The Run pane empty state becomes three lines plus the sample button; "To review" hidden until a verdict exists; first run opens with a headline chip "17 of 20 passed" in the existing results header | `EvaluationsView.tsx:622-640`, `RunPanel` header | e2e `evaluation-dataset` |
| AU-8 | Error texts say the fix: "Choose a model first" with a one-click "Use the offline demo model"; Run is never disabled without a one-click remedy | `EvaluationsView.tsx` Run `reason`, `Providers` addPreset | e2e `ai-try-sample` |

### 6.2 Larger items

| Id | Change for the user | Implementation notes | Size | Depends on | Tests |
|---|---|---|---|---|---|
| AU-9 | **Start page** with the six cards, recent runs with headlines, the sample button | New `views/ai/Start.tsx`; recent runs from `runs.list`; intents route | M | AU-4 | e2e `ai-start` |
| AU-10 | **Case table**: editable grid, paste CSV/JSONL/spreadsheet cells, column mapping, "expected answer" column; the raw editor stays under "Edit as text" | new shared `components/CaseTable.tsx` (virtualised like `EvalMatrix`); `lib` dataset parse helpers (`countDatasetRecords`, `datasetFormatOfName`); RAG records reuse it with `RagColumnMapper` | L | none | unit parse round-trip; e2e `evaluation-dataset` |
| AU-11 | **Good answer picker** with sentences and a live preview on case 1 (no cost for exact checks; the AI reviewer preview shows its cost first) | new `GoodAnswerPicker.tsx` over `AssertionEditor`'s config types; `rag.tryMetric`-style RPC `eval.tryCheck` (CLI `eval check --case n`, MCP `eval_try_check`) | M | AU-3 | e2e `ai-good-answer` |
| AU-12 | **Wizard** (3 steps) for "Answers are correct", saved as the same evaluation file | `views/ai/Wizard.tsx`, step state in the draft, no new file format | L | AU-10, AU-11, AU-5 | e2e `ai-wizard` |
| AU-13 | **Generate cases with AI**: from the prompt, an OpenAPI spec, a collection or folder, documents (reuses `rag generate-dataset`), or real History; each case verified, shown in `ProposalReview`, accepted by a person | RPC `eval.generateCases` (task `eval-cases`), CLI `testpion eval generate-cases`, MCP `eval_generate_cases`; `AiPreviewDialog` | M | AU-10 | e2e `ai-generate-cases` (demo model) |
| AU-14 | **Report card** as one component: headline sentence, by-check strip, failures first, pass line, vs last run | extract `RunReport` from `RunPanel`/`RunsOverview`/`RagMetricMatrix` headers; core `eval.summary` (CLI/MCP same text) | L | AU-7 | unit summary sentences; e2e `eval-report` |
| AU-15 | **Why did this fail?** one click on a failed case; uses stored judge reason or an AI task, with preview and cost | `AiAction` + `AiAnalysisDialog`; task `eval-why`; MCP `eval_explain_failure` | M | AU-14 | e2e `ai-eval-why` |
| AU-16 | **Compare mode**: variants (prompt version, model) in one evaluation; summary rows and the one-sentence conclusion; Model comparison opens it | `VariantsBar`, `EvalMatrix` as the table; core `eval.variantsSummary`; `eval run --variants` | L | AU-14 | e2e extend `eval-matrix`, new `ai-compare` |
| AU-17 | **Run in CI** from an evaluation: command + workflow file + secrets line; plain "Last good run" baseline | `CiDialog` preselect; `eval run --baseline last-good`; MCP `ci_config` gets `evaluation` | M | none | e2e `ai-ci` |
| AU-18 | **Spend cap** and ask-once over a threshold for every evaluation type | generalise `maxJudgeCostUsd`; `eval run --max-cost` exists for RAG (`rag run --max-cost`), add for LLM | M | AU-5 | unit cap stops; e2e `ai-cap` |
| AU-19 | **Agent checks in the UI**: agent type in the wizard, "should call / should not call" columns, mock tools | `ToolsetEditor`; persists `type: agent` | L | AU-12 | e2e `ai-agent-eval` |
| AU-20 | **Bots with sources wizard**: two goals instead of 138 metrics, preset 5 checks, More checks | `MetricPicker` remains behind it; `rag.author` can pre-fill | M | AU-12 | extend `rag-evaluation`, `rag-author` |
| AU-21 | **One AI quality rail item** with tabs Start / Checks / Try a prompt / Compare / Bots with sources / Models and keys; old view ids kept as aliases | `components/nav.tsx`, `lib/rail.ts`, `AiLabView`, `EvaluationsView` hosting; intents | M | AU-9 | e2e `rail`, all `ai-*` plans re-run |
| AU-22 | **Diff against the previous run** per case (answer text diff) and trend sparkline in the report | existing diff component of the response view; `score_trend` | M | AU-14 | e2e `eval-report` |
| AU-23 | **Trust the AI reviewer**: grade 10 yourself, see agreement | reuse `RagCalibration`, move to a shared card; shown when an AI reviewer check exists | M | AU-11 | extend `rag-calibrate` |
| AU-24 | Docs: one page "Check an AI answer in 5 minutes" replacing `first-ai-test.md` as the entry; the vocabulary table as a glossary; `llms.txt` lines for each new RPC | `docs/getting-started`, `docs/ai-testing/*`, `docs/public/llms.txt` | S (per release) | each item | docs build + unit that every MCP tool is in llms.txt |

### 6.3 Release grouping (next release is 0.55; AI items ≤ half of each release)

| Release | AI items | Why this order |
|---|---|---|
| 0.55 | AU-1, AU-2, AU-3, AU-6, AU-8 (+AU-24 notes) | All renames, hints, defaults; no new screens; nothing for e2e to redo beyond selector text |
| 0.56 | AU-4, AU-5, AU-7, AU-17 | First result without a key in three clicks; the cost beside Run; CI button |
| 0.57 | AU-9, AU-10, AU-11 | The new entry, the table, the good-answer sentences |
| 0.58 | AU-14, AU-15, AU-13, AU-18 | Report card, why, generated cases, spend cap |
| 0.59 | AU-12, AU-16, AU-22 | Wizard and compare mode on top of the finished parts |
| 0.60 | AU-19, AU-20, AU-21, AU-23 | Agents, bots with sources wizard, the single rail item, trust the reviewer |

If Fiddler work needs more room, AU-19, AU-20 and AU-23 slip first; AU-1 to AU-8 must not.

## 7. Success metrics and how to test them

| Metric | Target | How the e2e harness measures it |
|---|---|---|
| Time to first result, fresh profile, no key | ≤ 3 clicks, ≤ 20 s | New plan `ai-try-sample`: count `__t.real.click` calls, assert report headline text `/\d+ of \d+ passed/` |
| Clicks from "start" to a run on own 20 cases (paste) | ≤ 7 | `ai-wizard`: scripted paste of a CSV, count clicks |
| Share of runs started from a template, card or sample | ≥ 60 % | Count in usage log (local only, opt-in): `ai.entry` event kinds; unit test of the counter |
| Every check and metric has a sentence | 100 % | Unit test over `AssertionEditor` and metric catalogue |
| No jargon in labels | 0 matches | `vocabulary.test.ts` with `AI_JARGON` |
| Cost shown before Run | 100 % of run buttons | e2e reads Run button text for LLM and RAG |
| Failures first | Yes | e2e asserts first row of a run with failures is a failure |
| A stalled user always sees a remedy | 0 disabled controls without reason | Existing plan helpers that list disabled buttons without `reason` |
| Screen density | Options collapsed by default | e2e checks Options closed |

User study (cheap, optional): five developers who have not used the app, task J1, think aloud, no help; success is the headline seen without asking.

## 8. Open questions for the owner

1. Merge the two rail items into one **AI quality** (AU-21), or keep **AI Lab** and **Evaluations** as two rail items and only change what is inside? The plan assumes one.
2. Should the offline demo model be used silently when no real model is connected (clear label "Offline demo"), or must the person pick it? The plan assumes silent with a visible label.
3. Default spend cap for a real provider: $1.00 per run, ask over $0.50, or no default?
4. Is a small local usage counter for the "started from a template" metric acceptable (no network, opt-in), or should the metric come from the e2e harness only?
5. Agent evaluations: persist as the existing `type: agent` test file (assumed), or as an evaluation item in `library/evaluations.json` like the others?

## Decisions on the open questions (2026-10-28, chosen by the owner's request "pick which one is best")

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | One rail item or two | **One "AI quality" item** (AU-21), with the old view ids kept as aliases for one release. | Today the person has to know which of two places does their job; one entry with task cards removes that choice. |
| 2 | No real model connected | **Use the offline demo model automatically, with a visible "Offline demo" label on every result and a one-click "Connect a real model"**. | The first result must appear in ≤ 3 clicks with no key; the label keeps it honest that the answers are not from a real model. |
| 3 | Default spend cap | **$1.00 per run as a hard stop for real providers; ask first when the estimate is over $0.50**; both editable under Options; none for the offline demo. | Protects a first run from a surprise bill and still lets a normal evaluation run unprompted. |
| 4 | "Started from a template" metric | **From the e2e harness only; no counter in the product.** | The privacy table promises nothing leaves the machine; a metric is not worth a new data question. |
| 5 | Where agent evaluations live | **The existing `type: agent` test file** (git-tracked, already run by the CLI and CI). | One format for the UI, the CLI and CI; no second place to keep in sync. |
