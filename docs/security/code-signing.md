---
title: "Code signing"
description: "What the owner has to buy and configure so the Windows and macOS installers are signed, and how the release workflow uses it."
---

::: v-pre

# Code signing

TestPion's installers are not code-signed yet. Windows SmartScreen and macOS Gatekeeper ask users to confirm the first launch, and the updater cannot check *who* built an update (it checks the SHA-512 in `latest.yml`, which is published by the same account as the installer; the signed checksum list `SHA256SUMS.txt.sigstore.json` covers a manual download). Signing needs certificates that only the project owner can buy. Everything else is already wired: the release workflow signs by itself as soon as the secrets below exist, and builds without them are unchanged.

## What to buy

| Platform | What | Roughly | Notes |
|---|---|---|---|
| Windows | A code-signing certificate from a CA that issues to individuals or organisations: an **OV** certificate (SmartScreen reputation builds over time) or an **EV** one (immediate reputation, usually on a hardware token) | 100 to 450 USD a year | Since 2023 CAs issue the private key on a hardware token or in a cloud HSM. For CI use a service that signs remotely (Azure Trusted Signing, SSL.com eSigner, DigiCert KeyLocker) or an OV certificate exportable as `.pfx`. |
| macOS | An **Apple Developer Program** membership and a **Developer ID Application** certificate | 99 USD a year | Notarization is part of the membership. |

## What to configure

Add these **repository secrets** (Settings ▸ Secrets and variables ▸ Actions):

| Secret | Value |
|---|---|
| `WIN_CSC_LINK` | the Windows `.pfx` as base64 (`base64 -w0 cert.pfx`), or a `https://` link to it |
| `WIN_CSC_KEY_PASSWORD` | its password |
| `CSC_LINK` | the macOS Developer ID Application certificate exported as `.p12`, base64 |
| `CSC_KEY_PASSWORD` | its password |
| `APPLE_ID` | the Apple ID that owns the membership |
| `APPLE_APP_SPECIFIC_PASSWORD` | an app-specific password made at appleid.apple.com |
| `APPLE_TEAM_ID` | the 10-character team id |

A remote-signing service for Windows replaces the first two with the service's own variables; see electron-builder's [Windows code signing](https://www.electron.build/code-signing-win) page and add the `signtoolOptions` for it to `apps/desktop/electron-builder.yml`.

## What the workflow does with them

`.github/workflows/release.yml`, step *Package*:

- **Windows**: with `WIN_CSC_LINK`, electron-builder signs the installer, the portable build and the app's executables, and writes the publisher name into the update feed, so the updater refuses an update that another publisher signed.
- **macOS**: with `CSC_LINK`, the ad-hoc identity (`-`) is replaced by the real one, the hardened runtime is turned on, and with `APPLE_ID` the app is notarized and stapled.
- **Linux**: not signed (the `SHA256SUMS.txt` signature covers it).
- Without the secrets nothing changes: unsigned on Windows, ad-hoc signed on macOS.

## Release checklist (owner)

1. Buy the certificates above; keep the private keys out of the repository.
2. Add the secrets. Make a tag `v…-rc` or run the workflow by hand to build once.
3. On Windows run `Get-AuthenticodeSignature .\TestPion-*-setup.exe` (status `Valid`, the right publisher). On macOS run `codesign --verify --deep --strict --verbose=2 TestPion.app` and `spctl --assess --type execute --verbose TestPion.app` (accepted, source Notarized Developer ID).
4. Update the notes in the release workflow ("The installers aren't code-signed yet…") and `docs/download.md`.
5. Renew before the expiry date; a lapsed certificate does not invalidate earlier signatures if they were timestamped (electron-builder timestamps).

:::
