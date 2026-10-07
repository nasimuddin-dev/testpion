import { describe, expect, it } from 'vitest';
import { asyncApiOutline } from '../../packages/core/src/index.js';

describe('AsyncAPI outline', () => {
  it('AsyncAPI 2: channels with what the API does on them, messages with payload outlines and examples', () => {
    const o = asyncApiOutline(`asyncapi: 2.6.0
info: { title: Clinic events, version: '2', description: What happens. }
servers: { local: { url: 'localhost:9092', protocol: kafka } }
channels:
  clinic.appointments:
    description: Bookings.
    publish:
      message: { name: Book, payload: { type: object, required: [pet], properties: { pet: { type: string } } }, examples: [{ payload: { pet: Byron } }] }
    subscribe:
      message:
        oneOf:
          - { name: Booked, payload: { type: object, properties: { id: { type: string } } } }
          - { name: Book, payload: { type: object } }
`);
    expect(o).toMatchObject({ title: 'Clinic events', version: '2', asyncapi: '2.6.0', servers: [{ name: 'local', url: 'localhost:9092', protocol: 'kafka' }] });
    const c = o.channels[0]!;
    expect(c).toMatchObject({ address: 'clinic.appointments', description: 'Bookings.', actions: ['receive', 'send'] });
    expect(c.messages.map((m) => m.name)).toEqual(['Book', 'Booked']);
    expect(c.messages[0]!.payload).toMatch(/pet: string/);
    expect(c.messages[0]!.example).toEqual({ pet: 'Byron' });
  });

  it('AsyncAPI 3: addresses, servers by reference, actions from the operations', () => {
    const o = asyncApiOutline(`asyncapi: 3.0.0
info: { title: Kennel, version: '1' }
servers: { broker: { host: 'mqtt.example:1883', protocol: mqtt } }
channels:
  temp:
    address: kennel/{id}/temperature
    servers: [{ $ref: '#/servers/broker' }]
    messages: { reading: { name: Reading, payload: { schemaFormat: x, schema: { type: object, properties: { c: { type: number } } } } } }
operations:
  out: { action: send, channel: { $ref: '#/channels/temp' } }
`);
    expect(o.servers[0]).toEqual({ name: 'broker', url: 'mqtt.example:1883', protocol: 'mqtt' });
    expect(o.channels[0]).toMatchObject({ id: 'temp', address: 'kennel/{id}/temperature', servers: ['broker'], actions: ['send'] });
    expect(o.channels[0]!.messages[0]!.payload).toMatch(/c\?: number/);
    expect(() => asyncApiOutline('openapi: 3.0.0')).toThrow(/Not an AsyncAPI document/);
  });
});
