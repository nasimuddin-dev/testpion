---
title: "Agent testing"
description: "Test agentic tool-calling workflows with mock tools and MCP tools, with full step-by-step traces."
---

::: v-pre

# Agent testing

`type: agent` runs a provider-agnostic tool-calling loop. The tools can be mocks, MCP server tools, or both:

```yaml
name: Booking agent uses the right tools
type: agent
model: { provider: openai, name: my-model }
input: Please book an appointment for customer 123.
mcpServers: [customer-mcp]
tools:
  - name: get_weather
    inputSchema: { type: object, properties: { city: { type: string } } }
    result: { forecast: sunny, city: "{{args.city}}" }
maxSteps: 4
evaluators:
  - { type: tool-called, tool: create_appointment, arguments: { customer_id: "123" } }
  - { type: tool-not-called, tool: delete_customer }
  - { type: max-tool-calls, max: 3 }
  - { type: tool-args-valid }
  - { type: tool-sequence, expected: [search_customer, create_appointment] }
```

The trace records every model call (prompt, tokens, finish reason), every tool call (arguments, result, latency, source) and the final answer.

## Agent evaluations in the app

AI quality > Start > **An agent uses tools** opens a three-step wizard that saves an evaluation with `type: agent` (the same saved-evaluation file as the other evaluations, so `testpion eval run`, the MCP `run_evaluation` tool and a CI pipeline run it unchanged).

1. **What are you testing?** Name, instructions for the agent, and the tools it can use: mock tools that answer every call with a fixed result (`{{args.name}}` is filled from the call), and the tools of MCP servers set up in the MCP view (a mock server designed there works too).
2. **Your cases.** Each row is a task for the agent (the `input` column). Under **Should call** write the tools it must call, as a name or `name(argument=value)` when the arguments matter, separated by commas. Under **Should not call** write the tools it must never call. An empty cell asks nothing.
3. **What does a good run look like?** The tools each case lists are always checked. Tick more: never calls a tool, makes few tool calls, gives each tool the arguments it asks for, the final reply contains a phrase. **Try on case** runs the agent on one case and shows how each tool check did.

In the file the two columns are `should_call` and `should_not_call`: each `should_call` tool becomes a `tool-called` check and the `should_not_call` tools one `tool-not-called` check for that case. Compare mode (variants) is for prompt evaluations only.

:::
