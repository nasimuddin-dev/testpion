---
title: "API security checks"
description: "Find secrets typed into requests, secrets in URLs and plain http, and check responses for security headers."
---

::: v-pre

# API security checks

## Security review of a collection

**Tools ▸ Security review…** in a collection's header lists what in its requests weakens security, most severe first. Click a finding to open the request.

| Severity | Finding |
|---|---|
| high | A token, password, API key or client secret typed into auth, a header or a JSON body instead of kept in a [secret variable](/api-testing/environments#secrets) |
| high | Credentials (Basic, Bearer, API key …) sent over plain http to another computer |
| medium | A secret sent in the query string, where proxies and server logs keep it |
| medium | Plain http to a host that isn't local |
| medium | TLS certificate verification turned off for a request |

The review also checks **variables**: a `{{variable}}` a request uses that the active environment, the collection, its folders, the workspace and the globals don't define, and that no script sets, is reported, and so is one that's set only by a script of a request that runs later (a common cause of a run that fails on its first request).

From the terminal, and in CI:

```bash
testpion lint "My API" -w . -e Staging         # prints the findings (variables checked against Staging)
testpion lint "My API" -w . --fail-on high     # exit 1 when there is a high finding
testpion lint api.postman_collection.json --json
```

It also flags HTTPS hosts of the collection whose TLS certificate (as recorded when their responses came back) expires within 30 days, or has expired. AI agents use the MCP tool `security_review`. Values are never printed or returned.

## Security headers of a response

Add the **Security headers** check to a request's Tests (or `type: security-headers` in a test file). It fails when the response:

- is served over https without `Strict-Transport-Security`,
- has no `X-Content-Type-Options: nosniff`,
- is an HTML page without `X-Frame-Options` or a CSP `frame-ancestors` (clickjacking),
- allows any origin (`Access-Control-Allow-Origin: *`) together with credentials,
- reveals the server's version (`Server: nginx/1.18.0`, `X-Powered-By` …).

List the items to skip in the check's values: `hsts`, `nosniff`, `frame`, `cors`, `server-version`.

```yaml
assertions:
  - type: security-headers
    values: [server-version]
```

These are quick checks, not a security audit or a penetration test.

:::
