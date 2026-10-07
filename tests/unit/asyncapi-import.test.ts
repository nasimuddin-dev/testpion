import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectFormat, importAny, importAsyncApi, importIntoWorkspace, WorkspaceStore } from '../../packages/core/src/index.js';

const kafka2 = `asyncapi: 2.6.0
info:
  title: Clinic events
  version: 1.0.0
  description: What happens at the clinic.
servers:
  production:
    url: broker.clinic.example:9093
    protocol: kafka-secure
  local:
    url: localhost:9092
    protocol: kafka
channels:
  clinic.{clinicId}.appointments:
    parameters:
      clinicId:
        schema: { type: string }
    publish:
      operationId: bookAppointment
      tags: [{ name: appointments }]
      message:
        $ref: '#/components/messages/AppointmentBooked'
    subscribe:
      message:
        oneOf:
          - $ref: '#/components/messages/AppointmentBooked'
          - name: AppointmentCancelled
            payload:
              type: object
              properties:
                id: { type: string, format: uuid }
                reason: { type: string, enum: [owner, vet] }
components:
  messages:
    AppointmentBooked:
      name: AppointmentBooked
      headers:
        type: object
        properties:
          source: { type: string, example: front-desk }
      bindings:
        kafka:
          key: { type: string, example: pet-7 }
      payload:
        $ref: '#/components/schemas/Appointment'
  schemas:
    Appointment:
      type: object
      properties:
        id: { type: string, format: uuid }
        pet: { type: string, example: Byron }
        at: { type: string, format: date-time }
`;

const mqtt3 = `asyncapi: 3.0.0
info: { title: Kennel sensors, version: '1' }
servers:
  broker:
    host: mqtt.kennel.example:8883
    protocol: secure-mqtt
channels:
  temperature:
    address: kennel/{kennel}/temperature
    bindings: { mqtt: { qos: 1 } }
    messages:
      reading:
        name: Reading
        examples:
          - payload: { celsius: 21.5 }
  commands:
    address: kennel/{kennel}/fan
    messages:
      fan:
        payload: { type: object, properties: { on: { type: boolean } } }
operations:
  sendReading:
    action: send
    channel: { $ref: '#/channels/temperature' }
  receiveFan:
    action: receive
    channel: { $ref: '#/channels/commands' }
`;

const byName = (items: Array<{ name: string; data: any }>, n: string) => items.find((i) => i.name === n)!.data;

describe('AsyncAPI import', () => {
  it('is detected, in YAML and JSON', () => {
    expect(detectFormat(kafka2)).toBe('asyncapi');
    expect(detectFormat(JSON.stringify({ asyncapi: '3.0.0', info: { title: 'x' } }))).toBe('asyncapi');
  });

  it('AsyncAPI 2 / Kafka: a connection per channel, servers as an environment, examples ready to produce', () => {
    const r = importAsyncApi(kafka2);
    expect(r.collection).toMatchObject({ name: 'Clinic events', description: 'What happens at the clinic.', items: [] });
    expect(r.environment!.variables).toEqual([
      { key: 'productionUrl', value: 'kafkas://broker.clinic.example:9093', enabled: true },
      { key: 'localUrl', value: 'kafka://localhost:9092', enabled: true },
    ]);
    const items = r.savedItems!.websocket;
    expect(items).toHaveLength(1);
    expect(items[0]!.folder).toBe('appointments');
    const d = byName(items, 'clinic.{clinicId}.appointments');
    expect(d).toMatchObject({ url: '{{productionUrl}}', mode: 'kafka', topic: 'clinic.{{clinicId}}.appointments', key: 'pet-7', reads: [{ topic: 'clinic.{{clinicId}}.appointments' }] });
    expect(JSON.parse(d.message)).toEqual({ id: '00000000-0000-0000-0000-000000000000', pet: 'Byron', at: '1970-01-01T00:00:00.000Z' });
    expect(d.kafkaHeaders).toEqual([{ key: 'source', value: 'front-desk', enabled: true }]);
    // every message the channel carries is kept to send again
    expect(d.savedMessages.map((m: { name: string }) => m.name)).toEqual(['AppointmentBooked', 'AppointmentBooked', 'AppointmentCancelled']);
    expect(JSON.parse(d.savedMessages[2].message)).toEqual({ id: '00000000-0000-0000-0000-000000000000', reason: 'owner' });
  });

  it('AsyncAPI 3 / MQTT: what the application sends is subscribed to, what it receives is published', () => {
    const r = importAsyncApi(mqtt3);
    expect(r.environment!.variables[0]).toMatchObject({ key: 'brokerUrl', value: 'mqtts://mqtt.kennel.example:8883' });
    const items = r.savedItems!.websocket;
    const temp = byName(items, 'kennel/{kennel}/temperature');
    expect(temp).toMatchObject({ mode: 'mqtt', topic: 'kennel/{{kennel}}/temperature', qos: 1, subscriptions: [{ topic: 'kennel/+/temperature', qos: 1 }] });
    expect(JSON.parse(temp.message)).toEqual({ celsius: 21.5 });
    const fan = byName(items, 'kennel/{kennel}/fan');
    expect(fan).toMatchObject({ mode: 'mqtt', topic: 'kennel/{{kennel}}/fan', subscriptions: [] });
    expect(JSON.parse(fan.message)).toEqual({ on: false });
  });

  it('WebSocket channels are paths on the server; unsupported protocols are reported', () => {
    const ws = importAsyncApi(`asyncapi: 2.6.0
info: { title: Live, version: '1' }
servers:
  live: { url: 'live.example.com/v1', protocol: wss }
  queue: { url: 'rabbit.example.com', protocol: amqp }
channels:
  /prices:
    servers: [live]
    subscribe: { message: { payload: { type: object, properties: { price: { type: number } } } } }
  orders:
    servers: [queue]
    publish: { message: { payload: { type: string } } }
`);
    expect(byName(ws.savedItems!.websocket, '/prices')).toMatchObject({ mode: 'websocket', url: '{{liveUrl}}/prices' });
    expect(ws.skipped).toEqual(['orders: the amqp protocol is not supported (Kafka, MQTT, WebSocket and Socket.IO are)']);
    expect(ws.collection.description).toMatch(/Not imported: orders/);
    expect(() =>
      importAsyncApi(`asyncapi: 2.6.0\ninfo: { title: Q, version: '1' }\nservers: { q: { url: x, protocol: amqp } }\nchannels: { a: { publish: { message: { payload: { type: string } } } } }\n`),
    ).toThrow(/Nothing to import/);
  });

  it('imports into a workspace: the connections belong to the collection, the servers are an environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-asyncapi-'));
    try {
      const store = WorkspaceStore.create(dir, 'asyncapi');
      const out = importIntoWorkspace(store, kafka2);
      expect(out.format).toBe('asyncapi');
      expect(out.savedItems).toEqual({ websocket: 1 });
      expect(store.listEnvironments().map((e) => e.name)).toContain('Clinic events servers');
      expect(importAny(mqtt3).format).toBe('asyncapi');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
