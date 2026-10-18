---
title: Save and export results
description: "Every response and result in TestPion has the same down arrow: save it as JSON, CSV, HTML, Markdown, HAR, JUnit, ZIP or raw bytes through the Save as dialog, or copy it. Secrets in logs are masked by default, big outputs stream to disk, and Ctrl+Shift+S saves the output you are in."
---

# Save and export results

Every response and every result in TestPion has the same **down arrow** at the right end of its bar. It saves what the panel shows to a file, and **Copy** sits next to it.

## Save an output

1. Open the output: a response, a run's results, the console and so on.
2. At the right end of its bar, click the **down arrow** (*Download …*). It saves in the default format, or in the format you chose last on that kind of output.
3. Choose the folder and the name in the **Save as** dialog. The first time it opens in your Downloads folder. After that it opens in the folder you last used for that kind of output in this workspace.
4. When the file is saved, a message says where. **Show in folder** opens the file's folder and **Open** opens the file.

**Other formats.** Click **▾** next to the arrow. The menu lists every format of that output with its extension. It also has:

- **Copy as**: copies the output in another text format.
- **Include secrets…**: on outputs that are redacted by default, except the console and the application log (see [Secrets](#secrets)).

**Copy.** The **Copy** button copies the output in its default text format. Copy is limited to 5 MB: download anything bigger.

**Keyboard.**

- <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> (<kbd>⌘</kbd>+<kbd>⇧</kbd>+<kbd>S</kbd> on macOS) saves the output you are in, meaning the one nearest to where you last clicked, in its default format. You can rebind it in **Settings ▸ Keyboard**.
- The command palette's **Download Output…** and **File ▸ Download Output…** open its format menu.

File names are made from what the output is and when, for example `GET-patients-2026-10-17-1405-200.json` or `run-smoke-2026-10-17-1405-passed.html`. They are safe on Windows, macOS and Linux. For a raw response body, the file name from the server's `Content-Disposition` header wins.

## What you can save

| Output | Formats |
|---|---|
| Response body: REST, SOAP, GraphQL | Raw bytes as received (images, PDFs and other binary bodies too), JSON pretty or minified, the Table view as CSV or TSV, HTML, XML, text, HAR (request and response) |
| Response headers / cookies | JSON, CSV, text (`Name: value`) / JSON, CSV, `cookies.txt` (Netscape, for `curl -b`) |
| Response timeline, checks, trace, JWTs, stream, history, cURL | JSON, HAR with timings, Markdown / JSON, JUnit XML, Markdown / JSON / JSON / text / JSON, CSV / shell script |
| gRPC: response, metadata, trailers | Response JSON, messages as JSON Lines, metadata and trailers as JSON or CSV, and everything in one JSON |
| WebSocket, Socket.IO, MQTT and Kafka message logs, server-sent events, GraphQL subscriptions | JSON Lines, CSV, text, JSON. These hold every message kept, not only the filtered ones. |
| MCP tool result | JSON, Markdown, text |
| Generated code | The file in its language (`.sh`, `.py`, `.js` …) |
| Run results: tests, collection runner, evaluations | HTML report, JSON, JUnit XML, Markdown, CSV of the results, ZIP of all of them |
| Flow run timeline | Self-contained HTML, JSON |
| Data-run rows, scale and matrix grids | CSV, JSON, HTML |
| Load test results | JSON, CSV, HTML, Markdown |
| Evaluation matrix | CSV, JSON, Markdown, HTML |
| Console, application log, terminal | Text, JSON Lines / text |
| Problems | Markdown, JSON, CSV |
| HTTP Debugger session | HAR (sanitized), JSON, CSV |

**CSV files are safe to open in a spreadsheet.** A cell that a spreadsheet would run as a formula starts with `=`, `+`, `-`, `@`, a tab or a line break. TestPion writes such a cell with a leading `'`, so the spreadsheet shows it as text. Plain numbers such as `-12.5` stay numbers. **CSV for Excel** adds a byte-order mark so Excel reads the file as UTF-8.

**HTML exports** are one self-contained file. They have no scripts and load nothing from the network, and they follow the reader's light or dark theme.

## Secrets {#secrets}

**Logs and reports are redacted by default.** This covers the console, the application log, the terminal transcript, run reports, traces, the HTTP Debugger's HAR, decoded JWTs and the cURL command. The following are masked:

- Authorization and cookie headers
- tokens and API keys, found by their shape
- credential query parameters
- the values of your secret variables

These outputs show a **Redacted** mark next to the arrow. To keep the secrets, choose **▾ ▸ Include secrets…**. TestPion asks first, and the choice applies to that one file only.

**The console and the application log never hold secrets.** They are masked as each request or log line is recorded, so these two have the **Redacted** mark but no **Include secrets…**: the masked values are not kept anywhere to put back.

**A response body is your own data, so it is saved as it is.** When the body looks like it holds a credential (an `access_token` field, a bearer token), the message after saving says so. When the active environment is marked as production, the menu and the message say that too.

## Big outputs

**Large data is never copied into the window.** The full response body is already kept on disk (the window only shows a preview), and the app copies or re-indents it straight into your file. The same applies to:

- a run's reports
- the rows of a data run or an evaluation matrix
- the console and the log

**Long saves show progress.** A save of more than 5 MB, or one that takes a moment, shows how far it is, with **Cancel**. A cancelled or failed save leaves no half-written file: the file is written as `<name>.part` and renamed when it is complete.

In the browser version the file is downloaded instead of saved through a dialog, up to 100 MB. Use the desktop app or the CLI for bigger files.

## From the terminal and for agents

The CLI already writes many of these files:

- `run-collection`, `test` and `eval run` take `-o/--out` and `-r` for the reports
- `load --json <file>`
- `history export-har -o`, `debug -o`
- `flow report --html`

Coming in a later release: `--out <file> --format …` with the same formats and the same redaction on every result command, and MCP tools that save big results into the workspace's `exports/` folder.
