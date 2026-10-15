---
title: "Testing MCP tools"
description: "Execute MCP tools with schema-generated forms, assert on results and save tool calls as tests."
---

::: v-pre

# Tools

Select a tool to see its description, input and output schemas and annotations. Tools marked `destructiveHint` are flagged and ask for confirmation before running. With an environment marked as [production](/api-testing/environments#production) active, a tool call asks first, since a tool may change data; tools the server marks `readOnlyHint` run without asking.

- **Arguments:** use the form generated from the input schema, or switch to raw JSON. **Generate args** asks the assistant for example arguments.
- **Execute:** shows the content blocks (text, JSON, images), `structuredContent`, `isError` and latency.
- **Display:** show the output **Pretty** (JSON as a tree, images inline), **Raw** (searchable text) or as rendered **Markdown**; **Copy** and **Save** the result.
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

:::
