---
title: "MCP mock server"
description: "A fake MCP server from a YAML file, or recorded from a real one, to test AI agents and MCP clients without the real server or its side effects."
---

::: v-pre

# MCP mock server

An MCP mock is a fake MCP server: tools with canned responses, resources and prompts, defined in a `*.mcp-mock.yaml` file. Use it to:

- test an AI agent or MCP client against predictable answers, with no side effects (a mocked `delete_customer` deletes nothing);
- keep testing when the real server is slow, down, rate-limited or needs credentials;
- share a server's behaviour with people who can't run it.

## Record a mock from a real server

1. In **MCP**, connect to the server and call the tools you want to capture.
2. Click **Save as mock**.

TestPion writes `mocks/<server>.mcp-mock.yaml` in the workspace, with the server's tools (names, descriptions, input schemas, annotations), resources (and their text), prompts, and each tool call you made as a response matched on its arguments. Secrets in recorded content are redacted. A server entry `<server> (mock)` is added, so you can connect to the mock right away.

## Write one by hand

```yaml
name: customer-mock
instructions: A fake customer service
tools:
  - name: search_customer
    description: Look up a customer by id.
    inputSchema:
      type: object
      properties: { customer_id: { type: string } }
      required: [customer_id]
    responses:
      - when: { customer_id: "999" }      # used when the arguments contain these values
        text: "No customer {{args.customer_id}}"
        isError: true
      - json: { id: "123", name: "Ada Lovelace", tier: gold }   # the default
resources:
  - uri: clinic://hours
    name: Opening hours
    mimeType: text/plain
    text: Mon-Fri 8-18
prompts:
  - name: summarize
    arguments: [{ name: topic, required: true }]
    messages:
      - role: user
        text: "Summarize {{topic}} in one line."
```

A tool's first response whose `when` matches the arguments is used, otherwise the one without `when`. A response is `text` (with `{{args.name}}` placeholders), `json` (also sent as structured content), raw MCP `content` items, or a `script` (below), and `isError: true` makes it a tool error. [Dynamic variables](/api-testing/environments#built-in-variables) such as `{{$guid}}`, `{{$randomFullName}}` or `{{$randomInt(1,100)}}` give a fresh value on every call; a string that is only a placeholder keeps the value's type (`qty: "{{$randomInt(1,5)}}"` is a number).

### Script answers

When the answer depends on the arguments in a way placeholders can't express, a response can be a `script`: JavaScript run in the same sandbox as test scripts (no network, no files, bounded time), with `args` in scope. Write it as `(args) => result` or as a body with `return`. A string result is sent as text; anything else as JSON (and as structured content); an object `{ content: [...] }` is sent as it is. An exception makes a tool error with its message.

```yaml
tools:
  - name: refund
    inputSchema: { type: object, properties: { id: { type: string }, amount: { type: number } }, required: [id, amount] }
    responses:
      - when: { id: "missing" }
        text: "No order {{args.id}}"
        isError: true
      - script: |
          if (args.amount > 50) throw new Error('needs approval');
          return { id: args.id, refunded: args.amount, at: new Date().toISOString() };
```

## Design a toolset

A toolset is the set of tools an AI agent will see: for each, a name, a description that says when to call it, an input schema, and how it answers. An MCP mock is exactly that, and it is served as a real MCP server, so you can design and try an agent's tools before the backend that implements them exists.

In **MCP**, select a server whose transport is **Mock** (or add one and give it a file path such as `mocks/orders.mcp-mock.yaml`; the file is created on Save). Its **Tools** tab is the design surface:

- **The list** of tools on the left: add, duplicate, reorder and delete from each tool's menu.
- **The form** of a tool: name, title, description, the read-only and destructive hints, the input schema as JSON (with completion), and the responses: each one is text, JSON, a script or raw content, optionally only when the arguments match a `when` object, and optionally a tool error.
- **Try** calls the tool as edited (nothing saved yet) with a form generated from its schema and shows the mock's answer like any tool result, including what a script computes.
- **Form / YAML** switches to the raw file: the YAML is the source of truth and stays editable; **Save** (or Ctrl+S) writes it. Reconnect the server after saving to serve the new tools in the inspector.
- **Serve** shows the command lines that serve the toolset to an agent (stdio, and Streamable HTTP with its URL) and the `mcpServers` configuration to paste, each with a copy button.
- **Generate with AI** asks the assistant for the tools of an agent from one or two sentences about its job. The answer is AI-generated: it is loaded into the form for review (and marked as such), not saved, until you press Save.

From the command line and for agents:

```bash
testpion mock-mcp mocks/orders.mcp-mock.yaml --list          # the toolset: each tool, its arguments and how it answers
testpion mock-mcp mocks/orders.mcp-mock.yaml --list --json   # the same as JSON (input schemas included)
```

The [MCP server](/ai-testing/mcp-server) has the same as `mock_tools` (it takes the file's path in the workspace), so an agent can read a toolset you designed, and design one by writing the YAML file.

## Use it

**In the app:** add an MCP server with the transport **Mock (definition file)** and the file's path in the workspace. The mock runs inside TestPion; saved MCP tests can use it like any other server.

**For AI agents and other clients:** serve it with the CLI.

```bash
testpion mock-mcp mocks/customer.mcp-mock.yaml              # stdio: the command an agent starts
testpion mock-mcp mocks/customer.mcp-mock.yaml --http -p 3333   # Streamable HTTP on 127.0.0.1
```

For example, in an agent's MCP configuration:

```json
{ "mcpServers": { "customer": { "command": "testpion", "args": ["mock-mcp", "mocks/customer.mcp-mock.yaml"] } } }
```

:::
