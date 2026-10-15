---
title: "MCP (Model Context Protocol) testing"
description: "Inspect, debug and test MCP servers: tools, resources, prompts and protocol traces."
---

::: v-pre

# MCP

TestPion is a full MCP client built on the official TypeScript SDK. MCP servers are listed in the **MCP servers** section of the Collections explorer (the one sidebar of the request editors); a server opens in its own tab of the MCP view.

- [Connect](./connecting.md) over **stdio**, **Streamable HTTP** or legacy **SSE**, or serve a [mock](./mocking.md) from a YAML file.
- Discover [tools](./tools.md), [resources, resource templates](./resources.md) and prompts.
- Run tools from forms generated from their JSON Schema, and save calls as regression tests (**Save as test…**).
- Answer a server's [elicitation, sampling and roots](./client-features.md) requests.
- [Debug](./debugging.md) with a timeline of every JSON-RPC message.

Transport handling is isolated from the domain model: a tracing decorator wraps whichever transport is used.

:::
