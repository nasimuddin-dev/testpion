import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Backend } from '../../apps/desktop/backend/backend.js';
import { RPC_PARAMS } from '../../apps/desktop/backend/rpc-params.js';
import { RPC_VERSION } from '../../packages/shared/src/index.js';
import { SOURCE, TARGET, generate, parseTables, tsType } from '../../apps/desktop/scripts/rpc-types.mjs';
import { tempDir } from '../helpers.js';

// The RPC contract is typed from its one source, the parameter tables of the backend (rpc-params.ts): a generator writes the
// window's types (src/lib/rpc-params.generated.ts), this test fails when a method was added or changed without regenerating
// (npm run rpc-types -w @testpion/desktop), and the answers of the most used methods are typed in src/lib/rpc-methods.ts.
const root = join(__dirname, '..', '..');
const tmp = tempDir('tp-rpc-contract-');
const be = new Backend({ appDir: tmp.dir, emit: () => {}, noMonitors: true });
afterAll(async () => {
  await be.dispose();
  tmp.cleanup();
});

describe('RPC contract types', () => {
  it('the generated parameter types are up to date with backend/rpc-params.ts (regenerate with npm run rpc-types)', () => {
    const text = generate(readFileSync(SOURCE, 'utf8'));
    expect(readFileSync(TARGET, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
  });

  it('every method of the parameter table has a type entry, and the generator read the whole table (nothing silently skipped)', () => {
    const { methods } = parseTables(readFileSync(SOURCE, 'utf8'));
    expect(Object.keys(methods).sort()).toEqual(Object.keys(RPC_PARAMS).sort());
    const generated = readFileSync(TARGET, 'utf8');
    for (const m of Object.keys(RPC_PARAMS)) expect(generated, m).toContain(`  '${m}': RpcCommonParams`);
  });

  it('the type of a table entry follows its letters', () => {
    expect(tsType('s')).toEqual({ optional: false, type: 'string' });
    expect(tsType('n?')).toEqual({ optional: true, type: 'number' });
    expect(tsType('s|null')).toEqual({ optional: false, type: 'string | null' });
    expect(tsType('wpa?')).toEqual({ optional: true, type: 'string[]' });
    expect(() => tsType('zz')).toThrow(/unknown parameter type/);
  });

  it('the typed answers name methods that exist (a rename is caught here, and by the compiler at every call site)', () => {
    const src = readFileSync(join(root, 'apps/desktop/src/lib/rpc-methods.ts'), 'utf8');
    const block = /export interface RpcResults \{([\s\S]*?)\n\}/.exec(src)![1]!;
    const typed = [...block.matchAll(/^  '([\w.]+)':/gm)].map((m) => m[1]!);
    expect(typed.length).toBeGreaterThanOrEqual(24);
    const missing = typed.filter((m) => !Object.hasOwn(be.handlers, m));
    expect(missing).toEqual([]);
  });
});

describe('RPC contract version', () => {
  it('app.info answers rpcVersion, the same number the window checks (@testpion/shared RPC_VERSION)', async () => {
    const info = (await be.invoke('app.info', {})) as { rpcVersion: number };
    expect(info.rpcVersion).toBe(RPC_VERSION);
    expect(Number.isInteger(RPC_VERSION) && RPC_VERSION >= 1).toBe(true);
  });

  it('the window checks it at connect and the bridge refuses a page of another version', () => {
    expect(readFileSync(join(root, 'apps/desktop/src/api.ts'), 'utf8')).toMatch(/checkRpcVersion\(r\?\.rpcVersion\)/);
    const bridge = readFileSync(join(root, 'apps/desktop/backend/web-server.ts'), 'utf8');
    expect(bridge).toMatch(/call\.rpcVersion !== RPC_VERSION/);
    expect(bridge).toContain('426');
  });
});
