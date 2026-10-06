---
title: "HTTP Debugger"
description: "See the HTTP traffic of other programs: a browser, an app under test, a Node server, an AI agent or an MCP server sends through TestPion's local proxy, and every request and response is listed, inspected, resent and saved."
---

::: v-pre

# HTTP Debugger

The **HTTP Debugger** (**Debugger** in the rail, under Testing) shows the traffic of *other* programs. TestPion runs a local proxy; a program pointed at it sends every request through, and each exchange is listed as it happens with the program that sent it, the status, the size and the timing. A row opens whole: the request and response headers and bodies, and a timing breakdown.

## Capture

1. Click **Start capturing** (the port is 8899 unless you change it).
2. Point the program at the proxy:
   - a terminal program: `HTTP_PROXY=http://127.0.0.1:8899` (and `HTTPS_PROXY` for HTTPS) before you run it; Node, Python, curl, Go and most SDKs read it;
   - Chrome or Edge: start it with `--proxy-server=http://127.0.0.1:8899`;
   - anything else: the operating system's proxy setting (Windows: Settings ▸ Network ▸ Proxy).
3. Use the program. Its traffic appears; a filter box, the host, method and status filters and a Bookmarked switch narrow the list.

Plain HTTP is captured whole. HTTPS shows as a **tunnel** by host, with bytes in and out: decrypting it needs a TestPion root certificate, which is coming (see the plan).

## What you can do with a row

- **Open**: the exchange becomes a request in a tab, to change and send; double-click does the same.
- **Resend**: send it again as it was (the response lands in History).
- **cURL**: copy it as a cURL command.
- **Bookmark**, **Delete**.

**Statistics** show the session by host, content type and program, with the largest and the slowest exchanges. **HAR** saves the session as a HAR file (open it in any HTTP tool, or **Import** it back into TestPion as a collection). **Clear** forgets the session.

Secrets (Authorization headers, API keys, passwords in bodies) are masked wherever the session is shown or saved; the proxy listens on this computer only unless you ask for the LAN.

## From the terminal and for agents

```bash
testpion debug                       # the proxy on 8899; every exchange printed as it happens
testpion debug -p 9000 -o session.har --json
```

AI agents have the same through the workspace's MCP server: `debugger_capture` (start / stop / status / clear), `debugger_exchanges` (the list, with filters), `debugger_exchange` (one, with bodies), `debugger_stats`. An agent can start the proxy, run a program against it and read what it did.

## Coming next

Rules that change traffic (modify headers, auto-reply with a canned response, redirect a host to a mock), highlight rules, saved sessions, WebSocket / SSE / gRPC frames, HTTPS decryption with a root certificate, Fiddler session import. The plan is `planning/http-debugger.md` in the repository.

:::
