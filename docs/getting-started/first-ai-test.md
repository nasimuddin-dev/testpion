---
title: "Your first AI test file"
description: "Run a prompt in the Playground, validate structured output and save it as a repeatable LLM test file."
---

# Your first AI test file

::: tip In short
Write one prompt in the Playground and save it as a test file you can run again. About 10 minutes. The built-in Mock provider works with no key.
:::

::: v-pre

Starting out? Begin with [Check an AI answer in 5 minutes](/getting-started/check-an-ai-answer): the sample with no key, the 3-step wizard and test cases written by AI. This page is the other way in: one prompt in the Playground, saved as a test file you can run from a terminal. The steps below use your own model.

1. Open **AI quality → Providers** (AI quality is on the rail) and add a provider. With the demo servers running, use *OpenAI-compatible* at `http://127.0.0.1:4012/v1`. The built-in **Mock** provider works fully offline.
2. In **Playground**, write a template with variables, such as `Classify: {{message}}`, and fill in the variable.
3. Choose **Structured output → JSON mode** and press **Run**. Latency, time to first token, tokens and estimated cost appear above the output.
4. Add checks (for example `exact-match $.intent = cancellation`) and click **Save as test…**. The test is written as YAML under `tests/ai/`:

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

## Next

- [Check an AI answer in 5 minutes](/getting-started/check-an-ai-answer): scores many answers at once.
- [Evaluations](/ai-testing/evaluations): all the checks you can use.
- [Run tests in CI](/test-runner/ci-cd): run this test on every change.

:::
