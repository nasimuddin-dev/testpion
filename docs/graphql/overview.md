---
title: "GraphQL"
description: "Execute GraphQL queries and mutations with variables, headers and auth, and assert on data and errors."
---

::: v-pre

# GraphQL

Open the GraphQL editor from the Collections explorer: a saved GraphQL request (under a collection's **GraphQL** category), or **+** ▸ **GraphQL request**. It shares the tab bar with the other request editors.

Enter the endpoint (variables allowed), then write the operation in the Monaco editor. **Variables**, **Headers**, **Auth**, **Scripts** and **Tests** (the assertions) have their own tabs. If a document contains several operations, choose which one to run.

- **Ctrl/Cmd+Enter** runs the operation, **Prettify** formats it, and **Generate** asks the AI assistant to draft a query from the schema.
- **Save** (<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>S</kbd>) keeps the request in a [collection](/api-testing/collections), in the same dialog as an HTTP request. **Test** (or **Save as test…** in the **⋯** at the end of the breadcrumb line) writes it as a test file under `tests/graphql`.
- On an environment marked as **production**, a mutation asks before it is sent; queries run without asking ([Production](/api-testing/environments#production)).
- Responses appear as a JSON tree. GraphQL `errors` are counted and can be asserted on.
- **Code** shows the call as code (cURL, fetch, Python, Go and more): the JSON `POST` with the query, variables and operation name, with `{{variables}}` resolved.
- Subscriptions run over WebSocket (`graphql-transport-ws` and `graphql-ws`): see [subscriptions](./subscriptions.md).
- The schema explorer's **Build** writes a whole operation for a root field (see [schema explorer](./schema-explorer.md#build-an-operation)).

See [schema explorer](./schema-explorer.md), [testing](./testing.md) and the [GraphQL mock server](./mocking.md).

:::
