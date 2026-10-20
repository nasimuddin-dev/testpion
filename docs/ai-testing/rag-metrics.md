# RAG metrics

<!-- Generated from the metric registry by `node scripts/gen-rag-metrics-doc.mjs`. Do not edit by hand. -->

TestPion has 30 RAG metrics. Each one can be chosen in an evaluation, tried on one sample first, gated in CI (`--min faithfulness=0.8`) and read in the samples × metrics matrix. A metric that needs a model says so, and no judged metric ever runs without a judge you chose. [Testing a RAG system](./rag.md) shows how to use them.

| Metric | Kind | Higher is better | Reads | Judge calls |
|---|---|---|---|---|
| [`faithfulness`](#faithfulness) | judge model | yes | answer, contexts | 1 (2 when it shares the claim pass with answer-relevance) |
| [`answer-relevance`](#answer-relevance) | judge model | yes | question, answer | 1 (2 when it shares the claim pass with faithfulness); reverse-questions 1 + embeddings |
| [`context-relevance`](#context-relevance) | judge model | yes | question, contexts | nvidia 2; the other modes 1 |
| [`context-precision`](#context-precision) | judge model | yes | question, contexts | 1 with a judge |
| [`context-recall`](#context-recall) | judge model | yes | question, reference, contexts | 1 with a judge |
| [`context-entity-recall`](#context-entity-recall) | no model | yes | reference, contexts | 0 |
| [`factual-correctness`](#factual-correctness) | judge model | yes | answer, reference | 2 with a judge (1 for precision) |
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

`context-precision` · judge model · higher is better · passes at 0.5 · judge calls: 1 with a judge

Whether the useful chunks are ranked first (rank-weighted average precision over the retrieved chunks).

**How.** A verdict per chunk (useful for the question / the reference); average precision = Σ precision@k · relevant(k) / relevant chunks. Without a judge the check scores word coverage instead.

**Example.** Verdicts [useful, not, useful]: (1/1 + 2/3) / 2 = 0.833.

**Reads.** the question; the retrieved contexts; also, when present: a reference answer (dataset column "reference").

**Also called.** `contextual-precision`, `context_precision`, `ContextPrecision`, `LLMContextPrecisionWithReference`, `llm_context_precision_with_reference`

**Ragas.** Ragas asks one judge call per chunk; this asks once for all chunks.

### Context recall {#context-recall}

`context-recall` · judge model · higher is better · passes at 0.8 · judge calls: 1 with a judge

Whether the retrieved documents contain what the reference answer says (each statement of the reference is looked for in them).

**How.** reference statements found in the documents / reference statements. Without a judge the check scores sentence coverage.

**Example.** The reference has 4 statements and the documents hold 3 of them: 0.75.

**Reads.** the question; a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `contextual-recall`, `context_recall`, `ContextRecall`, `LLMContextRecall`, `llm_context_recall`

### Context entity recall {#context-entity-recall}

`context-entity-recall` · no model · higher is better · passes at 0.8 · no judge calls

The share of the reference’s entities (names, numbers with units) that appear in the retrieved text.

**How.** entities of the reference found in the contexts / entities of the reference (found by pattern, no model; case ignored). A reference with no entities is n/a.

**Example.** Reference entities {Paris, 1889, Eiffel}; the contexts have Paris and Eiffel: 0.667.

**Reads.** a reference answer (dataset column "reference"); the retrieved contexts.

**Also called.** `context_entities_recall`, `context_entity_recall`, `ContextEntityRecall`

**Ragas.** Ragas extracts the entities with a model and matches case-sensitively.

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

`factual-correctness` · judge model · higher is better · passes at 0.7 · judge calls: 2 with a judge (1 for precision)

How the answer’s facts agree with the reference answer’s: precision (the answer’s claims the reference supports), recall (the reference’s claims the answer makes) and their F1.

**How.** mode f1 (default): the harmonic mean of claim precision and claim recall. Without a judge the check compares sentence coverage.

**Example.** Precision 3/4 and recall 3/5: F1 = 0.667.

**Reads.** the answer; a reference answer (dataset column "reference"); also, when present: the question.

**Options.**

- `mode` (f1 | precision | recall), default `f1`: Which of the three scores to return.

**Also called.** `answer-correctness`, `factual_correctness`, `FactualCorrectness`

**Ragas.** Ragas rounds to 2 decimals.

### Citation validity {#citation}

`citation` · no model · higher is better · passes at 1 · no judge calls

The share of the answer’s citation markers ([doc-2], [1]) that refer to a document that was retrieved.

**How.** valid citations / citations. It does not check that the cited document supports the claim (faithfulness does).

**Example.** The answer cites [1] and [7] and 3 documents were retrieved: 1 / 2 = 0.5.

**Reads.** the answer; the retrieved contexts.

**Also called.** `citations`

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
