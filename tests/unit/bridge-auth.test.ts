import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bridgeAuth } from '../../apps/desktop/backend/bridge-auth.js';

// Security review 2026-10-27 (P2): the development bridge took its token in the query string (history, access logs, Referer).
const T = 'a'.repeat(32);
const u = (path: string) => new URL(path, 'http://127.0.0.1');
const root = join(__dirname, '..', '..', 'apps', 'desktop');

describe('development bridge token', () => {
  it('the x-aps-token header is accepted', () => {
    expect(bridgeAuth(u('/rpc'), { 'x-aps-token': T }, T)).toBe('ok');
  });
  it('a token in the URL is refused, even a valid one, even with the header', () => {
    expect(bridgeAuth(u(`/rpc?token=${T}`), {}, T)).toBe('token-in-url');
    expect(bridgeAuth(u(`/events?token=${T}`), { 'x-aps-token': T }, T)).toBe('token-in-url');
  });
  it('a missing, wrong or repeated header is forbidden', () => {
    expect(bridgeAuth(u('/rpc'), {}, T)).toBe('forbidden');
    expect(bridgeAuth(u('/rpc'), { 'x-aps-token': 'b'.repeat(32) }, T)).toBe('forbidden');
    expect(bridgeAuth(u('/rpc'), { 'x-aps-token': 'short' }, T)).toBe('forbidden');
    expect(bridgeAuth(u('/rpc'), { 'x-aps-token': [T, T] }, T)).toBe('forbidden');
  });
  it('the page holds no token: the dev server proxy adds the header, no URL carries it, the launcher does not print it', () => {
    const api = readFileSync(join(root, 'src', 'api.ts'), 'utf8');
    expect(api).not.toMatch(/token=/);
    expect(api).toContain("'/__aps/rpc'");
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toMatch(/headers: \{ 'x-aps-token': process\.env\.TESTPION_BRIDGE_TOKEN/);
    expect(readFileSync(join(root, 'scripts', 'dev.mjs'), 'utf8')).not.toContain('|${token}');
    const server = readFileSync(join(root, 'backend', 'web-server.ts'), 'utf8');
    expect(server).not.toContain("searchParams.get('token')");
    expect(server).toContain('givenToken ?'); // a token the launcher gave is not logged
  });
});
