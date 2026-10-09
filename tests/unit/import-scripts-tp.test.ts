import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  exportPostmanCollection,
  importAny,
  importInsomnia,
  importIntoWorkspace,
  importPostman,
  WorkspaceStore,
  type CollectionFolder,
  type CollectionNode,
  type SavedHttpRequest,
} from '../../packages/core/src/index.js';

const ev = (listen: string, exec: string[]) => ({ listen, script: { type: 'text/javascript', exec } });

const colPre = ["pm.variables.set('t', Date.now()); // pm.variables in a comment stays"];
const colTest = ["pm.test('fast', () => pm.expect(pm.response.responseTime).to.be.below(2000));"];
const folderPre = ["console.log('pm.environment in a string stays');", "pm.environment.set('x', 1);"];
const reqTest = ['pm.test("ok", () => {', '  pm.response.to.have.status(200);', '  const msg = `pm.test ${pm.response.code}`;', '});'];
const ownPm = ['const pm = { note: 1 };', 'pm.note;'];

const postman = JSON.stringify({
  info: { _postman_id: '1b2c', name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  event: [ev('prerequest', colPre), ev('test', colTest)],
  item: [
    {
      name: 'Orders',
      event: [ev('prerequest', folderPre)],
      item: [
        { name: 'List orders', request: { method: 'GET', url: { raw: 'https://shop.test/orders' } }, event: [ev('test', reqTest)] },
        { name: 'Own pm', request: { method: 'GET', url: { raw: 'https://shop.test/own' } }, event: [ev('test', ownPm)] },
      ],
    },
  ],
});

const folder = (items: CollectionNode[], name: string) => items.find((n) => n.name === name) as CollectionFolder;
const request = (items: CollectionNode[], name: string) => folder(items, 'Orders').items.find((n) => n.name === name) as SavedHttpRequest;

describe('importing Postman scripts as tp.*', () => {
  it('converts collection, folder and request scripts to tp.* (strings and comments untouched)', () => {
    const { collection: c, scripts } = importPostman(postman);
    expect(c.preRequestScript).toBe("tp.variables.set('t', Date.now()); // pm.variables in a comment stays");
    expect(c.testScript).toBe("tp.test('fast', () => tp.expect(tp.response.responseTime).to.be.below(2000));");
    expect(folder(c.items, 'Orders').preRequestScript).toBe("console.log('pm.environment in a string stays');\ntp.environment.set('x', 1);");
    expect(request(c.items, 'List orders').testScript).toBe(['tp.test("ok", () => {', '  tp.response.to.have.status(200);', '  const msg = `pm.test ${tp.response.code}`;', '});'].join('\n'));
    expect(scripts.converted).toBe(4);
  });

  it('leaves a script that declares its own pm, and reports it', () => {
    const { collection: c, scripts } = importPostman(postman);
    expect(request(c.items, 'Own pm').testScript).toBe(ownPm.join('\n'));
    expect(scripts.unchanged).toEqual([{ where: 'Shop / Orders / Own pm (post-response)', reason: 'the script declares its own "pm"' }]);
  });

  it("keeps pm.* with scripts: 'keep'", () => {
    const { collection: c, scripts } = importPostman(postman, { scripts: 'keep' });
    expect(c.preRequestScript).toBe(colPre.join('\n'));
    expect(request(c.items, 'List orders').testScript).toBe(reqTest.join('\n'));
    expect(scripts).toEqual({ converted: 0, unchanged: [] });
    expect(importAny(postman, { scripts: 'keep' }).collection!.testScript).toBe(colTest.join('\n'));
  });

  it('round trip: import (tp) then export to Postman gives the original pm.* scripts', () => {
    const { collection: c } = importPostman(postman);
    const back = exportPostmanCollection(c).collection as {
      event?: Array<{ listen: string; script: { exec: string[] } }>;
      item: Array<{ event?: Array<{ listen: string; script: { exec: string[] } }>; item: Array<{ name: string; event?: Array<{ listen: string; script: { exec: string[] } }> }> }>;
    };
    const script = (events: Array<{ listen: string; script: { exec: string[] } }> | undefined, listen: string) => events?.find((e) => e.listen === listen)?.script.exec.join('\n');
    expect(script(back.event, 'prerequest')).toBe(colPre.join('\n'));
    expect(script(back.event, 'test')).toBe(colTest.join('\n'));
    expect(script(back.item[0]!.event, 'prerequest')).toBe(folderPre.join('\n'));
    expect(script(back.item[0]!.item.find((i) => i.name === 'List orders')!.event, 'test')).toContain(reqTest.join('\n'));
    expect(script(back.item[0]!.item.find((i) => i.name === 'Own pm')!.event, 'test')).toContain(ownPm.join('\n'));
  });

  it('importIntoWorkspace reports the conversion; other formats have no scripts summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-import-'));
    try {
      const store = WorkspaceStore.create(dir, 'Import scripts');
      const r = importIntoWorkspace(store, postman);
      expect(r.scripts).toMatchObject({ converted: 4 });
      expect(r.scripts!.unchanged).toHaveLength(1);
      expect(importIntoWorkspace(store, postman, { scripts: 'keep' }).scripts).toEqual({ converted: 0, unchanged: [] });
      const har = { log: { entries: [{ request: { method: 'GET', url: 'https://x.test/a', headers: [] }, response: { status: 200 } }] } };
      expect(importIntoWorkspace(store, JSON.stringify(har)).scripts).toBeUndefined();
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});

describe('importing Insomnia scripts as tp.*', () => {
  const insomnia = JSON.stringify({
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Shop' },
      {
        _id: 'req_1',
        _type: 'request',
        parentId: 'wrk_1',
        name: 'Create order',
        method: 'POST',
        url: 'https://shop.test/orders',
        preRequestScript: "insomnia.environment.set('n', 1);",
        afterResponseScript: "insomnia.test('created', () => insomnia.expect(insomnia.response.code).to.eql(201));",
      },
    ],
  });

  it('turns insomnia.* into tp.*', () => {
    const r = importInsomnia(insomnia);
    const req = r.collection.items[0] as SavedHttpRequest;
    expect(req.preRequestScript).toBe("// Insomnia script: insomnia.* runs as tp.* (the same API)\ntp.environment.set('n', 1);");
    expect(req.testScript).toContain("tp.test('created', () => tp.expect(tp.response.code).to.eql(201));");
    expect(req.testScript!.split('\n').slice(1).join('\n')).not.toMatch(/\b(pm|insomnia)\./);
    expect(r.scripts).toEqual({ converted: 2, unchanged: [] });
  });

  it("keeps the runnable pm.* form with scripts: 'keep'", () => {
    const req = importInsomnia(insomnia, { scripts: 'keep' }).collection.items[0] as SavedHttpRequest;
    expect(req.testScript).toContain("pm.test('created', () => pm.expect(pm.response.code).to.eql(201));");
  });
});
