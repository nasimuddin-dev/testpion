---
title: Package managers
description: How the winget, Homebrew and Scoop manifests of a TestPion release are made, and how to submit them.
---

# Package managers

A release can be offered through **winget** (Windows), a **Homebrew** tap (macOS) and a **Scoop** bucket (Windows). The manifests are made from the release's own checksum list, so every hash is the one the release workflow published and signed.

```bash
npm run package-manifests -- 0.58.0
```

This reads `SHA256SUMS.txt` of the GitHub release `v0.58.0` and writes into `dist/packages/`:

| File | For |
|---|---|
| `winget/NasimUddin/TestPion/<version>/` (three YAML files) | winget |
| `homebrew/Casks/testpion.rb` | a Homebrew tap |
| `scoop/testpion.json` | a Scoop bucket |

`--sums <file>` reads a local checksum list instead, and `--out <dir>` writes somewhere else. Nothing is submitted: the files are for you to send.

## winget

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) and copy `dist/packages/winget/NasimUddin` into its `manifests/n/` folder.
2. Check it on Windows: `winget validate --manifest <folder>` and `winget install --manifest <folder>`.
3. Open a pull request. Its checks download the installer and compare the hash.

The installer is installed per user and silently (`/S`). Until the installer is code-signed (see [code signing](../security/code-signing.md)), the pull request's checks may flag it for SmartScreen, and reviewers may ask for a signed build.

## Homebrew

The main cask repository takes only notarized apps, so until the macOS builds are signed and notarized the cask belongs in a tap of your own:

1. Create a repository named `homebrew-testpion` and copy `dist/packages/homebrew/Casks/testpion.rb` into its `Casks/` folder.
2. People then install with `brew install --cask nasimuddin-dev/testpion/testpion`.

An app that is not notarized is still stopped by Gatekeeper the first time it is opened; the [macOS page](../installation/macos.md) says how to open it.

## Scoop

1. Create a bucket repository (for example `scoop-testpion`) and copy `dist/packages/scoop/testpion.json` into its `bucket/` folder.
2. People then run `scoop bucket add testpion https://github.com/nasimuddin-dev/scoop-testpion` and `scoop install testpion`.

The manifest installs the portable build and has an update rule: Scoop's own updater finds a new release and reads its hash from that release's `SHA256SUMS.txt`.

## What is not built yet

- **Windows on ARM**: the Windows build is x64 only (it runs on ARM under emulation). A native ARM64 build needs the native modules (the terminal and the database) built and tested on that processor, which the release workflow does not do yet.
- The manifests are not made or submitted by the release workflow: run the command after a release.
