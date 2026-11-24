---
title: Download
description: Download TestPion for Windows (User Installer, System Installer, .zip or portable), macOS (Apple Silicon and Intel) or Linux (AppImage, .deb, .rpm). Free, self-contained installers from GitHub Releases.
---

<script setup>
import { data as release } from "./data/release.data";
</script>

# Download TestPion

The current version is **{{ release.version }}**<span v-if="release.date">, released {{ release.date }}</span>. Every installer is self-contained: you don't need Node.js or anything else. The files are hosted on the project's <a :href="release.releaseUrl">GitHub release page</a>, which also lists their SHA-256 checksums.

<Downloads />

## Which file do I need?

- **Windows:** use the **User Installer**: it installs for you only and needs no administrator rights. The **System Installer** installs for everyone who uses the computer and needs an administrator. If you can't or don't want to install anything, take the **.zip**: unpack it and run `TestPion.exe`; with a `data` folder beside it, it keeps everything in that folder ([portable mode](/installation/windows#portable-mode)).
- **macOS:** choose **Apple Silicon** for Macs with an M-series chip, or **Intel** for older Macs. Apple menu → **About This Mac** shows which one you have.
- **Linux:** the **AppImage** runs on most distributions without installing. Use the **.deb** on Ubuntu and Debian derivatives, or the **.rpm** on Fedora, RHEL and openSUSE, to get a menu entry.
- **CI servers:** use the [`testpion` CLI](/installation/cli) instead of the desktop app.

## Before you install

**Code signing.** The installers aren't code-signed yet. Windows SmartScreen may warn you the first time, and macOS asks you to confirm the first launch. The installation guides show exactly what to click.

## Verify a download (optional)

Each release includes `SHA256SUMS.txt`. Compare the checksum of your file with the one listed:

::: code-group

```powershell [Windows]
Get-FileHash .\TestPion-*-setup.exe -Algorithm SHA256
```

```bash [macOS]
shasum -a 256 TestPion-*.dmg
```

```bash [Linux]
sha256sum TestPion-*
```

:::

`SHA256SUMS.txt` is signed by the release workflow itself (Sigstore, keyless), so the list can be trusted even if someone could upload files to the release. With [cosign](https://docs.sigstore.dev/cosign/installation/) installed, download `SHA256SUMS.txt.sigstore.json` next to it and run:

```bash
cosign verify-blob --bundle SHA256SUMS.txt.sigstore.json \
  --certificate-identity-regexp 'https://github.com/nasimuddin-dev/testpion/.github/workflows/release.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS.txt
```

## Installation guides

- [Install on Windows](/installation/windows)
- [Install on macOS](/installation/macos)
- [Install on Linux](/installation/linux)
- [Install the CLI](/installation/cli)

Older versions are on the [GitHub releases page](https://github.com/nasimuddin-dev/testpion/releases). To build from source, see [development](/contributing/development).
