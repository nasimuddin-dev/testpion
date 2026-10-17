---
title: Roadmap
description: "What's planned for TestPion (signed installers, optional team features) and what has shipped."
---

# Roadmap

Plans change with feedback. Vote or comment on [GitHub issues](https://github.com/nasimuddin-dev/testpion/issues).

## Next

- **Signed installers:** Windows Authenticode, and macOS Developer ID with notarization (macOS in-place updates need it).

## Shipped

Everything below is in the app today; the [changelog](/changelog) has the details per version.

- **Protocols:** REST, GraphQL (with subscriptions, a schema explorer and an operation builder), gRPC (proto files or server reflection, TLS), WebSocket, Socket.IO, MQTT, Kafka, Server-Sent Events and MCP; HTTP/2.
- **Mock servers:** HTTP mocks from saved examples (with forwarding for partial mocks), a GraphQL mock from a schema, and MCP mocks.
- **Imports:** OpenAPI, Postman, Insomnia, Bruno (collection folders too, with Bruno scripts running as they are), Hoppscotch, WSDL 1.1 and 2.0, AsyncAPI 2 and 3, .http files (REST Client, JetBrains), Arazzo 1.0 workflows, HAR and pasted cURL / fetch / PowerShell; an HTTP Debugger that captures traffic and saves it as requests or flows.
- **Running:** a Collection Runner and Newman-compatible `testpion run-collection`, suites, monitors of collections or flows (scheduled runs with webhooks), load tests of one endpoint, a collection or a flow, CI pipeline generation (from any run, or one flow with data rows and an environment matrix), and watch mode.
- **Flows:** a visual flow designer with every block (requests of each protocol, conditions, loops, polling, scripts, sub-flows, parallel groups, clean-up), debugging with breakpoints, runs per data row or per environment, a timeline with the critical path, and deployment to a schedule, a webhook, an MCP tool or CI.
- **Production guard:** an environment marked as production asks before every data-changing request, in the app, the CLI (`--allow-production`), monitors and for agents.
- **Finding your way:** Quick Open, a Problems list, an Info panel, a terminal in the bottom panel, `testpion://` links, and one menu vocabulary everywhere.
- **Git:** changes by meaning (flows step by step), Pull & push in one step, conflicts request by request.
- **AI:** an AI Lab with model comparison, evaluations for LLMs, RAG and agents (with a matrix of runs against a baseline), an assistant in the request builder, AI that writes verified checks, tp tests and integration flows from a collection as proposals you review (with what is sent shown first, Local only and cost caps), `testpion mcp-server` for AI agents, AGENTS.md from the live workspace, and one JSON envelope for every CLI `--json`.
- **OpenTelemetry export** of traces (OTLP/HTTP) from the app, the CLI and MCP.
- **The CLI on npm:** `npx testpion` or `npm install -g testpion`, no clone needed.
- **Updates** inside the app (Windows installer and Linux AppImage; other builds are pointed to the download page).

## Optional cloud features (not in the local-first core)

Team workspaces, cloud execution, centralised reports, SSO and role-based access. These will always be optional; the desktop app and CLI will keep working fully offline.
