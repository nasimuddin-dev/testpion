::: v-pre

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
| **gRPC and MCP calls in History** | The request of a call (the gRPC message, the MCP tool's arguments). History keeps no response for them, so the dataset holds the **questions**; the target answers them when an evaluation runs. | CLI `--target <a gRPC or MCP target>`; History |
| **A WebSocket message log** | The log saved from the down arrow of a WebSocket tab (JSON Lines: time, direction, data), kept in `messages/` of the workspace. Each sent message and the messages received before the next one is a call; the target's mapping reads the answer from them. | CLI `--messages <file>` (`--messages-url` when the target's address must match) |

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

## Other protocols {#protocols}

The RAG target says which protocol the calls are for, and a call of another protocol is skipped with its reason ("a mcp call, and the target is grpc"). **gRPC**: the call is matched by its method (`rag.Rag/Ask`) and, when both are known, its address; the question is read from the message where the target writes `{{question}}`. **MCP**: matched by the tool; the question is read from the arguments (`query: "Answer briefly: {{question}}"` gives back only the question). **WebSocket**: the question is read from the sent message, the answer and the contexts from the replies with the target's mapping (the replies are read as `received`, the way a live WebSocket target reads them). A call that got no reply is a call that did not succeed. The report says it when a protocol keeps no response.

## Draft the reference answers {#references}

A captured dataset has the question, the answer the system gave and the passages it retrieved, but no reference answer. **Draft reference answers…** (Data ▸ a dataset, `testpion rag draft-references <dataset>`, MCP `rag_draft_references`) has the AI write one for each record that has none, **from the passages that record retrieved, not from the system's own answer** (a wrong answer is not copied; it is not even sent). A record whose passages do not hold the answer is marked unanswerable. Every draft is checked against its passages (the share of its words in them, and a judge's claim-by-claim check when a judge is available) and the result is **one proposal** you read in the usual review: accepting an item replaces the record of the same id in `datasets/<name>.jsonl` and keeps the rest of it (the answer, the contexts, the tags); one Undo puts the file back. Up to 12 records per run (`--limit`, `--ids`); run it again for the next ones. The estimate and *What will be sent* come first, the questions and passages are sent redacted, and the AI privacy level must be Full. `--estimate` sends nothing.

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

* History keeps no response for a gRPC or an MCP call, so those datasets hold questions only; a WebSocket call needs the message log saved from the WebSocket tab (nothing records it by itself).
* A response body is read from `payloads/` (History) or the HAR file; a response that was not recorded is skipped with that reason.
* Drafting reference answers is a separate step after capture (above): nothing in capture calls a model.

:::
