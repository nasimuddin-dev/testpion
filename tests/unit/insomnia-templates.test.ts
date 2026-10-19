import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { importAny, runScript, type CollectionFolder, type CollectionNode, type SavedHttpRequest } from '../../packages/core/src/index.js';
import { jsonPathAccessor, tagArgs } from '../../packages/core/src/import/insomnia-tags.js';

// IMP-FIX-2: Insomnia v5 request scripts are read; plain JavaScript stays runnable; template tags map to dynamic
// variables, pre-request lines or chained variables; every other tag is a note naming the request (never a silent literal).
// Fixtures (tests/fixtures/import/insomnia) follow Insomnia's v5 source and docs (cited in the YAML) and a v4 export.

const FIX = join(__dirname, '..', 'fixtures', 'import', 'insomnia');
const v5 = readFileSync(join(FIX, 'vet-clinic.v5.yaml'), 'utf8');
const v4 = readFileSync(join(FIX, 'vet-clinic.v4.json'), 'utf8');
const flat = (nodes: CollectionNode[]): CollectionNode[] => nodes.flatMap((n) => (n.kind === 'folder' ? [n, ...flat(n.items)] : [n]));
const byName = (nodes: CollectionNode[], name: string) => flat(nodes).find((n) => n.name === name) as SavedHttpRequest;
const run = (code: string, response?: { status?: number; headers?: Array<[string, string]>; body?: string }) =>
  runScript(code, { variables: { apiKey: 'demo-key' }, request: { method: 'GET', url: 'https://clinic.test/x', headers: [] }, ...(response ? { response: { time: 5, ...response } } : {}) });

describe('Insomnia 5 (YAML)', () => {
  const r = importAny(v5);
  const c = r.collection!;
  const login = byName(c.items, 'Log in');
  const list = byName(c.items, 'List patients');
  const create = byName(c.items, 'Create patient');
  const notes = r.notes ?? [];

  it('reads request scripts from scripts.preRequest / scripts.afterResponse, as tp.*', () => {
    expect(login.preRequestScript).toBe("// Insomnia script: insomnia.* runs as tp.* (the same API)\ntp.environment.set('loginAt', Date.now());");
    expect(login.testScript).toContain("tp.test('logged in', () => tp.expect(tp.response.code).to.eql(200));");
    expect(r.scripts!.converted).toBeGreaterThanOrEqual(3);
  });

  it('keeps a plain JavaScript script runnable (not commented out)', () => {
    expect(list.preRequestScript!.split('\n').slice(-2)).toEqual(['const started = Date.now();', "console.log('listing patients', started);"]);
  });

  it('marks an Insomnia API TestPion lacks with a TODO and a note', () => {
    expect(create.testScript).toMatch(/\/\/ TODO\(import\): Insomnia's parentFolders has no TestPion equivalent: rewrite this line\n\s*const clinic = tp\.parentFolders/);
    expect(notes).toContain('"Create patient": insomnia.parentFolders has no TestPion equivalent (marked TODO(import) in the script)');
  });

  it('folder: scripts and headers kept on the folder (its requests inherit them)', () => {
    const folder = c.items.find((n) => n.name === 'Patients') as CollectionFolder;
    expect(folder.preRequestScript).toBe("console.log('folder pre-request');");
    expect(folder.headers).toEqual([{ key: 'X-Clinic', value: 'north', enabled: true }]);
    expect(list.request.headers.map((h) => h.key)).not.toContain('X-Clinic');
  });

  it('settings.followRedirects off, descriptions from meta, other v5 items noted', () => {
    expect(list.request.settings).toEqual({ followRedirects: false });
    expect(login.description).toBe('Gets a token');
    // a WebSocket request of a v5 file becomes a connection of the library (not a broken HTTP request)
    expect(flat(c.items).map((n) => n.name)).not.toContain('Patient stream');
    expect((r.savedItems as { websocket?: Array<{ name: string }> }).websocket?.map((w) => w.name)).toEqual(['Patient stream']);
  });

  it("uuid, now, timestamp and faker become dynamic variables; {{ _['a-b'] }} a variable", () => {
    expect(login.request.body).toEqual({ type: 'json', content: '{"user": "vet", "password": "{{vet-password}}", "nonce": "{{$guid}}"}' });
    expect(list.request.params).toEqual([{ key: 'since', value: '{{$timestampMs}}', enabled: true }]);
    expect(list.request.headers[0]).toEqual({ key: 'X-Request-Id', value: '{{$guid}}', enabled: true });
    const body = JSON.parse((create.request.body as { content: string }).content);
    expect(body).toMatchObject({ name: '{{$randomFirstName}}', at: '{{$isoTimestamp}}', ts: '{{$timestampMs}}' });
  });

  it('base64 and hash become a pre-request line that sets the variable the request uses', async () => {
    const sig = list.request.headers.find((h) => h.key === 'X-Signature')!.value;
    expect(sig).toBe('{{insomnia_hash}}');
    const tag = JSON.parse((create.request.body as { content: string }).content).tag;
    expect(tag).toBe('{{insomnia_base64}}');
    const out = await run(list.preRequestScript!);
    expect(out.error).toBeUndefined();
    expect(out.vars.insomnia_hash).toBe(createHash('sha256').update('demo-key').digest('hex'));
    const out2 = await run(create.preRequestScript ?? '');
    expect(out2.vars.insomnia_base64).toBe('cmV4');
  });

  it('{% response %} with a JSONPath is chained: the login sets the variable, the folder and the request use it', async () => {
    expect(list.request.auth).toEqual({ type: 'bearer', token: '{{insomnia_log_in_token}}' });
    expect((c.items.find((n) => n.name === 'Patients') as CollectionFolder).auth).toEqual({ type: 'bearer', token: '{{insomnia_log_in_token}}' });
    // one line in the referenced request, however many use it
    expect(login.testScript!.match(/tp\.collectionVariables\.set\("insomnia_log_in_token", tp\.response\.json\(\)\?\.token\);/g)).toHaveLength(1);
    const out = await run(login.testScript!, { status: 200, headers: [['content-type', 'application/json']], body: '{"token":"tok-1"}' });
    expect(out.scopeSets.collectionVariables).toEqual({ insomnia_log_in_token: 'tok-1' });
    expect(out.tests).toEqual([expect.objectContaining({ name: 'logged in', passed: true })]);
    expect(notes).toContain('"List patients": {% response %} from "Log in" became {{insomnia_log_in_token}}, set by "Log in"\'s post-response script: send "Log in" first');
  });

  it('prompt becomes a variable to set; other tags stay as text with a note naming the request', () => {
    const body = JSON.parse((create.request.body as { content: string }).content);
    expect(body.question).toBe('{{prompt_security_question}}');
    expect(body.sid).toBe("{% cookie 'https://clinic.test', 'sid' %}");
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^"Create patient": Insomnia asked for "Security question" when sending/),
        expect.stringMatching(/^"Create patient": Insomnia template tag \{% cookie .* has no TestPion equivalent: it is left as text, set the value by hand$/),
      ]),
    );
  });

  it('hawk auth maps to TestPion Hawk, environments merged, tags in environments mapped', () => {
    expect(create.request.auth).toMatchObject({ type: 'hawk', id: 'vet' });
    expect(r.environments!.map((e) => e.name)).toEqual(['Staging']);
    expect(r.environments![0]!.variables).toEqual(
      expect.arrayContaining([
        { key: 'baseUrl', value: 'https://staging.clinic.test', enabled: true },
        { key: 'requestId', value: '{{$guid}}', enabled: true },
      ]),
    );
  });

  it('leaves no Insomnia tag behind silently: every remaining {% %} has a note', () => {
    // tags still in the collection (as text), outside the scripts' comments
    const { preRequestScript: _p, testScript: _t, ...rest } = c;
    const text = JSON.stringify(rest, (k, v) => (k === 'preRequestScript' || k === 'testScript' ? undefined : v));
    const left = [...text.matchAll(/\{%\s*([\w-]+)/g)].map((m) => m[1]);
    expect(left).toEqual(['cookie']);
    expect(left.filter((tag) => !notes.some((n) => n.includes(`{% ${tag}`)))).toEqual([]);
  });
});

describe('Insomnia 4 (JSON)', () => {
  const r = importAny(v4);
  const c = r.collection!;
  const get = byName(c.items, 'Get patient');
  const notes = r.notes ?? [];

  it('chains body JSONPath (plain and b64-encoded) and headers; a complex JSONPath is a note', () => {
    expect(get.request.url).toBe('{{baseUrl}}/patients/{{insomnia_log_in_id}}');
    expect(get.request.headers).toEqual(
      expect.arrayContaining([
        { key: 'Authorization', value: 'Bearer {{insomnia_log_in_token}}', enabled: true },
        { key: 'X-Session', value: '{{insomnia_log_in_x_session}}', enabled: true },
      ]),
    );
    const login = byName(c.items, 'Log in');
    expect(login.testScript).toContain('tp.collectionVariables.set("insomnia_log_in_id", tp.response.json()?.patients?.[0]?.id);');
    expect(login.testScript).toContain('tp.collectionVariables.set("insomnia_log_in_x_session", tp.response.headers.get("X-Session"));');
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining('(Insomnia sent it on its own when needed)'),
        expect.stringMatching(/^"Get patient": Insomnia template tag \{% response .*JSONPath \$\.\.items/),
        expect.stringMatching(/^"Get patient": Insomnia template tag \{% os 'hostname' %\} has no TestPion equivalent/),
      ]),
    );
  });

  it('plain JavaScript stays runnable; empty auth inherits; ntlm maps to NTLM auth', () => {
    expect(get.preRequestScript).toBe("// plain JavaScript, no insomnia.*\nconst ids = [1, 2, 3];\nfor (const id of ids) console.log('patient', id);");
    expect(byName(c.items, 'Log in').request.auth).toEqual({ type: 'inherit' });
    expect(byName(c.items, 'Log in').request.body).toMatchObject({ content: '{"user": "vet", "apiKey": "{{api-key}}"}' });
    expect(get.request.auth).toMatchObject({ type: 'ntlm', username: 'vet' });
  });
});

describe('tag helpers', () => {
  it('reads tag arguments, decoding b64::', () => {
    expect(tagArgs("'body', 'req_1', 'b64::JC50b2tlbg==::46b', 'never', 60")).toEqual(['body', 'req_1', '$.token', 'never', '60']);
    expect(tagArgs(`"a, b", 'it\\'s'`)).toEqual(['a, b', "it's"]);
  });

  it('turns simple JSONPaths into accessors and refuses the rest', () => {
    expect(jsonPathAccessor('$.data.items[2]["first-name"]')).toEqual({ accessor: '?.data?.items?.[2]?.["first-name"]', last: 'first-name' });
    expect(jsonPathAccessor('$')).toEqual({ accessor: '', last: 'value' });
    expect(jsonPathAccessor('$..id')).toBeUndefined();
    expect(jsonPathAccessor('$.items[*].id')).toBeUndefined();
    expect(jsonPathAccessor('/root/id')).toBeUndefined();
  });
});
