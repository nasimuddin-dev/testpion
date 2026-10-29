import { describe, expect, it } from 'vitest';
import { aiCallOf, aiLabelOf, aiCostOf, exchangeView, looksLikeAiCall, scrubSecrets, scrubValue } from '../../packages/shared/src/index';

const sse = (...events: Array<[string | undefined, unknown]>) => events.map(([e, d]) => `${e ? `event: ${e}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`).join('');

describe('AI calls: OpenAI', () => {
  const url = 'https://api.openai.com/v1/chat/completions';
  it('reads a whole chat completion with usage and cost', () => {
    const c = aiCallOf({
      url,
      requestBody: JSON.stringify({ model: 'gpt-4o', temperature: 0.2, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }], tools: [{ type: 'function', function: { name: 'get_weather' } }] }),
      responseBody: JSON.stringify({ model: 'gpt-4o-2024-08-06', choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 400 } } }),
    })!;
    expect(c.provider).toBe('openai');
    expect(c.model).toBe('gpt-4o-2024-08-06');
    expect(c.system).toBe('Be brief.');
    expect(c.messages).toEqual([{ role: 'user', text: 'Hi' }]);
    expect(c.tools).toEqual(['get_weather']);
    expect(c.output).toMatchObject({ text: 'Hello!', stopReason: 'stop' });
    expect(c.usage).toMatchObject({ inputTokens: 1000, outputTokens: 100, cachedInputTokens: 400 });
    // 600 fresh * 2.5 + 400 cached * 1.25 + 100 out * 10 = 1500 + 500 + 1000 per million
    expect(c.cost!.usd).toBeCloseTo(0.003, 6);
    expect(c.cacheHint).toMatch(/prompt cache/);
    expect(c.label).toBe('OpenAI gpt-4o-2024-08-06');
  });
  it('puts a streamed answer and streamed tool call arguments back together', () => {
    const body = sse(
      [undefined, { model: 'gpt-4o', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] }],
      [undefined, { choices: [{ delta: { content: 'lo' } }] }],
      [undefined, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":' } }] } }] }],
      [undefined, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"Oslo"}' } }] }, finish_reason: 'tool_calls' }] }],
      [undefined, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }],
      [undefined, '[DONE]'],
    );
    const c = aiCallOf({ url, requestBody: JSON.stringify({ model: 'gpt-4o', stream: true, messages: [{ role: 'user', content: 'x' }] }), responseBody: body })!;
    expect(c.stream).toBe(true);
    expect(c.output!.text).toBe('Hello');
    expect(c.output!.toolCalls).toEqual([{ name: 'get_weather', arguments: { city: 'Oslo' } }]);
    expect(c.output!.stopReason).toBe('tool_calls');
    expect(c.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });
  it('reads the Responses API, streamed', () => {
    const body = sse(
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hi ' }],
      ['response.output_text.delta', { type: 'response.output_text.delta', delta: 'there' }],
      ['response.completed', { type: 'response.completed', response: { model: 'gpt-4.1', status: 'completed', usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } } } }],
    );
    const c = aiCallOf({ url: 'https://api.openai.com/v1/responses', requestBody: JSON.stringify({ model: 'gpt-4.1', instructions: 'Short.', input: 'hello' }), responseBody: body })!;
    expect(c.endpoint).toBe('responses');
    expect(c.system).toBe('Short.');
    expect(c.output!.text).toBe('Hi there');
    expect(c.usage).toMatchObject({ inputTokens: 20, outputTokens: 4 });
  });
  it('reads the provider error', () => {
    const c = aiCallOf({ url, status: 401, requestBody: '{"model":"gpt-4o","messages":[]}', responseBody: '{"error":{"message":"Incorrect API key provided: sk-abcdefghijklmnopqrstuvwx"}}' })!;
    expect(c.error).toContain('Incorrect API key');
    expect(c.error).not.toContain('abcdefghijklmnop');
  });
});

describe('AI calls: Anthropic', () => {
  const headers = { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant-FAKEFAKEFAKEFAKEFAKE' };
  it('reads a streamed message with a tool call, usage and cache numbers', () => {
    const body = sse(
      ['message_start', { type: 'message_start', message: { model: 'claude-sonnet-4-5', usage: { input_tokens: 50, output_tokens: 1, cache_read_input_tokens: 2000 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Checking' } }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't', name: 'search' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } }],
    );
    const c = aiCallOf({
      url: 'https://api.anthropic.com/v1/messages',
      requestHeaders: headers,
      requestBody: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 100, stream: true, system: [{ type: 'text', text: 'You help.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'find x' }] }], tools: [{ name: 'search' }] }),
      responseBody: body,
    })!;
    expect(c.provider).toBe('anthropic');
    expect(c.system).toBe('You help.');
    expect(c.output!.text).toBe('Checking');
    expect(c.output!.toolCalls).toEqual([{ name: 'search', arguments: { q: 'x' } }]);
    expect(c.output!.stopReason).toBe('tool_use');
    expect(c.usage).toMatchObject({ inputTokens: 50, outputTokens: 30, cachedInputTokens: 2000 });
    expect(c.cost!.usd).toBeGreaterThan(0);
    expect(c.cacheHint).toMatch(/prompt cache/);
  });
  it('hints at cache_control for a long prompt that cached nothing', () => {
    const c = aiCallOf({
      url: 'https://api.anthropic.com/v1/messages',
      requestHeaders: headers,
      requestBody: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [{ role: 'user', content: 'x'.repeat(7000) }] }),
      responseBody: JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1500, output_tokens: 2 } }),
    })!;
    expect(c.cacheHint).toMatch(/cache_control/);
    expect(c.messages[0]!.text).toContain('more characters');
  });
});

describe('AI calls: Gemini and Ollama', () => {
  it('reads Gemini generateContent with the model from the address', () => {
    const c = aiCallOf({
      url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00',
      requestBody: JSON.stringify({ systemInstruction: { parts: [{ text: 'Be kind.' }] }, contents: [{ role: 'user', parts: [{ text: 'hey' }] }], tools: [{ functionDeclarations: [{ name: 'lookup' }] }] }),
      responseBody: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }, { functionCall: { name: 'lookup', args: { id: 1 } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } }),
    })!;
    expect(c.model).toBe('gemini-2.5-flash');
    expect(c.system).toBe('Be kind.');
    expect(c.tools).toEqual(['lookup']);
    expect(c.output).toMatchObject({ text: 'Hello', toolCalls: [{ name: 'lookup', arguments: { id: 1 } }] });
    expect(c.usage).toMatchObject({ inputTokens: 7, outputTokens: 3, totalTokens: 10 });
  });
  it('reads Ollama NDJSON and says a local model is free', () => {
    const body = ['{"model":"llama3","message":{"role":"assistant","content":"Hel"},"done":false}', '{"model":"llama3","message":{"role":"assistant","content":"lo"},"done":false}', '{"model":"llama3","message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":12,"eval_count":2}'].join('\n');
    const c = aiCallOf({ url: 'http://localhost:11434/api/chat', requestBody: '{"model":"llama3","messages":[{"role":"user","content":"hi"}]}', responseBody: body })!;
    expect(c.stream).toBe(true);
    expect(c.output!.text).toBe('Hello');
    expect(c.usage).toMatchObject({ inputTokens: 12, outputTokens: 2 });
    expect(c.cost).toMatchObject({ usd: 0 });
  });
});

describe('AI calls: MCP', () => {
  const url = 'https://tools.example.test/mcp';
  it('lists tool calls by name with their results', () => {
    const req = JSON.stringify([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_weather', arguments: { city: 'Oslo', api_key: 'sk-abcdefghijklmnopqrstuvwx' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bad', arguments: {} } },
    ]);
    const res = sse([undefined, { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '12 C' }] } }], [undefined, { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'unknown tool' } }]);
    const c = aiCallOf({ url, requestBody: req, responseBody: res })!;
    expect(c.provider).toBe('mcp');
    expect(c.tools).toEqual(['get_weather', 'bad']);
    expect(c.mcp![0]).toMatchObject({ method: 'tools/call', name: 'get_weather', result: '12 C', arguments: { city: 'Oslo', api_key: '***' } });
    expect(c.mcp![1]!.error).toBe('unknown tool');
    expect(c.label).toBe('MCP 2 messages (2 tool calls)');
  });
  it('reads initialize and tools/list', () => {
    const l = aiCallOf({ url, requestBody: '{"jsonrpc":"2.0","id":3,"method":"tools/list"}', responseBody: '{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"a"},{"name":"b"}]}}' })!;
    expect(l.mcp![0]!.tools).toEqual(['a', 'b']);
    expect(l.label).toBe('MCP tools/list');
    const i = aiCallOf({ url, requestBody: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}', responseBody: '{"jsonrpc":"2.0","id":1,"result":{"serverInfo":{"name":"demo","version":"1.2"}}}' })!;
    expect(i.mcp![0]!.server).toBe('demo 1.2');
  });
});

describe('AI calls: recognising and redacting', () => {
  it('does not take other traffic for AI', () => {
    expect(looksLikeAiCall({ url: 'https://example.test/api/users', requestBody: '{"a":1}' })).toBe(false);
    expect(aiCallOf({ url: 'https://example.test/v1/messages', requestBody: '{"text":"hi"}' })).toBeUndefined();
    expect(aiLabelOf({ url: 'https://example.test/', requestBody: '{"jsonrpc":"2.0","method":"other"}' })).toBeUndefined();
  });
  it('tolerates bodies that are not what they should be', () => {
    expect(aiCallOf({ url: 'https://api.openai.com/v1/chat/completions', requestBody: 'not json' })).toBeUndefined();
    const c = aiCallOf({ url: 'https://api.openai.com/v1/chat/completions', requestBody: '{"model":"gpt-4o","messages":[{"role":"user"}]}', responseBody: '<html>' })!;
    expect(c.notes.join(' ')).toMatch(/could not be read/);
  });
  it('masks keys pasted into prompts and in tool arguments', () => {
    const key = 'sk-proj-abcdefghijklmnopqrstuvwxyz0123';
    const c = aiCallOf({ url: 'https://api.openai.com/v1/chat/completions', requestBody: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: `use ${key} and Bearer abcdefghijklmnop1234` }] }) })!;
    expect(c.messages[0]!.text).not.toContain('abcdefghijkl');
    expect(JSON.stringify(exchangeView({ url: 'https://api.openai.com/v1/chat/completions', requestBody: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: key }] }) }, 'ai'))).not.toContain('abcdefghijkl');
    expect(scrubSecrets('AKIAABCDEFGHIJKLMNOP')).toBe('***');
    expect(scrubValue({ a: { password: 'x', n: 1 } })).toEqual({ a: { password: '***', n: 1 } });
  });
  it('prices only models it knows', () => {
    expect(aiCostOf('openai', 'some-new-model', { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
    expect(aiCostOf('anthropic', 'claude-opus-4', { inputTokens: 1_000_000, outputTokens: 0 })!.usd).toBeCloseTo(15, 6);
  });
});

describe('the ai view of an exchange (CLI and MCP share it)', () => {
  it('is listed for AI calls and says what is wrong otherwise', () => {
    const e = { url: 'https://api.openai.com/v1/chat/completions', requestBody: '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}', responseBody: '{"choices":[{"message":{"content":"yo"}}]}', contentType: 'application/json' };
    expect(exchangeView(e, 'list').data).toMatchObject({ views: expect.arrayContaining(['ai']) });
    const r = exchangeView(e, 'ai');
    expect(r.ok).toBe(true);
    expect(r.text).toContain('Answer');
    expect(exchangeView({ url: 'https://example.test/' }, 'ai')).toMatchObject({ ok: false });
  });
});
