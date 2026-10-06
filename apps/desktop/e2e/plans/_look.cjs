// Screenshots to look at (not part of the suite): Home's tiles and the collection explorer's rows.
const { withExpect } = require('../lib.cjs');
const steps = [
  ['home', `(async () => { await __t.view('Home'); await __t.sleep(1500); return 'ok'; })()`],
  [
    'explorer',
    `(async () => { await __t.requests(); await __t.sleep(800); for (const n of ['Swagger Petstore (OpenAPI contract)', 'gRPC (grpcb.in)']) { try { await __t.expand(n); } catch {} } await __t.sleep(800); return 'ok'; })()`,
  ],
];
module.exports = withExpect(steps, { home: /^ok$/, explorer: /^ok$/ });
