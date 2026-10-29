// The Debugger's AI call inspector (0.60, FG-18): an LLM call is marked in the URL cell, the AI call tab reads it (model, messages, the streamed
// answer put back together, tokens, a cost estimate, a prompt-cache hint) with an API key pasted into the prompt masked, and an MCP
// message lists its tool call with the result. Loads a mock HAR (no network). Part of the end-to-end UI regression suite.
const { withExpect, stepOf } = require('../lib.cjs');

const HAR = `(() => {
  const h = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
  const entry = (i, method, url, reqType, reqBody, resType, resBody, reqHeaders = {}) => ({
    startedDateTime: new Date(Date.now() - 60000 + i * 1000).toISOString(),
    time: 25,
    request: { method, url, httpVersion: 'HTTP/1.1', headers: h({ 'content-type': reqType, ...reqHeaders }), cookies: [], queryString: [], headersSize: -1, bodySize: reqBody.length, postData: { mimeType: reqType, text: reqBody } },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: h({ 'content-type': resType }), cookies: [], content: { size: resBody.length, mimeType: resType, text: resBody }, redirectURL: '', headersSize: -1, bodySize: resBody.length },
    cache: {},
    timings: { send: 1, wait: 20, receive: 4 },
    _testpion: { id: 'ai' + i, kind: 'http' },
  });
  const ev = (o) => 'data: ' + JSON.stringify(o) + '\\n\\n';
  const openai = entry(1, 'POST', 'https://api.openai.com/v1/chat/completions', 'application/json',
    JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'system', content: 'You are terse.' }, { role: 'user', content: 'Weather in Oslo? My key is sk-abcdefghijklmnopqrstuvwxyz0123' }], tools: [{ type: 'function', function: { name: 'get_weather' } }] }),
    'text/event-stream',
    ev({ model: 'gpt-4o', choices: [{ delta: { content: 'Sun' } }] }) + ev({ choices: [{ delta: { content: 'ny.' } }] }) + ev({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '{"city":"Oslo"}' } }] }, finish_reason: 'tool_calls' }] }) + ev({ choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 } } }) + 'data: [DONE]\\n\\n');
  const mcp = entry(2, 'POST', 'https://tools.example.test/mcp', 'application/json',
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lookup_order', arguments: { id: 42, api_key: 'sk-abcdefghijklmnopqrstuvwxyz0123' } } }),
    'application/json', JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'Order 42 shipped' }] } }));
  const plain = entry(3, 'GET', 'https://plain.example.test/users', 'application/json', '{}', 'application/json', '{"a":1}');
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [openai, mcp, plain] } });
})()`;

const H = `
  const vis = (sel) => [...document.querySelectorAll(sel)].filter((x) => x.getClientRects().length);
  const rows = () => vis('main [data-debugger-grid] [role=row][data-exchange]');
  const row = (text) => rows().find((r) => r.textContent.includes(text));
  const pane = (side) => document.querySelector('main [data-details-pane="' + side + '"]');
  const tabs = (side) => [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].map((t) => t.textContent.trim());
  const openTab = async (side, name) => {
    const t = [...(pane(side)?.querySelectorAll('[role=tab]') ?? [])].find((x) => x.textContent.trim().startsWith(name));
    if (!t) return false;
    if (!t.hasAttribute('data-overflow')) { await __t.real.click(t); await __t.sleep(400); return true; }
    const more = pane(side)?.querySelector('[aria-label^="All tabs"]');
    if (!more) return false;
    more.click(); await __t.sleep(300);
    const it = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim().startsWith(name)), 2000);
    if (!it) return false;
    it.click(); await __t.sleep(400); return true;
  };
  const select = async (text) => { const r = await __t.waitFor(() => row(text), 5000); if (!r) return false; await __t.real.click(r); await __t.sleep(700); return true; };
`;
const step = stepOf(H);

const steps = [
  step(
    'load-a-session-with-an-llm-call-an-mcp-call-and-plain-traffic',
    `await __t.view('Debugger'); await __t.sleep(500);
     const r = await window.aps.invoke('debug.openSession', { text: ${HAR} });
     await __t.waitFor(() => (rows().length >= 3 ? true : null), 8000);
     return 'loaded: ' + r.loaded + ' | rows: ' + rows().length;`,
  ),
  step(
    'ai-calls-are-marked-in-the-url-cell-and-plain-traffic-is-not',
    `const label = (t) => row(t)?.querySelector('[data-ai-label]')?.textContent.trim() ?? null;
     return 'llm: ' + label('api.openai.com') + ' | mcp: ' + label('tools.example.test') + ' | plain: ' + label('plain.example.test');`,
  ),
  step(
    'ai-call-tab-reads-the-streamed-answer-tokens-and-cost',
    `if (!(await select('api.openai.com'))) return 'NO ROW';
     if (!(await openTab('response', 'AI call'))) return 'NO AI TAB: ' + tabs('response').join(',');
     const v = await __t.waitFor(() => { const x = pane('response')?.querySelector('[data-view=ai]'); return x && x.querySelector('[data-ai-usage]') ? x : null; }, 5000);
     if (!v) return 'NO VIEW';
     const t = v.textContent;
     return 'model: ' + /gpt-4o/.test(t) + ' | answer joined: ' + /Sunny\\./.test(t) + ' | tool call: ' + !!v.querySelector('[data-ai-tool-call]') + ' ' + /get_weather/.test(t) + ' | tokens: ' + /1,200/.test(t) + ' | cost shown: ' + /\\$0\\.\\d+/.test(t) + ' | cache hint: ' + !!v.querySelector('[data-ai-cache]') + ' | on request side too: ' + tabs('request').some((x) => x.startsWith('AI call'));`,
  ),
  step(
    'api-key-pasted-into-the-prompt-is-masked',
    `const v = pane('response')?.querySelector('[data-view=ai]'); if (!v) return 'NO VIEW';
     const t = v.textContent;
     return 'prompt shown: ' + /Weather in Oslo/.test(t) + ' | system: ' + /You are terse/.test(t) + ' | key shown: ' + /abcdefghijkl/.test(t);`,
  ),
  step(
    'mcp-tool-call-lists-name-arguments-and-result',
    `if (!(await select('tools.example.test'))) return 'NO ROW';
     if (!(await openTab('response', 'AI call'))) return 'NO AI TAB: ' + tabs('response').join(',');
     const v = await __t.waitFor(() => pane('response')?.querySelector('[data-ai-mcp]'), 5000); if (!v) return 'NO MCP TABLE';
     const t = v.textContent;
     return 'tool: ' + /lookup_order/.test(t) + ' | result: ' + /Order 42 shipped/.test(t) + ' | key shown: ' + /abcdefghijkl/.test(t);`,
  ),
  step(
    'plain-traffic-has-no-ai-tab',
    `if (!(await select('plain.example.test'))) return 'NO ROW';
     return 'ai tab: ' + tabs('response').concat(tabs('request')).some((x) => x.startsWith('AI call'));`,
  ),
];

module.exports = withExpect(steps, {
  'load-a-session-with-an-llm-call-an-mcp-call-and-plain-traffic': /^loaded: 3 \| rows: 3$/,
  'ai-calls-are-marked-in-the-url-cell-and-plain-traffic-is-not': /^llm: OpenAI gpt-4o \| mcp: MCP tools\/call lookup_order \| plain: null$/,
  'ai-call-tab-reads-the-streamed-answer-tokens-and-cost': /^model: true \| answer joined: true \| tool call: true true \| tokens: true \| cost shown: true \| cache hint: true \| on request side too: true$/,
  'api-key-pasted-into-the-prompt-is-masked': /^prompt shown: true \| system: true \| key shown: false$/,
  'mcp-tool-call-lists-name-arguments-and-result': /^tool: true \| result: true \| key shown: false$/,
  'plain-traffic-has-no-ai-tab': /^ai tab: false$/,
});
