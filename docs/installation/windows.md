---
title: Install on Windows
description: Install TestPion on Windows 10 or 11 with the User Installer (no administrator rights) or the System Installer, or run it from a .zip without installing. Portable mode, SmartScreen, silent install, updating and uninstalling.
---

# Install TestPion on Windows

## Requirements

- Windows 10 or Windows 11, 64-bit (x64).
- About 400 MB of free disk space.
- No administrator rights for the User Installer, the `.zip` or the portable `.exe`. Only the System Installer needs them.

## Download

<Downloads only="windows" />

## Which download?

| Download | Installs for | Administrator rights | Updates itself |
|---|---|---|---|
| **User Installer** `…-windows-x64-setup.exe` | You only, in `%LOCALAPPDATA%\Programs\TestPion` | No | Yes |
| **System Installer** `…-windows-x64-system-setup.exe` | Everyone who uses the computer, in `C:\Program Files\TestPion` | Yes | Yes, with administrator approval each time |
| **.zip** `…-windows-x64.zip` | Nobody: unpack and run | No | No: it tells you and opens the download page |
| **Portable .exe** `…-windows-x64-portable.exe` | Nobody: one file | No | No: it tells you and opens the download page |

Take the **User Installer** unless you have a reason for another one. On a computer where you can't install software, take the **.zip**.

## Install

1. Double-click the installer you downloaded.
2. The installers aren't code-signed yet, so Windows SmartScreen may show **"Windows protected your PC"**. Click **More info**, then **Run anyway**. Your browser may also ask whether to keep the file; choose **Keep**.
3. The System Installer asks for administrator approval here. The User Installer doesn't.
4. Optionally change the folder, then click **Install** and **Finish**.

The app gets a Start menu entry and a desktop shortcut named **TestPion**, and appears under **Settings → Apps → Installed apps**.

A computer with TestPion installed for everyone and no copy of your own: the User Installer updates that installation (Windows asks for approval) instead of adding a second copy.

## Run without installing

**The .zip.** Unpack `TestPion-<version>-windows-x64.zip` into a folder you can write to, for example `Documents\TestPion`, and double-click `TestPion.exe`. Nothing is installed and nothing is added to the Start menu. It starts as fast as an installed copy.

**The portable .exe.** `TestPion-<version>-windows-x64-portable.exe` is one file: put it anywhere and double-click it. It starts a little slower because it unpacks itself on each launch, and some company computers block programs that do that; use the .zip there.

Both keep your workspaces and settings where an installed copy does (`%USERPROFILE%\.testpion`), unless you turn on portable mode.

### Portable mode

Create a folder named `data` next to `TestPion.exe` (the .zip) or next to the portable `.exe`. From the next start, that copy keeps **everything** in it: workspaces, settings, saved secrets and the window's own state. Nothing is written to your profile folder, so the whole folder can live on a USB stick or a network drive.

- To move to a newer version, unpack the new .zip and move the `data` folder into it.
- Saved secrets are encrypted for your Windows account. On another computer or account the `data` folder opens, but secret values have to be entered again.
- Remove the `data` folder (or rename it) to go back to the usual places.

## First launch

Open **TestPion** from the Start menu. On first launch it creates a workspace called **My Workspace** in `%USERPROFILE%\.testpion\workspaces`. Continue with [your first request](/getting-started/first-request).

Secrets (tokens, API keys, secret variables) are encrypted with **Windows DPAPI**, tied to your Windows account.

## Silent install (IT administrators)

```powershell
.\TestPion-<version>-windows-x64-setup.exe /S                        # current user, no administrator rights
.\TestPion-<version>-windows-x64-system-setup.exe /S                 # all users (run elevated)
.\TestPion-<version>-windows-x64-setup.exe /S /D=C:\Tools\TestPion  # custom folder (must be last)
```

## Updating

TestPion checks GitHub for a newer version a few seconds after it starts. When there is one, it asks: **Update now** downloads the new version and restarts TestPion; **Later** asks again next time; **Skip this version** stops asking about that version. **Help ▸ Check for Updates** checks at any time, and **Settings ▸ About** can turn the check off.

If the window can't show the question (for example it failed to open properly), TestPion asks with a regular Windows dialog instead, so a fixed version can always be installed.

The .zip and the portable `.exe` don't update themselves: they tell you about the new version and open the download page. You can also download and run a newer installer by hand; it upgrades in place and keeps your workspaces, settings and secrets.

## Uninstall

Use **Settings → Apps → Installed apps → TestPion → Uninstall**. A copy from the .zip or the portable `.exe` is removed by deleting its folder or file. Your workspaces and settings in `%USERPROFILE%\.testpion` are kept; delete that folder to remove them too.
