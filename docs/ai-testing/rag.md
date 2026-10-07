---
title: "RAG evaluation"
description: "Evaluate retrieval-augmented generation: context precision and recall, entity recall, groundedness (faithfulness), answer correctness and relevance, citations, judged claim by claim."
---

::: v-pre

# RAG testing

```yaml
name: Clinic opening hours
type: rag
question: What time does the clinic open on weekdays?
contexts:
  - { id: doc-1, text: "Happy Paws Clinic opens at 8am…", score: 0.92 }
  - { id: doc-2, text: "Parking is available…", score: 0.41 }
expected: The clinic opens at 8am on weekdays.
model: { provider: openai, name: my-model }   # or `answer:` with your system's answer
```

| Metric | What it measures | Without a judge | With `judge:` |
|---|---|---|---|
| `context-precision` | Are the useful documents ranked first? (rank-aware average precision) | word overlap with the question and expected answer | a verdict per document |
| `context-recall` | Does the retrieved context hold what the expected answer needs? | expected-answer sentences covered | a verdict per statement of the expected answer |
| `context-entity-recall` | The expected answer's names, numbers and dates found in the context (or list them in `entities:`). Default threshold 0.8. | deterministic | — |
| `groundedness` (aliases `faithfulness`, `hallucination`) | Is every claim of the answer supported by the context? Reports `hallucinationIndicator`. | answer sentences covered | the answer split into claims, a verdict and the evidence per claim |
| `answer-correctness` | The answer's facts against the expected answer: F1 of precision (the answer's claims the reference supports) and recall (the reference's claims the answer makes); `mode: precision \| recall \| f1`. Default threshold 0.7. | sentence overlap | claim by claim, both ways (two judge calls; one with `mode: precision`) |
| `answer-relevance` | Does the answer address the question? | word overlap | a 0–1 score with reasoning |
| `citation` | `[id]` citations must refer to retrieved documents. | deterministic | — |

## Judged claim by claim

With a `judge:`, the RAG checks do not ask the model for one number. The judge splits the answer (or the expected
answer, or the retrieved documents) into items and gives each a verdict with its evidence, a quote or a document id.
TestPion computes the score from those verdicts, so every score can be followed back to the claims behind it.

```yaml
evaluators:
  - type: faithfulness
    judge: { provider: openai, name: gpt-4o-mini }
  - type: answer-correctness
    judge: { provider: openai, name: gpt-4o-mini }
    threshold: 0.6
  - type: context-entity-recall      # no model needed
```

In the results, each check lists what is **still to verify** (unsupported claims, missing facts, documents judged not
useful) before what was **demonstrated**, with the evidence. A failing check opens the list. The list is in
`metadata.items` of the check result (`{ text, ok, evidence }`), in the JSON report and over MCP, so an agent can
read it too. A judge is a model: read the evidence before acting on a verdict. The judge's provider, model, prompt
version and config hash are stored with the result for reproducibility.

The result stores the query, document IDs, scores, model, prompt hash, answer and evaluation, as required by §15.

:::
