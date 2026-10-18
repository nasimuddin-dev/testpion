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
- **Save the response:** the down arrow at the right end of the response's tab bar saves it as pretty or minified JSON, the raw bytes as received or (when it holds a list) the table as CSV; **Copy** sits before it. See [Save and export results](/getting-started/save-and-export-results).
- **Code** shows the call as code (cURL, fetch, Python, Go and more): the JSON `POST` with the query, variables and operation name, with `{{variables}}` resolved.
- Subscriptions run over WebSocket (`graphql-transport-ws` and `graphql-ws`): see [subscriptions](./subscriptions.md).
- The schema explorer's **Build** writes a whole operation for a root field (see [schema explorer](./schema-explorer.md#build-an-operation)).
- **Import** a schema file (SDL, `.graphql`; paste it in the Import dialog, or `testpion import schema.graphql -w <workspace>`): it becomes a GraphQL request for `{{graphqlUrl}}` (a collection variable to set) with a ready operation for the first Query field, and the schema is kept in `specs/graphql/` for [mocking](./mocking.md) (see [Import fidelity](/getting-started/import-fidelity)).

See [schema explorer](./schema-explorer.md), [testing](./testing.md) and the [GraphQL mock server](./mocking.md).

:::
