---
title: FAQ
description: Frequently asked questions about TestPion — pricing, privacy, supported protocols and AI providers, MCP, CI usage and data locations.
---

# Frequently asked questions

## Is TestPion free?

Yes. It's open source under the MIT license, with no account, subscription or paid tier.

## Does it send my requests, prompts or API keys anywhere?

No. Requests go only to the servers you call, and prompts only to the AI provider you choose. There's no telemetry. Secrets are encrypted with your operating system's credential store and redacted from logs, traces, history and reports. See [privacy](/security/privacy).

## Which AI providers are supported?

OpenAI and any OpenAI-compatible server (vLLM, LM Studio, OpenRouter and others), Azure OpenAI, Anthropic, Google Gemini, Amazon Bedrock (any model, through the Converse API), Ollama for local models, and a built-in offline mock. See [AI testing](/ai-testing/overview).

## Do I need an internet connection?

No for local APIs, local MCP servers, local models (Ollama) and the mock provider. Cloud AI providers and remote APIs need network access, of course.

## Which MCP transports can I connect to?

stdio (a local command), Streamable HTTP and the legacy SSE transport. See [connecting](/mcp/connecting).

## Can I run my tests in CI?

Yes. Tests are YAML files in your repository, and the [`testpion` CLI](/installation/cli) runs them with JUnit, JSON, HTML and Markdown reports and standard exit codes. A run's ⋯ ▸ **Run in CI…** (or `testpion ci github -w . --run last`) writes the pipeline for what you just ran. See [CI/CD](/test-runner/ci-cd).

## Can tests change data in production by accident?

Not without a yes. Mark an environment as **production** and every data-changing request (POST, PUT, PATCH, DELETE, GraphQL mutations, gRPC calls that are not reads, realtime messages, MCP tool calls) asks first in the app, once per run; reads run as usual. In the CLI, data-changing steps fail unless you add `--allow-production`, a monitor changes data only when saved with consent, and an AI agent needs a server started with `--allow-production` and `allowProduction: true` on the call. See [Production](/api-testing/environments#production).

## Can AI coding agents work with my workspace?

Yes. `testpion mcp-server` serves it as MCP tools (send requests, run tests, design flows, read failures), `testpion agents init` writes an AGENTS.md describing it, and every CLI command's `--json` prints one envelope whose `.data` is the result (`testpion collections --json | jq '.data'`). See [MCP server](/ai-testing/mcp-server).

## Can I import my Postman collections or OpenAPI specs?

Yes: OpenAPI 3 and Swagger 2 (JSON or YAML, from a file or a link), Postman v2.0 and v2.1 collections and environments (their `pm.*` scripts are converted to `tp.*` and run, and `testpion run-collection` accepts Newman's options), Insomnia, Bruno (a collection folder too), Hoppscotch, WSDL 1.1 and 2.0 (SOAP services), AsyncAPI, `.http` files, Arazzo workflows and HAR files, or a request copied as cURL, fetch, PowerShell or HTTPie. See [collections](/api-testing/collections).

## Are LLM-as-judge scores reliable?

They're useful but not deterministic, so TestPion always labels them as **AI judge** results and records the judge's model, temperature, prompt version and a config hash. Use deterministic checks (exact match, JSON Schema, regex) for hard requirements. See [evaluations](/ai-testing/evaluations).

## How big can responses and test suites get?

Response bodies stream to disk, and the viewer only shows a preview (2 MB by default), so 100 MB+ responses are fine. Test suites and datasets are streamed rather than loaded at once, so runs with hundreds of thousands of tests work. See [benchmarks](/performance/benchmarks).

## Where is my data stored?

In `~/.testpion` (`%USERPROFILE%\.testpion` on Windows): settings, logs, encrypted secrets and workspaces. A workspace can also live in any folder you open, such as one in a git repository. **Settings ▸ Storage** shows how much the open workspace keeps besides its definitions (runs, traces, response bodies, history) and deletes old runs; `testpion storage --delete-runs-older-than 30` does the same from a terminal.

## Something doesn't work. Where do I start?

Run `testpion doctor -w <workspace>`: it checks Node.js, SQLite, the app folder, secrets from the environment, proxy and certificate settings, and whether every collection of the workspace can be read (`--json` for scripts and bug reports). The app's logs are under **Logs** in the status bar.

## Why does Windows or macOS warn me when installing?

The installers aren't code-signed yet. The [Windows](/installation/windows) and [macOS](/installation/macos) guides show how to proceed safely.

## How do I report a bug, suggest an idea or give feedback on the design?

In the app: **Help ▸ Send Feedback or Report a Problem…**, the **Feedback** button in the status bar, or the command palette. Choose *Problem*, *Idea*, *Design* or *Question*, describe it, and decide whether to include the versions and platform and the app's recent errors (home folders and secret-looking values are masked; your requests, responses, collections and environments are never included). **Show the report** shows exactly what will be sent. **Open on GitHub** opens a new issue with it filled in, for you to review and post; **Copy** and **Save as file** keep it for an email or later. The app itself sends nothing.

When a view stops with an error, its error panel has **Report this problem**, with the error already in the report. Unexpected errors are also written to the app log (status bar ▸ Logs).

From a terminal or an agent: `testpion feedback -k bug -t "…" -m "…" --diagnostics` prints the report and the link (`--json` for scripts). You can also open an issue on [GitHub](https://github.com/nasimuddin-dev/testpion/issues) directly. Report security problems privately as described in [SECURITY.md](https://github.com/nasimuddin-dev/testpion/blob/main/SECURITY.md).
