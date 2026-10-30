---
title: "Glossary: every word in plain language"
description: "The words used across TestPion in plain language, from A to Z: API, assertion, collection, environment, flow, MCP, prompt, workspace and more, each with one sentence and a link to learn more."
---

# Glossary: every word in plain language

::: tip In short
One sentence per word, in alphabetical order. If a word is about testing AI, the [glossary of AI testing](/ai-testing/glossary) goes into more detail.
:::

::: v-pre

| Word | What it means | Learn more |
|---|---|---|
| **Agent** | An AI that can use tools (search, send an email, call an API) to finish a task. | [Agents](/ai-testing/agents) |
| **API** | A way for one program to ask another program for data or to do something. | [REST and HTTP](/api-testing/rest) |
| **Assertion (check)** | A rule an answer must follow, such as "status is 200" or "the name is not empty". | [Assertions](/test-runner/assertions) |
| **Authentication** | Proving who you are to an API, with a token, a password or a key. | [Authentication](/api-testing/authentication) |
| **Baseline** | A result you saved to compare later runs with. | [Evaluations](/ai-testing/evaluations) |
| **Body** | The data you send with a request, or the data that comes back. | [REST and HTTP](/api-testing/rest) |
| **Branch** | A separate line of work in git, so your changes do not disturb others until you are ready. | [Git](/getting-started/git) |
| **CI (continuous integration)** | A service that runs your tests by itself on every change. | [CI/CD](/test-runner/ci-cd) |
| **CLI** | The command line: type `testpion run` instead of clicking. | [CLI reference](/cli/reference) |
| **Collection** | A folder of saved requests, usually for one API. | [Collections](/api-testing/collections) |
| **Commit** | A saved step in git, with a short message about what changed. | [Git](/getting-started/git) |
| **Cookie** | A small value a website gives you and expects back, often to remember you are logged in. | [Cookies](/api-testing/cookies) |
| **Dataset** | A table of inputs (one row per test), so one test runs many times. | [Datasets](/test-runner/datasets) |
| **Environment** | A named set of values (a web address, a key) you can switch, such as *test* and *live*. | [Environments](/api-testing/environments) |
| **Evaluation** | Many questions sent to an AI, with a score for each answer, saved to run again. | [Evaluations](/ai-testing/evaluations) |
| **Flaky test** | A test that sometimes passes and sometimes fails with no change. | [Test runner](/test-runner/overview) |
| **Flow** | Several steps drawn on a canvas and run in order (log in, create, check, delete). | [Flows](/test-runner/integration-testing) |
| **gRPC** | A fast way for programs to talk, used inside companies. | [gRPC](/api-testing/grpc) |
| **GraphQL** | An API where you ask for exactly the fields you want. | [GraphQL](/graphql/overview) |
| **Header** | Extra information sent with a request or answer, such as the type of data. | [REST and HTTP](/api-testing/rest) |
| **HTTP** | The language of the web. Every web request and answer uses it. | [REST and HTTP](/api-testing/rest) |
| **JSON** | A common way to write data as `{"name": "value"}`. | [REST and HTTP](/api-testing/rest) |
| **JUnit report** | A standard test report file that CI services can read. | [CI/CD](/test-runner/ci-cd) |
| **Load test** | Sending many requests at once to see how fast and stable an API stays. | [Load testing](/performance/load-testing) |
| **MCP (Model Context Protocol)** | A standard way to give an AI assistant tools. TestPion can connect to an MCP server and test its tools. | [MCP overview](/mcp/overview) |
| **Merge** | Joining two lines of work in git. TestPion merges collections request by request. | [Git](/getting-started/git) |
| **Mock server** | A pretend API that answers with fixed data, for when the real one is not ready. | [Mock servers](/api-testing/mock-servers) |
| **Monitor** | A test that runs on a schedule and alerts you when it fails. | [Monitors](/test-runner/monitors) |
| **Pass / fail** | Whether every check on a test held (pass) or at least one did not (fail). | [Test runner](/test-runner/overview) |
| **Prompt** | The text you send to an AI model. | [Prompts](/ai-testing/prompts) |
| **Pull / push** | Pull brings your team's changes to your computer. Push sends yours to the team. | [Git](/getting-started/git) |
| **RAG bot (bot with sources)** | A chatbot that looks up documents before it answers. | [RAG](/ai-testing/rag) |
| **Redaction** | Hiding secrets (keys, passwords) in logs and reports. | [Privacy](/security/privacy) |
| **Request / response** | The question you send, and the answer that comes back. | [Your first request](/getting-started/first-request) |
| **REST** | The most common kind of web API, using web addresses and HTTP. | [REST and HTTP](/api-testing/rest) |
| **Secret** | A value that must stay private, such as a password or an API key. TestPion keeps it in your computer's key store. | [Secrets](/security/secrets) |
| **Status code** | A number in the answer. `200` worked, `404` not found, `401` not allowed, `500` the server failed. | [REST and HTTP](/api-testing/rest) |
| **Test suite** | A list of tests you run together. | [Test runner](/test-runner/overview) |
| **Token (login)** | A long text that proves you are logged in. | [Authentication](/api-testing/authentication) |
| **Token (AI)** | A piece of a word. AI models count and charge by tokens. | [Model pricing](/ai-testing/model-pricing) |
| **Trace** | A recorded timeline of what happened during a request or a test. | [Traces](/test-runner/traces) |
| **Variable** | A name in double curly braces, like `{{baseUrl}}`, that TestPion replaces with a value. | [Environments](/api-testing/environments) |
| **WebSocket** | A connection that stays open so both sides can send messages at any time. | [WebSocket](/api-testing/websocket) |
| **Workspace** | A folder that holds everything for one project: collections, environments, tests. | [Workspaces](/getting-started/workspaces) |
| **YAML** | A simple text format for settings and tests. TestPion test files are YAML. | [Test runner](/test-runner/overview) |

:::
