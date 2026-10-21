# Monitor a RAG system: trends, nightly runs and CI {#top}

A RAG system drifts: a new embedding model, a re-indexed corpus, a prompt edit, a provider update. One evaluation tells you how it is
today; this page is about knowing **when it changed** and being told **before your users are**. Everything here builds on the
evaluations and metrics of [RAG testing](./rag.md) and [RAG metrics](./rag-metrics.md), and none of it needs a new kind of run: a
trend, a nightly monitor and a CI job are the same evaluation, scored the same way, looked at over time.

## The trend of your metrics {#trend}

**Evaluations ▸ Metrics ▸ Trend** draws the mean of every metric run by run, one chart per metric, for the evaluation you have open.
The CLI and agents get the same numbers:

```
testpion rag trend "Clinic RAG"                       # a table, oldest run first
testpion rag trend "Clinic RAG" --metric faithfulness --runs 10 --format csv -o trend.csv
testpion rag trend "Clinic RAG" --json                # the full envelope: points and findings
testpion rag trend "Clinic RAG" --fail-on-drop        # exit 1 when the newest run got worse on a metric
```

MCP: `rag_trend` (`evaluation`, `metrics`, `runs`, `since`, `min_delta`). RPC: `rag.trend`.

Each point holds the mean, the 95% interval (a seeded bootstrap), the pass rate, how many samples were scored and how many were n/a.
The trend follows the runs of the evaluation **and of its monitor** (a monitor's runs are named after it). Reading a run's results
once is enough: its means are cached next to the results (`runs/<id>/rag-means.json`, keyed by the size and modification time of the
results file), so a trend over 30 runs of thousands of samples is quick, and a changed file is read again.

**A change of judge is not a regression.** A run that was scored by another judge model, or with another wording of a metric's judge
prompt, than the run before is marked ("judge or wording changed", drawn in the warning colour). It is never reported as a drop, and
it starts a new baseline: the runs before it are not used as the comparison of the runs after it.

**What counts as a drop.** The newest run's mean against the **median of the 3 runs before it** (the same judge and wording): a move
is reported when it is larger than 0.05, or when the newest run's interval excludes the median and the move is at least 0.025.
`--min-delta` changes the 0.05. A lower-is-better metric (hallucination, latency) that rose is the bad direction. A report line reads
"faithfulness dropped 0.08 over 3 runs (0.86 to 0.78)".

**Needs attention.** Home and the Problems panel list a RAG metric that fell over the last runs (group "RAG metrics"). They use only the
cached means, so the list never scans a big run; a trend is cached whenever it is looked at and after every monitor run.

## Nightly runs: a monitor with a budget {#monitor}

A monitor can run a saved RAG evaluation on a schedule (**Monitors ▸ New monitor ▸ A RAG evaluation**, or
`testpion monitor add nightly -w . --rag-evaluation "Clinic RAG" --every 1d`). The fields that matter for a nightly check on a system in
production:

| Field | What it does | CLI |
|---|---|---|
| Questions | Score this many records per run | `--limit n` |
| Rotate the sample nightly | Score a **different** `limit` records each UTC day, chosen by the date: a month covers the dataset, the same day always picks the same records, so a night can be reproduced from its date | `--rotate` |
| Judged share | The share of samples that get the judged metrics; the free metrics always run | `--judge-sample 0.2` |
| Cost limit / run | One run stops judging at this much; the rest is n/a, **not** a failed gate | `--max-cost 0.5` |
| Judge budget / day | The day's judging (from the AI usage ledger) stops at this much | `--judge-budget 2` |
| Gates | The lowest mean a metric may have: `faithfulness=0.8` | `--gate faithfulness=0.8` |
| Regression gate | Fail when a metric dropped against the previous run, the best of the last 30, or a named run | `--baseline previous` |
| Largest drop allowed | The smallest drop that fails (default 0.05) | `--max-drop 0.05` |

The editor shows what one run is expected to cost (the same estimate as the evaluation's Run dialog; nothing is sent to make it).

**The regression gate** uses the paired comparison of `testpion rag compare`: the same questions in both runs, a seeded paired
bootstrap over the samples both scored, so one unlucky answer does not wake anyone and a slow drift does not hide. A drop is a gate
failure that names the metric, before and after and the interval: `regressed against run-… : faithfulness 0.86 to 0.78 (-0.08,
interval -0.12 to -0.04)`. The first run of a monitor has nothing to compare with and says so.

**A budget stop is not a failure.** When the judge reaches its cost limit or the day's budget, the scores it did not get to are n/a
("budget") and the run's note says how many; the gates look only at what was scored.

**The alert.** A monitor's webhook (Slack, Teams, Discord or any URL) is called when it starts failing and when it recovers. For a RAG
evaluation the message carries the sample ("day 20746: 40 of 400 records"), the metric means, the regressions, the budget note and the
judging cost, and the JSON body has them as `rag`. The same regression table is what the pull-request comment shows (below).

## CI: a nightly job and the pull-request table {#ci}

**Run in CI…** with a RAG evaluation writes a workflow that runs `testpion rag run` with your gates. Tick **A nightly job** and it
becomes a scheduled job instead of a per-push one:

```
testpion ci github -w . --rag-evaluation "Clinic RAG" --rag-nightly "0 3 * * *" --rag-sample 25 --rag-regression --rag-max-drop 0.05
```

The command it runs is `testpion rag run … --limit 25 --rotate --baseline-results previous/results.jsonl --max-regression 0.05`.

| Provider | Schedule | The previous night's results (the baseline) |
|---|---|---|
| GitHub Actions | `schedule: cron` and `workflow_dispatch` | `gh run download` of the last successful run's `testpion-results` artifact (`continue-on-error`) |
| GitLab CI | `rules` for scheduled pipelines; **you create the schedule** under Build ▸ Pipeline schedules with the cron shown in the file (GitLab keeps schedules outside the file) | the artifacts of the default branch's last `api-tests` job, through the job token |
| Azure Pipelines | `schedules` (UTC, `always: true`) | `DownloadPipelineArtifact@2`, the latest from `main` |
| Jenkins | `triggers { cron }` (the server's time zone) | **not generated**: it needs the Copy Artifact plugin; copy the last build's `results.jsonl` to `previous/` yourself |

A missing `previous/results.jsonl` is not an error: the run says it is the baseline of the next one. `--rotate` needs `--limit`.

**The pull-request comment.** With `--markdown file`, the metrics table is followed by a section **Against `<baseline>`**: every metric
that moved (regressions first) with before, after, the change, the 95% interval, the number of samples in both runs, the judge and
what the judging cost. One function writes it for `testpion rag run`, the CI comment and the monitor's alert, so the three agree.

## What is not here {#limits}

* The schedule of a **cloud runner** (a nightly job that does not need your computer or a CI minute) belongs to the cloud version.
* The per-judge-model trend of a **jury** shows the first judge; a jury's own noise is measured by `--repeat`.
* Jenkins gets the schedule and the sample, not the baseline download (see above).
* The matrix views are drawn from the stored scores; the trend is only as old as the runs in the workspace (the Runs list keeps the
  most recent 400).
