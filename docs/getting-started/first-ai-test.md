---
title: "Your first AI test"
description: "Run a prompt, validate structured output and save it as a repeatable LLM test."
---

::: v-pre

# Your first AI test

1. Open **AI Lab → Providers** (AI Lab is under the rail's **More…**) and add a provider. With the demo servers running, use *OpenAI-compatible* at `http://127.0.0.1:4012/v1`. The built-in **Mock** provider works fully offline.
2. In **Playground**, write a template with variables, such as `Classify: {{message}}`, and fill in the variable.
3. Choose **Structured output → JSON mode** and press **Run**. Latency, time to first token, tokens and estimated cost appear above the output.
4. Add evaluators (for example `exact-match $.intent = cancellation`) and click **Save as test…**. The test is written as YAML under `tests/ai/`:

```yaml
name: Customer Intent Classification
type: llm
model: { provider: openai, name: my-model, temperature: 0 }
input: { message: "I need to cancel my appointment" }
prompt: |
  Classify the customer intent as JSON {"intent": "..."}.
  {{message}}
responseFormat: { type: json }
evaluators:
  - type: json-schema
  - type: exact-match
    path: $.intent
    expected: cancellation
limits:
  latency_ms: 3000
```

Run it with `testpion test tests/ai`.

This page tests *your* LLM prompts. To have TestPion's own AI write checks, tp tests or an integration flow for your API (reviewed before anything is saved), see [AI features: privacy, cost and review](/ai-testing/ai-features) and [Let AI write the flow](/test-runner/integration-testing#let-ai-write-the-flow).

:::
