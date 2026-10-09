---
title: "Examples workspace"
description: "The TestPion Examples workspace: ready-to-run requests and tests for REST, SOAP, GraphQL, gRPC, WebSocket, MQTT, SSE, MCP and AI against free public APIs."
---

# Examples workspace

TestPion comes with a **TestPion Examples** workspace. It opens the first time you start the app, and you can open it again at any time from **Help ▸ Open Examples Workspace** or the link on the Home page. Everything in it works against free public services, with nothing to install or configure. Select the **Public APIs** environment (it is selected for you) and press **Send**.

The workspace is copied into your data folder once. You can change it freely: app updates never overwrite your copy.

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
| AI prompts: JSON output, summaries, a prompt injection | AI Lab ▸ **Saved prompts** | the offline demo model |
| Evaluation over a dataset, safety, RAG, an agent that calls MCP tools | Tests ▸ `ai/`, `agent/` | the offline demo model (+ Petstore MCP for the agent) |
| Test suites | Tests ▸ **All examples** (everything) and **Offline** (no internet needed) | |
| Monitor (paused) | Monitors ▸ **Public APIs health** | httpbin.org |
| Traces | Traces view: every request, MCP call, model call and test run adds one | |

## The offline demo model

AI examples use **Offline demo model**, a deterministic stand-in that runs inside TestPion. It classifies the example intents, refuses the prompt injection, answers the RAG question and calls the Petstore MCP tool. It is set up in **Settings ▸ Providers**, with rules (regular expression → reply or tool call) in its `x-mock-rules` header. So evaluations, safety tests and the agent test run without an API key and give the same result every time.

To try a real model, add an API key to **OpenAI**, **Anthropic** or **Google Gemini** under **Settings ▸ Providers**, or start Ollama locally. Then pick that provider in AI Lab, or change `provider:` in a test file.

## From the terminal

The same workspace is in the repository at `examples/public-workspace`, so the CLI and AI agents can use it too:

```bash
testpion run -w examples/public-workspace --suite all      # everything (needs internet)
testpion run -w examples/public-workspace --suite offline  # no internet needed
testpion run-collection "HTTP basics (httpbin)" -w examples/public-workspace -e "Public APIs"
testpion grpc grpcb.in:9000 hello.HelloService/SayHello -d '{"greeting":"hi"}'
testpion run-collection "Public REST APIs (playground)" -w examples/public-workspace -e "Public APIs"
testpion mcp --url https://petstore.run.mcp.com.ai/mcp
testpion mcp -- npx -y @modelcontextprotocol/server-everything
```

::: warning Public services
These are free services run by other people. They can be slow, rate-limited (the GitHub API allows 60 requests an hour without a token), or down for a while, and shared ones such as the Petstore change as other people use them. A failure in the examples is not always a TestPion problem. For tests that must be stable, use your own API or a [mock server](/api-testing/mock-servers).
:::
