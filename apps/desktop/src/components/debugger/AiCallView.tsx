import { useEffect, useState, type ReactNode } from 'react';
import { formatUsd, plural, type AiCall } from '@testpion/shared';
import { call } from '../../api';
import { Badge, Empty } from '../ui';
import { CodeBlock } from '../CodeBlock';
import { JsonTree } from '../JsonView';
import type { Exchange } from './model';

/**
 * The AI call tab (FG-18): what an LLM or MCP exchange says in words. The reading is done on the host (`debug.bodyView`, view `ai`)
 * by the shared reader the CLI and the MCP tool use, so API keys pasted into a prompt or a tool argument are already masked.
 */
const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <div className="grid gap-1">
    <div className="text-xs font-semibold text-muted">{title}</div>
    {children}
  </div>
);

const Text = ({ text }: { text: string }) => <CodeBlock className="p-2 text-xs mono whitespace-pre-wrap break-words rounded border border-line bg-panel max-h-72 overflow-auto" text={text} />;

const tokens = (n?: number) => (n === undefined ? '–' : n.toLocaleString('en-US'));

export function AiCallView({ e }: { e: Exchange }) {
  const [c, setC] = useState<AiCall | null>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    setC(undefined);
    setFailed(undefined);
    void call<{ ok: boolean; data?: AiCall }>('debug.bodyView', { id: e.id, view: 'ai', side: 'request' }).then(
      (x) => live && setC(x.ok && x.data ? x.data : null),
      (err) => live && setFailed((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [e.id, e.responseBodyBytes, e.requestBodyBytes]);
  if (failed) return <Empty title="Could not read the call">{failed}</Empty>;
  if (c === undefined) return <div className="p-3 text-sm text-muted">Reading…</div>;
  if (c === null) return <Empty title="Not an AI call">The address is not an OpenAI, Anthropic, Gemini or Ollama endpoint, and the body is not MCP.</Empty>;
  const u = c.usage;
  return (
    <div className="p-3 grid gap-3 text-sm overflow-auto h-full min-h-0" data-view="ai">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone="accent">{c.provider === 'mcp' ? 'MCP' : c.label.split(' ')[0]}</Badge>
        {c.model && <span className="font-semibold mono">{c.model}</span>}
        <span className="text-xs text-muted">{c.endpoint}</span>
        {c.stream && <Badge>streamed, put back together</Badge>}
        {c.error && <Badge tone="bad">error</Badge>}
      </div>
      {c.error && (
        <div className="rounded border border-bad/40 bg-bad/5 p-2 text-xs text-bad" data-ai-error>
          {c.error}
        </div>
      )}
      {u && (
        <div className="grid grid-cols-[repeat(auto-fit,minmax(8rem,1fr))] gap-2" data-ai-usage>
          {(
            [
              ['Input tokens', tokens(u.inputTokens)],
              ['Output tokens', tokens(u.outputTokens)],
              ...(u.cachedInputTokens ? [['From cache', tokens(u.cachedInputTokens)]] : []),
              ...(u.reasoningTokens ? [['Reasoning', tokens(u.reasoningTokens)]] : []),
              ['Cost (estimate)', c.cost ? formatUsd(c.cost.usd) : 'unknown model'],
            ] as Array<[string, string]>
          ).map(([k, v]) => (
            <div key={k} className="rounded border border-line p-2" title={k === 'Cost (estimate)' ? c.cost?.note : undefined}>
              <div className="text-2xs text-muted">{k}</div>
              <div className="font-semibold">{v}</div>
            </div>
          ))}
        </div>
      )}
      {c.cacheHint && <div className="text-xs text-muted" data-ai-cache>{c.cacheHint}</div>}
      {c.system && (
        <Section title="System prompt">
          <Text text={c.system} />
        </Section>
      )}
      {c.messages.length > 0 && (
        <Section title={plural(c.messages.length, 'message')}>
          <div className="grid gap-1" data-ai-messages>
            {c.messages.map((m, i) => (
              <div key={i} className="grid grid-cols-[5rem_1fr] gap-2 items-start">
                <Badge>{m.role}</Badge>
                <div className="grid gap-1">
                  {m.text && <Text text={m.text} />}
                  {m.toolCalls?.map((t, j) => (
                    <div key={j} className="text-xs mono">
                      calls <b>{t.name}</b> {t.arguments !== undefined && JSON.stringify(t.arguments)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {c.tools.length > 0 && c.provider !== 'mcp' && (
        <Section title={`${plural(c.tools.length, 'tool')} offered to the model`}>
          <div className="flex flex-wrap gap-1">
            {c.tools.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
          </div>
        </Section>
      )}
      {c.output && (
        <Section title={`Answer${c.output.stopReason ? ` (${c.output.stopReason})` : ''}`}>
          {c.output.text ? <Text text={c.output.text} /> : <div className="text-xs text-muted">The model answered with tool calls only.</div>}
          {c.output.toolCalls.map((t, i) => (
            <div key={i} className="rounded border border-line p-2 grid gap-1" data-ai-tool-call>
              <div className="text-xs">
                Calls <b className="mono">{t.name}</b>
              </div>
              {t.arguments !== undefined && (typeof t.arguments === 'object' && t.arguments !== null ? <JsonTree data={t.arguments} /> : <Text text={String(t.arguments)} />)}
            </div>
          ))}
        </Section>
      )}
      {c.mcp && (
        <Section title={`MCP: ${plural(c.mcp.length, 'message')}`}>
          <table className="text-xs w-full border-collapse" data-ai-mcp>
            <thead className="text-muted">
              <tr>
                {['Method', 'Name', 'Arguments', 'Result'].map((h) => (
                  <th key={h} className="text-left font-medium px-2 py-1 border-b border-line">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.mcp.map((m, i) => (
                <tr key={i} className="align-top hover:bg-hover">
                  <td className="px-2 py-1 border-b border-line/60 whitespace-nowrap">{m.method}</td>
                  <td className="px-2 py-1 border-b border-line/60 mono">{m.name ?? ''}</td>
                  <td className="px-2 py-1 border-b border-line/60 mono break-all">{m.arguments === undefined ? '' : JSON.stringify(m.arguments)}</td>
                  <td className={`px-2 py-1 border-b border-line/60 mono break-all ${m.error || m.isError ? 'text-bad' : ''}`}>{m.error ?? m.tools?.join(', ') ?? m.server ?? m.result ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {Object.keys(c.settings).length > 0 && (
        <Section title="Settings">
          <div className="text-xs mono">{Object.entries(c.settings).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(' · ')}</div>
        </Section>
      )}
      {c.notes.map((n) => (
        <div key={n} className="text-xs text-muted">
          {n}
        </div>
      ))}
    </div>
  );
}
