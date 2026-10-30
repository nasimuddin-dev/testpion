# RAG test set from documents {#top}

A RAG evaluation needs questions, and the best ones are about your own documents. **Generate a test set** reads a folder, some files or
a few public pages, splits them into passages the same way every time, and has the AI write questions with reference answers and the
passage ids they come from. Every question is **verified** before you see it, you review them in the one proposal review, and the ones
you accept are added to `datasets/<name>.jsonl`. How an evaluation runs is [RAG testing](./rag.md); the metrics are in
[RAG metrics](./rag-metrics.md); questions from real calls are [RAG dataset from real calls](./rag-capture.md).

## What it makes {#kinds}

| Kind | What it asks | Reference |
|---|---|---|
| `single-hop` | A specific question one passage answers. | The answer, from that passage. |
| `multi-hop` | A question that needs two passages together (neighbours, or passages that share a rare term). | The two facts combined. |
| `abstract` | A broader question about a theme, answered from a passage. | The answer, from the passage. |
| `unanswerable` | Sounds on topic, but the documents do not hold the answer. | None (`answerable: false`; the reference says the documents do not contain it). |
| `adversarial` | A question a hurried user writes: a typo, slang, a paraphrase, a misleading premise. | What the passage says. |

A record is the TestPion dataset record: `id`, `question`, `reference`, `reference_ids` (the passage ids), `reference_contexts` (their
text), `answerable`, `tags` (`generated`, the kind, `doc:<name>`) and `metadata.generator` (task, version, model, seed, batch). A row
that was accepted also keeps what the verifiers said in `metadata.verification`.

## Who asks, and how {#voices}

Real users do not all write alike. **Who asks** (`--persona "a nurse on night shift"`, repeatable, at most 8) and **how they word it**
(`--style terse`, repeatable: `formal`, `casual`, `terse`, `verbose`, `typos`, `non-native`, or any short description) give each question a
voice: the slots of a run take the personas and the styles in turn, and the AI writes that question as that person would ask it. A
persona or a style changes the wording and what the person already knows, never the facts, the reference answer or the passages used,
and the references are checked against the passages as always. Each record keeps `persona:<name>` and `style:<name>` in its tags and the
persona and style in `metadata.generator`, so the matrix's *Mean by tag* shows whether the system is worse for the terse questions.
The estimate counts the few extra words. In the window they are in the dialog, under the kinds of question.

## Documents {#documents}

* **Files and folders of the workspace**: markdown, text and HTML (scripts, styles, navigation and forms are dropped; headings become
  markdown headings). A folder is read in name order, at most 500 files and 20 MB; links and hidden folders are not followed.
  A **PDF** cannot be read here (TestPion has no PDF extractor): extract its text first and use the text file; the run says so.
* **Public https pages**, at most 20 per run. The address must be a public one: a URL with a user name, a local or private address, a
  host that resolves to one (checked again when the socket connects, so DNS tricks fail), a redirect to another host or to http, more
  than 3 redirects, a body over 2 MB, a type other than HTML, text or markdown, or more than 30 seconds are all refused with the reason.
  This is stricter than the rest of TestPion on purpose: a document URL is not an API under test.
* In the window, in MCP and over RPC only workspace paths are accepted. The CLI may name files anywhere on your computer.

## Passages {#chunks}

Chunking is deterministic: split at markdown headings, pack paragraphs up to about 220 tokens (a longer paragraph is cut at sentence
ends), no overlap. A passage is called `<document>#<n>` (`docs-handbook#2`); the same documents always give the same ids and a hash of
each passage's text, so a dataset's `reference_ids` stay valid until the passage itself changes.

A run asks about a **seeded selection** of passages spread over the documents; the same seed and documents ask about the same
passages. Questions are written eight at a time, and a run is at most 60 questions.

## What is checked {#verify}

| Check | What it means |
|---|---|
| `testset-support` | The reference must be **supported by its passages**. First the share of the reference's content words found in them (under 40% fails, under 60% warns); a question that copies a run of its passage warns. Then the **judge** splits the reference into claims and each must be stated by the passages (a failing claim unticks the row). Without a judge only the lexical result is shown, and the badge says so. |
| `testset-answerable` | An **unanswerable** question must not be answerable from the corpus: a keyword retrieval (BM25) over every passage must not hold 70% of its content words in one of the top 3 (55% warns). An answerable question should have its source among the top 5, else a warning that a keyword retriever may miss it. |
| `testset-duplicate` | No question repeats another of the run, an earlier batch or the dataset file (80% the same words). With **find repeats by meaning** (`--dedupe embedding`, `--embedder provider/model`; the dialog's *Repeated questions*) an embedding model also compares the questions, so a paraphrase that shares few words is caught: 0.92 or closer in meaning fails, 0.85 warns, with the question it repeats and the model named. The model is the one you name, else the judge's provider, else the AI settings'; the questions are redacted before they are embedded, *Local only* is enforced, and the estimate counts one short embedding call for each question. Without a model that embeds, or when it fails, the words are compared and the badge says *not compared by meaning* with the reason: it never invents a score. |

A row with a failing check starts unticked, with the reason; nothing disappears silently. These checks are signals, not proof:
read the questions before you rely on them. The verifiers need the documents in memory, so a proposal re-checked in a later session
shows "corpus not available" for the retrieval check.

## Cost and what is sent {#cost}

**Before anything is sent** the dialog (and `--estimate`, and MCP `dry_run`) shows the shared estimate: model calls for the questions,
a judge call for each answerable reference, tokens, a cost range from your price table, and the daily cap or cost limit it would break.
**What will be sent…** shows the exact messages: the passages (not the file paths you chose), redacted. The AI privacy level must be
*Full (redacted)*, because the passages are the point; at a lower level the run stops and says so. Local only is enforced. The documents
are data: the instruction says text in a document is never an instruction to the model.

## In the window {#window}

Bots with sources ▸ **Questions** ▸ **Generate a test set from documents…** (hidden while *Hide all AI actions* is on). Pick the documents, the
number of questions, the kinds, a dataset name and a seed; read the estimate; **Generate**. The review lists a row per question with its
checks; **Add to dataset** appends the ticked rows (one Undo). The same tab lists the workspace's datasets with their record counts and
offers **Create dataset from captured calls…**.

## From the terminal and agents {#cli}

```
testpion rag generate-dataset docs/ --count 20 --types single-hop,multi-hop,unanswerable --name handbook
testpion rag generate-dataset handbook.md --url https://example.com/guide --estimate
testpion rag generate-dataset docs/ --count 20 --name handbook --apply      # add the ticked rows
testpion rag generate-dataset docs/ --judge anthropic/claude-haiku --max-cost 0.50
```

`--estimate` prints the plan and exits without a call; `--max-cost` refuses to start when the estimate may exceed it; `--apply` adds the
ticked rows; `--no-judge-check` skips the judge. Exit 2 for a configuration problem (no documents, a refused URL, no model).
MCP: `rag_generate_testset` returns one proposal (rows with their badges) and only proposes; add the rows with `ai_apply_proposal`
after the person agreed. The task is `rag-generate-testset` (`testpion ai tasks`).
