---
title: "Your first request"
description: "Send an HTTP request, add assertions and save it to a collection."
---

::: v-pre

# Your first request

TestPion opens on **Home**, with shortcuts to a new request, a GraphQL query, import, a new collection, MCP, the AI lab and these docs. It also shows your recent requests, collections and environments. Click an environment there to make it active.

1. Start the demo servers: `node examples/servers/demo-servers.mjs`.
2. In **Environments**, create `Development` with `baseUrl = http://127.0.0.1:4010`. The eye button next to the environment selector gives a [quick look](/api-testing/environments#quick-look-every-variable-at-once) at its variables.
3. Click **New HTTP request** on Home (or **File ▸ New ▸ HTTP Request**, or <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>T</kbd>), enter `{{baseUrl}}/patients` and press **Ctrl/Cmd+Enter**.
4. The response is `401`. Open **Authorization**, choose **Bearer token** and use `demo-token-3f9a1c` (or better, a secret environment variable `{{accessToken}}`).
5. Send again. In **Tests**, add `status = 200` and `exists $.items[0].id`, then send once more to see them pass.
6. Press **Ctrl/Cmd+S** to save the request to a collection.
7. Make it a test: the ⋯ at the end of the breadcrumb line ▸ **Save as test…** writes it to `tests/rest/`, and the toast's **Run now** runs it. A run's ⋯ ▸ **Run in CI…** then writes the pipeline ([CI/CD](/test-runner/ci-cd)).

Variables resolved from the environment are shown in blue; unresolved ones are shown in red. Hover the URL (or any field with `{{variables}}`) to see where each value came from; the **Info** panel on the right edge lists them all. A `{{variable}}` with no value in the URL's host stops the request with a message such as *{{baseUrl}} has no value*.

:::
