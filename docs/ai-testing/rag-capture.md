# RAG dataset from real calls {#top}

Real questions are the best test set: they are what your users ask, in the words they use. **Capture from traffic** turns calls that
already happened into a RAG dataset: the question out of the request, the answer and the retrieved contexts out of the response. How a
RAG evaluation runs is [RAG testing](./rag.md); the metrics are in [RAG metrics](./rag-metrics.md).

Nothing in this feature calls a model. Secrets and personal data are masked **before** anything is written, and the request headers and
cookies are never kept: a record holds the question, the answer and the contexts, and where it came from.

## Where the calls come from {#sources}

| Source | What it is | Choose it with |
|---|---|---|
| **History** | The HTTP entries of the workspace (the request that was sent, the response kept under `payloads/`). | the window: History ▸ **RAG dataset…** (the entries listed); CLI `--history <ids…>` or nothing for the recent ones |
| **A saved Debugger session** | A capture saved as a HAR file in `debugger/`. The History entry of a capture that saved a session names it too. | CLI `--session <name or History id>` |
| **The Debugger, live** | The exchanges selected in the HTTP Debugger. | Debugger ▸ right-click ▸ **Create RAG dataset from selection…** |
| **A HAR file** | Any `.har` file in the workspace (browser tools, proxies). | CLI `--har <file>` |
| **An evaluation run** | The answered samples of a RAG run (question, answer and contexts were captured by the run). No target is needed. | CLI `--run <run id>` |

A capture that became a collection or a flow keeps no exchanges; save the session from the Debugger to use it as a source.

## How a call becomes a record {#how}

1. The calls are matched to the **RAG target** you name: its URL (variables stand for anything) and method. A call to anything else is
   reported as skipped, with its URL, never dropped silently. Only calls that answered 2xx are used unless you ask for all.
2. **The question** is read from the request where the target writes `{{question}}` (`{{questionJson}}`, `{{questionEscaped}}`): a field
   of the JSON body at any depth (also with text around it, `Answer briefly: {{question}}`), a query parameter, a text body or the URL.
   When the target does not say, give the place: `--question-path '$.input.q'` or `--question-path query:q`.
3. **The answer and the contexts** are read from the response with the target's own mapping: the same code that reads a live answer, so a
   streamed (server-sent events) answer works the same way.
4. **Masking.** Secret values the workspace knows, tokens and keys by their shape are always masked. Personal data (emails, phone
   numbers, card and ID numbers) is masked too, unless you turn it off (`--no-mask-pii`; the dialog's first switch). The report says how
   many texts were changed and which kinds.
5. **One record per question** (`--dedupe`; the newest call stays, or `--keep first`): questions that differ only in case, spacing or a
   trailing question mark are one. Masking happens first, so two people's questions that differ only in a name are one too.
6. **A sample**: `--limit n` keeps the newest n; `--sample n --seed s` takes a random n, the same every time with the same seed.
   `--since` and `--until` bound the time.

The record:

```json
{"id":"cap-3f9a2c1d04","question":"When is the clinic open?","answer":"Eight to six.","contexts":[{"id":"hours","text":"…","score":0.91}],
 "tags":["captured","history"],"metadata":{"capturedFrom":{"kind":"history","id":"h-123"},"at":"2026-10-01T10:00:00Z","latencyMs":812}}
```

A record that has an `answer` and `contexts` is scored **offline**: the evaluation judges what the system really answered, without calling it
again. **Questions only** (`--as-questions`) leaves them out, so running the dataset asks the target again (to score a new version on
production questions). There is no reference answer: add one by hand, or use only the metrics that need none (faithfulness, answer
relevance, context relevance).

## In the window {#window}

**Create dataset from captured calls** is one dialog, opened from History, from the Debugger and from AI Lab ▸ RAG. Choose the source and
the target, **Preview** shows what would be written (records, what was skipped and why, what was masked, the first rows), **Create dataset**
writes `datasets/<name>.jsonl`. It never replaces a file that exists.

## In the terminal and for agents {#cli}

```
testpion rag capture --target clinic-rag --dedupe --limit 200 --name prod-questions --dry-run
testpion rag capture --target clinic-rag --session monday --sample 100 --seed 7 --name monday
testpion rag capture --run run_2026-10-20_ab12 --name last-run-answers
```

`--json` prints the report and the first records. Exit 2 when the target or the source is wrong. The MCP tool is `rag_capture_dataset`
(`dry_run` first, then the same arguments without it).

## Limits {#limits}

* HTTP and server-sent-event targets only. A WebSocket, gRPC or MCP target has no request body in History to read a question from.
* A response body is read from `payloads/` (History) or the HAR file; a response that was not recorded is skipped with that reason.
* Drafting reference answers with a model is not part of capture. Do it from the dataset afterwards, as a reviewed proposal.
