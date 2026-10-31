---
title: "Examples workspace"
description: "The TestPion Examples workspace: ready-to-run requests and tests for REST, SOAP, GraphQL, gRPC, WebSocket, MQTT, SSE, MCP and AI against free public APIs."
---

# Examples workspace

TestPion comes with a **TestPion Examples** workspace. It opens the first time you start the app, and you can open it again at any time from **Help ▸ Open Examples Workspace** or the link on the Home page. Everything in it works against free public services, with nothing to install or configure. Select the **Public APIs** environment (it is selected for you) and press **Send**.

The workspace is copied into your data folder once. You can change it freely: app updates never overwrite your copy. They only add the examples that are new in that version and, when an older version left a second copy of an example collection (two *Live streams (SSE)*, say), merge it back into one; the copy stays in [Recently deleted](/getting-started/workspaces#recently-deleted) for 30 days.

<figure class="aps-screenshot">
  <img src="/images/examples-sidebar.jpg" alt="The TestPion Examples workspace in the Collections sidebar: each example collection listed once, Live streams (SSE) open with its three requests, and the MCP servers in their folders" width="1440" height="900" loading="lazy">
</figure>

## What's inside

| Area | Where | Uses |
|---|---|---|
| REST basics: methods, query parameters, JSON and form bodies, headers, redirects, XML, images, JSON Schema checks | Collection **HTTP basics (httpbin)** | [httpbin.org](https://httpbin.org) |
| Authentication: Basic, Bearer, Digest, API key; cookies | Same collection, **Authentication** and **Cookies** folders | httpbin.org |
| Scripts and chaining (`tp.*`), path variables, a `tp.visualizer` table | Collection **Scripts & chaining (JSONPlaceholder)**; run it in order | [JSONPlaceholder](https://jsonplaceholder.typicode.com) |
| OpenAPI contract testing (`openapi` check against `specs/petstore.json`) | Collection **Swagger Petstore (OpenAPI contract)** | [Swagger Petstore](https://petstore3.swagger.io) |
| A playground of public REST APIs: a login that returns a JWT used as a Bearer token; a full create, read, update, delete flow with a token in a cookie; an API key header; every method, Basic auth, any status code, slow responses; pagination, search, errors, images and open data | Collection **Public REST APIs (playground)**; run a folder in order (▶) to see values flow between requests | [DummyJSON](https://dummyjson.com), [Restful-Booker](https://restful-booker.herokuapp.com), [Postman Echo](https://postman-echo.com), [ReqRes](https://reqres.in), [Fake Store](https://fakestoreapi.com), [Open-Meteo](https://open-meteo.com), [PokéAPI](https://pokeapi.co), [Open Library](https://openlibrary.org), GitHub, xkcd, Dog CEO, catfact.ninja, agify.io, Zippopotam.us, randomuser.me |
| GraphQL queries with variables, mutations, and an error case | Collection **GraphQL (public APIs)**; open a request and press **Introspect** to browse the schema | [Countries](https://countries.trevorblades.com), [Rick and Morty](https://rickandmortyapi.com), [Star Wars (SWAPI)](https://swapi-graphql.netlify.app), [GraphQLZero](https://graphqlzero.almansi.me) (mutations), [AniList](https://anilist.co), PokéAPI GraphQL |
| Server-Sent Events: a short stream that ends, and live ones | Collection **Live streams (SSE)**; press Stop when you've seen enough | Postman Echo, [Wikimedia EventStreams](https://stream.wikimedia.org), Hacker News (Firebase) |
| gRPC through server reflection (no `.proto` files): unary, server streaming, plain text and TLS, every field type, metadata, a chosen error status | Collection **gRPC (grpcb.in)**; tests in Tests ▸ `grpc/` | [grpcb.in](https://grpcb.in) |
| WebSocket echo | Collection **WebSocket & MQTT ▸ Echo servers**; tests in Tests ▸ `websocket/echo.yaml` | Postman echo, echo.websocket.org, ws.ifelse.io |
| MQTT publish and subscribe | Collection **WebSocket & MQTT ▸ MQTT brokers**; test in Tests ▸ `websocket/mqtt.yaml` | [test.mosquitto.org](https://test.mosquitto.org), [HiveMQ](https://www.hivemq.com/mqtt/public-mqtt-broker/), [EMQX](https://www.emqx.com/en/mqtt/public-mqtt5-broker) |
| SOAP, imported from a WSDL (1.1 and 1.2; tests read the XML with `xml2Json`), a calculator and country information | Collection **SOAP services** | [DataAccess NumberConversion](https://www.dataaccess.com/webservicesserver/NumberConversion.wso), [dneonline calculator](http://www.dneonline.com/calculator.asmx), [oorsprong CountryInfo](http://webservices.oorsprong.org/websamples.countryinfo/CountryInfoService.wso) |
| MCP over Streamable HTTP, no account | MCP servers ▸ **Public servers** (Petstore MCP, DeepWiki, Hugging Face Hub) and **Docs & search** (Microsoft Learn, Context7, Cloudflare, Astro, the MCP spec through GitMCP); tests in Tests ▸ `mcp/` | petstore.run.mcp.com.ai, mcp.deepwiki.com, huggingface.co/mcp, learn.microsoft.com/api/mcp, mcp.context7.com, docs.mcp.cloudflare.com, mcp.docs.astro.build, gitmcp.io |
| MCP over stdio, every MCP feature (tools, resources with subscriptions, prompts, completions, logging, long-running progress) | MCP servers ▸ **Reference servers ▸ Everything**; needs Node.js (it starts `npx -y @modelcontextprotocol/server-everything`) | the official reference server |
| MCP mock (offline) | MCP view ▸ **Weather (offline mock)**, from `mocks/weather.mcp-mock.yaml` | none |
| AI prompts: JSON output, summaries, a prompt injection | AI quality ▸ Try a prompt ▸ **Saved prompts** | the offline demo model |
| Evaluation over a dataset, safety, RAG, an agent that calls MCP tools | Tests ▸ `ai/`, `agent/` | the offline demo model (+ Petstore MCP for the agent) |
| **Learn by example**: MCP mocks with computed answers, every kind of prompt check, a dataset evaluation, safety probes, agents with tools, a bot with sources and measures of your own | see [Learn by example](#learn-by-example) below | the offline demo model (examples); nothing leaves the computer |
| Test suites | Tests ▸ **All examples** (everything), **Offline** (no internet needed) and **Learn by example** | |
| Monitor (paused) | Monitors ▸ **Public APIs health** | httpbin.org |
| Traces | Traces view: every request, MCP call, model call and test run adds one | |

## Learn by example

::: v-pre

A set of small, commented files to read, run and change: every one works offline and gives the same result every time. Open a file in **Tests**, read the comment at the top, run it, then change a value and run again. The suite **Learn by example** runs the ones that pass; two files fail on purpose and are marked so.

**MCP** (MCP view ▸ **Mocks**, tests in Tests ▸ `mcp/`)

| File | What it shows |
|---|---|
| `mocks/todo.mcp-mock.yaml` · `tests/mcp/todo-mock.yaml` | A mock with four tools, a resource and a prompt. How a mock picks its answer (`when` on the arguments, `{{args.x}}`, `isError`). Tests for a tool and the shape of its answer (`json-schema`), arguments that change the answer, a value carried from one call to the next (`extract`, `dependsOn`), an error on purpose, a resource by URI, a prompt filled with arguments, and a ping. |
| `mocks/payments.mcp-mock.yaml` · `tests/mcp/payments-mock.yaml` | Answers computed by a `script` (a fee from the amount; a thrown error is a tool error), a dynamic value (`{{$randomInt(…)}}`), an answer in several `content` parts, and checks on numbers and ids (`equals`, `regex`). |

**AI quality** (AI quality ▸ Try a prompt ▸ **Learn by example**, Checks ▸ **Learn: …**, tests in Tests ▸ `ai/`, `agent/`)

| File | What it shows |
|---|---|
| `tests/ai/prompt-checks.yaml` | One prompt per kind of check: JSON with a schema and a value, text checked by words, a pattern and a length, quality judged by an AI reviewer (`llm-judge`), a few-shot classification with `tokens` and `latency` budgets. |
| `tests/ai/support-replies.yaml` · `datasets/support-replies.jsonl` | An evaluation over a dataset: one test per record, `{{message}}` in the prompt and `{{expected}}` in the checks; `similarity` against the reference, an AI reviewer, a length limit. |
| `tests/ai/safety-probes.yaml` | Attacks that must be refused without leaking a canary (`refusal`, `no-leak`), and ordinary questions that must still be answered (`not-refusal`). |
| `tests/agent/todo-agent.yaml` | An agent with the tools of the task mock: which tools were called and with what (`tool-called`, `tool-not-called`, `tool-sequence`, `allowed-tools`, `max-tool-calls`, `tool-args-valid`), and a destructive tool that needs a confirmation first. |
| `tests/agent/agent-cases.yaml` · `datasets/agent-cases.csv` | The same agent from a table: `input`, `should_call` (with arguments: `add_task(title=Buy milk)`) and `should_not_call` columns become the checks. |
| Saved prompts **Learn: …** | The same four prompts as saved prompts, to run in **Try a prompt** and compare models. |
| Saved evaluations **Learn: review sentiment (prompt)**, **Learn: task agent (agent)** | A prompt evaluation and an agent evaluation ready to run from **Checks**, with their report cards. |
| Monitor **Learn: nightly intent check (prompt)** | The sentiment evaluation on a schedule, switched off. Turn it on in **Monitors** to see a nightly check that fails when the pass rate falls. |

**RAG bots** (RAG bots ▸ Bots, Questions, Metrics, Checks)

| File | What it shows |
|---|---|
| `mocks/handbook-bot.mcp-mock.yaml` | A bot that answers from six handbook documents, offline: one MCP tool that returns an answer and the documents it retrieved. Two answers are wrong on purpose: one states something no document says, one retrieves the wrong document. |
| Bot **Handbook bot (offline)** (`library/rag-targets.json`) | The bot as a saved target: the request and where the answer and the sources are in the response (the mapping). |
| `datasets/handbook-questions.jsonl` | Eight questions with the reference answer, the right documents (`reference_ids`) and whether the handbook can answer at all (`answerable`). |
| Evaluation **Learn: handbook bot (bot)** · `tests/ai/handbook-bot.yaml` | The bot checked end to end: the right documents found, the answer against the reference, each statement backed by the sources and the answer on the question (the offline demo model as the reviewer), a question with no answer declined, a measure of your own. 6 of 8 pass; the report card shows the two defects. |
| `tests/ai/rag-inline.yaml` | The same measures when you already have the answer and the documents (a log, a capture): no model is called. One test fails on purpose to show a retrieval miss. |
| `metrics/*.yaml` | A measure of each kind: `cites-a-source` (a rule), `plain-language` (a criterion an AI reviewer decides), `reply-checklist` (a checklist), `answer-quality` (a formula over other measures), `short-and-grounded` (a script). Each has examples; **Metrics** checks them. |

The AI reviewer and the model of these files is **Offline demo model (examples)**, a second offline model whose rules answer exactly these prompts (AI quality ▸ Models and keys). Point `model:` or `judge:` at a real provider to see how a real model does.

:::

## The offline demo model

AI examples use **Offline demo model**, a deterministic stand-in that runs inside TestPion. It classifies the example intents, refuses the prompt injection, answers the RAG question and calls the Petstore MCP tool. It is set up in **AI quality ▸ Models and keys**, with rules (regular expression → reply or tool call) in its `x-mock-rules` header. So evaluations, safety tests and the agent test run without an API key and give the same result every time.

To try a real model, add an API key to **OpenAI**, **Anthropic** or **Google Gemini** under **AI quality ▸ Models and keys**, or start Ollama locally. Then pick that provider in AI quality, or change `provider:` in a test file.

## From the terminal

The same workspace is in the repository at `examples/public-workspace`, so the CLI and AI agents can use it too:

```bash
testpion run -w examples/public-workspace --suite all      # everything (needs internet)
testpion run -w examples/public-workspace --suite offline  # no internet needed
testpion run -w examples/public-workspace --suite learn    # Learn by example (offline)
testpion eval run "Learn: handbook bot (bot)" -w examples/public-workspace   # the bot with sources, with its report
testpion run-collection "HTTP basics (httpbin)" -w examples/public-workspace -e "Public APIs"
testpion grpc grpcb.in:9000 hello.HelloService/SayHello -d '{"greeting":"hi"}'
testpion run-collection "Public REST APIs (playground)" -w examples/public-workspace -e "Public APIs"
testpion mcp --url https://petstore.run.mcp.com.ai/mcp
testpion mcp -- npx -y @modelcontextprotocol/server-everything
```

::: warning Public services
These are free services run by other people. They can be slow, rate-limited (the GitHub API allows 60 requests an hour without a token), or down for a while, and shared ones such as the Petstore change as other people use them. A failure in the examples is not always a TestPion problem. For tests that must be stable, use your own API or a [mock server](/api-testing/mock-servers).
:::
