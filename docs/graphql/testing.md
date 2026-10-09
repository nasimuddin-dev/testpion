---
title: "GraphQL tests"
description: "Write GraphQL tests in YAML with HTTP status, GraphQL error and JSONPath assertions."
---

::: v-pre

# GraphQL tests

```yaml
name: Get Patient
type: graphql
endpoint: "{{graphqlEndpoint}}"
query: |
  query GetPatient($id: ID!) {
    patient(id: $id) { id name species }
  }
variables:
  id: "123"
assertions:
  - type: http-status
    expected: 200
  - type: graphql-no-errors
  - type: exists
    path: $.data.patient.id
  - type: latency
    max: 500
```

`graphql-errors` asserts that errors occurred, either as a count (`expected: 1`) or by message (`expected: Cannot query field`). A GraphQL test without assertions checks `graphql-no-errors` by default.

## Scripts

GraphQL requests have pre-request and test scripts, like REST requests (the **Scripts** tab in the GraphQL view, `preRequestScript` / `testScript` in YAML). In a collection, the collection's and folders' scripts run for GraphQL requests too, as in Postman.

- In a pre-request script, `tp.request.url` is the endpoint and `tp.request.headers` can be changed (for example to add a signature or a trace id); the body holds the query and variables as JSON. The query itself stays as written.
- In a test script, `tp.response` is the GraphQL HTTP response: `tp.response.json().data`, `tp.response.json().errors`.

```js
tp.test('the patient has a name', () => {
  tp.expect(tp.response.json().data.patient.name).to.be.a('string');
});
tp.environment.set('patientId', tp.response.json().data.patient.id);
```

:::
