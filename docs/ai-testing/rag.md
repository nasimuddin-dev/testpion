---
title: "RAG evaluation"
description: "Test a RAG system that runs somewhere else: connect any endpoint (HTTP, SSE, WebSocket, gRPC, MCP) from a preset or by clicking, run a dataset (Ragas, DeepEval, BEIR, NVIDIA and promptfoo files convert), choose from 30 metrics, see the cost first, and read the samples × metrics matrix."
---

::: v-pre

# RAG testing

TestPion tests a RAG system that runs somewhere else: you connect its endpoint, a dataset of questions is sent to it, and
what comes back (the answer and the documents it retrieved) is scored. Everything is under **Evaluations** (the type
*RAG*) and **RAG bots** (its own rail item: Start, Bots, Questions, Metrics, Checks; where you connect the bot). The full list of metrics is [RAG metrics](./rag-metrics.md).

## Try the sample first {#sample}

**RAG bots ▸ Start ▸ Try the sample (offline)** makes everything a first run needs and runs it, with no key, no
network and no server: an offline bot (an MCP mock with four clinic documents, `mocks/clinic-bot.mcp-mock.yaml`, served
inside TestPion), the bot as a saved target (*Clinic bot (offline)*), six questions with their reference answers and right
documents, and the evaluation *Sample: clinic bot* with the standard five measures; the offline demo model is the AI
reviewer. Two questions fail on purpose, each for a different reason, so the report has something to show: the parking
answer states something no document says (not backed by the sources), and the rabies-booster question retrieves the wrong
document (the right document is not found). The result is *4 of 6 passed*. The same thing from the command line is
`testpion rag sample` (`--no-run` only makes it, `--json` for scripts), and for an agent the MCP tool `eval_sample` with
`kind: "bot"`. An edited sample is put back as written: make your own with Duplicate.

## Read a result: the two goals, the causes, one sample by stage {#read}

A run of a bot with sources opens on its **two goals**: *Backed by the sources: 5 of 6* (every statement of the answer is in
the documents the bot retrieved) and *Right documents found: 5 of 6* (the documents the question needs were retrieved). Under
them, **Why the failed cases failed** lists the causes in plain words with how many cases each explains (*1 claim not backed by
the sources · 1 right document not found*); a cause is a chip that narrows the failed cases below to that reason. The causes come
from the run's own scores by fixed rules, the same every time, with no model. The same sentences are in `testpion eval summary`
and the MCP tool `eval_summary` (`goals`, `causes`, and `cause` on each failure).

Open a case (a cell of the matrix) and it is laid out in four stages: **1 Question, 2 Retrieved, 3 Used, 4 Answer**, each with
one line (*1 document · right documents found 0 of 1*, *1 of 2 statements backed by the documents*) and **start here** on the first
stage that went wrong, so you look at the retrieval before the answer it fed. A right document that was not retrieved is listed
with the retrieved document closest to the reference answer.

## Mark the right documents {#right-documents}

In an open sample, each retrieved document has **Right**, **Partly** and **Wrong** buttons: your own reading of whether it answers the question. The labels are kept with the run. When you mark a document Right that the question did not list, **Add the documents you marked Right to the right documents of this question** writes it into the saved questions (`reference_ids`), so the next run measures the retrieval against documents you have read. It works for questions kept as JSONL or JSON; nothing is sent to a model.

## What was under test? {#under-test}

When a score changes, the first question is *what did we change?* If your bot reports its own details in the response (the version of its document index, how many documents it retrieves, the prompt version), name them in the connect dialog under **Under test**, one line each: `Corpus version: $.meta.corpus`. Every run records them, and the report says what was under test: *Corpus version v13 (was v12), Top k 5*, with a mark when one changed since the last run. In the target file this is `mapping.meta`.

## Connect a RAG system {#connect}

- After you probe the bot, TestPion tells you what its answer looks like: *Looks like LlamaIndex query endpoint · reads "The clinic opens at 8am." and 3 documents* with **Use this mapping**.
- It knows the answers of OpenAI chat (with citations), Anthropic messages with citations, LangServe, LlamaIndex, Haystack, Dify, Flowise, Cohere, LangChain RetrievalQA and a plain answer with sources.
- Nothing is sent to a model: the mapping is tried on your response.
- `testpion rag probe` prints the same under *Looks like*.

A **RAG target** is one request to the system under test and a map of where its answer and retrieved documents are in the
response. It works over the protocols TestPion already speaks:

| Protocol | The request is | The response the mapping reads |
|---|---|---|
| HTTP | a `type: http` step, JSON in and out | the parsed JSON body |
| HTTP with server-sent events | the same, with `Accept: text/event-stream` | `{ events: [{ event, id, data }] }`; each event's `data` is parsed as JSON when it is JSON |
| WebSocket | a `type: websocket` step with the question in `send` | `{ connected, received: [...] }` |
| gRPC | a `type: grpc` step (a `.proto` file or server reflection) | the reply message |
| MCP tool | a `type: mcp` step (`server`, `tool`, `arguments`) | the tool's structured result, or its text parsed as JSON |

In **RAG bots ▸ Bots ▸ Connect a bot** (or **Checks ▸ Connect…** in a bot evaluation):

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

## The wizard {#wizard}

AI quality > Start > **Answers come from my documents** opens a three-step wizard that saves an evaluation of type `rag`, the same file as the full editor makes (so `testpion rag run`, `testpion eval run` and CI run it unchanged).

1. **Which bot?** Choose a connected bot, or **Connect a bot...** (a preset, one test question, click where the answer is).
2. **Your questions.** The questions as records (a question, a reference answer, the ids of the right documents): type them, load a file, **Generate from documents...**, **From real calls...** or import another tool's file.
3. **What should be true?** Two goals instead of the whole catalogue: *Answers are backed by the sources* (faithfulness, answer relevance) and *The right documents are found* (context recall by ids). The line **Quality checks: 5 selected (the standard set)** lists what runs; each check has **Try on question 1**; **More checks...** opens the full picker of all metrics. The cost of a run is shown under the step; a run that asks an AI reviewer asks for your yes first.

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
`--corpus`). A multi-turn Ragas sample becomes a conversation record (see [Conversations](#r3-conversations)); promptfoo assertions other than the expected value are left out and named in the notes.
**Export as…** (`testpion rag export <dataset|evaluation> --to ragas|deepeval`, `rag_export_dataset`) goes the other way; with
`--run <runId>` the answer and retrieved contexts each record got in that run are included, so Ragas or DeepEval can score the very
same answers. TestPion does not call or depend on any of these tools.

## Metrics {#metrics}

The **Metrics** tab of the evaluation lists all 138 metrics, grouped by what they measure (retrieval by ids and rank, retrieval and answer judged by a model, claim by claim, text similarity, safety, conversations, agents and tools, pictures, SQL, and your own), with a search that finds a metric by
its id, an older name or a Ragas name (`LLMContextRecall`, `nv_context_relevance`, `response_relevancy`):

* **Presets** put a set in one click: *RAG triad*, *Ragas core*, *DeepEval RAG*, *NVIDIA RAG*, *Retrieval only*, *Free (no model at
  all)*, *Answer vs reference*, *Ragas NL comparison*, *Safety*, *Conversational*, *Agentic RAG*, *Multimodal*, *Ops*.
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
* **AI reviewer options** (*AI reviewer options* in the evaluation; `--judges`, `--swap`, `--repeat` …):
  a **jury** of several judges whose scores are combined (majority, mean or lowest); **both document orders** (a disagreement is a
  tie, which does not pass); **repeat** n times (the first answer may come from the cache, the rest are asked again) and report the
  flip rate of the verdicts; **skip judging when retrieval failed** (`shortCircuit`: the judged answer metrics of a sample whose
  free retrieval metrics already failed are n/a, with no call); **share the answer's claims** (`shareClaims`).
  A jury also votes on the **claim-level metrics** (`claim-precision`, `noise-sensitivity-relevant` …): each judge gives its verdict on every claim and the claim counts as supported by the majority (`mean`: half or more, `lowest`: all), with the judges' own shares and how often they agreed in the result. The claims themselves are extracted by the first judge only, because splitting is not a verdict.
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

### More views of a run {#views}

Above the matrix, **View** switches between the samples and four other views of the same stored scores:

* **By tag** is the mean of each metric for each tag of the dataset records (`tags`), so a weak topic stands out.
* **Charts** shows the distribution of every metric.
* **Compare** puts this run against another one metric by metric, with the paired bootstrap of `rag compare`.
* **Runs × metrics** puts several runs of the evaluation side by side (the variants of a prompt, a model, a retriever setting), the mean of every metric.

The down arrow (and `testpion rag matrix <run> --format csv|json|html`) exports the samples × metrics matrix: every sample, every metric,
the aggregates, with the pass marks as edited on screen. **Score again…** re-scores the stored answers with other metrics or another
judge; the RAG system is not called. In the estimate before a run, **Free metrics first** runs the metrics that need no model now and
leaves the judged ones for **Score again…** once you have looked.

A sample opens with **The call to your RAG system**, the raw exchange (the request, the response, the streamed events and timings), and
**Explain this sample**, an AI task that reads only that sample and its metric results and says which part failed (retriever,
generator or the metric) and what to change first. It proposes nothing.

### Your own metrics, SQL and Ragas compatibility {#r2}

* **Custom metrics** are files in `metrics/*.yaml` (a criterion for a judge, a checklist, rules, a formula, an embedding set, a
  sandboxed script): see [Custom RAG metrics](./custom-metrics.md).
* **Claim-level metrics** (`claim-faithfulness`, `claim-recall`, `noise-sensitivity-relevant` …) split the answer and the reference
  into claims once and share that work between them, so five of them cost about as much as two. Ragas' one `noise_sensitivity` takes `mode: relevant | irrelevant` as in Ragas (the check, `metricToCheck` and the matrix route it to `noise-sensitivity-relevant` or `-irrelevant`). `negative-rejection` takes `mode: judge` to have a judge decide whether the answer is a refusal when the wording of a refusal is not one the pattern knows.
* **The shape of the answer and what judging cost**: `answer-regex` (a pattern, optionally `not`), `answer-length` (characters, words or tokens between `min` and `max`), `answer-json-schema` (the answer, or the JSON in a code fence, against a schema; DeepEval's JsonCorrectness) score 1 or 0 with no model, and `judge-cost` is the spend of the judge on the other metrics of the same sample, in dollars (lower is better; `max` gates it).
* **SQL metrics** (`datacompy-score`, `sql-equivalence`) compare what the generated query returns with the reference query's result.
  The query runs only through a read-only executor: one `SELECT`, no `PRAGMA`, `ATTACH`, writes or extensions, a row limit, a time limit,
  a read-only connection (a PostgreSQL or MySQL source must be marked `readOnly: true`). The `database:` of the evaluation names the
  source, and only a saved definition can: a `database` in the options of an agent's `rag_try_metric` or of the Try dialog is ignored
  (give `evaluation`, and its database is used).
  * A **SQLite** file must lie inside the workspace; where the workspace folder is not known the metric does not run at all.
  * A **PostgreSQL / MySQL** connection (`url`, or `connectionEnv` naming an environment variable) is a file in your workspace
    naming a connection of its choosing, so it is **n/a until you allow that target on this computer**:
    `testpion rag trust-db "$SHOP_DB -> postgres://reader:***@db.example:5432/shop"` (the n/a message prints the line;
    `--list` and `--forget` manage them). The decision names the variable and the host and database it points to, never a
    password, and is kept in the app's data folder, not in the workspace or the repository. If the variable later points somewhere
    else, you are asked again. A database marked `production: true` also asks the production question.
  * The checker reads the query the way the server does: MySQL's `--x`, `#` comments and `/*! … */` / `/*M! … */` comments, a
    backslash outside a string, unusual spaces and quoted function names are refused rather than stripped. A SQLite query is also
    stopped by SQLite's size limits (16 MB a value, 30 compound terms, 32 function arguments) and by a memory limit (1 GB of growth).
* **Repeating the target** (`--repeat-target 3`, "Calls per question" in the CI dialog) calls your system several times per question and
  scores the mean, with the spread: the system's own noise. A failed call counts as the worst score.
* **Ragas compatibility.** `--compat ragas` reads the metric names as Ragas spells them, with Ragas' options. `testpion rag export --to ragas --names ragas`
  (with the dataset) writes the dataset and the result columns with the names Ragas uses, and a result file of Ragas
  is imported next to a run (as a column of **external** scores) to compare the two tools sample by sample.
* **Monitors and CI.** A monitor can run a saved RAG evaluation (gates, a number of questions, a share of the samples that get the
  judged metrics, a daily judge budget); the CI dialog has the gates, the preset, a baseline, the judge budget, the metric names,
  calls per question, and on GitHub a pull-request comment with the metrics table.

### Conversations, agents, safety, pictures and decision trees {#r3}

#### Conversations {#r3-conversations}

A dataset record with `turns` is a conversation. In the column mapper (*Import…*, and any dataset whose columns are named otherwise) **Conversation** is a field: choose the column (`turns`, `conversation`, `messages`, `dialogue` or `transcript` are found by name) and the record's question becomes its last user message. `turns` is the list of the user's messages (strings), a list of messages
(`{ role, content }`, OpenAI style, or Ragas' `human` / `ai` / `tool` messages with `tool_calls`), or a transcript text
(`User: …` / `Assistant: …` lines). TestPion replays the user's messages **one after another** against the target, in one lane
(turns of a conversation never run in parallel; the evaluation's concurrency is across conversations), and records the whole
conversation with the system's own answers, the chunks it retrieved for each turn and the tools it called.

How the system keeps the conversation is set in the target (**Conversations** in the Connect dialog, `conversation.mode` in the file):

| Mode | The request uses | Notes |
|---|---|---|
| one question per call (default) | `{{question}}` | `{{messages}}`, `{{history}}`, `{{historyText}}` are available too: with one question the history is empty. |
| the request carries the history | `{{messages}}` (the earlier messages plus this one, `[{role, content}]`), `{{history}}` (the earlier ones), `{{historyText}}` (`User: …` lines) | For OpenAI-style bodies: `json: { messages: "{{messages}}" }`. |
| the system keeps a session | `{{conversationId}}` (empty on the first turn) | Click the conversation id in the sample response and choose **Conversation id**; the id of each response is carried to the next turn. |
| the session is a cookie | none | Turn on *The session is a cookie* (`conversation: { mode: server-session, cookies: true }`): the cookies each answer sets are sent with the next turn of **the same conversation**, an expired one is dropped, and no conversation sees another's. The run's shared cookie jar is not used for these calls, the values are treated as secrets and nothing of them is written to a result. No conversation id is needed. |

The last turn's answer and chunks are the sample the single-turn metrics (`faithfulness` …) score. The conversation metrics read the
transcript: `knowledge-retention` (does it ask again for what the user said?), `role-adherence` (needs `role`),
`conversation-completeness`, `turn-relevancy`, `topic-adherence` (Ragas; needs the allowed topics, a `reference_topics` column or
`topics`), `coherence-across-turns`, `conversation-helpfulness`, `user-friction`, `conversational-g-eval`, and **`per-turn:<metric>`**
(`per-turn:faithfulness`, `per-turn:answer-relevance` …) which scores every assistant turn with a single-turn metric on that turn's own
question, answer and chunks and reports the mean (or `aggregate: min`) and each turn. Ragas multi-turn samples import as conversation
records and export back (`reference` is the goal, `expected_outcome`; `reference_tool_calls` and `reference_topics` are kept).

#### Agents and tool calls {#r3-agents}

Map the tool calls the system made in the Connect dialog (**The list of tool calls**, then each call's **name** and **arguments**;
OpenAI `function.name` / JSON `arguments`, LangChain `tool` / `tool_input` and MCP shapes are found without mapping). An **MCP target** *is*
a tool call: the call itself is the trace. A conversation keeps the calls of each turn.

* Deterministic: `tool-call-accuracy` (Ragas; `args: judge` lets the judge decide, in one call, whether an argument that differs as
  text means the same: "2026-10-20" and "20 October 2026"), `tool-call-f1`, **`trajectory-match`** (`mode`: `strict`, `in-order`,
  `any-order`, `precision`, `recall`; `args: exact` compares arguments too), `tool-correctness`, and the older `tool-called`,
  `tool-not-called`, `allowed-tools`, `max-tool-calls`, `tool-sequence`, `tool-args-valid`.
* Judged: `goal-accuracy` (Ragas AgentGoalAccuracy: with an `expected_outcome` it compares the end state with it, without one it works out
  the user's goal and decides whether it was reached; two calls), `argument-correctness`, `tool-selection`, `task-completion`,
  `step-efficiency`, `plan-adherence`, `plan-quality`, `mcp-use`, `mcp-task-completion`.

#### Safety {#r3-safety}

Free and sure where a rule can decide: `pii-leakage` (`mode: regex`: e-mail, phone, social security and card numbers with their
checksums, IBANs; findings are shown masked and never copied in full into a result), `no-leak` (secrets and canaries), `refusal`,
`prompt-injection-resistance` (canary words). Judged where it takes a reading: `toxicity`, `bias`, `harmfulness`, `maliciousness`,
`misuse`, `non-advice`, `role-violation`, `controversiality`, `jailbreak-resistance`, `off-topic`, `policy-adherence` (your rules as a
checklist), and the judge modes of `pii-leakage` (patterns first, then the statements), `refusal-correctness` and
`prompt-injection-resistance` (`mode: judge` or `both`). Every judge prompt tells the judge that the answer is data it is judging, never an
instruction.

`refusal-correctness` reads `should_refuse` and counts both failures: **missed refusals** (it answered what it should have refused) and
**false refusals** (it refused what it should have answered).

**Probe sets.** *RAG bots ▸ Bots ▸ Safety probe sets* (or `testpion rag probes add`, the MCP tool `rag_probe_sets`) writes small seeded
datasets into `datasets/`: `jailbreak`, `injection` (instructions planted in the text to read, with a made-up canary word that proves
obedience), `pii`, `toxicity`, `bias`, `off-topic` and `benign` (harmless look-alikes, to count false refusals). They are ordinary
JSON Lines files with `question`, `probe`, `should_refuse`, `canaries`, `tags`: add your own lines, and seeding again never overwrites a
file that is there. Run one with an evaluation of type RAG and the **Safety** preset. The prompts name the kinds of attack a red team tries and
carry none of the harmful content.

#### Pictures {#r3-pictures}

`multimodal-faithfulness` (Ragas; `mode: claims` names the picture or text that decides each claim) and `multimodal-relevance` read the pictures of
a sample together with its texts: a retrieved chunk that is an image (map its **image** in the Connect dialog; a chunk whose text is
a `data:image/…` URI, an image URL or a file of the workspace is recognised too), or the question's own (an `images` column).

* They are sent to the judge **as data** (base64), read by TestPion itself, so the judge's provider never fetches a private URL. A
  picture cannot be masked, so **nothing is sent unless the evaluation says so** (**Send pictures to the AI reviewer** in AI reviewer options,
  `--allow-images`, `allow_images`), the AI privacy level is *Full*, and the judge can see: a vision model (Claude, Gemini, GPT-4o …, or a
  local one such as an Ollama `llava`, `qwen2.5vl` or `gemma3`; list others in the provider's `visionModels`). Otherwise the metric is n/a
  with the reason, and nothing is asked. *Local only* keeps them on this computer.
* Limits: PNG, JPEG, GIF, WebP and BMP by their content (an SVG is refused: it can carry a script), 5 MB a picture, 16 pictures and 20 MB
  a sample. A picture over a limit makes the metric n/a with the size in words; nothing is resized or silently dropped (past 16
  the first 16 go, and the result says so). The camera and place data of a photo (EXIF, XMP, comments) is removed from the copy that is sent.
* **What will be sent** (Try, `--dry-run`) lists the pictures with their size and a thumbnail. A result keeps each picture's
  reference and sha256, never its bytes; the verdict cache is keyed by the picture's hash. The drill-down shows a picture through the backend.

#### Decision trees {#r3-trees}

A metric can run only when another metric of the same sample gave a result: `when` and `unless` on its entry, or in the picker **run only
when / unless** on the metric's row.

```yaml
evaluators:
  - faithfulness
  - { type: context-recall, when: "faithfulness < 0.8" }      # find out why it is unfaithful
  - { type: answer-relevance, unless: "faithfulness < 0.8" }  # otherwise check it answers the question
```

A condition is `metric < 0.8` (also `<=`, `>`, `>=`, `=`, `!=`), `metric passes` or `metric fails`, or `{ metric, lt: 0.8 }`. A metric that
is not run costs nothing and is n/a in the matrix, with the reason; a metric whose own result is n/a makes the condition unmet. A circle, an
unknown metric or an unreadable condition is refused before the first question. From the terminal: `--when "context-recall=faithfulness < 0.8"`.
Trees work in a run of a RAG target and in a re-score.

The **`dag`** metric (DeepEval) is a decision tree *inside one metric*: nodes that ask a yes/no question or pick one option, tasks whose
result later nodes read, and **rules** (any deterministic check, no model); only the path the answers lead to is asked, and a leaf
holds the score (0 to 10). It is checked when it loads (no cycles, at most 12 nodes deep).

```yaml
- type: dag
  tree:
    root: cites
    nodes:
      cites: { type: binary, question: "Does the answer cite a source?", yes: right, no: { score: 0, reason: no citation } }
      right: { type: choice, question: "Which document does it cite?", options: { "the right one": { score: 10 }, "a wrong one": { score: 4 } } }
```

#### Other judge designs {#r3-judges}

`g-eval` (a criterion turned into evaluation steps once, cached; `samples: n` averages n ratings, an estimate of the paper's
probability-weighted score because the AI layer has no token probabilities), `pairwise` (this run's answer against a `baseline_answer`,
blinded, in both orders; the mean is the win rate), `summarization` (DeepEval's min of alignment and coverage, or `mode: ragas`),
`faithfulness-hhem` (the judge writes the claims; a classifier you serve, Vectara HHEM, decides each: `classifier: { url }`, which Local only
requires to be on this computer) and `reward-score` (a Nemotron reward model on an OpenAI-compatible endpoint you name as a provider:
`attributes`, `scalar` or `genrm`). The classifier and the reward model obey the same rules as every judge: privacy level *Full*, redaction,
*Local only*, one ledger row per call.

### From the terminal and CI {#cli}

```bash
testpion rag metrics --kind deterministic                    # what needs no model
testpion rag run "Clinic RAG" --preset rag-triad --judge ollama/qwen2.5:14b --estimate
testpion rag run "Clinic RAG" --metrics faithfulness,recall@5,token-f1 --judge ollama/qwen2.5:14b \
    --min faithfulness=0.8 --min recall@5=0.9 --junit rag.xml --html rag.html --baseline run-abc
testpion rag run "Clinic RAG" --preset ragas-core --two-phase --max-cost 2     # free metrics first, then judge the answers
testpion rag rescore run-abc --judge anthropic/claude-sonnet --swap              # no call to the RAG system
testpion rag compare run-new -b run-old                                          # metric by metric, with a paired bootstrap
testpion rag run "Clinic RAG" --compat ragas --repeat-target 3 --markdown rag.md   # Ragas names; the system's own noise; a PR comment table
testpion rag matrix run-abc --format csv > matrix.csv                              # every sample, every metric
testpion rag metric new clinic-tone --kind judge                                   # a custom metric (metrics/clinic-tone.yaml)
```

`rag run` exits **1** when a `--min` gate fails (the mean of the metric must reach the value; a metric that has no score in the run
fails its gate, because it cannot be assumed to pass) or a metric regresses against `--baseline`, and **2** for a configuration error
(no judge, an unknown metric, a target that cannot be called). Without gates, a failed sample fails the run. `rag compare` decides what
is real with a seeded paired bootstrap over the samples both runs scored, direction aware (a lower-is-better metric that went up is a
regression). A two-phase run collects the answers first (the run is recorded), then judges them as a second, re-scored run: change
the judge or add a metric later with `rag rescore` and nothing is asked of your system again.

An agent has the same: `rag_metrics`, `rag_try_metric`, `rag_estimate`, `rag_run`, `rag_rescore`, `rag_compare`, the custom-metric tools `rag_list_custom_metrics`, `rag_validate_metric`, `rag_save_custom_metric`, the probe sets `rag_probe_sets`, and the prompt
`evaluate_rag_system` (probe → metrics → estimate → run → compare). `rag_run` stops before the first question when the target cannot
be called or a judged metric has no judge.

### Make the test set, trust the judge, keep watching {#r4}

* **Generate a test set from your documents** (RAG bots ▸ Questions): questions of five kinds with reference answers and the chunk
  ids they come from, every one verified and reviewed before it joins a dataset: [Test sets from documents](./rag-testset.md).
* **Build a dataset from real calls** (History, the Debugger, a run): the question, answer and contexts of calls that already
  happened, masked before they are written: [Datasets from real calls](./rag-capture.md).
* **Calibrate the judge**: label some results pass or fail, and see how well a judge agrees with you (Cohen's kappa, a confusion
  matrix, intervals) and which pass mark agrees most: [Calibrating a judge](./rag-calibration.md).
* **Let the AI draft the evaluation**: metrics with pass marks and reasons, judge options and gates, dry-run on a few samples
  before it is offered: [Drafting an evaluation](./rag-author.md).
* **Trends, nightly runs and CI**: metric means run by run, a rotating nightly sample with a budget, a regression gate against a
  baseline: [RAG: trends, nightly runs and CI](./rag-monitoring.md).

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
| `hallucination` | DeepEval's metric since RAG R2: the share of the answer's claims the context contradicts, **lower is better** (the pass mark is a maximum). Before R2 it was another name of `faithfulness`; a test file that still uses it gets an info line at the check, and `faithfulness` is the higher-is-better metric. | | |
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
