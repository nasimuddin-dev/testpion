---
title: "HTTP Debugger"
description: "See the HTTP traffic of other programs: a browser, an app under test, a Node server, an AI agent or an MCP server sends through TestPion's local proxy, and every request and response is listed, inspected, resent and saved."
---

::: v-pre

# HTTP Debugger

The **HTTP Debugger** (**Debugger** under the rail's **More…**, or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Go to Debugger*; right-click a rail item ▸ **Show on the rail** to keep it there) shows the traffic of *other* programs. TestPion runs a local proxy; a program pointed at it sends every request through, and each exchange is listed as it happens with the program that sent it, the status, the size and the timing. A row opens whole: the request and response side by side, and a timing breakdown.

## The workbench

The Traffic tab is laid out like a desktop HTTP debugger:

<figure class="aps-screenshot">
  <img src="/images/debugger.jpg" alt="The HTTP Debugger: the tool rail on the left, a grid of captured requests with method, version, URL, status, type, size, speed, application, domain and IP address, a 404 selected with Request details and Response details side by side, and the Summary panel on the right" width="1440" height="900" loading="lazy">
</figure>

| Part | What it is |
| --- | --- |
| **Tool rail** (left) | Submitter, Filter, Highlight, Auto-reply, Modify (headers, redirect), Timeline (F5), Summary, Structure (F6), Performance, Convert, Export / import. Hover one for what it does; a click opens its panel in the dock, a second click closes it. The button at the foot of the rail shows each tool's name under its icon (remembered). |
| **Filter bar** | The text filter first (**In bodies** searches headers and bodies too), then All applications, All domains, All types, method, status, **Bookmarked**, **Hide tunnels** (leaves out the HTTPS tunnels that are not decrypted), the chips of the quick filters you chose from a row's menu, saved **Presets**, and **Clear filters** (shown while a filter is on: it puts the text, the dropdowns, the checkboxes and the chips back to nothing). At the far right, behind a divider: **Save session** and **Clear**, then the download button and the number of filter-out / capture-only rules on (click it for the Filter panel). |
| **Grid** | `#`, Offset (seconds since the session's first request), Duration (s), Method, Version, URL, Status, Type, Size (KB), Speed (KB/s), Application (the program behind the connection, found while it is open; one that exits within milliseconds, such as a single curl, may show none), Domain, IP address, User (the account the program runs as), and PID on demand. Click a header to sort, again to reverse; the columns button shows or hides columns (remembered). Ctrl+click and Shift+click select several. |
| **Outgoing / Incoming** | Outgoing is what programs sent through the proxy; **Incoming requests** lists what your programs sent to TestPion's own mock servers (a collection's **Mock** tab), with the example that answered; click one for its headers and body and the mock's answer in the same panes (**Open** makes it a request tab). |
| **Request details / Response details** | Side by side under the grid once a row is selected (until then, a one-line hint). Each is a header table with the start line first (`[Request] POST /pet HTTP/1.1`, `[Response] HTTP/1.1 404 Not Found`) and **Filter headers**; tabs at the bottom: **Header**, **Content**, **Raw**, **JSON**, plus **Params** (the query string and a form body, decoded, one row each), **Cookies**, **Summary**, **Auth** and **Hex** on the request; **Cookies** (what the response sets, with the attributes), **Error** (a failure or a 4xx or 5xx, with what to check), **Hex**, **gRPC**, **Frames** or **Events** on the response when the exchange has them. |
| **Dock** (right) | One panel at a time, chosen from the rail; its title says which. The pin in its header unpins it: the dock folds into a tab on the right edge and the grid takes the width; hover or click the tab (or a rail button) and the panel slides over the grid, and it slides away when the pointer leaves it, on Esc or on a click elsewhere. Pin it to dock it again (remembered). Its width is dragged at its left edge. |
| **Footer** | How many requests are listed (or selected), their size and their total time. |

Once HTTPS traffic shows up as tunnels, a one-line notice offers **See inside HTTPS…** (and **Install certificate…** for the manual way). The **HTTPS** menu in the header holds the same, and its lock says the state: green when decrypted.

### The dock's panels

- **Filter**: **Filter out** rules hide what they match (it still goes through); **Capture only** rules, when one is on, list only what one of them matches. Each rule has a box to turn it on or off and its **Hits** (how many requests it acted on in this capture; the reset button counts from zero). **Remove all** removes every rule of the list at once (the message has **Undo**); it is off while the search box has text, because it takes the whole list, not the rows found.
- **Highlight** and **Highlight rule**: the highlight rules, and an editor for one: a rule name, a **Column** (Status, URL, Method, Domain, Application, Type, Version, IP address, Duration, Size), an **Expression** (equals, does not equal, contains, starts with, ends with, is between, greater than, less than, matches), the value (two for *is between*), **Use a regular expression**, a colour for the dark theme and one for the light theme, **Make bold** and **Entire row**. *Status is between 400 and 499* colours client errors; a new rule goes first, so it wins over the built-in ones.
- **Auto-reply**: the rules that answer without the server.
- **Modify**: the rules that change headers and bodies, add a delay, or redirect a host.
- **Timeline**: the selected request's **Sending**, **Waiting** and **Receiving** as bars, with its total time and size; several selected requests show on one time axis.
- **Summary**: the selected request in groups: **Main** (PID, application, user, IP address, total size), **Connection** (protocol, HTTPS, connection and stream id, client port), **Request details** and **Response details** (header and content sizes, content types, status), **Timing**, and, when they apply, **Rules and errors** (the rules that acted, a redirect, a breakpoint edit, the error). The request side's **Summary** tab shows the same table, so there is one summary.
- **Structure**: the listed requests by domain, then path segment by segment, with counts and sizes and a total; double-click one to select its first request.
- **Performance**: where the time and bytes go: the share of time spent waiting for servers, the slowest responses, the largest responses, the slowest transfers (KB/s) and every domain's average and slowest time.
- **Convert**: paste a value; **URL decode** and **URL encode** run the shown conversion (their arrows pick another: Base64, hex, HTML, JWT, timestamp, JSON format or minify) into the result box; **Other readings** lists every decoding that makes sense. The header's **Decode** button opens it.

## Capture

Before anything is captured the header shows one main button, **Capture all traffic**. Its small arrow offers **Only a program I point at the proxy**, which starts the proxy alone.

1. For everything on this computer, click **Capture all traffic**. One click starts the proxy, points the system proxy at it (so browsers and programs that follow it appear in the grid with their program name, like Fiddler) and asks **See inside HTTPS?** once (see [HTTPS](#https)). **Stop** puts the setting back. Programs that ignore the system proxy (some .NET, Java and Electron apps, most command-line tools) are not captured this way; use **a terminal** or **a phone or another computer…** for those. On Windows a site you run on `localhost` shows up too. On macOS and Linux browsers skip `localhost` even with a proxy: open the site as `http://localhost.:4373/` (with a dot after `localhost`) or use **Capture traffic for one API…**.
   Or choose a narrower way from **Capture**: **a browser** (Chrome, Edge, Firefox or Brave opened through the proxy with a profile of its own, so only that window is captured; on macOS, Safari, which has no proxy of its own, is opened with the system proxy pointed at TestPion and restored when you stop), **a terminal** (opened with `HTTP_PROXY` set, so only what runs in it), **a phone or another computer…**, or **Capture traffic for one API…**. The proxy starts on its own. **Capture ▸ Proxy port…** changes the port (8899).
2. Point a program at the proxy yourself (after **Only a program I point at the proxy**):
   - a terminal program: `HTTP_PROXY=http://127.0.0.1:8899` (and `HTTPS_PROXY` for HTTPS) before you run it; Node, Python, curl, Go and most SDKs read it;
   - Chrome or Edge: start it with `--proxy-server=http://127.0.0.1:8899`;
   - anything else: the operating system's proxy setting (Windows: the system Settings app ▸ Network & internet ▸ Proxy, not TestPion's Settings).
3. Use the program. Its traffic appears; a filter box, the host, method and status filters and a Bookmarked switch narrow the list. **In bodies** makes the filter box search headers and bodies too.

The **Capture** menu does the pointing for you:

- **A browser: Chrome / Edge / Firefox / Brave (only that window)**: the browser starts with a profile of its own (your real profile, cookies and extensions stay out of it) and every page it loads goes through TestPion.
- **A browser: Safari (through the system proxy, restored on stop)** (macOS): Safari always follows the system proxy, so TestPion points the system proxy at itself and opens Safari; other programs that follow the system proxy are captured too until you stop, when the proxy is put back. For HTTPS, trust the root certificate (**HTTPS ▸ Root certificate…** adds it to the login keychain). Safari on an iPhone or iPad is **A phone or another computer…**.
- **A terminal: commands run in it (only those)**: a new terminal window whose shell has `HTTP_PROXY` and `HTTPS_PROXY` set; anything you run in it is captured.
- **A phone or another computer…**: see [below](#a-phone-or-another-computer).
- **Capture traffic for one API…**: for a client that can't use a proxy; see [Capture traffic for one API](#capture-traffic-for-one-api).
- **Stop capturing everything (restore the system proxy)**: shown while the system proxy points at TestPion. The system proxy is also put back when you stop capturing and when TestPion quits. On Windows it is set with `<-loopback>`, which sends `localhost` and `127.0.0.1` through the proxy too (Windows normally skips them).
- **Copy the lines for bash / zsh, PowerShell, cmd, curl or Chrome / Edge**: the lines for a shell that is already open.

Plain HTTP is captured whole. HTTPS shows as a **tunnel** by host, with bytes in and out, until you decrypt it; **Hide tunnels** in the filter bar leaves the tunnels out of the list.

### HTTPS

**Capture all traffic** (and **HTTPS ▸ See inside HTTPS…**, and the notice's button) asks one question the first time: **See inside HTTPS?** TestPion makes the proxy answer each program with a certificate for the host it asked for, signed by **TestPion HTTP Debugger Root**, a root certificate created on this computer (it never leaves it); for that, this computer has to trust the root.

- If it already trusts it, decryption just goes on; nothing is asked.
- If it does not, the question offers **Install and decrypt** (your operating system asks you to confirm; Windows shows its own box) or **Keep HTTPS as tunnels**. Choose the second and HTTPS stays hidden; **HTTPS ▸ See inside HTTPS…** (or the notice's button) asks again whenever you want.
- If TestPion cannot tell whether the root is trusted (Linux, or a check that failed), it shows the steps to trust it by hand once, turns decryption on, and does not install anything or ask again in the session.

Close and reopen your browser after the root is installed: a browser reads the trust store when it starts. **HTTPS ▸ Stop decrypting HTTPS** turns it off.

Programs that trust the root are captured like plain HTTP, with a lock on the row; a program that does not trust it is listed as a tunnel that failed, with the reason, and its **Error** tab says what to do. **Keep this host encrypted** (right-click the row, or the button above the details) stops decrypting that host for programs that pin their certificate (OneDrive, banking, many apps); it appears while decryption is on or when the row failed on the certificate, and **HTTPS ▸ Keep hosts encrypted…** edits the list. **HTTPS ▸ Root certificate…** shows the fingerprint, trusts the root for the current user in one click (Windows, macOS, Chrome on Linux; Firefox imports it in its own settings), removes it, exports it for a phone or another computer, or regenerates it. TestPion trusts a root by its fingerprint, so an older root of the same name does not count and is replaced when you install. A root is valid for **one year** and has a path length of 0 (it can sign host certificates, nothing else); TestPion tells you 30 days before it ends and makes a new one when it does, which you then trust again (on a phone, install it again). A root made by an earlier version is valid for ten years: it keeps working so nothing you trusted breaks, and the dialog suggests **Regenerate certificate**, after which you remove the old root from the stores that had it and trust the new one. Node reads `NODE_EXTRA_CA_CERTS`, Python `REQUESTS_CA_BUNDLE`, curl `--cacert`. Remove the root from the trust store when you are done.

### HTTP/2 and gRPC

Programs that speak HTTP/2 inside a decrypted tunnel are read as HTTP/2: each request is a stream, marked **h2** on its row. **gRPC** calls are captured whole even without TLS (grpc-js and most gRPC clients send plaintext gRPC through a proxy as HTTP/2 inside a CONNECT, and the Debugger reads it): the row says **gRPC**, a failed call shows its gRPC status (NOT_FOUND, UNAVAILABLE …), and the **gRPC** tab lists the messages sent and received as JSON, with the status and message from the trailers. Messages are decoded with the `.proto` files (or reflection) of the workspace's gRPC requests when one describes the method, else field by field. The **Connections** tab groups requests by the connection they came on: an HTTP/2 connection with its streams, an HTTP/1.1 connection with its requests.

A tunnel that carries plain HTTP/1.1 is read too. A program whose server speaks first (SMTP, a database) gets an opaque tunnel.

### A phone or another computer

**Capture ▸ A phone or another computer…** shows this computer's addresses on the local networks, each with a QR code. The proxy has to listen on the network for this; the dialog offers to restart it that way. Scanning the code opens a page the proxy serves itself, with the server and port to type into the device's Wi-Fi proxy settings. When HTTPS is decrypted, the page also offers the root certificate to install, with the steps for Android and iOS.

### WebSocket and Server-Sent Events

A WebSocket through the proxy is one row (status 101, *live* while open) with a **Frames** tab: every message sent and received, with the time and size; control frames (ping, pong, close) on request. A `text/event-stream` response gets an **Events** tab with each event's name, id and data as it arrives.

## What you can do with a row

- **Open** (**Open as request** in the right-click menu, or the rail's **Submitter**): the exchange becomes a request in a tab, to change and send; double-click does the same. (Older versions called this *Edit & Submit*.)
- **Resend**: send it again as it was (the response lands in History). The row menu's **Resend** has more: *Once*, *Resend 10 times*, *Resend the selected, in order* and *Resend…* (see *Resend many times* below).
- **Copy**: the URL, the headers, or the request as code: **As cURL**, **As PowerShell**, **As fetch (JavaScript)**, **As HTTPie** (secrets masked).
- **Ask AI**: the assistant explains what the exchange does, what the response means, why it failed and what to check (it gets the exchange redacted).
- **Bookmark**, **Delete**.

The panes' tabs are the inspectors: **Header**, **Content**, **JSON** (as a tree), **Raw** (the request and the response as they went over the wire, to copy), **Params** (the query string and a form body, decoded), **Cookies** (the request's `Cookie` header, and what the response sets with its attributes), **Summary** (the whole exchange in one table, the same as the dock's), **Auth** (what the request authenticates with, without the secret: a Basic user, a Bearer JWT's claims and expiry, the cookie names), **Error** (shown for a failure and for a 4xx or 5xx: what it usually means and what to check) and **Hex** (the bodies as bytes). The timing is in the dock's **Timeline** and **Summary**.

**Right-click a row** (or select it and press <kbd>Shift</kbd>+<kbd>F10</kbd> or the Menu key) for the same and more, in groups: **Copy** (URL, as cURL, request or response headers), **Save content** (the request or response body to a file), **Bookmark**, **Open as request**, **Resend**, **See inside HTTPS…** or **Keep this host encrypted** (on a tunnel row), **Compare with…**, **Create flow from selection…**, **Save to collection…**, **Create RAG dataset from selection…** (with several rows selected the lines say *Create flow from 3 selected…* and so on), **Save as test…**; then the rules made from the row's values: **Capture only**, **Filter out** and **Highlight** with *Application = node.exe*, *URL starts with …*, *Domain = …*, *Method = POST*, *IP address = …* (under **Filter out** the lines read *Domain != …*, *URL does not start with …*, because that is what the click does to the list), or a new rule to fill in; then **Change this traffic** (**Auto-reply** ▸ *Reply with this response from now on*, **Modify headers…**, **Redirect connections…**), the **HTTP/2 connection tree** and **Delete** (the selected rows). To clear the whole session use **Clear** at the right of the filter bar, **Session ▸ Clear the session** or <kbd>Ctrl</kbd>+<kbd>E</kbd>: they are one action.

One click on **Capture only** or **Filter out** does two things: it adds a rule and applies it at once to the rows already captured, as a **chip** beside the filters (*Domain = x* for Capture only, *Domain != x* for Filter out). Click a chip to show those rows again: the chip goes, **the rule stays** in the Rules list (the chip says so), so new traffic is still filtered; remove the rule there. Several **Capture only** chips together keep a row that matches any of them, as the rules do; each **Filter out** chip hides what it matches. Chips are not saved in filter presets (the rules are). The rule is named from what it matches: *Filter out Domain = x*. Every rule is one you make: TestPion has no built-in list of programs to hide.

**Statistics** show the session: requests over time, the status mix, by host, content type and program, the largest and the slowest exchanges.

**Decode** opens the dock's **Convert** panel.

Keyboard: **↑ ↓** select, **Ctrl/Shift+click** select several, **Enter** opens the exchange as a request, **Shift+F10** or the **Menu key** opens the row's menu, **Delete** removes the selection, **F5** the Timeline, **F6** the Structure, **Ctrl+F** goes to the filter box, **Ctrl+E** clears the session.

A long capture stays quick: the session keeps the last 5,000 exchanges, the list gets only what changed (a new request is one row, not the list again), and sorting, filtering and scrolling 5,000 rows stay at the screen's frame rate.

### Sessions

The **Session** menu keeps captures: **Save session…** (also a button at the right of the filter bar) writes the session as a HAR file in the workspace's `debugger/` folder (which `.gitignore` keeps out of git); a saved session opens from the same menu (**Open** *name*) in a tab of its own beside the **Live capture** tab, which keeps capturing meanwhile: the grid, filters, Create flow and Save to collection work on the session on screen, and **Add to the live capture** in its bar copies its exchanges in. Session tabs work like the other tabs of the app (a preview tab first, kept per workspace); the Live capture tab can't be closed. **Import a HAR file…** opens a file from any tool (a browser's DevTools, Fiddler, Charles), and **Import a Fiddler session (.saz)…** opens Fiddler's own archives; **Export as HAR…** saves the session on screen anywhere, through the **Save as** dialog. The same session is behind the **down arrow** at the right end of the grid's bar: HAR with a click, JSON (the exchanges) or CSV (one row per exchange: time, method, URL, status, duration, size, type) from its **▾** ([Save and export results](/getting-started/save-and-export-results)). Either way the file is sanitized, with the **Redacted** mark: secrets are masked as the HAR is built, so there is no **Include secrets…**. While capturing, **AutoSave** writes the live session to `debugger/autosave.har` every minute, so a crash loses at most a minute. **Clear the session** (<kbd>Ctrl</kbd>+<kbd>E</kbd>; **Clear** in the filter bar) forgets it. Every **Save session…**, **Save to collection…** and **Create flow from selection…** also adds a **capture session** to History (*Kind ▸ Capture sessions*): how many exchanges, the hosts, through the proxy or the reverse proxy, and what they became; **Open** there opens it again (`testpion history list --kind capture --json`, MCP `history_list`). A session keeps about 5,000 exchanges (the oldest go in small blocks) and 200 MB of bodies: past that, the oldest exchanges lose their bodies first (their headers, sizes and timing stay, and the panes say so).

**Machine safety.** While the system proxy is TestPion's, the setting it replaced is kept in a private file; if TestPion is killed or crashes, the next start puts the old setting back (when it still points at TestPion and nothing is listening there), and quitting restores it before anything else. The AutoSave is not in the workspace (it can hold what every program on the computer sent): it lives in the app's data folder, tokens in it are masked by their shape (Authorization, Cookie, JWTs, `access_token`), and **Session ▸ Open ▸ autosave** still opens it. A saved session keeps your own masking choice.

Secrets (Authorization headers, API keys, passwords in bodies) are masked wherever the session is shown or saved; the proxy listens on this computer only unless you ask for the LAN.

### One-click tools

- **Breakpoints** (a split button in the filter bar): the button holds every request (a second click turns it off), the arrow chooses *Off*, *Every request*, *Every response*, *Only POST*, *Only errors* (responses with a status of 400 or more) or *Custom…* (the rule editor, for a breakpoint by domain, URL, method or status). It keeps one rule, **Auto breakpoint**, in the active profile, so it shows in the Rules tab like any other and the bar above the traffic still warns while it is on. When several exchanges are held, **Resume all** lets them go on. Terminal: `testpion debugger breakpoints errors --rules debugger/rules.json`; agents: `debugger_rules` with `action: breakpoints`, `held`, `resume`.
- **Pause** (the header, next to Stop): the proxy keeps forwarding and rules keep acting, but new traffic is not listed until **Resume**. A notice above the traffic says so. Terminal: `debugger capture --paused`, then `pause` and `resume` lines on its input; agents: `debugger_capture` with `action: pause` or `resume`.
- **Hide 304s** (a checkbox in the filter bar) leaves out the *Not Modified* answers; it is saved in filter presets.
- **Notes and marks**: right-click a row for **Add a note…** and **Mark** (a colour). The note shows in the **Comments** column (shown the first time you add one; the column menu hides it) and a marked row is coloured. Both are saved with the session: the note is the HAR entry's `comment`, the colour is in the entry's `_testpion` data. Terminal: `testpion debugger annotate session.har <id|#3> --note "…" --mark red`; agents: `debugger_exchange` with `action: annotate`.
- **Change this traffic** also offers *Disable caching*, *Remove all encodings*, *Ask for gzip*, **User agent** (Chrome, Firefox, Safari, iPhone, Android phone, Search bot) and *Require proxy sign-in (plain HTTP)*, each a rule for the row's domain. Require proxy sign-in answers a plain HTTP request that carries no proxy credentials with a 407, so the program asks for them (any user name and password pass; requests inside decrypted HTTPS are not asked). The same are in `testpion debugger presets` and the Presets list of the Rules tab.
- **Browsers started by the Debugger** run without HTTP/3 (Chromium `--disable-quic`, Firefox `network.http.http3.enable=false`), which would otherwise go around an HTTP proxy.

### The grid's power tools

- **Select matching** (**Edit ▸ Select matching…** in the filter bar): choose rows by conditions on the columns (*Status is at least 400*, *Domain contains api*, *Size is more than 200kb*, *Duration is more than 2s* …); every condition must hold. The dialog counts the matches before you select them. The selected rows are what **Delete**, **Save to collection**, **Create flow**, **Create RAG dataset** and **Resend** work on. **Edit** also has *Select all* (<kbd>Ctrl</kbd>+<kbd>A</kbd>), *Invert the selection* and *Select none*.
- **Command bar** (<kbd>Ctrl</kbd>+<kbd>K</kbd>, then type `!`): ten verbs, each a shortcut to something the Debugger already does. `?text` filters the list; `>200kb` and `<5kb` select larger or smaller responses; `=404` or `=4xx` selects a status; `@host` selects a domain; `select status>=400 and host~api` selects by a condition; `bp /orders` opens the breakpoint rule editor for a URL; `delete` removes the selected rows (asks first); `clear` clears the session (asks first); `hosts` opens the Structure panel. Only works while the Debugger is on screen.
- **Columns** (the columns icon at the right of the header): besides the usual ones there are **Caching**, **Content-Encoding**, **Client port**, **Protocol** and **TLS** (hidden until you show them), and **Add column from a header…** turns any request or response header (*X-Request-Id*, *Cache-Control*, *Server*) into a sortable column, saved per workspace. Up to 8 header columns; secret headers (Authorization, Cookie, API keys) show as `***`.
- **Group by** (the layers icon next to it): *None*, *Domain*, *Application* or *Connection*. Each group has a header line with its request count, how many failed and how many bytes; click it to collapse or expand the group, or use *Collapse all groups* / *Expand all groups*. Selecting a row with the arrow keys opens its group. The list stays as fast as without groups (the header lines are rows of the same virtual list).
- **Resend many times**: the row menu's **Resend** has *Resend 10 times*, *Resend the selected, in order* (select several rows first) and *Resend…*, a dialog for how many times (1 to 200), how many at once (1 to 20), the wait between sends and *Stop at the first failure*. The result is a table: how many were sent, the count of each status, the fastest, middle and slowest time and each send; every send is also in History. Sending several requests to a server that is not on this computer asks first.
- **A running program** (the **Capture** menu): the list of programs on this computer that hold network connections right now, busiest first. **Capture only** on one makes a rule on the Application column, so only what that program sends is listed (the crosshair of other tools, without dragging anything).

## Rules

The **Rules** tab is what the proxy does to matching traffic, in the order listed:

- **capture only** (when one is on) lists only what one of them matches; the rest still goes through;
- **ignore** (**Filter out**) hides it from the list (it still goes through);
- **highlight** colours the row: by host, URL, program, or by the response (a status class or code, slower than *n* ms, larger than *n* bytes), or by a condition on one column with its own colours, bold and whole row (the **Highlight rule** editor). A fresh profile highlights errors, server and client errors, slow and large responses;
- **modify** sets or removes request and response headers, replaces a body, adds a delay;
- **reply** answers without the server: a status, headers and a body (offline, a canned error, a mock);
- **redirect** sends the request to another host (and scheme): a staging API to a local one, a CDN to a mock;
- **breakpoint** pauses the request (before the server) or the response (before the program) in a dialog where you change the method, URL, status, headers or body, then **Continue**, or **Abort**. A held exchange goes on by itself after two minutes.

Hosts and URLs match by glob (`*.example.com`, `*/orders/*`) or by a /regular expression/; methods and the program's name narrow it. The first matching reply, redirect or breakpoint wins; header edits add up. **Presets** add the usual ones in one click (a header, CORS, no caching, a slow network, offline, a canned 200, a redirect to localhost, a breakpoint), filled in for the selected exchange's host; a row's **Rule** menu does the same from the traffic, including **Reply with this response from now on**. **What would happen to a URL** tells which rules act on it. The bar above the traffic says how many rules are active and when an exchange is held at a breakpoint.

Rules live in **profiles** (Offline, Slow network, Mock payments…) switched as one; the profiles are saved in the workspace's `debugger/rules.json`, committed with it, so a team shares them. The **Presets** menu next to the filters saves and recalls filter presets (the text, host, method, status and Bookmarked; not the chips). **Compare** on an exchange, then a click on another, shows the two side by side: status, headers, body.

## Record a flow

Select rows and pick **Create flow from selection…** (right-click, or the toolbar's **Flow** menu), or **Flow ▸ Record a flow…** to record what you do next until **Stop recording**: the exchanges become a test flow, with the tokens and ids that pass from one response into a later request extracted and passed as `{{variables}}`, static assets and analytics left out, and secrets turned into variables to set in an environment. The dialog shows the steps and the links it found before anything is written; **Create** opens the flow in the designer. See [Record a flow](/test-runner/integration-testing#record-a-flow).

## Save to a collection

**Save to collection…** (on the right-click menu, and **Flow ▸ Save selection to collection…**) keeps the selected exchanges as saved requests: in a new collection or added to one (in a folder), a folder per host, per first path segment, or none. Each address becomes a collection variable (`{{baseUrl}}`); tokens, cookies, API keys and passwords become variables to set in an environment (their values are never saved); a value a later request took from a response (a token, an id) is kept in a collection variable by the test script of the request that returned it, so sending them by hand in order works. From a terminal: `testpion debugger capture --save-collection [name]` (or `--to <collection>`, `--group host|path|none`) saves what was captured when you stop; agents: `debugger_save_to_collection`.

## Capture traffic for one API

A client that can't use a proxy (a front end with a configurable base URL, a mobile build, a test suite) can point at a local address instead: **Capture ▸ Capture traffic for one API…** forwards to the API you give and lists what passes, and **Save** keeps it as a collection with the responses as examples. The status bar's **Tools ▸ Capture traffic for one API…**, the command palette (*Capture traffic for one API…*) and the **Capture traffic into a collection** button in the Collections view's header open the same dialog in the Debugger. No certificate is needed, because the client talks plain HTTP to TestPion.

What the reverse proxy forwards is in the Debugger's grid too, next to the proxy's traffic: each row has a **reverse** badge and *Reverse proxy* in the **Application** column (pick it in the Application filter to see only those). Everything works on them as on any row: select, filter, **Create flow from selection…**, **Save to collection…**, **Export as HAR…**, Save session and AutoSave, and History's capture sessions (they say *reverse proxy*). **Show in Debugger** in the dialog goes there; the dialog's **Clear** starts its own list again (the rows stay in the Debugger, whose **Clear** removes them). See [Record traffic](/api-testing/recording) for the details and the `testpion record` command.

<figure class="aps-screenshot">
  <img src="/images/debugger-sessions.jpg" alt="The HTTP Debugger with two session tabs, Live capture and the saved session clinic-morning; the live capture holds five requests through the reverse proxy, each marked reverse, one selected with its request and response" width="1440" height="900" loading="lazy">
</figure>

## From the terminal and for agents

```bash
testpion debugger capture                 # the proxy on 8899; every exchange printed as it happens (`testpion debug` alone is the same)
testpion debugger capture -p 9000 -o session.har --json   # a JSON line ({ type, data }) per exchange, for scripts
testpion debugger capture --system-proxy --decrypt --yes  # the whole computer and HTTPS, like Capture all traffic; Ctrl+C puts the setting back
testpion debugger capture --system-proxy --dry-run        # say what it would do, change nothing
testpion debugger capture --save-collection "Captured"    # on Ctrl+C, the exchanges become requests in a new collection
testpion debugger capture --rules debugger/rules.json     # the workspace's rules (re-read when the file changes)
testpion debugger capture -w .                            # gRPC decoded with this workspace's .proto files
testpion debugger certificate --json                      # where the root is, its fingerprint, trusted or not (known: false when this computer cannot tell)
testpion debugger certificate --install --yes             # trust it (the system may ask); --remove takes it out; --dry-run only says
testpion debugger exchanges session.har --where "status>=400 and size>200kb" --column response:x-request-id --json   # Select matching, with header columns
testpion debugger exchanges session.har --group-by domain --json                                                   # Group by: counts, bytes, failures
testpion debugger replay session.har '#3' --times 20 --concurrency 4 --json    # Resend many times; --dry-run says what would go, --yes for a host that is not yours
testpion debugger snippet session.har '#3' --lang powershell                   # Copy as: curl, powershell, fetch, httpie, python …
testpion debugger programs --json                                              # the running programs with connections (the names a Capture only rule uses)
```

`--system-proxy` and `--install` / `--remove` change this computer, so without `--yes` a terminal asks and a run that cannot ask (CI, `--non-interactive`) refuses and says what it would do.

AI agents have the same through the workspace's MCP server: `debugger_capture` (start / stop / status / clear; `decrypt` for HTTPS, `system_proxy` for the whole computer, which asks the user), `debugger_certificate` (info, install, remove; install and remove ask the user), `debugger_no_decrypt` (the hosts kept as tunnels), `debugger_exchanges` (the list, with filters; `deep` searches bodies; `hide_tunnels` leaves the tunnels out; `include` adds `params`, `cookies` or `summary` to each exchange, and the advice for a failure), `debugger_exchange` (one, with bodies), `debugger_session` (save the session as HAR, or open a HAR file), `debugger_rules` (list with each rule's hits, presets, add, enable, remove; kinds include `only` for Capture only and a `where` condition on a column with a `style`: an agent can take an API offline, slow it down, redirect it or narrow the capture while it tests), `debugger_stats`. For the grid's tools: `debugger_exchanges` takes `where` (`status>=400 and host~api and size>200kb`; fields status, method, host, url, type, size, time, app, ip, user, pid, note, mark, kind; operators `= != > >= < <= ~ !~ ^= $=`) and `columns` (`response:cache-control`); `debugger_exchange` with `action: snippet` writes an exchange as cURL, PowerShell, fetch or HTTPie; `debugger_replay` sends exchanges again (`times` up to 200, `concurrency` up to 20, `confirm_remote` for a host that is not on this computer); `debugger_programs` lists the running programs. An agent can start the proxy, run a program against it and read what it did. `flow_from_exchanges` turns captured exchanges (or a HAR file) into a flow file; `testpion flow from-har <file.har>` does it from the terminal.

## Coming next

Every feature of HTTP Debugger and Fiddler Everywhere listed in `planning/http-debugger.md` is in; what comes next is in that file. The plan is `planning/http-debugger.md` in the repository.

:::
