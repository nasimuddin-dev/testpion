# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories ("Report a vulnerability") rather than a public issue. Include reproduction steps and the affected version. We aim to acknowledge reports within 3 business days.

## Security model

- **Secrets** are encrypted with the OS credential store and never written to workspace files, exports, logs, traces or reports. If no secure backend is available, the app refuses to store a secret instead of falling back to plain text.
- **Redaction** covers configurable sensitive field names and every secret value registered during a run.
- **Scripts** run in a QuickJS WebAssembly sandbox with no filesystem, network or process access and with CPU and memory limits.
- **Electron hardening:** `contextIsolation`, a sandboxed renderer, no `nodeIntegration`, a strict CSP, blocked navigation and window creation, and a narrow RPC-only preload.
- **Trust** is decided by the user, per workspace and per computer, and kept outside the workspace: stdio MCP servers and secret-manager commands, the hosts a workspace's scripts may send to, and whether they may read secrets. See [docs/security/trust.md](docs/security/trust.md).
- **Local servers and the network:** the HTTP Debugger on the LAN needs pairing and cannot reach this computer's loopback; the recorder, mock server, webhooks and bridge refuse a foreign `Host`; files on the host are reachable through one gate that a shared server turns off.
- **Agents (MCP):** destructive and spending tools need a confirmation code the user sees, sends and AI calls have session budgets, AI calls run under default caps.
- **Supply chain:** CI pins actions by commit, fails on high advisories in production dependencies (`scripts/audit-gate.mjs`), and releases sign `SHA256SUMS.txt` with Sigstore.
- **Load testing** is restricted to local and private hosts unless you explicitly opt in, and production environments are blocked by default.
- **Telemetry** is not implemented.

The browser development bridge (`npm run dev:web`) binds to `127.0.0.1` only and requires a per-process token. It is intended for development, not production use.
