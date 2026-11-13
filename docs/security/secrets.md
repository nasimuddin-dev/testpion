---
title: "Secrets"
description: "How secrets are stored and supplied, and how they are redacted."
---

# Secrets

::: tip In short
Passwords and keys never go into workspace files. TestPion keeps them in your computer's key store and uses them when a request is sent.
:::

::: v-pre

- **Desktop:** secrets are encrypted with Electron `safeStorage`, which uses Windows DPAPI, the macOS Keychain or Linux Secret Service. The ciphertext is stored in `~/.testpion/secrets.json` and can only be decrypted by your OS account. If no secure backend is available, TestPion refuses to store the secret rather than write plain text.
- **CLI/CI:** secrets come from the `TESTPION_SECRET_*` environment variables (see [CI/CD](../test-runner/ci-cd.md)), then from the **vault** (below).

## The vault: secrets for the command line

The command line cannot open the app's secret store, so it has one of its own that the app reads too: the vault, a file in the app folder (`secrets.vault.json`) in which every value is encrypted on its own (AES-256-GCM, bound to the secret's name).

```bash
printf %s "$TOKEN" | testpion secrets vault set token -e Staging -w my-workspace   # a secret variable of an environment
testpion secrets vault set openai --provider --from-env OPENAI_API_KEY             # an AI provider's API key
testpion secrets vault list                                                        # names only, never values
testpion secrets vault status                                                      # where the key comes from, whether it opens here
testpion secrets vault delete token -e Staging -w my-workspace
```

- A value is never an argument and never printed: `secrets vault set` reads it from standard input or from an environment variable (`--from-env`).
- **Where the key is kept.** By the operating system: Windows DPAPI (for your user account), the macOS Keychain, or the Linux Secret Service (`secret-tool`, package `libsecret-tools`). The vault file alone opens nothing, and it does not open on another computer or for another user.
- **CI and containers** have no keyring: set `TESTPION_VAULT_PASSPHRASE` and the key is derived from that passphrase instead. A vault made with a passphrase needs it every time.
- **Order.** The CLI reads `TESTPION_SECRET_*` first, then the vault. The app reads its own store first, then the vault, then the environment variables. A run never writes the vault: only `testpion secrets vault set|delete` and `testpion git fix-secrets --apply` do.
- `testpion git fix-secrets -e <environment> --apply` moves secrets typed into staged files to the vault and puts `{{variables}}` in their place, as *Fix all* does in the app.
- **Workspace files** only reference secrets (`{{$secret.provider.openai.apiKey}}`). Saving a provider with a literal API key is rejected.
- **Exports** never contain secret values.
- **Cookies:** the workspace [cookie jar](/api-testing/cookies) is stored as one encrypted value in the same store, never in workspace files. The CLI keeps cookies in memory unless you pass `--export-cookie-jar`, which writes a plain-text JSON file you choose.
- **Current values** set by scripts (`tp.environment.set` …) stay on this machine. Sensitive ones are encrypted the same way.

:::

## After a clone: secrets to fill in

::: v-pre

A secret variable is named in the environment file, but its value stays on the computer where it was typed. After you clone a workspace, or on a new computer, every secret variable is empty.

- **Home ▸ Needs attention** lists each environment with secrets that have no value here (*Environment "Staging" has 2 secrets with no value on this computer: apiKey, token*). Click it to open the environment. The empty field says *No value on this computer: type it here*.
- The same list is in the Problems tab, in `testpion problems`, and in the MCP tool `what_needs_attention`.
- On the command line, `testpion secrets --missing` lists them with the environment variable that gives each one to the CLI and CI (`TESTPION_SECRET_...`). It exits with 1 when one is missing. `testpion doctor` warns about them too.
- The MCP tool `list_environments` marks a secret with no value as `(secret, no value here)`.

Only names are ever listed, never values.

:::
