---
layout: home
title: TestPion
titleTemplate: API, MCP and AI Testing Tool
description: TestPion is a free, local-first desktop app and CLI for testing and debugging REST, GraphQL and WebSocket APIs, MCP servers, LLM APIs, RAG pipelines and AI agents on Windows, macOS and Linux.

hero:
  text: Test and debug APIs, MCP servers and AI systems in one place
  tagline: REST, GraphQL, WebSocket, MCP, LLMs, RAG and agents — with a test runner, evaluation lab and trace viewer. Local-first, private, and the same engine in your CI.
  image:
    src: /images/testpion-wordmark.png
    alt: TestPion — Connect every protocol
  actions:
    - theme: brand
      text: Download
      link: /download
    - theme: alt
      text: View on GitHub
      link: https://github.com/nasimuddin-dev/testpion
    - theme: alt
      text: Read the docs
      link: /getting-started/installation

features:
  - title: REST & GraphQL client
    details: Requests with every common auth type, bodies, cookies, scripts and assertions. GraphQL introspection with schema-aware autocomplete. Large responses stream to disk.
    link: /api-testing/rest
    linkText: API testing
  - title: MCP inspector
    details: Connect over stdio, Streamable HTTP or SSE. Discover tools, resources and prompts, run tools from generated forms, and trace every JSON-RPC message.
    link: /mcp/overview
    linkText: MCP debugging
  - title: AI quality
    details: Test prompts on OpenAI-compatible, Azure, Anthropic, Gemini, Amazon Bedrock and Ollama models — or an offline mock. Streaming, time to first token, tokens, cost and side-by-side comparison.
    link: /ai-testing/overview
    linkText: AI testing
  - title: Evaluations
    details: Stream datasets through deterministic, semantic and LLM-as-judge evaluators, including RAG, agent tool-use and safety checks. Compare runs against baselines.
    link: /ai-testing/evaluations
    linkText: Evaluation guide
  - title: Test runner & CI
    details: YAML test suites with parallel workers, retries, dependencies and resumable runs. Save any request as a test, run it in CI from the run itself. JUnit, JSON, HTML and Markdown reports, and the testpion CLI for any CI system.
    link: /test-runner/overview
    linkText: Test runner
  - title: Visual flow designer
    details: Build multi-step API flows on a canvas — requests, conditions, loops, polling, sub-flows — debug them with breakpoints, run them per data row, per environment or under load, and deploy them to a schedule, a webhook, an MCP tool or CI. The file stays plain YAML.
    link: /test-runner/integration-testing#design-a-flow
    linkText: Design a flow
  - title: Monitors & certificates
    details: Run collections or flows on a schedule with alerts, response-time limits, uptime by day and per-request numbers. Every HTTPS response records its certificate, so an expiring one never surprises you.
    link: /test-runner/monitors
    linkText: Monitors
  - title: Charts that explain
    details: A Home dashboard with what needs attention, run charts down to DNS, TCP, TLS and server time, each test's history and the flaky ones, load and monitor trends, and usage of MCP tools and AI models.
    link: /features
    linkText: All features
  - title: Built for AI agents
    details: testpion mcp-server gives agents more than 120 tools, from sending requests and designing flows to what needs attention, with secrets redacted and production guarded. testpion agents init writes AGENTS.md, every CLI command's --json is one envelope, and the docs publish llms.txt.
    link: /ai-testing/mcp-server
    linkText: MCP server
  - title: Local-first and private
    details: No account and no telemetry. Secrets are encrypted with your OS keychain and redacted from logs, traces and reports. Scripts run in a WebAssembly sandbox.
    link: /security/privacy
    linkText: Privacy
---

<script setup>
import { data as release } from "./data/release.data";
</script>

## See it in action

<figure class="aps-screenshot">
  <img src="/images/rest.jpg" alt="TestPion sending a GET request from the Veterinary API collection, showing a 200 response as a JSON tree and three passing assertions" width="1440" height="900">
  <figcaption>A REST request from a collection, with the JSON response and passing assertions.</figcaption>
</figure>

<div class="aps-gallery">
  <figure class="aps-screenshot">
    <img src="/images/mcp.jpg" alt="The MCP inspector connected to a stdio server, running the search_customer tool from a form generated from its JSON Schema" width="1440" height="900" loading="lazy">
    <figcaption>MCP inspector: run a tool from its schema.</figcaption>
  </figure>
  <figure class="aps-screenshot">
    <img src="/images/tests.jpg" alt="A test run of 22 REST, GraphQL, MCP, LLM, RAG and agent tests, all passing, with evaluation score cards" width="1440" height="900" loading="lazy">
    <figcaption>One run across REST, GraphQL, MCP, LLM, RAG and agents.</figcaption>
  </figure>
  <figure class="aps-screenshot">
    <img src="/images/ai-lab.jpg" alt="The AI quality playground with a prompt template, streamed JSON output, latency, time to first token and token counts" width="1440" height="900" loading="lazy">
    <figcaption>AI quality: prompt, stream and measure.</figcaption>
  </figure>
  <figure class="aps-screenshot">
    <img src="/images/traces.jpg" alt="A trace waterfall of an agent test with LLM steps, an MCP tool call and evaluation" width="1440" height="900" loading="lazy">
    <figcaption>Traces for every request, tool call and model call.</figcaption>
  </figure>
</div>

[See all features](/features)

## Runs on your operating system

TestPion is a desktop app for Windows, macOS and Linux, and every release has installers for each:

| System | Installers |
| --- | --- |
| **Windows** 10 and 11, x64 | Installer (`.exe`) or a portable `.exe` that runs without installing |
| **macOS** 12+ | `.dmg` for Apple Silicon and for Intel |
| **Linux** x86_64 | AppImage, `.deb` and `.rpm` |

The `testpion` command-line runner uses the same engine and runs anywhere Node.js 22+ runs — see [installing the CLI](/installation/cli).

[Download TestPion](/download) · [Installation guides](/installation/windows)

## Local-first by design

- **Your data stays on your machine.** Workspaces are plain files (collections, environments, YAML tests) that you can commit to git. There's no account and no cloud backend.
- **Secrets never touch workspace files.** Tokens and API keys are encrypted with Windows DPAPI, the macOS Keychain or Linux Secret Service, and redacted from every log, trace, report and export.
- **No telemetry.** Requests and prompts go only to the servers and AI providers you call.
- **Deterministic where it matters.** AI-judge and heuristic scores are always labelled, so they're never confused with real assertions.

Read the [privacy notes](/security/privacy).

## Latest release

**TestPion {{ release.version }}**<span v-if="release.date">, released {{ release.date }}</span>. See [what's new](/changelog) or <a :href="release.releaseUrl">all release files on GitHub</a>.

## Developed in public on GitHub

The source code, issues and releases are public at [github.com/nasimuddin-dev/testpion](https://github.com/nasimuddin-dev/testpion). [Report a bug or request a feature](https://github.com/nasimuddin-dev/testpion/issues), browse [releases](https://github.com/nasimuddin-dev/testpion/releases), or read the source.
