import { Copy, Download, Play, Save, Sparkles, Wrench } from 'lucide-react';
import { useState } from 'react';
import { asError, call, type NormalizedError } from '../../api';
import { confirmAction, promptText, useApp } from '../../store';
import { useSendShortcut } from '../../hooks';
import type { CheckConfig, CheckResult } from '../../types';
import { formatMs } from '../../lib/format';
import { AssertionEditor } from '../AssertionEditor';
import { CodeEditor } from '../CodeEditor';
import { JsonSchemaForm } from '../JsonSchemaForm';
import { JsonTree, RawView } from '../JsonView';
import { Markdown } from '../Markdown';
import { useSticky } from '../../lib/sticky';
import { downloadContent } from '../../lib/files';
import { CheckList, ErrorPanel } from '../Results';
import { Badge, Button, cx, Empty, IconButton, Input, Split, Tabs } from '../ui';
import { ResponseSplit } from '../ResponseSplit';
import { type Tool } from './McpPanels';
import { copyText } from '../../lib/clipboard';

export function ToolsPanel({ serverId, tools }: { serverId: string; tools: Tool[] }) {
  // kept while the app runs: switching tabs, servers or views doesn't lose arguments or results
  const k = `mcp:${serverId}:`;
  const [sel, setSel] = useSticky<string | undefined>(`${k}tool`, tools[0]?.name);
  const [filter, setFilter] = useState('');
  const [args, setArgs] = useSticky<Record<string, Record<string, unknown>>>(`${k}args`, {});
  const [raw, setRaw] = useSticky(`${k}raw`, false);
  // raw JSON arguments and assertions belong to each tool (switching tools shows that tool's own)
  const [rawText, setRawText] = useSticky(`${k}rawText:${sel ?? ''}`, () => JSON.stringify((sel && args[sel]) || {}, null, 2));
  const [assertions, setAssertions] = useSticky<CheckConfig[]>(`${k}assertions:${sel ?? ''}`, [{ type: 'status', expected: 'success' }]);
  const [results, setResults] = useSticky<Record<string, ToolRun>>(`${k}results`, {});
  const result = sel ? results[sel] : undefined;
  const setResult = (r: ToolRun | undefined) => sel && setResults((all) => ({ ...all, [sel]: r! }));
  const [running, setRunning] = useState(false);
  const [sub, setSub] = useSticky<'form' | 'schema' | 'tests'>(`${k}sub`, 'form');
  const tool = tools.find((t) => t.name === sel);
  const value = (sel && args[sel]) || {};
  const exec = async () => {
    if (!tool) return;
    let a = value;
    if (raw) {
      try {
        a = JSON.parse(rawText || '{}');
      } catch (e) {
        return useApp.getState().toast(`Invalid JSON: ${(e as Error).message}`, 'error');
      }
    }
    // required arguments left empty: say which (sending them anyway is useful to test the server's validation)
    const required = ((tool.inputSchema as { required?: string[] } | undefined)?.required ?? []).filter((k) => a[k] === undefined || a[k] === '');
    if (
      required.length &&
      !(await confirmAction({
        title: 'Required arguments are empty',
        message: `${required.join(', ')} ${required.length > 1 ? 'are' : 'is'} required by ${tool.name}.`,
        detail: 'The server will most likely reject the call. Execute anyway to test its validation.',
        confirmLabel: 'Execute anyway',
        tone: 'warning',
      }))
    )
      return;
    setRunning(true);
    try {
      setResult(await call('mcp.call', { serverId, tool: tool.name, args: a, assertions }));
    } catch (e) {
      setResult({ error: asError(e) });
    } finally {
      setRunning(false);
    }
  };
  useSendShortcut('mcp', () => !running && void exec());
  const saveTest = async () => {
    if (!tool) return;
    const name = await promptText('Save as test', { message: 'Test name', value: `${tool.name} works`, okLabel: 'Save' });
    if (!name) return;
    const rel = await call<string>('mcp.saveTest', { serverId, tool: tool.name, args: raw ? JSON.parse(rawText || '{}') : value, assertions, name });
    useApp.getState().toast(`Saved test tests/${rel}`, 'success');
  };
  const destructive = tool?.annotations?.destructiveHint === true;
  return (
    <Split id="mcp-tools" initial={28}>
      <div className="h-full flex flex-col">
        <div className="p-2">
          <Input className="w-full h-7 min-h-7 text-sm" placeholder="Filter tools" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="flex-1 overflow-auto">
          {tools
            .filter((t) => !filter || t.name.toLowerCase().includes(filter.toLowerCase()))
            .map((t) => (
              <button key={t.name} onClick={() => setSel(t.name)} className={cx('w-full text-left px-3 py-2 border-b border-line/60', sel === t.name ? 'bg-accent/10' : 'hover:bg-hover')}>
                <div className="flex items-center gap-1.5 text-sm font-medium mono">
                  <Wrench size={12} className="text-muted" />
                  {t.name}
                  {t.annotations?.destructiveHint === true && <Badge tone="bad">destructive</Badge>}
                </div>
                {t.description && <div className="text-xs text-muted line-clamp-2">{t.description}</div>}
              </button>
            ))}
        </div>
      </div>
      {tool ? (
        <ResponseSplit id="mcp-tool-run" initialBelow={55}>
          <div className="h-full flex flex-col">
            <div className="flex items-center gap-2 px-3 h-10 border-b border-line">
              <span className="font-semibold mono">{tool.name}</span>
              {destructive && <Badge tone="bad">destructive hint</Badge>}
              <label className="ml-auto text-xs flex items-center gap-1 text-muted">
                <input type="checkbox" checked={raw} onChange={(e) => (setRaw(e.target.checked), e.target.checked && setRawText(JSON.stringify(value, null, 2)))} /> Raw JSON
              </label>
              <Button size="sm" variant="ghost" icon={<Sparkles size={12} />} onClick={() =>
                  useApp.getState().set({
                    assistant: {
                      task: 'generate-args',
                      title: `Arguments for ${tool.name}`,
                      context: { tool: tool.name, description: tool.description, inputSchema: tool.inputSchema },
                      apply: {
                        label: 'Use these arguments',
                        run: (code) => {
                          let v: unknown;
                          try {
                            v = JSON.parse(code);
                          } catch {
                            return 'it is not valid JSON';
                          }
                          if (!v || typeof v !== 'object' || Array.isArray(v)) return 'it is not a JSON object';
                          setArgs((a) => ({ ...a, [tool.name]: v as Record<string, unknown> }));
                          setRawText(JSON.stringify(v, null, 2));
                        },
                      },
                    },
                  })
                }
              >
                Generate args
              </Button>
              <Button size="sm" icon={<Save size={12} />} onClick={saveTest}>
                Save as test
              </Button>
              <Button size="sm" variant="primary" icon={<Play size={12} />} loading={running} onClick={async () => (destructive && !(await confirmAction({ title: 'Run a destructive tool', message: 'This tool is marked destructive by the server.', detail: 'It may change or delete data. Run it only if you mean to.', confirmLabel: 'Execute anyway', tone: 'warning' })) ? undefined : exec())}>
                Execute
              </Button>
            </div>
            <Tabs
              value={sub}
              onChange={setSub}
              tabs={[
                { id: 'form', label: 'Arguments' },
                { id: 'schema', label: 'Input schema' },
                { id: 'tests', label: 'Assertions', badge: assertions.length },
              ]}
            />
            <div className="flex-1 min-h-0 overflow-auto">
              {sub === 'form' &&
                (raw ? (
                  <CodeEditor value={rawText} onChange={setRawText} path={`mcp-args/${serverId}/${tool.name}.json`} jsonSchema={tool.inputSchema} />
                ) : (
                  <>
                    {tool.description && <p className="px-3 pt-3 text-sm text-muted">{tool.description}</p>}
                    <JsonSchemaForm schema={tool.inputSchema as never} value={value} onChange={(v) => setArgs({ ...args, [tool.name]: v })} />
                  </>
                ))}
              {sub === 'schema' && <JsonTree data={{ inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}), ...(tool.annotations ? { annotations: tool.annotations } : {}) }} />}
              {sub === 'tests' && <AssertionEditor checks={assertions} onChange={setAssertions} groups={['Response', 'Body']} />}
            </div>
          </div>
          <div className="h-full min-h-0">{result ? 'error' in result ? <ErrorPanel error={result.error} context={{ tool: tool.name }} /> : <ToolResult r={result} name={tool.name} /> : <Empty title="Execute the tool to see its result" />}</div>
        </ResponseSplit>
      ) : (
        <Empty title="This server exposes no tools" />
      )}
    </Split>
  );
}

type ToolRun = { isError: boolean; content: unknown[]; structuredContent?: unknown; durationMs: number; checks: CheckResult[]; body: unknown } | { error: NormalizedError };
type ContentItem = { type: string; text?: string; data?: string; mimeType?: string };
type ViewMode = 'pretty' | 'raw' | 'markdown';

const jsonOf = (text: string | undefined): unknown => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function ToolResult({ r, name }: { r: Extract<ToolRun, { content: unknown[] }>; name: string }) {
  const [tab, setTab] = useState<'content' | 'structured' | 'tests'>(r.checks.some((c) => !c.passed) ? 'tests' : 'content');
  const items = r.content as ContentItem[];
  const text = items.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n\n');
  const looksMarkdown = /(^|\n)(#{1,6} |[-*] |\d+\. |```)|\[[^\]]+\]\([^)]+\)/.test(text) && jsonOf(text) === undefined;
  // display options, like the REST response: Pretty (JSON as a tree), Raw, Markdown (rendered)
  const [mode, setMode] = useSticky<ViewMode>('mcp:resultMode', 'pretty');
  const effective: ViewMode = mode === 'markdown' && !text ? 'pretty' : mode;
  const copy = () => void copyText(text || JSON.stringify(r.content, null, 2), 'the result');
  const save = () => downloadContent(`${name}-result.${jsonOf(text) !== undefined ? 'json' : looksMarkdown ? 'md' : 'txt'}`, text || JSON.stringify(r.content, null, 2));
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm">
        <Badge tone={r.isError ? 'bad' : 'ok'}>{r.isError ? 'isError' : 'success'}</Badge>
        <span className="text-muted">{formatMs(r.durationMs)}</span>
        {text && <span className="text-muted">{text.length.toLocaleString()} chars</span>}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex rounded-md border border-line overflow-hidden text-xs" role="group" aria-label="Display">
            {(['pretty', 'raw', 'markdown'] as const).map((m) => (
              <button key={m} type="button" className={cx('px-2 py-0.5 capitalize', effective === m ? 'bg-accent-soft text-fg' : 'text-muted hover:text-fg', m === 'markdown' && !text && 'opacity-40 pointer-events-none')} onClick={() => (setMode(m), setTab('content'))}>
                {m}
              </button>
            ))}
          </div>
          <IconButton label="Copy result" onClick={copy}>
            <Copy size={13} />
          </IconButton>
          <IconButton label="Save result" onClick={save}>
            <Download size={13} />
          </IconButton>
        </div>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'content', label: 'Content', badge: r.content.length },
          ...(r.structuredContent !== undefined ? [{ id: 'structured' as const, label: 'Structured' }] : []),
          { id: 'tests', label: 'Assertions', badge: r.checks.length },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        {tab === 'content' && effective === 'raw' && <RawView text={text || JSON.stringify(r.content, null, 2)} />}
        {tab === 'content' && effective === 'markdown' && <Markdown className="p-4" source={text} />}
        {tab === 'content' &&
          effective === 'pretty' &&
          items.map((c, i) => {
            let parsed: unknown;
            if (c.type === 'text' && c.text) {
              try {
                parsed = JSON.parse(c.text);
              } catch {
                parsed = undefined;
              }
            }
            // a single content block (the usual case) fills the panel
            const single = items.length === 1;
            return (
              <div key={i} className={cx('border-b border-line', single && 'flex-1 min-h-0 flex flex-col')}>
                <div className="px-3 py-1 text-xs text-muted">
                  {c.type}
                  {c.mimeType ? ` · ${c.mimeType}` : ''}
                </div>
                {c.type === 'image' && c.data ? (
                  <img alt="tool output" className="max-w-full p-3" src={`data:${c.mimeType};base64,${c.data}`} />
                ) : parsed !== undefined ? (
                  <div className={single ? 'flex-1 min-h-0' : 'h-64'}>
                    <JsonTree data={parsed} />
                  </div>
                ) : (
                  <pre className="px-3 pb-3 mono text-xs whitespace-pre-wrap">{c.text ?? JSON.stringify(c, null, 2)}</pre>
                )}
              </div>
            );
          })}
        {tab === 'structured' && <JsonTree data={r.structuredContent} />}
        {tab === 'tests' && <CheckList checks={r.checks} />}
      </div>
    </div>
  );
}
