import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createTestPionMcpServer,
  EnvSecretStore,
  exposedFlows,
  flowInputSchema,
  lintTestFile,
  loadSuite,
  parseExpose,
  readExposure,
  readRunSummary,
  setExposure,
  WorkspaceManager,
  type WorkspaceStore,
} from '../../packages/core/src/index.js';
import { copyExample } from '../helpers.js';

// A flow as an MCP tool: a test file or suite with an expose: block becomes a tool of the TestPion MCP server,
// its inputs the tool's arguments; calling it runs the flow and returns each step's result and the extracted values.
const dir = mkdtempSync(join(tmpdir(), 'tp-flow-tools-'));
const ws = copyExample('public-workspace', join(dir, 'ws'));
let store: WorkspaceStore;
let client: Client;

beforeAll(async () => {
  // a suite exposed too, and a file whose block is broken (listed with its problem, never registered)
  mkdirSync(join(ws, 'tests', 'flows'), { recursive: true });
  writeFileSync(
    join(ws, 'tests', 'flows', 'offline.suite.yaml'),
    'name: Offline checks\nexpose:\n  tool: offline_checks\n  description: The offline tests\n  inputs:\n    - { name: city, default: Paris }\n    - { name: note, description: Free text, required: false }\ntests:\n  - ../mcp/weather-mock.yaml\n',
  );
  writeFileSync(join(ws, 'tests', 'flows', 'broken.yaml'), 'name: Broken\nexpose: { tool: Not Snake }\ntests:\n  - { name: a, url: http://localhost/x }\n');
  const mgr = new WorkspaceManager(join(dir, 'home'));
  store = mgr.open(ws);
  const server = createTestPionMcpServer({ store, secrets: new EnvSecretStore(), settings: mgr.loadSettings() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
});
afterAll(async () => {
  await client.close();
  store.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

const body = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;

describe('exposed flows', () => {
  it('finds every file and suite with an expose: block under tests/, with its inputs and kind', () => {
    const flows = exposedFlows(store);
    expect(flows.map((f) => `${f.tool}@${f.file}:${f.kind}`)).toEqual([
      'Not Snake@flows/broken.yaml:file',
      'offline_checks@flows/offline.suite.yaml:suite',
      'weather_forecast_check@mcp/weather-mock.yaml:file',
    ]);
    expect(flows[2]).toMatchObject({ description: expect.stringContaining('offline weather mock'), inputs: [{ name: 'city', description: 'The city to ask a forecast for', default: 'Paris' }] });
    expect(flows[0]!.problem).toMatch(/snake_case/);
  });

  it('validates the block: a snake_case tool name, inputs with variable names', () => {
    expect(parseExpose(undefined)).toBeUndefined();
    expect(parseExpose({ tool: 'checkout_flow', inputs: ['customerId', { name: 'qty', default: 2 }] })).toEqual({
      tool: 'checkout_flow',
      inputs: [{ name: 'customerId' }, { name: 'qty', default: '2' }],
    });
    expect(() => parseExpose({ tool: 'Checkout Flow' })).toThrow(/snake_case/);
    expect(() => parseExpose({ tool: 'x', inputs: [{ description: 'no name' }] })).toThrow(/variable name/);
    expect(() => parseExpose({ tool: 'x', inputs: ['a', 'a'] })).toThrow(/twice/);
    expect(() => parseExpose('checkout')).toThrow(/must be a map/);
    // the editor's lint reports it at the key, in a test file and in a suite
    expect(lintTestFile('name: X\nexpose: { tool: Bad Name }\ntests: []\n').map((p) => `${p.severity}@${p.line}: ${p.message}`)).toEqual([
      expect.stringMatching(/^error@2: expose.tool "Bad Name" must be snake_case/),
    ]);
    expect(lintTestFile('name: X\nexpose: { tool: fine }\ntests: [rest]\n', { suite: true })).toEqual([]);
    expect(lintTestFile('name: X\nexpose: { tool: fine, inputs: [{ name: a }] }\ntests: []\n')).toEqual([]);
  });

  it("the loader reads a suite's block and the file text keeps everything else when the block is written or removed", async () => {
    const suite = await loadSuite(join(ws, 'tests', 'flows', 'offline.suite.yaml'));
    expect(suite.expose).toEqual({
      tool: 'offline_checks',
      description: 'The offline tests',
      inputs: [
        { name: 'city', default: 'Paris' },
        { name: 'note', description: 'Free text', required: false },
      ],
    });
    const text = '# keep me\nname: Orders\ndescription: Create and read an order\r\ntests:\n  - name: create\n    url: http://localhost/orders # trailing\n';
    const written = setExposure(text, {
      tool: 'order_flow',
      description: 'Order round trip',
      inputs: [
        { name: 'customerId', description: 'Who orders' },
        { name: 'qty', default: '1' },
      ],
    });
    expect(written).toBe(
      '# keep me\r\nname: Orders\r\ndescription: Create and read an order\r\n\r\nexpose:\r\n  tool: order_flow\r\n  description: Order round trip\r\n  inputs:\r\n    - { name: customerId, description: Who orders }\r\n    - { name: qty, default: "1" }\r\n\r\ntests:\r\n  - name: create\r\n    url: http://localhost/orders # trailing\r\n',
    );
    expect(readExposure(written)).toEqual({
      tool: 'order_flow',
      description: 'Order round trip',
      inputs: [
        { name: 'customerId', description: 'Who orders' },
        { name: 'qty', default: '1' },
      ],
    });
    // written again: replaced in place; removed: gone, the rest as before
    expect(setExposure(written, { tool: 'order_flow_v2' })).toContain('\r\nexpose:\r\n  tool: order_flow_v2\r\n\r\ntests:');
    expect(setExposure(written, undefined)).toBe('# keep me\r\nname: Orders\r\ndescription: Create and read an order\r\ntests:\r\n  - name: create\r\n    url: http://localhost/orders # trailing\r\n');
  });

  it("builds the tool's input schema from the inputs: a property each (with its default), environment, required without a default", () => {
    expect(
      flowInputSchema({
        inputs: [
          { name: 'customerId', description: 'Who' },
          { name: 'qty', default: '1' },
          { name: 'note', required: false },
        ],
      }),
    ).toEqual({
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'Who' },
        qty: { type: 'string', description: 'The {{qty}} variable of the flow', default: '1' },
        note: { type: 'string', description: 'The {{note}} variable of the flow' },
        environment: { type: 'string', description: "Environment to run with (default: the suite's, else none)" },
      },
      required: ['customerId'],
    });
  });
});

describe('flow tools on the MCP server', () => {
  it('lists list_flows and one tool per valid exposed flow, with the inputs as its schema', async () => {
    const { tools } = await client.listTools();
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.list_flows).toBeDefined();
    expect(by.offline_checks).toBeDefined();
    expect(by.Not).toBeUndefined();
    expect(by.weather_forecast_check!.description).toMatch(/^Check the offline weather mock/);
    expect(by.weather_forecast_check!.inputSchema.properties).toMatchObject({ city: { type: 'string', default: 'Paris' }, environment: { type: 'string' } });
    expect(by.weather_forecast_check!.annotations).toMatchObject({ readOnlyHint: false });
    const listed = body(await client.callTool({ name: 'list_flows', arguments: {} })) as unknown as Array<{ tool: string; problem?: string }>;
    expect(listed.map((f) => f.tool)).toEqual(['Not Snake', 'offline_checks', 'weather_forecast_check']);
    expect(listed[0]!.problem).toMatch(/snake_case/);
  });

  it('runs the flow with the arguments as variables, records the run and returns steps and extracted values', async () => {
    const r = await client.callTool({ name: 'weather_forecast_check', arguments: { city: 'Berlin' } });
    expect(r.isError).toBeFalsy();
    const out = body(r);
    expect(out).toMatchObject({ tool: 'weather_forecast_check', file: 'mcp/weather-mock.yaml', passed: 2, failed: 0, errors: 0, extracted: { forecastCity: 'Berlin' } });
    expect((out.steps as Array<{ name: string; status: string; durationMs: number }>).map((s) => `${s.name}: ${s.status}`)).toEqual([
      'Mock MCP tool returns a forecast: passed',
      'Mock MCP tool reports an error: passed',
    ]);
    expect(out.isError).toBeUndefined();
    expect(readRunSummary(store, String(out.runId))).toMatchObject({ total: 2, passed: 2 });
  });

  it('marks the result isError when a step fails, with the failed checks named', async () => {
    const r = await client.callTool({ name: 'weather_forecast_check', arguments: { city: 'Atlantis' } });
    expect(r.isError).toBe(true);
    const out = body(r);
    expect(out).toMatchObject({ passed: 1, failed: 1, isError: true });
    const step = (out.steps as Array<{ name: string; status: string; failedChecks?: string[] }>)[0]!;
    expect(step.status).toBe('failed');
    expect(step.failedChecks?.join(' ')).toMatch(/status/);
  });

  it("a suite runs its files with the suite's settings; a missing required input is refused", async () => {
    const r = await client.callTool({ name: 'offline_checks', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(body(r)).toMatchObject({ tool: 'offline_checks', passed: 2, extracted: { forecastCity: 'Paris' } });
    // the example file keeps its own default (vars: city) when run on its own: nothing unresolved
    expect(readFileSync(join(ws, 'tests', 'mcp', 'weather-mock.yaml'), 'utf8')).toContain('vars: { city: Paris }');
  });
});
