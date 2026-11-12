# AI testing and agent-friendliness: research of 2026-11-11

Asked by the owner: research how TestPion can be more AI-friendly and more useful for AI testing and automation.
Method: web survey (evaluation platforms, MCP testing, agent-facing CLI/MCP design, red teaming, MCP spec, OpenTelemetry
GenAI, simulated users) compared with what the code has today (grep of packages/*/src, not a full read).
Most web sources are vendor blogs; claims marked (unverified) were not checked against primary documents.

## What TestPion already covers (so it is not proposed again)

Checks and metrics for LLM, RAG, agents and conversations (trajectory-match, tool-selection, mcp-use, knowledge-retention …),
safety metrics and static probe sets (jailbreak, injection, pii, toxicity, bias, off-topic, benign), judge panel and
calibration, evaluation matrix, golden run, prompt versions with a gate, review queue, MCP client view with tool lint and
an MCP mock, OTLP export of run traces, junit/json/html/markdown reporters, CLI --json envelope, MCP profiles and search_tools.

## Gaps found, in the order I would build them

| Id | Gap | Why it matters | Size |
|---|---|---|---|
| N-1 | **Simulated users for conversations.** Conversations are replayed from scripted turns only (`eval/rag/conversation.ts`). No simulated user with a persona and a hidden goal that talks until the goal is met, given up or a turn cap is hit. | Scripted turns cannot follow an agent that answers differently. Simulation is what current agent-evaluation tools treat as the standard for multi-turn testing; a population of personas with one goal shows how robust the agent is. | M |
| N-2 | **MCP server check as one job.** The pieces exist (tool lint, call a tool, `tool-selection` and `mcp-use` metrics, mock), but there is no single check of a server under test: (a) protocol conformance, (b) a saved snapshot of tools/list with drift detection (a tool whose description or schema changed since it was approved), (c) "does each model pick the right tool" from generated prompts, across models. | Guides agree a server can pass API tests and still fail with real model clients, and that one model does not generalise. Drift detection also covers the "changed tool description" attack. | M–L |
| N-3 | **Red teaming beyond fixed prompts.** Probe sets are static seeds. Missing: attacks that adapt over several turns, indirect injection (the attack sits in a retrieved document or a tool result, not in the user message), a report mapped to OWASP LLM Top 10 2025, and SARIF output for code-scanning tabs. | Indirect injection is the main agent risk and the MCP mock can already serve poisoned tool results, so most of the machinery exists. | M |
| N-4 | **Traces in, not only out.** OTLP export exists; nothing reads `gen_ai.*` traces. Import a trace file (or receive OTLP on a local port) and turn real conversations into dataset rows and trajectory baselines. | "Production failure → dataset → experiment" is the loop the hosted platforms sell. Caveat: the GenAI conventions are still marked Development and moved to their own repository in June 2026, so the reader must tolerate renamed attributes. | M |
| N-5 | **A smaller agent surface.** The verbose MCP list sits at 329 of 330 KiB with ~170 tools; every new feature fights the cap. Research favours few tools, CLI for local work, and packaged skills. Proposed: make `minimal` the default profile, generate an Agent Skill (SKILL.md + references) from `agent-info`, add `llms-full.txt`, and long runs as MCP tasks instead of blocking calls. | Removes the cap as a recurring trap and cuts the context an agent spends before doing anything. Changing the default profile is a behaviour change for existing users: owner decision. | M |
| N-6 | **MCP spec 2026-07-28.** The revision removes the initialize handshake and protocol sessions (stateless), tightens OAuth, and adds Tasks (unverified: read from secondary sources). Not checked: which revision TestPion's client and server speak. | A testing tool has to talk to servers on the new revision, and ideally test a server on both. | S to check, M to build |

Not proposed: guardrail false-positive testing (the benign probe set already serves it), A2A protocol testing (no clear
demand found in this pass), pairwise/Elo ranking (matrix + baseline covers the need).

## Status (2026-11-11, same day)

| Id | State | What was built | Left out |
|---|---|---|---|
| N-1 | Built (51db89ba) | `eval/rag/simulate.ts`: a record with `persona` + `goal` is played by the AI task `simulate-user` on the evaluation's judge; six personas; `metadata.rag.record.simulated`; `testpion rag personas`; the drill-down says how it ended. | No UI to author personas (they are dataset columns). The ending is the simulated user's own opinion. |
| N-2 | Built (4d97e4c5) | `protocols/mcp/check.ts` (conformance), `shared/mcp-snapshot.ts` (approved snapshot in `mcp-snapshots/`, drift), lint codes `instruction-like` and `invisible-text`, `eval/mcp-selection.ts` (which tool each model picks; AI task `mcp-selection-cases`); CLI `mcp --check / --approve / --selection-cases / --select`; MCP `mcp_server_tools { check, approve }`; Server info panel `ServerCheck.tsx`; e2e plan `mcp-server-check`. | Tool selection has no UI and no MCP tool (CLI only). Conformance covers what a client can see without side effects, not the official conformance suite. Selection calls go to the provider directly: tokens and cost are reported, not written to the usage ledger. |
| N-3 | Built (b7aea4bd) | Attacker personas + metric `attack-resisted` (139 metrics) + probe set `attackers`; `mock mcp --inject` and `inject:` in a mock file; `report/sarif.ts` (`-r sarif`, `rag run --sarif`) with the OWASP LLM Top 10 (2025) mapping and coverage. | The OWASP mapping is small on purpose; LLM03, LLM04, LLM07, LLM08 have no checks of their own. No OWASP view in the app. |
| N-4 | Built (2a094f4c) | `eval/rag/otel-traces.ts`: OTLP/JSON traces to dataset records (`rag import --from otel`, `--only-errors`, the app's Import dialog). | File import only: no OTLP receiver on a port. One record a trace (conversations across traces are not joined). |
| N-5 | Partly (c5cb76a1) | `agents init --targets skill` (an Agent Skill); the docs build writes `<page>.md` and `llms-full.txt`. | **Not done, owner decision:** making `minimal` the default MCP profile (it changes what existing agent setups list). **Not built:** long runs as MCP tasks. The verbose tool list still sits near its 330 KiB cap (221 tools, not about 170 as written above). |
| N-6 | Checked, not built | TestPion uses `@modelcontextprotocol/sdk` 1.32.1; its newest revision is **2025-11-25** (also 2025-06-18, 2025-03-26, 2024-11-05). The 1.x line ends at 1.32.2 with the same list. The 2026-07-28 revision is in the v2 SDK, which is split into `@modelcontextprotocol/client`, `/server` and `/core` (2.4.0, needs zod 4). `mcp --check` now reports the revision a server speaks. | Speaking 2026-07-28 means moving client, server and mock to the v2 packages: a major dependency change across `protocols/mcp/client.ts`, `mcp-server/` and the mock. **Owner decision** before starting; a server that only speaks the stateless revision cannot be connected until then. |

## Sources

- https://arize.com/resources/llm-and-agent-evaluation-platforms/
- https://atlan.com/know/ai-agent/ai-agent-evals/best-ai-agent-evaluation-platforms/
- https://www.braintrust.dev/articles/best-mcp-testing-tools-agent-evals-2026
- https://testomat.io/blog/mcp-server-testing-tools/
- https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector.md
- https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/
- https://dev.to/uenyioha/writing-cli-tools-that-ai-agents-actually-want-to-use-39no
- https://manveerc.substack.com/p/mcp-vs-cli-ai-agents
- https://promptfoo.dev/docs/red-team/owasp-llm-top-10/
- https://appsecsanta.com/ai-security-tools/garak-vs-promptfoo
- https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke
- https://arxiv.org/html/2605.12894v1
- https://futureagi.com/blog/simulated-multi-turn-conversation-eval-2026/

## Status after the 2026-11-11 follow-up (owner: "complete all before the cloud integration")

| Id | What was added | Still open |
|---|---|---|
| N-1 | The workspace's own personas: `personas.yaml`, a list and dialog in RAG Bots, `rag personas -w`. | — |
| N-2 | Tool selection in the app (Server info), as `select` of `mcp_server_tools`, and in the AI usage ledger (`eval/mcp-selection-server.ts`). | — |
| N-3 | OWASP Top 10 coverage on a run's Charts tab and as `owasp` of the run breakdown. | Probe sets `system-prompt`, `poisoning`, `cross-context` reach LLM07, LLM04, LLM08 from outside; LLM03 says a run cannot test it. |
| N-4 | `rag import --listen`: an OTLP/HTTP receiver (JSON, 127.0.0.1). | Protobuf is read too (`eval/rag/otlp-proto.ts`, receiver and file). gRPC is not received; traces of one conversation are still one record a trace. |
| N-5 | `minimal` is the default profile of the served MCP server (found tools join the list, `search_tools { name, arguments }` calls any tool); long runs as MCP tasks (`mcp-tasks.ts`). | — |
| N-6 | The inspector client is the v2 SDK (`@modelcontextprotocol/client` 2.4.0): it speaks 2026-07-28 (asked first over Streamable HTTP; `protocol: auto` for stdio and SSE) and falls back to the 2025 handshake. | TestPion's own server and the mocks are on the v2 server SDK too (`mcp-server/serve.ts`, `confirm-input.ts`): they answer 2026-07-28 and the 2025 revisions. Tasks are served by TestPion itself for 2025-11-25 clients (`serveTasks`); 2026-07-28 has none. A change of the tool list reaches a 2026 client only when it listens (`subscriptions/listen`); the 1.x SDK is a development dependency for the tests. |
