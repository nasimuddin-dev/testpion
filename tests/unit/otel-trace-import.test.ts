/**
 * Traces of an AI application as dataset records (N-4): an OTLP/JSON export, read under the attribute spellings in use
 * (the current GenAI conventions, the older indexed and event forms, OpenInference).
 */
import { describe, expect, it } from 'vitest';
import { detectRagFormat, importOtelTraces, importRagRecords, parseRagImportText } from '../../packages/core/src/index.js';

type A = Record<string, unknown>;
const attr = (o: A) => Object.entries(o).map(([key, v]) => ({ key, value: typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v) } }));
let n = 0;
const span = (traceId: string, name: string, attributes: A, o: { start?: number; end?: number; error?: boolean; events?: Array<{ name: string; attributes: A }> } = {}) => ({
  traceId,
  spanId: `s${++n}`,
  name,
  startTimeUnixNano: String((o.start ?? 0) * 1_000_000),
  endTimeUnixNano: String((o.end ?? 100) * 1_000_000),
  attributes: attr(attributes),
  ...(o.events ? { events: o.events.map((e) => ({ name: e.name, attributes: attr(e.attributes) })) } : {}),
  ...(o.error ? { status: { code: 2 } } : {}),
});
const batch = (...spans: unknown[]) => ({ resourceSpans: [{ resource: { attributes: attr({ 'service.name': 'clinic-bot' }) }, scopeSpans: [{ spans }] }] });

describe('traces as dataset records', () => {
  it('the current conventions: messages as JSON, a tool span, tokens, the model, the time and the conversation', () => {
    const b = batch(
      span('t1', 'chat gpt-4o', {
        'gen_ai.operation.name': 'chat',
        'gen_ai.request.model': 'gpt-4o',
        'gen_ai.conversation.id': 'conv-9',
        'gen_ai.usage.input_tokens': 120,
        'gen_ai.usage.output_tokens': 15,
        'gen_ai.input.messages': JSON.stringify([{ role: 'system', parts: [{ type: 'text', content: 'You are the clinic bot.' }] }, { role: 'user', parts: [{ type: 'text', content: 'When do you open on Saturday?' }] }]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', name: 'opening_hours', arguments: { day: 'saturday' } }] }]),
      }, { start: 0, end: 400 }),
      span('t1', 'execute_tool opening_hours', { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'opening_hours', 'gen_ai.tool.call.arguments': '{"day":"saturday"}' }, { start: 400, end: 450 }),
      span('t1', 'chat gpt-4o', {
        'gen_ai.operation.name': 'chat',
        'gen_ai.response.model': 'gpt-4o-2024-08-06',
        'gen_ai.usage.input_tokens': 160,
        'gen_ai.usage.output_tokens': 12,
        'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'When do you open on Saturday?' }] }]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'text', content: 'We open at 9 on Saturdays.' }] }]),
      }, { start: 450, end: 900 }),
    );
    const r = importOtelTraces([b]);
    expect(r).toMatchObject({ traces: 1, skipped: 0 });
    expect(r.records).toEqual([
      {
        id: 't1',
        question: 'When do you open on Saturday?',
        answer: 'We open at 9 on Saturdays.',
        tool_calls: [{ name: 'opening_hours', arguments: { day: 'saturday' } }],
        system: 'You are the clinic bot.',
        model: 'gpt-4o-2024-08-06',
        conversation_id: 'conv-9',
        latency_ms: 900,
        input_tokens: 280,
        output_tokens: 27,
        tags: ['trace'],
      },
    ]);
    expect(r.notes.join(' ')).toMatch(/1 record: 0 with retrieved documents, 1 with tool calls/);
    expect(r.notes.at(-1)).toMatch(/personal data/);
  });

  it('the older forms: indexed attributes, and one event a message', () => {
    const indexed = span('t2', 'openai.chat', {
      'gen_ai.prompt.0.role': 'user',
      'gen_ai.prompt.0.content': 'Is parking free?',
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': 'Yes, for two hours.',
      'gen_ai.usage.prompt_tokens': 9,
      'gen_ai.usage.completion_tokens': 6,
    });
    const events = span('t3', 'chat', { 'gen_ai.system': 'anthropic' }, {
      events: [
        { name: 'gen_ai.user.message', attributes: { content: 'Do you treat rabbits?' } },
        { name: 'gen_ai.choice', attributes: { message: JSON.stringify({ role: 'assistant', content: 'Yes, we do.' }) } },
      ],
    });
    const r = importOtelTraces([batch(indexed, events)]);
    expect(r.records.map((x) => [x.id, x.question, x.answer])).toEqual([
      ['t2', 'Is parking free?', 'Yes, for two hours.'],
      ['t3', 'Do you treat rabbits?', 'Yes, we do.'],
    ]);
    expect(r.records[0]).toMatchObject({ input_tokens: 9, output_tokens: 6 });
  });

  it('OpenInference: an LLM span, a retriever span with its documents, a tool span; a failed span tags the record', () => {
    const b = batch(
      span('t4', 'retrieve', { 'openinference.span.kind': 'RETRIEVER', 'retrieval.documents.0.document.id': 'hours', 'retrieval.documents.0.document.content': 'Open 8 to 18 on weekdays.', 'retrieval.documents.0.document.score': 0.91, 'retrieval.documents.1.document.content': 'Closed on Sundays.' }, { start: 0, end: 50 }),
      span('t4', 'llm', { 'openinference.span.kind': 'LLM', 'llm.model_name': 'llama3', 'llm.input_messages.0.message.role': 'user', 'llm.input_messages.0.message.content': 'Are you open on Sunday?', 'llm.output_messages.0.message.role': 'assistant', 'llm.output_messages.0.message.content': 'No, we are closed on Sundays.' }, { start: 50, end: 300 }),
      span('t4', 'lookup', { 'openinference.span.kind': 'TOOL', 'tool.name': 'calendar', 'tool.parameters': '{"day":"sunday"}' }, { start: 20, end: 40, error: true }),
    );
    const [rec] = importOtelTraces([b]).records;
    expect(rec).toMatchObject({
      question: 'Are you open on Sunday?',
      answer: 'No, we are closed on Sundays.',
      contexts: [{ id: 'hours', text: 'Open 8 to 18 on weekdays.', score: 0.91 }, { id: 'doc-2', text: 'Closed on Sundays.' }],
      tool_calls: [{ name: 'calendar', arguments: { day: 'sunday' } }],
      model: 'llama3',
      tags: ['trace', 'error'],
    });
  });

  it('a conversation the model was shown is kept as a transcript; only-errors and limit narrow the import', () => {
    const chat = (id: string, error = false) =>
      span(id, 'chat', {
        'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'Hi, I am Ann.' }, { role: 'assistant', content: 'Hello Ann.' }, { role: 'user', content: 'What is my name?' }]),
        'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', content: 'Ann.' }]),
      }, { error });
    const all = importOtelTraces([batch(chat('a'), chat('b', true), chat('c'))]);
    expect(all.records).toHaveLength(3);
    expect(all.records[0]).toMatchObject({ question: 'What is my name?', answer: 'Ann.', turns: [{ role: 'user', content: 'Hi, I am Ann.' }, { role: 'assistant', content: 'Hello Ann.' }, { role: 'user', content: 'What is my name?' }, { role: 'assistant', content: 'Ann.' }] });
    expect(importOtelTraces([batch(chat('a'), chat('b', true), chat('c'))], { onlyErrors: true }).records.map((r) => r.id)).toEqual(['b']);
    expect(importOtelTraces([batch(chat('a'), chat('b', true), chat('c'))], { limit: 2 }).records.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('a trace without recorded messages is skipped, with how to turn them on; an answer made only of tool calls is left out', () => {
    const r = importOtelTraces([
      batch(
        span('x', 'chat gpt-4o', { 'gen_ai.operation.name': 'chat', 'gen_ai.usage.input_tokens': 5 }),
        span('y', 'chat', { 'gen_ai.input.messages': JSON.stringify([{ role: 'user', content: 'Book it' }]), 'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', tool_calls: [{ function: { name: 'book', arguments: '{}' } }] }]) }),
      ),
    ]);
    expect(r).toMatchObject({ traces: 2, skipped: 2, records: [] });
    expect(r.notes[0]).toMatch(/1 trace has no model call with its messages recorded.*OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true/);
    expect(r.notes[1]).toMatch(/1 trace was left out/);
  });

  it('is found by its shape in a file (one object, or one a line) and imported as the format otel', () => {
    const a = batch(span('p', 'chat', { 'gen_ai.prompt': 'What is the fee?', 'gen_ai.completion': 'It is 40.' }));
    const b = batch(span('q', 'chat', { 'gen_ai.prompt': 'And for cats?', 'gen_ai.completion': 'The same.' }));
    const one = parseRagImportText(JSON.stringify(a), 'traces.json');
    expect(detectRagFormat(one)).toBe('otel');
    const lines = parseRagImportText(`${JSON.stringify(a)}\n${JSON.stringify(b)}\n`, 'traces.jsonl');
    const r = importRagRecords(lines);
    expect(r.from).toBe('otel');
    expect(r.records.map((x) => [x.question, x.answer])).toEqual([['What is the fee?', 'It is 40.'], ['And for cats?', 'The same.']]);
  });
});
