import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderVisualizer } from '../../packages/core/src/index.js';
import { HANDLEBARS_VERSION } from '../../packages/core/src/scripts/handlebars.generated.js';

const CANARY = 'tp-canary-visualizer-7f3a';

// a template is workspace content (an imported collection's script sets it), so the render must never reach the host
describe('visualizer templates render in the script sandbox', () => {
  it('the embedded Handlebars is at or above the fixed line (4.7.10) for GHSA-8r5x-fm3f-whwj and GHSA-p8wg-vrv2-v86f', () => {
    const [maj, min, pat] = HANDLEBARS_VERSION.split('.').map(Number);
    expect(maj > 4 || (maj === 4 && (min > 7 || (min === 7 && pat >= 10)))).toBe(true);
  });

  it('the host never loads the handlebars package', () => {
    const roots = ['packages/core/src', 'packages/cli/src', 'apps/desktop/backend', 'apps/desktop/electron'];
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name) && !name.includes('.generated.')) {
          if (/(?:require|import)\s*\(?\s*['"]handlebars['"]|from\s+['"]handlebars['"]/.test(readFileSync(p, 'utf8'))) hits.push(p);
        }
      }
    };
    for (const r of roots) walk(join(process.cwd(), r));
    expect(hits).toEqual([]);
  });

  const payloads: Record<string, string> = {
    'constructor chain (Function constructor)': `{{#with "s" as |string|}}{{#with "e"}}{{#with split as |conslist|}}{{this.pop}}{{this.push (lookup string.sub "constructor")}}{{this.pop}}{{#with string.split as |codelist|}}{{this.pop}}{{this.push "return process.env.TP_CANARY;"}}{{this.pop}}{{#each conslist}}{{#with (string.sub.apply 0 codelist)}}{{this}}{{/with}}{{/each}}{{/with}}{{/with}}{{/with}}{{/with}}`,
    'lookup of the prototype and constructor': `{{lookup (lookup this "__proto__") "constructor"}}|{{lookup (lookup (lookup this "constructor") "constructor") "name"}}`,
    'own-property bypass shape': `{{#each this}}{{@key}}={{lookup ../this @key}};{{/each}}{{[constructor]}}{{[__defineGetter__]}}`,
    'process through a partial name': `{{> (lookup this "process")}}{{process.env.TP_CANARY}}`,
  };

  for (const [name, template] of Object.entries(payloads)) {
    it(`cannot reach the process: ${name}`, async () => {
      process.env.TP_CANARY = CANARY;
      try {
        const r = await renderVisualizer(template, { a: 1 });
        expect(`${r.html ?? ''}${r.error ?? ''}`).not.toContain(CANARY);
      } finally {
        delete process.env.TP_CANARY;
      }
    });
  }

  it('code reached through the template engine sees no process, require, fs or fetch', async () => {
    // an engine-level helper that evaluates source: what a successful injection would be able to run
    const { renderTemplate } = await import('../../packages/core/src/scripts/sandbox.js');
    const r = await renderTemplate('{{x}}', { x: 1 });
    expect(r.html).toBe('1');
    // the same context type is used for the render; scripts there have no host objects
    const { runScript } = await import('../../packages/core/src/index.js');
    const s = await runScript(`tp.environment.set('v', [typeof process, typeof fetch, Function('return typeof process')(), Function('return typeof globalThis.require')()].join(','));`, { variables: {}, environment: {} } as never);
    expect(s.scopeSets.environment.v).toBe('undefined,undefined,undefined,undefined');
  });

  it('refuses a template over the size cap, and stops an endless one', async () => {
    expect((await renderVisualizer('x'.repeat(300 * 1024), {})).error).toMatch(/longer than 256 KB/);
    const t0 = Date.now();
    const r = await renderVisualizer('{{#each a}}{{#each ../a}}{{#each ../../a}}{{#each ../../../a}}{{#each ../../../../a}}{{.}}{{/each}}{{/each}}{{/each}}{{/each}}{{/each}}', { a: Array.from({ length: 400 }, (_, i) => i) });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.error ?? r.html).toBeTruthy();
  });
});
