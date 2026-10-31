---
title: "When something does not work"
description: "Find the fix by what you see: a request that fails, a variable that stays as it is, no traffic captured, an AI model that is not set up, git that will not push, an installer warning."
---

# When something does not work

::: tip In short
Find the sentence that looks like what you see, then read the fix under it. Each fix says where to click. If nothing helps, the last section tells you how to send us everything we need.
:::

::: v-pre

## A request fails

**"The request could not reach the server" or "connection refused".**
The server is not running, or the address is wrong. Check the web address and the port. Start your API, then press **Send** again.

**The address shows `{{baseUrl}}` in the error.**
The variable has no value. See [A variable stays as it is](#a-variable-stays-as-it-is) below.

**A certificate error.**
The server uses a certificate your computer does not trust. This happens on company networks that inspect traffic, and with private certificate authorities.

1. Open **Settings ▸ Certificates**.
2. Turn on **Trust the certificates installed in the operating system**, or add your company's `.pem` file under **Extra CA certificates**.
3. For a development server only, you can turn off verification in the request's **Settings**.

More is in [Certificates](/api-testing/rest#certificates).

**The request takes too long and then stops.**
Raise the **timeout** in the request's **Settings**. For a server that sometimes fails once, set **retries** (up to 5).

**401 or 403.**
The server does not accept your sign-in. Check that the token is current and that the right environment is chosen. [Authentication](/api-testing/authentication) shows how to refresh a token by itself.

**TestPion asks "are you sure?" before it sends.**
The environment is marked as **production**, so any request that changes data asks first. This is on purpose. From the command line, add `--allow-production`.

## A variable stays as it is

You see `{{token}}` in the request, or the response says the value is missing.

- Check the **environment** in the top bar. The value may live in another environment.
- A red warning sign next to the environment name says the request uses a variable nobody defined. Click it to add the value.
- Open **Environments** and look for the name.
- A value a script sets, or a step extracts, exists only after that step has run.

See [Environments](/api-testing/environments).

## No traffic shows in the Debugger

- Press **Capture all traffic** in the Debugger, then open a page or run the program.
- For **HTTPS**, install the TestPion certificate when the Debugger asks. Without it, HTTPS bodies stay hidden.
- Some programs ignore the system proxy. Open a browser or a terminal through the proxy from **More ways to capture**, or start the program with the proxy address (`HTTP_PROXY` or `--proxy-server`).

See [HTTP Debugger](/api-testing/http-debugger).

## An AI model is not set up

**"The AI assistant is off" or "No model is set up".**
Open **Settings ▸ AI assistant**, choose a provider and paste a key. Or choose a model on this computer, such as Ollama.

**The key is rejected.**
Check that it is for the provider you chose, that it has credit, and that the model name is spelled as the provider writes it.

**You have no key and only want to try things.**
Use the offline demo model. It needs no key and no network. The samples under **AI quality** and **RAG bots** use it.

**"needs an embedding model".**
A check that compares meaning needs a model that can embed text. Set `embedder: provider/model` on the check, or choose a provider that embeds. The offline demo model can embed.

## Git will not push or pull

**"Git is not installed".**
Install git, then restart TestPion.

**"The workspace is not in a git repository" or "no remote".**
Open the **Git** view. Press **Initialize repository**, and give it a remote address to share it.

**"Git does not know who you are" when you commit.**
A computer that has never used git has no name and e-mail. The Git view asks for them in a small dialog and commits again. They are kept for this workspace only. On the command line, run `testpion git identity --name "Your Name" --email you@example.com`.

**A push is refused.**
Your team pushed first. Press **Pull & push**: TestPion merges your changes by request and pushes.

**It asks you to sign in.**
TestPion uses the same sign-in as git in a terminal: your SSH keys or the credential manager. Sign in there once, then try again.

See [Keep your workspace in git](/getting-started/git).

## The installer warns you

Windows may say **"Windows protected your PC"**, and macOS may say the app is damaged. The installers are not signed yet. The guides show how to continue safely: [Windows](/installation/windows) and [macOS](/installation/macos).

## A secret cannot be saved

**"OS secure storage is not available; refusing to store the secret in plain text".**
TestPion keeps secrets in your operating system's credential store and never in a plain file. On Linux, install and unlock a keyring such as GNOME Keyring, then try again.

See [Secrets](/security/secrets).

## Still stuck? Send what we need

1. Run `testpion doctor` in a terminal. It checks Node.js, the app folder, proxy and certificate settings, and whether every collection can be read.
2. In the app, open **Settings ▸ About ▸ Download** and choose the diagnostics bundle. It holds versions, settings without secrets and the last log lines.
3. Use **Help ▸ Send Feedback or Report a Problem…** and attach the bundle if you wish.

More answers are in the [FAQ](/faq).

:::
