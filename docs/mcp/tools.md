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
- **too many tools**, or a list so big that it fills the agent's context (about 4 characters a token).

Errors make the command exit with 1; warnings and tips are advice. `--json` prints the findings. The MCP tool `mcp_server_tools` returns the same as `lint`.

:::
