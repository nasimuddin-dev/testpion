// Writes the collection corpus of the import tests: eight API collections shaped like the real ones (a pet store, a payments API, a
// code host, a chat service, a maps API, a weather API, a bank with OAuth 2, a vet clinic with uploads) in the file formats of ten
// exports (Postman v2.1, Insomnia v5 and v4, OpenCollection, Bruno export, Hoppscotch, Thunder Client, Yaak, HTTPie, Apidog), from
// the tools' public documentation. 80 files; `index.json` says what each holds (the test checks the import against it).
//   node tests/fixtures/import/corpus/generate.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const YAML = require('yaml');

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (name, method, path, extra = {}) => ({ name, method, path, ...extra });
const json = (o) => ({ type: 'json', content: JSON.stringify(o, null, 2) });

const DOMAINS = [
  {
    id: 'petstore', title: 'Pet Store', base: 'https://petstore.example.test/v2', auth: { type: 'apikey', key: 'api_key', value: '{{apiKey}}' },
    envs: { dev: { baseUrl: 'http://localhost:8080/v2', apiKey: 'dev-key' }, staging: { baseUrl: 'https://staging.petstore.example.test/v2', apiKey: 'stg-key' }, prod: { baseUrl: 'https://petstore.example.test/v2', apiKey: '' } },
    folders: [
      { name: 'pet', requests: [R('Add a new pet', 'POST', '/pet', { body: json({ id: 0, name: 'doggie', status: 'available', tags: [{ name: 'good' }] }) }), R('Update an existing pet', 'PUT', '/pet', { body: json({ id: 1, name: 'doggie', status: 'sold' }) }), R('Find pets by status', 'GET', '/pet/findByStatus', { query: { status: 'available' }, test: 200 }), R('Find pet by ID', 'GET', '/pet/1', { test: 200 }), R('Delete a pet', 'DELETE', '/pet/1', { headers: { api_key: '{{apiKey}}' } }), R('Upload an image', 'POST', '/pet/1/uploadImage', { body: { type: 'multipart', fields: [{ key: 'additionalMetadata', value: 'cute' }, { key: 'file', file: 'dog.png' }] } })] },
      { name: 'store', requests: [R('Returns pet inventories by status', 'GET', '/store/inventory', { test: 200 }), R('Place an order for a pet', 'POST', '/store/order', { body: json({ petId: 1, quantity: 1, status: 'placed' }) }), R('Find purchase order by ID', 'GET', '/store/order/1'), R('Delete purchase order by ID', 'DELETE', '/store/order/1')] },
      { name: 'user', requests: [R('Create user', 'POST', '/user', { body: json({ username: 'theUser', email: 'john@example.test' }) }), R('Logs user into the system', 'GET', '/user/login', { query: { username: 'theUser', password: '{{password}}' }, test: 200 }), R('Get user by user name', 'GET', '/user/theUser'), R('Logs out current logged in user session', 'GET', '/user/logout')] },
    ],
  },
  {
    id: 'payments', title: 'Payments API', base: 'https://api.payments.example.test/v1', auth: { type: 'bearer', token: '{{secretKey}}' },
    envs: { test: { baseUrl: 'https://api.payments.example.test/v1', secretKey: 'sk_test_0000' }, live: { baseUrl: 'https://api.payments.example.test/v1', secretKey: '' } },
    folders: [
      { name: 'Customers', requests: [R('Create a customer', 'POST', '/customers', { body: { type: 'form', fields: [{ key: 'email', value: 'jenny@example.test' }, { key: 'name', value: 'Jenny Rosen' }] }, test: 200 }), R('Retrieve a customer', 'GET', '/customers/cus_123', { test: 200 }), R('Update a customer', 'POST', '/customers/cus_123', { body: { type: 'form', fields: [{ key: 'description', value: 'VIP' }] } }), R('Delete a customer', 'DELETE', '/customers/cus_123'), R('List all customers', 'GET', '/customers', { query: { limit: '10', starting_after: 'cus_100' }, test: 200 })] },
      { name: 'Charges', requests: [R('Create a charge', 'POST', '/charges', { headers: { 'Idempotency-Key': '{{$guid}}' }, body: { type: 'form', fields: [{ key: 'amount', value: '2000' }, { key: 'currency', value: 'usd' }, { key: 'source', value: 'tok_visa' }] }, test: 200 }), R('Retrieve a charge', 'GET', '/charges/ch_123'), R('Capture a charge', 'POST', '/charges/ch_123/capture'), R('List all charges', 'GET', '/charges', { query: { customer: 'cus_123' } })] },
      { name: 'Refunds', requests: [R('Create a refund', 'POST', '/refunds', { body: { type: 'form', fields: [{ key: 'charge', value: 'ch_123' }, { key: 'amount', value: '500' }] } }), R('Retrieve a refund', 'GET', '/refunds/re_123'), R('List all refunds', 'GET', '/refunds', { query: { charge: 'ch_123' } })] },
    ],
  },
  {
    id: 'codehost', title: 'Code Host API', base: 'https://api.codehost.example.test', auth: { type: 'bearer', token: '{{token}}' },
    envs: { default: { baseUrl: 'https://api.codehost.example.test', token: '', owner: 'octocat', repo: 'hello-world' } },
    folders: [
      { name: 'Repos', requests: [R('Get a repository', 'GET', '/repos/{{owner}}/{{repo}}', { headers: { Accept: 'application/vnd.codehost+json' }, test: 200 }), R('List repository contributors', 'GET', '/repos/{{owner}}/{{repo}}/contributors', { query: { per_page: '30', page: '1' } }), R('List branches', 'GET', '/repos/{{owner}}/{{repo}}/branches'), R('Create a fork', 'POST', '/repos/{{owner}}/{{repo}}/forks'), R('Delete a repository', 'DELETE', '/repos/{{owner}}/{{repo}}')] },
      { name: 'Issues', requests: [R('List issues', 'GET', '/repos/{{owner}}/{{repo}}/issues', { query: { state: 'open', labels: 'bug' } }), R('Create an issue', 'POST', '/repos/{{owner}}/{{repo}}/issues', { body: json({ title: 'Found a bug', body: "I'm having a problem with this.", labels: ['bug'] }), test: 201 }), R('Get an issue', 'GET', '/repos/{{owner}}/{{repo}}/issues/1347'), R('Update an issue', 'PATCH', '/repos/{{owner}}/{{repo}}/issues/1347', { body: json({ state: 'closed' }) }), R('Lock an issue', 'PUT', '/repos/{{owner}}/{{repo}}/issues/1347/lock', { body: json({ lock_reason: 'resolved' }) })] },
      { name: 'Users', requests: [R('Get the authenticated user', 'GET', '/user', { test: 200 }), R('Get a user', 'GET', '/users/{{owner}}'), R('List followers of a user', 'GET', '/users/{{owner}}/followers')] },
    ],
  },
  {
    id: 'chat', title: 'Chat API', base: 'https://chat.example.test/api', auth: { type: 'bearer', token: '{{botToken}}' },
    envs: { workspace: { baseUrl: 'https://chat.example.test/api', botToken: 'xoxb-test', channel: 'C0123' } },
    folders: [
      { name: 'conversations', requests: [R('conversations.list', 'GET', '/conversations.list', { query: { limit: '100', types: 'public_channel' }, test: 200 }), R('conversations.history', 'GET', '/conversations.history', { query: { channel: '{{channel}}', limit: '20' } }), R('conversations.join', 'POST', '/conversations.join', { body: json({ channel: '{{channel}}' }) }), R('conversations.create', 'POST', '/conversations.create', { body: json({ name: 'new-channel', is_private: false }) })] },
      { name: 'chat', requests: [R('chat.postMessage', 'POST', '/chat.postMessage', { body: json({ channel: '{{channel}}', text: 'Hello, world', unfurl_links: false }), test: 200 }), R('chat.update', 'POST', '/chat.update', { body: json({ channel: '{{channel}}', ts: '1405894322.002768', text: 'edited' }) }), R('chat.delete', 'POST', '/chat.delete', { body: json({ channel: '{{channel}}', ts: '1405894322.002768' }) })] },
      { name: 'users', requests: [R('users.list', 'GET', '/users.list', { query: { limit: '200' } }), R('users.info', 'GET', '/users.info', { query: { user: 'U0123' } }), R('auth.test', 'POST', '/auth.test', { test: 200 })] },
    ],
  },
  {
    id: 'geo', title: 'Maps API', base: 'https://maps.example.test/maps/api', auth: { type: 'apikey-query', key: 'key', value: '{{mapsKey}}' },
    envs: { default: { baseUrl: 'https://maps.example.test/maps/api', mapsKey: 'AIza-test' } },
    folders: [
      { name: 'Geocoding', requests: [R('Geocode an address', 'GET', '/geocode/json', { query: { address: '1600 Amphitheatre Parkway, Mountain View, CA' }, test: 200 }), R('Reverse geocode', 'GET', '/geocode/json', { query: { latlng: '40.714224,-73.961452' } }), R('Geocode by place id', 'GET', '/geocode/json', { query: { place_id: 'ChIJd8BlQ2BZwokRAFUEcm_qrcA' } })] },
      { name: 'Directions', requests: [R('Driving directions', 'GET', '/directions/json', { query: { origin: 'Toronto', destination: 'Montreal', mode: 'driving' }, test: 200 }), R('Transit directions', 'GET', '/directions/json', { query: { origin: 'Boston', destination: 'Concord', mode: 'transit' } })] },
      { name: 'Places', requests: [R('Find place', 'GET', '/place/findplacefromtext/json', { query: { input: 'Museum of Contemporary Art Australia', inputtype: 'textquery' } }), R('Place details', 'GET', '/place/details/json', { query: { place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4' } }), R('Nearby search', 'GET', '/place/nearbysearch/json', { query: { location: '-33.8670522,151.1957362', radius: '1500', type: 'restaurant' } })] },
    ],
  },
  {
    id: 'weather', title: 'Weather API', base: 'https://api.weather.example.test/data/2.5', auth: { type: 'apikey-query', key: 'appid', value: '{{appid}}' },
    envs: { default: { baseUrl: 'https://api.weather.example.test/data/2.5', appid: 'demo' } },
    folders: [
      { name: 'Current', requests: [R('Current weather by city', 'GET', '/weather', { query: { q: 'London,uk', units: 'metric' }, test: 200 }), R('Current weather by coordinates', 'GET', '/weather', { query: { lat: '51.5', lon: '-0.12' } }), R('Current weather by zip', 'GET', '/weather', { query: { zip: '94040,us' } })] },
      { name: 'Forecast', requests: [R('5 day forecast', 'GET', '/forecast', { query: { q: 'Paris', cnt: '40' }, test: 200 }), R('Air pollution', 'GET', '/air_pollution', { query: { lat: '50', lon: '50' } }), R('Weather alerts', 'GET', '/onecall', { query: { lat: '33.44', lon: '-94.04', exclude: 'minutely,hourly' } })] },
    ],
  },
  {
    id: 'bank', title: 'Bank API', base: 'https://api.bank.example.test/open-banking/v3', auth: { type: 'oauth2', tokenUrl: 'https://auth.bank.example.test/oauth/token', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scope: 'accounts payments' },
    envs: { sandbox: { baseUrl: 'https://sandbox.bank.example.test/open-banking/v3', clientId: 'sandbox-client', clientSecret: '' }, production: { baseUrl: 'https://api.bank.example.test/open-banking/v3', clientId: '', clientSecret: '' } },
    folders: [
      { name: 'Accounts', requests: [R('List accounts', 'GET', '/accounts', { test: 200 }), R('Get account', 'GET', '/accounts/{{accountId}}'), R('Get balances', 'GET', '/accounts/{{accountId}}/balances', { test: 200 }), R('Get transactions', 'GET', '/accounts/{{accountId}}/transactions', { query: { fromBookingDateTime: '2026-01-01T00:00:00Z', limit: '50' } }), R('List standing orders', 'GET', '/accounts/{{accountId}}/standing-orders')] },
      { name: 'Payments', requests: [R('Create a payment consent', 'POST', '/domestic-payment-consents', { headers: { 'x-idempotency-key': '{{$guid}}', 'x-fapi-financial-id': '{{orgId}}' }, body: json({ Data: { Initiation: { InstructionIdentification: 'ACME412', InstructedAmount: { Amount: '165.88', Currency: 'GBP' } } }, Risk: {} }), test: 201 }), R('Get a payment consent', 'GET', '/domestic-payment-consents/{{consentId}}'), R('Submit a payment', 'POST', '/domestic-payments', { body: json({ Data: { ConsentId: '{{consentId}}' }, Risk: {} }) }), R('Get a payment', 'GET', '/domestic-payments/{{paymentId}}')] },
      { name: 'Funds', requests: [R('Confirm funds', 'POST', '/funds-confirmations', { body: json({ Data: { ConsentId: '{{consentId}}', Reference: 'Purchase01', InstructedAmount: { Amount: '20.00', Currency: 'GBP' } } }) }), R('Get funds consent', 'GET', '/funds-confirmation-consents/{{consentId}}')] },
    ],
  },
  {
    id: 'clinic', title: 'Vet Clinic', base: 'https://clinic.example.test/api', auth: { type: 'basic', username: '{{user}}', password: '{{password}}' },
    envs: { local: { baseUrl: 'http://localhost:4010/api', user: 'vet', password: 'secret' }, staging: { baseUrl: 'https://staging.clinic.example.test/api', user: 'vet', password: '' } },
    folders: [
      { name: 'Patients', requests: [R('List patients', 'GET', '/patients', { query: { species: 'dog', limit: '25' }, test: 200 }), R('Create a patient', 'POST', '/patients', { body: json({ name: 'Rex', species: 'dog', born: '2021-03-04', owner: 'o-7' }), test: 201 }), R('Get a patient', 'GET', '/patients/:id', { pathVars: { id: 'p-1' }, test: 200 }), R('Update a patient', 'PATCH', '/patients/:id', { pathVars: { id: 'p-1' }, body: json({ weightKg: 31.5 }) }), R('Upload a photo', 'PUT', '/patients/:id/photo', { pathVars: { id: 'p-1' }, body: { type: 'multipart', fields: [{ key: 'caption', value: 'At the beach' }, { key: 'photo', file: 'rex.png' }] } })] },
      { name: 'Visits', requests: [R('List visits', 'GET', '/visits', { query: { patient: 'p-1' } }), R('Book a visit', 'POST', '/visits', { body: json({ patient: 'p-1', at: '2026-05-04T09:30:00Z', reason: 'vaccination' }), test: 201 }), R('Cancel a visit', 'DELETE', '/visits/v-3')] },
      { name: 'Owners', requests: [R('List owners', 'GET', '/owners'), R('Create an owner', 'POST', '/owners', { body: json({ name: 'Ada', email: 'ada@example.test' }) })] },
    ],
  },
];

const url = (d, r) => `{{baseUrl}}${r.path}`;
const hs = (h) => Object.entries(h ?? {});
const countOf = (d) => ({ requests: d.folders.reduce((n, f) => n + f.requests.length, 0), folders: d.folders.length, environments: Object.keys(d.envs).length });
const allReqs = (d) => d.folders.flatMap((f) => f.requests);

/* ---------------------------------------------------------------- emitters */
function postman(d) {
  const auth = (a) => (a.type === 'bearer' ? { type: 'bearer', bearer: [{ key: 'token', value: a.token, type: 'string' }] } : a.type === 'basic' ? { type: 'basic', basic: [{ key: 'username', value: a.username }, { key: 'password', value: a.password }] } : a.type === 'apikey' ? { type: 'apikey', apikey: [{ key: 'key', value: a.key }, { key: 'value', value: a.value }, { key: 'in', value: 'header' }] } : a.type === 'apikey-query' ? { type: 'apikey', apikey: [{ key: 'key', value: a.key }, { key: 'value', value: a.value }, { key: 'in', value: 'query' }] } : { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'client_credentials' }, { key: 'accessTokenUrl', value: a.tokenUrl }, { key: 'clientId', value: a.clientId }, { key: 'clientSecret', value: a.clientSecret }, { key: 'scope', value: a.scope }] });
  const body = (b) => (!b ? undefined : b.type === 'json' ? { mode: 'raw', raw: b.content, options: { raw: { language: 'json' } } } : b.type === 'form' ? { mode: 'urlencoded', urlencoded: b.fields.map((f) => ({ key: f.key, value: f.value })) } : { mode: 'formdata', formdata: b.fields.map((f) => (f.file ? { key: f.key, type: 'file', src: f.file } : { key: f.key, value: f.value, type: 'text' })) });
  const item = (r) => ({
    name: r.name,
    request: { method: r.method, header: hs(r.headers).map(([key, value]) => ({ key, value })), ...(body(r.body) ? { body: body(r.body) } : {}), url: { raw: url(d, r) + (r.query ? '?' + hs(r.query).map(([k, v]) => `${k}=${v}`).join('&') : ''), host: ['{{baseUrl}}'], path: r.path.split('/').filter(Boolean), ...(r.query ? { query: hs(r.query).map(([key, value]) => ({ key, value })) } : {}), ...(r.pathVars ? { variable: hs(r.pathVars).map(([key, value]) => ({ key, value })) } : {}) } },
    ...(r.test ? { event: [{ listen: 'test', script: { type: 'text/javascript', exec: [`pm.test("Status code is ${r.test}", function () {`, `    pm.response.to.have.status(${r.test});`, '});'] } }] } : {}),
  });
  const col = { info: { _postman_id: `pm-${d.id}`, name: d.title, schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, auth: auth(d.auth), item: d.folders.map((f) => ({ name: f.name, item: f.requests.map(item) })), variable: [{ key: 'baseUrl', value: d.base }] };
  return { ext: 'json', text: JSON.stringify(col, null, 2) };
}
const insomniaReq = (d, r, i) => ({
  name: r.name, url: url(d, r), method: r.method,
  ...(r.body ? { body: r.body.type === 'json' ? { mimeType: 'application/json', text: r.body.content } : r.body.type === 'form' ? { mimeType: 'application/x-www-form-urlencoded', params: r.body.fields.map((f) => ({ name: f.key, value: f.value })) } : { mimeType: 'multipart/form-data', params: r.body.fields.map((f) => (f.file ? { name: f.key, type: 'file', fileName: f.file } : { name: f.key, value: f.value, type: 'text' })) } } : {}),
  ...(r.query ? { parameters: hs(r.query).map(([name, value]) => ({ name, value })) } : {}), ...(r.pathVars ? { pathParameters: hs(r.pathVars).map(([name, value]) => ({ name, value })) } : {}),
  headers: hs(r.headers).map(([name, value]) => ({ name, value })),
  ...(r.test ? { scripts: { afterResponse: `insomnia.test("Status code is ${r.test}", () => {\n  insomnia.expect(insomnia.response.code).to.eql(${r.test});\n});` } } : {}),
});
const insomniaAuth = (a) => (a.type === 'bearer' ? { type: 'bearer', token: a.token } : a.type === 'basic' ? { type: 'basic', username: a.username, password: a.password } : a.type === 'apikey' ? { type: 'apikey', key: a.key, value: a.value, addTo: 'header' } : a.type === 'apikey-query' ? { type: 'apikey', key: a.key, value: a.value, addTo: 'queryParams' } : { type: 'oauth2', grantType: 'client_credentials', accessTokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope });
const tpl = (s) => String(s).replace(/\{\{\s*([A-Za-z_][\w]*)\s*\}\}/g, (m, n) => (n.startsWith('$') ? m : `{{ _.${n} }}`));
function insomnia5(d) {
  const envs = Object.entries(d.envs);
  const doc = {
    type: 'collection.insomnia.rest/5.0', schema_version: '5.1', name: d.title, meta: { id: `wrk_${d.id}`, created: 1, modified: 1 },
    collection: d.folders.map((f, fi) => ({ name: f.name, meta: { id: `fld_${d.id}_${fi}`, sortKey: fi }, ...(fi === 0 ? { authentication: insomniaAuth(d.auth) } : {}), children: f.requests.map((r, i) => ({ ...JSON.parse(tpl(JSON.stringify(insomniaReq(d, r, i)))), meta: { id: `req_${d.id}_${fi}_${i}`, sortKey: i }, authentication: undefined })) })),
    environments: { name: 'Base Environment', meta: { id: `env_${d.id}` }, data: { baseUrl: d.base }, subEnvironments: envs.map(([n, v]) => ({ name: n, meta: { id: `env_${d.id}_${n}` }, data: v })) },
  };
  return { ext: 'yaml', text: YAML.stringify(doc, { lineWidth: 0 }) };
}
function insomnia4(d) {
  const res = [{ _id: `wrk_${d.id}`, _type: 'workspace', name: d.title, parentId: null }];
  d.folders.forEach((f, fi) => {
    res.push({ _id: `fld_${d.id}_${fi}`, _type: 'request_group', parentId: `wrk_${d.id}`, name: f.name, metaSortKey: fi, ...(fi === 0 ? { authentication: insomniaAuth(d.auth) } : {}) });
    f.requests.forEach((r, i) => {
      const q = insomniaReq(d, r, i);
      const { scripts, ...rest } = q;
      res.push({ _id: `req_${d.id}_${fi}_${i}`, _type: 'request', parentId: `fld_${d.id}_${fi}`, metaSortKey: i, ...JSON.parse(tpl(JSON.stringify(rest))), ...(scripts ? { afterResponseScript: scripts.afterResponse } : {}) });
    });
  });
  res.push({ _id: `env_${d.id}`, _type: 'environment', parentId: `wrk_${d.id}`, name: 'Base Environment', data: { baseUrl: d.base } });
  for (const [n, v] of Object.entries(d.envs)) res.push({ _id: `env_${d.id}_${n}`, _type: 'environment', parentId: `env_${d.id}`, name: n, data: v });
  return { ext: 'json', text: JSON.stringify({ _type: 'export', __export_format: 4, __export_source: 'insomnia.desktop.app:v10', resources: res }, null, 2) };
}
function opencollection(d) {
  const auth = (a) => (a.type === 'bearer' ? { type: 'bearer', token: a.token } : a.type === 'basic' ? { type: 'basic', username: a.username, password: a.password } : a.type === 'apikey' ? { type: 'apikey', key: a.key, value: a.value, placement: 'header' } : a.type === 'apikey-query' ? { type: 'apikey', key: a.key, value: a.value, placement: 'query' } : { type: 'oauth2', flow: 'client_credentials', accessTokenUrl: a.tokenUrl, credentials: { clientId: a.clientId, clientSecret: a.clientSecret }, scope: a.scope });
  const req = (r, i) => ({
    info: { name: r.name, type: 'http', seq: i + 1 },
    http: { method: r.method, url: url(d, r), ...(r.headers ? { headers: hs(r.headers).map(([name, value]) => ({ name, value })) } : {}), ...(r.query || r.pathVars ? { params: [...hs(r.query).map(([name, value]) => ({ name, value, type: 'query' })), ...hs(r.pathVars).map(([name, value]) => ({ name, value, type: 'path' }))] } : {}), ...(r.body ? { body: r.body.type === 'json' ? { type: 'json', data: r.body.content } : r.body.type === 'form' ? { type: 'form-urlencoded', data: r.body.fields.map((f) => ({ name: f.key, value: f.value })) } : { type: 'multipart-form', data: r.body.fields.map((f) => (f.file ? { name: f.key, type: 'file', value: [f.file] } : { name: f.key, value: f.value, type: 'text' })) } } : {}) },
    ...(r.test ? { runtime: { assertions: [{ expression: 'res.status', operator: 'eq', value: String(r.test) }] } } : {}),
  });
  const doc = { opencollection: '1.0.0', bundled: true, info: { name: d.title }, request: { auth: auth(d.auth), variables: [{ name: 'baseUrl', value: d.base }] }, items: d.folders.map((f, fi) => ({ info: { name: f.name, type: 'folder', seq: fi + 1 }, items: f.requests.map(req) })), config: { environments: Object.entries(d.envs).map(([name, v]) => ({ name, variables: hs(v).map(([k, val]) => ({ name: k, value: val })) })) } };
  return { ext: 'yaml', text: YAML.stringify(doc, { lineWidth: 0 }) };
}
function bruno(d) {
  const auth = (a) => (a.type === 'bearer' ? { mode: 'bearer', bearer: { token: a.token } } : a.type === 'basic' ? { mode: 'basic', basic: { username: a.username, password: a.password } } : a.type === 'apikey' ? { mode: 'apikey', apikey: { key: a.key, value: a.value, placement: 'header' } } : a.type === 'apikey-query' ? { mode: 'apikey', apikey: { key: a.key, value: a.value, placement: 'queryparams' } } : { mode: 'oauth2', oauth2: { grantType: 'client_credentials', accessTokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope } });
  const items = d.folders.map((f, fi) => ({ type: 'folder', name: f.name, seq: fi + 1, items: f.requests.map((r, i) => ({ type: 'http-request', name: r.name, seq: i + 1, request: { url: url(d, r) + (r.query ? '?' + hs(r.query).map(([k, v]) => `${k}=${v}`).join('&') : ''), method: r.method, headers: hs(r.headers).map(([name, value]) => ({ name, value, enabled: true })), params: [...hs(r.query).map(([name, value]) => ({ name, value, type: 'query', enabled: true })), ...hs(r.pathVars).map(([name, value]) => ({ name, value, type: 'path', enabled: true }))], body: !r.body ? { mode: 'none' } : r.body.type === 'json' ? { mode: 'json', json: r.body.content } : r.body.type === 'form' ? { mode: 'formUrlEncoded', formUrlEncoded: r.body.fields.map((f2) => ({ name: f2.key, value: f2.value, enabled: true })) } : { mode: 'multipartForm', multipartForm: r.body.fields.map((f2) => (f2.file ? { name: f2.key, type: 'file', value: [f2.file], enabled: true } : { name: f2.key, value: f2.value, type: 'text', enabled: true })) }, auth: { mode: 'inherit' }, script: {}, vars: {}, assertions: r.test ? [{ name: 'res.status', value: `eq ${r.test}`, enabled: true }] : [], tests: r.test ? `test("Status code is ${r.test}", function () {\n  expect(res.status).to.equal(${r.test});\n});` : '' } })) }));
  const doc = { name: d.title, version: '1', items, environments: Object.entries(d.envs).map(([name, v]) => ({ name, variables: hs(v).map(([k, val]) => ({ name: k, value: val, enabled: true, secret: false })) })), root: { request: { auth: auth(d.auth), vars: { req: [{ name: 'baseUrl', value: d.base, enabled: true }] } } }, brunoConfig: { version: '1', name: d.title, type: 'collection' } };
  return { ext: 'json', text: JSON.stringify(doc, null, 2) };
}
function hoppscotch(d) {
  const auth = (a) => (a.type === 'bearer' ? { authType: 'bearer', authActive: true, token: a.token } : a.type === 'basic' ? { authType: 'basic', authActive: true, username: a.username, password: a.password } : a.type === 'apikey' ? { authType: 'api-key', authActive: true, key: a.key, value: a.value, addTo: 'HEADERS' } : a.type === 'apikey-query' ? { authType: 'api-key', authActive: true, key: a.key, value: a.value, addTo: 'QUERY_PARAMS' } : { authType: 'oauth-2', authActive: true, grantTypeInfo: { grantType: 'CLIENT_CREDENTIALS', authEndpoint: a.tokenUrl, clientID: a.clientId, clientSecret: a.clientSecret, scopes: a.scope } });
  const hp = (s) => String(s).replace(/\{\{([^}]+)\}\}/g, '<<$1>>');
  const folder = (f) => ({ v: 2, name: f.name, folders: [], auth: { authType: 'inherit', authActive: true }, headers: [], variables: [], requests: f.requests.map((r) => ({ v: '11', name: r.name, method: r.method, endpoint: hp(url(d, r)), params: hs(r.query).map(([key, value]) => ({ key, value: hp(value), active: true })), headers: hs(r.headers).map(([key, value]) => ({ key, value: hp(value), active: true })), preRequestScript: '', testScript: r.test ? `pw.test("Status code is ${r.test}", () => {\n  pw.expect(pw.response.status).toBe(${r.test});\n});` : '', auth: { authType: 'inherit', authActive: true }, body: !r.body ? { contentType: null, body: null } : r.body.type === 'json' ? { contentType: 'application/json', body: r.body.content } : r.body.type === 'form' ? { contentType: 'application/x-www-form-urlencoded', body: r.body.fields.map((x) => `${x.key}: ${x.value}`).join('\n') } : { contentType: 'multipart/form-data', body: r.body.fields.map((x) => ({ key: x.key, value: x.file ?? x.value, active: true, isFile: !!x.file })) }, requestVariables: [] })) });
  return { ext: 'json', text: JSON.stringify({ v: 2, name: d.title, folders: d.folders.map(folder), requests: [], auth: auth(d.auth), headers: [], variables: [] }, null, 2) };
}
function thunder(d) {
  const auth = (a) => (a.type === 'bearer' ? { type: 'bearer', bearer: a.token } : a.type === 'basic' ? { type: 'basic', basic: { username: a.username, password: a.password } } : a.type === 'oauth2' ? { type: 'oauth2', oauth2: { grantType: 'client_credentials', accessTokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope } } : { type: 'apikey', apikey: { key: a.key, value: a.value, addTo: a.type === 'apikey-query' ? 'query' : 'header' } });
  const folders = d.folders.map((f, i) => ({ _id: `f${i}`, name: f.name, containerId: '', created: '2026-01-01', sortNum: (i + 1) * 10000 }));
  let n = 0;
  const requests = d.folders.flatMap((f, fi) => f.requests.map((r) => ({ _id: `r${++n}`, colId: `c-${d.id}`, containerId: `f${fi}`, name: r.name, url: url(d, r), method: r.method, sortNum: n * 10000, headers: hs(r.headers).map(([name, value]) => ({ name, value })), params: [...hs(r.query).map(([name, value]) => ({ name, value, isPath: false })), ...hs(r.pathVars).map(([name, value]) => ({ name, value, isPath: true }))], body: !r.body ? { type: 'none', raw: '', form: [] } : r.body.type === 'json' ? { type: 'json', raw: r.body.content, form: [] } : r.body.type === 'form' ? { type: 'formencoded', raw: '', form: r.body.fields.map((x) => ({ name: x.key, value: x.value })) } : { type: 'formdata', raw: '', form: r.body.fields.filter((x) => !x.file).map((x) => ({ name: x.key, value: x.value })), files: r.body.fields.filter((x) => x.file).map((x) => ({ name: x.key, value: x.file })) }, auth: auth(d.auth), tests: r.test ? [{ type: 'res-code', custom: '', action: 'equal', value: String(r.test) }] : [] })));
  return { ext: 'json', text: JSON.stringify({ clientName: 'Thunder Client', collectionName: d.title, collectionId: `c-${d.id}`, dateExported: '2026-03-01T00:00:00.000Z', version: '1.2', folders, requests }, null, 2) };
}
function yaak(d) {
  const ws = `wk_${d.id}`;
  const auth = (a) => (a.type === 'bearer' ? { authenticationType: 'bearer', authentication: { token: a.token } } : a.type === 'basic' ? { authenticationType: 'basic', authentication: { username: a.username, password: a.password } } : a.type === 'oauth2' ? { authenticationType: 'oauth2', authentication: { grantType: 'client_credentials', accessTokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scope: a.scope } } : { authenticationType: 'apikey', authentication: { key: a.key, value: a.value, location: a.type === 'apikey-query' ? 'query' : 'header' } });
  const y = (s) => String(s).replace(/\{\{\s*([A-Za-z_]\w*)\s*\}\}/g, '${[ $1 ]}');
  const folders = d.folders.map((f, i) => ({ model: 'folder', id: `fl_${d.id}_${i}`, workspaceId: ws, folderId: null, name: f.name, sortPriority: i + 1, ...(i === 0 ? auth(d.auth) : {}) }));
  let n = 0;
  const httpRequests = d.folders.flatMap((f, fi) => f.requests.map((r) => ({ model: 'http_request', id: `rq_${d.id}_${++n}`, workspaceId: ws, folderId: `fl_${d.id}_${fi}`, name: r.name, method: r.method, url: y(url(d, r)), urlParameters: [...hs(r.query).map(([name, value]) => ({ enabled: true, name, value: y(value) })), ...hs(r.pathVars).map(([name, value]) => ({ enabled: true, name: ':' + name, value }))], headers: hs(r.headers).map(([name, value]) => ({ enabled: true, name, value: y(value) })), bodyType: !r.body ? null : r.body.type === 'json' ? 'application/json' : r.body.type === 'form' ? 'application/x-www-form-urlencoded' : 'multipart/form-data', body: !r.body ? {} : r.body.type === 'json' ? { text: y(r.body.content) } : { form: r.body.fields.map((x) => (x.file ? { enabled: true, name: x.key, file: x.file } : { enabled: true, name: x.key, value: x.value })) }, authenticationType: null, authentication: {}, sortPriority: n })));
  const environments = [{ model: 'environment', id: `ev_${d.id}_base`, workspaceId: ws, name: 'Global', base: true, variables: [{ enabled: true, name: 'baseUrl', value: d.base }] }, ...Object.entries(d.envs).map(([name, v]) => ({ model: 'environment', id: `ev_${d.id}_${name}`, workspaceId: ws, name, variables: hs(v).map(([k, val]) => ({ enabled: true, name: k, value: val })) }))];
  return { ext: 'json', text: JSON.stringify({ yaakVersion: '2025.2.0', yaakSchema: 3, resources: { workspaces: [{ model: 'workspace', id: ws, name: d.title }], environments, folders, httpRequests } }, null, 2), envCount: Object.keys(d.envs).length };
}
function httpie(d) {
  const auth = (a) => (a.type === 'bearer' ? { type: 'bearer', credentials: { token: a.token } } : a.type === 'basic' ? { type: 'basic', credentials: { username: a.username, password: a.password } } : a.type === 'oauth2' ? { type: 'none' } : { type: 'api-key', credentials: { name: a.key, value: a.value, in: a.type === 'apikey-query' ? 'query' : 'header' } });
  const req = (r) => ({ name: r.name, method: r.method, url: url(d, r), queryParams: hs(r.query).map(([name, value]) => ({ name, value, enabled: true })), pathParams: hs(r.pathVars).map(([name, value]) => ({ name, value, enabled: true })), headers: hs(r.headers).map(([name, value]) => ({ name, value, enabled: true })), auth: { type: 'inherit' }, body: !r.body ? {} : r.body.type === 'json' ? { text: { format: 'json', value: r.body.content } } : r.body.type === 'form' ? { form: { isMultipart: false, fields: r.body.fields.map((x) => ({ name: x.key, value: x.value, enabled: true })) } } : { form: { isMultipart: true, fields: r.body.fields.map((x) => (x.file ? { name: x.key, type: 'file', values: [{ name: x.file, path: x.file }], enabled: true } : { name: x.key, value: x.value, enabled: true })) } } });
  const entry = { name: d.title, auth: auth(d.auth), requests: [], collections: d.folders.map((f) => ({ name: f.name, requests: f.requests.map(req) })) };
  return { ext: 'json', text: JSON.stringify({ meta: { format: 'httpie', version: '1.0.0', contentType: 'collection', docs: 'https://httpie.io/r/export-docs', source: 'HTTPie for Desktop 2025.2.0' }, entry }, null, 2), envCount: 0 };
}
function apidog(d) {
  const params = (o) => hs(o).map(([name, example]) => ({ name, required: true, type: 'string', example: String(example) }));
  const api = (r, id) => ({ name: r.name, api: { id: String(id), method: r.method.toLowerCase(), path: r.path.replace(/:(\w+)/g, '{$1}'), parameters: { query: params(r.query), path: params(r.pathVars), header: params(r.headers), cookie: [] }, ...(r.body ? { requestBody: r.body.type === 'json' ? { type: 'application/json', example: r.body.content } : r.body.type === 'form' ? { type: 'application/x-www-form-urlencoded', parameters: r.body.fields.map((x) => ({ name: x.key, example: x.value })) } : { type: 'multipart/form-data', parameters: r.body.fields.map((x) => ({ name: x.key, type: x.file ? 'file' : 'string', example: x.value })) } } : {}), responses: [{ id: `${id}0`, name: 'OK', code: r.test ?? 200, contentType: 'json', jsonSchema: { type: 'object', properties: { id: { type: 'string' } } } }] } });
  let id = 100;
  return { ext: 'json', text: JSON.stringify({ apidogProject: '1.0.0', info: { name: d.title }, apiCollection: [{ name: 'Root', id: 1, items: d.folders.map((f, i) => ({ name: f.name, id: 10 + i, items: f.requests.map((r) => api(r, ++id)) })) }], environments: Object.entries(d.envs).map(([name, v]) => ({ name, baseUrl: v.baseUrl, variables: hs(v).filter(([k]) => k !== 'baseUrl').map(([k, val]) => ({ name: k, value: val })) })) }, null, 2), envCount: Object.keys(d.envs).length, noBase: true };
}

const EMITTERS = { postman, 'insomnia-v5': insomnia5, 'insomnia-v4': insomnia4, opencollection, bruno, hoppscotch, thunder, yaak, httpie, apidog };
const index = {};
for (const [tool, emit] of Object.entries(EMITTERS))
  for (const d of DOMAINS) {
    const r = emit(d);
    const dir = join(HERE, tool);
    mkdirSync(dir, { recursive: true });
    const file = `${d.id}.${r.ext}`;
    writeFileSync(join(dir, file), r.text.endsWith('\n') ? r.text : r.text + '\n');
    const c = countOf(d);
    // environments the tool's file carries (Yaak adds its base environment; HTTPie's collection export has none; Thunder's are separate files)
    const envs = tool === 'httpie' || tool === 'thunder' || tool === 'hoppscotch' || tool === 'postman' ? 0 : tool === 'yaak' ? c.environments : c.environments;
    index[`${tool}/${file}`] = { tool, domain: d.id, requests: c.requests, folders: c.folders, environments: envs, tests: ['yaak', 'httpie', 'apidog'].includes(tool) ? 0 : allReqs(d).filter((r2) => r2.test).length };
  }
writeFileSync(join(HERE, 'index.json'), JSON.stringify(index, null, 2) + '\n');
console.log(Object.keys(index).length, 'files');
