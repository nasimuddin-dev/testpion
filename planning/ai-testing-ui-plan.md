# AI testing (prompts, agents, compare, models): UI research and improvement plan (2026-10-30)

Scope: everything under the AI quality rail item except bots with sources, which has its own plan
(`rag-testing-ui-plan.md`). Builds on `ai-lab-evaluations-ux.md` (2026-10-28): of its 24 items, 0.55 shipped AU-1 to
AU-21 and AU-23 (the Start page, the case table, the good-answer picker, the wizard, generated cases, the report card,
"why did this fail", Compare mode, CI, the spend cap, agent checks, one rail item, trust the reviewer). Left from it:
AU-22 (per-case diff against the previous run), Compare for agents, and the rag.author pre-fill (moved to the RAG plan).

## 1. Where it stands after 0.55

Tabs: *Start · Checks · Try a prompt · Compare · Models and keys* (`AiQualityTabs`). The wizard has two types, "A prompt
or chatbot" and "An agent with tools" (`Wizard.tsx`); agent tools are edited with `AgentToolsEditor` (mock tools and MCP
servers). 56 features go through the one `AiAction` button (what will be sent, cost, proposal review).

Where it still hurts:

1. **An agent run is a table of pass/fail, not a trajectory.** A case says "should call `lookup_order`: failed"; the
   person cannot see the steps the agent took, with which arguments, and where the check broke.
2. **Prompt versions are variants of a compare run, not a history.** Try a prompt and the evaluation do not keep "the
   prompt as it was when 18 of 20 passed"; a better prompt replaces the old one and the old result stays in the run list
   under the same name.
3. **Compare shows the winner, not the difference.** Two answers sit side by side; what changed between them is read by
   eye (no diff), and a model change versus a prompt change look the same.
4. **The previous run is a number.** The report card says "vs last run +2"; it does not list which cases flipped or show
   the answer diff per case (AU-22).
5. **Human review is only for calibrating the AI reviewer.** "Grade 10" exists on the Checks tab when an AI reviewer check
   exists; there is no general queue to mark answers good / bad with a note, which is also the cheapest way to build a
   better test set.
6. **Cost is shown before a run and in Models and keys, not in the run's own history.** "This run $0.12, last $0.10, this
   evaluation this month $3.40" is missing from the report.
7. **Gating is a CI command.** A prompt that scores under the pass line can still become "current" in the app with no
   warning.

## 2. Research: what the field does in 2026 (own words; sources at the end)

1. **Trajectory views**: each tool call in order with arguments and results; checks are rule-based and free (exact tool
   names, order, parameters, regex, JSON schema) and run without a model (EvalView, Inspect View, EvalScope's step-grouped
   "Agent Trace", Arize's agent-trajectory evaluations).
2. **Golden-baseline trajectory diffing**: save a known-good run; a later run diffs tool names, order and parameters
   against it (EvalView lists this as the feature others lack).
3. **Prompt versioning tied to evaluations**: a version is promoted only when its evaluators pass; every run traces back
   to its version (Future AGI's prompt-management guide; Agenta's registry).
4. **Playground diff panels**: additions and deletions between two outputs; "a playground without versioning is a
   re-iteration trap" (Future AGI's playground guide; Agenta highlights output differences in compared evaluations).
5. **Judge alignment**: chance-corrected agreement, a human-human bar, decomposed binary criteria (see the RAG plan §2.7;
   the same findings apply to `llm-judge` checks).
6. **Evaluation-first platforms** (Braintrust, LangSmith, Langfuse, Phoenix) keep datasets, scorers and experiments as
   three nouns and make "compare two experiments, case by case" the central screen. TestPion's three nouns are test
   cases, checks and runs; the case-by-case compare is the missing screen.

## 3. Jobs to be done

- J1 "Did my prompt change make the answers better or worse, and on which cases?"
- J2 "What did my agent actually do on the case that failed?"
- J3 "Which version of this prompt is live, and was it good enough?"
- J4 "Mark what is good so the next test set is better."
- J5 "What does this evaluation cost me over time?"

## 4. The plan

Sizes: S ≤ 1 day, M ≤ 3 days, L ≤ 1–2 weeks. Every item: shared components, a `reason` on every disabled control, CLI
`--json` + MCP tool + llms.txt, an e2e plan, performance budgets kept.

| Id | Change for the user | Implementation notes | Size | Job |
|---|---|---|---|---|
| A-1 | **Agent trajectory view.** A case of an agent evaluation opens as a timeline: model call → tool call (name, arguments) → tool result → … → final answer; each "should call / should not call" check is pinned to the step that decided it (green at the call, red where a forbidden call happened, grey "never called" at the end). | the run already stores steps (`type: agent` results); new shared `StepTimeline` (also usable by flow runs); `RunReport` row click. | M | J2 |
| A-2 | **Golden trajectory.** "Mark this run as the baseline" on an agent evaluation; later runs show per case "same tools, same order", "a tool added / dropped", "arguments differ", with the diff. The baseline is a plain field of the saved evaluation (`baselineRun`). | core `eval.diffTrajectory` (CLI `eval diff --trajectory`, MCP `eval_diff_runs`); pure, unit-tested on fixtures. | M | J2, J1 |
| A-3 | **Cases that flipped (AU-22).** The report card's "vs last run" opens a list: pass→fail first, then fail→pass, each with the answer diff (the existing response diff component) and the check that changed. Also for Compare mode between two variants. | core `eval.diffRuns` shared with A-2 and the RAG plan's R-5 (one RPC, `kind` decides the lanes); `RunReport` link. | M | J1 |
| A-4 | **Prompt versions.** A saved evaluation keeps a version list of its prompt (and system prompt): "Save as version" with a name, the report headline beside each version, "Make current", and the stamp of the version on every run. Try a prompt gets "Save to an evaluation…" which creates a version. | `SavedEvaluation.promptVersions[]` (additive, old files unchanged); `VariantsPanel` reused for the list; CLI `eval versions`, MCP `eval_prompt_versions`. | M | J3 |
| A-5 | **Promotion gate.** "Make current" on a version under the pass line, or under the baseline, asks first and says the numbers; `eval run --baseline` already exists for CI, so the app and CI use one rule. | `RunReport` pass line + A-4; no new engine rule. | S | J3 |
| A-6 | **Review queue for any run.** "Review 10" (or all) on the report card: keyboard j/k, good / bad / note, the check verdicts hidden until graded; grades feed Trust the AI reviewer (when a judged check exists) and **Add the good ones to the test cases** (with the answer as the expected answer) in one click. | new shared `ReviewQueue` (the RAG plan's R-7 uses the same); labels in `labels/*.json` with `reviewer`; CLI `eval review --export`. | M | J4 |
| A-7 | **Output diff in Compare and Try a prompt.** Two answers side by side with additions and deletions highlighted, a toggle "Show differences only"; when the same prompt was sent at two temperatures or to two models, the header says which changed. | the response diff component in `Compare.tsx` and `Playground.tsx`. | S | J1 |
| A-8 | **Cost in the run's history.** The report card shows this run's cost, the previous run's, and the evaluation's month-to-date; Models and keys links to it. | `runs.list` already carries cost; `RunReport` line; `eval runs --json` prints it. | S | J5 |
| A-9 | **Compare for agents.** Variants (model, system prompt) on an agent evaluation, summarised by tool-check pass rate and steps per case; the trajectory diff of A-2 between variants. | lift the "not for agents" guard once A-1 and A-2 exist; `VariantsPanel`. | M | J1, J2 |
| A-10 | **Uniformity audit of AI quality after 0.55**: one Run button shape, one Options pattern, every disabled control with a reason, identical empty states, menu order (`menus-uniform.md`). | the existing e2e helpers that list disabled buttons without `reason`; `uniform-*` plans. | S | — |
| A-11 | **Docs**: "Check an agent in 5 minutes", prompt versions and gates in the CI page, llms.txt lines for every new RPC. | `docs/ai-testing/*`, `docs/public/llms.txt`. | S per release | — |

Not planned: a hosted prompt registry or team review (cloud stage, B-42); automatic prompt optimisation (a product of its
own); more check types (the picker has 45; the gap is seeing results, not scoring them).

## 5. Release grouping (AI items ≤ half of a release)

| Release | Items | Why |
|---|---|---|
| 0.56 | A-3, A-7, A-8, A-10 | Diffs and cost on screens that exist; the audit; no new nouns |
| 0.57 | A-1, A-6 | The trajectory view and the review queue (the queue is shared with RAG 0.57) |
| 0.58 | A-4, A-5, A-2 | Versions, the gate, the golden trajectory |
| 0.59 | A-9, A-11 | Compare for agents; docs catch up |

## 6. Success metrics

| Metric | Target | How |
|---|---|---|
| A failed agent case shows the step that failed | 100 % | e2e `ai-agent-eval` asserts the pinned check on a step |
| "vs last run" lists flipped cases | yes | e2e `eval-report` |
| A prompt version is shown on every run | 100 % | e2e `ai-versions` |
| A promotion under the pass line asks first | yes | e2e `ai-versions` |
| Ten answers reviewed with the keyboard only | ≤ 25 key presses | e2e `ai-review-queue` |
| Cost on the report card | 100 % of runs with a priced model | e2e `eval-report` |

## 7. Open questions for the owner

1. A-4: versions inside `library/evaluations.json` (one file, as assumed) or as files under `prompts/` (git-friendlier,
   a new kind)?
2. A-6: should "Add the good ones to the test cases" write the model's answer as the expected answer, or ask for an
   edited one each time?
3. A-2: is a baseline per evaluation enough, or per variant?

## Decisions on the open questions (2026-10-30, chosen on the owner's request "base it on the current app")

| # | Question | Decision | Why, from the app as it is |
|---|---|---|---|
| 1 | Where prompt versions live (A-4) | **Inside the evaluation item** in `library/evaluations.json` as `promptVersions[]`, newest first, capped at 50 per evaluation (the oldest unnamed ones go first). | An evaluation already keeps everything inside itself (dataset text, variants, tools, gates) and the bots wizard was built on "no new file format"; the item is a git kind with a semantic diff by item name, so a new version shows as one change of one item. A `prompts/` kind would need a serializer, change marks, bundle export and import, secret scan and an index entry before the first version could be saved. |
| 2 | "Add the good ones to the test cases" (A-6) | **Writes the model's answer as the expected answer**, marks the case `source: reviewed`, and opens the case table on the new rows so they can be edited. | The existing human review of results already turns an approved answer into a dataset row ("Add to dataset", 2026-10-07); asking for an edited answer each time would make ten reviews ten forms. |
| 3 | Baseline per evaluation or per variant (A-2) | **Per evaluation.** | Variants are compared with each other by Compare mode already; a baseline answers "did the agent regress since the run I trusted", which is one answer per evaluation. A per-variant baseline can be added later as a field of the variant without changing the file. |

## Sources

- [EvalView 0.5 (PyPI)](https://pypi.org/project/evalview/0.5.1/)
- [Arize: agent trajectory evaluations](https://arize.com/docs/ax/evaluate/agent-trajectory-evaluations)
- [EvalScope: agent evaluation and the Agent Trace view](https://evalscope.readthedocs.io/en/v1.8.1/user_guides/agent/index.html)
- [Agent evaluation systems 2026: Inspect AI, promptfoo, Phoenix, LangSmith, OpenAI Evals (youngju.dev)](https://www.youngju.dev/blog/culture/2026-05-14-agent-evaluation-systems-2026-inspect-ai-promptfoo-phoenix-langsmith-openai-evals-deep-dive-2026.en)
- [Best prompt management platforms for agents 2026 (Future AGI)](https://futureagi.com/blog/best-prompt-management-platform-ai-agents-2026/)
- [Best LLM prompt playground tools 2026 (Future AGI)](https://futureagi.com/blog/best-llm-prompt-playground-tools-2026)
- [Agenta changelog](https://agenta.ai/docs/changelog/archive)
- [Braintrust review 2026](https://toolbrain-astro.pages.dev/blog/braintrust-review-2026/)
- [7 LLM evaluation platforms compared (Arize)](https://arize.com/llm-evaluation-platforms-top-frameworks/)
- [LLM eval tools compared 2026 (benchmarkingagents.com)](https://benchmarkingagents.com/tools-compared/)
- [Ragas: align an LLM judge](https://docs.ragas.io/en/latest/howtos/applications/align-llm-as-judge/)
- [LLM-as-a-judge vs human evaluation (koji.so)](https://www.koji.so/docs/llm-as-a-judge-vs-human-evaluation)
