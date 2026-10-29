import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// docs/architecture/engine-sdk.md promises a runnable example: keep it running (needs the built packages, as the CLI tests do).
describe('the engine as an SDK (FG-25)', () => {
  it('examples/sdk/debugger-proxy.mjs starts a proxy, applies a modify rule and a script rule, and reads the capture', () => {
    const r = spawnSync(process.execPath, [resolve('examples/sdk/debugger-proxy.mjs')], { encoding: 'utf8', timeout: 60_000, cwd: resolve('.') });
    expect(r.status, r.stderr).toBe(0);
    // the server saw x-env: staging (set by the rule); the script removed the secret from what the program received
    expect(r.stdout).toContain('the program received: {"path":"/orders/42","env":"staging"}');
    expect(r.stdout).toMatch(/captured: GET http:\/\/127\.0\.0\.1:\d+\/orders\/42 200 rules: \[ 'Mark staging', 'Hide the secret' \]/);
    expect(r.stdout).toContain('HAR entries: 1');
  }, 90_000);
});
