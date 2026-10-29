---
title: "Glossary: the words of AI testing"
description: "The plain words TestPion uses for AI testing: checks, test cases, AI reviewer, bot with sources and the rest, each with one sentence."
---

# Glossary: the words of AI testing

The screens, the command line and the docs use these words, and only these. Each has one sentence.

| Word | What it means |
|---|---|
| **Check** | Decides whether one answer is good. An evaluation has one or more. |
| **Test case** | One input and, if you have one, the answer you expect. An evaluation runs on many. Also called a row of the table. |
| **Expected answer** | The answer a correct reply gives: a column of the test cases. |
| **Evaluation** | A prompt or chatbot, a model, its test cases and its checks, saved to run again. |
| **Prompt or chatbot** | An evaluation of a prompt you write, or of a chatbot you call. |
| **Bot with sources** | A bot that answers from your documents (a retrieval-augmented generation system). **My bot** is the one an evaluation calls. |
| **AI reviewer** | A second AI model that reads each answer and grades it by your rule. Its grades come from a model, so they are labelled as such. |
| **Grading rule** | The plain sentence you write for an AI reviewer: "The reply is polite and does not promise a refund." |
| **Answer backed by sources** | Every claim in the answer is supported by the documents the bot found (what the research calls faithfulness or groundedness). |
| **Answers the question** | The answer is about what was asked. |
| **Found the right documents** | The documents the bot found include the ones that hold the answer (checked by document id). **Found only useful documents** is the same idea for noise. |
| **Words in common with the expected answer** | A check that counts the words the reply and the expected answer share (token F1). **Wording close to expected answer** also looks at the order of the words. |
| **Similar meaning** | Close in meaning to the expected answer, even if the words differ. |
| **Same as the saved answer** | The reply equals the answer saved last time (a snapshot). |
| **Randomness** | How much the model varies its answers; 0 gives the same answer every time. |
| **Run at once** | How many cases are sent to the model together. |
| **Try again on errors** | How many times a failed call is repeated. |
| **Only the first … cases** | Run a part of the cases, for a quick look. |
| **Spend cap** | The most a run may cost; it stops there. |
| **Compare runs** | A table of runs side by side, case by case (a matrix), against a **run to compare against** (a baseline). |
| **Last good run** | The last run of an evaluation that passed; the next run is measured against it. |
| **Offline demo model** | A model that answers by rules, with no key and no network, for trying things out. It says nothing about a real model. |
| **Models and keys** | Where you connect the models your prompts run on. |
| **Try a prompt** | The Playground: one prompt, one case at a time. |
| **Compare models** | One input sent to several models in one table. |
| **Not reviewed** | Results nobody has marked good or bad yet (hidden until one is). |
| **Proposal** | What an AI feature suggests: shown with the checks that were run on it and added only when you accept. |

See also [Check an AI answer in 5 minutes](/getting-started/check-an-ai-answer) and [Evaluations](/ai-testing/evaluations).
