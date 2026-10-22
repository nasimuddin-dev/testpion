---
title: "Trust and permissions"
description: "What a workspace from git, an import or a teammate may do on your computer: programs, scripts, the network, files, and agents."
---

::: v-pre

# Trust and permissions

A workspace comes from somewhere: a git repository, an import, a teammate, a shared session. Opening it must not run its author's code with your permissions. TestPion asks before it does anything beyond reading and sending the requests you pick, and it keeps your answers **on this computer, outside the workspace**, so a repository cannot ship its own trust.

## Where your answers live

Decisions are kept in the app's data folder (`~/.testpion/trust/<hash of the workspace's real path>.json`), one file per workspace. A `.local/trust.json` inside a workspace folder (written by versions before 0.55) is **ignored**: you are asked again the next time it matters. That is the one-time migration, and it never trusts anything silently. Imports, bundles and zip files refuse any path under `.local/`.

**Settings ▸ Privacy & security ▸ Script trust** lists what the open workspace was allowed (secret reads, hosts, programs) with a **Forget** button for each and **Forget everything**. On the command line: `testpion trust list --json` and `testpion trust forget [--host h | --secrets | --all]`. An agent can read the list with the MCP tool `trust_status`, never change it.

## Programs

A stdio MCP server, or a secret-manager reference (`op://…`, `vault://…`), is a program TestPion starts. The first time, it shows the exact command line: **Run once**, or **Always for this workspace**. An agent over MCP cannot grant it.

## Scripts

Scripts run in a sandbox with no files, processes or network of their own. Two things reach out through the engine, so both need your say, per workspace:

- **Secrets.** Until you allow it, a script sees every variable **except the ones marked secret** (`tp.environment.get`, `tp.vault.get`, `tp.variables.toObject()`). Requests still use the secrets: `{{token}}` in a header resolves as always.
- **Hosts.** `tp.sendRequest` and `tp.execution.runRequest` may reach the host of the request being sent, this computer's loopback, and the hosts you allowed. Any other host is refused with a message naming it, nothing is sent, and the window offers **Allow…** (allow `*` to allow every host).

The command line and CI have no one to ask: pass `--trust-scripts` to `testpion run`, `test`, `send`, `load`, `run-collection`, `eval run` and the other sending commands, or set `TESTPION_TRUST_SCRIPTS=1`. Without it a refused script logs what it needed. The MCP server for agents follows the same list; an agent cannot add to it.

## The HTTP Debugger on the network

**Capture a phone or another computer** makes the proxy listen on the network. It is not an open proxy:

- A device must be **paired**: scan the QR code (it opens the proxy page with a one-time secret and pairs that device's address for 8 hours), or give the proxy any user name and the **password** shown in the dialog (iOS, curl, `HTTP_PROXY=http://x:<password>@<ip>:<port>`).
- A paired device cannot reach **this computer's** loopback or link-local addresses through the proxy (`127.0.0.1`, `localhost`, `169.254.169.254`, `fe80::`): your local servers and cloud metadata stay out of reach.
- The pairing secret is new every time the proxy starts.

## Local servers

The recorder, the mock server, flow webhooks and the development bridge answer only to a `Host` of `localhost`, `127.0.0.1` or `::1` (a web page that points its own name at your computer is refused), the recorder gives CORS and credentials only to pages from this computer or origins you list, and never combines credentials with `*`.

## Files on this computer

Pointing at a file on this computer (a client certificate, a data file, a folder to clone into or open, a terminal's working folder) is what a desktop app is for. On a shared server it must not be: the host has a `localFiles` capability (`app.info` ▸ `capabilities`), and every RPC that takes a path on the host goes through one gate that, with the capability off, only allows the user's own folder. A server also ignores the *Environment variables* allow-list of Settings, so `{{$env.NAME}}` can never read the server's own environment.

## Files TestPion writes

`secrets.json`, current values, the application log and saved Debugger sessions are readable by your account only (mode `0600`, folders `0700`). On Windows the same files and their folders get an ACL with inheritance removed and a single entry, your account (full control), set with `icacls` the first time each is written; it is best effort (if `icacls` cannot run, saving goes on and the file keeps your profile folder's permissions, which are private to your account by default). On Linux without a Secret Service or KWallet, Electron falls back to a key that is part of its source code; TestPion treats that as **no secure store** and refuses to save a secret until you install a keyring, or start TestPion with `TESTPION_ALLOW_WEAK_SECRET_STORE=1` and accept it.

## Agents (MCP)

See [Agents over MCP](/ai-testing/mcp-server#confirmation). In short: a tool that deletes, overwrites or spends needs a **confirmation code** you give the agent when the agent's app cannot ask you; sending requests and AI calls stop at a budget per session; AI calls from agents have default caps (`$5` a day, 50,000 tokens a call, 1,000,000 tokens a day) until you set your own in Settings ▸ AI assistant ▸ Limits.

## The app itself

The installed app ignores `TESTPION_CAPTURE_SCRIPT` unless it is started with `--testpion-capture`, grants its page only notifications and the clipboard (no camera, microphone or location), carries a security policy without development origins, and checks that `app.asar` has not been changed (ASAR integrity). Releases are built by GitHub Actions with actions pinned by commit; `SHA256SUMS.txt` is signed with Sigstore ([Download](/download#verify-a-download-optional)); CI fails on a high or critical advisory in a production dependency.

## Known limits

- Installers are not code-signed yet (Windows SmartScreen and macOS Gatekeeper ask on first launch). The release workflow signs by itself once the certificate secrets exist: [Code signing](/security/code-signing).
- `node-forge` has an advisory about signature **verification**; TestPion only creates and reads certificates with it (listed in `scripts/audit-allow.json` with a date to look again).
- `@lydell/node-pty` is a pre-release native module (the prebuilt N-API package of node-pty); it is pinned to one version and kept outside `app.asar`.

:::
