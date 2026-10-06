---
title: Roadmap
description: What's planned for TestPion — signed installers, an npm CLI package, more protocols and providers, and optional team features.
---

# Roadmap

Plans change with feedback. Vote or comment on [GitHub issues](https://github.com/nasimuddin-dev/testpion/issues).

## Next

- **Signed installers:** Windows Authenticode, and macOS Developer ID with notarization (macOS in-place updates need it).
- **Published CLI package** on npm, so `npx testpion` works without cloning the repository.

## Shipped

Everything below is in the app today; the [changelog](/changelog) has the details per version.

- **Protocols:** REST, GraphQL (with subscriptions, a schema explorer and an operation builder), gRPC (proto files or server reflection, TLS), WebSocket, Socket.IO, MQTT, Kafka, Server-Sent Events and MCP; HTTP/2.
- **Mock servers:** HTTP mocks from saved examples (with forwarding for partial mocks), a GraphQL mock from a schema, and MCP mocks.
- **Imports:** OpenAPI, Postman, Insomnia, Bruno (collection folders too, with Bruno scripts running as they are), Hoppscotch, WSDL 1.1 and 2.0, HAR and pasted cURL / fetch / PowerShell; recording traffic through a local proxy.
- **Running:** a Collection Runner and Newman-compatible `testpion run-collection`, suites, monitors (scheduled runs with webhooks), load tests of one endpoint or a whole collection, CI pipeline generation, and watch mode.
- **AI:** an AI Lab with model comparison, evaluations for LLMs, RAG and agents, an assistant in the request builder, and `testpion mcp-server` for AI agents.
- **OpenTelemetry export** of traces (OTLP/HTTP) from the app, the CLI and MCP.
- **Updates** inside the app (Windows installer and Linux AppImage; other builds are pointed to the download page).

## Optional cloud features (not in the local-first core)

Team workspaces, cloud execution, centralised reports, SSO and role-based access. These will always be optional; the desktop app and CLI will keep working fully offline.
