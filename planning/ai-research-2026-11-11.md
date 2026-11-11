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
