---
title: "Check an AI answer in 5 minutes"
description: "Test a prompt or chatbot on many cases and see how many pass: the sample with no key, the 3-step wizard, test cases written by AI, and a check that you can trust."
---

::: v-pre

# Check an AI answer in 5 minutes

You have a prompt or a chatbot and want to know whether its answers are right, on more than the one case you tried by hand. This page takes you from nothing to "17 of 20 passed" with no key, then to your own prompt. The words used here are in the [glossary](/ai-testing/glossary).

## 1. See a result first (about 1 minute, no key)

Open **AI quality**. It opens on **Start**: "What do you want to check?". Press **Try the sample (offline)**.

TestPion adds the offline demo model, makes the evaluation *Sample: support intents* (ten customer messages to sort into cancellation, refill, booking or other), runs it and shows **10 of 10 passed**. The demo model answers by rules, so the result says how a run looks and nothing about a real model; the result is labelled **Offline demo**. Nothing leaves your computer.

## 2. Check your own prompt (about 3 minutes)

On **Start**, press **Start** on **Answers are correct**. A wizard with three steps opens; the cost of the run is under every step.

1. **What are you testing?** Name the evaluation, write the prompt with `{{variables}}` where each case puts its text, and choose the model. With no model connected the offline demo model is used and every result says so; **Connect a real model** is one click away.
2. **Your cases.** One row per case: the input and the expected answer. Type in the cells, **Paste cases…** from a spreadsheet (or a CSV file, JSONL lines or a JSON list), **Load file…**, or press **Generate with AI…** to have cases written for you (below). 5 to 20 cases are enough to start. Add the cases that went wrong before.
3. **What is a good answer?** Tick what applies, each with one sentence: matches the expected answer exactly, contains a word or phrase, matches a pattern, is valid JSON, has a similar meaning, or is graded by an AI reviewer. Press **Try on case 1** to see a check on one case: the reply, passed or failed, and why.

**Run N cases** saves the evaluation (the same file the full editor makes; **Open the full editor** takes your draft there at any step) and runs it. From the card to a running evaluation on pasted cases takes six clicks. The report starts with the answer: **17 of 20 passed**, the failures first.

## 3. Let AI write the cases (optional)

**Generate with AI…** (on the Test cases tab, and in step 2 of the wizard) writes cases from:

- **The prompt**: typical cases and tricky ones for the prompt you are testing.
- **An API definition**: questions a user could ask about the operations of an OpenAPI file; the expected answer is the operation.
- **Saved requests**: requests a user could make, from a collection or folder; the expected answer is the saved request.
- **Documents**: questions with expected answers from your files, each checked against the passage it came from.
- **Real calls in History**: cases based on prompts you sent before, with names and numbers removed.

Before anything is sent you see the estimate and **What will be sent…**. Each case is then verified (it fills every variable of the prompt, it is not a repeat, it names something the source has) and shown in a review with its checks; a case that failed a check is unticked. Nothing is added until you press **Add to test cases**, and **Undo** takes it back. With no model set up, **Use the offline demo model** writes a few cases so you can try it.

From a terminal: `testpion eval generate-cases "My evaluation" --from prompt --count 10`; agents: `eval_generate_cases`.

## 4. Can you trust the AI reviewer? (optional)

When a check is **graded by an AI reviewer**, a second model reads each reply and grades it by a rule you write. The Checks tab then has **Trust the AI reviewer**: after a run, grade ten answers yourself (good or bad; the reviewer's verdict stays hidden), and the card says how often it agreed: "The AI reviewer agreed with you on 8 of 10 answers (80 %). It failed 2 that you passed (too strict)", with the answers where you differ. Below about 70 % agreement, reword the rule or use a stronger model before relying on its grades. From a terminal: `testpion eval trust last`; agents: `eval_trust_reviewer`.

## Next

- Put the evaluation in CI so a change that makes answers worse stops the build: [Evaluations](/ai-testing/evaluations#the-result-and-run-in-ci).
- Prefer a text file? [Your first AI test file](/getting-started/first-ai-test) saves a prompt from the Playground as a YAML test.
- A bot that answers from your documents: [RAG bots](/ai-testing/rag).
- Privacy, cost and review of TestPion's own AI: [AI features](/ai-testing/ai-features).

:::
