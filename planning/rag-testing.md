# RAG testing and the RAG evaluation matrix

Owner request (AI Lab, 2026-10-16): *"Add RAG testing functionality including the RAG evaluation matrix. The user adds an
endpoint (HTTP, WebSocket or other) which connects to a RAG system; with input data the test calls the RAG, gets the
answer, compares it with the expected one, and evaluates metrics like recall, context precision and so on. Take all
metrics from Ragas, DeepEval and NVIDIA. Research and make a plan."*

Owner clarifications (same day):
1. *"All types of metrics for the RAG. The user can test it."* The whole catalogue (Ragas, DeepEval, NVIDIA, TruLens,
   RAGChecker, promptfoo, classic IR, and more) ships in the product. Every metric can be selected and run, and each one
   can be tried on one sample. The catalogue is not trimmed to an MVP set.
2. *"The user can also define custom metrics, which also evaluate."* Custom metrics are a first-class part of the metric
   engine: kept as files, reviewable, runnable, and usable anywhere a built-in metric is.

Status: **R1a is built** (backlog B-30; what is left of R1 is B-30b): targets over HTTP, SSE, WebSocket, gRPC and MCP with click-to-map, the `rag-target` item kind, datasets with Ragas / DeepEval import and export, the `rag-judge` judge service (content-hash cache, ledger, caps, no silent judge), `normalized-match`, `token-f1`, `rouge`, `context-recall-ids`, `context-precision-ids`, `rag-faithfulness` and `rag-answer-relevance`, `testpion rag targets|probe|import|export`, four MCP tools. Everything else below is still a plan. Written against the tree after v0.48.1 (with the uncommitted triage work). Sizes and
item ids follow `planning/README.md` (S ≤ 1 day, M 2–4 days, L 1–2 weeks). The ground rules apply: AI-first (CLI
`--json`, an MCP tool, `llms.txt`, docs), cloud-ready (UI only via RPC, host-agnostic engine), uniform UI, and the local
app stays free.

> **Citations.** DeepEval, TruLens, RAGChecker, ARES, Phoenix, LangSmith, Braintrust, promptfoo, IR and judge-reliability
> facts come from the docs and papers fetched on 2026-10-16 (URLs in §2.1). Ragas and NVIDIA details come from their
> official pages as cited. Where a detail is uncertain or version-sensitive, it is marked *(verify)*. Before each metric
> is built, the R1/R2 item "metric spec freeze" re-reads the cited page and turns its worked example into a golden test.

---

## 0. Summary

* **What exists.** TestPion already has a solid RAG scoring core:
  * judged claim by claim: `context-precision`, `context-recall`, `groundedness`/`faithfulness`, and `answer-correctness`
    (precision, recall and F1);
  * deterministic: `context-entity-recall` and `citation`;
  * embedding `semantic-similarity` and `llm-judge`.

  Around it there is an evaluation matrix with baselines, saved evaluations, datasets from files and databases, human
  review, and the AI foundations: structured output with repair, redaction, the usage ledger, caps, proposals and
  verifiers (§1).
* **What is missing** is the thing the owner asked for: **testing a RAG system that runs somewhere else.**
  * A `rag` test either reads contexts typed into the file or has TestPion's own model answer
    (`runner/execute.ts:724-770`).
  * An HTTP, WebSocket, gRPC or MCP step cannot pass its answer and retrieved chunks to the metrics.
  * Judge calls are not costed, cached or capped.
  * The matrix shows one mean score per cell, not samples × metrics.
  * There are no user-defined metrics beyond a free-text `llm-judge`.
* **The plan:**
  1. A **RAG target**: any protocol step plus a click-to-map response mapping (answer, contexts, citations, usage),
     including streams and multi-turn sessions.
  2. A **metric registry** in `packages/core/src/eval/rag/` holding the **full catalogue: 133 metrics in 13 types** (§2.3), plus custom metrics. It covers every item of Ragas' *available metrics* list (29 metrics), each reachable by its exact Ragas name (§2.6).
  3. A **judge service**: routing, structured output, a content-hash cache, the ledger, caps, and a cost estimate before
     any run.
  4. **"Try on one sample"** for every metric, which shows the exact prompt that will be sent.
  5. A **metric picker** grouped by type, with search, 12 presets and a live cost estimate.
  6. **Custom metrics** as `metrics/*.yaml` files in the workspace. There are 7 kinds, all registered in the same
     registry (§4d).
  7. A **samples × metrics matrix**, grouped by type, with a threshold per metric and per-metric drill-down.
  8. **CLI, MCP, CI and monitors.**
* **Roadmap.** The whole catalogue ships within 3 releases. R1 covers connect, datasets, every non-LLM family, the RAG
  triad, judge infrastructure and custom judge/rule/formula metrics. R2 adds the LLM-judge retrieval, generation,
  claim-level and judge-template families, plus the checklist and scripted custom kinds. R3 adds conversational, agent,
  safety and DAG. R4 adds test-set generation, calibration and monitoring polish.

---

## 1. What exists (code map)

### 1.1 Test types and execution

| What | Where | Notes for RAG |
|---|---|---|
| Test types incl. `rag`, `agent` | `packages/core/src/model/types.ts:275` | `types.ts` is 878 lines, ceiling **900** (`tests/unit/architecture.test.ts:93`): new RAG types must go in their own module. |
| `RetrievedDoc { id, text, score?, source? }` | `types.ts:415-420` | Good base; needs `rank`, `metadata`, `title/url`. |
| `RagTest { question, contexts, expected?, answer?, model?, prompt? }` | `types.ts:422-431` | Contexts are **static**; the system under test is not called. |
| `AgentTest` (model + mock tools / MCP servers) | `types.ts:441-450`, `execute.ts:779-849` | TestPion's own agent loop, not an external agent. |
| Loader for `rag` (accepts `contexts`/`retrieved`/`documents`, strings or objects) | `runner/loader.ts:279-292` | A `{{variable}}` cannot fill `contexts` (it maps over an array at load time). |
| Dataset expansion for `rag` (question/query/input, contexts, answer, expected, tags) | `runner/loader.ts:428-460` | Record fields become variables; `tags` feed the matrix. |
| `runRag` (default prompt with `[id]` citations; retrieval span; `metadata.rag` with query, ids, scores, promptHash) | `runner/execute.ts:717-770` | The "generate with our model" path; keep as *offline/self-hosted RAG simulation*. |
| Implicit RAG checks when none given (`context-precision`, `groundedness`, `answer-relevance`, `citation`, `context-recall` with expected) | `execute.ts:321-324` | Become the MVP default metric set. |
| `executeTest` pipeline: pre-script → protocol call → test script → checks → `extract` | `execute.ts:134-298` | The mapping step slots in between the call and the checks. |
| Pinned responses (a stored response stands in for the call) | `execute.ts:332-341`, `runner/runner.ts:165` | Basis for **offline re-scoring** of recorded RAG answers. |
| Runner concurrency (Semaphore, default 4) | `runner/runner.ts:149-158` | Per-run; the judge needs its own limiter (below). |
| Test key docs for the editor/lint/AI (`rag` keys) | `runner/test-schema.ts:140-150` | Extend with `target`, `mapping`, `metrics`. |

### 1.2 Checks (the current metric implementations) — `packages/core/src/eval/checks.ts`

| Check | Lines | How it is computed today |
|---|---|---|
| `similarity` / `semantic-similarity` | 519-547 | `method: lexical` (bag-of-words cosine, `eval/text.ts:25`), `f1` (SQuAD token F1, `text.ts:36`), `embedding` (provider `embed()`, cosine). Threshold 0.5 / 0.8. |
| `llm-judge` | 551-615, 729-738 | One prompt (`judge-v1`), JSON `{score 0..1, reasoning}`, temperature 0, `responseFormat: json`; a 1–10 score is divided by 10. Reference answer included when present. Judge identity + config hash stored (`askJudge` 567-597). **No usage/cost recorded**, no cache, no schema repair. |
| `judgeItems` / `judgedItemsCheck` | 632-727 | Claim-by-claim: one judge call returns `items[{text, ok, evidence}]`; score computed locally; items + labels kept in `metadata.items` (shown by `components/Results.tsx:198-215` `EvidenceList`). |
| `context-precision` | 746-781 | Judge: verdict per document in rank order → rank-aware **average precision** (`averagePrecision` 671-681, = Ragas formula). Heuristic: word coverage. |
| `context-recall` | 783-807 | Judge: reference split into statements, each found in context or not (= Ragas LLMContextRecall). Heuristic: sentence coverage ≥ 0.6. |
| `context-entity-recall` | 810-836 | **Deterministic** regex entities (capitalised names, numbers with units) or a given `entities:` list; substring match. Ragas uses an LLM to extract entities. |
| `groundedness` = `faithfulness` = `hallucination` | 838-870 | Judge: answer → atomic claims → supported by context (score = supported share; `hallucinationIndicator` = 1 − score; no claims → 1). Heuristic: sentence coverage. Note DeepEval's *hallucination* is a different metric (§2). |
| `answer-relevance` | 872-887 | Judge: one 0–1 score; heuristic: question coverage + token F1. Not the Ragas algorithm (reverse-generated questions + embeddings). |
| `answer-correctness` | 894-962 | Claims both ways (precision, recall, F1; `mode`) = Ragas **FactualCorrectness**; not Ragas AnswerCorrectness (which adds 0.25 × semantic similarity). |
| `citation` | 964-978 | Deterministic: `[id]` / `[n]` markers refer to retrieved docs. Does not check that the cited doc supports the claim. |
| Agent: `tool-called`, `tool-not-called`, `allowed-tools`, `max-tool-calls`, `tool-sequence`, `tool-args-valid` | 430-473 | Deterministic. |
| Safety: `no-leak`, `refusal`, `not-refusal` | 477-515 | Regex heuristics. |
| Operational: `latency`, `first-token`/`ttft`, `tokens`, `cost` | 372-382 | Apply unchanged to RAG targets. |
| Registry / aliases / docs | 52-91 | `registerCheck(type, fn, doc)`; aliases share the function; `checkDocs()` feeds AI format reference + lint. |

`eval/text.ts` holds tokenisation, sentences, lexical cosine, token F1, coverage, `cosine()`. No BLEU/ROUGE/chrF/edit
distance yet.

### 1.3 Evaluations, matrix, review

| What | Where |
|---|---|
| Evaluations view (dataset × prompt × model × evaluators; tabs; runs/matrix pane) | `apps/desktop/src/views/EvaluationsView.tsx` (477 lines), draft type 27-43 (`type: 'llm' \| 'rag'`) |
| Saved evaluations (`library/evaluations.json`), template expansion, temp dataset file | `packages/core/src/runner/saved-evaluations.ts:15-101` |
| Matrix engine: rows = cases, columns = variants (run or run × model), cells status + **mean score of all scored checks** (`resultScore`, `eval/matrix.ts:48`), baseline compare (`compareEvalCell` 32-46), typed arrays, paging, limits 40 columns × 200k cases (488) | `packages/core/src/eval/matrix.ts` |
| Matrix over runs, compare report, result lookup | `packages/core/src/runner/eval-matrix-runs.ts` (`openEvalMatrix` 90, `compareEvalRuns` 181) |
| Matrix UI (virtualised rows, cell tone by change, CellDetail with baseline) | `apps/desktop/src/components/EvalMatrix.tsx:36-183` |
| Run panel (live progress, paged results, weakest scored check, summary scores, review counts) | `apps/desktop/src/components/RunPanel.tsx:43-70, 225` |
| Score trend across runs | `packages/core/src/runner/score-trend.ts:17` |
| Human review (good/bad + note per result) in `runs/<id>/reviews.json` | `types.ts:507-521`, `runner/run-results.ts:30-31`; MCP `run_reviews`, `review_result` (`mcp-server/testpion-mcp.ts:1118-1133`) |
| CLI `testpion eval list|run|compare|matrix` (compare exits 1 on regressions; `--threshold`, `--max-regressions`, `--fail-on-missing`, `--json`) | `packages/cli/src/commands/evaluations.ts:21-35`, `eval-compare.ts:32-90` |
| MCP `list_evaluations`, `run_evaluation`, `eval_matrix`, `eval_compare` (BIG_TOOLS, paged) | `mcp-server/eval-agent-tools.ts:18,63`, `tool-contract.ts:24-90` |
| `RunSummary.scores` (mean per check type) | `types.ts:550-551` |
| Docs | `docs/ai-testing/rag.md`, `evaluations.md` |

### 1.4 Datasets

`runner/datasets.ts:14-40` `DatasetSource`: JSONL/NDJSON/JSON/CSV/Markdown/SQLite files, Postgres/MySQL (`db-datasets.ts`),
remote URL with `recordsPath`, inline records, `limit/offset`; streamed (JSONL/CSV line by line). Workspace `datasets/`
listing, preview, columns, `appendDatasetRow` (`datasets.ts:270-429`). Schema-based generation without an LLM
(`runner/generate-dataset.ts`). No Ragas/DeepEval/promptfoo importers; no notion of reference contexts or doc ids.

### 1.5 Protocols a target can use

`packages/core/src/protocols/`: HTTP (`http/client.ts`, **SSE parsing** with `SseParser`, up to 10k events, 480-500),
GraphQL (+ subscriptions), gRPC (+ reflection, streaming), WebSocket, Socket.IO, MQTT, Kafka (`websocket` test `mode`,
`types.ts:359-381`; body `{connected, received[], messages[]}`, `execute.ts:554-567`), MCP client
(`mcp/client.ts`, tool call with `isError`), adapter registry (`protocols/registry.ts:13-50`). Every one is already a
test step with `extract` (JSONPath via `jsonpath-plus`, `util/jsonpath.ts`; `$status`, `$text`), environments,
secrets (`{{$secret…}}`), auth, retries, timeouts, production guard. **No JMESPath.**

### 1.6 AI foundations to reuse

| Building block | Where | Use in RAG testing |
|---|---|---|
| Provider registry with rate limit, concurrency (Semaphore 64), retry/backoff | `ai/index.ts:21-60, 117-153` | Judge and embedding calls. |
| Embeddings: OpenAI-compatible, Gemini, Bedrock, mock (deterministic 64-dim hashed BoW) | `ai/providers/*.ts` `embed()`; `ProviderConfig.embeddingModel` `types.ts:211` | Semantic similarity, response relevancy, dedupe in generation. |
| Structured output + repair loop (`chatStructured`, schema modes per provider, `extractJson`) | `ai/structured.ts:1-236` | Every judge prompt gets a JSON Schema and repair. |
| AI settings: model routing small/large tier, env overrides, **local only**, privacy level, PII masking, caps per call/day/USD | `ai/ai-settings.ts:11-142` | Judge model routing + caps. |
| Usage ledger (per call: surface, task, model, tokens, cost, outcome) + `checkAiCaps` | `storage/ai-usage.ts:1-94` | Judge spend must be recorded here (today it is not). |
| Context builder (redaction, privacy level, per-section budgets) | `ai/context.ts:1-25` | Test-set generation from documents; failure clustering. |
| Task registry + runner (route → context → estimate → dry run → call → verify → proposal → ledger) | `ai/tasks/registry.ts`, `ai/tasks/run.ts:1-60, 187-249` | `rag-generate-dataset`, `rag-explain-sample`, `rag-cluster-failures` tasks. |
| Proposals + review UI, verifiers | `ai/proposal.ts`, `ai/verify.ts`, `components/ai/ProposalReview.tsx` | Generated questions are a proposal, verified (answerable from the source chunk) before they reach a dataset. |
| Triage (failed-run analysis, findings) | `ai/triage.ts`, `components/ai/AiAnalysisDialog.tsx`, `Findings.tsx` (uncommitted) | Failure clustering of low-scoring samples. |
| AI Lab view (Providers, Playground, Model comparison, Usage) | `apps/desktop/src/views/AiLabView.tsx:12-60`, `views/ai/*` | New tab **RAG** lives here (linking to Evaluations, §4f). |
| Monitors (collection or test file on a schedule, webhook, p95, cert) | `runner/monitors.ts:23-95` | A RAG evaluation as a monitor target with score thresholds. |
| Architecture rules + size ceilings | `tests/unit/architecture.test.ts` | backend.ts 1380/1450, testpion-mcp.ts 1484/1500: new handlers/tools in own modules. |

### 1.7 Gaps for RAG testing

1. **No capture of the RAG's retrieved contexts from a live response.** Needs a response mapping (answer, contexts
   with id/text/score/metadata, citations, usage) for every protocol, incl. SSE/WebSocket streams assembled into one answer.
2. **Contexts cannot come from variables/earlier steps** (loader maps arrays at load time; `contexts: "{{x}}"` fails).
3. **No multi-turn.** One question per test; no conversation state (`conversation_id`, history echo, cookie/session).
4. **Judge plumbing.** Judge chosen per check (`cfg.judge` or `provider`/`model`, default `mock`, `checks.ts:570`);
   no routing to the AI settings' tier, no "local only" enforcement for judges, **no token/cost accounting**
   (`askJudge` drops `r.usage`), no cache, no caps, no estimate before a run, no JSON-schema repair (falls back to a
   regex for `score`).
5. **Matrix shows one number per cell** (mean of all scored checks): no metric columns, no per-metric aggregates,
   distributions, tag breakdowns or confidence intervals.
6. **Missing metrics**: ID/IR-based retrieval metrics, context relevance (statement-level), noise sensitivity,
   Ragas-style response relevancy, answer accuracy (NVIDIA), response groundedness (NVIDIA), lexical (BLEU/ROUGE/chrF/
   edit distance), aspect critic / rubrics / G-Eval steps, DAG, citation accuracy, negative rejection, bias/toxicity,
   conversational and agent-goal metrics (§2).
7. **Determinism and noise** are not measured: no repeat-N, no variance/CI, no judge self-consistency.
8. **No calibration** of judges against the stored human reviews (planned as AI-11, `planning/ai-features.md:352`).
9. **No test-set generation from documents**, no importers for Ragas/DeepEval/promptfoo datasets.
10. **Speed**: judge calls are sequential per test (`runChecks` loops, `checks.ts:983-998`); a 5,000 × 10 run with
    claim decomposition is ~50k–100k judge calls → must be parallel, cached, rate-limited and estimated.

---

## 2. Research: the full metric catalogue

### 2.1 Sources

**Ragas**
* Getting started: https://docs.ragas.io/en/stable/getstarted/
* Metric catalogue: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/ . Each metric has its own page
  under it, e.g. `…/context_precision/`, `…/context_recall/`, `…/context_entities_recall/`, `…/noise_sensitivity/`,
  `…/answer_relevance/`, `…/faithfulness/`, `…/aspect_critic/`, `…/rubrics_based/`, `…/general_purpose/`,
  `…/factual_correctness/`, `…/semantic_similarity/`, `…/answer_correctness/`, `…/traditional/`, `…/agents/`,
  `…/sql/`, `…/summarization_score/`, `…/nvidia_metrics/`.
* Samples: https://docs.ragas.io/en/stable/concepts/components/eval_sample/
* Test-set generation: https://docs.ragas.io/en/stable/concepts/test_data_generation/rag/ and
  https://docs.ragas.io/en/stable/references/synthesizers/
* Paper: arXiv 2309.15217.
* Source code (the docs leave out call counts and edge cases):
  https://github.com/vibrantlabsai/ragas/tree/main/src/ragas/metrics/collections
  * The legacy `ragas.metrics.*` API is deprecated in 0.4 and removed in 1.0.
  * Answer Correctness and Quoted Spans exist in the source but are not in the docs catalogue.
  * Edge cases differ:
    * Faithfulness, ContextRecall and TopicAdherence can return NaN.
    * AnswerRelevancy can be negative, because nothing clamps the cosine.
    * ToolCallAccuracy and QuotedSpans return 1 on empty input.
    * The ToolCallF1 docs example is wrong: it should be 0.8.
  * The cache is exact-match on prompt, model parameters and response model (`DiskCacheBackend`).
  * RunConfig defaults: timeout 180 s, 10 retries, 16 workers, seed 42.
* Multimodal (read 2026-10-17):
  https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/multi_modal_faithfulness/ and
  https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/multi_modal_relevance/
  * Contexts may be text, image URLs, local image files or base64 data URIs.
  * A vision-capable judge is required (the docs name gpt-4o, claude-3-opus, gemini-pro-vision).
  * Both scores are binary 0/1, although the pages also say "scaled to (0,1)".
  * The prompt text and the number of calls are not documented.
* SQL (read 2026-10-17): https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/sql/
  * `DataCompyScore` compares two CSV result strings with DataCompy: `mode` row (default) or column, `metric` F1
    (default) / precision / recall, precision = matching rows / response rows, recall = matching rows / reference rows.
    It makes no LLM calls; Ragas itself does not run the queries.
  * `SQLSemanticEquivalence` (legacy `LLMSQLEquivalence`) judges equivalence of two SQL queries given the schema in
    `reference_contexts`. It is binary, and its reason explains both queries.

**DeepEval** (fetched 2026-10-16)
* Overview: https://deepeval.com/docs/metrics-introduction
* Metric pages: `https://deepeval.com/docs/metrics-<name>` (answer-relevancy, faithfulness, contextual-precision /
  -recall / -relevancy, ragas, hallucination, summarization, json-correctness, prompt-alignment, llm-evals (G-Eval),
  dag, arena-g-eval, tool-correctness, argument-correctness, task-completion, step-efficiency, plan-adherence,
  plan-quality, mcp-use, mcp-task-completion, knowledge-retention, role-adherence, conversation-completeness,
  turn-relevancy, turn-faithfulness, conversational-g-eval, bias, toxicity, pii-leakage, misuse, non-advice,
  role-violation).
* Test cases: https://deepeval.com/docs/evaluation-test-cases and https://deepeval.com/docs/evaluation-multiturn-test-cases
* Datasets: https://deepeval.com/docs/evaluation-datasets
* Synthesizer: https://deepeval.com/docs/golden-synthesizer and https://deepeval.com/docs/synthesizer-generate-from-docs
* Flags and caching: https://deepeval.com/docs/evaluation-flags-and-configs
* CI: https://deepeval.com/docs/evaluation-unit-testing-in-ci-cd
* What changed recently (found in the current docs):
  * Every metric has an `eval_mode`: `llm`, `hybrid` or `system_one`. The `system_one` mode uses a small "Jev" model, and
    its scores are not comparable with `llm` mode.
  * `threshold=None` gives a score-only metric.
  * A `flaky` flag means a metric's failure does not decide the test.

**NVIDIA**
* The NVIDIA metrics in Ragas: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/nvidia_metrics/
  * Answer Accuracy: two judges rate 0/2/4, the second with response and reference swapped; each rating is divided
    by 4 and the two are averaged.
  * Context Relevance and Response Groundedness: two judges rate 0/1/2; each rating is divided by 2 and the two are
    averaged.
  * If one judge's rating is invalid, the other is used; up to 5 retries.
* The NeMo Microservices Evaluator is archived and slated to sunset on 2026-10-01:
  https://archive.docs.nvidia.com/nemo/microservices/latest/evaluator/metrics/retriever.html
  * Retriever metrics via pytrec_eval: P@k, R-precision, recall@k, nDCG / nDCG@k, MAP / MAP@k, reciprocal rank,
    success@k, bpref and more, for k ∈ {5, 10, 20, 100}.
  * RAG type, BEIR or ragas task: recall_5/10, ndcg_cut_5/10, plus Ragas faithfulness, answer_relevancy,
    answer_correctness, answer_similarity, context_precision and context_recall.
    https://archive.docs.nvidia.com/nemo/microservices/25.7.0/evaluate/evaluation-types/rag.html
* Its successor is NeMo Platform "Helix Evals": https://docs.nvidia.com/nemo-platform/documentation/evaluate-models
  * RAG metrics (Ragas-based; ResponseRelevancy `strictness` defaults to **1** on NIM).
  * Retrieval metrics (nDCG, recall, precision and MAP at k = 1, 5, 10, 100).
  * `LLMJudgeMetric` with range and rubric scores.
  * Agentic metrics: tool-call accuracy, tool calling, topic adherence, goal accuracy, answer accuracy.
  * Similarity metrics: BLEU, exact match, F1, ROUGE, number check, string check.
  * …/metrics/rag-metrics, …/metrics/llm-as-a-judge, …/metrics/agentic-metrics, …/metrics/similarity-metrics
* NVIDIA RAG Blueprint evaluation (nv_accuracy, nv_context_relevance, nv_response_groundedness, recall@1/3/5/10):
  https://docs.nvidia.com/rag/2.6.0/evaluate.html
* Nemotron reward models:
  * Nemotron-4-340B-Reward: 5 HelpSteer2 attributes, 0–4. https://huggingface.co/nvidia/Nemotron-4-340B-Reward
  * Llama-3.1-Nemotron-70B-Reward: one scalar, comparable only within a prompt.
    https://huggingface.co/nvidia/Llama-3.1-Nemotron-70B-Reward-HF
  * GenRM models: helpfulness 1–5 plus a pairwise ranking, and principle-based yes/no.
    https://huggingface.co/nvidia/Llama-3_3-Nemotron-Super-49B-GenRM-Multilingual and
    https://huggingface.co/nvidia/Qwen3-Nemotron-32B-GenRM-Principle
* NeMo Guardrails:
  * Fact-checking rails (self-check facts, AlignScore, Patronus Lynx, SelfCheckGPT-style hallucination):
    https://docs.nvidia.com/nemo/guardrails/configure-guardrails/guardrail-catalog/fact-checking.md
  * Evaluation tooling: https://docs.nvidia.com/nemo/guardrails/evaluation/evaluate-guardrails.md

**Other tools and benchmarks**
* TruLens:
  * RAG triad: https://www.trulens.org/getting_started/core_concepts/rag_triad/
  * Feedback functions (Likert 0–3, normalised; `_with_cot_reasons`; context relevance, groundedness, coherence,
    conciseness, helpfulness, comprehensiveness, citations, harmfulness, maliciousness, controversiality, stereotypes,
    agent goal/plan metrics, topic adherence, coherence across turns):
    https://www.trulens.org/reference/trulens/feedback/llm_provider/
* ARES: https://arxiv.org/abs/2311.09476
  * Fine-tuned DeBERTa judges.
  * Prediction-powered inference with about 150+ human labels gives 95% confidence intervals.
* RAGChecker: https://github.com/amazon-science/RAGChecker , formulas in https://arxiv.org/html/2408.08067
  * Meta-evaluation against human preference (Pearson): RAGChecker 61.9, RAGAS 48.3, TruLens 35.2, ARES 17.8.
* Arize Phoenix pre-tested evals: https://arize.com/docs/phoenix/evaluation/running-pre-tested-evals
  * The evals include faithfulness, hallucination, completeness, conciseness, correctness, retrieval relevance, tool
    selection/invocation/response handling, refusal, user friction, PII and toxicity. Labels are preferred over numeric
    scores.
* LangSmith RAG tutorial (correctness, relevance, groundedness, retrieval relevance as booleans, explanation first):
  https://docs.langchain.com/langsmith/evaluate-rag-tutorial
* Braintrust autoevals: https://github.com/braintrustdata/autoevals
* promptfoo model-graded assertions: https://www.promptfoo.dev/docs/configuration/expected-outputs/model-graded/
  * Pages for context-faithfulness, context-recall, context-relevance, answer-relevance and factuality (A–E categories).
  * `contextTransform` pulls the context out of a response.
* IR measures: https://en.wikipedia.org/wiki/Evaluation_measures_(information_retrieval)
* BEIR: https://arxiv.org/html/2104.08663v4 (primary metric nDCG@10; also Recall@100 and Hole@10)
* "Know Your RAG": https://arxiv.org/abs/2411.19710 (question taxonomy: fact, summary, reasoning, unanswerable)

**Judge reliability**
* Zheng et al., MT-Bench: https://arxiv.org/abs/2306.05685
  * Position consistency when the answer order is swapped: GPT-4 65.0%, GPT-3.5 46.2%, Claude-v1 23.8%.
  * A verbosity attack fooled GPT-3.5 and Claude-v1 in 91.3% of cases.
  * Self-enhancement: about +10% for GPT-4 and +25% for Claude-v1.
  * Math grading failures dropped from 14/20 to 3/20 with a reference answer.
  * GPT-4 agreed with experts 85% of the time; humans agreed with each other 81%.
* G-Eval: https://arxiv.org/abs/2303.16634 (probability-weighted score Σ p(s)·s)
* PoLL: https://arxiv.org/abs/2404.18796
  * A jury of three small models had Cohen's κ 0.76–0.91 against humans, beating GPT-4 at 7–8× lower cost.
* Hamel Husain: https://hamel.dev/blog/posts/llm-judge/
  * Use binary pass/fail with critiques from one domain expert.
  * Report TPR and TNR, not raw agreement.
  * About 100 labels per failure mode.
  * Split the labels 10–20% / 40–45% / 40–45%.
* Eugene Yan: https://eugeneyan.com/writing/llm-evaluators/ (κ, not raw agreement; pairwise for subjective criteria)
* Prediction-powered inference: https://arxiv.org/abs/2301.09633
* Nondeterminism: https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/
  * 1000 completions at temperature 0 gave 80 distinct outputs.

### 2.2 Inputs: what each metric needs, what the user provides, and the "missing input" message

Every metric declares which of these inputs it requires. The picker and *Try on one sample* grey a metric out when an
input is missing, and show that input's message with a button that does the fix (open the mapping, open the column
mapper, open Providers).

| Code | Input | Ragas / DeepEval name | Where it comes from | Message when it is missing |
|---|---|---|---|---|
| Q | Question | `user_input` / `input` | Dataset column `question` (also `query`, `input`, `user_input`) | "Needs the question: map a dataset column to *Question*." |
| A | Answer | `response` / `actual_output` | Captured by the target's mapping, or a `response` column for offline scoring | "Needs the answer: in *Connect*, click the answer in the response, or add a `response` column to score recorded answers." |
| R | Reference answer | `reference` / `expected_output` | Dataset column `reference` (also `expected`, `ground_truth`, `expected_output`) | "Needs a reference answer: add a `reference` column, or draft references with AI (reviewed before use)." |
| C | Retrieved contexts | `retrieved_contexts` / `retrieval_context` | The mapping's `contexts` (text, id, score), or a `retrieved_contexts` column | "Needs the retrieved chunks: in *Connect*, click the list of sources. If your API does not return them, turn on its 'return sources' option, or use answer-only metrics." |
| RC | Reference contexts | `reference_contexts` / `context` | Dataset column `reference_contexts` (gold chunks), filled automatically for generated test sets | "Needs the gold chunks: add a `reference_contexts` column, or generate the test set from documents (it records them)." |
| ID | Retrieved ids and reference ids | `retrieved_context_ids`, `reference_context_ids` | The mapping's `context.id`, plus a dataset `reference_ids` column (the BEIR qrels import fills it) | "Needs document ids on both sides: map the id of a context item and add a `reference_ids` column." |
| REL | Graded relevance (optional) | qrels grade | Dataset `relevance` (`{id: grade}`) | Without it, nDCG uses binary relevance (a note, not an error). |
| T | Conversation turns | `MultiTurnSample` / `turns` | Dataset `turns` (user messages), and the target's conversation mode | "Needs a conversation: add a `turns` column and choose how the target keeps the session (*Connect ▸ Conversation*)." |
| TC | Tool calls made | `tools_called` | The mapping's `toolCalls`, or an `agent` / MCP test | "Needs the tool calls: map them in the response (*Connect ▸ Tool calls*)." |
| RTC | Expected tool calls | `reference_tool_calls` / `expected_tools` | Dataset `reference_tool_calls` | "Needs the expected tool calls: add a `reference_tool_calls` column." |
| GOAL | Expected outcome | `reference` (goal) / `expected_outcome` | Dataset `expected_outcome` | Optional: without it, goal accuracy runs in its no-reference mode. |
| TOP | Allowed topics | `reference_topics` | Dataset or metric config `topics` | "Needs the allowed topics: list them in the metric's settings." |
| RUB | Rubric or criteria | `rubrics` / `criteria`, `evaluation_steps` | Metric config, or a per-sample `rubric` column | "Needs a rubric: write the criteria, or let AI draft them." |
| ROLE | Assistant role | `chatbot_role` / `role` | Metric config | "Needs the assistant's role in one sentence." |
| INSTR | Instructions | `prompt_instructions` | Metric config (a list) | "Needs the instructions the answer must follow." |
| ANS | Answerable flag | — | Dataset `answerable: false` for questions that have no answer | Optional: without it, only false refusals are counted. |
| SRC | Source text | `input` (summarisation) | Dataset `source` | "Needs the text that was summarised (`source` column)." |
| CAN | Canaries / injected instruction | — | Dataset `injection` / metric `canaries` | "Needs the injected instruction or canary to look for." |
| U | Usage | — | The mapping's `usage` (tokens), price table | Cost per answer is shown as "unpriced" without it. |
| EMB | Embedding model | — | A provider's `embeddingModel` (`types.ts:211`) | "Needs an embedding model: set one on a provider (*AI Lab ▸ Providers*); a local Ollama model works." |
| IMG | Images in contexts (or the answer) | `retrieved_contexts` items that are image URLs, paths or data URIs | The mapping's `context.image` (URL, data URI, `{mime, data}` or a path), or dataset context items that are images | "Needs images: map the image field of a context item (*Connect ▸ click the image URL or data*), or put image URLs / data URIs in `retrieved_contexts`." |
| SQL | Generated SQL and reference SQL (or their results) | `response`, `reference` | The answer (the mapping can take a ```sql fence), a dataset `reference` holding SQL, or CSV/JSON results | "Needs SQL on both sides: map the generated query (*Connect ▸ SQL*) and add a `reference` column with the expected query (or its result as CSV)." |
| DB | A read-only database to run SQL on | — | The evaluation's `database` (SQLite file, `postgres://`, `mysql://`, or `connectionEnv`), declared read-only | "Needs a read-only database: choose one for this evaluation (*Evaluation ▸ Database*). Use a read-only database user." |
| JV | A vision-capable judge | — | A judge model marked vision-capable (probed, or set on the provider) | "Needs a judge that can see images: choose a vision-capable model (a local one such as an Ollama vision model works). Text-only judges cannot score this metric." |
| J | Judge model | — | The evaluation's judge, else the AI settings' large tier | "Needs a judge model: choose one for this evaluation, or set *Settings ▸ AI assistant*. A local model works; nothing is sent until you run." |

### 2.3 The catalogue by type

Key:
* **Calls** = LLM calls per sample. TestPion batches the verdicts for all items into one call, so this is often fewer
  than the library makes; "+E" means embedding calls too.
* **Dir**: ↑ higher is better, ↓ lower is better.
* **Src**: R Ragas · D DeepEval · N NVIDIA · T TruLens · C RAGChecker · P promptfoo · A Arize Phoenix · L LangSmith ·
  B Braintrust · I IR/BEIR · O other paper · TP TestPion.
* **Has** (today): Y yes · P partly · N no.
* Each row's *worked example* becomes a unit test (non-LLM metrics) or a golden mock-judge case (judged metrics; §5.1).

#### Type 1 — Retrieval quality, judged (LLM)

| # | Metric (aliases) | Measures | Inputs | Method / formula | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|---|
| 1.1 | `context-precision` (Ragas LLMContextPrecisionWithReference, DeepEval ContextualPrecision, Braintrust ContextPrecision) | Useful chunks ranked first | Q, C, R, J | A verdict per chunk on whether it is useful for reaching R, then rank-weighted AP = Σₖ P@k·rₖ / #relevant | 1 (Ragas: 1 per chunk) | ↑ | Verdicts [✓,✗,✓] → (1/1 + 2/3)/2 = 0.833 | R, D, B, N | Y |
| 1.2 | `context-utilization` (Ragas LLMContextPrecisionWithoutReference) | Chunks the answer used, rank-weighted | Q, C, A, J | As 1.1, with each chunk judged against A | 1 | ↑ | [✗,✓] → (1/2)/1 = 0.5 | R | P |
| 1.3 | `context-recall` (Ragas LLMContextRecall, DeepEval ContextualRecall, promptfoo context-recall, Braintrust ContextRecall) | Reference statements found in the context | Q, R, C, J | Split R into statements; score = attributable / total | 1 | ↑ | 3 of 4 statements found → 0.75 | R, D, P, B, N | Y |
| 1.4 | `context-entity-recall` (Ragas ContextEntityRecall, Braintrust) | Reference entities present in the context | R, C (J for `mode: llm`) | \|E_C ∩ E_R\| / \|E_R\|. `mode: regex` needs no model; `mode: llm` makes 2 extraction calls. Ragas matches entities exactly and case-sensitively, and a reference with no entities scores 0; TestPion normalises case and returns *n/a* instead of 0 | 0 / 2 | ↑ | E_R {Paris, 1889, Eiffel}, C has Paris and Eiffel → 0.667 | R, B, N | P |
| 1.5 | `context-relevance` (DeepEval ContextualRelevancy, TruLens context_relevance, promptfoo context-relevance, NVIDIA ContextRelevance, Phoenix Retrieval Relevance) | How much of the retrieved text is relevant to Q | Q, C, J | `mode` decides the formula (default `nvidia`, so the Ragas name `context_relevance` means what it means in Ragas): **statements** (DeepEval: relevant statements / statements); **chunks** (TruLens: 0–3 per chunk, normalised, mean); **sentences** (promptfoo: needed sentences / sentences); **nvidia** (two prompts each rate 0/1/2, normalised, averaged) | 1–2 | ↑ | 10 statements, 4 relevant → 0.4; nvidia ratings 2 and 1 → 0.75. NVIDIA pre-check: an empty context, or one equal to or contained in the question, scores 0 with no call | D, T, P, N, A | N |
| 1.6 | `retrieval-relevance` (LangSmith retrieval relevance, Phoenix relevance labels) | Judged relevance labels for retrieved chunks, fed to IR metrics when there are no ids | Q, C, J | A binary label per chunk, then precision@k, MRR and nDCG over those labels (no recall: unretrieved documents are unknown) | 1 | ↑ | Labels [1,0,1] → P@3 0.667, MRR 1 | L, A | N |

#### Type 2 — Retrieval quality, IR and ID-based (no LLM)

| # | Metric (aliases) | Inputs | Formula | Dir | Worked example (retrieved top = [a,b,c,d]) | Src | Has |
|---|---|---|---|---|---|---|---|
| 2.1 | `context-precision-ids` (Ragas IDBasedContextPrecision) | ID | \|ret ∩ ref\| / \|ret\| | ↑ | ref {a,c} → 2/4 = 0.5 | R | N |
| 2.2 | `context-recall-ids` (Ragas IDBasedContextRecall) | ID | \|ret ∩ ref\| / \|ref\| | ↑ | ref {a,c,e} → 2/3 = 0.667 | R | N |
| 2.3 | `context-precision-lexical` (Ragas NonLLMContextPrecisionWithReference) | C, RC | A chunk is relevant if its string similarity to some RC ≥ t (0.5); then AP | ↑ | relevant [✓,✗,✓,✗] → (1 + 2/3)/2 = 0.833 | R | N |
| 2.4 | `context-recall-lexical` (Ragas NonLLMContextRecall) | C, RC | An RC is recalled if some chunk's similarity to it ≥ t | ↑ | 2 of 3 RC matched → 0.667 | R | N |
| 2.5 | `recall@k` (NVIDIA NeMo retriever eval, BEIR Recall@100) | ID | \|rel ∩ top-k\| / \|rel\| | ↑ | k=3, rel {a,e} → 0.5 | N, I | N |
| 2.6 | `precision@k` | ID | \|rel ∩ top-k\| / k | ↑ | k=3, rel {a,e} → 0.333 | N, I | N |
| 2.7 | `hit-rate@k` (NVIDIA success@k) | ID | 1 if any relevant document is in the top k | ↑ | k=3, rel {a,e} → 1 | N, I | N |
| 2.8 | `mrr@k` (NVIDIA recip-rank) | ID | 1 / rank of the first relevant document | ↑ | rel {b} → 0.5 | N, I | N |
| 2.9 | `ndcg@k` (NVIDIA NeMo retriever eval; BEIR's main metric nDCG@10) | ID (+REL) | DCG = Σ relᵢ / log₂(i+1); `gain: exponential` uses 2^rel − 1; divide by IDCG | ↑ | rel [0,1,1] at k=3: DCG 0.631 + 0.5 = 1.131, IDCG 1 + 0.631 = 1.631 → 0.693 | N, I | N |
| 2.10 | `map@k` | ID | AP = Σ P(k)·rel(k) / \|rel\|; relevant documents never retrieved count 0; mean over samples | ↑ | rel {a,c,e}, k=3 → (1 + 2/3)/3 = 0.556 | N, I | P (an AP helper exists, `checks.ts:671`) |
| 2.11 | `r-precision` (NVIDIA rprec) | ID | P@R, where R = \|rel\| | ↑ | rel {a,c} → P@2 = 0.5 | N, I | N |
| 2.12 | `hole@k` (BEIR) | ID | Share of the top k with no relevance label | ↓ | 3 of the top 10 unlabelled → 0.3 | I | N |

#### Type 3 — Generation quality

| # | Metric (aliases) | Measures | Inputs | Method / formula | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|---|
| 3.1 | `faithfulness` = `groundedness` (Ragas Faithfulness, DeepEval Faithfulness, TruLens groundedness, promptfoo context-faithfulness, Braintrust Faithfulness, LangSmith groundedness, Phoenix Faithfulness) | Answer claims backed by the context | Q, A, C, J | Split A into claims. `strictness: support` (Ragas, TruLens) scores supported / claims. `strictness: contradiction` (DeepEval) scores claims that contradict no truth extracted from C; `penalizeAmbiguous` is optional. An answer with no claims scores 1 (`emptyScore`; Ragas returns NaN, which TestPion shows as *n/a*). Ragas makes 2 calls: statements, then one batched NLI | 1–3 | ↑ | 4 claims, 3 supported → 0.75 | R, D, T, P, B, L, A, N | Y |
| 3.2 | `faithfulness-hhem` (Ragas FaithfulnesswithHHEM) | As 3.1, with a classifier as the verifier | A, C, J + classifier endpoint | Claims come from the LLM; entailment comes from the Vectara HHEM classifier, served from a local endpoint | 1 + cls | ↑ | 4 claims, entailment p > 0.5 on 3 → 0.75 | R | N |
| 3.3 | `response-groundedness` (NVIDIA ResponseGroundedness) | The whole answer grounded, rated holistically | A, C, J | Two prompts each rate 0/1/2; divide by 2 and average. One invalid rating → use the other; both invalid → judge error. A blank answer or context scores 0 with no call. NeMo Guardrails' *self-check facts* (yes/no) is `mode: binary` | 2 | ↑ | Ratings 2 and 1 → (1 + 0.5)/2 = 0.75 | N | N |
| 3.4 | `hallucination` (DeepEval Hallucination, Phoenix hallucination label) | The answer contradicts the ground-truth context | A, RC, J | Per reference context, decide whether A contradicts it. TestPion reports `hallucination` = contradicted / contexts ↓, plus `alignment` = 1 − that. DeepEval's current docs report aligned / total ↑; older versions reported contradicted ↓ (version-sensitive). `label: binary` gives Phoenix's grounded/hallucinated label | 1 | ↓ | 4 reference contexts, 1 contradicted → 0.25 | D, A | P (today an alias of groundedness) |
| 3.5 | `answer-relevance` (Ragas ResponseRelevancy, DeepEval AnswerRelevancy, TruLens relevance, promptfoo answer-relevance, Braintrust AnswerRelevancy, LangSmith relevance) | The answer addresses the question | Q, A, J (+EMB) | `mode: reverse-questions` (Ragas, promptfoo): generate N = 3 questions from A, mean cosine to Q, clamped to 0..1 (Ragas does not clamp); the score is 0 only when every generated question is non-committal; NVIDIA NIM uses N = 1. `mode: statements` (DeepEval): relevant statements / statements. `mode: score` (TruLens 0–3). `mode: binary` (LangSmith) | N +E | ↑ | Cosines 0.90, 0.80, 0.85 → 0.85 | R, D, T, P, B, L, N | P |
| 3.6 | `factual-correctness` (Ragas FactualCorrectness with modes precision/recall/f1, `atomicity`, `coverage`) | The answer's facts against the reference's facts | A, R, J | Claims both ways: TP = A's claims supported by R; FP = A's claims not in R; FN = R's claims missing from A; F-beta (`beta`). Precision mode makes 2 calls; f1 and recall make 4 | 2–4 | ↑ | A: 2 of 3 claims in R; R: 2 of 4 claims in A → P 0.667, R 0.5, F1 0.571 | R | Y (as today's `answer-correctness`) |
| 3.7 | `answer-correctness` (Ragas AnswerCorrectness, Braintrust AnswerCorrectness) | Weighted factual and semantic correctness | A, R, J, EMB | 0.75 × factual F1 + 0.25 × semantic similarity (weights configurable). Ragas: 2 statement calls + 1 TP/FP/FN classification + 2 embeddings. Ragas scores factuality 1.0 when a statement list is empty (likely a bug); TestPion returns *n/a* | 3 +E | ↑ | F1 0.571, similarity 0.9 → 0.653 | R, B, N | P |
| 3.8 | `answer-accuracy` (NVIDIA AnswerAccuracy) | Agreement with the reference, rated holistically, both orders | Q, A, R, J | Two prompts, the second with A and R swapped. Each rates 0/2/4 ("4 = fully contained and equivalent, 2 = partially, 0 = not"); divide by 4 and average; one invalid → use the other; up to 5 retries | 2 | ↑ | Ratings 4 and 2 → (1 + 0.5)/2 = 0.75 | N | N |
| 3.9 | `factuality` (promptfoo factuality, Braintrust Factuality, OpenAI evals prompt) | How the answer relates to the reference | Q, A, R, J | Category A subset, B superset, C same, D disagrees, E differs but factual. D fails; every category's score is configurable | 1 | ↑ | Category B → 1 (pass) | P, B | N |
| 3.10 | `correctness` (LangSmith correctness, Phoenix correctness, promptfoo model-graded-closedqa) | Correct with respect to the reference (binary) | Q, A, R, J | `{explanation, correct}`, explanation first. Extra accurate information is allowed; a conflict is not | 1 | ↑ | A conflicts on the date → 0 | L, A, P | N |
| 3.11 | `completeness` (Phoenix completeness) | Every part of the question or reference is answered | Q, A, (R), J | The question's sub-questions (or R's claims) answered / total | 1 | ↑ | 3 of 4 parts → 0.75 | A | P (factual-correctness recall) |
| 3.12 | `citation` (TestPion) | Citation markers point to retrieved chunks | A, C | `[id]` / `[n]` markers, or citations captured by the mapping, must exist in C | 0 | ↑ | [1], [7] with 4 chunks → 0.5 | TP | Y |
| 3.13 | `citation-accuracy` (TruLens citation accuracy, ALCE citation precision/recall) | Each cited chunk supports its sentence, and claims are cited | A, C, J | Precision = supporting citations / citations; recall = cited supported sentences / sentences | 1 | ↑ | 5 citations, 4 supportive → 0.8 | T, O | N |
| 3.14 | `negative-rejection` (RGB benchmark; TruLens answerability-aware groundedness) | Declines unanswerable questions without refusing answerable ones | A, ANS (J optional) | Refusal detector (regex, or a judge with `judge:`). Score 1 when `answerable:false` and it declines, or when it is answerable and it answers. Reports false and missed refusals | 0–1 | ↑ | Unanswerable question answered confidently → 0 | O, T | P (`refusal` check) |
| 3.15 | `summarization` (DeepEval Summarization, Ragas SummarizationScore) | A summary is aligned with and covers its source | SRC, A, J | DeepEval: min(alignment, coverage), with coverage from n = 5 yes/no assessment questions. `mode: ragas`: keyphrases → yes/no questions → answers from the summary; QA = correct / total; conciseness = 1 − min(len summary, len text)/len text; final = 0.5·QA + 0.5·conciseness | 3–4 | ↑ | Alignment 0.9, coverage 0.8 → 0.8 | D, R | N |
| 3.16 | `ragas-score` (DeepEval RAGAS aggregate) | Mean of answer relevance, faithfulness, context precision and context recall | Q, A, R, C, J | Composite (formula) | sum | ↑ | 0.85, 0.75, 0.833, 0.75 → 0.796 | D | N |

#### Type 4 — Claim-level analysis (RAGChecker style; one shared pass)

One extraction pass splits A and R into claims. One checking pass checks each claim against R, A and each chunk; a
chunk is relevant if it entails at least one claim of R. All 11 values come from that pass, so selecting several costs
the same as selecting one (about 3 calls, batched; joint checking by default).

**Worked example** (used for every row):
* A has 5 claims: 3 are in R and in C, 1 is wrong but comes from a relevant chunk, and 1 is in neither R nor C.
* R has 4 claims: 3 are in A, and all 4 are in C.
* k = 4 chunks, 3 of them relevant.

| # | Metric | Formula | Dir | Example | Src | Has |
|---|---|---|---|---|---|---|
| 4.1 | `claim-precision` | A claims entailed by R / A claims | ↑ | 3/5 = 0.6 | C | P (3.6) |
| 4.2 | `claim-recall` | R claims entailed by A / R claims | ↑ | 3/4 = 0.75 | C | P (3.6) |
| 4.3 | `claim-f1` | Harmonic mean of 4.1 and 4.2 | ↑ | 0.667 | C | P (3.6) |
| 4.4 | `retriever-claim-recall` | R claims in C / R claims | ↑ | 4/4 = 1.0 | C | P (1.3) |
| 4.5 | `retriever-context-precision` | Relevant chunks / k | ↑ | 3/4 = 0.75 | C | N |
| 4.6 | `context-utilization-claims` | R claims in C and in A / R claims in C | ↑ | 3/4 = 0.75 | C | N |
| 4.7 | `noise-sensitivity-relevant` (Ragas NoiseSensitivity `mode: relevant`) | Wrong A claims entailed by relevant chunks / A claims. Ragas makes 2K + 3 calls; TestPion's shared pass batches them into about 3 | ↓ | 1/5 = 0.2 | C, R, N | N |
| 4.8 | `noise-sensitivity-irrelevant` (Ragas `mode: irrelevant`) | Wrong A claims entailed by irrelevant chunks / A claims | ↓ | 0/5 = 0 | C, R, N | N |
| 4.9 | `claim-hallucination` | A claims in neither R nor C / A claims | ↓ | 1/5 = 0.2 | C | N |
| 4.10 | `self-knowledge` | Correct A claims not in C / A claims (informational) | — | 0/5 = 0 | C | N |
| 4.11 | `claim-faithfulness` | A claims in C / A claims | ↑ | 4/5 = 0.8 | C | P (3.1) |

#### Type 5 — Lexical, string and structure (no LLM)

| # | Metric (aliases) | Inputs | Formula | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|
| 5.1 | `exact-match` (Ragas ExactMatch, Braintrust ExactMatch, Phoenix, NVIDIA ExactMatchMetric) | A, R | Normalised equality (trim, `ignoreCase`; Ragas does no normalisation, `normalize: false`) | ↑ | "Paris" vs "paris" (ignoreCase) → 1 | R, B, A, N | Y |
| 5.2 | `contains` / `string-presence` (Ragas StringPresence, NVIDIA StringCheck contains/startswith/endswith) | A, R or a list | Substring (or prefix / suffix) present; `any` or `all` of a list | ↑ | "8am" in the answer → 1 | R, N | Y |
| 5.3 | `not-contains` / forbidden terms | A, list | None of the terms present | ↑ | "guarantee" found → 0 | TP | Y |
| 5.4 | `regex` / `not-regex` (Phoenix regex) | A, pattern | Match / no match | ↑ | `^\d{4}-\d{2}` | A | Y |
| 5.5 | `string-similarity` (Ragas NonLLMStringSimilarity: levenshtein, hamming, jaro, jaro-winkler; Braintrust Levenshtein) | A, R | 1 − normalised distance | ↑ | Levenshtein "kitten"/"sitting" = 3 → 1 − 3/7 = 0.571 | R, B | N |
| 5.6 | `bleu` (Ragas BleuScore, sacreBLEU-compatible) | A, R | Geometric mean of 1–4-gram precisions × brevity penalty, with exponential smoothing (Ragas splits both on ". " and uses corpus BLEU / 100; `segmentation: ragas \| whole`) | ↑ | Fixture from sacreBLEU's documented example | R, N | N |
| 5.7 | `rouge` (Ragas RougeScore: rouge1/rouge2/rougeL; precision/recall/fmeasure) | A, R | n-gram or LCS overlap | ↑ | A "the cat sat", R "the cat sat down": rouge1 P 1, R 0.75, F 0.857 | R, N | N |
| 5.8 | `chrf` (Ragas ChrfScore) | A, R | Character n-gram F-score, β = 2 | ↑ | Fixture from sacreBLEU's chrF example | R | N |
| 5.9 | `token-f1` (SQuAD F1, NVIDIA F1Metric) | A, R | Token overlap F1 | ↑ | A "the cat sat", R "a cat sat": P 2/3, R 2/3 → 0.667 | O, N | Y (`similarity method: f1`) |
| 5.10 | `numeric-diff` (Braintrust NumericDiff, NVIDIA NumberCheck) | A (or path), R | 1 − \|a − b\| / max(\|a\|, \|b\|); `op: == != > >= < <=` with epsilon for a pass/fail number check | ↑ | 95 vs 100 → 0.95 | B, N | N |
| 5.11 | `json-diff` (Braintrust JSONDiff) | A, R (JSON) | Per-key similarity (strings by 5.5, numbers by 5.10), averaged | ↑ | {a:1, b:"x"} vs {a:1, b:"y"} → 0.5 | B | P (`snapshot`) |
| 5.12 | `json-correctness` (DeepEval JsonCorrectness) = `json-schema` | A, schema | Validates (1) or not (0); an LLM writes the reason only when it fails (optional) | ↑ | Missing required `id` → 0 | D | Y |
| 5.13 | `length` | A | Characters, words or tokens within min/max | ↑ | 412 words, max 300 → 0 | TP | Y |
| 5.14 | `label-f1` (Phoenix precision/recall/F code evaluator) | A (labels via path), R (labels) | Set precision, recall and F1 | ↑ | Expected {a,b}, got {a,c} → P 0.5, R 0.5, F1 0.5 | A | N |
| 5.15 | `quoted-spans` (Ragas QuotedSpansAlignment, in the source only) | A, C | Quoted spans of ≥ 3 words in A, found verbatim (casefolded) in C / quoted spans; no quotes → 1 | ↑ | 2 quotes, 1 found → 0.5 | R | N |

#### Type 6 — Embedding-based

| # | Metric (aliases) | Inputs | Formula | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|
| 6.1 | `semantic-similarity` (Ragas SemanticSimilarity, Braintrust EmbeddingSimilarity / AnswerSimilarity, NeMo answer_similarity) | A, R, EMB | cosine of L2-normalised e(A), e(R); an optional threshold makes it binary | ↑ | The mock embedder's fixture vectors → 0.83 | R, B, N | Y |
| 6.2 | `reference-set-similarity` | A, a set of good answers, EMB | max (or mean) cosine to the set; `negatives:` also lists bad answers that must stay below t | ↑ | Max over 3 good answers 0.91; max over bad answers 0.42 → pass | TP | N |
| 6.3 | `context-answer-similarity` | A, C, EMB | Max cosine of each answer sentence to the chunks, averaged. A cheap grounding proxy with no judge | ↑ | Sentences 0.9 and 0.6 → 0.75 | TP | N |

#### Type 7 — Judge templates (built-in criteria judges)

These are ready-made LLM judges with fixed criteria, plus the template engines that custom metrics also use (§4d).

| # | Metric (aliases) | Measures | Inputs | Method | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|---|
| 7.1 | `llm-judge` (promptfoo llm-rubric, NVIDIA LLMJudgeMetric range score) | Free criteria, score 0–1 | any, J | `{reasoning, score}`; scale and parser configurable (JSON path or regex) | 1 | ↑ | "polite and concise" → 0.8 | P, N, TP | Y |
| 7.2 | `pass-fail` = `aspect-critic` (Ragas AspectCritic, Phoenix labels) | A binary verdict on one aspect | any, J | `{reasoning, verdict}`; `votes: n` (odd) takes the majority of n samples (Ragas strictness — whose current code makes only 1 call); presets for Ragas' predefined aspects: harmfulness, maliciousness, coherence, correctness, conciseness | n | ↑ | Votes [1,1,0] → 1 | R, A | P |
| 7.3 | `simple-criteria` (Ragas SimpleCriteriaScore) | An integer score on a criterion | any, J | Integer on the configured scale, normalised | 1 | ↑ | 4 on 0–5 → 0.8 | R | P |
| 7.4 | `rubric-score` (Ragas RubricsScore) | The rubric level that fits best | Q, A, (R), RUB, J | Levels 1–5, each with a `scoreN_description`, with or without a reference; `{score, feedback}`; normalised (s − 1)/4 | 1 | ↑ | Level 4 → 0.75 | R, N | N |
| 7.5 | `instance-rubric` (Ragas InstanceRubrics) | As 7.4, with the rubric per sample | + per-sample RUB | Same as 7.4 | 1 | ↑ | Level 5 → 1 | R | N |
| 7.6 | `g-eval` (DeepEval GEval, G-Eval paper) | Criteria scored with evaluation steps | chosen params, RUB, J | Steps generated once from `criteria` and cached (or given). Form-filling score. With logprobs, Σ p(s)·s; else the integer. Optional score-range rubric (DeepEval) | 1 (+1 once) | ↑ | p(3)=0.2, p(4)=0.8 on 1–5 → 3.8 → 0.7 | D | N |
| 7.7 | `dag` (DeepEval DAG) | A decision tree of judgements | any, J | Task, binary, non-binary and verdict nodes. Only the matching branch runs; the leaf score / 10. Cycles are refused when it loads | depth | ↑ | "Has citations?" yes → "Cites the right doc?" no → leaf 4 → 0.4 | D | N |
| 7.8 | `prompt-alignment` (DeepEval PromptAlignment) | Instructions followed | A, INSTR, J | Instructions followed / instructions | 1 | ↑ | 3 of 4 → 0.75 | D | N |
| 7.9 | `pairwise` (DeepEval Arena G-Eval, promptfoo select-best) | Which of two answers is better (variant vs baseline) | Q, A, A′, J | Blinded; judged in both orders; a tie when the orders disagree; win rate over samples | 2 | ↑ | Wins in both orders → 1; disagree → 0.5 | D, P | N |
| 7.10 | `coherence` (TruLens) | Logical flow | A, J | Likert 0–3, normalised | 1 | ↑ | 2 → 0.667 | T | N |
| 7.11 | `conciseness` (TruLens, Phoenix) | No unnecessary content | A, J | Likert 0–3, or a label | 1 | ↑ | 3 → 1 | T, A | N |
| 7.12 | `helpfulness` (TruLens) | Helpful to the user | Q, A, J | Likert 0–3 | 1 | ↑ | 1 → 0.333 | T | N |
| 7.13 | `comprehensiveness` (TruLens) | Covers the key points of the source | C or SRC, A, J | Key points covered / key points | 1–2 | ↑ | 4 of 5 → 0.8 | T | N |
| 7.14 | `reward-score` (NVIDIA Nemotron reward models) | A reward model's rating | Q, A, reward endpoint | Calls a reward model (NIM or OpenAI-compatible). `kind: attributes` (Nemotron-4-340B: 5 HelpSteer2 attributes 0–4), `scalar` (70B-Reward: comparable only within one prompt, so used for pairwise / variant ranking, not thresholds), or `genrm` (1–5 helpfulness, or a principle yes/no) | 1 | ↑ | Helpfulness 3.2 on 0–4 → 0.8 | N | N |

#### Type 8 — Safety and quality

| # | Metric (aliases) | Inputs | Method | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|
| 8.1 | `toxicity` (DeepEval Toxicity, Phoenix toxicity) | A, J | Extract opinions; non-toxic / opinions (DeepEval's current direction ↑). `toxicityRate` = 1 − that, ↓ | 1–2 | ↑ | 1 toxic of 4 opinions → 0.75 | D, A | N |
| 8.2 | `bias` (DeepEval Bias, TruLens stereotypes) | A, J | Opinions judged for gender, political, racial or geographic bias; unbiased / opinions | 1–2 | ↑ | 0 of 3 biased → 1 | D, T | N |
| 8.3 | `pii-leakage` (DeepEval PIILeakage, Phoenix PII) | A, J | Statements that might hold PII; non-PII / statements. Regex runs first (8.4) | 1–2 | ↑ | 1 of 5 has a phone number → 0.8 | D, A | P |
| 8.4 | `no-leak` (TestPion) | A (CAN optional) | Regex for secrets, PII and canaries | 0 | ↑ | An AWS key found → 0 | TP | Y |
| 8.5 | `refusal` | A | Refusal detector (regex; judge optional) | 0–1 | ↑ | "I can't help with that" → 1 | TP, A | Y |
| 8.6 | `not-refusal` | A | Inverse of 8.5 | 0–1 | ↑ | — | TP | Y |
| 8.7 | `prompt-injection-resistance` (promptfoo `pi` / prompt-injection tests) | A, CAN (J optional) | A dataset or chunk carries an injected instruction (canary, e.g. "reply with BANANA"). Pass if the answer does not carry it out; regex on the canary plus an optional judge | 0–1 | ↑ | Answer contains "BANANA" → 0 | P | N |
| 8.8 | `misuse` (DeepEval Misuse) | A, domain, J | Non-misuse statements / statements | 1–2 | ↑ | 0 of 4 misuse → 1 | D | N |
| 8.9 | `non-advice` (DeepEval NonAdvice) | A, advice types, J | Appropriate advice statements / advice statements | 1–2 | ↑ | 1 of 2 inappropriate → 0.5 | D | N |
| 8.10 | `role-violation` (DeepEval RoleViolation) | A, ROLE, J | Binary: 1 when there is no violation | 1 | ↑ | Breaks character → 0 | D | N |
| 8.11 | `harmfulness` (TruLens; Ragas AspectCritic preset) | A, J | Pass/fail template (7.2) | 1 | ↑ | — | T, R | N |
| 8.12 | `maliciousness` (TruLens; Ragas AspectCritic preset) | A, J | Pass/fail template (7.2) | 1 | ↑ | — | T, R | N |
| 8.13 | `controversiality` (TruLens) | A, J | Likert 0–3, inverted | 1 | ↑ | — | T | N |

#### Type 9 — Conversational (multi-turn)

| # | Metric (aliases) | Inputs | Method | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|
| 9.1 | `knowledge-retention` (DeepEval) | T, J | Facts from user turns. A turn that forgets or contradicts them is attrition. Score = turns without attrition / assistant turns | 2 | ↑ | 1 of 5 turns asks again → 0.8 | D | N |
| 9.2 | `role-adherence` (DeepEval) | T, ROLE, J | Adherent assistant turns / assistant turns | 1 | ↑ | 4 of 5 → 0.8 | D | N |
| 9.3 | `conversation-completeness` (DeepEval) | T, J | Satisfied user intentions / intentions | 2 | ↑ | 2 of 3 → 0.667 | D | N |
| 9.4 | `turn-relevancy` (DeepEval) | T, J | Sliding window (size 10). Relevant assistant turns / assistant turns | 1 | ↑ | 5 of 5 → 1 | D | N |
| 9.5 | `turn-faithfulness` (DeepEval TurnFaithfulness) | T with per-turn C, J | Per window, faithful claims / claims; mean over assistant turns | per turn | ↑ | Turns 1.0, 0.5 → 0.75 | D | N |
| 9.6 | `conversational-g-eval` (DeepEval) | T, RUB, J | G-Eval over the whole conversation | 1–2 | ↑ | — | D | N |
| 9.7 | `topic-adherence` (Ragas TopicAdherenceScore precision/recall/f1; TruLens topic_adherence) | T, TOP, J | For each query: on-topic? answered or refused? → precision / recall / F1 | 2 | ↑ | P 1.0, R 0.67 → F1 0.8 | R, T, N | N |
| 9.8 | `coherence-across-turns` (TruLens) | T, J | Likert 0–3, normalised | 1 | ↑ | — | T | N |
| 9.9 | `conversation-helpfulness` (TruLens) | T, J | Likert 0–3 | 1 | ↑ | — | T | N |
| 9.10 | `user-friction` (Phoenix) | T, J | A label: did the user have to repeat or rephrase? | 1 | ↑ | — | A | N |
| 9.11 | `per-turn:<metric>` (promptfoo conversation-relevance; TestPion design) | T with per-turn C | Runs any single-turn metric on each assistant turn, then takes the mean and the minimum | per turn | ↑ | per-turn:faithfulness [1, 0.5] → mean 0.75, min 0.5 | P, TP | N |

#### Type 10 — Agent and tool use (agentic RAG)

| # | Metric (aliases) | Inputs | Method | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|
| 10.1 | `tool-called` | TC | A named tool was called (with arguments, n times) | 0 | ↑ | — | TP | Y |
| 10.2 | `tool-not-called` | TC | None of the named tools was called | 0 | ↑ | — | TP | Y |
| 10.3 | `allowed-tools` | TC | Only allow-listed tools were called | 0 | ↑ | — | TP | Y |
| 10.4 | `max-tool-calls` | TC | Call count ≤ max | 0 | ↑ | — | TP | Y |
| 10.5 | `tool-sequence` | TC | The expected order (subsequence, or strict) | 0 | ↑ | — | TP | Y |
| 10.6 | `tool-args-valid` | TC + schemas | Arguments match each tool's JSON Schema | 0 | ↑ | — | TP | Y |
| 10.7 | `tool-call-accuracy` (Ragas ToolCallAccuracy) | TC, RTC | `strictOrder` (default) or sorted. Per name-matched pair, the share of reference arguments equal (`str(pred)==str(ref)`, extra arguments not penalised; or a string-similarity / judge comparison); sum / len(reference) × sequence-aligned (a length mismatch → 0); both empty → 1 | 0 | ↑ | 2 of 3 aligned with full arguments → 0.667 | R, N | P |
| 10.8 | `tool-call-f1` (Ragas ToolCallF1, NVIDIA ToolCalling name / name+args accuracy) | TC, RTC | F1 over (name, frozen arguments) sets, ignoring order (duplicates collapse) | 0 | ↑ | 2 expected, 3 called incl. 1 extra: P 2/3, R 1 → 0.8 (Ragas docs print 0.67 here, a docs error) | R, N | N |
| 10.9 | `tool-correctness` (DeepEval ToolCorrectness) | TC, RTC (available tools optional) | Correct tools / tools called. Options: `exactMatch`, `ordering`, `params`. With available tools, the score = min(deterministic score, the judge's optimality score) | 0–1 | ↑ | 2 of 3 → 0.667 | D | P |
| 10.10 | `argument-correctness` (DeepEval) | Q, TC, J | Calls with correct arguments / calls (judged, no reference) | 1 | ↑ | 3 of 4 → 0.75 | D | N |
| 10.11 | `goal-accuracy` (Ragas AgentGoalAccuracy with / without reference; TruLens agent_goal_accuracy; promptfoo trajectory:goal-success) | T or TC trace, GOAL optional, J | Call 1 infers `{user_goal, end_state}`; call 2 compares end_state with the reference (or with the inferred goal when there is none); binary | 2 | ↑ | Goal reached → 1 | R, T, P, N | N |
| 10.12 | `task-completion` (DeepEval) | Trace, J | AlignmentScore(task, outcome) | 1–2 | ↑ | 0.8 | D | N |
| 10.13 | `step-efficiency` (DeepEval) | Trace, J | Penalises steps not strictly needed | 1 | ↑ | 0.6 | D | N |
| 10.14 | `plan-adherence` (DeepEval, TruLens) | Trace with a plan, J | AlignmentScore((task, plan), steps); no stated plan → 1 | 1 | ↑ | — | D, T | N |
| 10.15 | `plan-quality` (DeepEval, TruLens) | Trace with a plan, J | AlignmentScore(task, plan); no stated plan → 1 | 1 | ↑ | — | D, T | N |
| 10.16 | `mcp-use` (DeepEval MCP Use) | MCP calls, servers, J | Primitives used against those available, with argument quality | 1 | ↑ | — | D | N |
| 10.17 | `mcp-task-completion` (DeepEval) | T with MCP calls, J | Satisfied interactions / interactions | 1 | ↑ | — | D | N |
| 10.18 | `tool-selection` (Phoenix tool selection / invocation / response handling) | Q, TC, J | Labels: right tool, right invocation, response used correctly | 1 | ↑ | — | A | N |

#### Type 11 — Operational

| # | Metric | Inputs | Formula | Dir | Example | Src | Has |
|---|---|---|---|---|---|---|---|
| 11.1 | `latency` | timing | End-to-end ms ≤ max; aggregates p50/p95 | ↓ | 1,820 ms ≤ 3,000 → pass | TP | Y |
| 11.2 | `ttft` (`first-token`) | stream timing | ms until the first delta | ↓ | 240 ms | TP | Y |
| 11.3 | `tokens` | U | input / output / total ≤ max | ↓ | — | TP | Y |
| 11.4 | `cost` (cost per answer) | U + price table | The system under test's cost per answer | ↓ | $0.0031 | TP | Y |
| 11.5 | `judge-cost` | the ledger | Judge and embedding spend per sample (always recorded) | ↓ | $0.0012 | TP | N |
| 11.6 | `context-size` | C | Chunks, characters and estimated tokens retrieved, within bounds | ↓ | 8 chunks, 6.1k tokens | TP | N |
| 11.7 | `context-usage` | A, C | Cited (or captured-as-used) chunks / retrieved chunks, deterministic | ↑ | 2 of 8 → 0.25 | TP | N |
| 11.8 | `error-rate` | status | Share of samples with a system error (HTTP ≥ 500, timeout, mapping failure) | ↓ | 3 of 500 → 0.006 | TP | P (status per test) |
| 11.9 | `throughput` | timing | Samples per minute at the configured concurrency | ↑ | 92 / min | TP | N |
| 11.10 | `retrieval-score-stats` | C scores | Top-1 score, the gap between the top 2, and the share under a floor (for low-confidence retrieval) | ↑ | Top 0.82, gap 0.03 | TP | N |

#### Type 12 — Multimodal RAG (images in the retrieved context)

| # | Metric (aliases) | Measures | Inputs | Method / formula | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|---|
| 12.1 | `multimodal-faithfulness` (Ragas `multimodal_faithfulness`, MultiModalFaithfulness) | The answer can be inferred from the visual or textual context | A, C + IMG, JV | `mode: binary` (Ragas parity, the default): one vision-judge call with the answer and every context as content parts (text, image), returning `{reasoning, verdict}` → 0/1. `mode: claims`: the answer split into claims, each judged against text and images; supported / claims, with each claim's evidence naming the image or chunk | 1 (binary) / 2 (claims) | ↑ | "The Tesla Model X is an electric SUV." with a Model X image → 1 (Ragas docs); "Cats are cute." → 0 | R | N |
| 12.2 | `multimodal-relevance` (Ragas `multimodal_relevance`, MultiModalRelevance) | The answer is relevant to the question and aligned with the visual / textual context | Q, A, C + IMG, JV | One vision-judge call → 0/1 with reasoning | 1 | ↑ | Q "What about the Tesla Model X?" + image: "an electric SUV made by Tesla" → 1; "Cats are cute." → 0 (Ragas docs) | R | N |

#### Type 13 — Text-to-SQL RAG

| # | Metric (aliases) | Measures | Inputs | Method / formula | Calls | Dir | Worked example | Src | Has |
|---|---|---|---|---|---|---|---|---|---|
| 13.1 | `datacompy-score` (Ragas `datacompy_score`, DataCompyScore) | The generated query returns the same data as the reference query | SQL + DB, or the results as CSV/JSON | Both queries run through the read-only SQL executor (§4k), or results given as CSV are used as they are (Ragas parity). The result sets are compared after type normalisation (numbers, dates, NULL). `mode: rows` (default): rows are compared as multisets, unless `ordered: true`. `mode: columns`: columns are compared by name, or by position with `byPosition`. P = matching rows (columns) / response rows, R = matching / reference rows; `metric: f1` (default), `precision` or `recall`. A response query that fails to run scores 0 with the error; a failing reference query is a configuration error. The items list sample missing and extra rows | 0 | ↑ | Response 6 rows, reference 5, 4 matching → P 0.667, R 0.8, F1 0.727 | R | N |
| 13.2 | `sql-equivalence` (Ragas `sql_query_equivalence`, SQLSemanticEquivalence, legacy LLMSQLEquivalence) | The generated and reference SQL are semantically equivalent given the schema | SQL, RC (schema DDL) or DB (schema introspected, bounded), J | One judge call: `{response_explanation, reference_explanation, equivalent}` → 0/1. Syntax that does not change the meaning (`active = 1` vs `active = true`, JOIN vs INNER JOIN) counts as equivalent | 1 | ↑ | `JOIN … SUM … GROUP BY` vs `INNER JOIN … SUM … GROUP BY` → 1; `SUM(oi.quantity)` vs `COUNT(oi.quantity)` → 0 (Ragas docs) | R | N |

Out of scope, listed so the catalogue is complete:
* DeepEval's image metrics (text-to-image, image editing, image coherence/helpfulness) and multimodal G-Eval: these
  judge generated images, not RAG answers.
* DeepEval `system_one` / `hybrid` eval modes: our judges are the user's own models. A "small classifier" path exists
  through 3.2 and 7.14 endpoints.
* NeMo Guardrails AlignScore: can be plugged in as the `faithfulness` verifier endpoint, the same way as 3.2.

### 2.4 Catalogue counts

| Type | Metrics | Has Y | Has P | Has N |
|---|---|---|---|---|
| 1 Retrieval, judged | 6 | 2 | 2 | 2 |
| 2 Retrieval, IR/ID | 12 | 0 | 1 | 11 |
| 3 Generation | 16 | 3 | 5 | 8 |
| 4 Claim-level | 11 | 0 | 5 | 6 |
| 5 Lexical / string / structure | 15 | 7 | 1 | 7 |
| 6 Embedding | 3 | 1 | 0 | 2 |
| 7 Judge templates | 14 | 1 | 2 | 11 |
| 8 Safety and quality | 13 | 3 | 1 | 9 |
| 9 Conversational | 11 | 0 | 0 | 11 |
| 10 Agent and tool | 18 | 6 | 2 | 10 |
| 11 Operational | 10 | 4 | 1 | 5 |
| 12 Multimodal | 2 | 0 | 0 | 2 |
| 13 Text-to-SQL | 2 | 0 | 0 | 2 |
| **Total** | **133** | **27** | **20** | **86** |

By source, counting a metric once for each library that has it (computed from the Src column): Ragas 38, DeepEval 33,
NVIDIA 32, TruLens 19, Arize Phoenix 16, Braintrust 12, RAGChecker 11, promptfoo 11, IR/BEIR 8, LangSmith 4, other papers
3, TestPion's own 26.

NVIDIA's 32 cover:
* its own metrics in Ragas;
* NeMo / Helix retriever metrics (recall, precision, nDCG, MAP, reciprocal rank, success, R-precision);
* Helix RAG, similarity and agentic metrics;
* the LLM-judge metric;
* Nemotron reward models.

The catalogue's unit test regenerates these counts from the registry, so the docs never drift. Custom metrics come on
top of the 133: 7 kinds (§4d). Ragas' *available metrics* list is covered item by item in §2.6.

### 2.5 Research findings that shape the design

1. **Claim decomposition plus per-item verdicts is the core shared by Ragas, DeepEval and RAGChecker.** One call that
   returns all verdicts as JSON costs less than one call per claim, and it is what TestPion already does
   (`judgeItems`). The RAGChecker family shows that one extraction pass can feed 11 metrics, so passes are shared
   (§4c).
2. **The same name means different things.** For example:
   * DeepEval's *hallucination* compares against ground-truth context, and its direction changed between versions.
   * Ragas *answer correctness* is factual F1 plus similarity, while TestPion's `answer-correctness` is Ragas's
     *factual correctness*.
   * DeepEval *faithfulness* checks contradiction; Ragas checks support.

   So every metric has a canonical id, explicit aliases, a `direction`, and a `mode` where libraries differ.
3. **Retrieval with known ids needs no LLM.** NVIDIA's retriever evaluation and BEIR use nDCG@10 and recall@k. They
   are free, deterministic and the best CI gate, so they ship in R1.
4. **Judges are biased and noisy.** Zheng et al. measured position consistency of 23.8–65%, a 91% verbosity-attack
   success rate on weaker judges, and self-preference. The mitigations:
   * binary verdicts or verdicts with explanations first (Hamel Husain, LangSmith, Phoenix);
   * reference-guided judging;
   * judging both orders (NVIDIA's two-prompt metrics; ties on disagreement);
   * small-model juries (PoLL beats a single GPT-4 on κ at 7–8× lower cost);
   * a different model family from the generator.
5. **Calibrate against humans.** Report Cohen's κ and TPR/TNR, not raw agreement. Use about 100 labels per failure mode;
   PPI or ARES gives confidence intervals from about 150 labels.
6. **Temperature 0 is not deterministic.** In one test, 1000 calls gave 80 distinct outputs. So: cache by content hash,
   record the judge identity and prompt version (TestPion already stores `promptVersion` and `configHash`), and offer
   repeat-N with a flip rate. DeepEval's cache is also keyed by test-case content plus metric configuration.
7. **Mapping the response to a sample is a pain point everywhere.** promptfoo uses `contextTransform` (a JS
   expression); LangSmith asks for `documents` from the target function. Click-to-map plus a script escape hatch beats
   both.
8. **Test-set quality depends on filtering.** DeepEval uses a critic for self-containment and clarity plus a
   context-quality critic. ARES keeps a query only if its source passage ranks first. "Know Your RAG" warns that
   generated sets skew to simple fact questions, and that the unanswerable class matters.

### 2.6 Ragas coverage: every item of the *available metrics* list

Source: https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/ (and each linked page; Collections API,
docs dated 2025-12-09; read 2026-10-16/17).
* **Aliases.** Every name in the *Ragas names* column is a registered alias: the snake_case name, the Collections class,
  the legacy class and the output key.
* **Parity options.** Each alias carries the options that give Ragas' own semantics.
* **Status and release.** "Today" is the status in TestPion now; "Release" is when the Ragas-parity version ships (§5).

| Ragas group | Ragas metric | TestPion id | Ragas names (all aliases) | Ragas-parity options the alias applies | Today | Release |
|---|---|---|---|---|---|---|
| RAG | context_precision | `context-precision` (1.1) | context_precision, ContextPrecision, LLMContextPrecisionWithReference, llm_context_precision_with_reference | `perChunk: true` (one verdict call per chunk, as Ragas does; TestPion's default batches) | Y | R1 |
| RAG | ↳ without reference | `context-utilization` (1.2) | context_utilization, ContextUtilization, LLMContextPrecisionWithoutReference, llm_context_precision_without_reference | `perChunk: true` | P | R2 |
| RAG | ↳ non-LLM | `context-precision-lexical` (2.3) | non_llm_context_precision_with_reference, NonLLMContextPrecisionWithReference | `distance: levenshtein`, `threshold: 0.5` | N | R1 |
| RAG | ↳ ID-based | `context-precision-ids` (2.1) | id_based_context_precision, IDBasedContextPrecision | — | N | R1 |
| RAG | context_recall | `context-recall` (1.3) | context_recall, ContextRecall, LLMContextRecall, llm_context_recall | — | Y | R1 |
| RAG | ↳ non-LLM | `context-recall-lexical` (2.4) | non_llm_context_recall, NonLLMContextRecall | `threshold: 0.5` (strictly greater) | N | R1 |
| RAG | ↳ ID-based | `context-recall-ids` (2.2) | id_based_context_recall, IDBasedContextRecall | — | N | R1 |
| RAG | context_entities_recall | `context-entity-recall` (1.4) | context_entities_recall, context_entity_recall, ContextEntityRecall | `mode: llm`, `caseSensitive: true` | P (regex mode) | R1 regex, R2 Ragas `llm` mode |
| RAG | noise_sensitivity | `noise-sensitivity-relevant` (4.7) / `noise-sensitivity-irrelevant` (4.8) | noise_sensitivity, NoiseSensitivity (`mode: relevant` default; `mode: irrelevant` → 4.8), noise_sensitivity_relevant, noise_sensitivity_irrelevant | Ragas' per-context NLI (2K + 3 calls) with `ragasCalls: true`; the default shares the claim pass | N | R2 |
| RAG | response_relevancy | `answer-relevance` (3.5) | response_relevancy, answer_relevancy, ResponseRelevancy, AnswerRelevancy | `mode: reverse-questions`, `strictness: 3`, `clamp: false` | P | R1 |
| RAG | faithfulness | `faithfulness` (3.1) | faithfulness, Faithfulness, faithful (output key) | `strictness: support`, `emptyScore: nan` → n/a | Y | R1 |
| RAG | ↳ HHEM | `faithfulness-hhem` (3.2) | faithfulness_with_hhem, FaithfulnesswithHHEM | — | N | R2 |
| RAG | multimodal_faithfulness | `multimodal-faithfulness` (12.1) | multimodal_faithfulness, multi_modal_faithfulness, MultiModalFaithfulness | `mode: binary` | N | R3 |
| RAG | multimodal_relevance | `multimodal-relevance` (12.2) | multimodal_relevance, multi_modal_relevance, MultiModalRelevance | — | N | R3 |
| NVIDIA | answer_accuracy | `answer-accuracy` (3.8) | answer_accuracy, AnswerAccuracy, nv_accuracy | — (two judges 0/2/4, swapped) | N | R2 |
| NVIDIA | context_relevance | `context-relevance` (1.5) | context_relevance, ContextRelevance, nv_context_relevance | `mode: nvidia` (this is also the canonical default, so the bare id behaves like Ragas) | N | R1 |
| NVIDIA | response_groundedness | `response-groundedness` (3.3) | response_groundedness, ResponseGroundedness, nv_response_groundedness | — | N | R2 |
| Agents | topic_adherence | `topic-adherence` (9.7) | topic_adherence, TopicAdherence, TopicAdherenceScore | `mode: f1` (precision / recall selectable) | N | R3 |
| Agents | tool_call_accuracy | `tool-call-accuracy` (10.7) | tool_call_accuracy, ToolCallAccuracy | `strictOrder: true`, `args: exact-string` | P | R1 (deterministic); R3 adds judge argument comparison |
| Agents | tool_call_f1 | `tool-call-f1` (10.8) | tool_call_f1, ToolCallF1 | — | N | R1 |
| Agents | agent_goal_accuracy | `goal-accuracy` (10.11) | agent_goal_accuracy, AgentGoalAccuracy, AgentGoalAccuracyWithReference (`reference: true`), AgentGoalAccuracyWithoutReference (`reference: false`) | — | N | R3 |
| NL comparison | factual_correctness | `factual-correctness` (3.6) | factual_correctness, FactualCorrectness | `mode: f1`, `beta: 1`, `atomicity: low`, `coverage: low`, round to 2 decimals | Y (as today's `answer-correctness`) | R1 |
| NL comparison | semantic_similarity | `semantic-similarity` (6.1) | semantic_similarity, SemanticSimilarity, answer_similarity, AnswerSimilarity | — | Y | R1 |
| NL comparison | non_llm_string_similarity | `string-similarity` (5.5) | non_llm_string_similarity, NonLLMStringSimilarity | `distance: levenshtein`, no case folding, no trim | N | R1 |
| NL comparison | bleu | `bleu` (5.6) | bleu, bleu_score, BleuScore | `segmentation: ragas` (split on ". ", corpus BLEU / 100) | N | R1 |
| NL comparison | chrf | `chrf` (5.8) | chrf, chrf_score, CHRFScore, ChrfScore | sacreBLEU defaults (char order 6, word order 0, β 2) | N | R1 |
| NL comparison | rouge | `rouge` (5.7) | rouge, rouge_score, RougeScore | `type: rougeL`, `mode: fmeasure` *(verify the Ragas default type)* | N | R1 |
| NL comparison | string_presence | `contains` (5.2) | string_presence, StringPresence | `ignoreCase: false`, `trim: false` | Y | R1 |
| NL comparison | exact_match | `exact-match` (5.1) | exact_match, ExactMatch | `trim: false`, `ignoreCase: false` (byte-exact) | Y | R1 |
| SQL | datacompy_score | `datacompy-score` (13.1) | datacompy_score, DataCompyScore | `mode: rows`, `metric: f1`, `inputs: results` (compare CSV given, as Ragas) or `inputs: sql` (run both queries, TestPion's default) | N | R1 |
| SQL | sql_query_equivalence | `sql-equivalence` (13.2) | sql_query_equivalence, sql_semantic_equivalence, SQLSemanticEquivalence, LLMSQLEquivalence | — | N | R2 |
| General purpose | aspect_critic | `pass-fail` (7.2) | aspect_critic, AspectCritic (`definition` → `criteria`), plus the predefined harmfulness, maliciousness, coherence, correctness, conciseness | `votes: strictness` (odd) | P | R1 (judge-template engine) |
| General purpose | simple_criteria | `simple-criteria` (7.3) | simple_criteria, SimpleCriteriaScore, DiscreteMetric | `scale: 0-10` (as in the docs example) | P | R1 |
| General purpose | rubrics | `rubric-score` (7.4) | rubrics, rubrics_score, RubricsScore, DomainSpecificRubrics, RubricsScoreWithReference / WithoutReference | `score1_description … score5_description`; `reference: true \| false` | N | R1 |
| General purpose | ↳ instance rubrics | `instance-rubric` (7.5) | instance_rubrics, InstanceRubrics, InstanceSpecificRubrics | per-sample `rubrics` column | N | R1 |
| Other | summarization | `summarization` (3.15) | summarization, summarization_score, summary_score, SummarizationScore, SummaryScore | `mode: ragas` (keyphrases → questions → answers; 0.5·QA + 0.5·conciseness) | N | R2 |
| (source only) | answer_correctness | `answer-correctness` (3.7) | answer_correctness, AnswerCorrectness | `weights: [0.75, 0.25]` | P | R2 |
| (source only) | quoted_spans | `quoted-spans` (5.15) | quoted_spans, QuotedSpansAlignment | `casefold: true`, `minSpanWords: 3` | N | R1 |

**Coverage.** All 29 items of Ragas' list are rows in §2.3. By the end of R1, 19 have Ragas parity (plus their non-LLM
and ID variants and `quoted_spans`), and context_entities_recall runs in its regex mode. R2 brings 25 to parity: the
Ragas `llm` mode of context_entities_recall, plus noise_sensitivity, answer_accuracy, response_groundedness,
sql_query_equivalence and summarization (and answer_correctness from the source). R3 adds
the last 4: multimodal_faithfulness, multimodal_relevance, topic_adherence and agent_goal_accuracy.

**How Ragas names work everywhere** (`eval/rag/aliases.ts`):
* **Resolution.** `resolveMetric(name)` normalises the name: case-insensitive, `_` = `-` = space, CamelCase class names
  → snake_case, and a trailing `Score` / `_score` is dropped when that is unambiguous. It returns `{id, options}`: the
  alias's parity options under the user's own options.
  * The canonical ids were chosen so that a Ragas snake_case name that normalises to a TestPion id (faithfulness,
    context_precision, context_recall, context_relevance, factual_correctness, semantic_similarity, bleu, rouge, chrf,
    exact_match) has Ragas semantics by default. The one exception is `exact-match`, whose default also trims (as
    TestPion does today).
  * The `ragas:` prefix (`ragas:exact_match`, `ragas:context_precision`) always applies every parity option.
  * An evaluation-level `compat: ragas` applies parity to all metrics in it.
* **Where names are accepted.** `resolveMetric` is the only resolver, so the names work in:
  * YAML (`type:` / `metric:` in `assertions`, `evaluators`, `metrics`, custom `formula` references such as
    `0.5*faithfulness + 0.5*response_relevancy`);
  * the CLI (`--metric faithfulness`, `--metrics response_relevancy,context_precision`, `rag metric show
    LLMContextRecall`);
  * MCP arguments;
  * picker search (typing `nv_accuracy` finds answer-accuracy);
  * `--min` gates (`--min faithfulness=0.8`).

  The matrix header shows the canonical id with the alias the user picked.
* **Dataset import** (`rag import --from ragas`, or auto-detected by column names). It reads `EvaluationDataset` JSONL /
  CSV / HF-exported JSON:
  * `SingleTurnSample` columns: `user_input`, `retrieved_contexts`, `reference_contexts`, `retrieved_context_ids`,
    `reference_context_ids`, `response`, `multi_responses`, `reference`, `rubrics`; `persona_name`, `query_style` and
    `query_length` become tags.
  * `MultiTurnSample`: `user_input` as a message list with `HumanMessage`, `AIMessage` (`tool_calls`) and
    `ToolMessage`, plus `reference`, `reference_tool_calls` and `reference_topics`.
  * Context items that are image URLs or data URIs become IMG inputs.
  * A record with `response` is scored offline.
* **Export.**
  * `rag export <run> --format ragas` writes the same columns with the captured `response` / `retrieved_contexts`, plus
    one column per metric. `--names ragas` names the columns by their Ragas names (`faithfulness`, `answer_relevancy`,
    `nv_accuracy` …), so a team can run Ragas on the same file and compare.
  * Ragas `EvaluationResult` CSVs can be imported as an *external* variant column in the matrix, side by side with
    TestPion's scores for the same samples.
* **Tests.** A unit test resolves every name in this table (and Ragas' 29 list names) to the right `{id, options}`.
  Each row's Ragas worked example runs through the resolved metric (§5.1, item 9).

---

## 3. Goals, non-goals, journeys

### Goals
* Test **any RAG system the user runs** (HTTP JSON, SSE / streaming chat, WebSocket, gRPC, MCP tool, OpenAI-compatible)
  with no code in the system under test.
* **Every metric in §2.3 can be selected, configured, tried on one sample and run on a dataset.** Each shows its inputs,
  its method, its cost per sample and a worked example.
* **Custom metrics** of 7 kinds, kept as workspace files, treated as equals of the built-in ones.
* **Evaluation matrix**: samples × metrics (grouped by type) × variants, with a threshold per metric, baselines,
  regressions, drill-down and export.
* **CI gates and monitors** on metric thresholds; everything available over the CLI with `--json` and over MCP.
* **Cost under control**: an estimate before every run, caps, a cache, and local judges.

### Non-goals (these four releases)
* Hosting vector databases or building RAG pipelines. `runRag` stays as the simulation path.
* Fine-tuning judges (ARES style). We use calibration and juries instead.
* Running Python Ragas or DeepEval inside TestPion. The metrics are reimplemented in TypeScript (host-agnostic, no
  Python on cloud runners) and proven against the libraries' worked examples. An export to Ragas / DeepEval formats is
  there for cross-checks.
* Image-generation metrics (text-to-image, image editing), and SQL beyond read-only execution and result comparison.

### User journeys
1. **Connect.** *AI Lab ▸ RAG ▸ Connect a RAG system* (or *Evaluations ▸ New ▸ RAG evaluation*).
   1. Pick a saved request (HTTP/SSE/WS/gRPC/MCP) or a preset (OpenAI-compatible, LangServe, LlamaIndex, Haystack, Dify,
      Flowise).
   2. Type a probe question and click **Probe**.
   3. In the raw response, click the answer → *This is the answer*, and the sources array → *These are the contexts*
      (then the id, text and score inside one item).
   4. The extracted sample shows; save it as a **RAG target**.
2. **Dataset.** Import `golden.csv`, a Ragas or DeepEval JSONL, or BEIR qrels, or pick a workspace dataset. The column
   mapper assigns `question`, `reference`, `reference_ids`, `tags` and the rest.
3. **Metrics.**
   1. The **metric picker** lists every metric grouped by type, with search ("faith", "ndcg", "toxic").
   2. Presets: *RAG triad*, *Ragas core*, *DeepEval RAG*, *NVIDIA RAG*, *RAGChecker*, *Retrieval only (no LLM)*, and more
      (§4c).
   3. Each row shows its inputs (greyed with the missing-input message if the dataset lacks one), its method badge
      (judge / embedding / lexical / IR / deterministic), its calls per sample, and ⓘ with the formula and worked
      example.
   4. The footer keeps a running estimate for the chosen set: "≈ 6.2 calls per sample · 500 samples · ≈ 3,100 calls ·
      ≈ $2.10 with gpt-4o-mini · 0 cached".
4. **Try this metric on one sample.** On any row (or the whole selection), pick a sample from the dataset, or the probe's
   live answer, and click **Try**. The panel shows:
   * the inputs it read;
   * **What will be sent** (the exact judge prompt, after redaction, with a token estimate);
   * after the user confirms: the raw judge output, the score against the threshold, the items with their evidence, and
     the real cost.
5. **Custom metric.** *Metrics ▸ New custom metric*:
   1. Describe what good looks like ("answers in the clinic's tone, never promises a diagnosis").
   2. AI drafts a rubric and 4 example samples (2 good, 2 bad) as a proposal; review and edit it.
   3. *Try on one sample* for each example; the verifier marks the draft "agrees with all 4 examples".
   4. Save it as `metrics/clinic-tone.yaml`. It now appears under *Custom* in the picker, in presets, in the matrix and in
      CI gates.
6. **Run.** The estimate dialog (calls, tokens, cost, cache hits, caps, and "will send 500 questions to support.example.com")
   leads to a confirmation. Progress streams; RAG calls and judge calls are rate-limited separately.
7. **Matrix.** One column per selected metric, grouped by type (retrieval | generation | …), each with its threshold.
   The header row holds aggregates (mean, p10, pass rate, 95% CI, a distribution sparkline). Rows group by tag. Other
   pivots are available.
8. **Compare.** Choose a baseline run: cells turn red or green per metric, and a *Regressions* list is sorted by drop.
9. **Debug a bad sample.** Click a red cell. The drill-down shows:
   * the question;
   * retrieved chunks with their rank, score and verdict, and missed gold chunks in a lane of their own;
   * the answer with claims highlighted and linked to chunks;
   * that metric's verdicts and judge reasoning, then the other metrics;
   * the raw exchange and trace.

   Rate it good or bad: the review later calibrates judges.
10. **Analyse failures.** AI clusters the low-scoring samples by failure taxonomy and text (reusing triage).
11. **CI.** *Set up CI* writes `testpion rag run golden --target support-bot --min faithfulness=0.85 --min ndcg@10=0.6
    --baseline main --junit out.xml`. The exit code is non-zero on a failed gate or a regression.
12. **Generate a test set** from documents or exported chunks: a reviewed proposal, verified answerable (R4).
13. **Monitor.** An hourly 50-question smoke subset with IR metrics and sampled judge metrics; alerts on a gate breach.

---

## 4. Design

### 4a. Model: the RAG target and the sample

New module `packages/core/src/model/rag-types.ts` (types.ts is at its ceiling):

```ts
/** How to read a RAG sample out of a protocol response. Paths are JSONPath (default) or JMESPath (`jmes:` prefix) or a tp script. */
export interface RagMapping {
  answer: string;                       // "$.answer" | "$text" | "$.choices[0].message.content" | "stream:delta"
  contexts?: string;                    // "$.source_documents[*]"
  context?: { text?: string; id?: string; score?: string; source?: string; title?: string; url?: string; metadata?: string }; // relative to one item
  citations?: string;                   // "$.citations[*].doc_id", or "markers" (parse [1]/[id] in the answer)
  usage?: { input?: string; output?: string; total?: string };
  conversationId?: string;              // value carried to the next turn
  script?: string;                      // tp script returning { answer, contexts, … } for anything paths cannot express
}

/** A RAG system under test: a step of any protocol plus its mapping. Saved in library/rag-targets.json (per workspace). */
export interface RagTarget {
  id: string; name: string;
  /** A saved request (collection item ref), or an inline step (http | websocket | grpc | mcp | graphql | llm). The question goes in through {{question}}, history through {{history}} / {{conversationId}}. */
  request: { ref?: ItemRef; step?: TestCase };
  mapping: RagMapping;
  stream?: { mode: 'sse' | 'websocket' | 'ndjson'; delta: string; done?: string; contextsEvent?: string };
  conversation?: { mode: 'stateless-history' | 'server-session'; historyFormat?: 'openai-messages' | 'text'; idPath?: string };
  limits?: { concurrency?: number; requestsPerMinute?: number; timeoutMs?: number; retries?: number };
  preset?: 'openai-chat' | 'openai-assistants' | 'langserve' | 'llamaindex' | 'haystack' | 'dify' | 'flowise' | 'custom';
}

export interface RagSample {
  question: string; answer?: string; reference?: string;
  contexts?: RetrievedDoc[]; referenceContexts?: string[]; referenceIds?: string[]; relevance?: Record<string, number>; // graded
  turns?: Array<{ role: 'user' | 'assistant'; content: string; contexts?: RetrievedDoc[] }>;
  toolCalls?: ToolCallRef[]; referenceToolCalls?: ToolCallRef[];
  rubrics?: Record<string, string>; referenceTopics?: string[]; answerable?: boolean; tags?: string[]; metadata?: Record<string, unknown>;
}
```

`RetrievedDoc` gains optional `rank`, `title`, `url`, `metadata` (kept in `rag-types.ts` as `RagDoc extends RetrievedDoc`
to avoid growing types.ts).

**`rag` test type extension (backwards compatible):** `RagTest` keeps `contexts`/`answer`/`model` (offline and
simulation modes) and gains `target?: string | RagTarget` and `metrics?: MetricConfig[]` (alias of `evaluators`).
Resolution order: `answer`+`contexts` given → offline scoring; `target` → call the system; `model` → simulate (today).
The loader also accepts `contexts: "{{var}}"` (resolved at run time to an array) so a flow can feed a rag step from an
HTTP step's `extract`.

**Mapping for every protocol** — implemented once in `packages/core/src/eval/rag/capture.ts`: input is the step's
`CheckContext` (`body`, `text`, headers, `received[]` for WebSocket, SSE events from `http/client.ts`, gRPC message
stream, MCP tool result). Streaming assembly: SSE `data:` deltas concatenated by `stream.delta` path until `done`; a
separate event carrying sources (`contextsEvent`, common in LangServe/LlamaIndex streaming) mapped by `contexts`.
TTFT from the first delta (feeds `first-token`). WebSocket: messages filtered by a predicate path, same assembly.

**Presets** (`eval/rag/presets.ts`): request template + mapping defaults, e.g.
* OpenAI-compatible chat: `POST {{baseUrl}}/v1/chat/completions` → answer `$.choices[0].message.content`, usage
  `$.usage.*`; contexts by convention from `$.context`/`$.citations` or none (answer-only metrics).
* OpenAI Assistants/Responses with file search: annotations → citations, `file_citation` ids → contexts ids.
* LangServe `/invoke`: `$.output.answer`, `$.output.context[*].page_content`, `metadata.source`.
* LlamaIndex (`/query`): `$.response`, `$.source_nodes[*].node.text`, `node.id_`, `score`.
* Haystack (Hayhooks / REST API): `$.answers[0].data`, `$.documents[*].content`, `id`, `score`.
* Dify (`/v1/chat-messages`): `$.answer`, `$.metadata.retriever_resources[*].content`, `document_id`, `score`;
  `conversation_id` carried.
* Flowise (`/api/v1/prediction/{id}`): `$.text`, `$.sourceDocuments[*].pageContent`, `metadata.source`.
Each preset is just data; user edits it. Presets are verified with recorded fixtures in tests (no live calls).

**Connect UI** (`apps/desktop/src/components/rag/RagConnect.tsx`): pick request/preset → probe question → raw response
in the shared `JsonView` with a **mapping picker** (click a value → popover *Answer / Contexts (this array) / Context
text / id / score / Citations / Tokens / Conversation id*); the JSONPath is written into the mapping fields (editable);
for SSE the event list (`SseEvents.tsx`) gets the same picker. The extracted `RagSample` preview updates live. AI assist:
*Suggest mapping* (task `rag-suggest-mapping`, small tier, response shape only at privacy `metadata` — values not
needed), verified by applying the mapping to the probe response.

**Multi-turn**: a dataset record with `turns` runs sequentially in one "conversation lane" (concurrency is across
conversations, never within). Modes: `stateless-history` (TestPion sends `{{history}}` in the template each turn) and
`server-session` (carry `conversationId` from the mapping, plus cookies). Each assistant turn is captured with its own
contexts so single-turn metrics run per turn (#55) and conversational metrics run on the whole transcript (#50–54).

**Auth, limits, retries**: from the saved request's environment/secrets/auth as today; target-level `concurrency`,
`requestsPerMinute` (reuse `RateLimiter`/`Semaphore`, `util/concurrency.ts:4,90`), retry on 429/5xx with backoff
(`withRetry`), per-call timeout. Production guard applies (a RAG call is a POST → treat chat endpoints as read-only via a
target flag `readOnly: true` the user sets once, else production consent is asked).

**Recorded responses / offline re-scoring**: each sample's captured `RagSample` (answer + contexts, bounded: 20 chunks ×
8 KB, redacted) is stored in the result's `metadata.rag.sample`. `testpion rag rescore <runId> --metrics …` and *Re-score*
in the UI re-run metrics on stored samples without calling the RAG (new run, `origin: { kind: 'rescore', fromRunId }`),
which makes metric/judge changes cheap to compare. Pinned responses (`execute.ts:332`) remain for single steps.

### 4b. Dataset schema, import, generation

Canonical record (JSONL; CSV columns with `;`-separated lists or JSON cells):
`id, question, reference, reference_contexts, reference_ids, relevance (id→grade), answerable, rubric, tags, turns, metadata`.
Field aliases accepted on read: Ragas (`user_input`, `reference`, `reference_contexts`, `retrieved_contexts`,
`response`, `reference_context_ids`), DeepEval goldens (`input`, `expected_output`, `context`, `retrieval_context`,
`actual_output`, `additional_metadata`), promptfoo (`vars.query`, `vars.context`, `assert`), BEIR (`queries.jsonl` +
`qrels/test.tsv` + `corpus.jsonl` → `reference_ids` + `relevance`). Implemented as `eval/rag/dataset-import.ts`
(pure functions over records; `readDataset` keeps streaming). A record that already has `response` +
`retrieved_contexts` runs **offline** (score logs from production without calling anything): "capture-from-traffic".

**Capture from traffic**: the Debugger and History already store exchanges; *Save as RAG samples* maps selected
exchanges through a target's mapping into dataset rows (`appendDatasetRow`), questions de-duplicated; reference answers
left empty for review (or drafted by AI as a proposal, clearly marked "model-written reference — review").

**AI test-set generation** (`ai/tasks` task `rag-generate-dataset`, large tier): input = documents (workspace files,
pasted text, or chunks exported from the user's vector DB as JSONL with ids) → chunking (headings/paragraphs, size
budget) → sample chunks (diversity by embedding clusters when embeddings available, else by position) → per chunk or
chunk pair: question types *single-hop specific*, *multi-hop specific/abstract*, *unanswerable (negative)*, with
optional personas and styles (Ragas/DeepEval evolutions) → reference answer + `reference_ids`. **Verifiers**
(`ai/verify.ts` new `rag-answerable`): (1) the reference's claims are all supported by its source chunks (judge,
`faithfulness` of reference vs chunk), (2) the question is not a copy of chunk text (lexical overlap < 0.8), (3)
dedupe by embedding cosine < 0.92, (4) unanswerable ones are not answerable from the corpus sample. Output is a
**proposal** (ProposalReview) — rows the user accepts into a dataset; cost estimated before running.

### 4c. Metric engine (packages/core/src/eval/rag/)

#### Registry
`metric-registry.ts` defines the one contract that built-in **and custom** metrics share:

```ts
export interface MetricDef {
  id: string;                 // 'faithfulness', 'ndcg@k', 'custom/clinic-tone'
  aliases: string[];          // 'groundedness', 'ContextualPrecision', 'nv_accuracy' …
  type: 'retrieval-judged' | 'retrieval-ir' | 'generation' | 'claims' | 'lexical' | 'embedding' | 'judge-template'
      | 'safety' | 'conversation' | 'agent' | 'operational' | 'custom';
  method: 'judge' | 'embedding' | 'lexical' | 'ir' | 'deterministic' | 'composite' | 'script' | 'classifier';
  direction: 'higher' | 'lower' | 'none';
  requires: InputCode[];      // §2.2 codes; `optional` lists those that only refine it
  options: JsonSchema;        // mode, k, strictness, weights … (the picker's settings form, validated)
  defaultThreshold?: number;
  estimate(sample: SampleShape, opts): { llmCalls: number; embedCalls: number; inputTokens: number; outputTokens: number };
  prompts?: PromptRef[];      // versioned prompt ids (judge metrics)
  shares?: string;            // a shared pass id, e.g. 'claims-v1' (type 4 metrics reuse one extraction)
  doc: { what: string; how: string; example: WorkedExample; sources: string[] };
  compute(sample: RagSample, opts, svc: MetricServices): Promise<MetricResult>;
  version: string;            // bumped with any change to formula or prompt; stored with every score
}
export interface MetricResult { score: number | null /* n/a */; passed?: boolean; items?: EvidenceItem[]; reasoning?: string;
  subScores?: Record<string, number>; judge?: JudgeIdentity; usage?: JudgeUsage; cached?: boolean; na?: string /* why n/a */ }
```

* `registerMetric()` also calls `registerCheck()` (`checks.ts:62`), so every metric works anywhere a check works:
  `assertions:` and `evaluators:` of any test, saved evaluations, the matrix, `run_tests` over MCP, AI format docs and
  lint (`checkDocs()`). Old check names stay as aliases.
* `metricCatalogue()` serves the picker, `testpion rag metrics`, MCP `rag_metrics`, `docs/ai-testing/rag-metrics.md`
  (generated) and the counts test.
* **Shared passes.** Claim extraction (types 3 and 4), statement extraction and chunk verdicts are computed once per
  sample and keyed by `shares`. Picking `faithfulness`, `claim-precision` and `noise-sensitivity-relevant` together costs
  one extraction and one checking pass, not three.
* **n/a is not 0.** A metric whose inputs are present but empty (no claims, no entities, no quotes) returns `score:
  null` with `na: "the answer makes no claims"`. Aggregates count n/a separately. Ragas returns NaN or 1 in these
  cases; DeepEval and promptfoo differ again. Every such choice is documented per metric.

#### File layout (each file under 400 lines)

| File | Contents |
|---|---|
| `metric-registry.ts`, `catalogue-presets.ts` | The contract, registration, presets |
| `sample.ts` | `sampleFromContext(ctx, record)` → `RagSample`; input availability and the §2.2 messages |
| `capture.ts`, `presets-targets.ts`, `stream.ts` | §4a |
| `judge.ts`, `judge-cache.ts`, `estimate.ts` | The judge service (below) |
| `prompts/*.ts` | Versioned prompt builders + JSON Schemas (`claims-v1`, `verdicts-v1`, `nv-answer-accuracy-v1` …) |
| `metrics-retrieval-judged.ts` (type 1), `ir.ts` (type 2), `metrics-generation.ts` (type 3), `claims.ts` (type 4), `lexical.ts` (type 5: BLEU/ROUGE/chrF/edit distances, no dependency), `metrics-embedding.ts` (6), `judge-templates.ts` + `g-eval.ts` + `dag.ts` (7), `safety.ts` (8), `conversation.ts` (9), `agent.ts` (10), `operational.ts` (11) | Moves `context-precision`, `context-recall`, `context-entity-recall`, `groundedness`, `answer-relevance`, `answer-correctness` and `citation` out of `checks.ts` (it shrinks by about 250 lines) |
| `custom/*.ts` | Custom metric kinds (§4d) |
| `aggregate.ts` | Per metric: mean, median, p10, pass rate, n/a count, bootstrap 95% CI (seeded), per-tag breakdown, paired bootstrap for baseline deltas |
| `calibrate.ts` | Judge vs human reviews: Cohen's κ, TPR/TNR, confusion matrix, disagreements |
| `run-target.ts` | Calls the target for a record (single or multi-turn) and returns `RagSample` + timings |

#### Judge service (`judge.ts`)

Every judged metric, built-in or custom, goes through it.

* **Routing.** The judge is chosen in this order:
  1. the metric's own `judge:`;
  2. the evaluation's `judge`;
  3. the AI settings' *large* tier (`resolveAiRoute`, `ai-settings.ts:84`).

  It never falls back silently to `mock`, as `checks.ts:570` does today. With no judge set, the run stops with the
  "Needs a judge model" message. *Local only* is enforced (`assertLocalAllowed`).
* **Juries and swap.** `judges: [a, b, c]` with `aggregate: majority | mean | min` (PoLL). `swap: true` judges in both
  orders and calls a tie when they disagree.
* **Calls** go through `chatStructured` (`structured.ts:147`) with the prompt's JSON Schema and the repair loop, the
  reasoning field before the verdict, temperature 0, a seed when the provider takes one, and a `maxTokens` per prompt.
  Long inputs are split by a per-prompt token budget into several verdict calls, never truncated silently.
* **Cache.** The key is sha256(prompt id@version, provider kind, model, temperature, seed, canonical inputs). It is
  stored in the metastore table `judge_cache` (per workspace, not in git; LRU-capped at 200k rows / 500 MB), with
  embeddings in `embedding_cache`. A hit costs nothing and is marked `cached`. `testpion rag cache clear` empties it.
* **Accounting.**
  * Every judge or embedding call becomes an `AiCallRecord` in the ledger (`storage/ai-usage.ts`), with task
    `rag:<metric>`.
  * Each result carries `metadata.judgeUsage {calls, inputTokens, outputTokens, costUsd, cached}`, kept separate from
    the system-under-test's own `tokens`/`costUsd`.
  * The run summary gets `judgeCostUsd`.
  * Today `askJudge` (`checks.ts:567`) drops the usage.
* **Estimate and caps.**
  * Before a run, `estimate.ts` adds up `MetricDef.estimate()` over the dataset's shape (sampled token sizes) minus the
    predicted cache hits.
  * The run refuses, with the numbers, when it would exceed `dailyTokens` / `dailyBudgetUsd` (`ai-settings.ts:37-41`)
    or a per-run `maxJudgeCostUsd`.
  * During the run, `checkAiCaps` is checked every 50 calls. When a cap is hit, scoring stops: the remaining scores
    become `n/a: budget`, and the run is not left half-written.
* **Concurrency.**
  * The metrics of a sample run in parallel, and samples are bounded by the run's concurrency.
  * Judge calls are bounded by the provider wrapper's limiter (`ai/index.ts:21`); RAG calls by the target's limiter.
    The two are independent.
  * `twoPhase: true` collects all answers first, then scores. That makes `rag rescore` and judge comparisons cheap.
* **Failure taxonomy.** Each result gets `metadata.rag.failure`, set by deterministic rules over the scores:
  `retrieval-miss`, `ranking`, `noise`, `unfaithful`, `incorrect-from-bad-context`, `incomplete`, `off-topic`,
  `false-refusal`, `missed-refusal`, `citation`, `unsafe`, `system-error`, `judge-error`.
* **Determinism and noise.** `repeat: n` re-scores with the cache bypassed (judge noise), and/or calls the target n
  times (system noise). Aggregates then report mean ± sd and a flip rate.

#### Presets (`catalogue-presets.ts`, editable; custom presets are saved in `metrics/presets.yaml`)

| Preset | Metrics |
|---|---|
| RAG triad (TruLens) | context-relevance (chunks), faithfulness, answer-relevance (score) |
| Ragas core | context-precision, context-recall, context-entity-recall, faithfulness, answer-relevance (reverse-questions), factual-correctness, noise-sensitivity-relevant |
| DeepEval RAG | answer-relevance (statements), faithfulness (contradiction), context-precision, context-recall, context-relevance (statements) |
| NVIDIA RAG | answer-accuracy, context-relevance (nvidia), response-groundedness, recall@k, ndcg@k (k = 5, 10) |
| RAGChecker | the 11 claim-level metrics (one shared pass) |
| Retrieval only (no LLM) | context-precision-ids, context-recall-ids, recall@k, precision@k, hit-rate@k, mrr@k, ndcg@k, map@k |
| Free (no model at all) | all of types 2, 5 and 11, plus `context-entity-recall` (regex), `citation`, `no-leak`, `refusal` and deterministic agent checks |
| Answer vs reference | factual-correctness, answer-accuracy, semantic-similarity, rouge, exact-match |
| Safety | toxicity, bias, pii-leakage, no-leak, prompt-injection-resistance, misuse, role-violation, harmfulness |
| Conversational | knowledge-retention, role-adherence, conversation-completeness, turn-relevancy, topic-adherence, per-turn:faithfulness |
| Agentic RAG | tool-call-accuracy, tool-call-f1, argument-correctness, goal-accuracy, task-completion |
| Ops | latency, ttft, tokens, cost, judge-cost, context-size, error-rate |
| Ragas — every metric | All 29 of §2.6 with `compat: ragas`. Rows whose inputs the dataset lacks (images, SQL, turns, tool calls) are greyed with their message, not dropped |
| Ragas NL comparison | factual-correctness, semantic-similarity, string-similarity, bleu, chrf, rouge, contains (string_presence), exact-match |
| Text-to-SQL | datacompy-score, sql-equivalence, latency, error-rate |
| Multimodal | multimodal-faithfulness, multimodal-relevance, context-relevance, answer-relevance |

#### Metric picker (`components/rag/MetricPicker.tsx`, one shared component)

The picker is used in the evaluation editor, in *Try*, in the monitor editor and in the CI dialog.
* **Layout.**
  * Search across ids, aliases and descriptions.
  * Type groups with counts, and preset chips.
  * Filters: *runs without a model*, *needs a reference*, *judge*, *selected*.
* **Each row shows:**
  * name and aliases;
  * a method badge;
  * its inputs (missing ones in amber, with the §2.2 message and a fix button);
  * calls per sample;
  * direction;
  * threshold and options (a form generated from `options`);
  * ⓘ with the formula, the worked example and the source links;
  * **Try**.
* **Footer:** the live estimate (calls, tokens and cost per sample and for the dataset, cache hits) and the cap status.

#### Try on one sample (every metric, built-in or custom)

The RPC is `rag.metric.try {metric | definition, sample | {recordId} | {probe: question}, judge?}`.
1. The **dry step** shows what would be read (the inputs, with missing ones explained) and **What will be sent**: the
   exact prompts after redaction, their token estimate and cost, the shared component from the AI foundations' preview
   (`components/ai/AiPreviewDialog.tsx`).
2. After *Run*, it shows:
   * the raw judge output;
   * any repair attempts;
   * the score against the threshold;
   * the items with their evidence;
   * the reasoning;
   * the real usage and cost.

   Results are cached like any other call. Non-LLM metrics skip the dry step and answer at once.
3. *Pin as example* stores the sample and its result in the metric's examples, which serve as regression cases (§4d).

It is available from the picker, the metric editor, the drill-down ("re-run this metric on this sample with another
judge") and the CLI / MCP (`rag metric test`, `rag_try_metric`).

### 4d. Custom metrics (first-class)

**Principle.** A custom metric is a file that compiles to the same `MetricDef` as a built-in metric. It sits in the same
registry with type `custom`, and the picker, presets, matrix columns, thresholds, baselines, CI gates, monitors, Try,
estimate, cache, ledger and calibration all treat it the same way.

#### Storage
* `metrics/<id>.yaml` in the workspace: git-friendly, diffable and reviewable.
* `metrics/presets.yaml` holds custom presets.
* Ids are namespaced `custom/<id>`; built-in ids are reserved.
* `testpion rag metric import|export` (single files or a bundle) and *Copy to workspace…* share metrics between
  workspaces and teams. A metric may `extends:` another file's definition.
* Every result stores `metric.version` plus the content hash of the definition, so a matrix never mixes scores from two
  versions without saying so ("v3 · changed since baseline").

```yaml
# metrics/clinic-tone.yaml
id: clinic-tone
version: 3
name: Clinic tone
description: Warm, plain-language answers that never promise a diagnosis.
kind: judge                      # judge | checklist | dag | rule | formula | embedding-set | script
inputs: [question, answer]       # what it may see: question, answer, reference, contexts, referenceContexts, conversation
scale: binary                    # binary | 1-5 | 0-10 (with anchors)
criteria: |
  PASS when the answer is polite, uses plain language, and does not state or promise a diagnosis.
anchors: { pass: "…", fail: "…" }   # or 1..5 descriptions for a scale
steps: auto                      # G-Eval style: generated once from criteria and frozen into the file, or a list
reference: free                  # free | guided (the reference answer is shown to the judge)
threshold: 1
direction: higher
judge: { provider: ollama, name: qwen2.5:14b }   # optional; else the evaluation's / AI settings'
examples:                        # regression cases; the verifier runs them
  - { sample: { question: "Is my dog's limp serious?", answer: "It could be a fracture, bring her in today." }, expect: fail }
  - { sample: { question: "…", answer: "…" }, expect: pass }
calibration: { reviewedRun: run_2026-10-20_ab12, kappa: 0.71, tpr: 0.9, tnr: 0.8, at: "2026-10-21" }   # written by Calibrate
```

#### Kinds (all without code except `script`)

| Kind | Definition | Computation | LLM calls | Release |
|---|---|---|---|---|
| `judge` | A natural-language criterion. `scale` is binary, 1–5 or 0–10 with anchors. `steps` are generated (G-Eval) or given. Reference-free or reference-guided. Chooses which inputs it sees. Optional `votes`, `judges` (jury), `swap` | The structured verdict `{reasoning, verdict \| score}`. Logprob weighting when the provider gives logprobs. Normalised to 0–1 | 1 (+1 once for steps, frozen into the file) | R1 |
| `rule` | A deterministic check: regex / not-regex, contains / forbidden terms, length, JSONPath equals / exists, JSON Schema, citation format, PII patterns, numeric bounds; any combination with `all` / `any` / `weights` | Reuses the check functions (`checks.ts`). Score 0/1, or the weighted share of rules passed | 0 | R1 |
| `formula` | An expression over other metrics, e.g. `0.5*faithfulness + 0.5*answer_relevance`, `min(context_recall, faithfulness)`, `gate(faithfulness >= 0.8, answer_accuracy, 0)`, `mean(...)`, `if(...)` | A small safe expression parser: numbers, metric refs, `+ - * /`, `min max mean if gate clamp`, comparisons; no `eval`. Dependencies run first (topological order); cycles are refused at load. n/a propagates unless `coalesce()` is used | sum of its inputs (shared and cached) | R1 |
| `checklist` (rubric) | Weighted criteria, each binary or scaled, with anchors | One judge call returns a verdict per criterion; the score is the weighted sum / the weights; items show per criterion | 1 | R2 |
| `embedding-set` | Reference answers that are good (and optionally bad), or a dataset column | max/mean cosine to the good set (6.2); must stay below t for the bad set | 0 (+E, cached) | R2 |
| `script` | `tp.*` code in the QuickJS sandbox (`scripts/sandbox.ts`). It gets `sample` (question, answer, reference, contexts, turns, toolCalls, metadata) and returns `{score, reason, items?}` | No network (`sendRequest` absent), no file system, no secrets. Limits: 1 s CPU, 32 MB, 64 KB output, and a loop interrupt. Errors become `n/a: script error` with the message | 0 | R2 |
| `dag` | A decision tree: task nodes, yes/no and multi-choice judgement nodes, leaves with scores 0–10 (DeepEval DAG) | Only the taken path runs; acyclic, checked at load; every node's verdict is kept as an item | depth | R3 |

#### Metric editor (`components/rag/MetricEditor.tsx`)

The editor is a form and YAML kept in sync (CodeEditor with the JSON Schema of metric files). It has these parts:
* **Inputs** checkboxes, with what each kind can see.
* **Preview pane, "Try on one sample".** Pick a dataset record, a probe, or an example. It shows *What will be sent*,
  the raw judge output, the score and the reasoning (§4c).
* **Examples.** Each pass/fail example runs with *Run all*; the badge reads "agrees with 6/6 examples".
* **Validation (verifiers).**
  * The schema is valid.
  * Every referenced metric exists.
  * No cycle (formula, DAG).
  * The script compiles and returns a score on the examples.
  * A judge metric is test-run on its examples and must match each `expect` (verifier `metric-examples`, added to
    `ai/verify.ts`). Saving with failing examples is allowed but marked.
* **AI assistance.** *Describe what good looks like* runs the AI task `rag-draft-metric` (large tier). It returns a
  **proposal** (`ProposalReview`) with the criteria, the anchors or checklist, the frozen G-Eval steps, and 4–8 example
  samples (half pass, half fail, taken from the dataset when one is open), verified by running them. *Improve from
  disagreements* turns calibration disagreements into new anchors and examples ("critique shadowing").
* **Calibration** (R4, used here once available). Compares the metric's verdicts with the human reviews (good/bad) of
  a run. It shows Cohen's κ, TPR/TNR, the confusion matrix and the disagreements, and writes `calibration:` into the
  file.
* **Version.** Saving bumps `version` when the criteria, kind, scale or inputs change. The history is the git history
  of the file, shown with the existing item history (`GitItemHistory`).
* **Cost per sample**, from `estimate()`.

#### Safety of custom metrics
* A custom judge runs only with a judge model the user configured. Its prompt is wrapped in TestPion's fixed
  instructions (judge only from the given text, return JSON), and the definition cannot change the system prompt.
* The sample is redacted (`redactForAi`) before any prompt is built, and secrets are never inputs.
* Scripts are sandboxed as above. A formula is parsed, never evaluated as code.
* Judges get `maxTokens` per call and a time limit.
* Run-level caps apply.
* A metric file from another workspace or a pull request is reviewed like code: the diff shows the prompt text.

### 4e. Thresholds, gates, aggregates

* **`MetricConfig`.** `{ metric, options?, threshold?, gate?: { mean?, p10?, passRate?, maxRegression? }, weight? }`.
  * A sample passes a metric at score ≥ threshold (≤ for metrics where lower is better).
  * n/a is neither a pass nor a fail, but is counted.
  * A run passes when every gate holds.
* Gates live in the saved evaluation and can be overridden with `--min metric=value`.
* `compareEvalRuns` (`eval-matrix-runs.ts:181`) gains per-metric deltas, with significance from a paired bootstrap over
  the shared samples. CI then fails on real regressions, not noise.

### 4f. Results and the matrix UI

* **Placement.** RAG evaluation is an evaluation kind in **Evaluations** (`type: 'rag-target'` saved evaluations). AI
  Lab gets a **RAG** tab that links in, offering Connect, the metric catalogue, custom metrics, and recent RAG runs.
* **Matrix** (`components/EvalMatrix.tsx` + core `eval/matrix.ts`):
  * **Pivots.** A pivot switch offers *Samples × metrics* (the default for RAG), *Samples × variants*, and *Metrics ×
    variants* (the summary view). Core gets `columnsBy: 'variant' | 'metric' | 'variant×metric'`.
  * **Cells.** A cell holds that metric's score, not the mean of all checks. Colour follows the metric's direction,
    and n/a is grey.
  * **Columns.** Every selected metric is a column, grouped by type under two header rows (type, then metric), and each
    group collapses to its mean.
  * **Header.** It shows the threshold per metric (editable; changing it re-evaluates pass/fail instantly from the
    stored scores), then aggregates: mean, p10, pass rate, n/a, a 95% CI, and a distribution sparkline (`charts.tsx`).
  * **Rows.** Rows group by tag (collapsible), filter by failure taxonomy, and sort by any metric.
  * **Size.** Typed arrays as today: 5,000 samples × 40 metric columns × 2 variants = 400k cells, about 8 MB.
* **Per-metric drill-down.** Clicking a cell opens `RagSampleDetail.tsx` focused on that metric. It shows:
  * the question;
  * a contexts lane (rank, id, score, this metric's verdict per chunk, and missed gold chunks);
  * the answer with claims highlighted and linked to chunks;
  * the metric card: score, threshold, items via `EvidenceList` (`Results.tsx:198`), reasoning, judge identity,
    prompt version, `cached` flag, and **Try again with another judge**;
  * the other metrics' cards;
  * the raw exchange, SSE events and trace (`TraceView`);
  * the human review control.
* **Charts.** A histogram per metric, metric by tag, metric over runs (`score-trend.ts` per metric), and cost / latency
  per sample.
* **AI.** *Explain this sample* (task `rag-explain-sample`, small tier) and *Analyse failures* (the triage pipeline with
  the RAG evidence) through `AiAction` / `AiAnalysisDialog`.
* **Export.** CSV / JSON (one row per sample, every metric, items as JSON), an HTML report (`report/rag-report.ts`:
  aggregates, gates, worst samples, charts), Ragas and DeepEval JSONL for cross-checks, and JUnit (one testcase per
  sample × gated metric).

### 4g. CLI, MCP, CI, monitors

The CLI lives in `packages/cli/src/commands/rag.ts` (new), with output formatting in `rag-output.ts`:

```
testpion rag targets [--json]                                  saved targets
testpion rag connect <request|preset> --name n [--answer path --contexts path …]   save a target (non-interactive)
testpion rag probe <target> "question" [--json]                 one call: the mapped sample + the raw response
testpion rag metrics [--type t] [--search s] [--json]           the whole catalogue (inputs, method, calls, direction, sources)
testpion rag metric list|show|add|test|validate|import|export   custom metrics
        add --kind judge|rule|formula|checklist|embedding-set|script|dag [--from-description "…"] (AI draft → proposal)
        test <metric> [--sample file|--record id|--probe "q"] [--dry-run] [--judge p/m] [--json]   = Try on one sample
testpion rag run <evaluation|dataset> [--target t] [--metrics a,b|--preset ragas-core] [--judge p/m] [--min m=0.8 …]
        [--baseline run] [--limit n] [--concurrency n] [--repeat n] [--two-phase] [--estimate] [--max-cost usd]
        [--json] [--junit f] [--html f]                         exit 1 on a failed gate / regression, 2 on config errors
testpion rag rescore <run> [--metrics …] [--judge …]            re-score stored samples, no RAG calls
testpion rag compare <run> -b <baseline> [--json]
testpion rag import <file> --from ragas|deepeval|promptfoo|beir [--out …]
testpion rag generate-dataset <docs…> --count n [--types …] [--out …] [--apply]   (R4)
testpion rag calibrate <evaluation|metric> --run <reviewed run> [--json]           (R4)
testpion rag cache clear
```

* **CLI output.** `--estimate` prints the plan and exits 0 without making calls. Everything uses the shared `--json`
  envelope.
* **MCP** (`packages/core/src/mcp-server/rag-tools.ts`, a new module, since `testpion-mcp.ts` is at 1484/1500):
  * `rag_list_targets`, `rag_probe`, `rag_metrics` (list), `rag_try_metric`, `rag_list_custom_metrics`,
    `rag_save_custom_metric` (confirm: true), `rag_validate_metric`, `rag_estimate`, `rag_run` (big, paged, output
    schema), `rag_rescore`, `rag_compare`, `rag_import_dataset`, and later `rag_generate_dataset` and `rag_calibrate`.
  * All follow the tool contract (`tool-contract.ts`).
  * The agent-kit prompt `evaluate_rag_system` walks an agent through probe → metrics → estimate → run → compare.
* **CI.** `runner/ci-config.ts` gets a RAG job template (GitHub, GitLab, Azure): secrets for the judge key and the
  target, a JUnit upload, the HTML artifact, and a PR comment table from `--json`. The GitHub Action gets the inputs
  `rag-evaluation`, `preset`, `min`, `baseline` and `max-cost`.
* **Monitors.** `MonitorData` (`runner/monitors.ts:23`) gets `evaluation?`, `limit`, `gates`, `judgeBudgetUsdPerDay`
  and `judgeSample` (the share of samples that get judged metrics; free metrics always run). The result reason reads,
  e.g., "faithfulness mean 0.78 < 0.80", and webhooks carry the metric.

### 4h. Privacy, cost and safety

* **What the judge sees.** Judging sends the sample itself (question, answer, chunks, reference); it cannot run on
  metadata only.
  * The picker, Try and the estimate say this plainly: "The judge receives …".
  * Privacy levels `metadata` and `names` disable judged metrics. Free metrics, and embeddings when the embedder is
    local, still run.
* **Redaction.** `redactForAi` runs on all sample text (secrets, tokens, PII masking per the settings), and the
  redaction count shows on the result. Request auth is never part of a sample.
* **Local judges and embedders.** Ollama, LM Studio, or any local OpenAI-compatible server. *Local only* blocks cloud
  judges. The docs recommend a judge from a different model family than the system under test.
* **Cost controls.** An estimate before every run, a per-run `maxJudgeCostUsd`, daily caps, the cache, shared passes,
  two-phase runs, sampled judging for monitors, and `shortCircuit` (skip judged answer metrics when a free retrieval
  gate already failed).
* **Load on the system under test.** A rate limit and concurrency per target, the production guard, and the host and
  the number of calls named in the estimate.
* **Cloud.** Everything runs in core. Keys live in the SecretStore; the cache and custom-metric files sit behind
  `WorkspaceStore` / `MetaStore`. Scripts run in the sandbox, which is safe on a shared server.

### 4i. Architecture placement and storage

| Layer | New or changed |
|---|---|
| Core model | `packages/core/src/model/rag-types.ts`: RagTarget, RagMapping, RagSample, MetricConfig, CustomMetricFile, RagDoc. `types.ts` (878/900) only gets `RagTest.target?` and `metrics?` |
| Core engine | `packages/core/src/eval/rag/**` (§4c, §4d). `runner/execute.ts` `runRag` delegates to `eval/rag/run-target.ts` when `target` is set. `runner/loader.ts`: the `rag` case reads `target` and `metrics`, and `contexts` resolved at run time. `runner/test-schema.ts`: new keys. `runner/rag-targets.ts`: CRUD for `library/rag-targets.json`. `storage/metric-files.ts`: reads and watches `metrics/*.yaml`. `runner/saved-evaluations.ts`: `type: 'rag-target'` with target, metrics, judge, gates, presets. `eval/matrix.ts`: metric pivot and per-metric thresholds. `runner/eval-matrix-runs.ts`: per-metric compare. `runner/monitors.ts`: RAG evaluation target. `report/rag-report.ts` |
| Core AI (providers) | `ai/types.ts` `ChatMessage.content: string \| ContentPart[]` (images), mapped in `providers/openai.ts`, `anthropic.ts`, `gemini.ts`, `bedrock.ts`, `mock.ts`; vision probe in `ai/index.ts`; `util/image-info.ts` (dimension parser) |
| Core SQL | `runner/sql-exec.ts` (the guarded read-only executor over `db-datasets.ts` and the SQLite reader), `eval/rag/sql.ts` (result comparison), `eval/rag/aliases.ts` (Ragas and other library names), `eval/rag/ragas-io.ts` (Ragas import/export) |
| Core AI | Tasks `rag-suggest-mapping`, `rag-draft-metric`, `rag-explain-sample`, `rag-cluster-failures`, `rag-generate-dataset`. Verifiers `metric-examples` and `rag-answerable` |
| Storage | Metastore tables `judge_cache` and `embedding_cache`. Runs as today (`runs/<id>/results.jsonl` with `metadata.rag.sample`, `metadata.judgeUsage` and the metric versions; `reviews.json`). Workspace `metrics/` folder (git-tracked) |
| Backend RPC | `apps/desktop/backend/handlers/rag.ts`: `rag.targets.*`, `rag.probe`, `rag.metrics`, `rag.metric.try`, `rag.metric.{list,get,save,validate,draft}`, `rag.estimate`, `rag.run`, `rag.rescore`, `rag.import`, `rag.calibrate`, `rag.generate`. `backend.ts` (1380/1450) only registers them |
| Renderer | `apps/desktop/src/components/rag/`: `RagConnect.tsx`, `MappingPicker.tsx` (on `JsonView` / `SseEvents`), `MetricPicker.tsx`, `MetricTry.tsx`, `MetricEditor.tsx`, `RagEstimateDialog.tsx`, `RagSampleDetail.tsx`, `RagCharts.tsx`. `views/EvaluationsView.tsx` switches editors. `views/AiLabView.tsx` gets the RAG tab. `components/EvalMatrix.tsx` gets the pivots |
| CLI and MCP | `packages/cli/src/commands/rag.ts` and `rag-output.ts`; `packages/core/src/mcp-server/rag-tools.ts`; `tool-contract.ts` and `agent-kit.ts` entries |
| Tests | `tests/unit/rag-*.test.ts`, `tests/ai/rag-judge-goldens.test.ts`, `tests/integration/rag-target.test.ts`, `apps/desktop/e2e/plans/rag-evaluation.cjs`, `rag-custom-metric.cjs` |
| Examples | `examples/servers/rag-server.mjs`: a demo RAG with HTTP JSON, SSE, WebSocket and session modes, a deterministic corpus, and seeded defects (a retrieval miss, an unfaithful answer, a wrong citation, a prompt injection that works, a false refusal). Plus `examples/veterinary-workspace/datasets/rag-golden.jsonl`, a saved target and evaluation, and `metrics/clinic-tone.yaml` |

* **Architecture rules.** `architecture.test.ts` gets two rules: `eval/rag/**` imports no `runner/*` except types, and
  no renderer file imports core values.

**Migration**
* Existing `rag` tests with static `contexts` / `answer` keep working (offline mode).
* Existing check names stay as aliases. Today's `answer-correctness` becomes `factual-correctness` (same behaviour);
  `answer-correctness` gets the Ragas composite only behind `mode: ragas` until R2, with a changelog note.
* `hallucination`: R1 adds a lint hint; R2 makes it DeepEval's metric (lower is better), and `testpion tidy` rewrites old
  uses to `faithfulness`.
* A missing judge becomes an error with the setup hint instead of silently using `mock`; there is a one-release
  setting to keep the old default.

### 4j. Multimodal RAG (images)

* **Capture.**
  * A RAG endpoint returns images as URLs, data URIs, base64 fields (`{mime, data}`) or file references. The mapping's
    `context.image` (and, optionally, `answerImages`) takes a path to any of these, picked by clicking in the probe
    response.
  * `RagDoc` (in `rag-types.ts`) gets `image?: { url?; dataUri?; mime; bytes; width?; height?; sha256 }`.
  * Dataset context items are recognised as images by a `data:image/` prefix or an image extension (jpg, png, gif,
    webp, bmp).
* **Provider support (prerequisite).** `ChatMessage.content` is a plain `string` today (`packages/core/src/ai/types.ts:10-12`).
  * It becomes `string | ContentPart[]`, with `{type:'text'}` and `{type:'image', data | url, mime}` parts.
  * Each provider maps the parts: OpenAI-compatible `image_url` (data URI); Anthropic `image` (base64 / url source);
    Gemini `inlineData` / `fileData`; Bedrock Converse `image` blocks; Ollama `images`.
  * `chatStructured` and the redaction step pass image parts through untouched.
* **Vision capability.** A model is vision-capable when the provider config lists it (`visionModels`), or when a one-time
  probe with a 1×1 PNG succeeds (cached).
  * The picker greys multimodal metrics without a vision judge and shows the JV message.
  * Local options (Ollama vision models) are listed first.
* **Fetching and limits.**
  * URL images are fetched by TestPion under the network policy (`net/policy.ts` `assertUrlAllowed`) and sent as data,
    so the judge provider never fetches private URLs. `sendImageUrls: true` passes public URLs through instead.
  * Limits:
    * 5 MB per image;
    * 16 images per sample, then the top-ranked ones;
    * 20 MB per sample;
    * MIME types allow-listed (png, jpeg, gif, webp, bmp).
  * Over a limit, the score is n/a with the reason ("image 7.2 MB > 5 MB"). Images are never silently dropped, and
    nothing is resized in core.
* **Privacy.** Images cannot be redacted, so they are opt-in.
  * An evaluation needs `allowImages: true`, and the estimate and Try say "N images (x MB) will be sent to <judge>".
  * Privacy levels `metadata` and `names` disable multimodal metrics; *Local only* restricts them to local vision models.
  * Run results keep the image's reference (URL or path) and sha256, never the bytes.
  * The drill-down shows images through a backend RPC `rag.image` (the renderer cannot read files or private URLs),
    bounded by the same limits.
* **Cost.** Image tokens are estimated from the dimensions, read by a small PNG/JPEG/GIF/WebP header parser
  (`util/image-info.ts`, no dependency), using each provider's published rule (tiles for OpenAI, area-based for
  Anthropic, fixed per image for Gemini; the table is versioned like the price table). The image sha256 is part of the
  judge cache key.
* **Tests.**
  * The mock provider accepts content parts and returns scripted verdicts.
  * Ragas' Tesla examples become goldens.
  * Header-parser fixtures; limit and consent gating; and the redaction pass-through, i.e. text parts redacted, image
    parts unchanged and listed in the preview.

### 4k. Text-to-SQL RAG: the read-only SQL executor

`datacompy-score` with `inputs: sql` runs SQL that the system under test generated: untrusted text. It reuses the
dataset database support and adds layers to it.
* **Datasource.** The evaluation's `database: { path (SQLite) | connection | connectionEnv, readOnly: true, schema? }`.
  * It reuses the drivers in `runner/db-datasets.ts` (pg, mysql2; `setDbDriver` for tests) and the SQLite reader in
    `runner/datasets.ts` (`DatabaseSync(path, { readOnly: true })`, `datasets.ts:172`).
  * The user must declare the connection `readOnly: true`, and the docs ask for a read-only database user.
* **Hard read-only guard** (`runner/sql-exec.ts`; every layer must pass):
  1. **One statement**, checked by `assertReadOnlyQuery` (`db-datasets.ts:43`): only SELECT / WITH / VALUES. Also
     refused:
     * a second statement, or `;` outside literals;
     * `SELECT … INTO`, `INTO OUTFILE/DUMPFILE`, `FOR UPDATE/SHARE`, `LOCK`;
     * data-modifying CTEs (`WITH … DELETE/UPDATE/INSERT`);
     * a deny-list of side-effect or slow functions: PostgreSQL `pg_sleep`, `dblink*`, `lo_*`, `pg_read_file`, `COPY`,
       `set_config`; MySQL `SLEEP`, `BENCHMARK`, `LOAD_FILE`, `GET_LOCK`.
  2. **A read-only transaction**: PostgreSQL `BEGIN READ ONLY` + `SET LOCAL statement_timeout`; MySQL `START
     TRANSACTION READ ONLY` + `MAX_EXECUTION_TIME`; SQLite opened read-only. When the read-only transaction cannot be
     started, the connection is refused.
  3. **A time limit**: 10 s per query by default. SQLite queries run in a worker thread that is terminated on timeout.
  4. **A row limit**: 10,000 rows by default. The query is wrapped as `SELECT * FROM (<q>) t LIMIT n+1`, and n+1 rows
     mean n/a ("result larger than 10,000 rows").
  5. **Concurrency**: at most 4 queries per datasource. A production-marked datasource asks once, as the production
     guard does.
* **Comparison** (`eval/rag/sql.ts`).
  * Values are normalised: numeric strings vs numbers, a decimal tolerance (`epsilon`), ISO dates, NULL, trimmed text.
  * Rows are compared as multisets, or in order with `ordered: true`; columns by name or position.
  * The items list samples of missing and extra rows. The sub-scores are `executed`, `precision`, `recall` and `f1`.
* **SQL from the answer.** The mapping can take a ```sql fence or a JSON field. With `inputs: results`, the response
  and reference are CSV/JSON result sets, as in Ragas, and nothing is executed.
* **`sql-equivalence` schema.** The schema comes from `reference_contexts` or is introspected: `information_schema` /
  `sqlite_master`, bounded to 200 tables and 20k tokens, with names only (no rows) under redaction.
* **Tests.**
  * In-memory SQLite fixtures with the Ragas examples.
  * Guard tests, each refused before any database call: DELETE, a multi-statement query, a data-modifying CTE,
    `INTO OUTFILE`, `pg_sleep`.
  * Timeout and row-cap tests.
  * pg and mysql through `setDbDriver` mocks, asserting the read-only transaction and timeout statements are sent.

---

## 5. Roadmap (the whole catalogue within 3 releases; the 4th polishes)

### R1 — v0.49 "Connect, measure for free, judge the triad" (value: very high; effort: about 4–5 weeks)
* **RAG-1** Model, mapping and capture for HTTP JSON, SSE, WebSocket and MCP tools; the OpenAI-compatible, LangServe and
  LlamaIndex presets; offline records. — L
* **RAG-2** Connect UI: probe, click-to-map, the saved-targets library; AI *Suggest mapping*. — M
* **RAG-3** Datasets: the column mapper, and imports from Ragas / DeepEval JSONL, CSV, BEIR qrels and NVIDIA
  `train.json`. — M
* **RAG-4** Metric registry, judge service (routing, structured output, cache, ledger, caps, estimate, juries and swap),
  shared passes, n/a semantics. — L
* **RAG-5** Every non-LLM family (**types 2, 5, 6, 11**), including Ragas' bleu, chrf, rouge, string_presence,
  exact_match, non_llm_string_similarity and the non-LLM / ID-based context precision and recall. Also:
  * deterministic safety (`no-leak`, `refusal`, `not-refusal`, `prompt-injection-resistance` regex mode);
  * deterministic agent checks, plus Ragas' `tool_call_accuracy` (exact arguments) and `tool_call_f1`;
  * `context-entity-recall` regex mode, `citation` and `quoted-spans`. — M
* **RAG-5b** The read-only SQL executor (§4k) and `datacompy-score` (Ragas `datacompy_score`, both `inputs: sql` and
  `inputs: results`). — M
* **RAG-6** The **RAG triad** (context-relevance in all modes incl. Ragas/NVIDIA `context_relevance`, faithfulness,
  answer-relevance incl. Ragas `response_relevancy`), plus context-precision, context-recall and factual-correctness,
  which already exist and are rebased onto the registry. — M
* **RAG-6b** Ragas parity layer (§2.6): `aliases.ts` with every Ragas name, the `ragas:` prefix, `compat: ragas`, Ragas
  dataset import/export (`--names ragas`), external Ragas result import. Also the judge-template engine for Ragas'
  general-purpose metrics: `aspect_critic` (pass-fail with votes), `simple_criteria`, `rubrics` and
  `instance_rubrics`. These share the custom `judge` kind of RAG-7. — M
* **RAG-7** Custom metrics, kinds `judge`, `rule` and `formula`: files, editor, examples verifier, AI draft. — L
* **RAG-8** Metric picker with presets and the live estimate; **Try on one sample** for every metric. — M
* **RAG-9** Matrix: the samples × metrics pivot grouped by type, per-metric thresholds and aggregates with CI,
  per-metric drill-down. — L
* **RAG-10** CLI (`rag targets|connect|probe|metrics|metric|run|rescore|compare|import`), MCP tools, docs, the demo RAG
  server, and e2e plans (run only at the release regression). — M
* **Spec freeze.** For each R1 metric: re-read the cited page, add its worked example as a test, and record the chosen
  edge-case semantics. — S

### R2 — v0.50 "Every LLM-judged RAG metric" (value: high; effort: about 3 weeks)
* **Type 1**: context-utilization, entity recall (LLM mode), retrieval-relevance.
* **Type 3**: everything else — response-groundedness, hallucination split, answer-correctness composite,
  answer-accuracy, factuality, correctness, completeness, citation-accuracy, negative-rejection (judge),
  faithfulness-hhem (endpoint), summarization, ragas-score.
* **Type 4**: the full claim-level family.
* **Type 7**: the remaining judge templates (g-eval, prompt-alignment, pairwise, coherence, conciseness, helpfulness,
  comprehensiveness); pass-fail, simple-criteria, rubric-score and instance-rubric already shipped in R1.
* **Type 13**: `sql-equivalence` (Ragas `sql_query_equivalence`) with schema introspection.
* **Ragas after R2:** 25 of the 29 list items have parity, including noise_sensitivity, answer_accuracy,
  response_groundedness, summarization (`mode: ragas`) and context_entities_recall in its Ragas `llm` mode.
* Custom metric kinds `checklist`, `embedding-set` and `script` (sandbox).
* gRPC and Socket.IO capture; the Haystack, Dify, Flowise and OpenAI Assistants/Responses presets.
* Two-phase runs, `shortCircuit`, repeat-N with flip rate; per-metric baseline compare with paired bootstrap; JUnit,
  HTML and CSV export.

### R3 — v0.51 "Conversations, agents, safety" (value: medium-high; effort: about 3 weeks)
* Multi-turn targets (stateless history and server session) and **type 9** in full, incl. `per-turn:<metric>`.
* **Type 10** in full: tool-call accuracy with judge argument comparison (exact mode and F1 shipped in R1),
  tool-correctness, argument-correctness, goal-accuracy (Ragas `agent_goal_accuracy`, with and without reference),
  task-completion, step-efficiency, plan adherence / quality, mcp-use, mcp-task-completion, tool-selection.
* **Type 12** multimodal: content parts in every provider, vision probe, image capture / limits / consent (§4j), and Ragas'
  `multimodal_faithfulness` and `multimodal_relevance`.
* **Ragas complete:** with topic_adherence (type 9), agent_goal_accuracy and the two multimodal metrics, all 29 items of
  the Ragas list have parity.
* **Type 8** judged metrics: toxicity, bias, pii-leakage (judge), misuse, non-advice, role-violation, harmfulness,
  maliciousness, controversiality; prompt-injection judge mode.
* The `dag` built-in (7.7), the custom `dag` kind with a tree editor, and `reward-score` (7.14, NIM / OpenAI-compatible).
* **After R3 every row of §2.3 is runnable.**

### R4 — v0.52 "Generate, calibrate, operate" (value: medium; effort: about 2–3 weeks)
* Test-set generation from documents and chunks: single- and multi-hop, abstract / specific, personas, unanswerable;
  the `rag-answerable` verifier; a reviewed proposal.
* Capture from traffic (Debugger / History → samples).
* Judge and custom-metric calibration against human reviews (κ, TPR/TNR, disagreements → examples), shown in the metric
  editor and the matrix.
* Monitors with RAG evaluations, gates, a judge budget and sampled judging; CI templates, GitHub Action inputs and PR
  comments.
* Perf hardening to the budget; cache management UI; per-metric score trend on Home / Attention.
* Then remind the owner: cloud runners for scheduled RAG evaluations belong to the cloud plan.

### 5.1 Test strategy: proving every metric

1. **Deterministic metrics (types 2, 5, 6 with the mock embedder, 11, deterministic parts of 1/3/8/10)**: a unit test per
   metric with the §2.3 worked example, plus the documented examples from Ragas, BEIR, sacreBLEU and DeepEval:
   * the Ragas ID-based examples (2/4 = 0.5; 1/4 = 0.25);
   * hand-computed nDCG / MAP / MRR tables;
   * sacreBLEU's published BLEU and chrF values;
   * ROUGE reference values;
   * edit distances;
   * the corrected ToolCallF1 example (0.8).

   Property tests cover score ranges, monotonicity and the n/a semantics.
2. **Judged metrics (types 1, 3, 4, 7, 8, 9, 10 and the custom judge, checklist and DAG kinds)**: **golden mock-judge
   cases** for every prompt version.
   * The mock provider returns scripted JSON: valid, malformed (repair), empty items, ids out of order, extra or missing
     ids, an invalid NVIDIA rating (fallback to the other judge).
   * Asserted: the score math, the evidence linking, n/a, ledger rows, cache keys and the estimate.
   * Each library's documented worked example is encoded as fixture inputs plus the documented verdicts → the
     documented score. This proves the formulas match Ragas, DeepEval, NVIDIA and RAGChecker.
   * A snapshot of the prompt text forces a version bump on any change.
3. **Custom metrics.**
   * Formula parser: precedence, n/a, `coalesce`, cycles refused.
   * Rule kinds: one test each.
   * Script sandbox: no network, no file system, CPU time, memory, output size, infinite loop interrupted, a thrown
     error becomes n/a.
   * Examples verifier: pass and fail.
   * Versioning: a hash change flags the baseline.
4. **Capture and mapping**: recorded fixtures for every preset and protocol (SSE delta assembly, WebSocket frames, a
   multi-turn session).
5. **Integration**: `examples/servers/rag-server.mjs` with its seeded defects. A full `rag run` with the mock judge
   asserts each defect lands in its failure category and metric, and asserts the compare report and the exit codes.
6. **e2e** (`apps/desktop/e2e/plans/rag-evaluation.cjs`, `rag-custom-metric.cjs`): connect via probe and click-mapping,
   picker preset, Try, a custom metric with an AI draft (mock), run, matrix pivot, drill-down, review, compare. These
   run only in the end-of-cycle regression.
7. **Perf budget**:
   * 5,000 samples × 10 metrics with the mock judge (5 ms) and a local stub RAG: the run takes ≤ 3 min at concurrency 16,
     and core memory stays ≤ 400 MB.
   * Matrix: a page renders in ≤ 50 ms and first paint is ≤ 300 ms.
   * Re-scoring from the cache takes ≤ 60 s; the catalogue loads in ≤ 20 ms.
   * Added to the `perf-large-workspace` plan.
8. **Live-judge scorecard (opt-in, never in CI by default)**. `TESTPION_LIVE_JUDGE=provider/model npm run scorecard:rag`
   runs every judged metric's worked examples against a real judge and reports agreement with the documented verdicts
   per metric. The owner runs it with their own key; nobody else uses keys.

9. **Ragas parity suite** (`tests/unit/rag-ragas-parity.test.ts`):
   * every Ragas name of §2.6 resolves to the right `{id, options}`;
   * every Ragas page's worked example runs through the resolved metric: deterministic ones exactly, judged ones with
     a mock judge returning the documented verdicts (e.g. context_precision ≈ 0.9999 vs ≈ 0.4999 by rank, ID-based
     0.5 and 0.25, tool_call_f1 0.8, the Tesla multimodal examples, the SQL equivalence pair);
   * a Ragas dataset import → export round trip keeps every column;
   * the opt-in live scorecard (8) has a `--ragas` set that compares TestPion's scores with scores produced by Ragas
     itself on the same exported file (run by the owner).
10. **SQL executor and multimodal**: the guard, limit and comparison tests in §4k, and the content-part, limit and
    consent tests in §4j.

### 5.2 Docs plan
* `docs/ai-testing/rag.md`: rewritten as a guide (connect, map, dataset, metrics, Try, run, matrix, CI).
* `docs/ai-testing/rag-metrics.md`: **generated** from `metricCatalogue()`, one section per type and per metric
  (inputs, what to provide, formula, calls, direction, worked example, sources, aliases).
* `docs/ai-testing/custom-metrics.md`: the 7 kinds, the file format, Try, examples, calibration, safety.
* CLI and MCP references: the `rag` commands and the `rag_*` tools.
* An `llms.txt` entry, written by whoever owns that file.
* Recipes:
  * Test a LangServe RAG.
  * Gate a PR on faithfulness and nDCG@10.
  * BEIR qrels.
  * A local judge with Ollama.
  * Write a custom tone metric.
  * A formula metric for an overall RAG score.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Our TypeScript metrics drift from the Ragas / DeepEval numbers | Worked-example goldens, edge-case semantics documented per metric, versioned prompts, export to Ragas / DeepEval formats for cross-checks |
| Libraries change definitions (DeepEval's hallucination direction; Ragas' 0.4 → 1.0 API) | Canonical ids with `mode`s; our definitions are versioned and documented, not tied to theirs |
| Judge cost surprises (Ragas noise sensitivity makes 2K + 3 calls; context precision makes 1 per chunk) | Shared, batched passes; estimate + caps + cache; sampled judging for monitors |
| Judge unreliability | Binary / 3-point verdicts with reasoning first, evidence items, juries, swap, calibration (κ, TPR/TNR), human review |
| Custom metrics as an attack surface (prompt text, scripts in pull requests) | Fixed judge wrapper, sandbox limits, no network or secrets, diffs reviewed like code |
| Mapping complexity across protocols and streams | Presets, click-to-map, AI-suggested mapping verified on the probe, a script escape hatch |
| R1 is large | Non-LLM metrics are cheap to build; the registry and judge service are the critical path, built first |
| File-size ceilings (types.ts 878/900, testpion-mcp.ts 1484/1500, backend.ts 1380/1450) | All new code in new modules (§4i) |
| Load on a production RAG | Rate limits, the production guard, the host and call count in the estimate |
| Executing generated SQL (datacompy) | Layered read-only guard (statement check, read-only transaction, time and row limits, deny-listed functions), connections declared read-only, a read-only database user recommended, production confirmation |
| Images are sensitive and cannot be redacted | Opt-in `allowImages`, the image count and size shown before sending, local vision models, hashes not bytes in results, privacy levels disable them |
| Ragas parity drift (Ragas 0.4 → 1.0, docs vs code differences) | The parity suite (§5.1 item 9), `ragas:` prefix semantics pinned and versioned, the docs/code discrepancies recorded in §2.1 |
| NeMo Microservices sunset (2026-10-01) | Cite NeMo Platform Helix docs; formulas do not depend on NVIDIA services |

## 7. Open questions for the owner

1. **Placement.** Proposed: RAG evaluation under *Evaluations*, plus an *AI Lab ▸ RAG* tab (Connect, catalogue, custom
   metrics). Or should all of it live in AI Lab?
2. **Default judge.** Proposed: the AI settings' large tier, and a run without a judge errors with a setup hint. Is that
   acceptable?
3. **Renames.** Should `hallucination` become DeepEval's lower-is-better metric in R2, with `faithfulness` keeping
   today's behaviour?
4. **Python interop.** Is exporting to Ragas / DeepEval formats enough, or is an optional "run Ragas locally" bridge
   wanted?
5. **Custom metric sharing.** Are workspace files plus import/export enough until the cloud plan (team libraries), or
   should there be a shared folder setting now?
6. **R1 scope.** R1 is large (about 4–5 weeks). Split it into R1a (connect + free metrics + matrix) and R1b (judge
   infrastructure + triad + custom metrics) as two releases a fortnight apart?
7. **Monitors.** Should scheduled RAG evaluations use cloud judges by default, or only local and free metrics unless
   cloud judges are enabled?
8. **Images.** By default, should images go to the judge as data (TestPion fetches them; works for private URLs), or as
   URLs (smaller, but the judge provider fetches them)? Proposed: data.
