---
title: "Datasets"
description: "Stream JSON, JSONL, CSV and Markdown datasets, or the rows of a SQLite query, into tests."
---

::: v-pre

# Datasets

```yaml
dataset:
  path: cases.jsonl        # or url: https://…  (+ recordsPath: $.data)
  format: jsonl            # inferred from the extension
  expectedField: expected  # default "expected"
  idField: id
  limit: 1000
  offset: 0
```

- **LLM tests:** record fields become prompt variables, and `expected` comes from `expectedField`.
- **RAG tests:** records provide `question`, `contexts`, `answer` and `expected`.
- **Other types:** record fields become variables.

## SQLite databases

A SQLite database file (`.db`, `.sqlite`, `.sqlite3`) works as a dataset with a `query`: each row is a record and its columns are the fields.

```yaml
dataset:
  path: data/app.db
  query: SELECT email, plan FROM users WHERE active = ? ORDER BY id
  params: [1]              # ? placeholders; or { plan: pro } for :plan
  limit: 200
```

The database is opened read-only and the query must be one `SELECT` (`WITH … SELECT` and `VALUES` work too), so a dataset never changes it. BLOB columns arrive as base64 text.

The same works for collection runs: `testpion run-collection "My API" -d data/app.db --iteration-query "SELECT * FROM users"`, and in the app's Collection Runner, where picking a database shows its tables and a query box (it starts with the first table that has rows).

## PostgreSQL and MySQL

A PostgreSQL or MySQL / MariaDB database works the same way, through its connection URL. Keep the password out of the workspace: put the URL in an environment variable of the machine (or of CI) and name it with `connectionEnv`.

```yaml
dataset:
  connectionEnv: DATABASE_URL       # postgres://app:…@db.internal:5432/shop  or  mysql://app:…@db:3306/shop
  query: SELECT email, plan FROM customers WHERE plan = $1 ORDER BY id
  params: [pro]                     # PostgreSQL: $1, $2 …   MySQL: ? (or :name with an object)
```

`connection: postgres://…` works too (and `path:` with such a URL), but then the password is in the file. The query runs in a read-only transaction and must be one `SELECT` (`WITH … SELECT`, `VALUES`, `SHOW` and `TABLE` work too). Dates arrive as ISO text, binary columns as base64, big integers as numbers when they fit.

For collection runs: `testpion run-collection "My API" -d env:DATABASE_URL --iteration-query "SELECT * FROM customers"` (a `postgres://` or `mysql://` URL works in place of `env:NAME`). In the app's Collection Runner, **Database…** next to *Select file* takes the URL, where `{{variables}}` resolve from the run's environment (put the password in a secret variable: `postgres://app:{{dbPassword}}@host/shop`), lists the tables and shows the query box. Agents pass `data: "env:DATABASE_URL"` with `query` to `run_collection`.

:::
