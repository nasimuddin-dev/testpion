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

Plain HTTP is captured whole. HTTPS shows as a **tunnel** by host, with bytes in and out, until you decrypt it.

### HTTPS

**HTTPS ▸ Decrypt HTTPS** makes the proxy answer each program with a certificate for the host it asked for, signed by **TestPion HTTP Debugger Root**, a root certificate created on this computer (it never leaves it). Programs that trust that root are captured like plain HTTP, with a lock on the row; a program that does not trust it is listed as a tunnel that failed, with the reason. **HTTPS ▸ Root certificate…** shows its fingerprint, trusts it for the current user in one click (Windows, macOS, Chrome on Linux; Firefox imports it in its own settings), removes it, exports it for a phone or another computer, or makes a new one. Node reads `NODE_EXTRA_CA_CERTS`, Python `REQUESTS_CA_BUNDLE`, curl `--cacert`. **Keep hosts encrypted…** lists the hosts that stay opaque (programs that pin their certificates, banking). Remove the root from the trust store when you are done.

### HTTP/2 and gRPC

Programs that speak HTTP/2 inside a decrypted tunnel are read as HTTP/2: each request is a stream, marked **h2** on its row. **gRPC** calls are captured whole even without TLS (grpc-js and most gRPC clients send plaintext gRPC through a proxy as HTTP/2 inside a CONNECT, and the Debugger reads it): the row says **gRPC**, a failed call shows its gRPC status (NOT_FOUND, UNAVAILABLE …), and the **gRPC** tab lists the messages sent and received as JSON, with the status and message from the trailers. Messages are decoded with the `.proto` files (or reflection) of the workspace's gRPC requests when one describes the method, else field by field. The **Connections** tab groups requests by the connection they came on: an HTTP/2 connection with its streams, an HTTP/1.1 connection with its requests.

A tunnel that carries plain HTTP/1.1 is read too. A program whose server speaks first (SMTP, a database) gets an opaque tunnel.

### A phone or another computer

**Capture ▸ A phone or another computer…** shows this computer's addresses on the local networks, each with a QR code. The proxy has to listen on the network for this; the dialog offers to restart it that way. Scanning the code opens a page the proxy serves itself, with the server and port to type into the device's Wi-Fi proxy settings. When HTTPS is decrypted, the page also offers the root certificate to install, with the steps for Android and iOS.

### WebSocket and Server-Sent Events

A WebSocket through the proxy is one row (status 101, *live* while open) with a **Frames** tab: every message sent and received, with the time and size; control frames (ping, pong, close) on request. A `text/event-stream` response gets an **Events** tab with each event's name, id and data as it arrives.

## What you can do with a row

- **Open**: the exchange becomes a request in a tab, to change and send; double-click does the same.
- **Resend**: send it again as it was (the response lands in History).
- **cURL**: copy it as a cURL command.
- **Ask AI**: the assistant explains what the exchange does, what the response means, why it failed and what to check (it gets the exchange redacted).
- **Bookmark**, **Delete**.

The row's tabs are the inspectors: **Response** and **Request** (JSON as a tree), **Headers**, **Raw** (the request and the response as they went over the wire, to copy), **Hex** (the bodies as bytes), **Auth** (what the request authenticates with, without the secret: a Basic user, a Bearer JWT's claims and expiry, the cookie names) and **Timing**.

**Statistics** show the session: requests over time, the status mix, by host, content type and program, the largest and the slowest exchanges.

**Decode** reads a value as URL-encoded, Base64, hex, a Unix timestamp, a JWT or JSON, and encodes it back.

Keyboard: **↑ ↓** select, **Enter** opens the exchange as a request, **Delete** removes it, **Ctrl+F** goes to the filter box, **Ctrl+E** clears the session.

### Sessions

The **Session** menu keeps captures: **Save session…** writes the session as a HAR file in the workspace's `debugger/` folder (which `.gitignore` keeps out of git); a saved session opens from the same menu, replacing the current one or adding to it. **Import a HAR file…** opens a file from any tool (a browser's DevTools, Fiddler, Charles), and **Import a Fiddler session (.saz)…** opens Fiddler's own archives; **Export as HAR…** saves one anywhere. While capturing, **AutoSave** writes the live session to `debugger/autosave.har` every minute, so a crash loses at most a minute. **Clear** forgets the session.

Secrets (Authorization headers, API keys, passwords in bodies) are masked wherever the session is shown or saved; the proxy listens on this computer only unless you ask for the LAN.

## Rules

The **Rules** tab is what the proxy does to matching traffic, in the order listed:

- **ignore** hides it from the list (it still goes through);
- **highlight** colours the row: by host, URL, program, or by the response (a status class or code, slower than *n* ms, larger than *n* bytes). A fresh profile highlights errors, server and client errors, slow and large responses;
- **modify** sets or removes request and response headers, replaces a body, adds a delay;
- **reply** answers without the server: a status, headers and a body (offline, a canned error, a mock);
- **redirect** sends the request to another host (and scheme): a staging API to a local one, a CDN to a mock;
- **breakpoint** pauses the request (before the server) or the response (before the program) in a dialog where you change the method, URL, status, headers or body, then **Continue**, or **Abort**. A held exchange goes on by itself after two minutes.

Hosts and URLs match by glob (`*.example.com`, `*/orders/*`) or by a /regular expression/; methods and the program's name narrow it. The first matching reply, redirect or breakpoint wins; header edits add up. **Presets** add the usual ones in one click (a header, CORS, no caching, a slow network, offline, a canned 200, a redirect to localhost, a breakpoint), filled in for the selected exchange's host; a row's **Rule** menu does the same from the traffic, including **Reply with this response from now on**. **What would happen to a URL** tells which rules act on it. The bar above the traffic says how many rules are active and when an exchange is held at a breakpoint.

Rules live in **profiles** (Offline, Slow network, Mock payments…) switched as one; the profiles are saved in the workspace's `debugger/rules.json`, committed with it, so a team shares them. The **Presets** menu next to the filters saves and recalls filter presets. **Compare** on an exchange, then a click on another, shows the two side by side: status, headers, body.

## From the terminal and for agents

```bash
testpion debug                       # the proxy on 8899; every exchange printed as it happens
testpion debug -p 9000 -o session.har --json
testpion debug --rules debugger/rules.json   # the workspace's rules (re-read when the file changes)
testpion debug --decrypt                     # HTTPS too, for programs that trust ~/.testpion/debugger/testpion-root.pem
testpion debug -w .                          # gRPC decoded with this workspace's .proto files
```

AI agents have the same through the workspace's MCP server: `debugger_capture` (start / stop / status / clear; `decrypt` for HTTPS), `debugger_exchanges` (the list, with filters; `deep` searches bodies), `debugger_exchange` (one, with bodies), `debugger_session` (save the session as HAR, or open a HAR file), `debugger_rules` (list, presets, add, enable, remove: an agent can take an API offline, slow it down or redirect it while it tests), `debugger_stats`. An agent can start the proxy, run a program against it and read what it did.

## Coming next

Every feature of HTTP Debugger and Fiddler Everywhere listed in `planning/http-debugger.md` is in; what comes next is in that file. The plan is `planning/http-debugger.md` in the repository.

:::
