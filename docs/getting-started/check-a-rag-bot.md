---
title: "Test a bot that answers from documents in 5 minutes"
description: "Try a RAG bot test with no key and no server: run the offline sample, read the two goals and why answers failed, open one answer by stage, then connect your own bot."
---

# Test a bot that answers from documents in 5 minutes

::: tip In short
A RAG bot looks up documents before it answers. You will run a ready-made offline bot, see if its answers are backed by the right documents, and learn how to connect your own. **About 5 minutes. No key, no server.**
:::

## Why test this kind of bot

A bot can fail in two different ways. It can **find the wrong documents**, or it can **say something no document supports**. A single "right or wrong" mark hides which one happened. TestPion checks both and tells you which.

## 1. Run the offline sample

1. Click **RAG bots** in the left bar. It opens on the **Start** tab.
2. Click **Try the sample (offline)**.

TestPion makes a small bot (an offline clinic helper), six questions with their right documents, and a check. It runs everything and opens the result. Nothing leaves your computer.

## 2. Read the result

The result starts with the two goals:

- **Backed by the sources** shows how many answers say only what the found documents say.
- **Right documents found** shows how many questions found the documents they needed.

Under them, **Why the failed cases failed** lists the reasons in plain words, for example *claim not backed by the sources* and *right document not found*. Click a reason to see only those cases.

The sample has two failures on purpose, one of each kind, so you can see both.

## 3. Open one answer

Open the **Checks** tab, switch to **Metrics**, and click any cell. The answer opens in four stages:

1. **Question**: what was asked.
2. **Retrieved**: which documents the bot found, and which right ones it missed.
3. **Used**: which statements of the answer the documents back.
4. **Answer**: what the checks decided.

The first stage that went wrong says **start here**. Fix the retrieval before you blame the answer.

## 4. Read some answers yourself

On the result, click **Review answers**. Press <kbd>G</kbd> for good or <kbd>B</kbd> for bad. What the checks decided stays hidden until you grade, so your own reading counts. At the end you see how often the checks agreed with you.

## 5. Connect your own bot

1. Open the **Bots** tab and click **Connect a bot**.
2. Enter how to call your bot: a web address and a body with the question in it. HTTP, streams, WebSocket, gRPC and MCP tools all work.
3. Click **Probe**. TestPion asks one question and shows the answer it got.
4. TestPion says what the answer looks like, for example *Looks like LlamaIndex*. Click **Use this mapping**. If it does not know the shape, click the answer and the documents yourself.
5. Save the bot. Add questions in **Questions**, then run them from **Checks**.

Answers are judged by an AI reviewer that you choose in the evaluation. The offline sample uses a built-in demo reviewer, so it needs no key.

## Next

- [RAG in detail](/ai-testing/rag): every setting and the command line.
- [RAG metrics](/ai-testing/rag-metrics): all the checks and what each one measures.
- [Check an agent in 5 minutes](/getting-started/check-an-agent): the same idea for AI that uses tools.
- [Glossary](/getting-started/glossary): words you may not know.
