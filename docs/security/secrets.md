---
title: "Secrets"
description: "How secrets are stored and supplied, and how they are redacted."
---

::: v-pre

# Secrets

- **Desktop:** secrets are encrypted with Electron `safeStorage`, which uses Windows DPAPI, the macOS Keychain or Linux Secret Service. The ciphertext is stored in `~/.testpion/secrets.json` and can only be decrypted by your OS account. If no secure backend is available, TestPion refuses to store the secret rather than write plain text.
- **CLI/CI:** secrets come from the `TESTPION_SECRET_*` environment variables (see [CI/CD](../test-runner/ci-cd.md)).
- **Workspace files** only reference secrets (`{{$secret.provider.openai.apiKey}}`). Saving a provider with a literal API key is rejected.
- **Exports** never contain secret values.
- **Cookies:** the workspace [cookie jar](/api-testing/cookies) is stored as one encrypted value in the same store, never in workspace files. The CLI keeps cookies in memory unless you pass `--export-cookie-jar`, which writes a plain-text JSON file you choose.
- **Current values** set by scripts (`tp.environment.set` …) stay on this machine. Sensitive ones are encrypted the same way.

:::
