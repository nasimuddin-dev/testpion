---
title: "Prompt templates"
description: "Prompt templates with variables, system prompts, structured output and saving prompts as tests."
---

# Prompts

::: tip In short
A prompt is the text you send to an AI model. Use templates with variables, ask for JSON, and compare models side by side in the Playground.
:::

::: v-pre

Templates use `{{variable}}` placeholders, and the Playground builds an input form from the variables it finds. The system prompt is templated too.

**Structured output:**

- **JSON mode:** OpenAI `json_object`, Gemini `responseMimeType`, or an instruction for Anthropic.
- **JSON Schema:** OpenAI `json_schema` or Gemini `responseJsonSchema`. The response is always validated locally with Ajv.

In YAML tests, `limits: { latency_ms, tokens, output_tokens, cost }` become checks automatically. If a test sets `expected` but no evaluators, an exact-match or equals check is added.

:::
