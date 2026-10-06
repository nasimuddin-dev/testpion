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
3. Use the program. Its traffic appears; a filter box, the host, method and status filters and a Bookmarked switch narrow the list. **In bodies** makes the filter box search headers and bodies too.

The **Capture** menu does the pointing for you:

- **Open Chrome / Edge / Firefox / Brave through the proxy**: the browser starts with a profile of its own (your real profile, cookies and extensions stay out of it) and every page it loads goes through TestPion.
- **Open a terminal through the proxy**: a new terminal window whose shell has `HTTP_PROXY` and `HTTPS_PROXY` set; anything you run in it is captured.
- **Set the system proxy to TestPion**: every program that honours the operating system's proxy sends through (Windows: Internet Settings; macOS: `networksetup`; GNOME: `gsettings`). It is put back as it was when you **Restore** it, when you stop capturing and when TestPion quits.
- **Copy for bash / PowerShell / cmd / curl / Chrome**: the lines for a shell that is already open.

Plain HTTP is captured whole. HTTPS shows as a **tunnel** by host, with bytes in and out: decrypting it needs a TestPion root certificate, which is coming (see the plan).

## What you can do with a row

- **Open**: the exchange becomes a request in a tab, to change and send; double-click does the same.
- **Resend**: send it again as it was (the response lands in History).
- **cURL**: copy it as a cURL command.
- **Ask AI**: the assistant explains what the exchange does, what the response means, why it failed and what to check (it gets the exchange redacted).
- **Bookmark**, **Delete**.

The row's tabs are the inspectors: **Response** and **Request** (JSON as a tree), **Headers**, **Raw** (the request and the response as they went over the wire, to copy), **Hex** (the bodies as bytes), **Auth** (what the request authenticates with, without the secret: a Basic user, a Bearer JWT's claims and expiry, the cookie names) and **Timing**.

**Statistics** show the session: requests over time, the status mix, by host, content type and program, the largest and the slowest exchanges.

Keyboard: **↑ ↓** select, **Enter** opens the exchange as a request, **Delete** removes it, **Ctrl+F** goes to the filter box, **Ctrl+E** clears the session.

### Sessions

The **Session** menu keeps captures: **Save session…** writes the session as a HAR file in the workspace's `debugger/` folder (which `.gitignore` keeps out of git); a saved session opens from the same menu, replacing the current one or adding to it. **Import a HAR file…** opens a file from any tool (a browser's DevTools, Fiddler, Charles); **Export as HAR…** saves one anywhere. While capturing, **AutoSave** writes the live session to `debugger/autosave.har` every minute, so a crash loses at most a minute. **Clear** forgets the session.

Secrets (Authorization headers, API keys, passwords in bodies) are masked wherever the session is shown or saved; the proxy listens on this computer only unless you ask for the LAN.

## From the terminal and for agents

```bash
testpion debug                       # the proxy on 8899; every exchange printed as it happens
testpion debug -p 9000 -o session.har --json
```

AI agents have the same through the workspace's MCP server: `debugger_capture` (start / stop / status / clear), `debugger_exchanges` (the list, with filters; `deep` searches bodies), `debugger_exchange` (one, with bodies), `debugger_session` (save the session as HAR, or open a HAR file), `debugger_stats`. An agent can start the proxy, run a program against it and read what it did.

## Coming next

Rules that change traffic (modify headers, auto-reply with a canned response, redirect a host to a mock, breakpoints that pause a request for editing), highlight rules and filter presets, comparing two exchanges, WebSocket / SSE / gRPC frames, HTTPS decryption with a root certificate, Fiddler session import. The plan is `planning/http-debugger.md` in the repository.

:::
