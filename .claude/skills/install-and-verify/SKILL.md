---
name: install-and-verify
description: Download a TestPion release, verify its checksums, install it silently on Windows and run the UI regression suite against the installed app. Use after every release, or when the owner reports a problem in the installed app.
---

# Install and verify a release (Windows)

1. **Download and verify:**
   ```bash
   d=$(mktemp -d) && gh release download vX.Y.Z -D "$d" -p '*-windows-x64-setup.exe' -p SHA256SUMS.txt -p SHA256SUMS.txt.sigstore.json
   cd "$d" && sha256sum -c SHA256SUMS.txt --ignore-missing
   # the checksum list is signed by the release workflow (Sigstore); with cosign installed:
   cosign verify-blob --bundle SHA256SUMS.txt.sigstore.json --certificate-identity-regexp 'https://github.com/nasimuddin-dev/testpion/.github/workflows/release.yml@.*' --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS.txt
   ```
   Must print `OK` for the installer. A mismatch: stop, do not install, tell the owner.
2. **Install silently from PowerShell** (Git Bash turns `/S` into a path). Installing closes the running TestPion; say so to the owner first if they may be using it.
   ```powershell
   Start-Process "<dir>\TestPion-X.Y.Z-windows-x64-setup.exe" -ArgumentList '/S' -Wait
   (Get-Item "$env:LOCALAPPDATA\Programs\TestPion\TestPion.exe").VersionInfo.ProductVersion
   ```
3. **UI regression against the installed app** (it uses its own fresh home; the owner's data is untouched):
   ```bash
   npm run e2e -w @testpion/desktop -- --exe "$LOCALAPPDATA/Programs/TestPion/TestPion.exe"
   ```
   The `ai-agents` plan also starts the installed app's own MCP server (`TestPion.exe --mcp-server`) from Settings ▸ AI agents.
4. Report: version installed, checksum OK, e2e result (and anything flaky), and what the owner should do (relaunch from
   the Start menu or the taskbar; Windows may need Explorer restarted to show a changed icon).

If something fails only in the installed app, reproduce it with the reproduce-installed-bug skill.
