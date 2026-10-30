---
title: "Installation"
description: "Install the TestPion desktop app on Windows, macOS or Linux, or the testpion CLI."
---

# Installation

::: tip In short
Download the installer for your system, run it and open TestPion. It takes about two minutes. The command-line tool is optional and needs Node.js.
:::

## Desktop app

Download the installer for your system from the [download page](/download), then follow the guide:

- [Windows](/installation/windows) — installer or portable `.exe`
- [macOS](/installation/macos) — `.dmg` for Apple Silicon and Intel
- [Linux](/installation/linux) — AppImage, `.deb` or `.rpm`

## Command-line runner

For CI servers and scripts, install the [`testpion` CLI](/installation/cli).

## Try it with the demo servers

The repository includes local demo servers (REST, a SOAP service, GraphQL, an OpenAI-compatible mock LLM, WebSocket, Socket.IO, gRPC, an MQTT broker, a Kafka broker and an MCP server) and an example workspace whose regression suite runs 29 tests:

```bash
git clone https://github.com/nasimuddin-dev/testpion.git
cd testpion && npm ci && npm run build
node examples/servers/demo-servers.mjs
```

Open the `examples/veterinary-workspace` folder from the workspace menu (**Open folder**, or **File ▸ Open Workspace Folder…**), then continue with [your first request](/getting-started/first-request).

## Where data lives

| Item | Location |
|---|---|
| Settings, logs, encrypted secrets | `~/.testpion/` (override with `TESTPION_HOME`) |
| Workspaces | `~/.testpion/workspaces/<name>/`, or any folder you open (for example inside a git repo) |

## Next

- [Start here](/getting-started/start-here): pick the path that fits you.
- [Your first request](/getting-started/first-request): send a request in about five minutes.
- [Check an AI answer](/getting-started/check-an-ai-answer): no key needed for the first try.
