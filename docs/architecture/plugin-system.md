---
title: "Plugin system"
description: "Extending TestPion with protocol adapters and custom checks."
---

::: v-pre

# Extensibility

## Protocol adapters

```ts
import { registerProtocol, type ProtocolAdapter } from '@testpion/core';

registerProtocol({
  id: 'grpc',
  name: 'gRPC',
  async connect(config) { /* … */ },
  async execute(request, ctx) { /* … */ },
  async disconnect(conn) { /* … */ },
} satisfies ProtocolAdapter);
```

HTTP, GraphQL, MCP and WebSocket are registered this way. Adapters are independent of each other and of the UI.

## Custom checks

```ts
import { registerCheck } from '@testpion/core';
registerCheck('is-uuid', (cfg, ctx) => ({
  type: 'is-uuid', name: 'is uuid', source: 'deterministic',
  passed: /^[0-9a-f-]{36}$/.test(String(ctx.body)), message: '…',
}));
```

Built-in adapters include HTTP, GraphQL, gRPC, WebSocket, Socket.IO, MQTT, Kafka and MCP.

:::
