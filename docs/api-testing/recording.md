---
title: "Record traffic"
description: "Put TestPion between a client and an API, see every request and response, and save them as a collection to replay, test or mock."
---

::: v-pre

# Record traffic

TestPion can sit between your app and an API as a small reverse proxy on your computer. Point the app at the local address instead of the API, use it as usual, and every request and response shows up in TestPion. Save the recording as a collection: each request becomes a saved request with its response as an [example](/api-testing/collections#examples), ready to replay, turn into tests, or serve from a [mock server](/api-testing/mock-servers).

It's a quick way to document an API you only know through a front end, to reproduce what a browser app sends, or to build a mock from real traffic.

To capture a program that can use an HTTP proxy (a browser, a terminal, a whole computer, a phone) instead, use the [HTTP Debugger](/api-testing/http-debugger): it also turns what it captured into a collection (**Save to collection…**) or a test flow ([Record a flow](/test-runner/integration-testing#record-a-flow)).

## In the app

In the app, the reverse proxy is a capture mode of the [HTTP Debugger](/api-testing/http-debugger#reverse-proxy-for-one-api): open **Debugger** (the rail's **More…**, or <kbd>Ctrl</kbd>+<kbd>K</kbd> ▸ *Go to Debugger*) and choose **Capture ▸ Reverse proxy for one API…**. The status bar's **Tools ▸ Reverse proxy for one API…**, the command palette (*Capture: Reverse Proxy for One API…*) and the **Capture traffic into a collection** button in the Collections view's header open the same dialog.

1. Enter the API's base URL, for example `https://api.example.com`, and optionally a local port. Click **Start recording**.
2. TestPion shows (and copies) the local address, such as `http://127.0.0.1:52308`. Use it in your app instead of the API's base URL.
3. Requests appear as they happen: method, path, status and time.
4. Enter a name under **Save as collection** and click **Save**. **Stop** ends the recording; **Clear** empties the dialog's list.

The recorded requests are also rows of the Debugger's grid (marked **reverse**, *Reverse proxy* in the Application column): **Show in Debugger** goes there, to filter them, make a flow of them, save some of them to a collection or export them as HAR. Each save in the app is a capture session in History (*Kind ▸ Capture sessions*, `testpion history list --kind capture`); `testpion record` doesn't add one.

The saved collection has a `baseUrl` variable set to the API. Requests are named after their method and path and grouped by the first path segment; a repeated request keeps its other responses as more examples. Browser noise (cookies, `sec-*` headers, `accept-language` …) is left out.

**Secrets never land in the collection.** Tokens, API keys, passwords and similar values in headers, query parameters and form bodies are replaced by `{{variables}}`. The message after saving lists them, so you can add them as secret environment variables.

## From the terminal

```bash
testpion record https://api.example.com --port 8080 -w my-workspace --collection "Recorded"
# Recording https://api.example.com
# Point your client at http://127.0.0.1:8080 (instead of https://api.example.com). Ctrl+C stops and saves the recording.
# 200 GET    /v1/pets?limit=10  84 ms
# 201 POST   /v1/pets  120 ms
```

Without `-w` the exchanges are only printed. `--jsonl` prints a JSON line per event as it happens, then the result envelope, for scripts and AI agents; `-q` prints nothing per exchange.

## Good to know

- The proxy listens on `127.0.0.1` only, so nothing outside your computer can use it.
- Browser apps work: CORS preflight requests are answered by the proxy, redirects that point to the API are rewritten to the proxy, and cookies are adjusted (no `Domain`, no `Secure`) so the browser sends them back to the proxy.
- HTTPS APIs work, because your app talks plain HTTP to the proxy and the proxy talks HTTPS to the API. WebSocket upgrades are not recorded.
- Bodies of up to 256 KB are recorded; bigger ones are still forwarded in full. Binary bodies are recorded as their size and type.

:::
