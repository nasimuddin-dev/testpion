---
title: "GraphQL mock server"
description: "Serve fake, correctly typed data for any query against a GraphQL schema on localhost, from the app or the CLI."
---

::: v-pre

# GraphQL mock server

A GraphQL mock answers **any valid query** against a schema with fake but correctly typed data, so you can build a front end, write tests or demo a flow before the real API exists or while it is down.

## From the app

1. In the **GraphQL** editor, enter the endpoint and click **Introspect**.
2. Click **Mock**. The mock starts on `http://127.0.0.1:<port>/graphql` and the URL is copied to the clipboard.
3. Point your app (or another GraphQL tab) at that URL. The button shows **Mock on**; click it again to stop.

Clicking **Mock** after introspecting a changed schema updates the running mock.

## From the CLI

```bash
testpion mock-graphql --schema schema.graphql -p 4000
testpion mock-graphql --schema introspection.json --overrides fixtures.json
testpion mock-graphql --endpoint https://api.example.com/graphql --list-length 5
```

| Option | Description |
|---|---|
| `--schema <file>` | Schema as SDL (`.graphql`) or an introspection result (`.json`). |
| `--endpoint <url>` | Or introspect a running GraphQL server. |
| `-p, --port` | Port (default: any free port). |
| `--overrides <file>` | Fixed values per type, see below. |
| `--list-length <n>` | Items in every list (default 2). |
| `--delay <ms>` | Delay every response, to test loading states. |

## What the data looks like

- **Typed:** every field returns a value of its type: IDs, numbers, booleans, a value of the enum, objects and lists. Interfaces and unions return one of their types, with `__typename`.
- **Plausible:** values follow the field name. `email` gets an email address, `name` a person's name, `url` / `avatar` a URL, `createdAt` / `date` an ISO date, `price` / `amount` a price, `phone` a phone number and `status` a status.
- **Deterministic:** the same query always returns the same data, so tests and screenshots are stable.
- **Real errors:** an invalid query gets the same validation errors a real server would send, with HTTP 400.
- **Introspection works,** so GraphQL clients and IDEs can explore the mock.

## Fixed values (overrides)

Give fixed values per type in a JSON file. Other fields stay generated:

```json
{
  "Patient": { "name": "Rex", "species": "DOG" },
  "Query": { "patients": [{ "name": "Rex" }, { "name": "Tom" }] }
}
```

The mock only listens on localhost.

:::
