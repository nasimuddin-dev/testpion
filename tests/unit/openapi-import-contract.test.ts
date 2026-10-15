import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cliData } from '../helpers.js';

const cli = (args: string[], cwd: string) =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((ok) => {
    const p = spawn(process.execPath, [join(process.cwd(), 'packages/cli/bin/testpion.js'), ...args], { cwd, env: { ...process.env, NO_COLOR: '1' } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => ok({ status, stdout, stderr }));
  });

describe('importing an OpenAPI document', () => {
  it('keeps the document and gives every request a contract check that the collection run enforces', async () => {
    // the API breaks its contract on /owners (a number where a string is documented)
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/pets' ? JSON.stringify([{ id: 1, name: 'Byron' }]) : JSON.stringify([{ name: 42 }]));
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', () => ok()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = mkdtempSync(join(tmpdir(), 'tp-import-'));
    const spec = {
      openapi: '3.0.3',
      info: { title: 'Pet Shop', version: '1' },
      servers: [{ url }],
      paths: {
        '/pets': { get: { operationId: 'listPets', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', required: ['id', 'name'] } } } } } } } },
        '/owners': { get: { operationId: 'listOwners', responses: { 200: { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' } } } } } } } } } },
      },
    };
    try {
      expect((await cli(['workspace', 'create', 'shop', '--path', join(dir, 'shop')], dir)).status).toBe(0);
      writeFileSync(join(dir, 'petshop.json'), JSON.stringify(spec));
      const imp = await cli(['import', 'petshop.json', '-w', join(dir, 'shop'), '--json'], dir);
      const out = cliData(imp.stdout) as { collection: string; specPath: string; contractChecks: number };
      expect(out).toMatchObject({ collection: 'Pet Shop', specPath: 'specs/pet-shop.openapi.json', contractChecks: 2 });
      expect(JSON.parse(readFileSync(join(dir, 'shop', out.specPath), 'utf8')).info.title).toBe('Pet Shop');

      const run = await cli(['run-collection', 'Pet Shop', '-w', join(dir, 'shop'), '-r', 'json', '-o', join(dir, 'out')], dir);
      expect(run.status).toBe(1);
      expect(run.stdout).toMatch(/\/0\/name must be string/);
      expect(existsSync(join(dir, 'out', 'report.json'))).toBe(true);
      const report = JSON.parse(readFileSync(join(dir, 'out', 'report.json'), 'utf8')) as { summary: { passed: number; failed: number } };
      expect(report.summary).toMatchObject({ passed: 1, failed: 1 });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
