# Draft an evaluation with AI {#top}

Choosing what to measure is the hard part of testing a RAG system: which of the 138 [metrics](./rag-metrics.md), with which pass
marks, judged by which model, on how many questions, and what should fail a build. **Draft an evaluation with AI** reads your RAG
target and your dataset, proposes a complete evaluation, **drops what cannot run on your data**, dry-runs the rest on a few samples
without sending anything to a judge, and offers it for review. Nothing is saved until you accept. Running an evaluation is
[RAG testing](./rag.md).

## Draft one {#draft}

**Evaluations**, type RAG, with a RAG target chosen: below the target, **What do you want to find out?** (optional: "answers come
from the handbook and never invent a dose") and a **Dataset** of the workspace's `datasets/` folder. Beside the button TestPion says
how many metrics your data can support ("52 of 138 metrics can run on clinic.jsonl (200 records)"): the others lack an input such as
gold chunk ids or a reference answer, and their names and what they miss are in its tooltip.

Press **Draft an evaluation with AI**. Hovering it shows the model, the estimate and what stays on this computer; **What will be
sent…** shows the exact payload. The proposal opens in the same review as every AI proposal.

From the command line:

```bash
testpion rag author --target "Clinic RAG" --dataset clinic.jsonl --goal "answers come from the handbook" --estimate   # what would be sent
testpion rag author --target "Clinic RAG" --dataset clinic.jsonl --goal "answers come from the handbook"             # draft and show
testpion rag author --target "Clinic RAG" --dataset clinic.jsonl --name "Clinic nightly" --apply                     # save it
```

Options: `--docs <paths…>` (documents or folders: their titles and headings are shown to the model, never their text), `--spec <file>`
(an API definition under `specs/`: its operations are shown), `--judge <provider/model>` (your choice of judge wins over the model's),
`--slice-file <name>` (also write the records the evaluation runs to `datasets/<name>.jsonl`), `--provider` / `--model` (the model that drafts), `--json`. An agent uses the MCP tool `rag_author_evaluation` and applies the
proposal with `ai_apply_proposal` after you agree.

## What is sent to the model {#sent}

* **The target by what it reads**: its name, protocol, whether the mapping reads an answer, contexts, context ids and scores. Never
  its request: not the URL, headers, credentials or body.
* **The dataset**: its name, the number of records, which inputs it supplies (question, reference, gold ids …), and the first five
  records, each value cut at 400 characters. Values pass the redactor (secrets, tokens, personal data) like every AI context.
* **Documents** (`--docs`): file names, a title and a few headings. **An API definition** (`--spec`): the operation lines.
* **The metric catalogue**: id, kind, what each reads, judge calls, default pass mark; the metrics your data cannot run are listed by
  name with what they miss, so the model can say what to add.

The privacy level and *Local only* of Settings ▸ AI assistant apply, and the call is counted in the usage ledger and limited by the
daily caps.

## What you get {#plan}

The model answers with a **plan** (choices and reasons); TestPion builds the evaluation from it, so the file is always valid:

* **Metrics**, each with a pass mark and one sentence of why, from the catalogue only.
* **A dataset slice**: how many records, which tags, every n-th. The slice is stored inside the evaluation (a saved evaluation holds
  its dataset), up to 300 records; the dataset file itself is not changed. Tick **Also save the records it runs as a dataset file** (or pass `--slice-file`, MCP `slice_file`) and the proposal has a second item that writes the same records to `datasets/<name>.jsonl`: a file you can open, compare with the next slice and reuse. It never replaces the dataset the slice is cut from, adds a record only when its id is not in the file, and one Undo removes it with the evaluation.
* **Judge options**: judged share (for a recurring check of a big dataset), short-circuit (skip the judged answer metrics when a
  retrieval gate already failed), shared claims, a cost and a call limit. The model leaves provider and model to you.
* **Gates and a baseline**: the lowest mean each metric may have. They are saved in the evaluation (its **Gates** field, `gates:` in the
  library), and `testpion rag run`, a [monitor](./rag.md) of the evaluation and the CI step fail a run under one (`--min metric=value`, or a monitor's own gate, wins for the same
  metric). `baseline: previous` is a note to run with a baseline so a run worse than the one before fails.
* **Risks**: what this evaluation cannot tell ("only 3 questions", "no reference answers").

### What TestPion fixes, with a note each {#fixes}

A metric that is not in the catalogue, or that needs an input your data does not supply, is **dropped**; a pass mark outside 0 to 1
(for a metric that scores 0 to 1) is replaced by the metric's default; an option the metric does not have is left out; the same
column twice is kept once; a gate on a metric the evaluation does not run is dropped; a name that a saved evaluation already has gets
"(2)". Every change is a line under **Notes** in the review, never silent.

## The dry run {#dry-run}

The verifier `rag-eval-dry-run` runs the evaluation on up to five of its own samples before you see it:

* every metric must resolve and have its inputs from the dataset or from what the target returns, else the badge **fails** and the
  item is unticked ("2 of 3 metrics cannot run: recall@k cannot run: gold chunk ids are missing");
* the **free metrics are computed for real** on records that already hold an answer and contexts (a dataset made from a run or from
  [captured calls](./rag-capture.md));
* the **judged metrics** build their exact prompts on a dry judge host: the calls are counted and priced for the whole dataset, **and
  nothing is sent**; without a judge set up they are checked structurally and the badge says so;
* a pass mark your own samples already miss by a lot is a **warning** ("your 5 samples score 0.20 on recall@k; a gate at 0.8 fails
  today"), because that may be exactly what you want to fix.

The badge reads in plain words: "3 of 3 metrics can run on 5 samples; 1 judged metric would make 200 model calls for 200 records,
about $0.04 to $0.09".

## Accept and undo {#apply}

**Accept** saves a new item in **Evaluations** (never over an existing one) and **Undo** removes it. Open it, change anything, and
run it like any evaluation. With `--apply` the CLI saves it the same way when its checks did not fail.
