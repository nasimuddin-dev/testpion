import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WorkspaceStore, catalogHtml, catalogSite, workspaceCatalog } from '../../packages/core/src/index.js';
import { tempDir } from '../helpers';

/**
 * The API catalog (report/catalog.ts): every API (collection) with what belongs to it, read once from the workspace:
 * `testpion docs --catalog`, `docs --site`, MCP `api_catalog`, the app's API catalog dialog.
 */
const FIXTURE = join(__dirname, '..', 'fixtures', 'kinds', 'workspace');
let t: ReturnType<typeof tempDir>;
let store: WorkspaceStore;
beforeAll(() => {
  t = tempDir('tp-catalog-', { alias: true });
  store = WorkspaceStore.create(join(t.dir, 'ws'), 'Catalog');
  cpSync(FIXTURE, store.root, { recursive: true });
});
afterAll(() => {
  store?.close();
  t?.cleanup();
});

describe('the API catalog', () => {
  it('lists an API with its requests, definition, environments, monitors and calls', async () => {
    const c = await workspaceCatalog(store);
    expect(c.workspace.name).toBe('Catalog');
    const api = c.apis.find((a) => a.id === 'api')!;
    expect(api).toMatchObject({ name: 'Kinds API', page: 'apis/api.html', calls: { grpc: 1, websocket: 1, loadTests: 1 } });
    expect(api.requests).toBeGreaterThan(0);
    expect(Object.values(api.methods).reduce((a, b) => a + b, 0)).toBe(api.requests);
    expect(api.environments).toContain('Staging');
    expect(api.monitors.map((m) => m.name)).toEqual(['Pets monitor']);
    // the definition whose operations the requests call, and how many of them have a request
    expect(api.specs).toEqual([expect.objectContaining({ path: 'specs/petstore.yaml', withRequest: expect.any(Number) })]);
    expect(api.specs[0]!.withRequest).toBeGreaterThan(0);
    expect(api.specs[0]!.withRequest).toBeLessThanOrEqual(api.specs[0]!.operations);
    expect(c.specsWithoutRequests).toEqual([]);
    expect(c.mcpServers.map((s) => s.id)).toContain('weather');
  });

  it('a definition no collection calls is listed on its own, and one that cannot be read does not stop the catalog', async () => {
    writeFileSync(store.path('specs', 'orders.yaml'), 'openapi: 3.0.0\ninfo:\n  title: Orders\n  version: "2"\npaths:\n  /orders:\n    get: {}\n    post: {}\n  /orders/{id}:\n    delete: {}\n');
    writeFileSync(store.path('specs', 'broken.yaml'), 'openapi: [');
    const c = await workspaceCatalog(store);
    expect(c.specsWithoutRequests.find((s) => s.path === 'specs/orders.yaml')).toEqual({ path: 'specs/orders.yaml', title: 'Orders', version: '2', operations: 3 });
    expect(c.specsWithoutRequests.find((s) => s.path === 'specs/broken.yaml')).toMatchObject({ operations: 0 });
    expect(c.apis.find((a) => a.id === 'api')!.specs.map((s) => s.path)).toEqual(['specs/petstore.yaml']);
  });

  it('the page shows names, counts and statuses, escaped, and no value of a variable', async () => {
    const c = await workspaceCatalog(store);
    const html = catalogHtml({ ...c, apis: [{ ...c.apis[0]!, name: 'A <b>bold</b> API', summary: 'Uses "quotes" & <tags>' }] });
    expect(html).toContain('A &lt;b&gt;bold&lt;/b&gt; API');
    expect(html).toContain('Uses &quot;quotes&quot; &amp; &lt;tags&gt;');
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('href="apis/api.html"');
    expect(catalogHtml(c, { links: false })).not.toContain('href="apis/');
    // the environment's values are not in the catalog (only its name)
    const staging = store.getEnvironment('staging')!;
    for (const v of staging.variables) if (v.value && v.value.length > 6) expect(html).not.toContain(v.value);
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/);
  });

  it('the site has the catalog, its data and a documentation page per API', async () => {
    const { catalog, files } = await catalogSite(store);
    expect(files.map((f) => f.path)).toEqual(['index.html', 'catalog.json', ...catalog.apis.map((a) => a.page)]);
    expect(JSON.parse(files[1]!.content).apis.map((a: { id: string }) => a.id)).toEqual(catalog.apis.map((a) => a.id));
    expect(files.find((f) => f.path === 'apis/api.html')!.content).toContain('Kinds API');
  });
});
