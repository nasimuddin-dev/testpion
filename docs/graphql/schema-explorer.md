---
title: "GraphQL schema explorer"
description: "Introspect a schema to enable autocomplete, validation, hover docs and type navigation, and build ready-to-run operations from root fields."
---

::: v-pre

# Schema explorer

**Introspect** runs the standard introspection query and loads the schema (**Schema** shows or hides the explorer):

- **Autocomplete** for fields, arguments, types, directives and variables (Ctrl+Space).
- **Validation** as you type, with errors underlined in the editor.
- **Hover** documentation for types.
- **Explorer** listing root types, all types (objects, interfaces, unions, enums, inputs, scalars) and directives. Click a type to drill down and a field to insert it. The **SDL** toggle shows the printed schema.

If introspection is disabled on the server, the error explains why and suggests alternatives.

## Build an operation

On the root types (**Query**, **Mutation**, **Subscription**), each field has a **Build** button. It writes a complete operation for that field into the editor:

- a variable for each argument, declared with its type, and placeholder values in **Variables** (`""` for strings and IDs, `0` for numbers, `false`, the first enum value, and input objects with their required fields);
- a selection of the field's scalar fields, and of nested objects two levels deep. Fields that need arguments, deprecated fields and types already on the path (cycles) are left out; unions get an inline fragment per type.

If the editor already has a query, you're asked before it is replaced. Fill in the variables and **Run**.

The same builder is in the terminal and for AI agents:

```bash
testpion graphql-op Query.patient --endpoint http://127.0.0.1:4011/graphql
testpion graphql-op addPatient --schema schema.graphql --depth 1 --json
```

AI agents use the `graphql_operation` MCP tool, which introspects the endpoint and returns `{ operation, operationName, query, variables }`, so they don't have to guess field names.

:::
