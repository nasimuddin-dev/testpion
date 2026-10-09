// Floods the Debugger's proxy from outside the app: N requests at concurrency C to the demo API through the proxy,
// then writes { sent, ok, failed, seconds, rps } as JSON to the result file. Used by the _perf-debugger-flood plan.
//   node flood.mjs <proxyPort> <count> <concurrency> <resultFile> [bodyBytes]
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const [port, countArg, concurrencyArg, resultFile, bodyArg] = process.argv.slice(2);
const count = Number(countArg) || 1000;
const concurrency = Number(concurrencyArg) || 20;
const bodyBytes = Number(bodyArg) || 0;
const agent = new http.Agent({ keepAlive: true, maxSockets: concurrency });
const body = bodyBytes ? 'x'.repeat(bodyBytes) : undefined;
let sent = 0;
let ok = 0;
let failed = 0;
const t0 = Date.now();

const one = (i) =>
  new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number(port),
        method: body ? 'POST' : 'GET',
        // an absolute URL: the proxy forwards it to the demo API
        path: `http://127.0.0.1:4010/health?flood=${i}`,
        agent,
        headers: { host: '127.0.0.1:4010', ...(body ? { 'content-type': 'text/plain', 'content-length': String(body.length) } : {}) },
      },
      (res) => {
        res.resume();
        res.on('end', () => {
          if (res.statusCode && res.statusCode < 500) ok++;
          else failed++;
          resolve();
        });
      },
    );
    req.on('error', () => {
      failed++;
      resolve();
    });
    // a request nobody answers (the proxy stopped mid-flood) counts as failed instead of hanging the tool
    req.setTimeout(30_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });

async function worker() {
  while (sent < count) {
    const i = sent++;
    await one(i);
  }
}
const finish = (timedOut) => {
  const seconds = (Date.now() - t0) / 1000;
  const out = { sent, ok, failed, seconds: Math.round(seconds * 100) / 100, rps: Math.round((ok + failed) / seconds), ...(timedOut ? { timedOut: true } : {}) };
  writeFileSync(resultFile, JSON.stringify(out));
  console.log(JSON.stringify(out));
  // keep-alive sockets would keep the process (and its Electron helpers) alive after the plan has moved on
  process.exit(0);
};
// never outlive the plan waiting for it (it gives up after 170 s): write what was done and leave
setTimeout(() => finish(true), 175_000).unref();
await Promise.all(Array.from({ length: concurrency }, worker));
finish(false);
