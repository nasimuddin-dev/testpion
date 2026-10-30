# Custom RAG metrics {#top}

A custom metric is a file in your workspace, `metrics/<id>.yaml`, that scores one RAG sample by your own rule. It is used like any
catalogue metric: in the metric picker of a RAG evaluation, in `evaluators`, in a preset, in a gate (`--min no-guarantee=1`), in the
matrix, in CI. The catalogue itself is [RAG metrics](./rag-metrics.md); how a RAG evaluation runs is [RAG testing](./rag.md).

The file is plain YAML under git, so a metric is reviewed, branched and merged like a test. Its name in an evaluation is
`custom/<id>`, and the bare `<id>` when no catalogue metric has that name.

## Where to write one {#where}

* **RAG bots ▸ Metrics** (its own rail item) lists the metrics of the workspace. **New** asks for an id and a kind and starts a file of that kind; the
  editor checks the file as you type (what is wrong is said at the line), **Run examples** scores the examples of the file and says
  whether the metric agrees with them, **Try on a sample** runs the saved metric on one sample, **Save** writes the file and
  **Delete** says which evaluations and formulas use it first.
* **Draft with AI**: describe what good looks like, and the AI writes the file as a reviewed proposal. TestPion runs the draft against
  its own examples before showing it, and says when the draft does not agree with them. Nothing is written until you accept.
* **The terminal**: `testpion rag metric new <id> --kind rule`, `new <id> --from-description "…"` (the AI drafts it), `list`, `validate <id> --examples`,
  `rag metric test <id> --sample file.json`, `export` and `import` (copy a metric to another workspace), and `rag metric example <id> --run <run> --result <id>` (add a labelled sample as an example).
* **A bundle carries it.** *Export…* of a metric (or of the whole workspace) puts `metrics/<id>.yaml` in the bundle and *Import…* brings it back with the usual choices when the id exists: the file must be a metric of its own id and kind. A script metric and a judge metric are listed in the import's *Review* (nothing runs and nothing is sent on import).
* **An agent**: the MCP tools `rag_list_custom_metrics`, `rag_validate_metric` (checks a file and runs its examples; with `run_examples`
  this spends the judge for a judged kind, so it asks to confirm) and `rag_save_custom_metric` (replacing an existing file asks for confirmation).

The files are read again only when the `metrics/` folder changed (a file added, removed or saved, here or outside the app): every request, run and
estimate used to read and parse all of them. The metric lists in the window reload only for a change to a metric file.

## The kinds {#kinds}

| Kind | What it does | Model |
|---|---|---|
| `judge` | A criterion in words, judged pass/fail or on a scale (`scale: binary`, or `scale: [1, 5]` for a rating). Optionally `votes: 3` for a majority of three calls. | one judge call |
| `checklist` | Several yes/no criteria in one call; the score is the weighted share that holds. | one judge call |
| `rule` | Deterministic checks (`contains`, `not-contains`, `regex`, `length`, JSON shape …) combined with `all`, `any` or `weights`. | none |
| `formula` | An expression over other metrics: `0.5 * faithfulness + 0.5 * answer_relevance`. | the metrics it names |
| `embedding-set` | Closeness to good answers (and distance from bad ones) by embedding. | one embedding call |
| `script` | A sandboxed function of the sample that returns `{ score, reason }`. No network, no files, a time limit. | none |
| `dag` | A decision tree of small judgements (see below): only the branch the answers lead to is asked, and a leaf holds the score. | one judge call for each question it visits |

```yaml
id: clinic-tone
version: 1
name: Clinic tone
description: Polite, plain language, no promise of a diagnosis
kind: judge
inputs: [question, answer]
scale: binary
criteria: The answer is polite, uses plain language and does not promise a diagnosis.
threshold: 1
examples:
  - { name: plain, sample: { question: "Is my rash serious?", answer: "I can't say. Please book a visit." }, expect: pass }
  - { name: promise, sample: { question: "Is my rash serious?", answer: "It is certainly nothing." }, expect: fail }
```

* `inputs` says what the metric reads; a dataset that lacks one is told so before the run.
* `direction: lower` makes a lower score better (a count of problems). The pass mark is then a maximum.
* `threshold` is the default pass mark; the evaluation can change it per run.
* `extends: other-metric` starts from another file.
* **Formulas** are a small expression language of their own (numbers, `+ - * /`, parentheses, `min`, `max`, `coalesce`, metric names with
  `_` or `-`); nothing is evaluated as code. A metric that is n/a makes the formula n/a, never zero; `coalesce(a, b)` is how you say
  otherwise. A formula that names itself, directly or through other formulas, is refused.
* **Scripts** run in the same sandbox as test scripts, with no `tp.sendRequest`, no files and a time limit; a script that throws or
  returns something that is not a score gives an error for that sample, not a zero.

### A decision tree {#dag}

The `dag` kind is the built-in `dag` metric (DeepEval's DAG) as a file. Each node is one small question and the answer decides which
node comes next; a leaf holds a score from 0 to 10 (divided by 10) and why:

```yaml
id: cites-right
kind: dag
inputs: [question, answer]
threshold: 0.6
tree:
  root: cites
  nodes:
    cites:
      type: binary                      # a yes / no judgement
      question: Does the answer cite a source?
      yes: which
      no: { score: 0, reason: no citation }
    which:
      type: choice                      # pick one labelled option
      question: Which document does it cite?
      options:
        the right one: { score: 10 }
        a wrong one: { score: 4, reason: wrong document }
```

Four node types: `binary`, `choice`, `task` (write something down that later nodes read) and `rule` (a deterministic check, no model). The
engine checks the tree when the file loads: every branch leads to a node or a leaf from 0 to 10, there is no cycle, no more than 40 nodes and
12 deep, and a rule is a check that needs no model. The catalogue row says the most judge calls one sample can cost (the judged nodes on the
longest path) and the estimate counts them; a tree of rules only is free. In the editor a **Decision tree** panel above the YAML shows the
questions in the order they are asked: edit a question, choose where each answer leads (another question or a score and why), add and remove a
question or an option, rename a node, pick the first one. Every change is written back into the YAML (the rest of the file and its comments stay)
and the engine's own check says what is wrong. The AI draft does not write trees.

## The examples are the metric's tests {#examples}

Each example is a small sample and the verdict the metric must give it (`expect: pass | fail`). **Run examples** (and
`testpion rag metric validate --examples`) score them and say `agrees with 2/2 examples`. A metric whose examples disagree can still be saved; the AI draft says in its proposal when its own examples do not agree. Write the examples first: they are the part that stays true when
the criterion is reworded or the judge model changes.

**Run examples** of a judged metric (a criterion or a checklist) asks first: *About 6 judge calls: one for each example* (a checklist: one for each example and item), because each call is paid for; the line beside the button says the same before you press it. A rule, formula or script metric runs on this computer and says *free*. Closing the editor with unsaved edits (**Discard**, Esc or the ×) asks first, and **Delete** has **Undo**; the delete message only says the history keeps the file when the workspace is a git repository.

## What a custom metric costs {#cost}

A `rule`, `formula` of free metrics and `script` metric costs nothing. A `judge` or `checklist` metric is one judge call per sample,
through the same judge service as the catalogue: the same cache (a re-run of an unchanged sample costs nothing), the same budget
(`--max-cost`), the same usage ledger. The estimate before a run counts it. Changing the file changes its scoring hash, so old
cached verdicts are not reused for a new criterion.

## Deleting and renaming {#delete}

The file name is the metric's id, and evaluations name it, so there is no rename: make the metric again under the new id (**New**, paste the YAML) and delete the old file. Deleting
asks first, naming the evaluations and formulas that use the metric; they will not find it afterwards (the run says so per metric).
The file is in git: its history keeps it.
