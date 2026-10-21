// Export workspace, nothing leaked and nothing lost (EX-G1, EX-G2): the workspace holds typed-in secrets (an MCP
// server's Authorization header, a request's bearer token and API-key header, a dataset with a database password) and
// files in specs/, datasets/, mocks/ and protos/, plus one dataset over the 10 MB limit. Export from the workspace menu
// (the save dialog answered by E2E_STUB_SAVE): the message says what was replaced and what was left out, the file is
// a bundle (`<name>.testpion.zip` or `.json`, B-41i), holds none of the secrets, and carries the four folders' files
// (the dataset over 10 MB travels by reference).
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

// built from fragments so no file in the repository holds a string a secret scanner takes for a live key; none is real
const alnum = (n) => 'Ab3'.repeat(Math.ceil(n / 3)).slice(0, n);
const SECRETS = {
  mcpAuthorization: 'Bearer ' + alnum(14) + '7=' + alnum(10),
  requestToken: 'gh' + 'p_' + alnum(36),
  apiKeyHeader: 'sk' + '_live_' + alnum(24),
  dbPassword: 'Hunter' + '2pass',
};
const OUT_NAME = 'e2e-export.json';

function prepare(ws) {
  const servers = JSON.parse(readFileSync(join(ws, 'mcp-servers.json'), 'utf8'));
  servers.servers.push({ id: 'e2e-secret-mcp', name: 'E2E secret server', transport: 'streamable-http', url: 'http://127.0.0.1:4010/mcp', headers: [{ key: 'Authorization', value: SECRETS.mcpAuthorization, enabled: true }] });
  writeFileSync(join(ws, 'mcp-servers.json'), JSON.stringify(servers, null, 2));
  writeFileSync(
    join(ws, 'collections', 'e2e-secrets.json'),
    JSON.stringify(
      {
        schemaVersion: '1.0',
        id: 'e2e-secrets',
        name: 'E2E secrets',
        variables: [],
        items: [
          {
            kind: 'http',
            id: 'sec-1',
            name: 'Typed-in token',
            request: { method: 'GET', url: 'http://127.0.0.1:4010/health', headers: [{ key: 'X-Api-Key', value: SECRETS.apiKeyHeader, enabled: true }], params: [], auth: { type: 'bearer', token: SECRETS.requestToken } },
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(ws, 'datasets', 'connections.csv'), `name,url\nclinic,postgres://app:${SECRETS.dbPassword}@db.example.com:5432/clinic\n`);
  // over the 10 MB limit: left out, and the message names it
  writeFileSync(join(ws, 'datasets', 'huge.csv'), 'id,value\n' + '1,xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n'.repeat(150_000));
  mkdirSync(join(ws, 'protos'), { recursive: true });
  writeFileSync(join(ws, 'protos', 'clinic.proto'), 'syntax = "proto3";\npackage clinic;\nmessage Pet { string name = 1; }\n');
}

const H = `const toastText = (re) => [...document.querySelectorAll('[data-sonner-toast]')].map((t) => t.textContent.trim()).find((t) => re.test(t));`;
const s = (name, body) => step(name, body, true, { extra: H, short: 2000 });

const steps = [
  s(
    'export-from-the-workspace-menu',
    `await __t.requests();
     const sw = document.querySelector('button[aria-haspopup="dialog"][title^="Switch workspace"]'); if (!sw) return 'NO WORKSPACE MENU';
     await __t.real.click(sw);
     const b = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog][aria-label="Workspaces"] button')].find((x) => x.textContent.trim() === 'Export' && x.offsetParent), 3000); if (!b) return 'NO EXPORT BUTTON';
     await __t.real.click(b);
     const t = await __t.waitFor(() => toastText(/^Exported/), 15000); if (!t) return 'NO TOAST';
     const parts = [
       'saved: ' + t.includes(${JSON.stringify(OUT_NAME)}),
       'included: ' + (/Exported (\\d+) items?:/.exec(t)?.[1] ?? 'NO'),
       'replaced: ' + (/Replaced (\\d+) secrets?/.exec(t)?.[1] ?? '0'),
       'left out: ' + /Dataset datasets\\/huge\\.csv \\([\\d.]+ MB\\) travels by reference/.test(t),
       'secret in the message: ' + ${JSON.stringify(Object.values(SECRETS))}.some((v) => t.includes(v)),
     ];
     return parts.join(' | ');`,
  ),
  [
    'the-file-holds-no-secret-and-every-folder',
    `main: const { readFileSync } = require('node:fs');
     const { readBundle } = require('@testpion/core');
     const b = readBundle(readFileSync(process.env.E2E_STUB_SAVE));
     const text = JSON.stringify(b.manifest) + [...b.entries.values()].map((e) => e.toString('latin1')).join('\\n');
     const leaked = ${JSON.stringify(Object.entries(SECRETS))}.filter(([, v]) => text.includes(v)).map(([k]) => k);
     const items = b.manifest.items;
     const has = (p) => items.some((i) => i.id === p && i.mode !== 'reference');
     const colItem = items.find((i) => i.kind === 'collection' && i.id === 'e2e-secrets');
     const req = colItem ? JSON.parse(b.entries.get(colItem.entry).toString('utf8')).items?.[0]?.request : undefined;
     const where = b.manifest.requires.secrets.map((x) => x.where).join(' ; ');
     return [
       'default name: ' + (/^TestPion Examples\\.testpion\\.(zip|json)$/.test(global.__e2eLastSaveOptions?.defaultPath ?? '') ? 'ok' : (global.__e2eLastSaveOptions?.defaultPath ?? 'NONE')),
       'format: ' + b.manifest.format,
       'leaked: ' + (leaked.join(',') || 'none'),
       'specs: ' + has('specs/petstore.json'),
       'datasets: ' + (has('datasets/intents.jsonl') && has('datasets/connections.csv')),
       'mocks: ' + has('mocks/weather.mcp-mock.yaml'),
       'protos: ' + has('protos/clinic.proto'),
       'huge by reference: ' + items.some((i) => i.id === 'datasets/huge.csv' && i.mode === 'reference'),
       'mcp header listed: ' + /E2E secret server/.test(where),
       'request token listed: ' + /Typed-in token/.test(where),
       'token now: ' + (req?.auth?.token ?? 'NONE'),
       'replaced listed: ' + b.manifest.requires.secrets.length,
     ].join(' | ');`,
    false,
  ],
];

module.exports = withExpect(
  steps,
  {
    'export-from-the-workspace-menu':
      /^saved: true \| included: (?:[89]|[1-9]\d+) \| replaced: (?:[3-9]|[1-9]\d+) \| left out: true \| secret in the message: false$/,
    'the-file-holds-no-secret-and-every-folder':
      /^default name: ok \| format: testpion-bundle \| leaked: none \| specs: true \| datasets: true \| mocks: true \| protos: true \| huge by reference: true \| mcp header listed: true \| request token listed: true \| token now: \{\{\w+\}\} \| replaced listed: (?:[3-9]|[1-9]\d+)$/,
  },
  { prepare, env: (out) => ({ E2E_STUB_SAVE: join(out, OUT_NAME) }) },
);
