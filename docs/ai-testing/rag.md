---
title: "RAG evaluation"
description: "Test a RAG system that runs somewhere else: connect any endpoint (HTTP, SSE, WebSocket, gRPC, MCP) from a preset or by clicking, run a dataset (Ragas, DeepEval, BEIR, NVIDIA and promptfoo files convert), choose from 30 metrics, see the cost first, and read the samples × metrics matrix."
---

::: v-pre

# RAG testing

TestPion tests a RAG system that runs somewhere else: you connect its endpoint, a dataset of questions is sent to it, and
what comes back (the answer and the documents it retrieved) is scored. Everything is under **Evaluations** (the type
*RAG*) and **AI Lab ▸ RAG** (where you connect the system). The full list of metrics is [RAG metrics](./rag-metrics.md).

## Connect a RAG system {#connect}

A **RAG target** is one request to the system under test and a map of where its answer and retrieved documents are in the
response. It works over the protocols TestPion already speaks:

| Protocol | The request is | The response the mapping reads |
|---|---|---|
| HTTP | a `type: http` step, JSON in and out | the parsed JSON body |
| HTTP with server-sent events | the same, with `Accept: text/event-stream` | `{ events: [{ event, id, data }] }`; each event's `data` is parsed as JSON when it is JSON |
| WebSocket | a `type: websocket` step with the question in `send` | `{ connected, received: [...] }` |
| gRPC | a `type: grpc` step (a `.proto` file or server reflection) | the reply message |
| MCP tool | a `type: mcp` step (`server`, `tool`, `arguments`) | the tool's structured result, or its text parsed as JSON |

In **AI Lab ▸ RAG ▸ Connect a RAG system** (or **Evaluations ▸ RAG ▸ Connect…**):

1. **Start from** a preset if your system is one of the common ones: *OpenAI-compatible chat completions* (also streamed),
   *LangServe*, *LlamaIndex*, *Haystack (Hayhooks)*, *Dify*, *Flowise*, or a *generic JSON* request. The request and the
   mapping are filled in; you add the host, the flow or pipeline name and the key as `{{variables}}`. Every preset's mapping is
   checked against a sample response of the framework's documented shape.
2. Or choose the protocol and write the request as YAML. The question is `{{question}}`. Inside a JSON text use
   `{{questionJson}}` (the question as a JSON string, quotes included) or `{{questionEscaped}}`; in a `json:` block
   `"{{question}}"` is always safe. Hosts and keys are `{{variables}}` and secrets, as in any request.
3. Type a question and press **Probe**. The real response appears as a tree.
4. **Click a key** in the tree and say what it is: *the answer*, *the list of retrieved contexts*, then a context's *text*,
   *id*, *score* or *source* (click inside one item of the list), the token counts, or a latency. For a streamed
   answer choose *the answer, streamed in pieces*: that field of every event is joined in order. Or press **Suggest
   mapping**: the AI reads the sample response and proposes the paths. TestPion applies the proposal to the sample first and
   sends a mapping that reads nothing back to the model, so what you get has already read an answer from your response.
5. The panel under the tree shows what the mapping reads, live. The mapping is plain JSONPath (`$.answer`,
   `$.sources[*]`, `$.text`) that you can also type or edit, so the same response always gives the same sample.
6. **Limits** keep an evaluation from overloading the system: calls at once, requests per minute, a timeout and retries of a call
   that failed on the server's side (5xx, 429, a dropped connection). They apply to every test of a run together.
7. **What the judge receives** shows the exact prompt a judged metric would send for this sample, before anything is
   sent. **Save target** keeps it in `library/rag-targets.json` of the workspace (a normal workspace item: folders,
   rename, duplicate, delete with Undo, git).

From the terminal or an agent: `testpion rag probe "Clinic bot" "What time does the clinic open?" --json`, or the
`rag_probe` MCP tool. Without the app: `testpion rag connect openai-compatible --name Gateway --var ragUrl=https://rag.example.com
--var ragModel=my-model --concurrency 2 --rpm 60` saves a target from a preset (`testpion rag presets` lists them). A production
environment is protected as for any request: a question is a `POST`, so it asks first unless the target is marked as read-only.

```yaml
# a target as a file (testpion rag probe --file target.yaml)
protocol: sse
step:
  type: http
  method: POST
  url: "{{ragUrl}}/stream"
  headers: { Content-Type: application/json, Accept: text/event-stream }
  json: { question: "{{question}}" }
mapping:
  answer: $.events[*].data.delta
  contexts: $.events[0].data.sources[*]
  context: { text: $.text, id: $.id, score: $.score }
limits: { concurrency: 2, requestsPerMinute: 120, retries: 1 }
```

## A dataset {#dataset}

An evaluation of type RAG takes records with a **question**, a **reference** answer and, when you have them, the gold
documents: **`reference_ids`** (the ids the retriever should return) and **`reference_contexts`** (their texts). JSON,
JSONL and CSV work (a list in a CSV cell is a JSON array, or one item per line, or `;`-separated):

```jsonl
{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["hours"]}
```

A test file can take its contexts from a variable too: `contexts: "{{docs}}"` is filled by a dataset column (a list, a JSON
array or lines of text) when the test runs.

### Your own column names {#columns}

**Map columns…** in the dataset tab reads a dataset whose columns are named otherwise (`prompt`, `gold_answer`, `doc_ids`):
choose which column is the question, the reference answer, the gold chunk ids, the gold texts, the id and the tags. The guess
comes from the names other tools use, the preview shows the records the choice gives, and columns you do not map stay as extra
fields (`{{variables}}`). Apply rewrites the dataset as JSON Lines.

### Datasets from other tools {#imports}

**Import…** in the dataset tab (or `testpion rag import`, or the `rag_import_dataset` tool) reads these as data (nothing in
a file is executed) and writes TestPion records:

| Format | Read as | Becomes |
|---|---|---|
| Ragas (`EvaluationDataset`, `SingleTurnSample`) | `user_input`, `reference`, `reference_contexts`, `reference_context_ids`, `response`, `retrieved_contexts` (+ `retrieved_context_ids`), persona and style columns | `question`, `reference`, `reference_contexts`, `reference_ids`, `answer`, `contexts`, `tags` |
| DeepEval (`Golden`, `LLMTestCase`) | `input`, `expected_output`, `context`, `actual_output`, `retrieval_context`, `additional_metadata.tags` | the same |
| BEIR | `queries.jsonl` + the qrels file (query-id, corpus-id, score; TREC's four columns work) + optionally `corpus.jsonl` | `question`, `reference_ids` (the documents with a positive score, best grade first), `reference_contexts` |
| NVIDIA retriever data | `query` / `question` with `pos_doc`, `positive_passages` or `positive_ctxs` (and negatives) | gold ids and texts of the positives; negatives kept as `negative_contexts` |
| promptfoo | a config or a list of `tests` (YAML or JSON): the question variable, the expected value of an `equals` / `contains` / `similar` / `context-recall` assertion, a `context` variable | `question`, `reference`, `reference_contexts` |

The format is found from the column names (or give `--from ragas|deepeval|nvidia|promptfoo|beir`; BEIR also takes `--qrels` and
`--corpus`). Multi-turn Ragas samples and promptfoo assertions other than the expected value are left out and named in the notes.
**Export as…** (`testpion rag export <dataset|evaluation> --to ragas|deepeval`, `rag_export_dataset`) goes the other way; with
`--run <runId>` the answer and retrieved contexts each record got in that run are included, so Ragas or DeepEval can score the very
same answers. TestPion does not call or depend on any of these tools.

## Metrics {#metrics}

The **Metrics** tab of the evaluation lists all 30 metrics, grouped by what they measure, with a search that finds a metric by
its id, an older name or a Ragas name (`LLMContextRecall`, `nv_context_relevance`, `response_relevancy`):

* **Presets** put a set in one click: *RAG triad*, *Ragas core*, *DeepEval RAG*, *NVIDIA RAG*, *Retrieval only*, *Free (no model at
  all)*, *Answer vs reference*, *Ragas NL comparison*, *Ops*.
* Each row says what it **reads**. When the dataset lacks an input (gold ids, a reference), the row says so in amber, with the column
  to add, instead of failing at the end of a run.
* A badge says whether it needs **no model**, a **judge** or **embeddings**, and how many judge calls it makes per sample.
* The **pass mark** and the options (a mode, a `k`) are set on the row; the ⓘ shows the formula, a worked example and the sources.
  `recall@k` can be added twice (`recall@5`, `recall@10`): each gets its own column.
* **Try** runs the metric on one sample (below). The line under the list estimates the whole evaluation as you choose.

Metrics are checks, so they also work in a test file's `assertions` and `evaluators`, by any of their names:

```yaml
evaluators:
  - { type: faithfulness, threshold: 0.8 }
  - { type: context-relevance, mode: chunks }
  - { type: recall@5, threshold: 0.9 }
  - { type: LLMContextRecall }          # a Ragas name: the same metric as context-recall
  - { type: ragas:answer-relevance }    # Ragas' own definition (reverse questions + embeddings)
```

Inside a run of a RAG target the judged metrics are **strict**: without a judge there is no score. A `rag` test with contexts written
in the file keeps the older behaviour of `faithfulness`, `context-precision` … (a heuristic, or `judge:`), see [the older checks](#checks).

### Try on one sample {#try}

Every metric has **Try**: choose a sample (ask the evaluation's RAG target a question, type one, or open a stored result from the
matrix) and see what the metric reads and what it lacks. For a judged metric, **Show the prompt** opens the exact messages the judge
would receive, after masking secrets and personal data, with the tokens, the cost and whether the verdict is already cached;
nothing has been sent. **Run** then scores the sample and shows the score against the pass mark, every item with its evidence, the
judge and what it cost. `testpion rag metric test faithfulness --answer … --context … --dry-run` and the `rag_try_metric` MCP tool do
the same.

### The judge {#judge}

Judged metrics ask a model through the AI task `rag-judge` (`testpion ai tasks`):

* **Which model.** The evaluation's *Judge* (a provider of the workspace and its model); else the AI settings' *large*
  model (`TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL` in the CLI and CI, `--judge provider/model`). There is **no silent
  fallback**: without a usable judge the run stops **before the first question** and lists what to configure. A mock judge
  is used only when you name the mock provider (offline tests). *Local only* is enforced: a cloud judge is refused.
* **What it sends.** Only what the metric needs (the answer and the documents; the question for relevance), redacted like every AI
  call, and only at the privacy level *Full (redacted)*. A sample longer than the judge's budget fails with a message instead
  of being cut.
* **The verdicts** are JSON with the reasoning first and an item per claim, statement or document: the text, a verdict (or a
  rating) and the evidence (a quote and the document id). They are checked against the schema and repaired.
* **Cost.** Every call is in the AI usage ledger (task `rag-judge`) and counts against the daily caps. A verdict is cached by
  the content hash of the exact prompt and the model: **running again costs nothing**; any change to the sample, the metric's
  wording (its version) or the model asks again. `testpion rag cache clear` empties the cache. A run can stop judging at an amount
  or a number of calls: what is not judged then is n/a, never a guess. The run's summary reports **`judgeCostUsd`**, apart from
  the cost of the system under test.
* **Judge options** (*Judge options* in the evaluation; `--judges`, `--swap`, `--repeat` …):
  a **jury** of several judges whose scores are combined (majority, mean or lowest); **both document orders** (a disagreement is a
  tie, which does not pass); **repeat** n times (the first answer may come from the cache, the rest are asked again) and report the
  flip rate of the verdicts; **skip judging when retrieval failed** (`shortCircuit`: the judged answer metrics of a sample whose
  free retrieval metrics already failed are n/a, with no call); **share the answer's claims** (`shareClaims`).
* **Shared claims.** Faithfulness and answer relevance both judge the answer's claims. With `shareClaims` the answer is split once
  (prompt `claims-v1`) and each metric judges those claims; the split is cached, so a third metric that reads claims costs nothing
  for it. With only two readers the extra call costs more than it saves, so sharing is on by default from three.
* The prompts are versioned (`faithfulness-v1`, `answer-relevance-v1`, `context-relevance-nvidia-a-v1` …) and stored with every score.
  A judge is a model: read the evidence before acting on a verdict, and prefer a model from another family than the one under test.

### Cost before you run {#estimate}

Before a run that asks a judge, a dialog shows how many judge calls it will make (per metric and in all), the tokens, a cost range from
the price table, the calls it makes to your RAG system, and any limit it would break (the daily token cap or budget, the run's own
limits). *Size a typical answer with one real call to your RAG system* makes the estimate better; *What the judge receives* shows a
real prompt. `testpion rag run … --estimate` (add `--probe` for the real call) and the `rag_estimate` MCP tool print the same; for
re-scoring a run they are exact (every prompt is built for the stored answers, and the cache hits are counted). A run of free metrics
starts at once.

## Run it {#run}

Evaluations ▸ type **RAG** ▸ choose the target (the Provider and Model fields become the Judge), the dataset and the metrics, **Run**.
The runs list, the results and the **Matrix** (cases × runs, against a baseline) are the same as for any evaluation.

### The samples × metrics matrix {#matrix}

**Metrics** next to *Matrix* in the results opens the run as a table: a row per sample, a column per metric, grouped by type under two
header rows (a group collapses to its mean). A cell is that metric's own score, green or red against its pass mark, grey for n/a (never
a zero). Above the rows, each metric has its **pass mark** (change it and pass and fail are decided again from the stored scores), the
**mean**, **p10**, **pass rate**, the **n/a** count, a **95% interval** and the **distribution**. Samples can be searched, sorted by a
metric and filtered by **why they failed**. Click a cell to open the sample through that metric: the question, the answer, the claims
with the document each was found in, the lane of retrieved contexts (the verdict on each chunk, and gold chunks that were never
retrieved), the card of every metric with its evidence, and **Try again with another judge**.

Why a sample failed is a class from fixed rules over its metric results: *retrieval miss* (the gold chunks or reference facts are not
in the contexts, or nothing was retrieved), *false refusal*, *ranking*, *noise*, *unfaithful*, *off topic*, *incomplete or wrong*,
*citation*, *format* (the mapping found no answer), *system error*, *judge error*, *operational*. Fix the retriever or the generator,
not both at once.

### From the terminal and CI {#cli}

```bash
testpion rag metrics --kind deterministic                    # what needs no model
testpion rag run "Clinic RAG" --preset rag-triad --judge ollama/qwen2.5:14b --estimate
testpion rag run "Clinic RAG" --metrics faithfulness,recall@5,token-f1 --judge ollama/qwen2.5:14b \
    --min faithfulness=0.8 --min recall@5=0.9 --junit rag.xml --html rag.html --baseline run-abc
testpion rag run "Clinic RAG" --preset ragas-core --two-phase --max-cost 2     # free metrics first, then judge the answers
testpion rag rescore run-abc --judge anthropic/claude-sonnet --swap              # no call to the RAG system
testpion rag compare run-new -b run-old                                          # metric by metric, with a paired bootstrap
```

`rag run` exits **1** when a `--min` gate fails (the mean of the metric must reach the value; a metric that has no score in the run
fails its gate, because it cannot be assumed to pass) or a metric regresses against `--baseline`, and **2** for a configuration error
(no judge, an unknown metric, a target that cannot be called). Without gates, a failed sample fails the run. `rag compare` decides what
is real with a seeded paired bootstrap over the samples both runs scored, direction aware (a lower-is-better metric that went up is a
regression). A two-phase run collects the answers first (the run is recorded), then judges them as a second, re-scored run: change
the judge or add a metric later with `rag rescore` and nothing is asked of your system again.

An agent has the same: `rag_metrics`, `rag_try_metric`, `rag_estimate`, `rag_run`, `rag_rescore`, `rag_compare` and the prompt
`evaluate_rag_system` (probe → metrics → estimate → run → compare). `rag_run` stops before the first question when the target cannot
be called or a judged metric has no judge.

## Recipes {#recipes}

**Is my retriever the problem?** Run the *Retrieval only* preset: it needs the gold ids and no model. A low `recall@5` with a high
`mrr@5` means the right chunk is retrieved but ranked low; low `context-precision-ids` means noise.

**Judge once, compare judges later.** `rag run … --two-phase` with a cheap local judge, then `rag rescore <run> --judge <bigger>` on the same
answers; `rag compare` shows which metrics the judges disagree on. Add `--swap` when you suspect position bias.

**Gate a pull request.** A CI job runs `testpion rag run "Clinic RAG" --preset rag-triad --min faithfulness=0.8 --junit rag.xml` against a
local judge (`testpion ci github --rag-evaluation "Clinic RAG" --rag-min faithfulness=0.8` writes the pipeline, and the GitHub Action takes
`rag-evaluation`, `preset`, `min`, `baseline` and `max-cost`). The job fails on a gate, and `--baseline <run>` makes it fail on a real
regression instead of a noisy drop. A **monitor** can run the evaluation on a schedule too (`testpion monitor add … --rag-evaluation "Clinic RAG"
--gate faithfulness=0.8 --judge-sample 0.2 --judge-budget 1`): it judges a share of the samples, stops judging at the day's budget, and its
failure reason names the metric (*faithfulness mean 0.78 < 0.8*).

**Cost control.** `--estimate` first; `--short-circuit` skips judging a sample whose retrieval already failed; `--max-cost 1` stops
judging at a dollar (the rest is n/a); verdicts are cached, so a second run costs nothing.

**A dataset from your own logs.** Export the questions and answers of a day as CSV, open **Map columns…**, choose the columns, and
add `reference` answers where you have them; the metrics that need a reference say so until you do.

## Without a target {#offline}

An evaluation without a target keeps the older modes: the dataset holds the contexts and, optionally, the answer (it is scored as it
is), or our own model answers over the written contexts. A test file does the same:

```yaml
name: Clinic opening hours
type: rag
question: What time does the clinic open on weekdays?
contexts:
  - { id: doc-1, text: "Happy Paws Clinic opens at 8am…", score: 0.92 }
  - { id: doc-2, text: "Parking is available…", score: 0.41 }
expected: The clinic opens at 8am on weekdays.
model: { provider: openai, name: my-model }   # or `answer:` with your system's answer
```

A test file can also name a `target:` (the step and mapping written in the file) and a `judge:`.

## The older checks {#checks}

These are metrics of the catalogue under their older names. In a RAG target run they are the strict metrics above; in a test with
contexts written in the file they keep this behaviour:

| Metric | What it measures | Without a judge | With `judge:` |
|---|---|---|---|
| `context-precision` | Are the useful documents ranked first? (rank-aware average precision) | word overlap with the question and expected answer | a verdict per document |
| `context-recall` | Does the retrieved context hold what the expected answer needs? | expected-answer sentences covered | a verdict per statement of the expected answer |
| `context-entity-recall` | The expected answer's names, numbers and dates found in the context (or list them in `entities:`). Default threshold 0.8. | deterministic | — |
| `groundedness` (aliases `faithfulness`) | Is every claim of the answer supported by the context? Reports `hallucinationIndicator`. | answer sentences covered | the answer split into claims, a verdict and the evidence per claim |
| `hallucination` | The same function as groundedness, with the same direction (higher is better). It is not DeepEval's hallucination metric; it becomes a lower-is-better metric with the safety metrics. Use `faithfulness`. | | |
| `answer-correctness` (`factual-correctness`) | The answer's facts against the expected answer: F1 of precision and recall; `mode: precision \| recall \| f1`. Default threshold 0.7. | sentence overlap | claim by claim, both ways (two judge calls; one with `mode: precision`) |
| `answer-relevance` | Does the answer address the question? | word overlap | a 0–1 score with reasoning |
| `citation` | `[id]` citations must refer to retrieved documents. | deterministic | — |

### Judged claim by claim

With a `judge:`, the RAG checks do not ask the model for one number. The judge splits the answer (or the expected
answer, or the retrieved documents) into items and gives each a verdict with its evidence, a quote or a document id.
TestPion computes the score from those verdicts, so every score can be followed back to the claims behind it.

```yaml
evaluators:
  - type: faithfulness
    judge: { provider: openai, name: gpt-4o-mini }
  - type: answer-correctness
    judge: { provider: openai, name: gpt-4o-mini }
    threshold: 0.6
  - type: context-entity-recall      # no model needed
```

In the results, each check lists what did not hold first (claims **not supported**, documents **not useful**, facts
**missing**), then what did, each with its evidence. A failing check opens the list. The list is in
`metadata.items` of the check result (`{ text, ok, evidence }`), in the JSON report and over MCP, so an agent can
read it too. A judge is a model: read the evidence before acting on a verdict. The judge's provider, model, prompt
version and config hash are stored with the result for reproducibility.

The result stores the query, document IDs, scores, model, prompt hash, answer, the reference, the failure class and the evaluation.

:::
