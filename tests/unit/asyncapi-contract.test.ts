import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { asyncApiChannels, checkAsyncApiMessages, runChecks } from '../../packages/core/src/index.js';

const v2 = parse(`asyncapi: 2.6.0
info: { title: Clinic events, version: '1' }
channels:
  clinic.{clinicId}.appointments:
    subscribe:
      message:
        oneOf:
          - $ref: '#/components/messages/Booked'
          - name: Cancelled
            payload: { type: object, required: [id, reason], properties: { id: { type: string }, reason: { type: string, enum: [owner, vet] } } }
  /prices:
    subscribe:
      message: { payload: { type: object, required: [price], properties: { price: { type: number } } } }
components:
  messages:
    Booked:
      name: Booked
      payload: { $ref: '#/components/schemas/Appointment' }
  schemas:
    Appointment:
      type: object
      required: [id, pet]
      properties:
        id: { type: string }
        pet: { type: string }
`);

const v3 = parse(`asyncapi: 3.0.0
info: { title: Kennel, version: '1' }
channels:
  temperature:
    address: kennel/{kennel}/temperature
    messages:
      reading:
        payload:
          schemaFormat: application/vnd.aai.asyncapi+json;version=3.0.0
          schema: { type: object, required: [celsius], properties: { celsius: { type: number } } }
`);

describe('AsyncAPI contract', () => {
  it('reads channels with their messages and matches addresses with parameters', () => {
    const ch = asyncApiChannels(v2);
    expect(ch.map((c) => [c.address, c.payloads.map((p) => p.name)])).toEqual([
      ['clinic.{clinicId}.appointments', ['Booked', 'Cancelled']],
      ['/prices', ['message 1']],
    ]);
    expect(ch[0]!.match.test('clinic.north.appointments')).toBe(true);
    expect(ch[0]!.match.test('clinic.north.invoices')).toBe(false);
    expect(asyncApiChannels(v3)[0]!.match.test('kennel/k7/temperature')).toBe(true);
  });

  it("a message passes when it matches one of its channel's messages", () => {
    const ok = checkAsyncApiMessages(v2, [
      { topic: 'clinic.north.appointments', data: { id: 'a1', pet: 'Byron' } },
      { topic: 'clinic.south.appointments', data: { id: 'a2', reason: 'vet' } },
    ]);
    expect(ok).toEqual({ passed: true, problems: [], checked: 2 });
    expect(checkAsyncApiMessages(v3, [{ topic: 'kennel/k7/temperature', data: { celsius: 21.5 } }]).passed).toBe(true);
  });

  it('says which message is wrong, and where', () => {
    const r = checkAsyncApiMessages(v2, [
      { topic: 'clinic.north.appointments', data: { id: 'a1', pet: 'Byron' } },
      { topic: 'clinic.north.appointments', data: { id: 'a3', reason: 'weather' } },
      { topic: 'clinic.north.invoices', data: {} },
    ]);
    expect(r.passed).toBe(false);
    expect(r.problems[0]).toMatch(/^message 2 on clinic\.\{clinicId\}\.appointments: Booked: .*pet.* \| Cancelled: \/reason must be equal to one of the allowed values/);
    expect(r.problems[1]).toBe('message 3 on clinic.north.invoices: no channel of the document matches it');
    expect(checkAsyncApiMessages(v2, [{ topic: 'clinic.north.invoices', data: {} }], { allowUnknownChannels: true }).passed).toBe(true);
  });

  it('plain WebSocket messages are checked against the channel the check names', () => {
    expect(checkAsyncApiMessages(v2, [{ price: 3 }], { channel: '/prices' }).passed).toBe(true);
    expect(checkAsyncApiMessages(v2, [{ price: 'free' }], { channel: '/prices' }).problems[0]).toMatch(/message 1 on \/prices: \/price must be number/);
    expect(checkAsyncApiMessages(v2, [{ price: 3 }]).problems[0]).toMatch(/no channel of the document given \(set channel in the check\)/);
  });

  it('runs as the asyncapi check of a realtime test', async () => {
    const ctx = { testType: 'websocket' as const, body: { connected: true, received: [{ topic: 'clinic.n.appointments', data: { id: 'x' } }] }, text: '' };
    const [bad] = await runChecks([{ type: 'asyncapi', spec: v2 }], ctx);
    expect(bad).toMatchObject({ passed: false, name: 'AsyncAPI contract' });
    expect(bad!.message).toMatch(/^1 of 1 messages don't match: message 1 on clinic/);
    const [good] = await runChecks([{ type: 'asyncapi', spec: v2 }], { ...ctx, body: { received: [{ topic: 'clinic.n.appointments', data: { id: 'x', pet: 'p' } }] } });
    expect(good).toMatchObject({ passed: true, message: '1 message matches the document' });
    const [http] = await runChecks([{ type: 'asyncapi', spec: v2 }], { testType: 'http', body: {}, text: '' });
    expect(http!.message).toMatch(/applies to WebSocket, Socket\.IO, MQTT and Kafka tests/);
  });
});
