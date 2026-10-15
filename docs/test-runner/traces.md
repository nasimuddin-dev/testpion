---
title: "Traces and OpenTelemetry"
description: "Every request, test, MCP call and LLM call becomes a trace. See it as a waterfall, and send traces to Jaeger, Grafana Tempo, Honeycomb or any OpenTelemetry collector."
---

::: v-pre

# Traces and OpenTelemetry

Every request, GraphQL operation, gRPC call, MCP call, LLM call, tool call, script and evaluation becomes a span in an OpenTelemetry-shaped trace (32-hex trace ids, 16-hex span ids, parent spans, attributes and status). The **Traces** view lists them, newest first, and shows the selected trace as a waterfall with each span's input, output and attributes. Secret values are redacted before a trace is written. Filter the list by text or kind, or tick **Errors** for the traces that ended in an error. An HTTP or GraphQL request's span has its phases as children: DNS lookup, TCP connect and TLS handshake (lighter, on a new connection), waiting for the first byte, and download (green).

A trace's header names the request it came from and its **History** entry (or its run), and a click opens them; a trace's right-click menu (the same as its ⋯) has **Open**, the run it belongs to and **Copy link**. A Console line links to its trace the same way. See [Finding your way around](/getting-started/finding-your-way#console-traces-and-history).

Test runs keep the traces of failing tests (`--trace failures`, the default); `--trace all` keeps every test's trace and `--trace none` none.

## Send traces to OpenTelemetry

TestPion exports traces as **OTLP/HTTP JSON** to any OpenTelemetry-compatible backend: an OpenTelemetry Collector, Jaeger, Grafana Tempo, Honeycomb, Datadog, New Relic and others. Spans keep their ids, parents and timings; attributes stay attributes; inputs and outputs are added as `testpion.input` / `testpion.output` (redacted, at most 4 KB each); the resource is `service.name = testpion` with the run's id and name.

### From the CLI (CI pipelines)

Give the collector with `--otlp`, or set the standard OpenTelemetry variables, and the traces of `testpion test`, `testpion run` and `testpion run-collection` are sent during the run:

```bash
# a local collector or Jaeger (OTLP/HTTP listens on 4318)
testpion test tests/ --trace all --otlp http://localhost:4318

# the standard variables work too, e.g. for Honeycomb
export OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
export OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=$HONEYCOMB_API_KEY"
testpion run-collection "Veterinary API" --trace all
```

`--otlp-header key:value` adds headers (for example an API key). `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (a full URL) and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` are honoured as well. If the collector can't be reached, the run prints a warning and its result doesn't change.

To try it locally, run Jaeger and open its UI on port 16686:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
```

### From the app

In the **Traces** view, the send button next to Refresh opens **Send to OpenTelemetry**: enter the collector URL and headers, then send the selected trace or all the traces shown (filter first to narrow them down). Put an API key in a [secret variable](../api-testing/environments.md#secrets) and use it as `{{honeycombKey}}`: only variable references are remembered, never a typed-in key.

### For AI agents

The `export_traces` MCP tool sends the newest traces (optionally of one kind) to a collector.

:::
