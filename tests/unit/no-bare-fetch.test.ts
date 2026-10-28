import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Cloud stage 1 (security review 2026-10-27, finding "bare fetch"): everything the engine or a backend handler sends goes through
// `netFetch` (net/proxy.ts), which follows the CALLING SESSION's NetConfig (proxy, CA, pools). A bare global `fetch(` follows the
// process default instead, so on a server one user's call would use another's proxy or trust. This fails on a new bare `fetch(`.
const ROOT = process.cwd();
const DIRS = ['packages/core/src', 'apps/desktop/backend'];

/** Files that may name the global fetch, with the reason. */
const ALLOWED: Record<string, string> = {
  'packages/core/src/net/proxy.ts': 'netFetch itself: the process default keeps the global dispatcher, any other session passes its own',
  'packages/core/src/codegen/codegen.ts': 'writes `fetch(...)` as TEXT for the user (a code snippet), it is never called',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** The text of a line without comments, strings and regular expressions' contents is hard; the shapes that matter are these two. */
const CALL = /(?<![.\w$'"])fetch\(/;
const REFERENCE = /(?:\?\?|\|\||[^=!<>]=|\()\s*fetch\s*(?:[;,)]|$)/;

describe('no bare global fetch outside netFetch', () => {
  it('packages/core/src and apps/desktop/backend send through netFetch', () => {
    const found: string[] = [];
    for (const d of DIRS)
      for (const file of sources(join(ROOT, d))) {
        const rel = relative(ROOT, file).split(sep).join('/');
        if (ALLOWED[rel]) continue;
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .forEach((line, i) => {
            const code = line.trim();
            if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
            if (CALL.test(line) || REFERENCE.test(line)) found.push(`${rel}:${i + 1}: ${code.slice(0, 120)}`);
          });
      }
    expect(found).toEqual([]);
  });

  it('every allow-listed file exists and still names fetch (a stale entry is removed)', () => {
    for (const rel of Object.keys(ALLOWED)) expect(readFileSync(join(ROOT, rel), 'utf8')).toMatch(/\bfetch\b/);
  });

  it('the pattern catches the shapes it is for', () => {
    expect(CALL.test('const r = await fetch(url)')).toBe(true);
    expect(CALL.test('x = opts.fetchImpl ?? ((u) => fetch(u))')).toBe(true);
    expect(CALL.test('await undici.fetch(url)')).toBe(false);
    expect(REFERENCE.test('const f = ctx.fetchImpl ?? fetch;')).toBe(true);
    expect(REFERENCE.test('const f = ctx.fetchImpl ?? netFetch;')).toBe(false);
  });
});
