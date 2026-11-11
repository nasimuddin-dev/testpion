---
title: "Testing MCP tools"
description: "Execute MCP tools with schema-generated forms, assert on results and save tool calls as tests."
---

::: v-pre

# Tools

Select a tool to see its description, input and output schemas and annotations. Tools marked `destructiveHint` are flagged and ask for confirmation before running. With an environment marked as [production](/api-testing/environments#production) active, a tool call asks first, since a tool may change data; tools the server marks `readOnlyHint` run without asking.

- **Arguments:** use the form generated from the input schema, or switch to raw JSON. **Generate args** asks the assistant for example arguments.
- **Execute:** shows the content blocks (text, JSON, images), `structuredContent`, `isError` and latency.
- **Display:** show the output **Pretty** (JSON as a tree, images inline), **Raw** (searchable text) or as rendered **Markdown**.
- **Save the result:** the down arrow at the right end of the result's bar saves it as JSON, Markdown (when the result is text) or text, and **Copy** sits before it ([Save and export results](/getting-started/save-and-export-results)).
- Results stay while the app runs: each tool keeps its last result, arguments and assertions, also when you switch tabs, servers or views.
- **Assertions:** `status: success|error`, JSONPath checks against `structuredContent`, or the parsed text content.
- **Save as test…:** writes the call with its assertions as a YAML test to `tests/mcp/` (the toast has **Run now** and **Open test file**; History's right-click menu has the same for an earlier call):

```yaml
name: Search Customer MCP Tool
type: mcp
server: customer-mcp
tool: search_customer
arguments: { customer_id: "123" }
assertions:
  - { type: status, expected: success }
  - { type: equals, path: $.customer.id, expected: "123" }
```

`status: error` matches only a tool-level error (`isError: true`). A connection or protocol failure counts as a test **error**, never as the expected error.

## Are the tools easy for an agent to use? {#lint}

An AI agent picks a tool by its description and fills its arguments from the schema. On a connected server, **Server info** has a **For AI agents** section that checks the tool list in words. From a terminal, `testpion mcp --lint -- node server.js` (or `--url`, or `--server <name>`) connects and checks the tool list in words:

- a tool with **no description**, a very short one, or one that only repeats its name;
- two tools with **the same description**, which an agent cannot tell apart;
- **parameters without descriptions**, and no list of which are required;
- a tool that **sounds destructive** (*delete*, *reset* …) but has no `destructiveHint`, so a client cannot ask first;
- **names** a client rejects, a schema that is not an object, a `required` that names nothing;
- **too many tools**, or a list so big that it fills the agent's context (about 4 characters a token);
- **prompts and resources** without a description;
- a description that **talks to the model** instead of describing the tool (*ignore previous instructions*, *do not tell the user*, *before using any other tool* …), in a tool or in a parameter: an agent may obey it;
- **characters a person cannot see** (zero-width and direction marks) in a description: a model reads them, and this is how instructions are hidden in a tool. This one is an error.

Errors make the command exit with 1; warnings and tips are advice. `--json` prints the findings. The MCP tool `mcp_server_tools` returns the same as `lint`.

## Check the whole server, and what changed since you approved it {#check}

`testpion mcp --server <name> --check` (or `--url`, or `-- node server.js`) runs three checks in one go and exits with 1 when one of them fails:

| Check | What it looks at |
|---|---|
| **Protocol** | What a client can see without side effects: the server gives its name and version, declares the capabilities it uses, lists every tool once with well-formed schemas, answers a ping, and answers a call of a tool that does not exist with an error (not a success). |
| **For agents** | The lint above. |
| **Changes** | What the server offers now against what you approved. |

An agent reads a tool's description as instructions, so a description that changes after you reviewed it matters as much as a code change. Approve a server once you have read its tools:

```bash
testpion mcp --server "Orders" --approve     # keeps mcp-snapshots/orders.json in the workspace
testpion mcp --server "Orders" --check       # from now on: every change, with the old and the new words
```

The snapshot is a small file of the workspace, so the approval travels with git and a change is also a diff in a pull request. Changes come in three kinds:

- **Breaks callers:** a tool is gone, a parameter became required, was removed, changed its type or accepts fewer values.
- **Review:** a description changed (the approved and the new text are shown), a new tool, a parameter was added, the server instructions changed, a tool no longer says it only reads.
- **Changed** (for information): prompts, resources, the server's version, the protocol revision.

Breaking changes and changes to review fail the check until you approve them again. In CI, run `--check` on every build of your server, or on a schedule against a server someone else runs. In the app, **Server info** shows the same under **Changes since you approved it** (with **Approve**) and **Protocol**. For an agent: the MCP tool `mcp_server_tools` with `check: true` (and `approve: true`).

`--probe-arguments` also calls the tools that say they only read (`readOnlyHint`) without their required arguments, to see that the server refuses. It is off by default because it calls real tools.

## Does each model pick the right tool? {#selection}

A server can pass every test above and still fail with a real model, because the model chooses by names and descriptions, and what one model understands another does not. Tool selection asks each model which tool it would call, **without calling any tool**:

```bash
testpion mcp --server "Orders" --selection-cases                      # the AI assistant writes requests a user would type
testpion mcp --server "Orders" --select --models openai/gpt-4o-mini,ollama/llama3.2 --min 0.9
```

In the app the same is under **Server info ▸ Which tool does each model pick?**: **Write cases with AI**, then name the models (`provider/model`, comma separated) and **Ask the models**; each model gets a line with its share, the requests it missed and the tools it confuses. An agent runs it with the MCP tool `mcp_server_tools` and `select: ["provider/model"]`. Every run is a line per model in the AI usage of the workspace (task `mcp-selection`).

The cases are a file you own, `datasets/mcp-selection-<server>.jsonl`: one `{"ask": "What the user types", "tool": "the_tool_it_needs"}` a line, with `"tool": "none"` for a request no tool fits. `--selection-cases` writes a first version (AI-generated: read and correct it; a case that names its tool or expects a tool the server does not have is dropped, and tools without a case are named). `--select` offers the tool list and the server instructions to each model, asks every case once, and reports per model how often it chose right, each miss (what it needed, what it chose), the pairs of tools it confuses more than once, and the requests **every** model missed: those point at a description, not at a model. `--min` makes the command exit with 1 below that share. `--json` prints it all, with tokens and cost per model.

:::
