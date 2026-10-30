---
title: "Start here"
description: "New to TestPion? Pick the line that describes you and follow a short path: test an API, test an AI chatbot, share work with a team, or run tests in CI. Plus a finder for common tasks and the words you will meet."
---

# Start here

::: tip In short
TestPion checks that software does what it should. You send a request to an API, an AI model or a chatbot, and TestPion tells you if the answer is right. **Pick the line below that sounds like you.**
:::

## Who are you?

| I am… | I want to… | Start with |
|---|---|---|
| **New to testing** | Try it without setting anything up | [Try the Examples workspace](#try-it-in-two-minutes) |
| **A tester or developer** | Test a web API (REST, GraphQL, gRPC, WebSocket) | [Your first request](/getting-started/first-request) |
| **Building with AI** | Check that a chatbot or prompt gives good answers | [Check an AI answer in 5 minutes](/getting-started/check-an-ai-answer) |
| **Building a bot that answers from documents (RAG)** | Find out if it uses the right documents | [Test a RAG bot](/ai-testing/rag#sample) |
| **Working in a team** | Share requests and tests with colleagues | [Share your work with your team](/getting-started/git) |
| **Setting up CI** | Run the same tests on every change | [Run tests in CI](/test-runner/ci-cd) |
| **Using Postman or another tool** | Move my work here | [Migrate from another tool](/migrate/) |
| **Using an AI assistant (Claude, Copilot…)** | Let it use TestPion for me | [Use TestPion from AI agents](/ai-testing/mcp-server) |

## Try it in two minutes

You do not have to install a server or write a file. TestPion comes with an **Examples workspace** that works on its own.

1. [Install TestPion](/getting-started/installation) and open it.
2. The **TestPion Examples** workspace opens the first time. If you closed it, choose **Help ▸ Open Examples Workspace**.
3. In the left list, open **HTTP basics (httpbin)** and click a request such as **GET with query parameters**.
4. Press **Send** (or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>).

You now see the answer: a number such as `200` (it worked), the time it took, and the data that came back. That is all an API test is: send something, look at what comes back, and decide if it is right.

::: tip Next step
Open the **Tests** tab on the same request and add a check, for example *status equals 200*. Send again. TestPion shows a green tick when the check passes and a red cross when it does not.
:::

## I want to… (find a task)

| I want to… | Go to |
|---|---|
| Send a request and read the answer | [Your first request](/getting-started/first-request) |
| Log in to an API (a token, a password, an API key) | [Authentication](/api-testing/authentication) |
| Use the same request for test and live servers | [Environments and variables](/api-testing/environments) |
| Check the answer automatically | [Assertions](/test-runner/assertions) |
| Run many requests in order | [Collections](/api-testing/collections) |
| Run my tests from the terminal or CI | [The test runner](/test-runner/overview), [CI/CD](/test-runner/ci-cd) |
| Chain several steps (log in, then create, then delete) | [Flows](/test-runner/integration-testing) |
| Fake an API that does not exist yet | [Mock servers](/api-testing/mock-servers) |
| See what an app is sending over the network | [HTTP Debugger](/api-testing/http-debugger) |
| Test an MCP server (a tool for AI) | [MCP overview](/mcp/overview) |
| Check if an AI answer is good | [Check an AI answer](/getting-started/check-an-ai-answer) |
| Compare two AI models on the same question | [Prompts](/ai-testing/prompts) |
| Make sure a chatbot refuses harmful requests | [Safety](/ai-testing/safety) |
| Test an AI agent that uses tools | [Agents](/ai-testing/agents) |
| Know how much an AI test costs | [Model pricing](/ai-testing/model-pricing) |
| Keep my work in git and share it | [Keep your workspace in git](/getting-started/git) |
| Keep secrets (passwords, keys) safe | [Secrets](/security/secrets) |
| Test how fast an API is under load | [Load testing](/performance/load-testing) |
| Watch an API all day and get an alert | [Monitors](/test-runner/monitors) |
| Bring my Postman collections | [Migrate from Postman](/migrate/postman) |
| Find a keyboard shortcut | [Keyboard shortcuts](/getting-started/keyboard-shortcuts) |
| Find a setting or a word I do not know | [The words you will meet](#the-words-you-will-meet), [Glossary](/getting-started/glossary) |

## The words you will meet

::: v-pre

You can learn these as you go.

| Word | In plain words |
|---|---|
| **API** | A way for one program to ask another program for something, over the internet. |
| **Request / response** | The question you send, and the answer that comes back. |
| **Status code** | A number in the answer. `200` means it worked, `404` means not found, `500` means the server failed. |
| **Collection** | A folder of saved requests. |
| **Environment** | A set of values (a web address, a key) you can switch, such as *test* and *live*. |
| **Variable** | A name in double curly braces, like `{{baseUrl}}`, that TestPion replaces with a value from the environment. |
| **Assertion / check** | A rule the answer must follow, such as "status is 200". |
| **Test suite** | A list of tests you run together. |
| **Flow** | Several steps drawn on a canvas, run in order. |
| **MCP** | A standard way to give an AI assistant tools. TestPion can test these tools. |
| **Prompt** | The text you send to an AI model. |
| **Evaluation** | Many questions sent to an AI, with a score for each answer. |
| **RAG bot** | A chatbot that looks up documents before it answers. |
| **Judge (AI reviewer)** | A second AI that reads an answer and decides if it is good. Shown as *AI reviewer* in the app. |
| **Workspace** | A folder that holds everything for one project. |

More words are in the [glossary](/getting-started/glossary).

:::

## How these docs are organised

Every page is one of four kinds, so you know what to expect:

- **Start and tutorials** ("Your first request", "Check an AI answer"): follow the steps, you get a result.
- **Guides** ("Authentication", "Flows"): how to do one job.
- **Explanations** ("Privacy", "Trust"): why it works the way it does.
- **Reference** ("CLI", "Assertions list"): look something up.

Most pages begin with a short **In short** box. If it tells you what you need, you can skip the rest.

## Still stuck?

- Press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>K</kbd> in the app to search commands, requests and help.
- Read the [FAQ](/faq).
- [Open an issue on GitHub](https://github.com/nasimuddin-dev/testpion/issues) and say what you tried.
