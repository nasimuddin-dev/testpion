# AI features: what exists, what to build next

Research and plan, 2026-10-15. Owner request: "Do research, add more AI features so the user gets benefit from it."
Item ids: `AIB-…` for the shared building blocks, `AI-…` for features. Sizes as in [README.md](README.md): **S** ≤ 1 day, **M** 2–4 days, **L** 1–2 weeks.
Ground rules that apply to every item: AI-first (CLI `--json` envelope + MCP tool + docs/llms.txt), cloud-ready (engine in `packages/core`, UI only via RPC), uniform UI, the user's own key (or a local model), nothing leaves the machine that the user did not see described.

---

## 1. What exists today (2026-10-15, after v0.46.1)

### 1.1 The AI call layer (`packages/core/src/ai`)

| Piece | Where | What it does |
|---|---|---|
| Providers | `packages/core/src/ai/providers/{openai,anthropic,gemini,bedrock,mock}.ts` | OpenAI-compatible (also Azure OpenAI and **Ollama**), Anthropic, Gemini, Bedrock, a mock provider. Streaming, tools, `responseFormat`, `seed`. |
| Managed provider | `ai/index.ts:329` `ManagedProvider` | Rate limit, bounded concurrency, retry with backoff on 429/5xx/network/timeout. |
| Registry | `ai/index.ts:423` `ProviderRegistry` | Resolves `ModelRef` → provider; keys from `{{$secret.x}}` / `{{$env.X}}`; implicit `mock`, `ollama`, env-key providers (`:466`). |
| Missing key | `ai/index.ts:404` `missingKeyError` | `ConfigurationError` with `details.setup.provider`; the app shows **Add the key** (`apps/desktop/src/components/Results.tsx:24`) which opens AI Lab ▸ Providers (`views/AiLabView.tsx:27`). |
| App key | `ai/app-provider.ts:194–237` | "Claude (your API key)" in the OS secret store; `checkAnthropicKey` validates for free. |
| Cost | `ai/index.ts:493` `estimateCost` | User-configured, versioned price table. `ai/types.ts:306` `estimateTokens` (chars/4) when a provider reports none. |
| Agent loop | `ai/agent.ts:100` `runAgent` | Provider-agnostic tool loop, every LLM/tool call a span (used by `agent` test type and the AI Lab). |
| Parsers | `ai/assist.ts:19` `parseGeneratedRequest`, `:53` `generatedTestScript` | Extract a request JSON / a `tp.test` script from model text; label "AI-generated". Unit tests: `tests/unit/ai-assist.test.ts`. |

### 1.2 The in-app assistant (desktop backend only)

* `apps/desktop/backend/backend.ts:1096` `assistant()` — one call per task: system prompt + `assistantInstruction(task)` + redacted context (`ctx.redactor.redact(...)`), `temperature 0.2`, `maxTokens 2000`, last 12 turns, streams `assistant.deltas`, cancel with `ai.cancel`.
* `apps/desktop/backend/assistant-tasks.ts:6–52` — **22 task prompts**: explain-error, generate-assertions, generate-test, generate-query, generate-args, generate-mock-data, design-toolset, design-flow, analyze, explain-response, generate-request, generate-pm-tests, explain-api-changes, fix-security, explain-fuzz, fix-openapi-lint, analyze-load, explain-test-failure, suggest-coverage-tests, explain-exchange, explain-timing, explain-test-history, explain-monitor, triage-attention, write-commit-message, free.
* `apps/desktop/src/components/AssistantPanel.tsx` — right-panel drawer: conversation, streamed Markdown, Copy per code block, optional **Apply** button (`:228` `Answer`) that hands the first code block to a caller-supplied `apply.run(code)`; errors become a toast.
* `apps/desktop/src/lib/assistant-context.ts` — each view offers "what is on screen" as a chip the user can remove.
* Entry points (all open the same panel): Results "Explain" (`components/Results.tsx:92`), RunPanel "Explain with AI" on a failed test (`components/RunPanel.tsx:461`), RestView explain-response / suggest assertions with Apply (`views/RestView.tsx:479`, `:523`), timing (`ResponseViewer.tsx:383`), coverage gaps with "Save as a test" (`ApiCoverageDialog.tsx:120`), fuzz (`ApiFuzzPanel.tsx:183`), lint (`ApiLintPanel.tsx:61`), API diff (`OpenApiDiffDialog.tsx:130`), security review (`SecurityReviewDialog.tsx:43`), Debugger exchange (`views/DebuggerView.tsx:232`), load results (`views/LoadView.tsx:486`), monitors (`views/MonitorsView.tsx:447`), test history (`TestHistory.tsx:67`), attention/problems (`AttentionCard.tsx:29`, `lib/problems.ts:58`), MCP toolset design (`mcp/ToolsetEditor.tsx:133`), MCP tool args (`mcp/ToolsPanel.tsx:129`), GraphQL query (`views/GraphQLView.tsx:466`), commit message (`backend/handlers/git.ts:161`), command palette / Shell / Home "Ask the assistant".
* RPC: `backend/handlers/ai.ts` — `ai.chat`, `ai.compare`, `ai.generateRequest` (`:77`, NL → request, opened as a dirty tab), `ai.generateTests` (`:82`, response → tp script), `assistant.ask`, `ai.usage`.
* MCP sampling: `backend/handlers/mcp.ts:67` `mcp.sampleDraft` — when a server under test asks for sampling, the assistant drafts a reply the user reviews (`backend.ts:1075`).

### 1.3 Flow designer "Generate with AI"

`apps/desktop/src/components/FlowDesigner.tsx:429` `generate()` — asks for one or two sentences, sends the current steps (id, name, method, url, extract, dependsOn), task `design-flow`; **Review and use this flow** runs `tests.lint`, then a confirm, then `applyFlowEdit({op:'replace'})` (one undo step). No collection picker, no retry with the lint error, whole-file replace.

### 1.4 Evaluations, LLM/RAG/agent testing (AI *under test*)

* Test types `llm`, `rag`, `agent` (`packages/core/src/runner/test-schema.ts:31`); LLM load profiles (`packages/core/src/load/load.ts:16`, tokens/s, TTFT).
* Checks (`packages/core/src/eval/checks.ts`): deterministic + `similarity`, `llm-judge` (`:680`), claim-by-claim `context-precision/recall`, `groundedness`/`faithfulness`, `answer-relevance`, `answer-correctness`, `citation` (`:579` explains the Ragas-style approach), agent checks `tool-called`, `tool-sequence`, `tool-args-valid`, `no-leak`, `refusal`.
* Evaluation matrix + compare (`packages/core/src/eval/matrix.ts`, `runner/eval-matrix-runs.ts`, CLI `eval matrix|compare` `packages/cli/src/commands/eval-compare.ts:32,90`, MCP `eval_matrix`, `eval_compare`), saved evaluations (`runner/saved-evaluations.ts`), human review of results (MCP `run_reviews` / `review_result`, `testpion-mcp.ts:1116`), AI Lab playground/compare, usage per model (`storage/llm-usage.ts` — **AI Lab history only**).

### 1.5 Deterministic generators (no LLM) that AI features should build on

| Generator | Where | Surfaces |
|---|---|---|
| Tests per operation from OpenAPI (+ an invalid request) | `openapi/tests-from-spec.ts` | MCP `generate_tests` (`mcp-server/openapi-tools.ts:19`), app API preview |
| CRUD integration flows from a spec **or a collection** | `openapi/flows-from-spec.ts:199`, `:316` `flowsFromCollection` | MCP `generate_flows` (`openapi-tools.ts:39`) |
| Flow steps from saved requests, extract suggestions from examples | `runner/flow-steps-from-requests.ts:22` `suggestedExtracts`, `:82` `collectionSteps` | Flow designer "Add from collection" |
| Flow from captured traffic / HAR | `runner/flow-from-exchanges.ts`, CLI `flow from-har` | Debugger |
| Datasets from a schema / operation | `runner/generate-dataset.ts`, `storage/dataset-files.ts` | CLI `generate-data`, MCP `generate_dataset` |
| Fuzz from a schema | `openapi/fuzz.ts` | MCP `api_fuzz`, app fuzz panel |
| Coverage gaps | `openapi/coverage.ts` | CLI `coverage`, app coverage dialog |
| Flaky tests / test history | `runner/test-history.ts:90` `flakyTests`, `:53` flips | MCP `flaky_tests`, `test_history` |
| Semantic workspace diff | `git` handlers (`git changes`) | CLI `git changes`, commit message |
| Agent files | `packages/core/src/agents/agent-files.ts`, CLI `agents init|agents-md` | `AGENTS.md`, MCP config |
| MCP prompts for the calling agent | `mcp-server/agent-kit.ts:186` `AGENT_PROMPTS` (investigate_failures, write_tests, debug_request, api_health_report, import_and_test) | `prompts/list` (`testpion-mcp.ts:1439`) |

### 1.6 Quality gaps (what is thin)

1. **Not AI-first.** The assistant, its 22 prompts and both generators live in `apps/desktop/backend` — the CLI, the MCP server and a future cloud host cannot use them. There is no `testpion ai …` command and no MCP tool that runs an assistant task. This breaks ground rules 2 and 3.
2. **Free text in, code-block out.** Every task returns Markdown; callers pick the first fenced block (`extractCodeBlock`). No JSON schema per task, no structured-output mode, no repair loop: when Apply fails (`AssistantPanel.tsx:233`) the error is a toast — the model never sees it. `finishReason` (truncation at 2000 tokens) is ignored (`backend.ts:1130`), so a long flow can be silently cut.
3. **Context is a string slice.** `JSON.stringify(redacted).slice(0, 24_000)` (`backend.ts:1107`) can cut JSON mid-value and drops whatever comes last; no per-field budget, no sampling of large collections, no token estimate.
4. **Cost is invisible for the assistant.** `assistant()` returns `usage` but nothing records it; `ai.usage`/`llmUsage` covers AI Lab runs only. No per-feature caps, no "≈ 3 k tokens · $0.01" before sending.
5. **Privacy is name- and value-based only.** `util/redact.ts:13` masks configured field names and known secret values. A bearer token inside a body field called `t`, a JWT in a query string, emails / phone numbers / card numbers in a response are sent as-is. The user cannot see the exact payload before sending.
6. **Generated code is not verified.** `ai.generateTests` appends the script to the Post-response tab without running it (`views/RestView.tsx:467`: "Send again to run them"); suggested assertions are added without evaluating them against the response they were written for; `explain-test-failure`, `explain-monitor`, `explain-fuzz`, `fix-openapi-lint` are prose only — no change to apply.
7. **One model for everything.** `settings.assistantProvider/assistantModel` serve a commit message and a 40-step flow alike; no "cheap model for small tasks", no local-model default for sensitive views.
8. **No grounding beyond the current view.** The free chat sees one view's context; it cannot look up other requests, runs or history, and cannot cite items (`ItemRef`, `packages/shared/src/item-ref.ts`).
9. **Prompts are untested.** Only the two parsers have unit tests; there is no eval suite for the 22 tasks, no prompt version, no regression when a prompt changes. (TestPion sells evals — it should eat its own.)
10. **Evaluations get no AI help.** No case generation, no rubric drafting, no judge calibration against the human reviews that already exist.

---

## 2. Research summary

Web research, 2026-10-15. Items marked *[vendor]* are self-reported claims.

### 2.1 What other API tools ship
| Tool | AI features | Review / privacy model |
|---|---|---|
| Postman | Postbot (test/script generation); Agent Mode (June 2025) is a lifecycle chat agent that adds tests to requests; Flows AI blocks + LLM-judge evals; AI Agent Builder / MCP generator | Agent Mode has an "Auto-run" setting: when it is off, the user approves each tool action. Cloud agent review is a PR. Runs on Bedrock. I found no BYOK or local-model option. [learning.postman.com/docs/agent-mode/get-started](https://learning.postman.com/docs/agent-mode/get-started), [AWS case study](https://aws.amazon.com/blogs/machine-learning/how-postman-runs-agent-mode-for-40-million-developers-on-amazon-bedrock/), [Flows AI](https://learning.postman.com/flows/build-flows/ai/overview) |
| Insomnia 12 | MCP client; AI mock-server generation; AI commit messages (editable/discardable) | Claude/OpenAI/Gemini keys, custom URL, or local LLM; can be turned off; free. [konghq press release](https://konghq.com/company/press-room/press-release/kong-releases-insomnia-12-to-accelerate-api-and-mcp-development-with-ai-powered-testing-and-collaboration), [AI in Insomnia](https://developer.konghq.com/insomnia/ai-in-insomnia/) |
| Bruno (v4 beta) | Script autocomplete, script/test generation, docs generation, chat at workspace/request level | BYOK incl. any OpenAI-compatible endpoint; "no data is routed through Bruno servers". [docs.usebruno.com/ai](https://docs.usebruno.com/ai/bruno-ai/introduction) |
| Apidog | Per-endpoint "Generate with AI" by category (positive / negative / boundary / security). Each case is runnable and accepted or discarded singly or in bulk | BYOK, keys encrypted locally. [docs.apidog.com](https://docs.apidog.com/generate-test-cases-1624860m0) |
| Thunder Client | AI script conversion and test generation | Paid plans only. [docs.thunderclient.com/features/ai](https://docs.thunderclient.com/features/ai) |
| Yaak | No built-in LLM. Has an MCP server, a JSON CLI and `yaak agent install` skills | Positions itself as free of "unnecessary AI". [yaak.app MCP](https://yaak.app/docs/getting-started/mcp-server) |
| HTTPie | NL → request in the URL field, then regenerate or edit | Needed an account. [httpie.io/blog/ai](https://httpie.io/blog/ai) |
| Hoppscotch, Kreya | Hoppscotch only auto-names requests; I found no AI in Kreya | [Hoppscotch 2024.7](https://dev.to/hoppscotch/hoppscotch-v202470-junit-reports-user-management-api-more-2an3) |

**What TestPion can take from this:** among local-first clients, BYOK plus local models and MCP in both directions are now baseline. Apidog's flow (generate by category, run, accept per case) is the clearest pattern for test generation. Nobody offers a reviewed, verified diff for collection or flow edits; Postman's per-action approval is the closest. TestPion already has more AI surfaces than Bruno or Insomnia. What it lacks is verification, structured proposals and CLI/MCP parity.

### 2.2 Test generation: what works
* **Keep a generated test only after it runs.** Meta TestGen-LLM / Qodo Cover keep a test only if it builds, passes reliably and adds coverage. In Meta's numbers, 75% of generated tests built, 57% passed reliably and 25% added coverage; humans accepted about half of the survivors. [qodo.ai](https://www.qodo.ai/blog/we-created-the-first-open-source-implementation-of-metas-testgen-llm). TestPion should apply the same filters to every generated test.
* **Hallucinated assertions** (`user_id` instead of `userId`, 200 instead of 201) create noise that teams learn to ignore. The fix is to ground assertions in a response that was actually observed. [testsprite (vendor)](https://www.testsprite.com/blog/how-does-testsprite-reduce-hallucinated-assertions-in-backend-testing)
* **Research tools pair the spec with an LLM.** KAT builds an operation-dependency graph from OpenAPI and covers 15.7% more status codes than RestTestGen. [arXiv 2407.10227](https://arxiv.org/abs/2407.10227v1). LlamaRestTest shows that small fine-tuned or quantised Llama-3-8B models beat larger ones on parameter dependencies and valid inputs, which is good news for local models. [arXiv 2501.08598](https://arxiv.org/abs/2501.08598v2). ARAT-RL feeds values from earlier responses into later calls. [ASE 2023](https://conf.researchr.org/details/ase-2023/ase-2023-papers/104/Adaptive-REST-API-Testing-with-Reinforcement-Learning). Schemathesis runs stateful tests via OpenAPI links. [pypi](https://pypi.org/project/schemathesis/3.13.4)
* **Recorded-traffic tests:** Keploy records traffic and uses AI to extend it with edge cases. [keploy.io](https://keploy.io/docs/concepts/what-is-keploy.md). The TestPion equivalent is Debugger capture → flow → AI edge cases.
* **Self-healing hides defects.** mabl documents false passes caused by auto-heal and offers an opt-out. [help.mabl.com](https://help.mabl.com/docs/assertions-and-auto-heal). TestPion should never auto-apply a "fix" that makes a check pass.

### 2.3 Review-before-apply
* Cursor reviews per file and per line with a review bar. [docs.cursor.com](https://docs.cursor.com/agent/review). Users pushed back when Cursor 3 auto-applied edits. [forum](https://forum.cursor.com/t/bring-back-per-change-apply-inline-diff-review-you-re-throwing-away-your-best-ux-advantage/160856)
* VS Code Copilot has Keep/Undo per edit, checkpoints before each request, and pending edits that survive a restart. [code.visualstudio.com](https://code.visualstudio.com/docs/agents/run/review-code-edits)
* Copilot Workspace went from an editable spec, to an editable plan, to a diff, then added automatic build/test with repair attempts. [manual](https://github.com/githubnext/copilot-workspace-user-manual/blob/main/overview.md), [auto-validation](https://github.blog/changelog/2025-01-31-copilot-workspace-auto-validation-go-to-definition-and-more)
* **For TestPion:** plan and assumptions → per-item diff → automatic verification → accept per item or in bulk → one undo step.

### 2.4 Failure triage and flaky tests
* **Datadog** uses states Active / Quarantined / Disabled / Fixed. Its "attempt to fix" reruns a test up to 20 times. [docs.datadoghq.com](https://docs.datadoghq.com/tests/flaky_test_management/)
* **Trunk** defines flaky as "pass and fail on the same code". It quarantines by overriding the exit code, and auto-quarantines flaky tests but never broken ones. [docs.trunk.io](https://docs.trunk.io/flaky-tests/quarantining)
* **CloudBees Smart Tests (formerly Launchable)** "never hides tests automatically". [docs.cloudbees.com](https://docs.cloudbees.com/docs/cloudbees-smart-tests/latest/features/unhealthy-tests)
* **Sentry Seer** finds root causes agentically, with tools over traces and logs and with linked evidence. It runs in stages (root cause → solution → code) and you can stop after any stage. [docs.sentry.io](https://docs.sentry.io/product/ai-in-sentry/seer/root-cause-analysis/)
* **GitHub "Explain error"** for failed Actions jobs explains one job at a time, with a follow-up "suggest a fix". [changelog](https://github.blog/changelog/2025-01-15-copilot-users-can-ask-about-a-failed-actions-job-ga)
* **For TestPion:** detect deterministically, use the LLM only to explain, attach evidence to every claim, and let the user stop after "explain".

### 2.5 LLM-as-judge
* **Use binary verdicts, swap positions, report Cohen's κ.** Prefer binary or pairwise judgements. Swap positions: position bias was about 50–70% in older judges. Judges also favour verbose answers and their own outputs. Report Cohen's κ rather than raw agreement. [eugeneyan.com](https://eugeneyan.com/writing/llm-evaluators/), [arXiv 2406.07791](https://arxiv.org/html/2406.07791v7)
* **Calibrate against an expert.** Get binary pass/fail plus a written critique from one domain expert, then iterate the judge until it agrees with that expert. [Hamel Husain](https://hamel.dev/blog/posts/llm-judge/)
* **Prefer code-based grading.** LLM graders reason first and need validation before scaling up. [Anthropic: develop tests](https://platform.claude.com/docs/en/test-and-evaluate/develop-tests)
* TestPion already stores human reviews (`review_result`), which is exactly the data a calibration step needs.

### 2.6 API security
* **OWASP API Top 10 2023:** BOLA, broken authentication, BOPLA (property-level), resource consumption, BFLA (function-level), business flows, SSRF and others. [owasp.org](https://owasp.org/API-Security/editions/2023/en/0x11-t10/)
* **Unit 42 BOLABuster:** the LLM maps endpoint dependencies, then two users test each other (A creates, B accesses). It needed fewer than 1% of a fuzzer's requests and found 15 CVEs. [unit42](https://unit42.paloaltonetworks.com/automated-bola-detection-and-ai/)
* **Escape** has a victim/attacker BOLA agent; plain-language authorisation rules reduce its false positives. [docs.escape.tech](https://docs.escape.tech/documentation/ai-pentesting/bola-agent)
* **StackHawk:** "AI to understand, deterministic to decide." [sdtimes](https://sdtimes.com/appsec/stackhawk-adds-business-logic-testing-blt-to-its-appsec-platform-menu/)

### 2.7 Agents, tools and MCP
* **Writing tools for agents** ([anthropic.com](https://www.anthropic.com/engineering/writing-tools-for-agents)):
  * a few high-impact tools rather than one per endpoint
  * concise/detailed `response_format`
  * pagination and truncation with hints on how to narrow the result
  * actionable errors
  * evaluation on realistic multi-step tasks
* **Building effective agents** ([anthropic.com](https://www.anthropic.com/research/building-effective-agents)): start with one optimised LLM call. Use evaluator-optimizer loops where criteria are clear, which matches TestPion's generate → verify → repair.
* **MCP sampling:** the client chooses the model, and a human in the loop SHOULD review. The 2025-11-25 spec allows tool use inside sampling. [spec](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling.md)

### 2.8 What users say and want
* **Stack Overflow 2025 survey** ([survey.stackoverflow.co/2025](https://survey.stackoverflow.co/2025/)):
  * 84% use or plan to use AI, but 46% distrust its accuracy (33% trust it) and favourability fell to 60%.
  * 66% are frustrated by answers that are "almost right".
  * 45% say debugging AI-generated code takes longer than expected.
  * Experienced developers are the most sceptical.
* **Postman State of the API 2025:** 51% name unauthorised or excessive calls by agents as their top security worry *[vendor]*. [businesswire](https://www.businesswire.com/news/home/20251008162423/en)
* Postman's forced cloud sync drove users to Bruno, whose pitch is offline and Git-friendly. AI that is paid per seat is a common complaint (Thunder Client, Katalon).
* **Synthesis — what API developers, QA and SREs want:**
  * AI that is optional and visible, never forced
  * their own key or a local model, with nothing sent through a vendor
  * AI kept to authoring and explaining, with deterministic execution
  * a diff before anything is applied
  * generated tests proven by running them
  * explanations that cite evidence
  * real failures never hidden

### 2.9 Local models
* **Ollama** serves `/v1/chat/completions` (marked experimental). Its native `format` and `/v1` `response_format: json_schema` are grammar-constrained on local v0.5+, but Ollama Cloud does not enforce the schema, so output must still be validated. [ollama structured outputs](https://ollama.com/blog/structured-outputs), [compat](https://docs.ollama.com/api/openai-compatibility.md)
* **LM Studio** at `:1234/v1` supports `json_schema` but reportedly not `json_object`; tool calling works. [lmstudio.ai](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
* **For TestPion:** the existing OpenAI-compatible provider covers both. The structured-output layer (AIB-3) must use `json_schema`, validate the output and repair it. Add an LM Studio preset next to Ollama.

---

## 3. Principles (apply to every AI feature)

1. **Propose, never apply.** The model's output is a *proposal*: a structured change (flow edit ops, checks to add, a request patch, files to write) shown as a diff/preview labelled "AI-generated" with the model name. Accept / edit / regenerate with a hint / discard. Nothing is saved, sent or run until accepted. CLI/MCP get the same: `--dry-run` is the default for AI commands, `--apply` writes; MCP tools return the proposal and a `proposal_id`, a second call applies it (with `confirm: true`, elicitation via `tool-contract.ts` `elicitationConfirmer` when the client supports it).
2. **Verify by running.** A generated artefact is checked by the engine before the user sees it as "ready": parse → lint (`tests.lint`, flow lint: cycles, unknown refs, unset variables) → **dry evaluation** (assertions against the response they were written for; tp scripts executed in the sandbox against the stored response; flows run against a mock server or with `--dry-run` request building) → optionally a real run on request. The proposal shows a verification badge: *parsed · linted · 7/7 checks pass on the last response*.
3. **Repair loop, bounded.** If parse/lint/verify fails, send the error back once or twice (`maxRepairs: 2`), then show the best attempt with its problems instead of hiding them.
4. **Deterministic first, AI to enrich.** Where an engine generator exists (`flowsFromCollection`, `writeTestsFromSpec`, `fuzzCases`, `suggestedExtracts`, `flakyTests`, coverage, semantic diff), run it first; the model receives its output and *improves* it (naming, ordering, edge cases, explanations). With no key or offline, the user still gets the deterministic result — AI is an upgrade, not a dependency.
5. **Privacy by default.** Every call goes through one context builder that redacts (secret values, sensitive field names, plus pattern detectors for tokens/JWTs/keys/PII), sends variable *names* never values, and offers a **"metadata only"** level (shapes and names, no bodies). The user can open **"What will be sent"** and see the exact payload. Local providers (Ollama/LM Studio via the OpenAI-compatible provider) are first-class; a workspace setting can require a local model for AI features ("AI stays on this computer").
6. **Cost is visible and capped.** Before sending: estimated input tokens and cost (price table from `settings.pricing`). Per-call and per-day caps (tokens and $) with a clear refusal. Every call — app, CLI, MCP — is logged to one usage log with feature, model, tokens, cost, duration, outcome (accepted/discarded).
7. **Provider-agnostic, per-feature routing.** A feature declares a tier (`small` | `large`); settings map tiers to models (e.g. Haiku/`llama3.1:8b` for commit messages, Opus for flow design). Structured output uses the provider's JSON-schema mode where available, with a parse-and-repair fallback for those without.
8. **Graceful degradation.** No key → the feature still opens, explains, and offers **Add the key** (existing `missingKeyError` path) or the deterministic result; offline → same; provider error → the normalized error with suggestions; truncated output (`finishReason: length`) → say so and offer "continue" / a bigger limit.
9. **One shared AI call layer in core.** Tasks, prompts, context building, redaction, structured output, repair, verification hooks, usage logging live in `packages/core/src/ai/` so the desktop backend, CLI, MCP server and cloud host call the same function. The desktop `assistant()` becomes a thin adapter.
10. **Prompts are code.** Each task has an id, a version, an output schema and a golden test set run against the mock provider in unit tests and against a real model in an opt-in eval (`npm run ai-evals`, using TestPion's own evaluation engine). A prompt change that drops the score fails CI.
11. **Honest labelling.** "AI-generated", the model, the prompt version, and what was verified are stored with the artefact (a comment header in YAML/JS, `meta.ai` in JSON items) so reviewers in a PR can see it.
12. **AI can be switched off.** One setting hides every AI action (Insomnia/Bruno do the same). The local app stays complete without AI, and AI is never a paid-only feature of the local app (README rule 5).
13. **MCP clients are already LLMs.** For agents calling TestPion over MCP, prefer *deterministic context packs* (triage bundle, coverage gaps, semantic diff) plus `AGENT_PROMPTS` over calling a second LLM; offer the assistant-backed tools for clients that want TestPion's own model (and MCP sampling when the client offers it).

---

## 4. Shared building blocks (build once)

### AIB-1 · Core AI task runner (`packages/core/src/ai/tasks/`) — M
* Move `assistant-tasks.ts` and the body of `backend.ts:1096` into core: `runAiTask(ctx, { task, input, options })`.
* A task definition: `{ id, version, tier, instruction, outputSchema?, buildContext(input, budget), parse(output), verify?(proposal, ctx), maxRepairs }`.
* Uses `ProviderRegistry` from the engine context; the assistant provider/model come from settings (desktop) or `--provider/--model` / `TESTPION_AI_PROVIDER` (CLI/CI).
* Desktop `assistant.ask` and `ai.generate*` call it; the panel keeps streaming.
* Tests: every existing task keeps working against the mock provider (`ai/providers/mock.ts`).

* *Built (2026-10-16):* `packages/core/src/ai/tasks/{registry,prompts,run}.ts` — 26 tasks (prompts moved unchanged from `apps/desktop/backend/assistant-tasks.ts`, now deleted), each `{ id, version, tier, instruction, output (markdown | code | json schema), context, sectionBudgets, verifiers, propose() }`; `runAiTask(deps, req)` + `aiRunDeps({ ctx, settings, surface })`; context from a workspace item (`ai/item-context.ts`: request + latest response, history, run / result, test, flow, spec, collection, folder). Desktop `assistant()` (`backend.ts`) is a thin adapter; RPC `ai.tasks`, `ai.runTask`, `ai.preview` (`backend/handlers/ai-tasks.ts`); CLI `testpion ai tasks|run` (`packages/cli/src/commands/ai.ts`); MCP `ai_list_tasks`, `ai_run_task` (`mcp-server/ai-tools.ts`, read-only, propose only). `generate-request` is the first JSON-schema task. Left: MCP sampling as a model source when no model is configured; `sampleWithAssistant` (MCP server-under-test sampling) still calls the provider directly.

### AIB-2 · Context builder with redaction and budgets (`ai/context.ts`) — M
* Inputs are typed (`request`, `response`, `run result`, `collection`, `flow`, `history slice`, `spec slice`), not one JSON blob.
* Per-section token budget; large arrays are *sampled* (first, last, failed, distinct shapes) and bodies *summarised to shape* (`{ id: number, items: [ {…} ×20 ] }`) instead of cut; never slice JSON text.
* Privacy levels: `full` | `no-bodies` (metadata only) | `names-only`.
* Redaction: existing `Redactor` + new detectors in `util/redact.ts`: JWT (`eyJ…\.…\.…`), `Bearer …`, AWS/GCP/GitHub/Stripe/OpenAI/Anthropic key prefixes, private keys, high-entropy strings in auth-like positions, optional PII (email, phone, card numbers with Luhn, IBAN). Reports what was masked (`redactions: [{ path, kind }]`).
* `preview()` returns the exact messages + token estimate for **What will be sent**.

* *Built (2026-10-16):* `ai/context.ts` `buildAiContext` — per-section budgets (`shareBudget`, water-filling; task `sectionBudgets`), sampling (`sampleArray`: first, last, failed, one per shape), `shapeOf`, JSON text fitted as data (never sliced), privacy levels `full | metadata | names` (`applyPrivacy`); `util/redact.ts` `redactForAi` / `maskSensitiveText` (JWT, Bearer/Basic, private keys, provider key prefixes, credential query params; PII: e-mail, phone, Luhn card, IBAN mod-97; secret variable values via the Redactor; `redactions[{path, kind}]`). "What will be sent": `prepareAiTask` / `runAiTask({ dryRun })` → `preview` (messages, sections, tokens, estimate, redactions); RPC `ai.preview`; shared dialog `components/ai/AiPreviewDialog.tsx` (privacy switch); CLI `ai run --dry-run`; MCP `ai_run_task { dryRun }`. Settings `ai.privacy`, `ai.maskPersonalData`.

### AIB-3 · Structured output + repair loop (`ai/structured.ts`) — M
* `chatStructured({ schema, … })`: uses `responseFormat` JSON-schema where the provider supports it (OpenAI/Ollama `format`, Gemini `responseSchema`, Anthropic tool-use-as-schema), else instructs + extracts + validates with `validateSchema`.
* On parse/schema/verify failure, append the error and retry up to `maxRepairs`; detect `finishReason === 'length'` and either continue or fail clearly.
* Returns `{ value, attempts, usage, problems }`.

* *Built (2026-10-16):* `ai/structured.ts` — `chatStructured` (JSON-schema `responseFormat` for OpenAI-compatible / Ollama / LM Studio / Gemini, prompt-only otherwise and as fallback when a server refuses `response_format`; tolerant `extractJson`; `validateSchema`; `check()` hook for verifiers; ≤ `maxRepairs` (2) turns with the problems; best attempt + problems returned), `chatText` (truncation via `isTruncated(finishReason)`, one continuation). Code tasks repair on verifier failures in `runAiTask` (best attempt kept); a code/JSON answer still cut fails with a clear `ValidationError` (`details.truncated`), prose returns `truncated: true`. The mock provider (`providers/mock.ts`) gained scripted `responses[]` and `finishReason` for tests.

### AIB-4 · Proposal model + review UI (`ai/proposal.ts`, `components/ai/ProposalReview.tsx`) — L
* `AiProposal = { id, task, model, promptVersion, summary, assumptions[], changes: Change[], verification: { parsed, linted, checks?: {passed, failed}, ran? }, usage }` with `Change` = `{ kind: 'file' | 'flowEdit' | 'requestPatch' | 'checks' | 'dataset' | 'collectionItems', target: ItemRef, before?, after }`.
* Stored in the meta store for 24 h so CLI/MCP can `apply` by id (`ai apply <proposal-id>`, MCP `apply_ai_proposal`).
* One shared review component (uniform UI): summary + assumptions, per-change diff (reuse the git diff viewer used by `git diff`/semantic diff), per-change checkboxes, verification badges, **Accept selected**, **Regenerate with a hint**, **Discard**, **What was sent**. The AssistantPanel's Apply becomes "Review proposal" opening this component.
* Accept applies through existing engine edits (`applyFlowEdit`, collection save, `tests` writers) → one undo step.

* *Built (2026-10-16):* `ai/proposal.ts` (`Proposal`, `ProposalItem` kinds file | flow | assertion | script | request | patch | text, `VerificationBadge`; stored in `.local/ai/proposals/<id>.json`, a day (applied: a week, for undo), at most 200) and `ai/proposal-apply.ts` (`applyProposal` through `writeTestFile` / `saveCollection` — own-writes reporting included; `undoProposal`; outcome `accepted`/`discarded` noted in the ledger). Review UI `components/ai/ProposalReview.tsx` (per-item checkbox, diff via `DiffText` + shared `unifiedDiff` in `packages/shared/src/text-diff.ts`, badges, select all/none, Regenerate with a hint, Discard, Ctrl+Enter, Esc); opened from the assistant panel's "N proposed changes · Review" (an editor's own Apply — tab checks, the flow designer's replace — still receives the accepted items). RPC `ai.proposal(s)`, `ai.applyProposal`, `ai.discardProposal`, `ai.undoProposal`; CLI `ai apply|undo|discard|proposals`; MCP `ai_proposals`, `ai_apply_proposal` (confirmed, `dryRun`), `ai_undo_proposal`. Left: `patch` items are applied but no task makes them yet. ("Try on mock" / "Run now" in the review: built with AI-1 / AI-3.)

### AIB-5 · Verifiers (`ai/verify.ts`) — M
* `verifyChecks(checks, storedResponse)` — run `runChecks` against the response the suggestion was made for.
* `verifyScript(script, storedResponse)` — run the post-response script in the existing sandbox (`packages/core/src/scripts`) without network; report tp.test passes/failures.
* `verifyTestFile(yaml)` — `tests.lint` + loader parse + reference check (requests, variables, datasets).
* `verifyFlow(yaml, { mode: 'lint' | 'mock' | 'live' })` — lint for cycles/unknown refs/unset vars; `mock` runs against a mock server built from saved examples (`packages/core/src/mock`).

* *Built (2026-10-16):* `ai/verify.ts` — registry (`registerVerifier`, `verifyItems`, failing items unticked, `verificationProblems` feed the repair loop): `checks` (runChecks against the stored response + a stability warning for pinned times/UUIDs/tokens), `script` (QuickJS sandbox, no network), `test-file` (lint + loader), `flow-refs` (undefined `{{vars}}`), `flow-mock` (runs the flow against `startMockServer(collection)` with `baseUrl` → the mock), `json` (+ tool input schema), `yaml`.

### AIB-6 · AI usage ledger and caps (`storage/ai-usage.ts`) — S
* One append-only log (meta store): `{ at, surface: app|cli|mcp|ci, feature, provider, model, inputTokens, outputTokens, costUsd, ms, outcome: accepted|discarded|error|n/a, proposalId? }`.
* `ai.usage` and `llmUsage` read both AI Lab history and this ledger; Settings ▸ AI shows month-to-date by feature/model.
* Caps in settings/workspace: `ai.maxTokensPerCall`, `ai.dailyBudgetUsd`, `ai.requireLocalModel`; refusal is an `ApsError('LimitError')` with a suggestion.
* CLI `testpion ai usage --json`, MCP `ai_usage`.

* *Built (2026-10-16):* `storage/ai-usage.ts` + `MetaStore.addAiCall/listAiCalls` (SQLite table `ai_calls`, JSONL `ai` rows; 20 000 kept): `{ id, at, surface app|cli|mcp|ci, task, provider, model, inputTokens, outputTokens, costUsd, ms, outcome ok|error|cancelled|accepted|discarded, proposalId, calls, error }`; `aiUsageSummary` (today, period, by task / model / surface, daily, recent, caps left, AI Lab `llmUsage`); `checkAiCaps` (settings `ai.maxTokensPerCall`, `ai.dailyTokens`, `ai.dailyBudgetUsd`; refusal is `ConfigurationError` with `details.aiLimit` → "Change the limits"). RPC `ai.taskUsage`; AI Lab ▸ Usage starts with "AI features" (`components/ai/AiFeatureUsage.tsx`); CLI `ai usage`; MCP `ai_usage`. Left: a month-to-date line in Settings.

### AIB-7 · Per-feature model routing — S
* Settings ▸ AI assistant: "Small tasks" and "Large tasks" models (default: same model); local-only toggle. CLI `--model`, env `TESTPION_AI_MODEL_SMALL/LARGE`.

* *Built (2026-10-16):* `ai/ai-settings.ts` — `AppSettings.ai` `{ small, large, localOnly, privacy, maskPersonalData, caps }`; `resolveAiRoute` (override → `TESTPION_AI_PROVIDER` / `TESTPION_AI_MODEL[_SMALL|_LARGE]` → tier → assistant), `aiLocalOnly` (+ `TESTPION_AI_LOCAL_ONLY`), `assertLocalAllowed` (shared `staysOnThisComputer`: mock, Ollama / OpenAI-compatible on loopback), `aiNotSetUpError` (`details.setup.assistant`). Settings UI `components/ai/AiSettingsPanel.tsx`; LM Studio preset. One renderer helper `lib/ai-errors.ts` `aiSetupAction` (Add the key / Set up AI / Change the limits) used by `toastError`, `toastAiError`, the assistant panel and `ErrorPanel`. Implicit `mock` / `ollama` providers got default models.

### AIB-8 · Workspace retrieval index (`ai/workspace-index.ts`) — M
* Lexical index (BM25 over names, URLs, descriptions, docs, test names, check messages, history summaries) built from existing search (`storage/search.ts`, `item-refs.ts`), optional embeddings when the provider has `embed`.
* Returns `ItemRef`s with snippets — used by Ask-the-workspace (AI-7), triage (AI-2) and the flow generator (to find related requests).

### AIB-9 · Eval harness for TestPion's own AI (`tests/ai-evals/`) — M
* Per task: 10–30 golden inputs (fixtures workspaces in `tests/fixtures`), a deterministic scorer (parses, lints, verify passes, required elements present, no invented hosts, no secrets echoed) and an optional `llm-judge` rubric.
* Runs with the mock provider in `npm test` (shape + parse + repair paths) and with a real model in an opt-in `npm run ai-evals` (uses TestPion's own `eval matrix`; results compared with `eval compare` against the last baseline).
* Mock provider gets scripted responses per task (good, invalid YAML, missing ref, truncated) for repair-loop tests.

* *Built (2026-10-16):* `tests/ai/` — `harness.ts` (workspace + recording provider registry; mock rules or `AI_EVAL_LIVE=1` with the environment's model), `tasks.test.ts` (registry completeness, tp-not-pm in prompts, golden cases: explain-error + ledger + no secret sent, generate-assertions verified + repaired / best attempt unticked, design-flow lint repair, truncation refused + ledger error row, generate-pm-tests sandbox, generate-request schema repair + variable names not values, generate-args schema, dry run preview, discard; scorecard printed live). Unit tests `tests/unit/ai-foundations.test.ts` (detectors, context, structured, routing, caps) and `tests/unit/ai-surfaces.test.ts` (MCP tools with confirm, CLI envelope). Left: per-task 10–30 golden inputs from fixture workspaces and an `npm run ai-evals` script on the eval engine.

### AIB-10 · Uniform entry point "✦ AI" — S
* One `AiAction` button/menu component (same icon, same "Add the key" fallback, same cost hint on hover) used in every view; right-click menus get "… with AI" items from one registry so the CLI/MCP/doc list is generated from the same table.

* *Built (2026-10-16):* `components/ai/AiAction.tsx` — `AiAction` (✦ label + the eye "What will be sent…", hover estimate, lazy/async request, `onStart`), `startAi(req)` and `askAssistant()` for menus and links. Migrated: ErrorPanel (Results), RunPanel failed result, TestHistory, ResponseViewer timing, ApiFuzzPanel, ApiLintPanel, OpenApiDiffDialog, SecurityReviewDialog, MCP ToolsPanel args, GraphQL Generate, MonitorsView, LoadView (buttons → `AiAction`); App palette, RightPanel, Shell, HomeView, ApiCoverageDialog, AttentionCard, problems.ts, DebuggerView, FlowDesigner, ToolsetEditor, RestView explain/suggest (→ `startAi`). Not migrated: `key-commands.ts` (Ctrl+J toggles the panel), RestView "Generate request" / "Generate tests" (own flows over `ai.generateRequest` / `ai.generateTests`, now through the runner with verification; AI-3 moves them into the review), the commit message (`handlers/git.ts`), MCP sampling drafts. Left: right-click "… with AI" items from one registry; a setting that hides every AI action.

---

## 5. Ranked backlog

Value: H/M/L. Effort: S/M/L. Priority P0 (next release), P1, P2.

| # | Id | Feature | Value | Effort | Pri | Builds on |
|---|---|---|---|---|---|---|
| 1 | AI-1 | Integration flow from a collection/folder (owner request) | H | M | P0 | AIB-1..5, `flowsFromCollection` |
| 2 | AI-2 | Failed-run triage with a fix proposal | H | M | P0 | AIB-1..5, run results, test history |
| 3 | AI-3 | Verified assertions & tp tests (fix the existing generators) | H | S | P0 | AIB-4, AIB-5 |
| 4 | AI-4 | Tests from an OpenAPI spec, gap-driven, with negative & edge cases | H | M | P0 | `tests-from-spec`, coverage, AIB-5 |
| 5 | AI-5 | Flaky-test analysis across history | H | S | P1 | `flakyTests`, AIB-1 |
| 6 | AI-6 | Script helper: write / explain / fix tp.* scripts | H | M | P1 | AIB-3, AIB-5 sandbox |
| 7 | AI-7 | Ask the workspace (grounded chat with citations) | H | L | P1 | AIB-8 |
| 8 | AI-8 | Security test generation (BOLA/IDOR, auth, mass assignment) | H | M | P1 | `fuzz.ts`, security review, AIB-5 |
| 9 | AI-9 | Contract drift explained (spec vs traffic/history) with spec/test patches | M | M | P1 | `openapi/contract.ts`, Debugger capture |
| 10 | AI-10 | Import cleanup: Postman/curl/HAR → tidy collection with variables & chaining | M | M | P1 | importers, `collection-tidy.ts`, `flow-from-exchanges` |
| 11 | AI-11 | Evaluation authoring: cases, rubrics, judge calibration | M | M | P1 | eval engine, human reviews |
| 12 | AI-12 | Natural-language search & filters over history/runs/traces | M | M | P2 | AIB-8, history tools |
| 13 | AI-13 | Monitor & load insights: alert summaries, regressions vs baseline | M | S | P2 | monitors, load history |
| 14 | AI-14 | Collection docs & changelog from semantic diffs | M | S | P2 | `collection_docs`, `git changes` |
| 15 | AI-15 | Realistic, PII-free test data & mock responses from examples | M | S | P2 | `generate-dataset`, mock server |

### AI-1 · Integration flow from a collection or folder (P0, H, M)
* **Problem.** Writing a CRUD integration flow by hand (order, extracts, dependsOn, checks) is the slowest part of adopting TestPion; the owner asked for it explicitly.
* **UI.** Right-click a collection/folder ▸ **Generate integration flow with AI…**; Flow designer **Generate with AI** gets a source picker (*Describe in words* | *From a collection/folder* | *From a spec*). Dialog: source, optional hint ("include the refund path"), privacy level (full / metadata only), token+cost estimate, **What will be sent**. Result opens on the canvas as a draft marked *AI-generated* with a side panel: summary, assumptions ("assumed `POST /orders` returns `id`"), verification badges, per-step diff vs the deterministic draft; **Accept**, **Regenerate with a hint**, **Discard**. Nothing saved before Accept; Accept = one undo step.
* **Engine.** `generateFlowFromCollection(ctx, { collection, folder?, hint?, privacy })`: (1) `flowsFromCollection` / `collectionSteps` + `suggestedExtracts` give a deterministic draft; (2) context = requests (method, URL template, body *shape*), saved examples (shape + statuses), spec slice if linked, variable **names**; large collections sampled per resource; (3) `chatStructured` with an output schema = flow steps (id, request ref, extract, dependsOn, assertions, error cases); (4) verify: flow lint (cycles, unknown request refs, unset variables, extract used before defined), optional mock run against saved examples; repair ≤ 2; (5) proposal (AIB-4).
* **CLI/MCP.** `testpion flow generate --collection X [--folder Y] [--hint …] [--privacy metadata] [--apply] [--json]` (dry run by default; prints the proposal + verification). MCP `generate_flow_ai` (returns proposal), `apply_ai_proposal`. Without a key both fall back to `generate_flows` output with a note.
* **Privacy.** Bodies only in `full`; `metadata` sends shapes; never variable values.
* **Verification.** Lint + reference check always; "Try on mock" button runs against a mock built from examples; "Run now" uses the chosen environment only after Accept.
* **Tests.** Mock LLM: good flow, invalid YAML, unknown request ref, extract cycle, truncated output; core unit tests for context sampling; integration test CLI `--json`; e2e plan `apps/desktop/e2e/plans/ai-flow-from-collection.cjs` (mock provider).
* **Docs.** Flow designer page, CLI/MCP reference, whats-new.

* *Built (2026-10-16):* engine `packages/core/src/ai/flow-from-collection.ts` — task `flow-from-collection` (JSON plan schema `FLOW_PLAN_SCHEMA`, tier large, 12k context: `requests` 8k, `draft`, `api`; registry `prepare` reads the item itself, `propose` builds the file, `describe` gives summary / assumptions / notes). `prepareFlowContext` (collection or folder ref; requests with header *names*, auth *type*, body or its shape, up to 2 saved examples, matching OpenAPI operations from `specs/` parsed once, collection/folder variable names; > 60 requests sampled: the draft's first, one per endpoint), `deterministicDraft` (`flowsFromCollection` on the folder, steps mapped to request ids by `sameEndpoint`; else the requests in order, chained), `buildFlowFile` (steps from `stepFromSavedRequest` by request id; unknown ids dropped with a note; URL overrides only on the saved origin and the same endpoint shape; body override; inherited folder/collection auth kept; AI plans extract only what the model says, the draft keeps suggested extracts), verifier `flow-vars` (undefined variables + `flowOrderProblems`: a value used without waiting for the step that extracts it — fails, so it is repaired), `draftFlowProposal` (no model / `--no-ai`, `taskVersion: 0`), `isAiSetupError`. Runner: `AiTaskDef.prepare/describe/aliases`, `AiTaskInput.local/label`, `Proposal.notes`, `request.path`, `ProposalItem.alternatives`, `previous` response; `structured.ts` keeps a no-worse repair on a tie. `verify.ts` `pointFlowAtMock` (every step's origin → the mock, auth and sendRequest scripts dropped, non-HTTP steps refuse the mock run); `flowOfFile` previews unsaved `text`. `proposal-verify.ts` `reverifyProposal` (edit, safer form, Try on mock, Run now). `applyProposal({ recordOnly })` for editors that apply themselves. Surfaces: RPC `ai.generateFlow` (+ `noAi`), `ai.reverifyProposal`; UI `components/ai/FlowGenerateDialog.tsx` (source: collection/folder or describe in words, hint, privacy, estimate via `ai.preview`, What will be sent, Stop, setup action + Use the draft without AI), `components/ai/FlowProposalReview.tsx` (canvas preview via `tests.flow {text}`, YAML edit + Check again, Changes, assumptions, notes, badges, Try on mock, Regenerate, Discard, Accept → `ai.applyProposal` + Run now / Open / Undo, or the designer's one-undo replace), `components/ai/flow-generate.ts` (`generateFlowItem` on collection and folder menus and Collections ▸ Export, `startFlowGenerate`); FlowDesigner `generate()` now opens it (describe-in-words runs `design-flow` through the same dialog and review). CLI `testpion flow generate` (`packages/cli/src/commands/flow-generate.ts`); MCP `flow_generate` (`mcp-server/ai-tools.ts`, docs in `tool-docs.ts`). Tests: `tests/ai/flow-from-collection.test.ts` (draft, folder scope, good flow, invalid JSON repaired, invented/out-of-folder requests dropped, cycle and order repaired, metadata sends no bodies, secrets never sent, dry run, mock pointing, mock run), `tests/unit/ai-flow-surfaces.test.ts` (MCP + CLI `--dry-run`, proposal, `--apply`, `--no-ai`, fallback without a model), e2e `apps/desktop/e2e/plans/ai-flow-from-collection.cjs` (real right-click → dialog → review → Try on mock → Accept → Run now passes on 127.0.0.1:4010; canvas suggestion). Left: a "From a spec" source in the dialog (AI-4), per-step diff against the deterministic draft in the review, MCP sampling as the model when none is configured.

### AI-2 · Failed-run triage with a fix proposal (P0, H, M)
* **Problem.** After a red run, users open each failure, compare expected/actual, check if the API or the test changed. Today "Explain with AI" (`RunPanel.tsx:461`) gives prose per test, no grouping, nothing to apply.
* **UI.** Run summary ▸ **Triage failures with AI**: failures grouped by probable cause (same status, same check, same endpoint, same time window as a monitor alert), each group labelled *API regression* / *test is stale* / *environment/data* / *flaky* / *auth* with evidence (diff of this response vs the last passing one from history) and a **proposed fix**: check edits (update expected value, loosen a timing check, use `exists` instead of `equals` for generated ids), request patches, or "API bug — copy a bug report" (Markdown with curl, redacted). Fixes open in the proposal review; re-run only the affected tests after Accept.
* **Staged like Sentry Seer:** *Explain* (root cause + evidence links) → *Propose fix* → *Apply*; the user can stop after any stage; every claim links its evidence (result, history entry, trace span as `ItemRef`).
* **Engine.** `triageRun(ctx, runId)`: deterministic pre-clustering (check type + path + status + endpoint), last-passing response from history (`history-compare.ts`), flake score from `test-history.ts`; LLM classifies clusters and proposes `Change[]`; verifier re-evaluates edited checks against the failing response *and* the last passing one (a fix must not just accept anything).
* **CLI/MCP/CI.** `testpion triage <runId|--last> [--json] [--apply]`; `testpion run … --triage` adds a triage section to JUnit/HTML/Markdown reports and the GitHub Action summary (`action.yml`); MCP `triage_run` (deterministic bundle always; AI classification when a key is set or via sampling).
* **Privacy.** Response bodies redacted + shape-summarised; metadata-only level available for CI.
* **Tests.** Fixture runs: stale expected value, 500 regression, timing flake, auth expiry; mock LLM; verifier rejects a "fix" that makes the check trivially true.

* *Built (2026-10-16):* engine `ai/run-evidence.ts` (`runEvidence`: one streamed pass groups failures by first failed check / error kind + status + `endpointTemplate` (ids, numbers, hashes → `{id}`, no query); ≤ 40 groups (`omitted` counts the rest), ≤ 2 representatives each with refs (`run:<id>:<result>` + `resultSourceRefs`), request line, response from the trace (16 KB) or the result (4 KB, `complete` when not cut), failed checks, the source's check configs that failed (`failedAssertions`, matched by type + `checkNameOf`), unresolved variables, error; one pass over earlier runs for the last passing result (its response, `diffResponses`: status / non-volatile headers / body paths) and flips; deterministic `hint`; `failedRunSummary('last')` = `latestFinishedRun` with failures), `ai/fix-items.ts` (`fixItems`: check replace in a saved request (`assertion` item with `data.replace`) or a test-file step (`applyFlowEdit updateStep`, comments kept), exact find/replace edit of a file or a request's test script, a step `set` (flaky), a `variable` item (new kind: environment variable, apply/undo via env-edit, secret variables refused by `setEnvironmentVariables`); `bugReport` (masked); verifier `fix`: `verifyCheckChange` — passes on the failing response, never on JUNK responses (*accepts any response*), compared with the last passing one (*follows an API change* = warn), lint for files, sandbox for scripts, secret-looking variables refused; `data.fix.base` makes apply refuse a file/script changed since), `ai/triage.ts` (task `triage-run` v1: `TRIAGE_SCHEMA` causes → groups, kind, title, explanation, confidence, evidence, fix check | edit | variable | none; `triageContext` per privacy — metadata drops body values, failure messages and definitions; `prepareTriage` / `proposeTriage` (unknown groups dropped with a note) / `describeTriage` → `Proposal.findings` (new: id, title, kind, confidence, explanation, evidence with refs, count, resultIds, groups; groups no cause explains are listed as deterministic findings); `deterministicFindings` clusters auth / environment groups), `ai/triage-run.ts` (`triageRun`: evidence once (`withEvidence`), task, report; no model → deterministic report with `fallback`), `report/triage-report.ts` (`triageMarkdown`, `rerunCommand`, `appendTriageToReports`: JUnit `<system-out>`, HTML section, Markdown). Runner: `propose` may return `{ items, notes }`, `describe(value, items, input)` may return `findings`, a proposal is made when there are findings even without items; `prepare` gets the privacy level. Surfaces: RPC `ai.triageRun` (`backend/handlers/ai-triage.ts`, via the new shared `Backend.withAiDeps` that `assistant()` uses too — it now disposes its engine context); UI `components/ai/AiAnalysisDialog.tsx` (subject + estimate from a dry run, privacy, hint, What will be sent, Stop; the review with `Findings.tsx`; Apply → *Rerun the affected tests* (`runAgain(runId, resultIds)`) and Undo), `components/ai/ai-analysis.ts` (`triageRunItem` on the run header ⋯, the Runs list rows, Problems / Home attention run and monitor problems); CLI `testpion ai triage` (`commands/ai-triage.ts`), `--triage` on test / run / run-collection (`cli/src/run-triage.ts`; never changes the exit code; CLI collection runs now record their origin); MCP `ai_triage_run` (`mcp-server/ai-triage-tools.ts`, docs in `tool-docs.ts`). Tests: `tests/ai/triage.test.ts` (grouping, templating, evidence, 12 × 401 → one cause, verifier cases, stale value repaired after an accepts-anything fix, unfixable fix unticked, bug report for 200 → 500, variable fix + secret refused, test-file patch + changed-file refusal, privacy full/metadata, 500 failures / 60 endpoints within budget, no model + report sections), `tests/unit/ai-triage-surfaces.test.ts` (MCP + CLI `--no-ai`, `--apply`, `test --triage` with JUnit section and unchanged exit code), e2e `apps/desktop/e2e/plans/ai-triage.cjs` (a failing collection run on 127.0.0.1:4010 → right-click in Runs → dialog → review → Apply → Rerun passes; Home attention offers it). After the first live run (gpt-4o-mini: right diagnosis, but its fix was an `edit` whose text was not in the request → 0 items): `triage-run` v2 — the evidence numbers the failing checks (`failingChecksAsWritten: [{ checkIndex, check }]`) and a check fix names one (`{ type: check, result, checkIndex, replacement }`; the quoted `check` / `newCheck` still read); `edit` only with text copied from `definition`; `fix-items.ts` `staleCheckUpdate` — TestPion's own update of a stale expected value (equals / json-path / status → the value the failing response has, `stableForm` (safer check) for a generated value; none for 5xx / 401 / 403 or when the check failed on the last pass too), used by `proposeTriage` when the model's fix cannot be made (or a stale-test has none) and offered as `alternatives` beside a different model check; a task's `propose` may return `problems` (the runner feeds them to the repair loop like failing verifiers: *the text to change is not in "Health" … result "health@1" checkIndex 1 (…)*); `verifyCheckChange` explains an unknown check type with `explainCheckProblem`. Tests: the live finding reproduced (edit → repair naming the check → 1 repair), never-usable fix → TestPion's update stands in, stale-test without a change, alternative offered, `staleCheckUpdate` cases. Left: the GitHub Action's job summary (`action.yml`) does not read `triage.md` yet; "API bug — copy a bug report" has no issue-tracker export; traces of passing runs are not kept, so the last passing body is the result's 4 KB summary.

### AI-3 · Verified assertions and tp tests (P0, H, S)
* **Problem.** Generated tests are appended unrun (`RestView.tsx:467`); suggested checks are added without evaluation; users find out on the next send.
* **UI.** Suggest assertions / Generate tests open the proposal review: each check/test with ✓/✗ against the current response; failing ones unticked by default with the reason; "Prefer stable checks" toggle (types/shape over literal ids and timestamps).
* **Engine.** Structured output (checks as JSON objects, not YAML text); `verifyChecks` and `verifyScript` (AIB-5); a stability lint flags literal timestamps, UUIDs, tokens.
* **CLI/MCP.** `testpion ai assertions --request <ref> [--from-history <id>] [--json]`; MCP `suggest_assertions` (deterministic shape-based suggestions without a key, AI-ranked with one).
* **Tests.** Mock outputs with one wrong check → shown unticked; script with a syntax error → repair attempt.

* *Built (2026-10-16):* `generate-assertions` v2 (alias `suggest-assertions`) answers JSON `{ checks: [...] }` and `generate-pm-tests` v2 (alias `generate-tests`) `{ tests: [{ name, code }] }` — one item per check / per test (`tpTestScript` wraps a self-contained `tp.test`). `verify.ts`: `verifyCheck(check, response, previous)` fails a check that passes now but failed on the previous response (History's second-latest, via `item-context`), warns on pinned generated values (`GENERATED_FIELD`, `UNSTABLE`), and offers `saferChecks` (format `regex`, `type`, `exists`) as the item's `alternatives`; `verifyScript` fails `pm.*` / `postman.*` (repaired to `tp.*`) and a test that fails on the previous response. Script items apply with `mode: 'append'` (after the request's own script, once). Review (`ProposalReview.tsx`): **Safer:** buttons (re-verified via `ai.reverifyProposal`), **Run now** (the editor's own send, under the production guard; new response checked, the old one as previous), **Try on mock** for flow items; the assistant opens the review at once for generating tasks (`AssistantRequest.autoReview`) and records editor-applied acceptance (`recordOnly`). RestView's Suggest assertions / Generate tests / Generate request go through `lib/ai-request-actions.ts` (runner → proposal → review → the tab). `ai.generateTests` RPC kept for the web bridge (selected tests only). Tests: `tests/ai/verified-assertions.test.ts` (unstable flagged + safer form switched, pm.* repaired, failing test unticked, only accepted items applied, undo), updated `tests/ai/tasks.test.ts`; e2e `ai-assistant` steps `apply-checks` (unticked time check → Safer: exists → 3 added) and `generate-tests-verified` (failing test unticked, Run now, appended). After the first live run (gpt-4o-mini, 4/6): `ai/yaml-repair.ts` — `quoteTemplateValues` (a task's `normalize`, for design-flow / generate-test / suggest-coverage-tests: unquoted `{{` values quoted before verification, *Fixed N unquoted template values* in the proposal's notes) and `explainYamlError` (verifier details for repair turns: unquoted `{{`, tabs, indentation, duplicate keys); prompts design-flow / generate-test / suggest-coverage-tests v2 (quote values with `{{` or a leading special character, with an example), generate-assertions / generate-pm-tests v3 (what a script / check can read; the response time only when known); `verifyScript` refuses a responseTime test when the response has no time; golden cases are live-meaningful (`honest`: something passes and every failing item is unticked with its reason; `preview.local` follows the provider; shared `score`/`printScorecard` in `tests/ai/harness.ts`). Second live finding (design-flow always 2 repairs: response fields put into `assertions:`): `ai/flow-format.ts` — `flowFormatReference()` / `checksReference()` made from `testKeys` (test-schema.ts) and the check registry (`checkTypes`, new `checkDocs` / `documentCheck` / `registerCheck(type, fn, doc)` and `checkAliases` in eval/checks.ts: fields + one example per response check, other types by name, aliases left out), plus one linted example flow; added to the system prompt when the call is made (`AiTaskDef.format`: `flow` for design-flow / generate-test / suggest-coverage-tests v3, `checks` for flow-from-collection v2 and generate-assertions v4); budgets tested (≈ 886 / 469 tokens, ≤ 900 / 600). `explainCheckProblem` turns "A check needs a type" / "Unknown check type" into the right entry shape and the allowed types for repair turns. Tests `tests/ai/flow-format.test.ts` (derived from the registry, budget, example lints, one-turn repair of a wrong assertions shape, live case 'design-flow: assertions shape' ≤ 1 repair). Left: the Tests view has no generator of its own yet (a run result → checks for its test step needs the step's stored response); "Prefer stable checks" as a setting. Third live finding (generate-pm-tests needed ~2 repairs every time with gpt-4o-mini): `ai/script-reference.ts` — the `tp.*` API read from the sandbox itself (a probe script lists `tp`, `tp.response`, its headers, `tp.response.to` and a `tp.expect(…)` chain: methods, values with their type, and getters told apart by behaviour on three responses — chain words, modifiers, assertion flags), `scriptReference()` (≈ 411 tokens, budget ≤ 520, one example test that runs, Jest matchers left out) added to the system prompt (`AiTaskDef.format` may now be `'script'` or a list; `runAiTask` loads the API once per process), and `scriptApiProblems()` — the `script` verifier's static check whose problems name the right member: `tp.response.body.x` → `tp.response.json().x`, `pm.response.json()` → `tp.response.json()`, `toBeTruthy()` → `to.be.ok` (`JEST_TO_CHAI`, complete for every Jest alias the sandbox has — tested), a bare `expect(` → `tp.expect(value)`, invented members with the closest real one (`statusCode()` → `status()`), a method used as a flag and back. generate-pm-tests v4 (the instruction no longer lists the API by hand). Tests `tests/ai/script-reference.test.ts` (read from the sandbox, notes name real members, budget, example runs, each mistake → one repair whose message names the member).

### AI-4 · Tests from an OpenAPI spec, gap-driven (P0, H, M)
* **Problem.** `generate_tests` gives one happy path + one invalid request per operation; `suggest-coverage-tests` writes YAML but unverified. Users want meaningful scenarios: boundaries, enum misuse, pagination, auth, idempotency, error contracts — and to see coverage go up.
* **UI.** API preview / coverage dialog ▸ **Fill coverage gaps with AI**: lists uncovered operations/statuses, user picks; proposal shows new test files, each test tagged *happy / boundary / negative / auth*, coverage before → after (computed, not claimed).
* **Engine.** Start from `writeTestsFromSpec` output; categories as in Apidog (positive / negative / boundary / security), acceptance filter as in TestGen-LLM (a case is offered only if it parses, runs, gives a stable result twice, and adds a covered operation or status); LLM adds cases per operation using schema constraints (min/max, formats, enums, required) and the spec's documented errors; never invents paths — every generated request is validated against the spec operation (`findOperation`, `validateAgainstOpenApi`); hallucinated operations are dropped and reported. Optional live run against a mock (`packages/core/src/mock`) or the chosen environment.
* **CLI/MCP.** `testpion generate tests --spec specs/x.yaml --ai [--gaps-only] [--json] [--apply]`; MCP `generate_tests` gets `ai: true`.
* **Tests.** Fixture spec (`examples/` clinic); mock outputs including an invented endpoint → dropped.

### AI-5 · Flaky-test analysis (P1, H, S)
* **Problem.** `flaky_tests` lists flip counts; users need *why* and *what to change*.
* **UI.** Home/attention "Flaky tests" card ▸ **Analyse** → per test: pattern (fails on first run of the day, only in env X, only under concurrency, after test Y, latency near the threshold), evidence charts from history, proposal: retry policy, raise a latency limit with p95 evidence, isolate data (unique names via `{{$guid}}`), add a wait/poll (`wait` step), or quarantine (tag `quarantine`, excluded from CI gate but still reported).
* **Engine.** Deterministic features first (`test-history.ts`: flips, env, order, concurrency, duration vs threshold, time of day); LLM only names the pattern and drafts the change; quarantine is a deterministic tag + runner option. Follow Trunk/Datadog/CloudBees: *flaky* = passes and fails on the same inputs; **broken tests are never quarantined**, nothing is hidden automatically, quarantined failures still appear in every report; "Attempt to fix" re-runs the test N times (default 20) before calling it fixed.
* **CLI/MCP.** `testpion flaky [--analyse] [--json]`, `run --skip-quarantined`; MCP `flaky_tests` gains `analyse`.

* *Built (2026-10-16):* `ai/flaky.ts` (task `analyze-flaky` v1: `flakyTestId` resolves `test-case:<id>` or `test:<path>[:<step>]` (the file's flaky step, or its only one); `flakyEvidence` reads up to 30 runs with the test: history (status, latency, attempts, HTTP status, failures), signals (pass rate, flips, retried, failed/passed per environment, median pass/fail time, fail statuses, fail hours, common failures), the latest failing evidence and a passing response, and how to run it again (`rerun`: its file or collection request); `FLAKY_SCHEMA` pattern timing | ordering | shared-state | time-dependent | external-dependency | rate-limit | data-collision | unknown; `proposeFlaky` — step `set` (until, timeout …; `skip`, `tags`, `if`, `when`, `disabled`, `quarantine` dropped with a note), check, edit, `retry` (≤ 2, `caution` warn badge), none; quarantine / skip types never become items; `describeFlaky` → one finding with model + signal evidence; `deterministicFlakyFinding`), `ai/flaky-run.ts` (`analyzeFlaky`, `attemptFix`: apply the chosen items, run the whole test file (or the collection request) N times (default 5, ≤ 20) through `runTests` / `runCollection` with the host's services for the runs' environment (production guard as usual), verdict stable / flaky / failing kept as `Proposal.attempts`). Surfaces: RPC `ai.analyzeFlaky`, `ai.attemptFix` (cancellable); UI the same `AiAnalysisDialog` (*Why is this flaky?*: signals, estimate, review with **Attempt to fix** and the verdict banner) from Problems' flaky items and `TestHistory` (`AiAction` gained `open` for analyses with a dialog of their own); CLI `testpion ai run analyze-flaky --item …` (generic) and `testpion ai attempt-fix <id> [--times]`; MCP `ai_analyze_flaky`, `ai_attempt_fix` (confirmed, `CONFIRM_TOOLS`). Tests `tests/ai/flaky.test.ts` (signals, until fix verified, skip refused, Attempt to fix 5/5 against a local server, undo, retry caution, quarantine never offered, no model). After the first live run (pattern called shared-state for a timing case; a fix that broke the YAML): `analyze-flaky` v2 — a deterministic signature (`signatureOf`: status and the first changed body fields between a passing and a failing response, *$.status: "done" when it passes, "running" when it fails*) and `signals.likely` (intermediate state / 404·202 → timing, 429 → rate-limit, 409 → data-collision, dates → time-dependent, 5xx / timeouts / slow failures → external-dependency) in the evidence and the no-model finding (left out at metadata); the instruction has a pattern-by-signature guide ("a state field that differs → timing + until:"), format `['flow', 'script']` (the whole test-file reference), check fixes by `checkIndex`; a fix that cannot be made is a repair problem with the checks to name; lint failures already fed the repair loop through `verificationProblems` (with `explainYamlError` / `explainCheckProblem` in the detail) — reproduced with the mock (invalid YAML edit → repair with the lint explanation → recovered in 1 repair); the scorecard's call count was hard-coded to 1 (fixed). Live-mode hygiene: mock-only cases `it.skipIf(LIVE)`, the no-model cases pass `env: {}` (no TESTPION_AI_* from the environment), live criteria tolerant (triage: an item that verifies pass/warn; flaky: timing or ordering with a fix that does not fail). Left: a deterministic quarantine mode (`run --skip-quarantined`) is deliberately not built — nothing hides a failure; flaky features from concurrency and order (no data recorded yet).

### AI-6 · Script helper for tp.* (P1, H, M)
* **Problem.** Pre/post scripts are where Postman migrants struggle (pm → tp, async, chai syntax, sandbox limits).
* **UI.** In the script editor: **✦ Write** (describe: "save the first order id whose status is paid"), **Explain**, **Fix** (after a script error, with the error and logs), inline ghost suggestion optional later. Every result runs once in the sandbox against the last response before it is offered (logs, tp.test results shown).
* **Engine.** Task with the tp API reference (`docs/` script API page) as context; `verifyScript`; lint that rejects network, `require` of non-allowed modules (same rule as `generatedTestScript`).
* **CLI/MCP.** `testpion ai script --request <ref> --describe "…" [--json]`; MCP `write_script`.

### AI-7 · Ask the workspace (P1, H, L)
* **Problem.** "Which requests use the old auth header?", "Why did the payments suite slow down last week?", "How do I call refund?" — the free chat only sees the current view.
* **UI.** The assistant panel's free mode gets a scope switch (*This view* | *Workspace*). Answers cite items as clickable `ItemRef` chips (requests, runs, history entries, monitors); any proposed change goes through AIB-4.
* **Engine.** `runAgent` (`ai/agent.ts`) with read-only tools over the workspace — the same tools the MCP server exposes in `--profile minimal` (search, get_request, history_list, test_history, run results) — plus AIB-8 retrieval; answers must cite; unsupported claims are flagged by a citation check (the `citation` check already exists in `eval/checks.ts:915`).
* **CLI/MCP.** `testpion ask "…" [--json]` (returns answer + citations); MCP clients already have the tools — add an MCP prompt `ask_workspace` for them.
* **Privacy.** Tools return redacted, shape-summarised data; per-tool privacy level honoured.

### AI-8 · Security test generation (P1, H, M)
* **Problem.** OWASP API Top 10 (BOLA, broken auth, mass assignment, excessive data exposure) needs multi-user, stateful tests that schema fuzzing does not produce.
* **UI.** Security review dialog ▸ **Generate security tests**: user maps two identities (environment variables for user A / user B tokens — names only), AI proposes flows: A creates, B reads/updates/deletes A's object (expect 403/404); missing/expired token; role escalation via extra fields; responses leaking fields not in the spec. Proposal review; run only against environments the user marks as test.
* **Engine.** "AI to understand, deterministic to decide" (StackHawk; BOLABuster's two-user method): resource/ID discovery from spec or collection (deterministic, `flows-from-spec.ts` resource grouping); LLM maps ownership and dependencies and picks attack variants per resource from a fixed catalogue (OWASP API1 BOLA, API2 auth, API3 BOPLA/mass assignment, API5 BFLA — no free-form exploits); an optional plain-language "authorisation rules" note from the user cuts false positives; verdicts are deterministic checks (B gets 2xx with A's data = finding; partial data = property-level finding); verifier ensures every step targets a known operation; `excessive-data` check compares response fields to the spec schema.
* **CLI/MCP.** `testpion security generate --spec|--collection … --identities userA,userB [--json]`; MCP `generate_security_tests`.
* **Risk control.** Destructive methods off by default; environment allow-list; clear "authorised testing only" note.

### AI-9 · Contract drift explained (P1, M, M)
* **UI.** From the Debugger capture, history or a run: **Compare with the spec** → drift list (undocumented fields/statuses/endpoints, type changes), AI explains impact and proposes either a spec patch (OpenAPI YAML diff) or test/check updates; user chooses per item.
* **Engine.** Deterministic drift from `validateAgainstOpenApi` over N exchanges, grouped; LLM writes the explanation and the patch; patch is validated by re-linting (`openapi/lint.ts`) and re-validating the same traffic (drift must disappear).
* **CLI/MCP.** `testpion openapi drift --spec … --from-history|--har … [--ai] [--json]`; MCP `contract_drift`.

### AI-10 · Import cleanup (P1, M, M)
* **Problem.** Imported Postman/curl/HAR collections arrive with hard-coded hosts, tokens, duplicate requests and no chaining.
* **UI.** After import (and on any collection: right-click ▸ **Tidy with AI…**): proposal with renamed requests, folders by resource, hosts → `{{baseUrl}}`, tokens → secret variables, duplicate merges, extract/chain suggestions, pm → tp script conversion notes.
* **Engine.** Existing `collection-tidy.ts`, `variable-refactor.ts`, `suggestedExtracts`, scripts convert — deterministic changes first; LLM only for names, folder grouping and chaining choices; every change a `Change` in the proposal.
* **CLI/MCP.** `testpion tidy --ai [--json] [--apply]`; MCP `tidy_collection` with `ai: true`.

### AI-11 · Evaluation authoring and judge calibration (P1, M, M)
* **UI.** Evaluations: **Generate cases** (from a prompt and a few examples: typical, edge, adversarial/jailbreak, multilingual), **Draft a rubric** for `llm-judge` (binary criteria, not 1–10), **Calibrate judge**: compares judge verdicts with the human reviews already stored (`review_result`) and shows agreement (Cohen's κ / % agree) and disagreements to fix the rubric.
* **Engine.** Case generation into datasets (dedup, diversity check); calibration is deterministic statistics over existing reviews (report Cohen's κ, not raw agreement); rubrics are binary pass/fail with a critique; judge reasons before the verdict; pairwise judging runs both orders and counts a win only when both agree (position bias); a "length-controlled" flag warns when the judge prefers the longer answer. Disagreements with the human reviewer become few-shot examples in the rubric ("critique shadowing").
* **CLI/MCP.** `testpion eval cases --generate`, `testpion eval calibrate <evaluation> [--json]`; MCP `generate_eval_cases`, `calibrate_judge`.

### AI-12 · Natural-language search over history/runs/traces (P2, M, M)
* **UI.** History/Runs/Traces search box accepts "failed payment calls last week over 2 s"; the parsed filter is shown as editable chips (method, host, status, path, time, duration, env) — the model only translates to a filter, the engine searches.
* **Engine.** Structured output = the existing filter object; deterministic search; no data sent except the query text and field names.
* **CLI/MCP.** `testpion history --ask "…" [--json]` prints the filter and results; MCP `history_list` gains `query_text`.

### AI-13 · Monitor and load insights (P2, M, S)
* Alert summaries (what broke, since when, likely cause, which request), regression vs baseline for load results (p95/p99/error-rate deltas with significance), weekly API health digest (Markdown, for Slack/email via existing webhooks — user configures). Builds on `explain-monitor`, `analyze-load`, `api_health_report` prompt. CLI `testpion monitor summary --ai`, `load-history --compare --ai`; MCP `monitor_summary`.

### AI-14 · Docs and changelog (P2, M, S)
* Collection docs (`collection_docs`) enriched with AI descriptions per request/field (from examples), and a changelog between two commits/tags from the semantic diff (`git changes`), with breaking changes first (reuse `explain-api-changes`). Proposal review before writing descriptions. CLI `testpion docs --ai`, `testpion git changelog --from v1 --to v2 --ai`; MCP `write_changelog`.

### AI-15 · Realistic, PII-free data and mock responses (P2, M, S)
* Datasets: the deterministic generator keeps doing the work; AI adds domain realism for free-text fields and coherent rows (city matches postcode), with a PII guard (no real-looking SSNs/cards; synthetic emails `@example.test`). Mock server: generate varied responses (pagination, errors, edge values) from saved examples/spec, validated against the spec schema. CLI `generate-data --ai`, `mock generate --ai`; MCP `generate_dataset` `ai: true`.

### Also considered (later)
* PR review of collection changes in CI: semantic diff + risk notes as a PR comment (GitHub Action). Becomes cheap after AI-14.
* Auto-healing of request chains when an API renames a field (suggested extract path updates) — after AI-2/AI-9.
* Debugger: "turn this session into a test with assertions" (flow-from-exchanges + AI-3 verification).
* gRPC/GraphQL: query/args generation already exists; add verification against the schema.
* Inline ghost-text completion in editors — low value per cost; skip until asked.

---

## 6. Build order

**Release 1 (v0.47.x → next): foundations + owner request**
1. AIB-1 core task runner (port the 22 tasks unchanged), AIB-6 usage ledger, AIB-7 routing.
2. AIB-2 context builder + redaction detectors + "What will be sent".
3. AIB-3 structured output + repair; AIB-5 verifiers (checks, script, test file, flow lint).
4. AIB-4 proposal model + review component (start with flow + checks change kinds).
5. **AI-1** flow from a collection/folder; **AI-3** verified assertions/tests.
6. AIB-9 eval harness with the mock provider for AI-1/AI-3 and the existing tasks.
7. CLI `testpion ai usage|apply`, `flow generate`; MCP `generate_flow_ai`, `apply_ai_proposal`, `ai_usage`; docs.

**Release 2: debugging and coverage**
* **AI-2** triage (+ CI report section), **AI-4** spec tests with gaps, **AI-5** flaky analysis, **AI-6** script helper, AIB-10 uniform AI action.

**Release 3: grounding, security, migration**
* AIB-8 retrieval, **AI-7** Ask the workspace, **AI-8** security tests, **AI-9** drift, **AI-10** import cleanup, **AI-11** eval authoring. Then P2 items (AI-12..15) as small slices.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Hallucinated endpoints, fields, check paths | Every generated request validated against the spec/collection; unknown refs dropped and reported; checks verified against a real response; deterministic draft as the base. |
| Tests that pass by being weak (always-true checks) | Verifier also runs the change against a counter-example (last passing / failing response); stability lint; review UI shows what a check asserts in words. |
| Secrets or PII leaving the machine | One context builder; detectors; metadata-only level; local-model-only setting; "What will be sent"; unit tests asserting no secret value appears in any provider request (mock provider records payloads). |
| Cost surprises (large collections, agent loops) | Token estimate before sending, sampling, per-call/per-day caps, `maxSteps` for agents, usage ledger. |
| Non-determinism (same input, different flow) | Temperature 0–0.2, `seed` where supported, the artefact is saved text reviewed once — runs are deterministic after Accept; prompt version recorded. |
| Weak local models break structured output | Schema-constrained decoding where available (Ollama `format`), repair loop, smaller schemas, tier routing; eval harness reports per-model pass rates so docs can name models that work. |
| Prompt regressions | Prompts versioned; AIB-9 evals in CI (mock) and before release (real model). |
| User distrust / "AI everywhere" fatigue | AI is an explicit action, never automatic; deterministic results without a key; Settings toggle to hide AI actions entirely. |
| Cloud version: multi-tenant prompts and keys | Engine-only implementation (no Electron); keys via SecretStore per user; usage ledger per user/org (fits `subscriptions.md` metering later). |
| Security test generation misused | Catalogue of known checks only, destructive methods off, environment allow-list, authorised-testing notice. |
