---
title: "GraphQL subscriptions"
description: "Run GraphQL subscriptions over WebSocket (graphql-transport-ws and graphql-ws) and watch the events arrive."
---

::: v-pre

# GraphQL subscriptions

Write a `subscription` operation in the GraphQL view and **Run** becomes **Subscribe**. TestPion opens a WebSocket to the endpoint (`http://` and `https://` become `ws://` and `wss://`), subscribes, and lists every event as it arrives. Click one to see its data as a JSON tree. **Stop** ends the subscription; a server that completes it ends it too.

```graphql
subscription OnPatientUpdated($id: ID!) {
  patientUpdated(id: $id) { id name weight }
}
```

- **Protocols:** both in use are offered and the server picks one: `graphql-transport-ws` (the graphql-ws library, used by Apollo Server 4, GraphQL Yoga, Hasura …) and the older `graphql-ws` (subscriptions-transport-ws). The one in use is shown above the events.
- **Auth:** the Auth tab and Headers are sent with the WebSocket handshake. For servers that read credentials from the first message instead, put them in the **Connection** tab: it's the `connection_init` payload, e.g. `{ "authorization": "Bearer {{token}}" }`.
- Variables and `{{variables}}` work as for queries. Secret values are masked in the event list.

## In test files and collection runs

A test file whose query is a `subscription` subscribes, waits for events, then stops. By default it waits for the first event, for at most 10 seconds. `events:` waits for more, and `wait:` changes the limit in milliseconds. A subscription the server completes earlier stops then.

```yaml
name: Vitals stream for a patient
type: graphql
endpoint: "{{graphqlEndpoint}}"
query: |
  subscription Vitals($pet: ID!) {
    vitals(pet: $pet) { pet beat }
  }
variables:
  pet: "p1"
events: 3
wait: 15000
assertions:
  - type: equals
    path: $.data.vitals.pet      # the first event, as for a query
    expected: "p1"
  - type: equals
    path: $.count                # how many events arrived
    expected: 3
  - type: equals
    path: $.events[2].data.vitals.beat
    expected: 3
```

The body has the first event's `data` and `errors`, so checks written for a query work unchanged. It also has every event in `events`, their number in `count`, and `completed` when the server ended the subscription. With no checks of your own, the test fails when no event arrives in time. A subscription saved in a collection runs the same way in the Collection Runner and `testpion run-collection`, with the defaults.

## From the terminal and for agents

From the terminal, and for AI agents:

```bash
testpion graphql-subscribe https://api.example.com/graphql -q 'subscription { patientUpdated { id name } }' --max 5 --duration 30 --json
```

The MCP tool `graphql_subscribe` returns the events received within a limit (at most 60 seconds).

:::
