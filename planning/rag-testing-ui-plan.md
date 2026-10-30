# RAG testing: UI research and improvement plan (2026-10-30)

Scope: only bots with sources (RAG). Prompts, agents, Compare and Try a prompt are in `ai-testing-ui-plan.md`.
Builds on `ai-lab-evaluations-ux.md` (2026-10-28, mostly shipped in 0.55) and `rag-testing.md` (§4f results UI). Nothing here
changes the engine or a file format: every item is a view, a plain word, or a small RPC with its CLI and MCP twin.

## 1. Where RAG testing stands after 0.55

What exists (code map): connect by click-to-map (`RagConnectDialog`, any protocol), probe sets, datasets from documents and
from captured calls (`RagDataPanel`, `RagTestsetDialog`, `RagCaptureDialog`), 134 metrics with a picker (`MetricPicker`),
custom metrics (`CustomMetrics`, `DagTreeEditor`), the bots wizard with two goals (`BotWizard`), the matrix
(`RagMetricMatrix`), the one-sample drill-down (`RagSampleDetail`: contexts lane, claims linked to chunks, metric cards, try
another judge, review), result views (distributions, by tag, run vs run with a paired bootstrap, several runs), rescore,
calibration with Cohen's kappa (`RagCalibration`), trends (`RagTrend`), gates, CI, monitors, `rag.author` drafting.

Where it still hurts (seen in the code and in the 10-28 stalls list, item 9 "RAG is a second app"):

1. **It lives as one tab of AI quality ("RAG bots") with a three-way sidebar** (targets / metrics / data) and an
   intro paragraph. Questions, systems, metrics, runs, calibration and trends are reached from four different places
   (the tab, Checks, the run's result tabs, the drill-down). A newcomer cannot see the RAG workflow as one line.
2. **No RAG sample.** The prompt side has "Try the sample (offline)"; RAG has a starter dataset and a mock judge in the
   code (`starter.ts`), but no three-click first result.
3. **Results open on numbers, not causes.** The matrix shows scores first. The failure taxonomy (`eval/rag/failure.ts`:
   retrieval miss, unsupported claim, off-topic, system error …) exists in the engine but is a filter, not the headline.
4. **The drill-down shows one metric's verdict per chunk, but a person cannot say which chunks were right.** Labels exist
   only per metric (Pass / Fail) and per result (Good / Bad); chunk relevance is never recorded, so retrieval judges are
   calibrated against nothing.
5. **Two runs compare by means, not by cases.** `RagResultViews` says "faithfulness +0.04, real"; it does not list the
   twelve questions that flipped.
6. **A run does not know what was under test.** Chunking, embedding model, top-k and the prompt version of the bot are
   not recorded, so a trend line cannot say what changed between two points (the judge change is marked; the system's
   own changes are not).
7. **Vocabulary**: target, contexts, gold ids, faithfulness, context precision, claims, judge, jury, kappa, in the labels
   of the drill-down and the picker. The 0.55 renames covered the prompt side more than the RAG side.
8. **The connect dialog starts from an empty request.** Common bot response shapes (OpenAI chat with citations,
   LangChain / LlamaIndex serve, Vercel AI SDK stream, a plain `{answer, sources[]}`) must be mapped by hand each time.

## 2. Research: what the field does in 2026 (own words; sources at the end)

Vendor pages dominate this topic, so each point below is "common practice", not a standard.

1. **Retrieval and generation in one view.** The retrieved chunks in order, the answer, and the score's explanation
   together, so a failure reads as "evidence missing", "evidence ranked low" or "evidence ignored" (Confident AI; the
   Phoenix guide: "the eval score is the triage surface, the trace is the debugging surface"). TestPion's
   `RagSampleDetail` already is this view; the gap is reaching it from a cause, not from a cell.
2. **Tag every run with the configuration**: corpus version, chunking strategy, embedding model, prompt version, retriever,
   experiment id; compare across them (Phoenix guide, imversion).
3. **Label chunks, not only answers**: relevant / partially relevant / not relevant per retrieved chunk (qaskills RAG QA
   guide). Chunk **ablation** (drop one chunk, re-ask, see what changes) finds the load-bearing chunk.
4. **Hold the test set fixed, change one thing, and look at the cases that changed**, not only the mean (imversion).
5. **Stable ids and ranks per request** (document id, chunk id, rank, score) so two runs line up (imversion).
6. **Embedding maps** (UMAP / t-SNE of questions, expected chunks and retrieved chunks) expose confusable chunks and
   blind spots (Phoenix, Renumics Spotlight, VectorBoard's "$29 / subscription" example, the RAGTrace paper's failure
   clusters). Useful, expensive to build, and needs an embedding model: last.
7. **Judge alignment**: chance-corrected kappa, not raw agreement; the bar is human-human agreement on the same set;
   decomposed binary criteria with anchors beat a 1–5 scale; a June 2026 review found no tool makes a one-click "agree
   with my labels" check the default (Ragas' align-judge how-to; koji.so; dev.to review). TestPion has the statistics
   (`RagCalibration`); it lacks the queue and the human-human bar.
8. **Tool landscape**: Braintrust (evaluation-first, experiment comparison), LangSmith (annotation queues, LangChain),
   Phoenix (traces + embeddings, self-host), Langfuse (MIT, datasets + judges + CI), Confident AI (DeepEval's dashboard:
   separate retrieval and generation scoring, regression checks). Ragas has no UI. None is offline-first or desktop;
   TestPion's edge is "no data leaves the machine" plus click-to-map of any protocol.

## 3. Jobs to be done

- J1 "Is my bot's answer backed by its sources?" in a few minutes, with my own questions.
- J2 "The answer is wrong: was the right document found, ranked low, or ignored?"
- J3 "I changed chunking / the prompt / the model. What got better, what got worse, by question?"
- J4 "Can I trust the AI judge on my data?"
- J5 "Keep it from regressing" (CI gate, nightly trend).

## 4. The plan

Sizes: S ≤ 1 day, M ≤ 3 days, L ≤ 1–2 weeks. Every item: uniform shared components, a `reason` on every disabled
control, CLI `--json` + MCP tool + llms.txt line, an e2e plan, performance budgets kept.

| Id | Change for the user | Implementation notes | Size | Job |
|---|---|---|---|---|
| R-1 | **RAG testing is its own rail item** ("RAG bots"), separate from AI quality, with the workflow as tabs in order: *Start · Bots · Questions · Checks · Results · Trust the judge · Trends*. AI quality keeps Start / Checks / Try a prompt / Compare / Models and keys. Old view ids and intents keep working as aliases. | `lib/rail.ts`, `components/nav.tsx`, `AiQualityTabs` loses `rag`; new `views/rag/RagView.tsx` hosting the existing panels; `EvaluationsView` filters `type === 'rag'` into the Checks tab here. Rail default shows it. | M | all |
| R-2 | **Start page for RAG** with three cards (Connect a bot · Build questions · Run the standard check), the latest RAG runs with their headline, and **Try the sample (offline)**: the starter dataset, the offline demo bot (a mock target in the examples workspace) and the mock judge give a report in ≤ 3 clicks. | reuse `Start.tsx`'s `StartCard`; `RAG_STARTER_DATASET` + `RAG_STARTER_EVALUATORS`; RPC `rag.sample` (CLI `testpion rag sample`, MCP `rag_sample`). | M | J1 |
| R-3 | **Results open on causes.** The report card headline for RAG is the two goals ("Backed by the sources: 17 of 20 · Right documents found: 15 of 20"), then a strip of failure causes as chips ("4 right document not retrieved · 3 ranked below the cut · 2 unsupported claim · 1 off-topic") that filter the matrix; failures first. | `RunReport` (shared) gets a `causes` strip; `eval/rag/failure.ts` already classifies; `rag.summary` returns counts; CLI `rag report --causes`. | M | J2 |
| R-4 | **One-sample view by stage**: query → retrieved (rank, score, right/wrong) → used (claims linked) → answer, with the **missed right documents** and the nearest retrieved chunk to each; per chunk a three-state label (relevant / partly / not) a person can set. Labels go to `labels/*.json` with provenance and feed the calibration of retrieval judges. | `RagSampleDetail` lanes; `RagLabelControl` extended to chunks; `labels.ts` schema gets `chunk`; `rag calibrate` reads chunk labels for context-precision / recall judges. | M | J2, J4 |
| R-5 | **What changed, by question.** Run vs run shows, beside the means, the list of cases that flipped (pass→fail first), each opening the stage view of both runs side by side with the answer diff and the retrieved-document diff (ids added / gone / re-ranked). | `RagResultViews` compare view; core `rag.diffRuns` (CLI `rag diff <run> <run>`, MCP `rag_diff_runs`); reuse the response diff component. | M | J3 |
| R-6 | **A run records what was under test.** Optional fields on the bot (corpus version, chunking, embedding model, top-k, prompt version), read from the response when the bot sends them (a `meta` mapping in the connect dialog) or typed; shown as a stamp on every run, in compare and as markers on the trend ("chunking changed here"). | `RagTarget.meta` map; run record `systemConfig`; `RagTrend` markers like the judge-change marker; `rag trend --by prompt-version`. | M | J3, J5 |
| R-7 | **Trust the judge as a tab with a queue.** "Grade 10" opens a keyboard queue (j/k, p/f, note) over the last run's samples with the judge's verdict hidden; then kappa with the bootstrap interval, the confusion matrix, and the **human-human bar** when two people graded (a second reviewer name on the labels); one click "Use the pass mark that agrees most". Decomposed criteria of a judged metric are shown as the sentences the judge used. | `RagCalibration` surfaced as a tab; new shared `ReviewQueue` (also used by `ai-testing-ui-plan.md` A-6); labels carry `reviewer`. | M | J4 |
| R-8 | **Plain words on the RAG side**: target → bot, contexts → retrieved documents, gold ids → right documents, faithfulness → backed by the sources, context precision → right documents ranked first, context recall → all right documents found, claims → statements, judge → AI reviewer, jury → several AI reviewers, kappa → agreement (chance-corrected). Ids, file formats and the CLI are unchanged; the picker shows the plain name with the metric id under it. | `lib/vocabulary.ts` `AI_JARGON` extended; `MetricPicker`, `RagSampleDetail`, `RagCalibration`, `RagConnectDialog` labels; the unit test that no label matches the jargon list. | S | all |
| R-9 | **Connect dialog recognises common response shapes** and offers the mapping ("Looks like an OpenAI chat answer with citations · Use this mapping"): OpenAI chat (+ `citations`/`annotations`), Anthropic messages with citations, LangChain / LangServe, LlamaIndex, Vercel AI SDK data stream, a plain `{answer, sources[]}`; a live three-colour preview (answer / documents / ids) of what the mapping reads. | `eval/rag/shapes.ts` (pure, unit-tested on fixtures); `RagConnectDialog` suggestion row; `rag connect --detect` prints the mapping. | M | J1 |
| R-10 | **The RAG report is the shared report card**, not its own header: sentence, cost and time, vs last run, trend line, pass line, by-goal counts, causes strip (R-3). The matrix stays below. | `RunReport` used by `RagMetricMatrix`'s header (uniform-UI rule). | S | J1 |
| R-11 | **Chunk ablation** on one sample: "Which document mattered?" re-asks the bot without each retrieved document (n calls, cost shown first) and marks the load-bearing ones. Only for bots whose request accepts a document list (the mapping says so); otherwise the button says why it is off. | `rag.ablate` (asks first: it calls the bot), MCP `rag_ablate`; `RagSampleDetail` button through `AiAction`-style confirm. | M | J2 |
| R-12 | **Embedding map** (later): questions, right documents and retrieved documents projected to 2D with a local embedding model; confusable chunks and unanswered regions. | needs an embedding provider setting and a UMAP port; `charts.tsx`; only after R-1…R-7 have shipped. | L | J2 |
| R-13 | **Docs**: "Test a bot with sources in 5 minutes" as the entry page of the RAG docs; a glossary from R-8; llms.txt lines for every new RPC. | `docs/rag-testing/*`, `docs/public/llms.txt`. | S per release | — |

Not planned (and why): a hosted annotation service or multi-user queues (the cloud stage, B-42); replacing the matrix
(it is fast and tested); new metrics (134 are enough; the gap is reaching them).

## 4a. Status (2026-10-30)

| Id | State |
|---|---|
| R-1 | Built: view id `rag`, rail item *RAG bots* (shown by default), tabs Start · Bots · Questions · Metrics · Checks; AI quality's Checks lists prompt and agent evaluations, the bots' Checks lists bot evaluations (`openIntent('evaluations', { host })`); old links land in the new place. Results, Trust the judge and Trends stay inside an evaluation's run (a tab outside would need an evaluation picker first). |
| R-2 | Built: *Try the sample (offline)* makes an MCP mock bot (`mocks/clinic-bot.mcp-mock.yaml`, served in-process), the target *Clinic bot (offline)*, six questions and *Sample: clinic bot*; the offline demo model is the reviewer; 4 of 6 pass by design (an unsupported claim; the wrong document retrieved). `testpion rag sample`, `eval_sample { kind: "bot" }`, RPC `rag.trySample`. |
| R-8 | Built: `PLAIN_METRIC` names in the picker (the id stays beside them), *Connect a bot*, *right document* in the drill-down, *Try again with another AI reviewer*. The `AI_JARGON` guard is unchanged (the docs still use the engine's words). |
| R-10 | Already true: `RunReport` is the one report card, used by the bot run too; the causes strip is R-3. |
| R-3 | Built (2026-10-31): `EvalReport.goals` and `causes` (plain words from `eval/rag/failure.ts`, `FAILURE_CLASSES[].plain`), `cause` on each failure, chips (`FilterChips`) that narrow the failed list. |
| R-4 | Partly built: the sample opens by stage (`lib/rag-stages.ts`: Question, Retrieved, Used, Answer, *start here*, the nearest retrieved document for a missed right one). Not built: per-chunk three-state labels feeding the calibration of retrieval judges. |
| R-5 | Built: `retrievedDiff` on `eval case diff` (documents dropped and added, the right documents found before and now, the cause now). |
| R-6 | Built: `mapping.meta` (names to JSONPaths), `sample.meta`, `EvalReport.underTest` with a change mark, the *Under test* field of the connect dialog. |
| R-7 | Covered by A-6 (the review queue, shared) and the existing *Trust the AI reviewer*; no separate retrieval-judge queue. |
| R-9 | Built: `eval/rag/shapes.ts` (`detectRagShape`: every preset's mapping and eight more shapes tried on the probe's response), `rag probe` returns `shapes`, the connect dialog's *Use this mapping* row. |
| R-11, R-12 | Not built (a bot whose request accepts a document list; an embedding provider setting). |
| R-13 | Built: `docs/getting-started/check-a-rag-bot.md`, the *What was under test* and *Read a result* sections of `docs/ai-testing/rag.md`. |

## 5. Release grouping (AI items ≤ half of a release; Fiddler work continues alongside)

| Release | RAG items | Why |
|---|---|---|
| 0.56 | R-1, R-2, R-8, R-10 | The separate place, the sample, plain words, one report card: no new engine work |
| 0.57 | R-3, R-4, R-7 | Causes first, the stage view with chunk labels, the judge queue |
| 0.58 | R-5, R-6, R-9 | Case-level diffs, the configuration stamp, recognised shapes |
| 0.59 | R-11, R-13 | Ablation; docs catch up |
| later | R-12 | The embedding map, once an embedding provider exists |

## 6. Success metrics (measured by the e2e harness)

| Metric | Target | How |
|---|---|---|
| Fresh profile, no key, first RAG report | ≤ 3 clicks, ≤ 30 s | new plan `rag-try-sample` counts `real.click` and asserts the two-goal headline |
| A failed question shows its cause without opening it | 100 % of failures | `rag-evaluation`: every failed row carries a cause chip |
| Run vs run lists the flipped questions | yes | `rag-diff` plan |
| No jargon in RAG labels | 0 matches | `vocabulary.test.ts` with the extended list |
| Judge agreement reachable in one click from a report | yes | `rag-calibrate` extended |
| Connect a bot with a known response shape | ≤ 4 clicks | `rag-connect` with an OpenAI-shaped mock |

## 7. Open questions for the owner

1. R-1 reverses the 10-28 decision "one AI quality rail item". The reason to split now: the RAG workflow has seven stages
   and its own vocabulary, and the owner asked for the separation. Confirm the rail label: "RAG bots" (plain)
   or "RAG testing" (what practitioners search for)?
2. R-6: should the configuration stamp be mandatory for CI gates (a gate fails if the stamp is missing), or informational?
3. R-7: a second reviewer is a name typed in; is that enough until the cloud version brings accounts?

## Decisions on the open questions (2026-10-30, chosen on the owner's request "base it on the current app")

| # | Question | Decision | Why, from the app as it is |
|---|---|---|---|
| 1 | Rail label | **"RAG bots"** in the rail and the tabs; "RAG" is the tooltip's second word, a Quick Open / search alias and the docs' section name ("RAG bots (RAG testing)"). | The vocabulary rule (`lib/vocabulary.ts`, `AI_JARGON`, unit-tested) forbids jargon in labels, and every other label was renamed in 0.55 to plain words; the alias keeps the term people search for reachable. |
| 2 | Configuration stamp (R-6) | **Informational.** A run without a stamp still runs and still gates; the trend marks "unknown configuration" in grey. | Today's gates are thresholds on numbers (`gates`, `--min`, monitors); making the stamp mandatory would fail every existing monitor and CI step on the day it ships. |
| 3 | Second reviewer (R-7) | **A name typed once** (Settings ▸ AI quality ▸ "Your name for reviews", default the OS user name), stored on each label's provenance. | Labels already carry provenance (`labels/*.json`, 0.54); there are no accounts until the cloud stage (B-42), and the app must not invent a second identity system before it. |

## Sources

- [Confident AI, best RAG evaluation tools (2026)](https://www.confident-ai.com/knowledge-base/compare/best-rag-evaluation-tools)
- [Phoenix RAG tracing and evaluation guide (qaskills.sh)](https://qaskills.sh/blog/phoenix-rag-tracing-evaluation-guide)
- [RAG QA testing guide: retrieval, generation, citation quality (qaskills.sh)](https://qaskills.sh/blog/rag-evaluation-metrics-complete-2026)
- [RAG retrieval quality best practices (imversion)](https://www.imversion.com/blog/rag-retrieval-quality-best-practices-for-accurate-context-in-2026)
- [How to evaluate RAG (Agenta)](https://agenta.ai/blog/how-to-evaluate-rag-metrics-evals-and-best-practices)
- [Top RAG evaluation tools 2026 (GoodEye Labs)](https://www.goodeyelabs.com/articles/top-rag-evaluation-tools-2026)
- [Best RAG debugging tools (Galileo)](https://galileo.ai/blog/best-rag-debugging-tools)
- [RAGTrace (Emergent Mind summary)](https://www.emergentmind.com/topics/ragtrace)
- [VectorBoard: debug RAG retrieval failures](https://vectorboard.gitbook.io/vectorboard-docs/03-use-case-1-rag-debugging)
- [Renumics Spotlight review](https://aicoolies.com/reviews/spotlight-review)
- [Ragas: align an LLM judge](https://docs.ragas.io/en/latest/howtos/applications/align-llm-as-judge/)
- [LLM-as-a-judge vs human evaluation (koji.so)](https://www.koji.so/docs/llm-as-a-judge-vs-human-evaluation)
- [LLM-as-judge tools compared: which one you can trust (dev.to)](https://dev.to/maya_andersson_dev/llm-as-judge-tools-compared-the-question-is-not-which-one-scores-it-is-which-one-you-can-trust-3526)
- [Who judges the judge (Kili)](https://kili-technology.com/blog/data-story-who-judges-the-judge-llm-as-a-judge)
- [7 LLM evaluation platforms compared (Arize)](https://arize.com/llm-evaluation-platforms-top-frameworks/)
- [LLM eval tools compared 2026 (benchmarkingagents.com)](https://benchmarkingagents.com/tools-compared/)
- [Top LLM observability and evaluation platforms 2026 (MarkTechPost)](https://www.marktechpost.com/2026/08/09/top-llm-observability-and-evaluation-platforms-in-2026-langfuse-langsmith-braintrust-arize-and-more-compared/)
- [DeepEval vs Ragas (deepeval.com)](https://deepeval.com/blog/deepeval-vs-ragas)
