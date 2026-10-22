---
title: Install on Windows
description: Install TestPion on Windows 10 or 11 with the installer or the portable app. Requirements, SmartScreen, per-user or all-users install, silent install and uninstalling.
---

# Install TestPion on Windows

## Requirements

- Windows 10 or Windows 11, 64-bit (x64).
- About 400 MB of free disk space.
- Administrator rights only if you install for all users.

## Download

<Downloads only="windows" />

## Install

1. Double-click `TestPion-<version>-windows-x64-setup.exe`.
2. The installer isn't code-signed yet, so Windows SmartScreen may show **"Windows protected your PC"**. Click **More info**, then **Run anyway**. Your browser may also ask whether to keep the file; choose **Keep**.
3. Choose who to install for:
   - **Only for me:** installs to `%LOCALAPPDATA%\Programs\TestPion` without administrator rights.
   - **Anyone who uses this computer:** installs to `C:\Program Files\TestPion`. Windows asks for administrator approval.
4. Optionally change the folder, then click **Install** and **Finish**.

The app gets a Start menu entry and a desktop shortcut named **TestPion**, and appears under **Settings → Apps → Installed apps**.

## Portable version

`TestPion-<version>-windows-x64-portable.exe` runs without installing. Put it anywhere, for example on a USB stick, and double-click it. It starts a little slower than the installed app because it unpacks itself on each launch.

## First launch

Open **TestPion** from the Start menu. On first launch it creates a workspace called **My Workspace** in `%USERPROFILE%\.testpion\workspaces`. Continue with [your first request](/getting-started/first-request).

Secrets (tokens, API keys, secret variables) are encrypted with **Windows DPAPI**, tied to your Windows account.

## Silent install (IT administrators)

```powershell
.\TestPion-<version>-windows-x64-setup.exe /S                 # current user
.\TestPion-<version>-windows-x64-setup.exe /S /allusers       # all users (run elevated)
.\TestPion-<version>-windows-x64-setup.exe /S /D=C:\Tools\TestPion  # custom folder (must be last)
```

## Updating

TestPion checks GitHub for a newer version a few seconds after it starts. When there is one, it asks: **Update now** downloads the new version and restarts TestPion; **Later** asks again next time; **Skip this version** stops asking about that version. **Help ▸ Check for Updates** checks at any time, and **Settings ▸ About** can turn the check off.

If the window can't show the question (for example it failed to open properly), TestPion asks with a regular Windows dialog instead, so a fixed version can always be installed.

The portable version doesn't update itself: it opens the download page. You can also download and run a newer installer by hand; it upgrades in place and keeps your workspaces, settings and secrets.

## Uninstall

Use **Settings → Apps → Installed apps → TestPion → Uninstall**. Your workspaces and settings in `%USERPROFILE%\.testpion` are kept; delete that folder to remove them too.
