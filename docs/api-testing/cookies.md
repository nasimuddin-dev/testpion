---
title: "Cookies"
description: "The workspace cookie jar: cookies from responses are kept and sent with later requests, managed in the Cookies dialog, in scripts and from the CLI."
---

::: v-pre

# Cookies

TestPion keeps a **cookie jar** for each workspace, like a browser or Postman. When a response sets a cookie, it is stored. Later requests to a matching URL send it automatically. Logging in to a cookie-based API once is enough for the requests that follow.

## How cookies are matched

The jar follows the browser rules in RFC 6265:

- **Domain.** A cookie without a `Domain` attribute is only sent to the exact host that set it. With `Domain=example.com` it is also sent to subdomains such as `api.example.com`. A server cannot set cookies for another domain or for a bare top-level domain.
- **Path.** A cookie is sent to its path and everything below it. `Path=/session` matches `/session/me` but not `/sessions`.
- **Secure.** `Secure` cookies are only stored from, and sent to, HTTPS URLs. `localhost` and `127.0.0.1` count as secure, so local development servers work.
- **Expiry.** `Max-Age` wins over `Expires`. An expired cookie is removed, which is how servers log you out (`Max-Age=0`). Cookies without either are session cookies. They are kept until you delete them.
- **Redirects.** Cookies set by every hop of a redirect are kept. A login endpoint that answers `303 See Other` with a session cookie works the same as in a browser. The `Authorization` header is not forwarded to a different origin.

When a request has its own entry in the **Cookies** tab with the same name as a jar cookie, the request's value is used.

## WebSocket and MCP connections

The jar is shared beyond HTTP requests, so a session you log in to with a request works for sockets and MCP servers too:

- **WebSocket:** the handshake sends the jar's cookies for the socket URL (`ws://` uses the cookies of `http://`, `wss://` those of `https://`). A `Cookie` header you set on the connection replaces them.
- **MCP servers over Streamable HTTP or SSE:** every request to the server sends the matching cookies, and cookies the server sets are stored in the jar.

## The Cookies dialog

Click the **cookie button** next to **Send** to open the Cookies dialog. It opens on the domain of the current request.

- The left column lists every domain in the jar, with the number of cookies.
- Click a cookie to edit its name, value, path, expiry, `Secure`, `HttpOnly` and whether subdomains get it.
- **Add cookie** creates a cookie by hand. Use **+** next to *Domains* to add a domain that has no cookies yet.
- **Clear domain** removes the cookies of the selected domain. **Clear all** empties the jar.

The response's **Cookies** tab still shows exactly what that response set.

## Where cookies are stored

Cookie values are often session tokens, so the jar is treated like a secret:

- It is kept **on this machine only**, encrypted with the OS credential store (Windows DPAPI, macOS Keychain or Linux Secret Service).
- It is **never written to workspace files**, so committing a workspace to git never leaks a session.
- When no credential store is available, the jar lives in memory until the app closes. The dialog says so.
- Cookie and `Set-Cookie` headers are redacted in traces, logs and history like other credentials. See [Privacy and redaction](/security/privacy).

## In scripts

`tp.cookies` holds the cookies for the current response: the jar's cookies for the response URL plus whatever the response set.

```js
tp.test("Session cookie is set", () => {
  tp.expect(tp.cookies.has("vet_session")).to.be.true;
});
```

`tp.cookies.jar()` reads and changes the workspace jar, with Postman's method names. The callbacks run immediately, and each method also returns its value:

```js
const jar = tp.cookies.jar();
const url = tp.request.url.toString();

jar.get(url, "vet_session", (error, value) => tp.variables.set("session", value));
jar.getAll(url, (error, cookies) => console.log(cookies.length));
jar.set(url, "feature_flag", "beta");  // host-only cookie on the URL's host, path /
jar.unset(url, "feature_flag");
jar.clear(url);                         // every cookie of that host
```

Changes are applied when the script ends, so the request that follows a pre-request script already sees them. Unlike Postman, there is no domain allowlist to set up.

## In runs and the CLI

The requests of one run (the test runner, the Collection Runner, `testpion run-collection`) share one jar. In the desktop app, that is the workspace jar. The CLI starts every run with an empty jar and never writes cookies anywhere unless you ask:

```bash
# log in once and save the cookies
testpion run-collection login.postman_collection.json --export-cookie-jar cookies.json

# reuse them in another run
testpion run-collection api.postman_collection.json --cookie-jar cookies.json
```

`--cookie-jar` also reads the cookie files that Newman's `--export-cookie-jar` writes. The exported file contains cookie values in plain text, with file mode `600` on macOS and Linux. Keep it out of git.

:::
