---
name: reproduce-installed-bug
description: Reproduce a bug the owner sees in their installed TestPion (blank window, crash, wrong behaviour) with a copy of their data, never their real profile. Use when a report cannot be reproduced from source.
---

# Reproduce a bug in the installed app

The installed app: `%LOCALAPPDATA%\Programs\TestPion\TestPion.exe`. Its data: `~/.testpion` (log:
`~/.testpion/logs/app.log`, which says which workspace was opened and when), browser profile `%APPDATA%\Protolens`
(legacy name, kept on purpose). First check the version the owner runs: an old version is often the whole answer.

1. **Copy, never touch the originals:** copy `~/.testpion` to a scratch `home/` and `%APPDATA%\Protolens` to
   `home/electron-profile` (delete `SingletonLock` / `lockfile` in the copy).
2. **Point the copy at itself:** rewrite `home/settings.json` so `lastWorkspace` / `workspacePaths` point at copied
   workspaces. Do it with a Python file (written with the Write tool), not a heredoc: Windows backslashes break heredocs.
3. **Run in capture mode** with a script of steps:
   ```bash
   TESTPION_HOME=<home> TESTPION_CAPTURE_SCRIPT=<steps.cjs> "$LOCALAPPDATA/Programs/TestPion/TestPion.exe" --testpion-capture
   ```
   (an installed build ignores the variable unless started with `--testpion-capture`; or `npx electron apps/desktop` after `npm run build` to try the fix from source). Capture mode uses
   `<home>/electron-profile`, skips the single-instance lock and calls `module.exports = async (win) => {…}` with the window.
   The e2e harness (`apps/desktop/e2e/harness.cjs`) is a ready example: set `E2E_PLAN` / `E2E_OUT` and use it as the capture script.
4. **Evidence:** `win.webContents.on('console-message')`, `capturePage()` screenshots, and for stack traces
   `webContents.debugger.attach()` + `Runtime.enable` + `Runtime.exceptionThrown`, then `reload()`.
5. Once fixed, add the scenario as an e2e step (ui-regression skill) so it cannot come back.
