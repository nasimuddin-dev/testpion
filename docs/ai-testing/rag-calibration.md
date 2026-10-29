# Calibrate the judge {#top}

A judged RAG metric (faithfulness, answer relevance, your own `judge` metrics) is only as good as the model that judges it. Calibration
asks a plain question: **on the samples you looked at yourself, does the judge say what you would have said?** You label some
results pass or fail, TestPion compares your labels with the judge's verdicts, and the report tells you how far to trust each
metric, where it disagrees with you, and which pass mark would agree with you most.

No model is called: calibration is statistics over scores and verdicts the run already stored, so it costs nothing and gives the
same answer every time. The metrics are described in [RAG metrics](./rag-metrics.md); running an evaluation is [RAG testing](./rag.md).

## Label some results {#label}

In **Evaluations ▸ Metrics**, click a cell of the matrix. The sample opens with its question, answer, retrieved contexts and
every metric's card. Under each scored metric is **Your label: Pass / Fail**: your own verdict on that answer for that metric.
Pressing the active button again removes the label.

* A label belongs to the **dataset record** and the metric, not to one run. It also counts for later runs of the same dataset, **as long as
  the system gives the same answer**: the label keeps a hash of the answer you saw, and a run whose answer changed leaves the label
  out and says so ("left out because the system answered differently since").
* Labels are a workspace file, `labels/<evaluation>.json`, so they are reviewed and committed like a test. Each label keeps who and when,
  the run and result it was made on, the hash of the question and answer, the judge that scored it (provider, model, prompt version) and
  the score you saw. A newer label for the same record and metric replaces the older.
* The **Good / Bad** review of a whole result (the buttons in the footer of the sample) is used too: it counts as an `overall` label
  (judge verdict: every check of the result passed) wherever you made no label for `overall`.

Label at least 30 samples, with passes **and** fails: a metric with 8 labels, all passes, can say nothing about leniency.

## The report {#report}

**Calibrate the AI reviewer…** in the matrix header (or `testpion rag calibrate`) shows, per metric:

| Number | Meaning |
|---|---|
| Cohen's kappa | Agreement beyond chance. Most RAG samples pass, so a judge that always says pass agrees with you most of the time and scores kappa 0. 0.6 or more is *good*, 0.4 to 0.6 *fair*, under 0.4 *poor*. Undefined (and said so) when everything falls in one class. |
| Accuracy | The share of samples where judge and you agree. |
| TPR / TNR | Of what you passed, how much the judge passed; of what you failed, how much the judge failed. |
| Precision | Of what the judge passed, how much you passed. |
| 95% interval | A seeded bootstrap interval of kappa and accuracy: the same labels always give the same interval. With few labels it is wide: that is the point. |
| Confusion matrix | judge × you. *Judge pass, you fail* means the judge is too lenient; *judge fail, you pass*, too strict. |
| Per judge model | The same numbers for each judge model that scored the labelled samples (a run, or a re-score with another judge, records which one judged). |
| Per member of a jury | With a jury (`judges:`) the table has a row for **the jury together** (its aggregate verdict, what the metric decided) and one row for **each member**, with that judge's own kappa, accuracy, TPR and TNR against the same labels. Seeing that one member is too lenient is how you drop it or swap it. |
| Disagreements | Each sample where the judge and you differ, with the question, answer, the judge's reason and your note, and a link to open it. They are the best new examples for a metric's criterion. |

The report works for **every judged metric**, the safety ones (`toxicity`, `bias`, `jailbreak-resistance` …) and the conversation ones (`knowledge-retention`, `conversation-completeness` …) included. For a safety metric a judge that is too lenient lets an unsafe answer through, and the advice says so. A conversation is judged as a whole, so a label belongs to **the whole transcript** it was made on: if the same record goes differently in a later run (another turn, another answer) the label is left out as stale, and a disagreement shows the last turns of the conversation, not only the final answer.

The judge's verdict is its score against the metric's pass mark (the one the run used, or the one you edited in the matrix), so what-if
pass marks calibrate too.

## Make an example of a disagreement {#example}

A sample where a **custom** metric disagrees with you is the best test that metric can get. **Make an example of this** (a button on each disagreement of a custom metric) adds the sample to the `examples:` of the metric's file, with *your* verdict as what the metric must say. **Run examples** then checks it, and an edit to the criterion that fixes this case cannot quietly break another. The file is edited as text, so its comments and layout stay; the same sample is not added twice; a metric has at most 50 examples. A built-in metric has no file to put an example in: copy it into a custom metric first.

## Keep the report {#report-file}

The down arrow of the report saves it as a file: **Markdown** (the numbers per metric, the confusion table, each judge and each member of a jury, the pass mark that agrees most and every disagreement with the question, the answer or the last turns, the judge's reason and your note: something to attach to a pull request) or **JSON** (the same numbers). Both are built by the engine from the same labels, so the CLI writes the identical file.

## Tune the pass mark {#tune}

The report finds the pass mark that agrees most with your labels (highest kappa, then accuracy, then nearest the current mark) and shows the gain
against the current one. A mark is reported in the middle of the gap between the two scores it separates. With fewer than 5 labels of a class it warns you.

* **Try it in the matrix** puts the tuned mark into the matrix header, so the pass rates and cells show what it would decide.
* **Save in the evaluation** (the saved evaluation of the matrix) sets `threshold` on that metric's evaluator.
* For a custom metric (`custom/<id>`), **Save in the metric file** writes `threshold:` and a `calibration:` summary
  (`reviewedRun`, `n`, `kappa`, `tpr`, `tnr`, `at`) into `metrics/<id>.yaml`.

## From the terminal {#cli}

```bash
# label one result on one metric (the result id from `rag matrix`, or just the dataset record id)
testpion rag label <run> --result hours --metric faithfulness --pass --note "the clinic does open at 8"
testpion rag label list                    # the label sets
testpion rag label list Clinic-RAG --json  # one set's labels
testpion rag label clear Clinic-RAG --result hours --metric faithfulness

# how well the judges agree with the labels of that run's evaluation
testpion rag calibrate --run <run> --tune
testpion rag calibrate Clinic-RAG --run <run> --metric faithfulness,answer-relevance --json
testpion rag calibrate --run <run> --min-kappa 0.6      # exit 1 when a metric is below it
testpion rag calibrate --run <run> --tune --apply --evaluation "Clinic RAG"
testpion rag calibrate --run <run> --tune --out calibration.md            # the report as a file (--format json for the numbers)
testpion output rag.calibration --run <run> --format md --out calibration.md

# a disagreement becomes an example of the custom metric (your label is the verdict, or give --expect)
testpion rag metric example custom/clinic-tone --run <run> --result hours --expect fail
```

`--apply` writes the tuned pass mark of every metric whose kappa it improves into the saved evaluation (`--evaluation`) or, for `custom/<id>`, the metric file.
`--min-kappa` is the gate for CI: calibrate the judge on a fixed, labelled run before trusting its scores in a gate.
Exit codes: 0 fine, 1 a metric below `--min-kappa`, 2 a configuration error.

## For agents {#mcp}

* `rag_label` records the verdict **a person** gave (run, result, metric, `pass` or `fail`, an optional note). An agent labels what the person told it to label, not what it
  thinks of the answer: a label is the ground truth the judge is measured against.
* `rag_calibrate` returns the report as JSON (`run_id`, optional `labels`, `metrics`, `tune`). It changes nothing; applying a tuned pass mark is a deliberate step in the app or the CLI.
* `rag_make_metric_example` adds a labelled sample to a custom metric's `examples:` (`metric`, `run_id`, `result`, `expect` or the person's label). It edits only that metric's own file, the way the editor does.

## Limits {#limits}

* Labels measure the judge against **you**. If you are inconsistent, so is the ceiling; label with a second person and compare.
* A kappa from 30 labels is rough: read the interval, not the point.
* A swap or a repeat run is one verdict per metric (its aggregate). A jury is one verdict too, with a row for each member in the table.
* A trend of a jury's members over runs is not kept: the report is per run.

For an evaluation of a prompt or chatbot with a check graded by an AI reviewer, **Trust the AI reviewer** on its Checks tab uses the same card: you grade ten answers of a run and see how often the reviewer agreed. See [Evaluations](/ai-testing/evaluations#trust-the-ai-reviewer).
