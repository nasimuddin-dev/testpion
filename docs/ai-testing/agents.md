---
title: "Agent testing"
description: "Test agentic tool-calling workflows with mock tools and MCP tools, with full step-by-step traces."
---

# Agent testing

::: tip In short
An agent is an AI that uses tools. These tests check that it calls the right tools with the right arguments, and nothing it should not.
:::

::: v-pre

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


### See what the agent did: the trajectory {#trajectory}

A failed agent case in the report card has **Show the steps**. It lays the case out down one line: the question, each model
call (what the model said and which tools it asked for), each tool call with its arguments and result (an error in red), and
the final answer. The checks about tools are pinned to the step that decided them: a **should call** is green at the call that
met it (or red on the calls whose arguments differ, or at the end as *never called*), a **should not call** is red on the call
that happened and grey at the end when it never did, an allow-list and a call limit are red on the call that broke them, and
valid arguments on the call whose arguments did not match the tool's schema. Nothing is sent to a model.

### Compare two models or two instructions on the same tasks {#compare}

Open **Compare** on an agent evaluation and add a variant: another model, or other instructions. Run them all, and the table shows each variant's passed cases, cost and time, and for an agent also **Tool calls per case** and **Same tools as A** (in how many cases the variant used the same tools as the first one). The sentence under it says it plainly: *B used other tools in 1 of 2 cases.* A cheaper model that passes the same cases but calls other tools is a change you want to know about. `testpion eval run <name> --variants` and `testpion eval variants <name>` do the same from a terminal.

### A golden run: has the agent started using other tools? {#baseline}

Mark a run you trust with **Mark this run as the baseline** (on the report card of an agent evaluation) or `testpion eval baseline <run>`. Later runs then say, case by case, how their tools differ from it: *same tools in the same order*, *dropped search_docs; added delete_record*, *same tools in another order*, or *same tools, but search_docs was called with other arguments*. The report card shows *Tools against the baseline: 4 of 5 cases the same, 1 changed*, and **Show the steps** of a case adds the comparison. The baseline is one field of the saved evaluation (`baselineRun`); **Clear the baseline** or `testpion eval baseline --clear --evaluation <name>` removes it. `testpion eval trajectory <run> <case> --against <run>` compares with any other run. From a terminal:
`testpion eval trajectory <run> <case>` (`--json` for scripts); for an agent, the MCP tool `eval_case_diff` with `steps: true`.

:::
