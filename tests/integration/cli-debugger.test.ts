import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { runCliSync, tempDir } from '../helpers.js';

// `testpion debugger capture` / `debug` and `debug certificate`, the terminal twins of the Debugger's Capture all traffic and its
// certificate: --dry-run changes nothing, the system proxy and the trust store ask for --yes. Never the real proxy setting or the
// real certificate folder (TESTPION_FAKE_SYSTEM_PROXY, TESTPION_DEBUGGER_CERTS).
let tmp: ReturnType<typeof tempDir>;
const run = (args: string[]) =>
  runCliSync(args, { cwd: tmp.dir, home: join(tmp.dir, 'home'), env: { TESTPION_FAKE_SYSTEM_PROXY: '1', TESTPION_DEBUGGER_CERTS: join(tmp.dir, 'certs'), CI: '1' }, timeout: 60_000 });

beforeAll(() => {
  tmp = tempDir('tp-cli-debugger-');
});
afterAll(() => tmp.cleanup());

describe('debugger capture', () => {
  it('--dry-run says what it would do and starts nothing; debugger and debug are the same word', () => {
    for (const word of ['debugger', 'debug']) {
      const r = run([word, 'capture', '--dry-run', '--system-proxy', '--decrypt', '--json']);
      expect(r.status, r.err).toBe(0);
      const event = JSON.parse(r.out.split('\n').find((l) => l.includes('"dry-run"'))!) as { data: { wouldDo: string[] } };
      expect(event.data.wouldDo.join(' | ')).toMatch(/start the proxy on port 8899.*decrypt HTTPS.*proxy setting/);
    }
    // `debug` alone is the capture, as before
    expect(run(['debug', '--dry-run', '-p', '9000']).out).toContain('would start the proxy on port 9000');
  });

  it('--system-proxy refuses without --yes when it cannot ask, and changes nothing', () => {
    const r = run(['debugger', 'capture', '--system-proxy', '--non-interactive', '--json']);
    expect(r.status).toBe(2);
    const body = JSON.parse(r.out) as { data: { confirmationRequired: boolean; wouldDo: string } };
    expect(body.data.confirmationRequired).toBe(true);
    expect(body.data.wouldDo).toMatch(/proxy setting/);
  });
});

describe('debug certificate', () => {
  it('shows where the root is, its fingerprint, and the steps while it is not trusted', () => {
    const r = run(['debugger', 'certificate', '--json']);
    expect(r.status, r.err).toBe(0);
    const d = (JSON.parse(r.out) as { data: Record<string, unknown> }).data;
    expect(String(d.path)).toContain('certs');
    expect(d.fingerprint).toBeTruthy();
    expect(typeof d.known).toBe('boolean');
    if (d.trusted !== true) expect(Array.isArray(d.instructions)).toBe(true);
  });

  it('--install and --remove ask for --yes; --dry-run only says what it would do', () => {
    const refused = run(['debugger', 'certificate', '--install', '--non-interactive', '--json']);
    expect(refused.status).toBe(2);
    expect((JSON.parse(refused.out) as { data: { confirmationRequired: boolean } }).data.confirmationRequired).toBe(true);
    const dry = run(['debugger', 'certificate', '--install', '--dry-run', '--json']);
    expect(dry.status, dry.err).toBe(0);
    expect((JSON.parse(dry.out) as { data: { note: string } }).data.note).toMatch(/would add the root certificate/);
    expect(run(['debugger', 'certificate', '--install', '--remove', '--json']).status).toBe(2);
  });
});
