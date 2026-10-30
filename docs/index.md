---
layout: home
title: TestPion
titleTemplate: API, MCP and AI Testing Tool
description: TestPion is a free, local-first desktop app and CLI for testing and debugging REST, GraphQL and WebSocket APIs, MCP servers, LLM APIs, RAG pipelines and AI agents on Windows, macOS and Linux.

hero:
  text: Check that your APIs and AI work the way they should
  tagline: Send a request, see the answer, and let TestPion tell you if it is right. For web APIs, AI chatbots and AI tools. Free, private on your computer, and the same tests run in CI.
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
      text: Start here
      link: /getting-started/start-here

features:
  - title: Test web APIs
    details: Send requests, log in, and add checks. Works with REST, GraphQL, gRPC and WebSocket.
    link: /getting-started/first-request
    linkText: Your first request
  - title: Test AI tools (MCP)
    details: Connect to an MCP server, see its tools, try them from a form, and watch every message.
    link: /mcp/overview
    linkText: MCP testing
  - title: Check AI answers
    details: Ask AI models the same question, compare the answers, and see time and cost.
    link: /getting-started/check-an-ai-answer
    linkText: Check an AI answer
  - title: Score a chatbot
    details: Send many questions to a chatbot or a bot that answers from documents, and get a score for each answer.
    link: /ai-testing/evaluations
    linkText: Evaluations
  - title: Run tests anywhere
    details: Save requests as tests, run them in groups, and run them again in CI. Reports in JUnit, HTML and Markdown.
    link: /test-runner/overview
    linkText: The test runner
  - title: Build multi-step flows
    details: "Draw steps on a canvas: log in, create something, check it, clean up. Run it with many data rows."
    link: /test-runner/integration-testing#design-a-flow
    linkText: Design a flow
  - title: Watch your APIs
    details: Run tests on a schedule and get an alert when something breaks or a certificate is about to expire.
    link: /test-runner/monitors
    linkText: Monitors
  - title: Work with your team
    details: Keep your work in git, review changes request by request, and pull your team's updates.
    link: /getting-started/git
    linkText: Share your work
  - title: Let AI assistants use it
    details: Give Claude, Copilot or another assistant tools to send requests and run tests for you.
    link: /ai-testing/mcp-server
    linkText: Use from AI agents
  - title: Private by design
    details: No account and no tracking. Your secrets stay in your computer's key store and are hidden in logs and reports.
    link: /security/privacy
    linkText: Privacy
---

<script setup>
import { data as release } from "./data/release.data";
</script>

## Choose your path

New here? Pick the line that sounds like you. Each path is short and ends with something that works.

| I want to… | Start with |
|---|---|
| Try it without setting anything up | [Start here](/getting-started/start-here) |
| Test a web API | [Your first request](/getting-started/first-request) |
| Check that an AI chatbot or prompt gives good answers | [Check an AI answer in 5 minutes](/getting-started/check-an-ai-answer) |
| Share my tests with a team | [Share your work](/getting-started/git) |
| Run my tests in CI | [Run tests in CI](/test-runner/ci-cd) |
| Move from Postman or another tool | [Migrate](/migrate/) |
| Find a word I do not know | [Glossary](/getting-started/glossary) |

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
