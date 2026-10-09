---
title: "Privacy and redaction"
description: "Redaction of logs, traces, reports and exports; the script sandbox; and telemetry."
---

::: v-pre

# Privacy

## Redaction

Everything written to logs, traces, history, results, reports and exports passes through a redactor that masks:

1. **Sensitive field names:** `password`, `token`, `apiKey`, `authorization`, `cookie`, `secret`, `ssn`, `creditCard` and more. These are configurable in Settings and matched case-insensitively, including as suffixes (`accessToken`, `x-api-key`).
2. **Known secret values:** every secret resolved during a run is registered, and any occurrence inside any string is masked (URLs, bodies, error messages). Tokens obtained at runtime (OAuth, `extract:` into sensitive names) are registered too.

## OS environment variables

`{{$env.NAME}}` reads an environment variable of the computer. In the app it works only for the names you list in **Settings ▸ Privacy ▸ OS environment variables requests may read** (none by default): otherwise a collection shared with you through git, or one you import, could read `{{$env.AWS_SECRET_ACCESS_KEY}}` and send it to any URL the moment you run it. A request that reads a variable not on the list says so, with a link to the setting. The CLI reads all of them, as CI pipelines expect (the pipeline decides what is in the environment; see [CI/CD](/test-runner/ci-cd)).

## Programs a workspace starts

An MCP server of the `stdio` kind is a program TestPion starts on your computer, with your permissions. Because a workspace can come from git, an import or a teammate, the first **Connect** to such a server shows the exact command line and asks: **Run once**, or **Always for this workspace** (remembered in the workspace's `.local/trust.json`, which is per computer and never committed). Mock and HTTP servers start nothing and never ask. The CLI and the MCP server for agents run what you invoke, like any command.

## Script sandbox

Scripts run in **QuickJS compiled to WebAssembly**, a separate JavaScript engine with its own heap. There is no filesystem, network, process, `require` or host-realm access. CPU time (2 s by default) and memory (32 MB) are limited. Data crosses the boundary only as JSON.

## Network policy (shared and hosted servers)

On your desktop TestPion can call anything, including `localhost` and your private network, because testing those APIs is the point. When TestPion runs for other people, such as an MCP server that agents use or the planned online version, turn on the network policy:

- **Private networks blocked:** requests, redirects, `tp.sendRequest`, GraphQL, WebSocket handshakes, MCP servers over HTTP, AI providers and remote datasets refuse loopback, private (10/8, 172.16/12, 192.168/16, fc00::/7), link-local (including the cloud metadata address 169.254.169.254), carrier-grade NAT and similar addresses. Host names are checked after DNS resolution and again when the connection opens, and every redirect is checked, so a public URL can't redirect or re-resolve into your network.
- **Local programs blocked:** MCP servers that run as local commands (stdio) can't be started.
- **Allow list:** specific internal hosts can stay reachable.

Turn it on with environment variables (`TESTPION_BLOCK_PRIVATE_NETWORKS=1`, `TESTPION_ALLOW_HOSTS=api.internal,10.0.0.5`, `TESTPION_ALLOW_PROCESSES=0`) or with `testpion mcp-server --block-private-networks [--allow-host api.internal]`.

## Telemetry

Telemetry is not implemented. Request bodies, API keys, prompts and responses are sent only to the endpoints and providers you call.

:::
