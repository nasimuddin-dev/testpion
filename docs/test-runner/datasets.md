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

## In the app

The Collections sidebar has a **Datasets** section after API definitions: every file in the workspace's `datasets/` folder with its format (CSV, JSONL, JSON, MD, DB) and how many rows it holds. Its menu makes a **New CSV** or **New JSONL** (empty, named by you) or opens **Generate test data…**; a row's menu has **Run a collection with it** (the Collection Runner opens with the file as its data; pick the collection there), **Rename**, **Duplicate** and **Delete** (the file goes to *Recently deleted* for 30 days, like a collection).

A dataset opens in a tab of its own:

- **Preview**: the first 200 rows as a table, each column with the kind of value it holds (string, number, boolean, object, array), sort and filter; the row and column counts are in the header. A SQLite database lists its tables and takes a query.
- **File**: the file itself in the editor (JSON Lines and CSV are coloured by column), saved with **Save** or <kbd>Ctrl</kbd>+<kbd>S</kbd>; the preview follows.
- **Run a collection with this dataset** opens the Collection Runner with the file chosen; **Use in a test** copies the `dataset:` block above, ready to paste into a test file.

The same from a terminal or an agent:

```bash
testpion datasets                          # every dataset: path, format, size (SQLite: its tables)
testpion datasets show users.csv           # the first 20 rows with the columns and their kinds of value
testpion datasets show app.db --query "SELECT * FROM users" --limit 5 --json
```

Agents use `list_datasets` and `read_dataset` (`name`, `limit`, and `query` for a database): the columns tell them which `{{variables}}` a test or a collection run can use.

## Generate test data

When there is no data file yet, generate one. In the Collection Runner, **Generate…** makes rows from an API definition operation's request body (`POST /patients` in `specs/clinic.yaml`) or from a JSON schema you write, saves them in `datasets/` and uses them for the run. Each field gets a value that fits it:

- its `enum` (one of the values), its `format` (email, UUID, date, date-time, URI, IP address), its range (`minimum` / `maximum`) and its length (`maxLength`);
- otherwise its name: `email`, `firstName`, `lastName`, `phone`, `city`, `country`, `company`, `price`, `createdAt`, `description` … get an email, a first name, a phone number and so on (the values `{{$randomEmail}}` and the other dynamic variables give);
- an integer `id` counts 1, 2, 3 … so rows don't collide.

```bash
testpion generate-data patients --spec specs/clinic.yaml --operation "POST /patients" --rows 50
testpion generate-data owners --schema owner.schema.yaml --format json
testpion run-collection "Clinic" -d datasets/patients.csv
```

Agents use the `generate_dataset` MCP tool. An existing dataset isn't replaced unless you ask (`--overwrite`).

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
