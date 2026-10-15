---
title: "Your first AI test"
description: "Run a prompt, validate structured output and save it as a repeatable LLM test."
---

::: v-pre

# Your first AI test

1. Open **AI Lab → Providers** and add a provider. With the demo servers running, use *OpenAI-compatible* at `http://127.0.0.1:4012/v1`. The built-in **Mock** provider works fully offline.
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

:::
