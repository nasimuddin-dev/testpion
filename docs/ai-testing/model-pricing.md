---
title: "Model pricing"
description: "Where the cost of an AI call comes from: the prices you enter in Settings, how a price matches a model, and what the estimates and the daily limit use."
---

# Model pricing

TestPion shows what an AI call costs before it is sent (the estimate) and after (the real tokens). The dollar amount comes from **Settings ▸ Model pricing**. **No prices are built in**: providers change them, so you enter the ones you pay.

## Add a price

1. Open **Settings ▸ Model pricing** and choose **Add price**. (In AI Lab, **Set a price…** on a model that has none adds the row with that model filled in.)
2. Fill the row: the **provider**, the **model**, the price per **million input tokens**, the price per **million output tokens**, and a **version**, the date you read the price.
3. **Save settings**.

```
provider   model          input / M   output / M   version
anthropic  claude-sonnet* 3.00        15.00        2026-10-01
openai     gpt-4o-mini    0.15        0.60         2026-10-01
```

Estimated cost = input tokens × input price + output tokens × output price.

## How a price finds its model

- The **provider** is `*` (any), or a provider's id, name or kind (`anthropic`, `openai`, `ollama` …).
- The **model** is its name, or a pattern with `*` (`gpt-4o*`, or `*` for every model).
- When several rows match, the **most specific model** wins (the one with the most letters before its `*`).
- A price for `gpt-4o-mini` also applies to its dated snapshots (`gpt-4o-mini-2024-07-18`, `claude-sonnet-20250101`) when no row names the snapshot.
- A model with no matching row says **no price set** in its estimate; its tokens are still counted.

## What uses it

- The **estimate** in the "Ready to send" step of every AI action, including the response bar's Explain, Generate tests and Suggest checks.
- The **cost** shown with an answer, in AI Lab, evaluations and run reports. Each cost keeps the **version** of the price it used, so a price you change later does not rewrite what earlier calls cost.
- The AI limits: the daily cost limit, and the per-call `max_cost_usd` of MCP tools and RAG runs.

## From a terminal

The price table is part of the settings. `testpion settings get --json` tells how many rows there are, but the table itself is not in the exported settings file, so keep your price list where you keep your team's notes.

## See also

- [AI features](/ai-testing/ai-features): the estimate and the review step.
- [Safety](/ai-testing/safety): limits and what is sent to a model.
- [Evaluations](/ai-testing/evaluations): cost per case and per run.
