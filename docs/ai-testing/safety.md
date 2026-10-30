---
title: "AI safety and guardrail testing"
description: "Test prompt injection, data leakage and tool misuse with configurable validators."
---

# Safety testing

::: tip In short
Check that an AI refuses harmful requests and does not leak secrets. These are building blocks for your own safety rules, not a guarantee.
:::

::: v-pre

These are building blocks for **your own** safety policies. The tool does not claim that any system is universally safe.

- **Prompt injection:** direct, indirect, retrieved-document and tool-result injection cases, checked with `refusal`, `not-contains` or `no-leak`.
- **Data leakage:** `no-leak` detects API keys, AWS keys, bearer tokens, JWTs, private keys, SSNs and card numbers, plus any canary `values` and custom regex `patterns` you add. It is heuristic.
- **Tool misuse:** `tool-not-called`, `allowed-tools`, `max-tool-calls`, `tool-args-valid`.
- **Output safety:** combine `regex`, `not-contains`, `json-schema` and `llm-judge` criteria that reflect your policy.

See `examples/veterinary-workspace/tests/safety/`.

:::
