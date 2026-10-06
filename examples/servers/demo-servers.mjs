#!/usr/bin/env node
/**
 * Local demo servers for TestPion examples, docs and integration tests.
 * Nothing here talks to the internet.
 *
 *   node examples/servers/demo-servers.mjs
 *
 *   REST API        http://127.0.0.1:4010   (veterinary API, bearer auth, SSE, large payloads)
 *   SOAP service    http://127.0.0.1:4010/soap/patients (WSDL: GET /soap/patients?wsdl; GetPatient, RegisterPatient)
 *   GraphQL         http://127.0.0.1:4011/graphql
 *   Mock LLM        http://127.0.0.1:4012/v1  (OpenAI-compatible: chat completions, streaming, tools, embeddings)
 *   WebSocket echo  ws://127.0.0.1:4013
 *   Socket.IO       http://127.0.0.1:4015/chat (events: say → said, with acknowledgement; welcome on connect)
 *   MQTT broker     mqtt://127.0.0.1:4016  (clinic/<id>/vitals every 2 s; clinic/<id>/commands → clinic/<id>/acks)
 *   gRPC            127.0.0.1:4014        (vet.v1.PetService, examples/veterinary-workspace/protos/vet/v1/pets.proto)
 *   Kafka           kafka://127.0.0.1:4017 (in-process broker; topic clinic.events holds 3 events, any topic is created on use)
 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildSchema, graphql } from 'graphql';
import { WebSocketServer } from 'ws';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';
import { Server as SocketIoServer } from 'socket.io';
import { Kafka, logLevel } from 'kafkajs';
import { startKafkaBroker } from './kafka-broker.mjs';
import { createServer as createTcpServer } from 'node:net';
import { Aedes } from 'aedes';

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
/** SOAP: the patient service described by patients.wsdl (SOAP 1.1 and 1.2). */
const WSDL = readFileSync(new URL('./patients.wsdl', import.meta.url), 'utf8');
function soapReply(req, res, body, patients, nextId) {
  const soap12 = /soap\+xml/.test(req.headers['content-type'] ?? '');
  const envNs = soap12 ? 'http://www.w3.org/2003/05/soap-envelope' : 'http://schemas.xmlsoap.org/soap/envelope/';
  const send = (status, inner) => {
    res.writeHead(status, { 'content-type': soap12 ? 'application/soap+xml; charset=utf-8' : 'text/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="utf-8"?>\n<soap:Envelope xmlns:soap="${envNs}">\n  <soap:Body>\n${inner}\n  </soap:Body>\n</soap:Envelope>`);
  };
  const fault = (msg) => send(soap12 ? 400 : 500, soap12 ? `    <soap:Fault><soap:Code><soap:Value>soap:Sender</soap:Value></soap:Code><soap:Reason><soap:Text xml:lang="en">${msg}</soap:Text></soap:Reason></soap:Fault>` : `    <soap:Fault><faultcode>soap:Client</faultcode><faultstring>${msg}</faultstring></soap:Fault>`);
  const tag = (name, xml = body) => (new RegExp(`<(?:[\\w-]+:)?${name}>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(xml) ?? [])[1];
  const xmlPatient = (pt) => `<patient><name>${pt.name}</name><species>${pt.species.toUpperCase()}</species><id>${pt.id}</id></patient>`;
  if (/<(?:[\w-]+:)?GetPatient[\s>]/.test(body)) {
    const pt = patients.get(String(tag('id') ?? ''));
    if (!pt) return fault(`No patient with id ${tag('id') ?? '(none)'}`);
    return send(200, `    <GetPatientResponse xmlns="http://vet.example/patients">${xmlPatient(pt)}</GetPatientResponse>`);
  }
  if (/<(?:[\w-]+:)?RegisterPatient[\s>]/.test(body)) {
    const name = tag('name');
    if (!name || name === '?') return fault('The patient needs a name');
    const id = String(nextId());
    patients.set(id, { id, name, species: String(tag('species') ?? 'dog').toLowerCase(), ownerId: '123' });
    return send(200, `    <RegisterPatientResponse xmlns="http://vet.example/patients">${id}</RegisterPatientResponse>`);
  }
  return fault('Unknown operation: send GetPatient or RegisterPatient');
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });

/* ------------------------------------------------------------------ REST */

export const DEMO_TOKEN = 'demo-token-3f9a1c';

/** An OpenID Connect style id_token (a JWT signed with a demo secret) for the user who asked for the token. */
function demoIdToken(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: 'http://127.0.0.1/demo-auth', sub, aud: ['veterinary-api'], scope: 'patients:read patients:write', iat: now, exp: now + 3600 })}`;
  return `${body}.${createHmac('sha256', 'demo-secret').update(body).digest('base64url')}`;
}

export function createRestServer() {
  const patients = new Map([
    ['1', { id: '1', name: 'Rex', species: 'dog', ownerId: '123' }],
    ['2', { id: '2', name: 'Whiskers', species: 'cat', ownerId: '456' }],
  ]);
  let nextId = 3;
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const auth = req.headers.authorization;
    const authed = auth === `Bearer ${DEMO_TOKEN}`;
    const p = url.pathname;

    if (p === '/health') return json(res, 200, { status: 'ok', time: new Date().toISOString() });
    // SOAP (no auth): the WSDL with this server's address, and the operations
    if (p === '/soap/patients') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/xml; charset=utf-8' });
        return res.end(WSDL.replaceAll('http://localhost:8080/soap/patients', `http://127.0.0.1:${req.socket.localPort}/soap/patients`));
      }
      return soapReply(req, res, await readBody(req), patients, () => nextId++);
    }
    if (p === '/auth/token' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      let creds = {};
      try {
        creds = JSON.parse(body);
      } catch {
        creds = Object.fromEntries(params);
      }
      if ((creds.client_id === 'demo' && creds.client_secret === 'demo-secret') || (creds.username === 'vet' && creds.password === 'paws'))
        return json(res, 200, { access_token: DEMO_TOKEN, token_type: 'Bearer', expires_in: 3600, id_token: demoIdToken(creds.username ?? creds.client_id) });
      return json(res, 401, { error: 'invalid_client', message: 'Unknown client credentials' });
    }
    // cookie session: POST /session/login sets a session cookie and redirects to /session/me
    if (p === '/session/login' && req.method === 'POST') {
      const body = await readBody(req);
      let creds = {};
      try {
        creds = JSON.parse(body);
      } catch {
        creds = Object.fromEntries(new URLSearchParams(body));
      }
      if (creds.username !== 'vet' || creds.password !== 'paws') return json(res, 401, { error: 'invalid_credentials' });
      res.writeHead(303, { location: '/session/me', 'set-cookie': ['vet_session=s-7f3a9; Path=/session; HttpOnly; SameSite=Lax', 'clinic=north; Path=/'] });
      return res.end();
    }
    if (p === '/session/me') {
      const cookies = Object.fromEntries((req.headers.cookie ?? '').split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf('=')), c.slice(c.indexOf('=') + 1)]));
      if (cookies.vet_session !== 's-7f3a9') return json(res, 401, { error: 'not_logged_in' });
      return json(res, 200, { user: 'vet', clinic: cookies.clinic ?? null });
    }
    if (p === '/session/logout') {
      res.writeHead(204, { 'set-cookie': ['vet_session=; Path=/session; Max-Age=0'] });
      return res.end();
    }
    if (p === '/echo') {
      const body = await readBody(req);
      return json(res, 200, { method: req.method, path: p, query: Object.fromEntries(url.searchParams), headers: req.headers, body }, { 'set-cookie': ['session=abc123; Path=/; HttpOnly', 'theme=dark; Path=/'] });
    }
    if (p === '/delay') {
      await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') ?? 1000)));
      return json(res, 200, { delayed: true });
    }
    if (p === '/status') return json(res, Number(url.searchParams.get('code') ?? 500), { error: 'requested status' });
    if (p === '/large') {
      // streams ~N MB of JSON without buffering it
      const mb = Number(url.searchParams.get('mb') ?? 10);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"items":[');
      const row = JSON.stringify({ id: 0, name: 'x'.repeat(200), tags: ['a', 'b', 'c'] });
      const n = Math.floor((mb * 1024 * 1024) / row.length);
      let i = 0;
      const pump = () => {
        while (i < n) {
          const ok = res.write((i ? ',' : '') + row.replace('"id":0', `"id":${i}`));
          i++;
          if (!ok) return res.once('drain', pump);
        }
        res.end(']}');
      };
      return pump();
    }
    if (p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let n = 0;
      const t = setInterval(() => {
        res.write(`event: tick\ndata: ${JSON.stringify({ n, time: Date.now() })}\n\n`);
        if (++n >= Number(url.searchParams.get('count') ?? 5)) {
          clearInterval(t);
          res.end();
        }
      }, 200);
      req.on('close', () => clearInterval(t));
      return;
    }
    if (p.startsWith('/patients')) {
      if (!auth) return json(res, 401, { error: 'unauthorized', message: 'Missing bearer token' }, { 'www-authenticate': 'Bearer' });
      if (!authed) return json(res, 403, { error: 'forbidden', message: 'Invalid token' });
      const id = p.split('/')[2];
      if (req.method === 'GET' && !id) return json(res, 200, { items: [...patients.values()], total: patients.size });
      if (req.method === 'GET') return patients.has(id) ? json(res, 200, patients.get(id)) : json(res, 404, { error: 'not_found', message: `Patient ${id} not found` });
      if (req.method === 'POST') {
        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          return json(res, 400, { error: 'invalid_json' });
        }
        if (!body.name || !body.species) return json(res, 422, { error: 'validation', fields: { name: !body.name ? 'required' : undefined, species: !body.species ? 'required' : undefined } });
        const pt = { id: String(nextId++), name: body.name, species: body.species, ownerId: body.ownerId ?? null };
        patients.set(pt.id, pt);
        return json(res, 201, pt, { location: `/patients/${pt.id}` });
      }
      if (req.method === 'DELETE' && id) return patients.delete(id) ? json(res, 204, {}) : json(res, 404, { error: 'not_found' });
    }
    json(res, 404, { error: 'not_found', path: p });
  });
}

/* ------------------------------------------------------------------ GraphQL */

const schema = buildSchema(`
  "A patient of the clinic"
  type Patient { id: ID! name: String! species: Species! owner: Owner }
  type Owner { id: ID! name: String! }
  enum Species { DOG CAT BIRD OTHER }
  input PatientInput { name: String! species: Species! ownerId: ID }
  type Query {
    "Fetch one patient"
    patient(id: ID!): Patient
    patients(species: Species): [Patient!]!
    owner(id: ID!): Owner
  }
  type Mutation { createPatient(input: PatientInput!): Patient! }
`);

export function createGraphQLServer() {
  const owners = { 123: { id: '123', name: 'Ada Lovelace' }, 456: { id: '456', name: 'Alan Turing' } };
  const patients = [
    { id: '123', name: 'Rex', species: 'DOG', ownerId: '123' },
    { id: '124', name: 'Whiskers', species: 'CAT', ownerId: '456' },
  ];
  const withOwner = (p) => p && { ...p, owner: owners[p.ownerId] ?? null };
  const root = {
    patient: ({ id }) => withOwner(patients.find((p) => p.id === id)),
    patients: ({ species }) => patients.filter((p) => !species || p.species === species).map(withOwner),
    owner: ({ id }) => owners[id] ?? null,
    createPatient: ({ input }) => {
      const p = { id: String(200 + patients.length), ...input };
      patients.push(p);
      return withOwner(p);
    },
  };
  return createServer(async (req, res) => {
    if (req.method !== 'POST') return json(res, 405, { errors: [{ message: 'Use POST' }] });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { errors: [{ message: 'Invalid JSON' }] });
    }
    const result = await graphql({ schema, source: body.query, rootValue: root, variableValues: body.variables, operationName: body.operationName });
    json(res, 200, result);
  });
}

/* ------------------------------------------------------------------ Mock LLM */

/** Deterministic OpenAI-compatible model: classifies intents, answers from context, calls tools. */
export function createMockLlmServer() {
  const reply = (messages, tools, responseFormat) => {
    const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const text = typeof last === 'string' ? last : JSON.stringify(last);
    const toolResult = messages.find((m) => m.role === 'tool');
    if (tools?.length && !toolResult) {
      const pick = /appointment|book/i.test(text) ? 'create_appointment' : /customer|lookup|find/i.test(text) ? 'search_customer' : tools[0].function.name;
      const tool = tools.find((t) => t.function.name === pick) ?? tools[0];
      const id = /\b(\d{3})\b/.exec(text)?.[1] ?? '123';
      const args = tool.function.name === 'create_appointment' ? { customer_id: id, date: '2026-10-01', reason: 'checkup' } : { customer_id: id };
      return { content: null, tool_calls: [{ id: `call_${randomUUID().slice(0, 8)}`, type: 'function', function: { name: tool.function.name, arguments: JSON.stringify(args) } }] };
    }
    if (toolResult) return { content: `Done. Tool result: ${toolResult.content}` };
    if (/ignore (all|previous) instructions|reveal .*system prompt/i.test(text)) return { content: "I can't help with that request." };
    if (/classify|intent/i.test(text) || responseFormat) {
      // classify only the customer's message, not the instructions (which may list every label)
      const msg = /customer:\s*([\s\S]*)$/i.exec(text)?.[1] ?? text.split('\n').filter((l) => l.trim()).pop() ?? text;
      const intent = /cancel/i.test(msg) ? 'cancellation' : /refill|prescription/i.test(msg) ? 'refill' : /book|appointment|schedule/i.test(msg) ? 'booking' : 'other';
      return { content: JSON.stringify({ intent, category: intent, confidence: 0.93 }) };
    }
    if (/score/i.test(text) && /CRITERIA/.test(text)) return { content: JSON.stringify({ score: 0.9, reasoning: 'The response addresses the criteria (mock judge).' }) };
    const ctx = /Context:\n([\s\S]*?)\n\nQuestion:/.exec(text);
    if (ctx) {
      const first = /\[([^\]]+)\]\s*([^\n]+)/.exec(ctx[1]);
      return { content: first ? `${first[2]} [${first[1]}]` : "I don't know." };
    }
    return { content: `Echo: ${text.slice(0, 500)}` };
  };
  const usage = (messages, out) => {
    const p = Math.ceil(JSON.stringify(messages).length / 4);
    const c = Math.ceil((out ?? '').length / 4) || 5;
    return { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
  };
  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.endsWith('/models')) return json(res, 200, { data: [{ id: 'mock-gpt' }, { id: 'mock-small' }, { id: 'mock-embed' }] });
    const body = req.method === 'POST' ? JSON.parse((await readBody(req)) || '{}') : {};
    if (url.pathname.endsWith('/embeddings')) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const embed = (t) => {
        const v = new Array(32).fill(0);
        for (const w of String(t).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
          let h = 0;
          for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % 32] += 1;
        }
        return v;
      };
      return json(res, 200, { data: inputs.map((t, index) => ({ index, embedding: embed(t) })), usage: { prompt_tokens: 1, total_tokens: 1 } });
    }
    if (!url.pathname.endsWith('/chat/completions')) return json(res, 404, { error: { message: 'not found' } });
    if (req.headers.authorization === 'Bearer bad-key') return json(res, 401, { error: { message: 'Invalid API key' } });
    const msg = reply(body.messages ?? [], body.tools, body.response_format);
    const model = body.model ?? 'mock-gpt';
    const delay = model === 'mock-small' ? 5 : 20;
    if (!body.stream) {
      await new Promise((r) => setTimeout(r, delay));
      return json(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: 'chat.completion',
        model,
        choices: [{ index: 0, message: { role: 'assistant', ...msg }, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }],
        usage: usage(body.messages, msg.content),
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    await new Promise((r) => setTimeout(r, delay));
    if (msg.tool_calls) send({ model, choices: [{ index: 0, delta: { tool_calls: msg.tool_calls.map((t, index) => ({ index, ...t })) } }] });
    else
      for (const piece of (msg.content ?? '').match(/.{1,8}/gs) ?? []) {
        send({ model, choices: [{ index: 0, delta: { content: piece } }] });
        await new Promise((r) => setTimeout(r, 2));
      }
    send({ model, choices: [{ index: 0, delta: {}, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] });
    if (body.stream_options?.include_usage) send({ model, choices: [], usage: usage(body.messages, msg.content) });
    res.end('data: [DONE]\n\n');
  });
}

/* ------------------------------------------------------------------ WebSocket */

export function createWsServer(port) {
  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  wss.on('error', () => undefined);
  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({ type: 'welcome', time: Date.now() }));
    ws.on('message', (data) => ws.send(JSON.stringify({ type: 'echo', data: data.toString() })));
  });
  return wss;
}

/** gRPC: the veterinary PetService (unary, server streaming, client streaming). */
async function startGrpcServer(port) {
  const proto = fileURLToPath(new URL('../veterinary-workspace/protos/vet/v1/pets.proto', import.meta.url));
  const def = protoLoader.loadSync(proto, { keepCase: true, longs: String, enums: String, defaults: true });
  const { vet } = grpc.loadPackageDefinition(def);
  const pets = [
    { id: '1', name: 'Byron', species: 'CAT', owner_id: '123', born: { seconds: '1577923200', nanos: 0 } },
    { id: '2', name: 'Biscuit', species: 'DOG', owner_id: '123', born: { seconds: '1609459200', nanos: 0 } },
    { id: '3', name: 'Clover', species: 'RABBIT', owner_id: '456', born: { seconds: '1640995200', nanos: 0 } },
  ];
  const server = new grpc.Server();
  server.addService(vet.v1.PetService.service, {
    GetPet: (call, cb) => {
      const pet = pets.find((p) => p.id === String(call.request.id));
      if (!pet) return cb({ code: grpc.status.NOT_FOUND, details: `No pet with id ${call.request.id}` });
      cb(null, pet);
    },
    ListPets: (call) => {
      for (const p of pets) if (call.request.species === 'SPECIES_UNSPECIFIED' || p.species === call.request.species) call.write(p);
      call.end();
    },
    StreamVitals: (call) => {
      let n = 0;
      const max = call.request.readings || 20;
      const t = setInterval(() => {
        call.write({ pet_id: call.request.pet_id, temperature_c: Math.round((38 + Math.random()) * 10) / 10, heart_rate: 110 + Math.round(Math.random() * 30) });
        if (++n >= max) {
          clearInterval(t);
          call.end();
        }
      }, 200);
      call.on('cancelled', () => clearInterval(t));
    },
    CheckIn: (call, cb) => {
      const names = [];
      call.on('data', (p) => names.push(p.name));
      call.on('end', () => cb(null, { checked_in: names.length, names }));
    },
  });
  // server reflection: clients can list and call the methods without the .proto file
  new ReflectionService(def).addToServer(server);
  await new Promise((resolve, reject) => server.bindAsync(`127.0.0.1:${port}`, grpc.ServerCredentials.createInsecure(), (e) => (e ? reject(e) : resolve())));
  return server;
}

/** Socket.IO: a /chat namespace that greets, echoes "say" as "said" and acknowledges it. */
async function startSocketIo(port) {
  const http = createServer();
  const sio = new SocketIoServer(http, { cors: { origin: '*' } });
  sio.of('/chat').on('connection', (socket) => {
    socket.emit('welcome', { id: socket.id, time: new Date().toISOString() });
    socket.on('say', (msg, ack) => {
      sio.of('/chat').emit('said', { from: socket.id, msg });
      if (typeof ack === 'function') ack({ ok: true, received: msg });
    });
  });
  await listen(http, port);
  return { http, sio };
}

/**
 * MQTT: a broker where two monitors publish clinic/7/vitals and clinic/8/vitals every 2 s, and a
 * command published to clinic/<id>/commands is acknowledged on clinic/<id>/acks.
 */
async function startMqtt(port) {
  const broker = await Aedes.createBroker();
  const publish = (topic, body) => broker.publish({ cmd: 'publish', topic, payload: Buffer.from(JSON.stringify(body)), qos: 0, dup: false, retain: false }, () => {});
  let beat = 0;
  const timer = setInterval(() => {
    beat++;
    for (const id of [7, 8]) publish(`clinic/${id}/vitals`, { patient: id, heartRate: 70 + ((beat * id) % 15), temperature: 38.2 + (beat % 4) / 10, time: new Date().toISOString() });
  }, 2000);
  timer.unref();
  broker.on('publish', (packet, client) => {
    const m = client && /^clinic\/([^/]+)\/commands$/.exec(packet.topic);
    if (!m) return;
    let command;
    try {
      command = JSON.parse(packet.payload.toString());
    } catch {
      command = packet.payload.toString();
    }
    publish(`clinic/${m[1]}/acks`, { ok: true, patient: m[1], command, by: client.id });
  });
  const server = createTcpServer(broker.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return {
    server,
    close: async () => {
      clearInterval(timer);
      await new Promise((r) => server.close(r));
      await new Promise((r) => broker.close(r));
    },
  };
}

export async function startAll(base = 4010) {
  const rest = await listen(createRestServer(), base);
  const gql = await listen(createGraphQLServer(), base + 1);
  const llm = await listen(createMockLlmServer(), base + 2);
  const ws = createWsServer(base + 3);
  await new Promise((resolve, reject) => {
    ws.once('listening', resolve);
    ws.once('error', reject);
  });
  const grpcServer = await startGrpcServer(base + 4);
  const socketIo = await startSocketIo(base + 5);
  const mqtt = await startMqtt(base + 6);
  const kafka = await startKafkaDemo(base + 7);
  return {
    rest,
    gql,
    llm,
    ws,
    grpc: grpcServer,
    close: async () => {
      grpcServer.forceShutdown();
      socketIo.sio.close();
      await mqtt.close();
      await kafka.close();
      for (const s of [rest, gql, llm]) {
        s.closeAllConnections?.();
        await new Promise((r) => s.close(r));
      }
      await new Promise((r) => ws.close(r));
    },
  };
}

/** Kafka: the in-process broker (kafka-broker.mjs) with a topic that holds a few events already. */
async function startKafkaDemo(port) {
  const broker = await startKafkaBroker({ port, topics: { 'clinic.events': 1 } });
  const kafka = new Kafka({ clientId: 'demo-seed', brokers: [broker.url], logLevel: logLevel.NOTHING });
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: 'clinic.events',
    messages: [
      { key: 'pet-1', value: JSON.stringify({ type: 'checked-in', petId: '1', name: 'Byron' }), headers: { source: 'front-desk' } },
      { key: 'pet-2', value: JSON.stringify({ type: 'vaccinated', petId: '2', name: 'Biscuit', vaccine: 'rabies' }), headers: { source: 'clinic' } },
      { key: 'pet-1', value: JSON.stringify({ type: 'checked-out', petId: '1', name: 'Byron' }), headers: { source: 'front-desk' } },
    ],
  });
  await producer.disconnect();
  return broker;
}

export { listen };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = Number(process.env.DEMO_PORT ?? 4010);
  await startAll(base);
  console.log(`REST       http://127.0.0.1:${base}        (token: ${DEMO_TOKEN}; POST /auth/token with client_id=demo&client_secret=demo-secret)`);
  console.log(`GraphQL    http://127.0.0.1:${base + 1}/graphql`);
  console.log(`Mock LLM   http://127.0.0.1:${base + 2}/v1   (OpenAI-compatible)`);
  console.log(`WebSocket  ws://127.0.0.1:${base + 3}`);
  console.log(`Socket.IO  http://127.0.0.1:${base + 5}/chat   (say → said, acknowledged)`);
  console.log(`gRPC       127.0.0.1:${base + 4}   (vet.v1.PetService; proto: examples/veterinary-workspace/protos/vet/v1/pets.proto)`);
  console.log(`MQTT       mqtt://127.0.0.1:${base + 6}   (clinic/+/vitals every 2 s; publish to clinic/7/commands, read clinic/7/acks)`);
  console.log(`Kafka      kafka://127.0.0.1:${base + 7}   (clinic.events holds 3 events; any topic is created on use)`);
  console.log('MCP        node examples/servers/mcp-server.mjs   (stdio)');
}
