---
title: "RAG evaluation"
description: "Test a RAG system that runs somewhere else: connect any endpoint (HTTP, SSE, WebSocket, gRPC, MCP), map its answer and retrieved contexts by clicking, run a dataset (Ragas and DeepEval files convert) and score it with deterministic metrics and a judge."
---

::: v-pre

# RAG testing

TestPion tests a RAG system that runs somewhere else: you connect its endpoint, a dataset of questions is sent to it, and
what comes back (the answer and the documents it retrieved) is scored. Everything is under **Evaluations** (the type
*RAG*) and **AI Lab ▸ RAG** (where you connect the system).

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

1. Choose the protocol; the request is written for you as YAML. The question is `{{question}}`. Inside a JSON text use
   `{{questionJson}}` (the question as a JSON string, quotes included) or `{{questionEscaped}}`; in a `json:` block
   `"{{question}}"` is always safe. Hosts and keys are `{{variables}}` and secrets, as in any request.
2. Type a question and press **Probe**. The real response appears as a tree.
3. **Click a key** in the tree and say what it is: *the answer*, *the list of retrieved contexts*, then a context's *text*,
   *id*, *score* or *source* (click inside one item of the list), the token counts, or a latency. For a streamed
   answer choose *the answer, streamed in pieces*: that field of every event is joined in order.
4. The panel under the tree shows what the mapping reads, live. The mapping is plain JSONPath (`$.answer`,
   `$.sources[*]`, `$.text`) that you can also type or edit, so the same response always gives the same sample.
5. **What the judge receives** shows the exact prompt a judged metric would send for this sample, before anything is
   sent. **Save target** keeps it in `library/rag-targets.json` of the workspace (a normal workspace item: folders,
   rename, duplicate, delete with Undo, git).

From the terminal or an agent: `testpion rag probe "Clinic bot" "What time does the clinic open?" --json`, or the
`rag_probe` MCP tool. A production environment is protected as for any request: a question is a `POST`, so it asks
first unless the target is marked as read-only.

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
```

## A dataset {#dataset}

An evaluation of type RAG takes records with a **question**, a **reference** answer and, when you have them, the gold
documents: **`reference_ids`** (the ids the retriever should return) and **`reference_contexts`** (their texts). JSON,
JSONL and CSV work (a list in a CSV cell is a JSON array, or one item per line, or `;`-separated):

```jsonl
{"id":"hours","question":"What time does the clinic open?","reference":"The clinic opens at 8am on weekdays.","reference_ids":["doc-1"],"tags":["hours"]}
```

### Ragas and DeepEval files {#ragas-deepeval}

**Import Ragas / DeepEval…** in the dataset tab (or `testpion rag import`, or the `rag_import_dataset` tool) reads the
documented shapes as data (nothing in a file is executed) and writes TestPion records:

| Ragas (`EvaluationDataset` / `SingleTurnSample`) | DeepEval (`Golden` / `LLMTestCase`) | TestPion |
|---|---|---|
| `user_input` (older: `question`) | `input` | `question` |
| `reference` (older: `ground_truth`) | `expected_output` (`expectedOutput`) | `reference` |
| `reference_contexts` | `context` | `reference_contexts` |
| `reference_context_ids` | | `reference_ids` |
| `response` (older: `answer`) | `actual_output` (`actualOutput`) | `answer` |
| `retrieved_contexts` + `retrieved_context_ids` | `retrieval_context` (`retrievalContext`) | `contexts: [{ id, text }]` |
| `persona_name`, `query_style`, `query_length` | `additional_metadata.tags` | `tags` |

The format is found from the column names (or give `--from ragas|deepeval`). Multi-turn samples are left out and named in
the notes. **Export as…** (`testpion rag export <dataset|evaluation> --to ragas|deepeval`, `rag_export_dataset`) goes the
other way; with `--run <runId>` the answer and retrieved contexts each record got in that run are included, so Ragas or
DeepEval can score the very same answers. TestPion does not call or depend on either library.

## Metrics {#metrics}

Add them in the evaluation's **Evaluators** tab (group *RAG*). Scores are computed here from numbers or from the judge's
verdicts; a metric whose input is missing fails with what to add.

| Metric | Needs | What it measures |
|---|---|---|
| `normalized-match` | reference | the answer equals the reference once case, punctuation and articles are ignored (1 or 0) |
| `token-f1` | reference | words shared with the reference, as precision, recall and F1 (the SQuAD F1). `normalize: true` drops punctuation and articles first. Default threshold 0.5 |
| `rouge` | reference | `rouge: rouge1 \| rouge2 \| rougeL` (default rougeL, the longest common subsequence), `mode: fmeasure \| precision \| recall`. No stemming. Default threshold 0.5 |
| `context-recall-ids` | `reference_ids`, mapped context ids | the gold ids that were retrieved / the gold ids. Default threshold 0.8 |
| `context-precision-ids` | `reference_ids`, mapped context ids | the retrieved ids that are gold / the retrieved ids. Default threshold 0.5 |
| `rag-faithfulness` | answer, mapped contexts, a judge | the answer is split into claims; the share the retrieved documents support. An answer with no claims is n/a |
| `rag-answer-relevance` | question, answer, a judge | the answer is split into statements; the share relevant to the question |
| `latency`, `tokens`, `cost` | | time, tokens and cost of the system under test (from the response and the mapping) |

Worked examples (they are unit tests): *the cat sat* against *a cat sat* is token F1 0.667; against *the cat sat down* ROUGE-L
is precision 1, recall 0.75, F 0.857; retrieved `[a, b, c, d]` against gold `{a, c}` is precision 0.5 and recall 1; four
claims of which three are supported is faithfulness 0.75. n/a is neither a pass nor a fail.

### The judge {#judge}

`rag-faithfulness` and `rag-answer-relevance` ask a model, through the AI task `rag-judge` (`testpion ai tasks`):

* **Which model.** The evaluation's *Judge* (a provider of the workspace and its model); else the AI settings' *large*
  model (`TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL` in the CLI and CI, `--judge provider/model`). There is **no silent
  fallback**: without a usable judge the run stops **before the first question** and lists what to configure. A mock judge
  is used only when you name the mock provider (offline tests). *Local only* is enforced: a cloud judge is refused.
* **What it sends.** Only what the metric needs (the answer and the documents; the question for relevance), redacted like every AI
  call, and only at the privacy level *Full (redacted)*. A sample longer than the judge's budget fails with a message instead
  of being cut. **What will be sent** shows the prompt (the Connect dialog).
* **The verdicts** are JSON with the reasoning first and an item per claim: the text, a verdict and the evidence (a quote and
  the document id). They are checked against the schema and repaired; the items show in the result, claims **not supported** first.
* **Cost.** Every call is in the AI usage ledger (task `rag-judge`) and counts against the daily caps. A verdict is cached by
  the content hash of the exact prompt and the model: **running again costs nothing**; any change to the sample, the metric's
  wording (its version) or the model asks again. The evaluation can limit a run (`maxJudgeCalls`, `--max-judge-cost`): what is not
  judged then is n/a, never a guess.
* The prompts are versioned (`faithfulness-v1`, `answer-relevance-v1`) and stored with every score. A judge is a model: read the
  evidence before acting on a verdict, and prefer a model from another family than the one under test.

## Run it {#run}

Evaluations ▸ type **RAG** ▸ choose the target (the Provider and Model fields become the Judge), the dataset and the metrics, **Run**. The
runs list, the results and the **Matrix** (cases × runs, against a baseline, with Download on every surface) are the same as for any
evaluation. From the terminal and CI:

```bash
testpion eval run "Clinic RAG" --judge ollama/qwen2.5:14b --max-judge-cost 1 -r console junit
testpion eval compare "Clinic RAG" --baseline "Clinic RAG v1"
```

An agent uses `list_evaluations` and `run_evaluation`; the checks of a failed run say which claims are unsupported and which gold documents were not retrieved.

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

| Metric | What it measures | Without a judge | With `judge:` |
|---|---|---|---|
| `context-precision` | Are the useful documents ranked first? (rank-aware average precision) | word overlap with the question and expected answer | a verdict per document |
| `context-recall` | Does the retrieved context hold what the expected answer needs? | expected-answer sentences covered | a verdict per statement of the expected answer |
| `context-entity-recall` | The expected answer's names, numbers and dates found in the context (or list them in `entities:`). Default threshold 0.8. | deterministic | — |
| `groundedness` (aliases `faithfulness`, `hallucination`) | Is every claim of the answer supported by the context? Reports `hallucinationIndicator`. | answer sentences covered | the answer split into claims, a verdict and the evidence per claim |
| `answer-correctness` | The answer's facts against the expected answer: F1 of precision (the answer's claims the reference supports) and recall (the reference's claims the answer makes); `mode: precision \| recall \| f1`. Default threshold 0.7. | sentence overlap | claim by claim, both ways (two judge calls; one with `mode: precision`) |
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

The result stores the query, document IDs, scores, model, prompt hash, answer and evaluation.

:::
