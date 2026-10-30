---
title: "Check an AI agent in 5 minutes"
description: "Test an AI agent that uses tools with no key: run the offline task agent, see every step it took, mark a run you trust as the baseline, and learn when its tools change."
---

# Check an AI agent in 5 minutes

::: tip In short
An agent is an AI that uses tools. You will run a ready-made offline agent, see each step it took, and learn how to be told when it starts using other tools. **About 5 minutes. No key.**
:::

## What goes wrong with agents

An agent can give a good-looking answer and still do the wrong thing on the way: call a tool it should not, skip one it should, or call the right tool with the wrong input. Checking only the final answer misses all of that. TestPion checks the **tools the agent used**.

## 1. Run the offline agent

1. Open **AI quality** in the left bar, then the **Checks** tab.
2. In the list, open **Learn: task agent (agent)** (in the folder **Learn by example** of the Examples workspace).
3. Click **Run**.

The agent is the built-in offline demo model with a small task list as its tools. Three questions are asked. Each question lists the tools the agent **should call** and the tools it **should not call**.

## 2. Read the result

The result shows how many questions passed. A failed question says which check failed, for example *should not call delete_task*.

## 3. See every step

On a failed question, click **Show the steps**. You see:

- the question,
- each time the model was called and what it asked for,
- each tool call, with its input and what it returned (an error shows in red),
- the final answer.

The checks about tools are pinned to the step that decided them. A green mark sits on the call that was right. A red mark sits on a call that should not have happened. A grey mark at the end means a tool was **never called**, which is good for a tool that is forbidden.

## 4. Mark a run you trust

When a run looks right, click **Mark this run as the baseline**. From now on, every new run says how the tools differ from that run, for each question:

- *Same tools in the same order.*
- *Dropped one tool and added another.*
- *Same tools in another order.*
- *Same tools, but one was called with other input.*

This tells you when an agent changes how it works, even if its answers still look fine. For example, after you switch to a new model.

## 5. Try a different prompt safely

Open **Prompt versions** above the instructions. **Save as version** keeps the wording you have. Change it, run again, and compare the results of each version side by side. **Make current** asks first if a version did worse than the one in use.

## Test your own agent

Click **An agent uses tools** on the AI quality **Start** tab. A short wizard asks for the tools, your questions, and which tools each question should or should not call. Tools can be fake ones that return a fixed answer, or real ones from an MCP server.

## Next

- [Agent testing in detail](/ai-testing/agents): every check, with the YAML.
- [Safety testing](/ai-testing/safety): check that an agent refuses harmful requests.
- [Test a bot that answers from documents](/getting-started/check-a-rag-bot): the same idea for chatbots with sources.
- [Glossary](/getting-started/glossary): words you may not know.
