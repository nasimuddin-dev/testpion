---
title: "Authentication"
description: "API key, Basic, Bearer, JWT, OAuth 1.0, OAuth 2.0 (client credentials, password, authorization code with PKCE), AWS Signature v4, Digest, custom headers and mTLS."
---

::: v-pre

# Authentication

| Type | Notes |
|---|---|
| API key | In a header or query parameter. |
| Basic | `Authorization: Basic …` |
| Bearer | Optional custom prefix. |
| JWT | Signed locally with HS256/384/512 from a JSON payload, with optional `exp`. |
| OAuth 2.0 | Client credentials, password, or authorization code with PKCE. The authorization-code flow opens your browser and captures the redirect on `127.0.0.1`; set **Callback URL** to the redirect registered with the provider (a loopback URL such as `http://localhost:8080/callback`). **Client authentication** sends the client id and secret in the body or as a Basic header. Tokens are cached in memory; an expired one is renewed with its refresh token (no browser) when the provider gave one. **Forget tokens** drops the cached ones. |
| AWS Signature | AWS Signature Version 4 for API Gateway, S3, Lambda function URLs and any AWS API: access key, secret key, region, service name and, for temporary credentials, a session token. The request is signed when it is sent (after pre-request scripts), over the method, URL, headers and body; file uploads are sent as `UNSIGNED-PAYLOAD`, which S3 accepts. |
| OAuth 1.0 | OAuth 1.0a (RFC 5849): consumer key and secret, access token and token secret, HMAC-SHA1 / HMAC-SHA256 / PLAINTEXT. Each request is signed when it is sent (method, URL, query and form fields) with a fresh nonce and timestamp; the parameters go in the `Authorization` header or the query string. |
| Digest | HTTP Digest (RFC 7616): TestPion sends the request, answers the server's `401` challenge and sends it again. MD5, SHA-256 and their `-sess` variants with `qop=auth`. |
| Custom headers | Any set of headers. |
| mTLS | Configured in request **Settings** (certificate, key, optional CA). |
| NTLM | Windows challenge-response (NTLMv2): user name, password, domain and workstation. |
| Hawk | Hawk request signing: id, key and algorithm. |
| Akamai EdgeGrid | Akamai API signing: client token, client secret, access token and host. |
| Inherit | Uses the auth from the nearest folder or collection. The Authorization tab says which one and what it is (for example *Bearer token {{accessToken}}, from folder "Admin"*), with **Override** to give the request its own. |

**Get token** (OAuth 2.0): runs the grant now, with the active environment, and shows whether the token call works, when the token ends, its scope and the token masked, with the token endpoint's own error when it fails. From a terminal: `testpion auth token <collection> [request] --json`; agents: the `auth_token` MCP tool.

A copied cURL command with `--digest -u user:password` or `--aws-sigv4 "aws:amz:<region>:<service>" -u <access key>:<secret key>` imports as Digest or AWS Signature auth, and both round-trip through Postman collections.

Every credential field accepts `{{variables}}`. Keep credentials in [secret environment variables](./environments.md#secrets) so they never end up in workspace files. Resolved credentials are automatically registered for redaction.

:::
