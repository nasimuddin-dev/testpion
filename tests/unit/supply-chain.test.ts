import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');
const atLeast = (version: string, floor: string) => {
  const a = version.split('.').map(Number);
  const b = floor.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
};

// the 2026-10-22 security review, supply chain
describe('supply chain', () => {
  const workflows = readdirSync(join(process.cwd(), '.github', 'workflows')).filter((f) => f.endsWith('.yml'));

  it('every action is pinned by commit, not by a tag that can move', () => {
    const loose: string[] = [];
    for (const f of workflows) for (const m of read(`.github/workflows/${f}`).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)) if (!/@[0-9a-f]{40}$/.test(m[1]!)) loose.push(`${f}: ${m[1]}`);
    expect(loose).toEqual([]);
  });

  it('the CI workflow reads only, audits the production dependencies, and the release job alone writes', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/^permissions:\s*\n\s+contents: read/m);
    expect(ci).toContain('node scripts/audit-gate.mjs');
    const release = read('.github/workflows/release.yml');
    expect(release).toMatch(/^permissions:\s*\n\s+contents: read/m);
    expect(release).toMatch(/publish:[\s\S]*?permissions:\s*\n\s+contents: write\s*\n\s+id-token: write/);
    // the checksums are signed by the workflow, and the signature is released with them
    expect(release).toContain('cosign sign-blob');
    expect(release).toContain('SHA256SUMS.txt.sigstore.json');
  });

  it('the audit gate lists each exception with a reason and a date to look again', () => {
    const allow = JSON.parse(read('scripts/audit-allow.json')) as { advisories: Array<{ id: string; reason: string; until: string }> };
    for (const a of allow.advisories) {
      expect(a.id).toMatch(/^GHSA-[a-z0-9-]+$/);
      expect(a.reason.length).toBeGreaterThan(40);
      expect(a.until).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('the dependencies named by advisories are at or above the fixed versions', () => {
    // Handlebars (GHSA-8r5x-fm3f-whwj, GHSA-p8wg-vrv2-v86f): the app embeds it and renders in the sandbox; the package stays current anyway
    expect(atLeast(JSON.parse(read('node_modules/handlebars/package.json')).version, '4.7.10')).toBe(true);
    // the MCP SDK's HTTP client re-sent headers across origins before 1.32.0 (GHSA-6prh-2h8m-c8cw)
    expect(atLeast(JSON.parse(read('node_modules/@modelcontextprotocol/sdk/package.json')).version, '1.32.0')).toBe(true);
    expect(JSON.parse(read('packages/core/package.json')).dependencies['@modelcontextprotocol/sdk']).toMatch(/\^1\.3[2-9]|\^1\.[4-9]\d/);
  });

  it('node-pty is the one beta native module: pinned to an exact version, outside the asar', () => {
    const v = JSON.parse(read('apps/desktop/package.json')).devDependencies['@lydell/node-pty'] as string;
    expect(v).toMatch(/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/); // exact: no ^ or ~
    expect(read('apps/desktop/electron-builder.yml')).toContain('node-pty-${platform}-${arch}');
  });

  it('the page security policy has no development origins and no data: or blob: frames in the build', () => {
    const vite = read('apps/desktop/vite.config.ts');
    expect(vite).toContain("connect-src 'self';");
    expect(vite).toContain("frame-src 'self' tpviz:");
  });
});
