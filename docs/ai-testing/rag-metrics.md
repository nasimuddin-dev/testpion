# RAG metrics

<!-- Generated from the metric registry by `node scripts/gen-rag-metrics-doc.mjs`. Do not edit by hand. -->

TestPion has 84 RAG metrics. Each one can be chosen in an evaluation, tried on one sample first, gated in CI (`--min faithfulness=0.8`) and read in the samples × metrics matrix. A metric that needs a model says so, and no judged metric ever runs without a judge you chose. [Testing a RAG system](./rag.md) shows how to use them.

| Metric | Kind | Higher is better | Reads | Judge calls |
|---|---|---|---|---|
| [`faithfulness`](#faithfulness) | judge model | yes | answer, contexts | 1 (2 when it shares the claim pass with answer-relevance) |
| [`answer-relevance`](#answer-relevance) | judge model | yes | question, answer | 1 (2 when it shares the claim pass with faithfulness); reverse-questions 1 + embeddings |
| [`context-relevance`](#context-relevance) | judge model | yes | question, contexts | nvidia 2; the other modes 1 |
| [`context-precision`](#context-precision) | judge model | yes | question, contexts | 1 (one per chunk with perChunk) |
| [`context-recall`](#context-recall) | judge model | yes | question, reference, contexts | 1 |
| [`context-entity-recall`](#context-entity-recall) | no model | yes | reference, contexts | 0 (mode llm: 2) |
| [`factual-correctness`](#factual-correctness) | judge model | yes | answer, reference | 4 (precision or recall alone: 2) |
| [`citation`](#citation) | no model | yes | answer, contexts | 0 |
| [`context-precision-ids`](#context-precision-ids) | no model | yes | contexts, reference ids | 0 |
| [`context-recall-ids`](#context-recall-ids) | no model | yes | contexts, reference ids | 0 |
| [`recall@k`](#recall-k) | no model | yes | contexts, reference ids | 0 |
| [`precision@k`](#precision-k) | no model | yes | contexts, reference ids | 0 |
| [`hit-rate@k`](#hit-rate-k) | no model | yes | contexts, reference ids | 0 |
| [`mrr@k`](#mrr-k) | no model | yes | contexts, reference ids | 0 |
| [`ndcg@k`](#ndcg-k) | no model | yes | contexts, reference ids | 0 |
| [`map@k`](#map-k) | no model | yes | contexts, reference ids | 0 |
| [`r-precision`](#r-precision) | no model | yes | contexts, reference ids | 0 |
| [`context-precision-lexical`](#context-precision-lexical) | no model | yes | contexts, reference contexts | 0 |
| [`context-recall-lexical`](#context-recall-lexical) | no model | yes | contexts, reference contexts | 0 |
| [`normalized-match`](#normalized-match) | no model | yes | answer, reference | 0 |
| [`exact-match`](#exact-match) | no model | yes | answer, reference | 0 |
| [`token-f1`](#token-f1) | no model | yes | answer, reference | 0 |
| [`rouge`](#rouge) | no model | yes | answer, reference | 0 |
| [`string-similarity`](#string-similarity) | no model | yes | answer, reference | 0 |
| [`contains`](#contains) | no model | yes | answer, reference | 0 |
| [`semantic-similarity`](#semantic-similarity) | embedding model | yes | answer, reference | 0 model calls, 2 embeddings with method embedding |
| [`latency`](#latency) | no model | no (lower) | — | 0 |
| [`ttft`](#ttft) | no model | no (lower) | — | 0 |
| [`tokens`](#tokens) | no model | no (lower) | — | 0 |
| [`cost`](#cost) | no model | no (lower) | — | 0 |
| [`hole@k`](#hole-k) | no model | no (lower) | contexts, reference ids | 0 |
| [`bleu`](#bleu) | no model | yes | answer, reference | 0 |
| [`chrf`](#chrf) | no model | yes | answer, reference | 0 |
| [`numeric-diff`](#numeric-diff) | no model | yes | answer, reference | 0 |
| [`json-diff`](#json-diff) | no model | yes | answer, reference | 0 |
| [`label-f1`](#label-f1) | no model | yes | answer, reference | 0 |
| [`quoted-spans`](#quoted-spans) | no model | yes | answer, contexts | 0 |
| [`context-size`](#context-size) | no model | no (lower) | contexts | 0 |
| [`context-usage`](#context-usage) | no model | yes | answer, contexts | 0 |
| [`error-rate`](#error-rate) | no model | no (lower) | — | 0 |
| [`throughput`](#throughput) | no model | yes | latency | 0 |
| [`retrieval-score-stats`](#retrieval-score-stats) | no model | yes | scores | 0 |
| [`prompt-injection-resistance`](#prompt-injection-resistance) | no model | yes | answer, canaries | 0 |
| [`tool-call-accuracy`](#tool-call-accuracy) | no model | yes | tool calls, reference tool calls | 0 |
| [`tool-call-f1`](#tool-call-f1) | no model | yes | tool calls, reference tool calls | 0 |
| [`reference-set-similarity`](#reference-set-similarity) | embedding model | yes | answer | 0 model calls, one embedding call |
| [`context-answer-similarity`](#context-answer-similarity) | embedding model | yes | answer, contexts | 0 model calls, one embedding call |
| [`context-utilization`](#context-utilization) | judge model | yes | question, answer, contexts | 1 |
| [`retrieval-relevance`](#retrieval-relevance) | judge model | yes | question, contexts | 1 |
| [`answer-correctness`](#answer-correctness) | judge model | yes | answer, reference | 4 + one embedding call |
| [`answer-accuracy`](#answer-accuracy) | judge model | yes | question, answer, reference | 2 |
| [`response-groundedness`](#response-groundedness) | judge model | yes | answer, contexts | 2 |
| [`hallucination`](#hallucination) | judge model | no (lower) | answer, reference contexts | 1 |
| [`correctness`](#correctness) | judge model | yes | question, answer, reference | 1 |
| [`completeness`](#completeness) | judge model | yes | question, answer | 1 |
| [`factuality`](#factuality) | judge model | yes | question, answer, reference | 1 |
| [`citation-accuracy`](#citation-accuracy) | judge model | yes | answer, contexts | 1 |
| [`negative-rejection`](#negative-rejection) | no model | yes | answer | 0 |
| [`ragas-score`](#ragas-score) | judge model | yes | question, answer, reference, contexts | 4 |
| [`claim-precision`](#claim-precision) | judge model | yes | answer, reference | 2 (passes shared with the other claim-level metrics are paid once) |
| [`claim-recall`](#claim-recall) | judge model | yes | answer, reference | 2 (passes shared with the other claim-level metrics are paid once) |
| [`claim-f1`](#claim-f1) | judge model | yes | answer, reference | 4 (passes shared with the other claim-level metrics are paid once) |
| [`retriever-claim-recall`](#retriever-claim-recall) | judge model | yes | reference, contexts | 2 (passes shared with the other claim-level metrics are paid once) |
| [`retriever-context-precision`](#retriever-context-precision) | judge model | yes | reference, contexts | 2 (passes shared with the other claim-level metrics are paid once) |
| [`context-utilization-claims`](#context-utilization-claims) | judge model | yes | answer, reference, contexts | 3 (passes shared with the other claim-level metrics are paid once) |
| [`claim-faithfulness`](#claim-faithfulness) | judge model | yes | answer, contexts | 2 (passes shared with the other claim-level metrics are paid once) |
| [`claim-hallucination`](#claim-hallucination) | judge model | no (lower) | answer, reference, contexts | 3 (passes shared with the other claim-level metrics are paid once) |
| [`self-knowledge`](#self-knowledge) | judge model | yes | answer, reference, contexts | 3 (passes shared with the other claim-level metrics are paid once) |
| [`noise-sensitivity-relevant`](#noise-sensitivity-relevant) | judge model | no (lower) | answer, reference, contexts | 5 (passes shared with the other claim-level metrics are paid once) |
| [`noise-sensitivity-irrelevant`](#noise-sensitivity-irrelevant) | judge model | no (lower) | answer, reference, contexts | 5 (passes shared with the other claim-level metrics are paid once) |
| [`pass-fail`](#pass-fail) | judge model | yes | answer | 1 |
| [`simple-criteria`](#simple-criteria) | judge model | yes | answer | 1 |
| [`rubric-score`](#rubric-score) | judge model | yes | answer | 1 |
| [`instance-rubric`](#instance-rubric) | judge model | yes | answer, rubric | 1 |
| [`checklist`](#checklist) | judge model | yes | answer | 1 |
| [`prompt-alignment`](#prompt-alignment) | judge model | yes | answer | 1 |
| [`coherence`](#coherence) | judge model | yes | answer | 1 |
| [`conciseness`](#conciseness) | judge model | yes | answer, question | 1 |
| [`helpfulness`](#helpfulness) | judge model | yes | answer, question | 1 |
| [`comprehensiveness`](#comprehensiveness) | judge model | yes | answer, question, contexts | 1 |
| [`harmfulness`](#harmfulness) | judge model | yes | answer | 1 |
| [`maliciousness`](#maliciousness) | judge model | yes | answer | 1 |
| [`datacompy-score`](#datacompy-score) | SQL | yes | answer, reference | 0 |
| [`sql-equivalence`](#sql-equivalence) | judge model | yes | answer, reference, reference contexts | 1 |

## How names work

Every metric answers to its id, to the older check names (`groundedness`, `answer-correctness` …) and to the names other tools give it. `LLMContextRecall`, `context_recall` and `context-recall` are the same metric; `recall@5` is `recall@k` with `k: 5`; a name from Ragas (`response_relevancy`) also applies the options that give Ragas’ own definition. The `ragas:` prefix applies those options to any metric (`ragas:answer-relevance`). A name works wherever a metric is named: `assertions` and `evaluators` in a test, `--metrics`, `--min`, the MCP tools.

## Presets

- **RAG triad** (`rag-triad`): TruLens’ three questions: is the context relevant, is the answer grounded in it, does the answer address the question.
- **Ragas core** (`ragas-core`): Ragas’ everyday set, with Ragas’ own definitions (answer relevance by reverse questions).
- **DeepEval RAG** (`deepeval-rag`): DeepEval’s RAG metrics: statement-based relevance, faithfulness, contextual precision, recall and relevancy.
- **NVIDIA RAG** (`nvidia-rag`): NVIDIA’s retrieval view: context relevance (two prompts) and the IR measures recall@k and nDCG@k at 5 and 10.
- **Retrieval only (no model)** (`retrieval-only`): Judges the retriever against the gold chunk ids, with no model at all.
- **Free (no model at all)** (`free`): Every metric that needs no judge and no embedding model: ids and rank, lexical, answer text and the limits.
- **Answer vs reference** (`answer-vs-reference`): How close the answer is to the reference answer, by facts, by meaning and by words.
- **Ragas NL comparison** (`ragas-nl-comparison`): Ragas’ natural-language comparison group that this release has (BLEU and chrF come later).
- **Ops** (`ops`): Latency, time to first token, tokens and cost of the system under test.

## Why a sample scored low

Every failing sample gets a class from fixed rules over its metric results, so the matrix can be filtered by cause.

- **System error** (`system-error`): The RAG system did not answer (an error, a timeout, a refused request).
- **Format** (`format`): It answered but the mapping found no answer in the response: the answer is empty or in a shape the target does not read.
- **Judge error** (`judge-error`): A judge could not score the sample (no verdict in the expected format); fix the judge, not the system.
- **Retrieval miss** (`retrieval-miss`): The retriever did not bring what the question needs (the gold chunks or the reference facts are not in the contexts, or nothing was retrieved).
- **False refusal** (`false-refusal`): The retrieval was good but the answer refuses or says it does not know.
- **Ranking** (`ranking`): The right chunks were retrieved but ranked low.
- **Noise** (`noise`): The right chunks were retrieved among many irrelevant ones.
- **Unfaithful** (`unfaithful`): The retrieval was fine but the answer makes claims the documents do not support.
- **Off topic** (`off-topic`): The answer does not address the question.
- **Incomplete or wrong** (`incomplete`): Retrieval and grounding were fine but the answer differs from the reference.
- **Citation** (`citation`): The answer cites documents that were not retrieved.
- **Operational** (`operational`): Only a latency, token or cost limit failed.
- **Other** (`other`): A check failed that no rule explains.

## Retrieval, judged

### Context relevance {#context-relevance}

`context-relevance` · judge model · higher is better · passes at 0.5 · judge calls: nvidia 2; the other modes 1

How much of what was retrieved is relevant to the question (a low score means the retriever brings noise). Four modes follow the four tools that define it.

**How.** mode nvidia (default, Ragas/NVIDIA): two prompts each rate the whole retrieved text 0, 1 or 2; the mean / 2. statements (DeepEval): relevant statements / statements. chunks (TruLens): each chunk rated 0 to 3, mean / 3. sentences (promptfoo): needed sentences / sentences. Nothing retrieved, or a context that is the question, scores 0 with no call.

**Example.** nvidia ratings 2 and 1: (2 + 1) / 2 / 2 = 0.75. statements: 10 statements, 4 relevant: 0.4.

**Reads.** the question; the retrieved contexts.

**Options.**

- `mode` (nvidia | statements | chunks | sentences), default `nvidia`: Which definition of context relevance to compute.

**Also called.** `contextual-relevancy`, `context_relevance`, `ContextRelevance`, `nv_context_relevance`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `mode: nvidia`.

**Prompts.** `context-relevance-nvidia-a-v1`, `context-relevance-nvidia-b-v1`, `context-relevance-statements-v1`, `context-relevance-chunks-v1`, `context-relevance-sentences-v1`

### Context precision {#context-precision}

`context-precision` · judge model · higher is better · passes at 0.5 · judge calls: 1 (one per chunk with perChunk)

Whether the useful chunks are ranked first (rank-weighted average precision over the retrieved chunks).

**How.** A verdict per chunk (useful for arriving at the reference answer; the answer when there is no reference); average precision = Σ precision@k · relevant(k) / relevant chunks. `perChunk: true` asks the judge once per chunk, as Ragas does.

**Example.** Verdicts [useful, not, useful]: (1/1 + 2/3) / 2 = 0.833.

**Reads.** the question; the retrieved contexts; also, when present: a reference answer (dataset column "reference").

**Options.**

- `perChunk` (boolean), default `false`: Ask the judge once per chunk (Ragas) instead of once for all.

**Also called.** `contextual-precision`, `context_precision`, `ContextPrecision`, `LLMContextPrecisionWithReference`, `llm_context_precision_with_reference`

**Ragas.** Ragas asks one judge call per chunk; the bare id asks once for all chunks (`perChunk: true`, or the class names, asks per chunk).

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `perChunk: true`.

**Prompts.** `context-precision-judge-v1`, `context-precision-judge-one-v1`

### Context recall {#context-recall}

`context-recall` · judge model · higher is better · passes at 0.8 · judge calls: 1

Whether the retrieved documents contain what the reference answer says (each statement of the reference is looked for in them).

**How.** reference statements found in the documents / reference statements.

**Example.** The reference has 4 statements and the documents hold 3 of them: 0.75.

**Reads.** the question; a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `contextual-recall`, `context_recall`, `ContextRecall`, `LLMContextRecall`, `llm_context_recall`

**Prompts.** `context-recall-judge-v1`

### Context entity recall {#context-entity-recall}

`context-entity-recall` · no model · higher is better · passes at 0.8 · judge calls: 0 (mode llm: 2)

The share of the reference’s entities (names, numbers with units) that appear in the retrieved text.

**How.** entities of the reference found in the contexts / entities of the reference. mode regex (default): found by pattern, no model, case ignored. mode llm (Ragas): a judge lists the entities of the reference and of the contexts (2 calls) and they are matched exactly. A reference with no entities is n/a.

**Example.** Reference entities {Paris, 1889, Eiffel}; the contexts have Paris and Eiffel: 0.667.

**Reads.** a reference answer (dataset column "reference"); the retrieved contexts.

**Options.**

- `mode` (regex | llm), default `regex`: regex: patterns, no model. llm: a judge extracts the entities (Ragas).
- `caseSensitive` (boolean), default `false`: mode llm: match entities exactly, as Ragas.

**Also called.** `context_entities_recall`, `context_entity_recall`, `ContextEntityRecall`

**Ragas.** Ragas extracts the entities with a model and matches case-sensitively: a Ragas class name or the `ragas:` prefix selects mode llm.

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `mode: llm`, `caseSensitive: true`.

**Prompts.** `entities-reference-v1`, `entities-contexts-v1`

### Context utilization {#context-utilization}

`context-utilization` · judge model · higher is better · passes at 0.5 · judge calls: 1

Which retrieved chunks the answer actually used, rank-weighted: useful chunks should come first. It needs no reference answer.

**How.** A verdict per chunk (does the answer take a fact from it); average precision = Σ precision@k · used(k) / used chunks. `perChunk: true` asks once per chunk, as Ragas does.

**Example.** Verdicts [not used, used]: (1/2) / 1 = 0.5.

**Reads.** the question; the answer; the retrieved contexts.

**Options.**

- `perChunk` (boolean), default `false`: Ask the judge once per chunk (Ragas) instead of once for all.

**Also called.** `context_utilization`, `ContextUtilization`, `LLMContextPrecisionWithoutReference`, `llm_context_precision_without_reference`

**Prompts.** `context-utilization-v1`

### Retrieval relevance {#retrieval-relevance}

`retrieval-relevance` · judge model · higher is better · passes at 0.5 · judge calls: 1

A relevant / not relevant label for every retrieved chunk, then a rank measure over those labels (precision@k by default; no recall, because the documents that were not retrieved are unknown).

**How.** Labels from the judge, then `measure` (precision, mrr, ndcg or hit-rate) at `k` (all chunks by default).

**Example.** Labels [relevant, not, relevant]: precision@3 = 0.667, mrr = 1.

**Reads.** the question; the retrieved contexts.

**Options.**

- `measure` (precision | mrr | ndcg | hit-rate), default `precision`: Which rank measure to compute from the labels.
- `k` (number): How many of the top chunks count (default: all).

**Prompts.** `retrieval-relevance-v1`

## Retrieval, by ids and rank (no model)

### Context precision (ids) {#context-precision-ids}

`context-precision-ids` · no model · higher is better · passes at 0.5 · no judge calls

The share of the retrieved chunks whose id is a gold id.

**How.** retrieved ids that are gold / retrieved ids

**Example.** Retrieved [a, b, c, d], gold {a, c}: 2 / 4 = 0.5.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Also called.** `id_based_context_precision`, `IDBasedContextPrecision`

### Context recall (ids) {#context-recall-ids}

`context-recall-ids` · no model · higher is better · passes at 0.8 · no judge calls

The share of the gold chunk ids that were retrieved.

**How.** gold ids retrieved / gold ids

**Example.** Retrieved [a, b, c, d], gold {a, c, e}: 2 / 3 = 0.667.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Also called.** `id_based_context_recall`, `IDBasedContextRecall`

### Recall@k {#recall-k}

`recall@k` · no model · higher is better · passes at 0.8 · no judge calls

The share of the gold chunks found in the top k retrieved.

**How.** |gold ∩ top k| / |gold|

**Example.** k = 3, gold {a, e}, top 3 [a, b, c]: 0.5.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `recall-at-k`

### Precision@k {#precision-k}

`precision@k` · no model · higher is better · passes at 0.3 · no judge calls

The share of the top k retrieved that are gold.

**How.** |gold ∩ top k| / k

**Example.** k = 3, gold {a, e}, top 3 [a, b, c]: 0.333.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `precision-at-k`

### Hit rate@k {#hit-rate-k}

`hit-rate@k` · no model · higher is better · passes at 1 · no judge calls

Whether any gold chunk is in the top k (1 or 0).

**How.** 1 if a gold id is in the top k, else 0

**Example.** k = 3, gold {a, e}, top 3 [b, a, c]: 1.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `success@k`, `hit@k`

### MRR@k {#mrr-k}

`mrr@k` · no model · higher is better · passes at 0.5 · no judge calls

The reciprocal rank of the first gold chunk in the top k.

**How.** 1 / rank of the first gold id (0 when none in the top k)

**Example.** Gold {b}, retrieved [a, b, c]: 1 / 2 = 0.5.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `reciprocal-rank@k`, `recip-rank@k`

### nDCG@k {#ndcg-k}

`ndcg@k` · no model · higher is better · passes at 0.6 · no judge calls

Rank-discounted gain of the gold chunks in the top k, against the best possible order.

**How.** DCG = Σ rel(i) / log2(i + 1) over the top k, divided by the ideal DCG (all gold first)

**Example.** Retrieved [x, a, b] with gold {a, b}, k = 3: DCG = 0.631 + 0.5 = 1.131; ideal = 1 + 0.631 = 1.631; nDCG = 0.693.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `ndcg-at-k`

### MAP@k {#map-k}

`map@k` · no model · higher is better · passes at 0.5 · no judge calls

Average precision of the gold chunks in the top k (gold never retrieved count as 0).

**How.** Σ precision@i · rel(i) over the top k / |gold|

**Example.** Gold {a, c, e}, retrieved [a, b, c], k = 3: (1 + 2/3) / 3 = 0.556.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `average-precision@k`

### R-precision {#r-precision}

`r-precision` · no model · higher is better · passes at 0.5 · no judge calls

Precision in the first R retrieved, where R is the number of gold chunks.

**How.** |gold ∩ top R| / R

**Example.** Gold {a, c}, retrieved [a, b, c]: precision in the top 2 = 0.5.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids").

**Also called.** `rprec`

### Context precision (lexical) {#context-precision-lexical}

`context-precision-lexical` · no model · higher is better · passes at 0.5 · no judge calls

Rank-aware precision where a retrieved chunk counts as relevant when it is similar enough to a gold chunk text (string similarity, no model).

**How.** A chunk is relevant when its Levenshtein similarity to some gold chunk text is at least `threshold` (0.5); then average precision over the chunks, as context-precision.

**Example.** Relevant [yes, no, yes, no]: (1 + 2/3) / 2 = 0.833.

**Reads.** the retrieved contexts; the gold chunk texts (dataset column "reference_contexts").

**Options.**

- `similarity` (number), default `0.5`: How similar a chunk must be to a gold chunk to count as relevant.

**Also called.** `non_llm_context_precision_with_reference`, `NonLLMContextPrecisionWithReference`

### Context recall (lexical) {#context-recall-lexical}

`context-recall-lexical` · no model · higher is better · passes at 0.8 · no judge calls

The share of the gold chunk texts that some retrieved chunk is similar to (string similarity, no model).

**How.** A gold chunk is recalled when some retrieved chunk’s Levenshtein similarity to it is above `similarity` (0.5); recalled / gold chunks.

**Example.** 2 of 3 gold chunks matched: 0.667.

**Reads.** the retrieved contexts; the gold chunk texts (dataset column "reference_contexts").

**Options.**

- `similarity` (number), default `0.5`: How similar a chunk must be to a gold chunk to recall it.

**Also called.** `non_llm_context_recall`, `NonLLMContextRecall`

### Hole@k {#hole-k}

`hole@k` · no model · lower is better · passes at 0.1 · no judge calls

The share of the top k retrieved chunks that nobody has labelled (BEIR): a high value means the gold list is too short to judge this retriever fairly, not that it is bad.

**How.** chunks in the top k whose id has no relevance label / k. A label is a gold id or any id in the record’s `relevance` grades (even grade 0).

**Example.** 3 of the top 10 have no label: 0.3.

**Reads.** the retrieved contexts; the gold chunk ids (dataset column "reference_ids"); also, when present: graded relevance of the gold chunks (dataset column "relevance": {id: grade}).

**Options.**

- `k` (number), default `10`: How many of the top retrieved chunks count.

**Also called.** `hole-at-k`

## Generation

### Faithfulness {#faithfulness}

`faithfulness` · judge model · higher is better · passes at 0.8 · judge calls: 1 (2 when it shares the claim pass with answer-relevance)

The share of the answer’s claims that the retrieved documents support (a high score means the answer stays inside what was retrieved).

**How.** claims supported by the documents / claims in the answer. An answer with no claims is n/a, not 0.

**Example.** The answer makes 4 claims and the documents support 3 of them: 3 / 4 = 0.75.

**Reads.** the answer; the retrieved contexts.

**Also called.** `rag-faithfulness`, `groundedness`, `Faithfulness`, `faithful`

**Prompts.** `faithfulness-v1`, `faithfulness-claims-v1` (claims shared through `claims-v1`)

### Answer relevance {#answer-relevance}

`answer-relevance` · judge model · higher is better · passes at 0.7 · judge calls: 1 (2 when it shares the claim pass with faithfulness); reverse-questions 1 + embeddings

How well the answer addresses the question: the share of its statements that are relevant to it (a low score means the answer wanders off or pads). Ragas’ response_relevancy asks for questions the answer would reply to and compares them with the real one.

**How.** mode statements (default): relevant statements / statements. mode reverse-questions (Ragas): the mean cosine similarity between the question and 3 questions the judge writes from the answer (embeddings), 0 when the answer is noncommittal.

**Example.** An answer of 5 statements, 4 on topic: 4 / 5 = 0.8.

**Reads.** the question; the answer.

**Options.**

- `mode` (statements | reverse-questions), default `statements`: statements: a judge rates each statement. reverse-questions: Ragas’ method (needs an embedding model).
- `embedder` (string): reverse-questions: the provider/model that embeds (default: the judge’s provider).

**Also called.** `rag-answer-relevance`, `response_relevancy`, `ResponseRelevancy`, `answer_relevancy`, `AnswerRelevancy`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `mode: reverse-questions`.

**Prompts.** `answer-relevance-v1`, `answer-relevance-claims-v1`, `answer-relevance-questions-v1` (claims shared through `claims-v1`)

### Factual correctness {#factual-correctness}

`factual-correctness` · judge model · higher is better · passes at 0.7 · judge calls: 4 (precision or recall alone: 2)

How the answer’s facts agree with the reference answer’s: precision (the answer’s claims the reference supports), recall (the reference’s claims the answer makes) and their F1.

**How.** The answer and the reference are split into claims (2 calls); each answer claim is checked against the reference (precision) and each reference claim against the answer (recall). mode f1 (default): their F-beta (`beta` 1), precision or recall alone.

**Example.** Precision 3/4 and recall 3/5: F1 = 0.667.

**Reads.** the answer; a reference answer (dataset column "reference"); also, when present: the question.

**Options.**

- `mode` (f1 | precision | recall), default `f1`: Which of the three scores to return.
- `beta` (number), default `1`: mode f1: how much recall counts against precision.

**Also called.** `factual_correctness`, `FactualCorrectness`

**Ragas.** Ragas rounds to 2 decimals.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1` (claims shared through `claim-passes`)

### Citation validity {#citation}

`citation` · no model · higher is better · passes at 1 · no judge calls

The share of the answer’s citation markers ([doc-2], [1]) that refer to a document that was retrieved.

**How.** valid citations / citations. It does not check that the cited document supports the claim (faithfulness does).

**Example.** The answer cites [1] and [7] and 3 documents were retrieved: 1 / 2 = 0.5.

**Reads.** the answer; the retrieved contexts.

**Also called.** `citations`

### Quoted spans {#quoted-spans}

`quoted-spans` · no model · higher is better · passes at 1 · no judge calls

Whether the quotations in the answer (three words or more) really occur in the retrieved documents, word for word.

**How.** quoted spans found verbatim (case folded, spaces collapsed) in the documents / quoted spans. An answer with no quotation scores 1 (Ragas).

**Example.** The answer quotes two phrases and one is in the documents: 0.5.

**Reads.** the answer; the retrieved contexts.

**Options.**

- `minSpanWords` (number), default `3`: The fewest words a quotation must have to count.
- `casefold` (boolean), default `true`: Ignore case when looking for a quotation.

**Also called.** `quoted_spans`, `QuotedSpansAlignment`, `quoted_spans_alignment`

### Answer correctness {#answer-correctness}

`answer-correctness` · judge model · higher is better · passes at 0.6 · judge calls: 4 + one embedding call

Ragas’ weighted answer correctness: the factual agreement with the reference (claims both ways) and the closeness in meaning (embeddings).

**How.** 0.75 × factual-correctness F1 + 0.25 × the cosine similarity of the answer and the reference embeddings (`weights` changes the split; weights [1, 0] needs no embedding model).

**Example.** Factual F1 0.571 and similarity 0.9: 0.75 × 0.571 + 0.25 × 0.9 = 0.653.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `weights` (string): The two weights [factual, semantic] (default [0.75, 0.25]).
- `embedder` (string): The provider/model that embeds (default: the judge’s provider).

**Also called.** `answer_correctness`, `AnswerCorrectness`

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1` (claims shared through `claim-passes`)

### Answer accuracy {#answer-accuracy}

`answer-accuracy` · judge model · higher is better · passes at 0.5 · judge calls: 2

NVIDIA’s answer accuracy: how well the answer agrees with the reference as a whole, rated twice (the second time with the two texts swapped) and averaged.

**How.** Two prompts each rate 0, 2 or 4 (0 no match, 2 partial, 4 full); each rating / 4; the mean. If one rating is invalid the other counts; `prompts: 1` asks only the first.

**Example.** Ratings 4 and 2: (1 + 0.5) / 2 = 0.75.

**Reads.** the question; the answer; a reference answer (dataset column "reference").

**Options.**

- `prompts` (number), default `2`: 2: both orders (NVIDIA). 1: only the first prompt (half the cost).

**Also called.** `answer_accuracy`, `AnswerAccuracy`, `nv_accuracy`

**Prompts.** `answer-accuracy-a-v1`, `answer-accuracy-b-v1`

### Response groundedness {#response-groundedness}

`response-groundedness` · judge model · higher is better · passes at 0.5 · judge calls: 2

NVIDIA’s response groundedness: how well the retrieved documents ground the answer as a whole, rated by two prompts and averaged. Cheaper than faithfulness, and coarser: it does not list the unsupported claims.

**How.** Two prompts each rate 0, 1 or 2 (not, partly, fully grounded); each rating / 2; the mean. A blank answer or no documents scores 0 without a call; one invalid rating falls back to the other.

**Example.** Ratings 2 and 1: (1 + 0.5) / 2 = 0.75.

**Reads.** the answer; the retrieved contexts.

**Options.**

- `prompts` (number), default `2`: 2: both prompts (NVIDIA). 1: only the first (half the cost).

**Also called.** `response_groundedness`, `ResponseGroundedness`, `nv_response_groundedness`

**Prompts.** `response-groundedness-a-v1`, `response-groundedness-b-v1`

### Hallucination {#hallucination}

`hallucination` · judge model · lower is better · passes at 0.5 · judge calls: 1

The share of the ground-truth documents the answer contradicts (DeepEval Hallucination). Lower is better; the sub-score `alignment` is its mirror. This is not faithfulness: it needs the true documents, and it only counts direct conflicts, not claims the documents do not mention.

**How.** documents the answer contradicts / documents given in `reference_contexts` (or in the retrieved contexts with `against: contexts`). Passes at 0.5 or less, DeepEval’s default.

**Example.** 4 ground-truth documents, 1 contradicted: 0.25 (alignment 0.75).

**Reads.** the answer; the gold chunk texts (dataset column "reference_contexts").

**Options.**

- `against` (reference-contexts | contexts), default `reference-contexts`: Which documents the answer is compared with.

**Prompts.** `hallucination-v1`

### Correctness {#correctness}

`correctness` · judge model · higher is better · passes at 1 · judge calls: 1

A binary verdict: is the answer correct with respect to the reference (extra accurate information is allowed, a conflict is not)?

**How.** One verdict from the judge, explanation first. 1 or 0.

**Example.** The answer gives a different date than the reference: 0.

**Reads.** the question; the answer; a reference answer (dataset column "reference").

**Also called.** `closed-qa`

**Prompts.** `correctness-v1`

### Completeness {#completeness}

`completeness` · judge model · higher is better · passes at 0.8 · judge calls: 1

Whether the answer covers every part of the question (or every point of the reference when there is one).

**How.** parts of the question answered / parts of the question.

**Example.** A question with 4 parts and an answer covering 3: 0.75.

**Reads.** the question; the answer; also, when present: a reference answer (dataset column "reference").

**Prompts.** `completeness-v1`

### Factuality {#factuality}

`factuality` · judge model · higher is better · passes at 0.6 · judge calls: 1

How the answer relates to the reference, in five categories: a subset, a superset, the same, a disagreement, or different in a way that does not matter.

**How.** The category from one judge call, scored A 0.4, B 0.6, C 1, D 0, E 1 (Braintrust’s scores; `scores: { A: …, E: … }` changes them). D is the only category that fails.

**Example.** Category B (the answer adds consistent detail): 0.6.

**Reads.** the question; the answer; a reference answer (dataset column "reference").

**Options.**

- `scores` (string): A score per category, e.g. { A: 0.4, B: 0.6, C: 1, D: 0, E: 1 }.

**Prompts.** `factuality-v1`

### Citation accuracy {#citation-accuracy}

`citation-accuracy` · judge model · higher is better · passes at 0.8 · judge calls: 1

Whether each cited document really supports the sentence that cites it (the existence of the citation is the cheaper `citation` metric).

**How.** precision = supporting citations / citations; recall = sentences with a supporting citation / sentences; `mode` chooses precision (default), recall or f1.

**Example.** 5 citations, 4 support their sentence: 0.8.

**Reads.** the answer; the retrieved contexts.

**Options.**

- `mode` (precision | recall | f1), default `precision`: Which score to return.

**Prompts.** `citation-accuracy-v1`

### Negative rejection {#negative-rejection}

`negative-rejection` · no model · higher is better · passes at 1 · no judge calls

Whether the system declines a question the documents cannot answer, without declining one they can. The dataset marks the unanswerable questions with `answerable: false`.

**How.** 1 when the question is unanswerable and the answer declines (or it is answerable and the system answers); else 0. The metadata says whether the miss was a false refusal or a missed refusal.

**Example.** An unanswerable question answered with confidence: 0.

**Reads.** the answer; also, when present: whether the question can be answered from the documents (dataset column "answerable": true or false).

**Also called.** `rejection`

### RAGAS score {#ragas-score}

`ragas-score` · judge model · higher is better · passes at 0.7 · judge calls: 4

DeepEval’s RAGAS aggregate: the mean of answer relevance, faithfulness, context precision and context recall.

**How.** The mean of the four metrics’ scores (each at its default). A metric without a score (n/a) is left out of the mean.

**Example.** 0.85, 0.75, 0.833 and 0.75: 0.796.

**Reads.** the question; the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `ragas-aggregate`

**Prompts.** `answer-relevance-v1`, `faithfulness-v1`, `context-precision-judge-v1`, `context-recall-judge-v1`

## Answer against the reference (no model)

### Normalized match {#normalized-match}

`normalized-match` · no model · higher is better · passes at 1 · no judge calls

Whether the answer equals the reference once case, punctuation and articles (a, an, the) are ignored (the SQuAD exact match).

**How.** 1 when the normalised texts are equal, else 0.

**Example.** “The Clinic opens at 8am!” and “clinic opens at 8am” are equal once case, punctuation and the article are ignored: 1.

**Reads.** the answer; a reference answer (dataset column "reference").

**Also called.** `squad-exact-match`

### Exact match {#exact-match}

`exact-match` · no model · higher is better · passes at 1 · no judge calls

Whether the answer is exactly the reference (trimmed).

**How.** 1 when equal, else 0.

**Example.** “Paris” and “Paris” → 1; “Paris.” and “Paris” → 0.

**Reads.** the answer; a reference answer (dataset column "reference").

**Also called.** `exact_match`, `ExactMatch`

### Token F1 {#token-f1}

`token-f1` · no model · higher is better · passes at 0.5 · no judge calls

The word overlap between the answer and the reference (the SQuAD F1).

**How.** F1 of the clipped word overlap: precision = overlap / answer words, recall = overlap / reference words.

**Example.** Answer “opens at 8am daily”, reference “opens at 8am”: overlap 3, precision 3/4, recall 1: F1 = 0.857.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `normalize` (boolean), default `false`: Drop punctuation and articles first.

### ROUGE {#rouge}

`rouge` · no model · higher is better · passes at 0.5 · no judge calls

ROUGE-1, ROUGE-2 or ROUGE-L between the answer and the reference.

**How.** N-gram overlap (1, 2) or the longest common subsequence (L), as precision, recall or F-measure. No stemming.

**Example.** ROUGE-1 of “a b c d” against “a b x”: overlap 2, precision 0.5, recall 0.667, F = 0.571.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `rouge` (rouge1 | rouge2 | rougeL), default `rougeL`: Which ROUGE.
- `mode` (fmeasure | precision | recall), default `fmeasure`: Which of the three.

**Also called.** `rouge-l`, `rouge_score`, `RougeScore`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `rouge: rougeL`, `mode: fmeasure`.

### String similarity {#string-similarity}

`string-similarity` · no model · higher is better · passes at 0.8 · no judge calls

How close the answer is to the reference as text: 1 minus the edit distance over the longer length.

**How.** Levenshtein similarity = 1 − edit distance / max(length), on the exact texts (no case folding, no trimming unless `normalize` is set).

**Example.** “kitten” and “sitting”: distance 3, length 7: 1 − 3/7 = 0.571.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `normalize` (boolean), default `false`: Ignore case and surrounding spaces.

**Also called.** `levenshtein`, `non_llm_string_similarity`, `NonLLMStringSimilarity`

### Contains the reference {#contains}

`contains` · no model · higher is better · no judge calls

Whether the answer contains the reference text.

**How.** 1 when the answer contains the expected text, else 0.

**Example.** Answer “It opens at 8am daily” contains “8am” → 1.

**Reads.** the answer; a reference answer (dataset column "reference").

**Also called.** `string_presence`, `StringPresence`

### BLEU {#bleu}

`bleu` · no model · higher is better · passes at 0.3 · no judge calls

How many word sequences (1 to 4 words) of the answer are in the reference, with a penalty for a short answer: the machine-translation score, computed as sacreBLEU does.

**How.** geometric mean of the clipped 1 to 4-gram precisions × the brevity penalty, with sacreBLEU’s exponential smoothing, on the 13a tokenisation. Ragas splits both texts on ". " and scores them as one corpus (`segmentation: ragas`, default); `whole` scores each text as one segment.

**Example.** “the cat sat on the mat” against “the cat is on the mat”: precisions 5/6, 3/5, 1/4, 0/3 (smoothed to 1/6): BLEU 0.38.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `segmentation` (ragas | whole), default `ragas`: ragas: split on ". " and score as one corpus (Ragas). whole: the whole text is one segment.

**Also called.** `bleu_score`, `BleuScore`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `segmentation: ragas`.

### chrF {#chrf}

`chrf` · no model · higher is better · passes at 0.5 · no judge calls

The character n-gram F-score (chrF) between the answer and the reference: it forgives small spelling and inflection differences that BLEU punishes.

**How.** character n-grams of order 1 to 6 with spaces removed; precision and recall averaged over the orders both texts have; F-beta of the two averages (beta 2, recall counts double), as sacreBLEU.

**Example.** “abcd” against “abce”: orders 1 to 4 give 0.75, 0.667, 0.5 and 0, averaging 0.479.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `charOrder` (number), default `6`: The longest character n-gram.
- `beta` (number), default `2`: How much recall counts against precision.

**Also called.** `chrf++`, `chrf_score`, `CHRFScore`, `ChrfScore`

### Numeric difference {#numeric-diff}

`numeric-diff` · no model · higher is better · passes at 0.95 · no judge calls

How close the number in the answer is to the reference number (a price, a dose, a count). With `op` it is an exact number check instead.

**How.** 1 − |a − b| / max(|a|, |b|), from the first number in the answer (or the JSON value at `path`). With `op` (==, !=, >, >=, <, <=) and `epsilon` it is 1 when the comparison holds, else 0.

**Example.** The answer says 95 and the reference is 100: 0.95.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `op` (== | != | > | >= | < | <=): Compare the two numbers instead of scoring their distance.
- `epsilon` (number), default `0`: With op: how far apart two numbers may be and still be equal.
- `path` (string): A JSONPath to the number when the answer is JSON.

**Also called.** `number-check`, `numeric`

### JSON difference {#json-diff}

`json-diff` · no model · higher is better · passes at 0.9 · no judge calls

How close a JSON answer is to a JSON reference, key by key: strings by edit similarity, numbers by distance, nested objects and lists recursively.

**How.** the mean similarity over the keys of either side (a missing key is 0); lists element by element over the longer length; strings by Levenshtein similarity; numbers by numeric difference.

**Example.** {"a": 1, "b": "x"} against {"a": 1, "b": "y"}: key a 1, key b 0: 0.5.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `path` (string): A JSONPath to the part of the answer to compare.

**Also called.** `jsondiff`

### Label F1 {#label-f1}

`label-f1` · no model · higher is better · passes at 0.8 · no judge calls

Precision, recall and F1 of the labels the answer gives (a classification, tags, entities) against the expected labels.

**How.** the answer’s labels (a JSON list, or words separated by commas, semicolons or lines) as a set against the reference’s; F1 of set precision and recall, case ignored by default.

**Example.** Expected {a, b}, answered {a, c}: precision 0.5, recall 0.5, F1 0.5.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `path` (string): A JSONPath to the labels when the answer is JSON.
- `caseSensitive` (boolean), default `false`: Tell “Billing” from “billing”.

**Also called.** `labels-f1`

## Embedding

### Semantic similarity {#semantic-similarity}

`semantic-similarity` · embedding model · higher is better · passes at 0.8 · judge calls: 0 model calls, 2 embeddings with method embedding

How close the answer is to the reference in meaning (cosine of their embeddings; `method: lexical` or `f1` without an embedding model).

**How.** cosine(embedding(answer), embedding(reference)).

**Example.** Two paraphrases embed close together: about 0.9.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `method` (embedding | lexical | f1), default `lexical`: embedding needs a provider that embeds.

**Also called.** `similarity`, `semantic_similarity`, `SemanticSimilarity`, `answer_similarity`, `AnswerSimilarity`

**Ragas.** The bare id keeps the older default (method lexical); `ragas:semantic_similarity` or AnswerSimilarity embeds, as Ragas does.

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `method: embedding`.

### Reference-set similarity {#reference-set-similarity}

`reference-set-similarity` · embedding model · higher is better · passes at 0.8 · judge calls: 0 model calls, one embedding call

How close the answer is to the nearest of several good answers (and, when you list bad ones, that it stays away from them).

**How.** the largest cosine between the answer’s embedding and a good answer’s (`aggregate: mean` takes the mean); with bad answers it also fails when the closest one is at `negativeMax` or more.

**Example.** Closest of three good answers 0.91, closest bad answer 0.42 (limit 0.6): passes.

**Reads.** the answer; also, when present: a reference answer (dataset column "reference"); other acceptable answers (dataset column "good_answers").

**Options.**

- `embedder` (string): The provider/model that embeds (default: the judge’s provider).
- `aggregate` (max | mean), default `max`: How the similarities to the good answers combine.
- `negativeMax` (number), default `0.6`: The similarity to a bad answer at which the sample fails.

**Also called.** `answer-set-similarity`

### Context-answer similarity {#context-answer-similarity}

`context-answer-similarity` · embedding model · higher is better · passes at 0.6 · judge calls: 0 model calls, one embedding call

A cheap grounding check with no judge: how close each sentence of the answer is to the nearest retrieved chunk, in meaning.

**How.** for each answer sentence the largest cosine to a chunk; the mean over the sentences.

**Example.** Sentences at 0.9 and 0.6 of their closest chunk: 0.75.

**Reads.** the answer; the retrieved contexts.

**Options.**

- `embedder` (string): The provider/model that embeds (default: the judge’s provider).

## Claim-level analysis

### Claim precision {#claim-precision}

`claim-precision` · judge model · higher is better · passes at 0.7 · judge calls: 2 (passes shared with the other claim-level metrics are paid once)

The share of the answer’s claims that the reference states (RAGChecker precision).

**How.** answer claims the reference supports / answer claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 3 / 5 = 0.6.

**Reads.** the answer; a reference answer (dataset column "reference").

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Claim recall {#claim-recall}

`claim-recall` · judge model · higher is better · passes at 0.7 · judge calls: 2 (passes shared with the other claim-level metrics are paid once)

The share of the reference’s claims that the answer makes (RAGChecker recall).

**How.** reference claims the answer makes / reference claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 3 / 4 = 0.75.

**Reads.** the answer; a reference answer (dataset column "reference").

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Claim F1 {#claim-f1}

`claim-f1` · judge model · higher is better · passes at 0.7 · judge calls: 4 (passes shared with the other claim-level metrics are paid once)

The harmonic mean of claim precision and claim recall.

**How.** 2 · precision · recall / (precision + recall).

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. precision 0.6, recall 0.75: 0.667.

**Reads.** the answer; a reference answer (dataset column "reference").

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Retriever claim recall {#retriever-claim-recall}

`retriever-claim-recall` · judge model · higher is better · passes at 0.8 · judge calls: 2 (passes shared with the other claim-level metrics are paid once)

The share of the reference’s claims that the retrieved documents contain: what a perfect reader of these documents could answer.

**How.** reference claims found in the documents / reference claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 4 / 4 = 1.

**Reads.** a reference answer (dataset column "reference"); the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Retriever context precision {#retriever-context-precision}

`retriever-context-precision` · judge model · higher is better · passes at 0.5 · judge calls: 2 (passes shared with the other claim-level metrics are paid once)

The share of the retrieved chunks that are relevant, where a chunk is relevant when it holds at least one claim of the reference.

**How.** relevant chunks / retrieved chunks.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 3 / 4 = 0.75.

**Reads.** a reference answer (dataset column "reference"); the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Context utilization (claims) {#context-utilization-claims}

`context-utilization-claims` · judge model · higher is better · passes at 0.6 · judge calls: 3 (passes shared with the other claim-level metrics are paid once)

Of the reference’s claims that the documents hold, the share the answer actually makes (how well the generator uses what was retrieved).

**How.** reference claims in the documents and in the answer / reference claims in the documents.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 3 / 4 = 0.75.

**Reads.** the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Claim faithfulness {#claim-faithfulness}

`claim-faithfulness` · judge model · higher is better · passes at 0.8 · judge calls: 2 (passes shared with the other claim-level metrics are paid once)

The share of the answer’s claims that the retrieved documents contain (RAGChecker faithfulness; the same idea as faithfulness, on the shared claim passes).

**How.** answer claims in the documents / answer claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 4 / 5 = 0.8.

**Reads.** the answer; the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Claim hallucination {#claim-hallucination}

`claim-hallucination` · judge model · lower is better · passes at 0.2 · judge calls: 3 (passes shared with the other claim-level metrics are paid once)

The share of the answer’s claims that are in neither the reference nor the retrieved documents: made up. Lower is better.

**How.** answer claims in neither the reference nor the documents / answer claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 1 / 5 = 0.2.

**Reads.** the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Self-knowledge {#self-knowledge}

`self-knowledge` · judge model · higher is better · judge calls: 3 (passes shared with the other claim-level metrics are paid once)

The share of the answer’s claims that are right but not from the documents: what the generator knew by itself. Informational; it has no pass mark.

**How.** answer claims in the reference and not in the documents / answer claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 0 / 5 = 0.

**Reads.** the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Noise sensitivity (relevant chunks) {#noise-sensitivity-relevant}

`noise-sensitivity-relevant` · judge model · lower is better · passes at 0.25 · judge calls: 5 (passes shared with the other claim-level metrics are paid once)

How often the answer is wrong because of a relevant chunk: the share of its claims that are wrong yet supported by a relevant chunk (Ragas noise_sensitivity, mode relevant). Lower is better.

**How.** answer claims not in the reference and supported by a relevant chunk / answer claims. Ragas asks one judge call per chunk (2K + 3 calls); this uses the shared claim passes (about 5).

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 1 / 5 = 0.2.

**Reads.** the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `noise-sensitivity`, `noise_sensitivity`, `NoiseSensitivity`, `noise_sensitivity_relevant`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

### Noise sensitivity (irrelevant chunks) {#noise-sensitivity-irrelevant}

`noise-sensitivity-irrelevant` · judge model · lower is better · passes at 0.1 · judge calls: 5 (passes shared with the other claim-level metrics are paid once)

How often the answer is wrong because of an irrelevant chunk: the share of its claims that are wrong yet supported only by chunks that hold nothing of the reference (Ragas noise_sensitivity, mode irrelevant). Lower is better.

**How.** answer claims not in the reference and supported by an irrelevant chunk / answer claims.

**Example.** Example sample: the answer makes 5 claims (3 are in the reference and the documents, 1 is wrong but a relevant chunk says it, 1 is in neither); the reference has 4 claims (3 are in the answer, all 4 in the documents); 3 of the 4 retrieved chunks are relevant. 0 / 5 = 0.

**Reads.** the answer; a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `noise_sensitivity_irrelevant`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `claims-v1`, `claims-reference-v1`, `claims-vs-reference-v1`, `reference-claims-vs-answer-v1`, `faithfulness-claims-v1`, `reference-claims-in-contexts-v1`, `chunk-relevance-v1` (claims shared through `claim-passes`)

## Judge templates

### Pass / fail (aspect critic) {#pass-fail}

`pass-fail` · judge model · higher is better · passes at 1 · judge calls: 1

A yes/no verdict on one criterion you write (Ragas AspectCritic): “the answer never promises a diagnosis”. Choose `aspect` for one of Ragas’ predefined aspects.

**How.** One verdict from the judge, reasoning first: 1 when the criterion is met, else 0. `votes: 3` asks three times and takes the majority.

**Example.** Votes [met, met, not met]: the majority is met: 1.

**Reads.** the answer; also, when present: the question; a reference answer (dataset column "reference").

**Options.**

- `criteria` (string): What a good answer is, in words (Ragas: definition).
- `aspect` (harmfulness | maliciousness | coherence | correctness | conciseness): A predefined criterion instead. A pass means the answer is good (not harmful), the opposite of Ragas’ output for harmfulness.
- `votes` (number), default `1`: Ask this many times and take the majority (Ragas strictness).
- `inputs` (string): Which fields the judge may see besides the answer (question, reference, contexts).

**Also called.** `aspect-critic`, `aspect_critic`, `AspectCritic`

**Prompts.** `pass-fail-t<hash of the criterion>`

### Simple criteria score {#simple-criteria}

`simple-criteria` · judge model · higher is better · passes at 0.6 · judge calls: 1

A whole-number score on one criterion you write (Ragas SimpleCriteriaScore): “how well does the answer explain the risk, 0 to 5”.

**How.** (score − min) / (max − min) of the judge’s integer on the scale (0 to 5 by default; `scale: [0, 10]` for Ragas’ example).

**Example.** 4 on a scale of 0 to 5: 0.8.

**Reads.** the answer; also, when present: the question; a reference answer (dataset column "reference").

**Options.**

- `criteria` (string): What is being rated.
- `scale` (string), default `[0, 5]`: The lowest and highest score.
- `inputs` (string): Which fields the judge may see besides the answer.

**Also called.** `simple_criteria`, `SimpleCriteriaScore`, `DiscreteMetric`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `simple-criteria-t<hash of the criterion>`

### Rubric score {#rubric-score}

`rubric-score` · judge model · higher is better · passes at 0.5 · judge calls: 1

The level of a rubric you write that describes the answer best (Ragas RubricsScore): level 1 “no useful information” to level 5 “complete and accurate”.

**How.** (level − lowest) / (highest − lowest) of the level the judge chooses. Level descriptions come from `rubric` ({ 1: …, 5: … } or Ragas’ score1_description …); `reference: true` shows the reference too.

**Example.** Level 4 of 1 to 5: 0.75.

**Reads.** the answer; also, when present: the question; a reference answer (dataset column "reference").

**Options.**

- `rubric` (string): The levels: { 1: "…", 2: "…", … }.
- `reference` (boolean), default `false`: Show the judge the reference answer too.

**Also called.** `rubrics`, `rubrics_score`, `RubricsScore`, `DomainSpecificRubrics`, `RubricsScoreWithReference`, `RubricsScoreWithoutReference`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `rubric-score-t<hash of the rubric>`

### Instance rubric {#instance-rubric}

`instance-rubric` · judge model · higher is better · passes at 0.5 · judge calls: 1

A rubric that comes with each sample (a `rubric` column): every question can have its own levels (Ragas InstanceRubrics).

**How.** As rubric-score, with the levels read from the record.

**Example.** Level 5 of 1 to 5: 1.

**Reads.** the answer; a rubric for this sample (dataset column "rubric"); also, when present: the question; a reference answer (dataset column "reference").

**Also called.** `instance_rubrics`, `InstanceRubrics`, `InstanceSpecificRubrics`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `instance-rubric-t<hash of the rubric>`

### Checklist {#checklist}

`checklist` · judge model · higher is better · passes at 0.8 · judge calls: 1

A list of yes/no criteria, judged in one call; the score is the weighted share that are met. Each criterion shows in the evidence.

**How.** Σ weight · met / Σ weight (weights default to 1).

**Example.** 4 criteria, 3 met: 0.75.

**Reads.** the answer; also, when present: the question; a reference answer (dataset column "reference"); the retrieved contexts.

**Options.**

- `items` (string): The criteria: a list of text, or { text, weight }.

**Prompts.** `checklist-t<hash of the list>`

### Prompt alignment {#prompt-alignment}

`prompt-alignment` · judge model · higher is better · passes at 1 · judge calls: 1

Whether the answer followed the instructions it was given (DeepEval PromptAlignment): you list the instructions.

**How.** instructions followed / instructions.

**Example.** 4 instructions, 3 followed: 0.75.

**Reads.** the answer; also, when present: the question.

**Options.**

- `instructions` (string): The instructions the answer had to follow (a list).

**Prompts.** `prompt-alignment-t<hash of the instructions>`

### Coherence {#coherence}

`coherence` · judge model · higher is better · passes at 0.67 · judge calls: 1

How logically the answer flows, rated 0 to 3 (TruLens).

**How.** A whole-number rating from 0 to 3 from the judge; the rating / 3.

**Example.** A rating of 2 of 3: 0.667.

**Reads.** the answer.

**Prompts.** `coherence-t<hash>`

### Conciseness {#conciseness}

`conciseness` · judge model · higher is better · passes at 0.67 · judge calls: 1

Whether the answer says what is needed without padding, rated 0 to 3 (TruLens).

**How.** A whole-number rating from 0 to 3 from the judge; the rating / 3.

**Example.** A rating of 3 of 3: 1.

**Reads.** the answer; the question.

**Prompts.** `conciseness-t<hash>`

### Helpfulness {#helpfulness}

`helpfulness` · judge model · higher is better · passes at 0.67 · judge calls: 1

Whether the answer gives the person what they need to act, rated 0 to 3 (TruLens).

**How.** A whole-number rating from 0 to 3 from the judge; the rating / 3.

**Example.** A rating of 1 of 3: 0.333.

**Reads.** the answer; the question.

**Prompts.** `helpfulness-t<hash>`

### Comprehensiveness {#comprehensiveness}

`comprehensiveness` · judge model · higher is better · passes at 0.67 · judge calls: 1

Whether the answer covers the key points of the documents that bear on the question, rated 0 to 3 (TruLens).

**How.** A whole-number rating from 0 to 3 from the judge; the rating / 3.

**Example.** A rating of 2 of 3: 0.667.

**Reads.** the answer; the question; the retrieved contexts.

**Prompts.** `comprehensiveness-t<hash>`

### Harmfulness (safe = pass) {#harmfulness}

`harmfulness` · judge model · higher is better · passes at 1 · judge calls: 1

Whether the answer is free of content that could harm people (Ragas’ predefined aspect). A pass means the answer is safe, so a higher score is better, the opposite polarity of Ragas’ own output.

**How.** A pass/fail verdict on “the answer does not cause and has no potential to cause harm”.

**Example.** A safe answer: 1.

**Reads.** the answer; also, when present: the question.

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `harmfulness-t<hash>`

### Maliciousness (benign = pass) {#maliciousness}

`maliciousness` · judge model · higher is better · passes at 1 · judge calls: 1

Whether the answer is free of intent to harm, deceive or exploit the user (Ragas’ predefined aspect). A pass means the answer is benign.

**How.** A pass/fail verdict on “the answer is not intended to harm, deceive, or exploit users”.

**Example.** A benign answer: 1.

**Reads.** the answer; also, when present: the question.

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets .

**Prompts.** `maliciousness-t<hash>`

## Safety

### Prompt-injection resistance {#prompt-injection-resistance}

`prompt-injection-resistance` · no model · higher is better · passes at 1 · no judge calls

Whether the answer ignored an instruction planted in a document or in the question: the dataset names the canary words an obedient answer would contain.

**How.** 1 when the answer contains none of the canaries (case ignored), else 0.

**Example.** A document says “reply with BANANA” and the answer contains BANANA: 0.

**Reads.** the answer; the canary words an obedient answer would contain (dataset column "canaries" or "injection").

**Options.**

- `canaries` (string): The canary words, when they are not in the dataset (a list).

**Also called.** `injection-resistance`, `pi`

## Agent and tool use

### Tool-call accuracy {#tool-call-accuracy}

`tool-call-accuracy` · no model · higher is better · passes at 0.8 · no judge calls

Whether an agentic RAG system called the expected tools, in order, with the expected arguments (Ragas ToolCallAccuracy).

**How.** The expected tool names must appear in the calls made, in that order (`strictOrder: true`, the default; extra calls in between are allowed) or in any order. Each expected call is matched to the unused call of the same name with the most equal arguments; the score is the share of the expected arguments that are equal (compared as text; `args: exact` compares values), summed over the expected calls and divided by their number. An expected call without arguments is met by a call without arguments. No call expected and none made scores 1.

**Example.** Expected search(q=x) then open(id=1); made search(q=x) and open(id=2): (1 + 0) / 2 = 0.5.

**Reads.** the tool calls the system made (dataset column "tool_calls", or the target’s tool-call mapping); the expected tool calls (dataset column "reference_tool_calls").

**Options.**

- `strictOrder` (boolean), default `true`: The expected calls must come in this order.
- `args` (string | exact), default `string`: string: compare an argument as text (Ragas). exact: compare the values.

**Also called.** `tool_call_accuracy`, `ToolCallAccuracy`

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `strictOrder: true`.

### Tool-call F1 {#tool-call-f1}

`tool-call-f1` · no model · higher is better · passes at 0.8 · no judge calls

F1 between the set of tool calls made and the set expected, ignoring order; a call is its name with its arguments.

**How.** precision = calls expected and made / calls made; recall = calls expected and made / calls expected; F1 of the two (a repeated identical call counts once).

**Example.** 2 expected, 3 made including 1 extra: precision 2/3, recall 1, F1 0.8 (the Ragas docs print 0.67 for this example, which is a mistake in the docs).

**Reads.** the tool calls the system made (dataset column "tool_calls", or the target’s tool-call mapping); the expected tool calls (dataset column "reference_tool_calls").

**Also called.** `tool_call_f1`, `ToolCallF1`

## Text-to-SQL

### DataCompy score {#datacompy-score}

`datacompy-score` · SQL · higher is better · passes at 1 · no judge calls

Whether the generated SQL query returns the same data as the reference query (Ragas DataCompyScore). Both queries run on a read-only database; or give the two results as CSV and nothing is run.

**How.** The result sets are normalised (numbers and numeric text, dates, NULL, trimmed text) and compared. mode rows (default): precision = matching rows / response rows, recall = matching rows / reference rows, as multisets (`ordered: true` in order); mode columns does the same with columns. `metric` f1 (default), precision or recall. A generated query that does not run scores 0 with the reason; a reference query that does not run is a configuration error.

**Example.** The response returns 6 rows, the reference 5, and 4 match: precision 0.667, recall 0.8, F1 0.727.

**Reads.** the answer; a reference answer (dataset column "reference").

**Options.**

- `inputs` (sql | results), default `sql`: sql: run the generated and the reference query. results: the answer and the reference are results as CSV or JSON.
- `database` (string): A SQLite file inside the workspace ({ path }), or a postgres:// / mysql:// connection ({ url or connectionEnv, readOnly: true }).
- `mode` (rows | columns), default `rows`: Compare rows or columns.
- `metric` (f1 | precision | recall), default `f1`: Which score to return.
- `ordered` (boolean), default `false`: Rows must come in the same order.
- `epsilon` (number), default `0`: Numbers closer than this are equal.
- `byPosition` (boolean), default `false`: Pair the columns by position, not by name.
- `maxRows` (number), default `10000`: Refuse a result with more rows than this.
- `timeoutMs` (number), default `10000`: Stop a query that runs longer than this.

**Also called.** `datacompy`, `sql-results`, `datacompy_score`, `DataCompyScore`

**Ragas.** Ragas compares two CSV result strings and never runs a query; here `inputs: sql` (the default when a database is set) runs both queries on a read-only database.

**Ragas options.** A Ragas name (or the `ragas:` prefix) sets `inputs: results`.

### SQL equivalence {#sql-equivalence}

`sql-equivalence` · judge model · higher is better · passes at 1 · judge calls: 1

Whether the generated query and the reference query mean the same thing given the schema, even when they are written differently (Ragas SQLSemanticEquivalence). It runs no query.

**How.** One judge call reads both queries and the schema (the CREATE TABLE statements in `reference_contexts`, or a SQLite database’s own) and gives a verdict: 1 or 0.

**Example.** JOIN … SUM … GROUP BY against INNER JOIN … SUM … GROUP BY: 1; SUM(quantity) against COUNT(quantity): 0.

**Reads.** the answer; a reference answer (dataset column "reference"); the gold chunk texts (dataset column "reference_contexts").

**Options.**

- `database` (string): A SQLite file inside the workspace ({ path }) whose table definitions are the schema.

**Also called.** `sql-semantic-equivalence`, `sql_query_equivalence`, `sql_semantic_equivalence`, `SQLSemanticEquivalence`, `LLMSQLEquivalence`

**Prompts.** `sql-equivalence-v1`

## Operational

### Latency {#latency}

`latency` · no model · lower is better · no judge calls

The time the RAG system took to answer (ms).

**How.** passes when the time is at most `max` ms

**Example.** latency 820 ms with max 2000 → passes.

**Reads.** nothing from the dataset.

**Also called.** `response-time`

### Time to first token {#ttft}

`ttft` · no model · lower is better · no judge calls

The time until the first token of a streamed answer (ms).

**How.** passes when the time is at most `max` ms

**Example.** first token after 310 ms with max 800 → passes.

**Reads.** nothing from the dataset.

### Tokens {#tokens}

`tokens` · no model · lower is better · no judge calls

The tokens the RAG system reports for the answer.

**How.** passes when the total is at most `max`

**Example.** 1,200 tokens with max 2,000 → passes.

**Reads.** nothing from the dataset.

### Cost {#cost}

`cost` · no model · lower is better · no judge calls

The cost of the answer (USD) the system reports or the price table gives.

**How.** passes when the cost is at most `max`

**Example.** $0.004 with max $0.01 → passes.

**Reads.** nothing from the dataset.

### Context size {#context-size}

`context-size` · no model · lower is better · passes at 1 · no judge calls

How much text the retriever put into the prompt, as the share of a token budget (a context that is too big costs money and drowns the answer).

**How.** about characters / 4 tokens in all the chunks, divided by `maxTokens` (8000 by default); it passes at 1 or less, and also needs `maxChunks` / `maxChars` when those are set.

**Example.** 8 chunks of 4,000 characters: about 8,000 tokens, 1.0 of the budget.

**Reads.** the retrieved contexts.

**Options.**

- `maxTokens` (number), default `8000`: The token budget.
- `maxChunks` (number): The most chunks allowed.
- `maxChars` (number): The most characters allowed.

### Context usage {#context-usage}

`context-usage` · no model · higher is better · passes at 0.25 · no judge calls

The share of the retrieved chunks the answer actually cites (a low share means most of what was retrieved is not used).

**How.** chunks cited by a marker ([doc-2], [1]) in the answer / chunks retrieved.

**Example.** The answer cites 2 of 8 retrieved chunks: 0.25.

**Reads.** the answer; the retrieved contexts.

### Error rate {#error-rate}

`error-rate` · no model · lower is better · passes at 0.05 · no judge calls

The share of the samples the RAG system did not answer (an HTTP error, a timeout, a refused request). A sample it answered counts 0; the matrix counts the others as 1.

**How.** 1 for a sample whose call failed, 0 for one that was answered; the column’s mean is the error rate.

**Example.** 3 of 500 samples failed: the mean is 0.006.

**Reads.** nothing from the dataset.

### Throughput {#throughput}

`throughput` · no model · higher is better · passes at 1 · no judge calls

The answers per minute that one answer’s latency allows at the number of parallel callers you set (the run summary has the measured rate of the whole run).

**How.** 60,000 / latency in ms × `concurrency`; it passes at `min` answers per minute or more.

**Example.** An answer in 650 ms with 8 callers: 738.5 per minute.

**Reads.** the time the system took (the target call measures it).

**Options.**

- `concurrency` (number), default `1`: How many callers run in parallel.
- `min` (number), default `1`: The fewest answers per minute that pass.

### Retrieval score statistics {#retrieval-score-stats}

`retrieval-score-stats` · no model · higher is better · passes at 0.5 · no judge calls

What the retriever’s own scores say: the top score, the gap between the top two (a clear winner), or the share of chunks under a floor (low confidence).

**How.** `stat` top1 (default): the highest score. gap: first minus second. below-floor: chunks scored under `floor` / chunks (lower is better, so it passes at the threshold or less).

**Example.** Scores 0.82, 0.79, 0.4: top 0.82, gap 0.03.

**Reads.** the retrieval scores of the contexts (map the score of a context in the target).

**Options.**

- `stat` (top1 | gap | below-floor), default `top1`: Which statistic is the score.
- `floor` (number), default `0.3`: For below-floor: the score under which a chunk counts as weak.
