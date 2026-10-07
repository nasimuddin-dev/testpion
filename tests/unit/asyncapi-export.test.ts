import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectionToAsyncApi, importAsyncApi, type LibraryItem } from '../../packages/core/src/index.js';

const kafka = `asyncapi: 2.6.0
info: { title: Clinic events, version: '1' }
servers:
  local: { url: 'localhost:9092', protocol: kafka }
channels:
  clinic.appointments:
    publish:
      message: { name: Booked, payload: { type: object, properties: { id: { type: string, example: a1 }, pet: { type: string, example: Byron } } } }
    subscribe:
      message: { name: Booked, payload: { type: object, properties: { id: { type: string } } } }
`;

const resolveUrls = (items: LibraryItem[], vars: Record<string, string>) =>
  items.map((i) => ({ ...i, data: { ...(i.data as object), url: String((i.data as { url: string }).url).replace(/\{\{(\w+)\}\}/, (_m, k: string) => vars[k] ?? '') } }));

describe('AsyncAPI export', () => {
  it('writes servers, channels with example messages, and operations from saved connections', () => {
    const imp = importAsyncApi(kafka);
    const vars = Object.fromEntries(imp.environment!.variables.map((v) => [v.key, v.value]));
    const out = collectionToAsyncApi(imp.collection, resolveUrls(imp.savedItems!.websocket, vars));
    expect(out.notes).toEqual([]);
    expect(out.doc.servers).toEqual({ kafka_localhost_9092: { host: 'localhost:9092', protocol: 'kafka' } });
    const ch = out.doc.channels.clinic_appointments;
    expect(ch.address).toBe('clinic.appointments');
    expect(ch.messages.Booked).toMatchObject({
      name: 'Booked',
      payload: { type: 'object', properties: { id: { type: 'string' }, pet: { type: 'string' } } },
      examples: [{ payload: { id: 'a1', pet: 'Byron' } }],
    });
    expect(
      Object.values(out.doc.operations)
        .map((o: any) => o.action)
        .sort(),
    ).toEqual(['receive', 'send']);
  });

  it('imports back: the same connections', () => {
    const imp = importAsyncApi(kafka);
    const vars = Object.fromEntries(imp.environment!.variables.map((v) => [v.key, v.value]));
    const out = collectionToAsyncApi(imp.collection, resolveUrls(imp.savedItems!.websocket, vars));
    expect(parse(out.text).asyncapi).toBe('3.0.0');
    const again = importAsyncApi(out.text).savedItems!.websocket;
    expect(again.map((i) => [(i.data as any).mode, (i.data as any).topic, (i.data as any).reads])).toEqual([['kafka', 'clinic.appointments', [{ topic: 'clinic.appointments' }]]]);
  });

  it('MQTT subscriptions and WebSocket paths become channels; a collection without connections says so', () => {
    const items: LibraryItem[] = [
      { id: '1', name: 'Kennel', data: { url: 'mqtts://broker.example:8883', mode: 'mqtt', topic: 'kennel/7/fan', message: '{"on":true}', subscriptions: [{ topic: 'kennel/+/temperature' }] } },
      { id: '2', name: 'Prices', data: { url: 'wss://live.example.com/prices', mode: 'websocket', message: '{"subscribe":"EUR"}' } },
    ];
    const out = collectionToAsyncApi({ name: 'Live' }, items);
    expect(
      Object.values(out.doc.channels)
        .map((c: any) => c.address)
        .sort(),
    ).toEqual(['/prices', 'kennel/+/temperature', 'kennel/7/fan']);
    expect(out.doc.servers.secure_mqtt_broker_example_8883.protocol).toBe('secure-mqtt');
    expect(collectionToAsyncApi({ name: 'Empty' }, []).notes[0]).toMatch(/no connections/);
  });
});
