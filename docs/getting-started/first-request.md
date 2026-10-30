---
title: "Your first request"
description: "Send your first HTTP request in TestPion in a few minutes, read the answer, add a check that passes, and save it. No server to set up."
---

# Your first request

::: tip In short
You will send a request to a public test website, read the answer, add a check, and save it. **About 5 minutes. You need only TestPion** and an internet connection. No server, no files.
:::

::: v-pre

## Before you start

[Install TestPion](/getting-started/installation) and open it. The first time, a workspace called **TestPion Examples** opens by itself. It holds ready-made requests for a free public test site (httpbin.org), so there is nothing to set up.

## 1. Send a request

1. In the list on the left, open **HTTP basics (httpbin)** and click **GET with query parameters**. The request opens in the middle.
2. Look at the web address at the top. It starts with `{{baseUrl}}`. That is a **variable**: TestPion swaps it for the real address from the active environment. Make sure **Public APIs** is chosen in the environment picker (top right).
3. Press **Send**, or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd>.

## 2. Read the answer

The answer appears below the request:

- **A number such as `200`.** This is the *status code*. `200` means it worked. `404` means not found. `401` means you are not allowed in. `500` means the server failed.
- **The time it took**, for example `180 ms`.
- **The data.** Most APIs answer with JSON, shown as a tree you can open and close.

That is the whole idea of testing an API: send something, look at what comes back, and decide if it is right.

## 3. Add a check

A **check** (also called an assertion) is a rule the answer must follow. TestPion tests it for you every time.

1. Open the **Tests** tab under the request.
2. Add a check: `status` **equals** `200`.
3. Add a second check: the data **exists** at `$.args`. (`$.args` means "the `args` part of the JSON answer".)
4. Press **Send** again. Each check shows a **green tick** when it passes and a **red cross** when it does not.

Try to make one fail: change the expected status to `201` and send again. Seeing a red cross is the quickest way to learn what a check does.

## 4. Save it

Press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd>. The request is saved in its collection.

## 5. Turn it into a test you can run again

Click the **⋯** at the end of the request's title line and choose **Save as test…**. TestPion writes a test file. A message appears with **Run now**: click it to run the test and see the result.

That test also runs from the terminal and in CI. See [Run tests in CI](/test-runner/ci-cd) when you are ready.

## Use your own API

To test your own API instead of the example site:

1. Open **Environments** and create one called `Development` with the variable `baseUrl` set to your API's address, for example `http://localhost:3000`.
2. Click **New HTTP request** on Home (or press <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>T</kbd>) and enter `{{baseUrl}}/your-path`.
3. If the answer is `401`, open **Authorization**, choose **Bearer token** and paste your token. Keep real tokens in a **secret** variable such as `{{accessToken}}`, not typed into the request ([Secrets](/security/secrets)).


## When something looks wrong

- **A variable is red.** It has no value in the active environment. The environment picker in the top bar counts them. Hover the web address to see where each value came from. A web address whose host is a variable with no value is not sent, and the message says which variable is empty.
- **A variable is blue.** It has a value. All is well.
- **Nothing happens when you press Send.** Check that an environment is chosen and that you are online.

## Next

- [Authentication](/api-testing/authentication): log in with a token, a password or an API key.
- [Environments and variables](/api-testing/environments): switch between test and live.
- [Assertions](/test-runner/assertions): every kind of check.
- [Finding your way around](/getting-started/finding-your-way): a tour of the screens.

:::

::: details I work on the TestPion repository and want the local demo servers
Start them with `node examples/servers/demo-servers.mjs`. Create the environment `Development` with the variable `baseUrl` set to `http://127.0.0.1:4010`, send the address `http://127.0.0.1:4010/patients`, expect `401`, then add the bearer token `demo-token-3f9a1c` and send again.
:::
