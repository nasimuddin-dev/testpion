// A RAG dataset from captured calls, with real mouse and keys (__t.real): a captured session (a HAR) is opened in the HTTP
// Debugger, its exchanges are selected, "Create RAG dataset from selection…" opens the one capture dialog, Preview says what
// would be written (records, what was skipped and why, what was masked, the first rows) and Create writes
// datasets/<name>.jsonl. The email and the phone number in the questions and answers never reach the file; a call to another URL
// is reported as skipped. No model is called and no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { withExpect, step } = require('../lib.cjs');

/** The RAG target the captured calls went to (written before the app starts; the library file is plain JSON). */
function prepare(ws) {
  mkdirSync(join(ws, 'library'), { recursive: true });
  const target = {
    protocol: 'http',
    step: { type: 'http', method: 'POST', url: 'https://rag.example.test/query', json: { question: '{{question}}' } },
    mapping: { answer: '$.answer', contexts: '$.sources[*]', context: { text: '$.text', id: '$.id', score: '$.score' } },
  };
  writeFileSync(join(ws, 'library', 'rag-targets.json'), JSON.stringify({ folders: [], items: [{ id: 'rag-cap', name: 'Captured clinic', data: target, updatedAt: '2026-10-01T00:00:00.000Z' }] }, null, 2));
}

const HAR = `(() => {
  const call = (i, url, q, answer) => ({
    startedDateTime: new Date(Date.parse('2026-10-01T10:00:00Z') + i * 1000).toISOString(),
    time: 30 + i,
    request: { method: 'POST', url, httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }, { name: 'authorization', value: 'Bearer abcdefghijklmnop0123456789' }], cookies: [], queryString: [], headersSize: -1, bodySize: -1, postData: { mimeType: 'application/json', text: JSON.stringify({ question: q }) } },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }], cookies: [], content: { size: 10, mimeType: 'application/json', text: JSON.stringify({ answer, sources: [{ id: 'hours', text: 'The clinic is open 8 to 6.', score: 0.9 }] }) }, redirectURL: '', headersSize: -1, bodySize: -1 },
    cache: {},
    timings: { send: 1, wait: 20, receive: 5 },
  });
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [
    call(0, 'https://rag.example.test/query', 'When are you open? Write to me at jane.roe@example.org', 'We are open from 8 to 6. Call 415-555-0199.'),
    call(1, 'https://rag.example.test/query', 'Do you take walk-ins?', 'Yes, walk-ins are welcome until 5pm.'),
    call(2, 'https://other.example.test/health', 'ignored', 'ok'),
  ] } });
})()`;

const H = `
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
`;
const s = (name, body) => step(name, `${H} ${body}`);

const steps = [
  s(
    'open-the-captured-session',
    `await __t.view('Debugger'); await __t.sleep(500);
     const r = await window.aps.invoke('debug.openSession', { text: ${HAR} });
     const ok = await __t.waitFor(() => (rows().length >= 3 ? true : null), 8000);
     return 'loaded: ' + r.loaded + ' | rows: ' + rows().length + ' | painted: ' + !!ok;`,
  ),
  s(
    'select-the-exchanges-and-open-the-dialog',
    `await __t.real.click(rows()[0]); await __t.sleep(200);
     await __t.real.click(rows()[2], { shift: true }); await __t.sleep(300);
     await __t.real.rightClick(rows()[1]);
     const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.includes('Create RAG dataset')), 3000); if (!item) return 'NO MENU ITEM';
     const label = item.textContent.trim();
     await __t.real.click(item);
     const d = await __t.waitFor(() => document.querySelector('[data-rag-capture-dialog]'), 5000); if (!d) return 'NO DIALOG';
     const chosen = await __t.waitFor(() => { const t = document.querySelector('[data-rag-capture-target]')?.selectedOptions[0]?.textContent.trim(); return t && !t.startsWith('No HTTP') ? t : null; }, 5000);
     return 'item: ' + label + ' | dialog: true | target chosen: ' + (chosen ?? '');`,
  ),
  s(
    'preview-says-what-would-be-written',
    `await __t.real.click('[data-rag-capture-name]'); await __t.real.type('e2e-captured');
     await __t.real.click('[data-rag-capture-preview]');
     const rep = await __t.waitFor(() => document.querySelector('[data-rag-capture-report]'), 8000); if (!rep) return 'NO REPORT';
     const text = rep.textContent;
     return 'records: ' + /(\\d+) records/.exec(text)?.[1] + ' | skipped url: ' + /Skipped 1 × not a call to the target/.test(text) + ' | masked: ' + /\\d+ texts? masked/.test(text) + ' | email shown: ' + /jane\\.roe@example\\.org/.test(text) + ' | rows: ' + rep.querySelectorAll('tbody tr').length;`,
  ),
  s(
    'create-writes-the-dataset',
    `await __t.real.click('[data-rag-capture-create]');
     const gone = await __t.waitFor(() => (document.querySelector('[data-rag-capture-dialog]') ? null : true), 8000);
     let file = '';
     try { const d = await window.aps.invoke('datasets.preview', { name: 'e2e-captured.jsonl' }); file = JSON.stringify(d); } catch (e) { file = 'ERR ' + e.message; }
     return 'closed: ' + !!gone + ' | file has question: ' + file.includes('walk-ins') + ' | email in file: ' + /jane\\.roe|415-555-0199|abcdefghijklmnop/.test(file);`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'open-the-captured-session': /^loaded: 3 \| rows: 3 \| painted: true$/,
    'select-the-exchanges-and-open-the-dialog': /^item: Create RAG dataset from 3 selected… \| dialog: true \| target chosen: Captured clinic$/,
    'preview-says-what-would-be-written': /^records: 2 \| skipped url: true \| masked: true \| email shown: false \| rows: 2$/,
    'create-writes-the-dataset': /^closed: true \| file has question: true \| email in file: false$/,
  },
  { prepare },
);
