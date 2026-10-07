---
title: "WebSocket"
description: "Connect to WebSocket, Socket.IO, MQTT and Kafka, send messages and events (with acknowledgements), subscribe and publish, read and produce Kafka topics, save connections in folders, and read clear connection errors."
---

::: v-pre

# WebSocket

The **WebSocket** view connects to a `ws://` or `wss://` server, sends messages and shows every message in both directions.

1. Enter the URL (variables such as `{{wsUrl}}` resolve from the active environment) and, if the server expects them, **Subprotocols** (comma separated) and **Handshake headers** (e.g. `Authorization`).
2. Click **Connect**. Cookies from the [cookie jar](./cookies.md) for the URL's domain are sent with the handshake.
3. Write a message (JSON or any text) and click **Send**.

The message log lists sent (↗), received (↙) and connection (ⓘ) messages with their time. The *Connected* message says how long the connection took and where the time went: DNS lookup, TCP connect and TLS handshake (on a new connection) and the upgrade handshake. Its header counts the messages and bytes in each direction and draws a sparkline of messages per second over the last minute. Filter it by text or direction, and click a message to see it in full (JSON as a tree). Connecting, sending and closing also appear in the [console](./rest.md#console).

## Socket.IO

Switch the protocol to **Socket.IO** to talk to a [Socket.IO](https://socket.io) server:

- The URL is the server and the namespace, e.g. `http://localhost:3000/chat` (`https://` for TLS). Set the **path** if the server doesn't use `/socket.io`.
- **Auth** is the handshake's auth payload (JSON), e.g. `{ "token": "{{accessToken}}" }`; handshake headers work too.
- On **Emit**, give the **event name** and its arguments as JSON (a JSON list sends several arguments). Tick **Acknowledgement** to wait for the server's reply (callback); it appears as `ack <event>`.
- Every event the server sends appears with its name. A refused connection shows the server's reason (e.g. `not authorized`).

The demo servers include a Socket.IO namespace: `http://127.0.0.1:4015/chat` (emit `say`; the server broadcasts `said` and acknowledges).

## MQTT

Switch the protocol to **MQTT** to talk to an MQTT broker (MQTT 3.1.1 or 5), e.g. for IoT devices or event pipelines:

- The URL is the broker: `mqtt://host:1883`, `mqtts://host:8883` for TLS, or `ws://` / `wss://` with the path (often `/mqtt`) for brokers behind WebSocket. Leave **Client ID** empty for a random one.
- **Subscriptions** lists the topic filters to receive (`+` matches one level, `#` the rest), each with its QoS. They are subscribed when you connect; while connected, adding or removing one subscribes or unsubscribes at once.
- **Connection** has the username, the password and the protocol version. Put the password in a [secret variable](./environments.md#secrets) and enter `{{mqttPassword}}`: only a variable reference is saved. A typed password is masked and used until you close the app, never written to the draft or the saved connection.
- On **Publish**, give the topic, the QoS (0 at most once, 1 at least once, 2 exactly once) and **Retain** if the broker should keep the message for new subscribers. The payload is text (JSON or anything else); `{{variables}}` resolve in the topic and the payload.
- Every message shows its topic (and *retained* for a retained message); the filter matches topics too.

The demo servers include a broker: `mqtt://127.0.0.1:4016`. Subscribe to `clinic/+/vitals` to see two monitors report every 2 seconds, and publish `{ "action": "recheck" }` to `clinic/7/commands` to get an answer on `clinic/7/acks`.

## Kafka

Switch the protocol to **Kafka** to read and produce the topics of a Kafka cluster:

- The URL is the cluster's bootstrap brokers: `kafka://host:9092`, several separated by commas (`kafka://a:9092,b:9092`), `kafkas://` for TLS listeners.
- **Topics** lists the topics to read, each **from the beginning** (what the topic holds already, then new messages) or only new messages. They are read when you connect; while connected, adding or removing one applies at once. **Topics** on the right lists the cluster's topics to pick from. Reading uses a consumer group of its own (`testpion-…`), so it never takes messages away from your real consumers; set **Consumer group** under **Connection** only when you mean to.
- On **Produce**, give the topic, an optional **key** (the same key always goes to the same partition) and the value; **Message headers** adds headers. `{{variables}}` resolve in all of them.
- **Connection** has the SASL mechanism (PLAIN, SCRAM-SHA-256, SCRAM-SHA-512), username and password (`{{kafkaPassword}}`: only a variable reference is saved), and the consumer group.
- Every received message shows its topic, partition and offset, and its key; selecting one shows its headers above the value.

The demo servers include a broker: `kafka://127.0.0.1:4017`. Read `clinic.events` from the beginning to see three events; any other topic is created when you use it.

Kafka tests look like MQTT tests:

```yaml
- name: An order is confirmed
  type: kafka
  url: "{{kafkaBrokers}}"
  subscribe:
    - { topic: order-confirmations }          # new messages; fromBeginning: true reads what is there
  send:
    - { topic: orders, key: order-42, value: { id: 42 }, headers: { source: testpion } }
  waitMs: 3000
  assertions:
    - { type: equals, path: "$.received[0].key", expected: order-42 }
```

Each received message is `{ topic, key, partition, offset, headers, data }`, with `data` parsed as JSON when it is JSON.

## Saved connections

The **Saved connections** list keeps connections (URL, subprotocols, handshake headers and the message) in folders:

- **Save** stores the current connection, or saves the changes to the one you opened (*Save\**).
- Create folders with the folder button above the list. Move a connection with its `⋯` / right-click menu (*Move to folder…*) or by dragging it onto a folder.
- Rename, duplicate and delete from the same menu.

**Saved messages:** above the message editor, **Save message** keeps the current message under a name (for Socket.IO, with its event), and the list next to it puts one back in the editor to send again. They are saved with the connection, so a connection can carry the handful of messages you send to it (subscribe, ping, unsubscribe …).

Saved connections live in the workspace (`library/websocket.json`). Use `{{variables}}` for tokens in headers, and keep the values in [secret variables](./environments.md#secrets).

## WebSocket tests

A test file with `type: websocket` connects, sends messages in order, listens for `waitMs`, and closes. The assertions run on:

- `$.received`: each message the server sent, parsed as JSON when it is JSON. With Socket.IO, each item is `{ event, data }`; with MQTT, `{ topic, data }`.
- `$.messages`: everything, with direction and time.
- The plain text of the received messages, for `contains` without a path.

A test that can't connect is an error that gives the reason.

```yaml
name: Echo server replies
type: websocket              # socketio for Socket.IO (or an http(s):// URL)
url: "{{wsEcho}}"
send:
  - hello                    # a text frame
  - { type: ping, id: 1 }    # objects are sent as JSON
waitMs: 1500
assertions:
  - { type: status, expected: 101 }            # connected (Switching Protocols)
  - { type: equals, path: "$.received[0]", expected: hello }
  - { type: equals, path: "$.received[1].type", expected: ping }
```

For Socket.IO, `send` items are `{ event, args, ack }`. Add `path:` if the server doesn't use `/socket.io`, and `auth:` for a handshake payload. The same exchange works from the terminal with [`testpion ws`](../cli/reference.md), and for AI agents with the `realtime_exchange` MCP tool.

For MQTT, use `type: mqtt` (or an `mqtt://` URL): `subscribe` lists topic filters, `send` items are `{ topic, payload, qos, retain }` and are published after subscribing, and `username` / `password` log in (use a variable for the password).

```yaml
name: A recheck command is acknowledged
type: mqtt
url: "{{mqttBroker}}"          # mqtt://127.0.0.1:4016
subscribe: [clinic/7/acks]
send:
  - { topic: clinic/7/commands, payload: { action: recheck }, qos: 1 }
waitMs: 1000
assertions:
  - { type: equals, path: "$.received[0].topic", expected: clinic/7/acks }
  - { type: equals, path: "$.received[0].data.ok", expected: true }
```

From the terminal, [`testpion mqtt`](../cli/reference.md#mqtt) subscribes, publishes and prints what arrives; AI agents use `realtime_exchange` with `mode: mqtt`.

### Check messages against an AsyncAPI document

The `asyncapi` check is contract testing for realtime APIs: every received message must be one of the messages its channel declares in an AsyncAPI 2 or 3 document. The channel is the message's topic (MQTT, Kafka) or event (Socket.IO), matched against the channels' addresses with their `{parameters}`. For plain WebSocket, name the channel in the check.

```yaml
assertions:
  - { type: asyncapi, spec: specs/clinic-events.asyncapi.yaml }
  - { type: asyncapi, spec: specs/prices.asyncapi.yaml, channel: /prices }    # WebSocket
```

A message that matches none of its channel's messages fails the check, with what is wrong (`message 2 on clinic.{clinicId}.appointments: /reason must be equal to one of the allowed values`). So does a message on a topic the document doesn't have, unless `allowUnknownChannels: true`. The document can be any file in the workspace, or the document itself inline under `spec`.

## When a connection fails

The reason is shown in the message log, with what to try:

| Message | What it means |
|---|---|
| *Can't find the server "…" (its name doesn't resolve)* | The host name doesn't exist (a typo, or a service that was retired). |
| *Nothing is listening on host:port (connection refused)* | The server isn't running, or the port is wrong. |
| *The server answered HTTP 401 / 404 … instead of opening a WebSocket* | The URL isn't a WebSocket endpoint, or the server wants credentials (add them under **Handshake headers**). |
| *… doesn't use TLS on this port, but the URL starts with wss://* | Use `ws://`. |

The demo servers include a WebSocket echo server: `node examples/servers/demo-servers.mjs`, then connect to `ws://127.0.0.1:4013`.

:::
