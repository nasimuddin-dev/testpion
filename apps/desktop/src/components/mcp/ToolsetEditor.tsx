import { ArrowDown, ArrowUp, Copy, CopyPlus, FileCode, MoreHorizontal, Play, Plus, Save, Server, Sparkles, Trash2, Wrench } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { McpMockDefinition, McpMockResponse } from '@testpion/core';
import { asError, call } from '../../api';
import { promptText, toastError, useApp } from '../../store';
import { copyText } from '../../lib/clipboard';
import { stringifyYaml } from '../../lib/yaml';
import { CodeBlock } from '../CodeBlock';
import { CodeEditor } from '../CodeEditor';
import { JsonSchemaForm } from '../JsonSchemaForm';
import { ErrorPanel } from '../Results';
import { ResponseSplit } from '../ResponseSplit';
import { Badge, Button, Callout, cx, Empty, Field, IconButton, Input, Menu, Segmented, Select, Split, Toggle, Textarea } from '../ui';
import { ToolResult, type ToolRun } from './ToolsPanel';

/**
 * The Tools tab of a mock MCP server: the toolset an agent will see, designed here. The mock file (`*.mcp-mock.yaml`)
 * stays the source of truth: the form edits its tools, the YAML view edits it raw, Save writes it, Try answers a call
 * from the unsaved definition, and the Serve box has the command lines that serve it to an agent.
 */
type MockTool = NonNullable<McpMockDefinition['tools']>[number];
type Loaded = { exists: boolean; definition: McpMockDefinition; text: string; serve: { stdio: string; http: string; url: string; agentConfig: string } };
type ResponseKind = 'text' | 'json' | 'script' | 'content';

export interface ToolsetEditorHandle {
  dirty: boolean;
  save(): Promise<void>;
}

const kindOf = (r: McpMockResponse): ResponseKind => (r.script !== undefined ? 'script' : r.content ? 'content' : r.json !== undefined ? 'json' : 'text');
const EMPTY_SCHEMA = { type: 'object', properties: {} };
const NEW_TOOL = (): MockTool => ({ name: 'new_tool', description: '', inputSchema: { type: 'object', properties: {}, required: [] }, responses: [{ json: { ok: true } }] });

export const ToolsetEditor = forwardRef<ToolsetEditorHandle, { file: string; serverName: string; connected?: boolean }>(function ToolsetEditor({ file, serverName, connected }, ref) {
  const [loaded, setLoaded] = useState<Loaded>();
  const [loadError, setLoadError] = useState<ReturnType<typeof asError>>();
  const [def, setDef] = useState<McpMockDefinition>({ name: '', tools: [] });
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'form' | 'yaml'>('form');
  const [sel, setSel] = useState(0);
  const [serve, setServe] = useState(false);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const l = await call<Loaded>('mcp.mock.read', { file, name: serverName.replace(/\s*\(mock\)$/i, '') });
      setLoaded(l);
      setDef(l.definition);
      setText(l.text);
      setSel(0);
    } catch (e) {
      setLoadError(asError(e));
    }
  }, [file, serverName]);
  useEffect(() => void load(), [load]);
  const tools = def.tools ?? [];
  const tool = tools[sel];
  const dirty = !!loaded && (!loaded.exists || (mode === 'yaml' ? text !== loaded.text : JSON.stringify(def) !== JSON.stringify(loaded.definition)));
  const update = (next: McpMockDefinition) => setDef(next);
  const setTools = (list: MockTool[]) => update({ ...def, tools: list });
  const patchTool = (i: number, t: Partial<MockTool>) => setTools(tools.map((x, j) => (j === i ? { ...x, ...t } : x)));
  const addTool = () => {
    const names = new Set(tools.map((t) => t.name));
    const t = NEW_TOOL();
    for (let n = 2; names.has(t.name); n++) t.name = `new_tool_${n}`;
    setTools([...tools, t]);
    setSel(tools.length);
  };
  const duplicateTool = (i: number) => {
    const copy = JSON.parse(JSON.stringify(tools[i])) as MockTool;
    copy.name = `${copy.name}_copy`;
    setTools([...tools.slice(0, i + 1), copy, ...tools.slice(i + 1)]);
    setSel(i + 1);
  };
  const deleteTool = (i: number) => {
    setTools(tools.filter((_, j) => j !== i));
    setSel(Math.max(0, Math.min(i, tools.length - 2)));
  };
  const moveTool = (i: number, to: number) => {
    if (to < 0 || to >= tools.length) return;
    const list = [...tools];
    const [t] = list.splice(i, 1);
    list.splice(to, 0, t!);
    setTools(list);
    setSel(to);
  };
  /** Form ⇄ YAML: the form's definition becomes text; text becomes the definition (checked by the backend). */
  const switchMode = async (m: 'form' | 'yaml') => {
    if (m === mode) return;
    if (m === 'yaml') {
      setText(stringifyYaml({ schemaVersion: '1.0', ...def }));
      return setMode('yaml');
    }
    try {
      setDef(await call<McpMockDefinition>('mcp.mock.parse', { text }));
      setSel(0);
      setMode('form');
    } catch (e) {
      toastError(e);
    }
  };
  const save = async () => {
    if (!loaded) return;
    setSaving(true);
    try {
      const r = await call<{ text: string; definition: McpMockDefinition }>('mcp.mock.write', mode === 'yaml' ? { file, text } : { file, definition: def });
      setLoaded({ ...loaded, exists: true, definition: r.definition, text: r.text });
      setDef(r.definition);
      setText(r.text);
      useApp.getState().toast(`Saved ${file}${connected ? '. Reconnect the server to serve the new tools.' : ''}`, 'success');
    } catch (e) {
      toastError(e);
    } finally {
      setSaving(false);
    }
  };
  useImperativeHandle(ref, () => ({ dirty, save }), [dirty, save]);
  /** An assistant task that designs the toolset from a sentence; the answer is loaded into the form for review, not saved. */
  const generate = async () => {
    const job = await promptText('Design a toolset with AI', {
      message: 'What does the agent do? One or two sentences.',
      placeholder: 'e.g. a support agent that looks up orders, issues refunds under $50 and escalates the rest',
      okLabel: 'Design tools',
      detail: tools.length
        ? 'The tools already here are kept; the assistant adds to them. Nothing is saved until you review and press Save.'
        : 'The assistant proposes the tools, which you review before saving.',
    });
    if (!job) return;
    useApp.getState().set({
      assistant: {
        task: 'design-toolset',
        title: 'Design a toolset',
        context: { file, name: def.name, instructions: def.instructions, existingTools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
        question: `${tools.length ? 'Add the tools an agent needs for' : 'Design the tools an agent needs for'}: ${job}`,
        apply: {
          label: 'Review in the Tools tab',
          run: async (code) => {
            let d: McpMockDefinition;
            try {
              d = await call<McpMockDefinition>('mcp.mock.parse', { text: code });
            } catch (e) {
              return `it is not a mock definition: ${asError(e).message}`;
            }
            setDef({ ...def, ...d, name: d.name || def.name });
            setMode('form');
            setSel(0);
            return { done: `${d.tools?.length ?? 0} AI-generated tools loaded: review them, Try one, then Save` };
          },
        },
      },
    });
  };

  if (loadError) return <ErrorPanel error={loadError} context={{ file }} />;
  if (!loaded) return null;
  return (
    <div className="h-full flex flex-col min-h-0" data-toolset={file}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 flex-wrap">
        <Input className="w-48" aria-label="Toolset name" placeholder="Toolset name" value={def.name} onChange={(e) => update({ ...def, name: e.target.value })} disabled={mode === 'yaml'} />
        <Input
          className="flex-1 min-w-40"
          aria-label="Instructions for the agent"
          placeholder="Instructions for the agent (one sentence)"
          value={def.instructions ?? ''}
          onChange={(e) => update({ ...def, instructions: e.target.value || undefined })}
          disabled={mode === 'yaml'}
        />
        <Segmented
          label="Edit as"
          value={mode}
          onChange={(m) => void switchMode(m)}
          options={[
            { value: 'form', label: 'Form', icon: <Wrench size={12} /> },
            { value: 'yaml', label: 'YAML', icon: <FileCode size={12} /> },
          ]}
        />
        <Button
          size="sm"
          icon={<Sparkles size={12} />}
          onClick={() => void generate()}
          data-toolset-generate
          title="Describe the agent's job; the assistant proposes the tools, which you review before saving"
        >
          Generate with AI
        </Button>
        <Button size="sm" icon={<Server size={12} />} onClick={() => setServe((s) => !s)} data-toolset-serve aria-pressed={serve} title="The command lines that serve this toolset to an agent">
          Serve
        </Button>
        <Button
          size="sm"
          variant="primary"
          icon={<Save size={12} />}
          loading={saving}
          disabled={!dirty}
          onClick={() => void save()}
          data-toolset-save
          title={loaded.exists ? `Write ${file}` : `Create ${file}`}
        >
          {loaded.exists ? 'Save' : 'Create file'}
        </Button>
      </div>
      {serve && (
        <Callout block className="m-3 mb-0 rounded-md p-3 text-sm grid gap-2" data-toolset-serve-box="">
          <div className="font-medium">Serve this toolset to an agent</div>
          <ServeLine label="stdio (the command an agent's MCP configuration starts, from the workspace folder)" text={loaded.serve.stdio} what="the command" />
          <ServeLine label={`Streamable HTTP on ${loaded.serve.url}`} text={loaded.serve.http} what="the command" />
          <ServeLine label="Agent configuration (mcpServers)" text={loaded.serve.agentConfig} what="the configuration" block />
          {!loaded.exists && <span className="text-xs text-muted">Create the file first: the commands read it.</span>}
        </Callout>
      )}
      {mode === 'yaml' ? (
        <div className="flex-1 min-h-0">
          <CodeEditor language="yaml" value={text} onChange={setText} path={file} />
        </div>
      ) : (
        <Split id="mcp-toolset" initial={28}>
          <div className="h-full flex flex-col">
            <div className="flex-1 overflow-auto">
              {tools.map((t, i) => (
                <div key={i} className={cx('group flex items-start border-b border-line/60', sel === i ? 'bg-accent/10' : 'hover:bg-hover')}>
                  <button onClick={() => setSel(i)} className="flex-1 min-w-0 text-left px-3 py-2" data-toolset-tool={t.name}>
                    <div className="flex items-center gap-1.5 text-sm font-medium mono truncate">
                      <Wrench size={12} className="text-muted shrink-0" />
                      {t.name || <span className="text-muted">(unnamed)</span>}
                      {t.responses?.some((r) => r.script !== undefined) && <Badge tone="accent">script</Badge>}
                    </div>
                    {t.description && <div className="text-xs text-muted line-clamp-2">{t.description}</div>}
                  </button>
                  <Menu
                    width={180}
                    trigger={
                      <IconButton label={`Actions for ${t.name}`} className="mt-1.5 mr-1 opacity-0 group-hover:opacity-100 focus:opacity-100 data-[state=open]:opacity-100">
                        <MoreHorizontal size={14} />
                      </IconButton>
                    }
                    items={[
                      { label: 'Duplicate', icon: <CopyPlus size={14} />, onSelect: () => duplicateTool(i) },
                      { label: 'Move up', icon: <ArrowUp size={14} />, disabled: i === 0, onSelect: () => moveTool(i, i - 1) },
                      { label: 'Move down', icon: <ArrowDown size={14} />, disabled: i === tools.length - 1, onSelect: () => moveTool(i, i + 1) },
                      { label: 'Delete', icon: <Trash2 size={14} />, danger: true, separator: true, onSelect: () => deleteTool(i) },
                    ]}
                  />
                </div>
              ))}
            </div>
            <div className="p-2 border-t border-line">
              <Button size="sm" className="w-full" icon={<Plus size={12} />} onClick={addTool} data-toolset-add>
                Add tool
              </Button>
            </div>
          </div>
          {tool ? (
            <ToolForm key={sel} tool={tool} index={sel} definition={def} onChange={(t) => patchTool(sel, t)} />
          ) : (
            <Empty
              icon={<Wrench size={26} />}
              title="No tools yet"
              actions={[
                { label: 'Add tool', icon: <Plus size={12} />, onClick: addTool },
                { label: 'Generate with AI', icon: <Sparkles size={12} />, onClick: () => void generate() },
              ]}
            >
              A toolset is what an agent sees: each tool has a name, a description that says when to call it, an input schema, and the answers the mock gives. Design it here, then serve it with the
              CLI before the real server exists.
            </Empty>
          )}
        </Split>
      )}
    </div>
  );
});

/** One command or snippet of the Serve box with its copy button. */
function ServeLine({ label, text, what, block }: { label: string; text: string; what: string; block?: boolean }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="flex-1">{label}</span>
        <IconButton label={`Copy ${what}`} onClick={() => void copyText(text, what)}>
          <Copy size={13} />
        </IconButton>
      </div>
      <CodeBlock className={cx('mono text-xs rounded bg-panel2 px-2 py-1', block ? 'whitespace-pre' : 'whitespace-pre-wrap')} text={text} language={block ? 'json' : 'plain'} data-toolset-command="" />
    </div>
  );
}

/** A JSON value edited as text: the value changes only when the text parses; invalid text stays on screen with a note. */
function JsonValueEditor({ value, onChange, path, height = 160, jsonSchema }: { value: unknown; onChange(v: unknown): void; path: string; height?: number; jsonSchema?: unknown }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [bad, setBad] = useState<string>();
  const last = useRef(JSON.stringify(value ?? {}));
  useEffect(() => {
    // the value changed elsewhere (another tool, the assistant): show it, unless it's what this editor just emitted
    const now = JSON.stringify(value ?? {});
    if (now !== last.current) {
      last.current = now;
      setText(JSON.stringify(value ?? {}, null, 2));
      setBad(undefined);
    }
  }, [value]);
  return (
    <div className="grid gap-1">
      <div className="border border-line rounded-lg overflow-hidden" style={{ height }}>
        <CodeEditor
          language="json"
          value={text}
          path={path}
          jsonSchema={jsonSchema}
          onChange={(t) => {
            setText(t);
            try {
              const v = JSON.parse(t || 'null') as unknown;
              last.current = JSON.stringify(v ?? {});
              setBad(undefined);
              onChange(v);
            } catch (e) {
              setBad((e as Error).message);
            }
          }}
        />
      </div>
      {bad && <span className="text-xs text-bad">Not valid JSON: {bad}</span>}
    </div>
  );
}

/** The form of one tool: name, description, input schema, responses, and Try (the mock's answer to a call, from the unsaved definition). */
function ToolForm({ tool, index, definition, onChange }: { tool: MockTool; index: number; definition: McpMockDefinition; onChange(t: Partial<MockTool>): void }) {
  const responses = tool.responses ?? [];
  const setResponses = (rs: McpMockResponse[]) => onChange({ responses: rs });
  const patchResponse = (i: number, r: McpMockResponse) => setResponses(responses.map((x, j) => (j === i ? r : x)));
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [result, setResult] = useState<ToolRun>();
  const [running, setRunning] = useState(false);
  const tryIt = async () => {
    setRunning(true);
    try {
      setResult(await call<ToolRun>('mcp.mock.call', { definition, tool: tool.name, args }));
    } catch (e) {
      setResult({ error: asError(e) });
    } finally {
      setRunning(false);
    }
  };
  const annotations = tool.annotations ?? {};
  const setAnnotation = (k: string, v: boolean) => {
    const next = { ...annotations };
    if (v) next[k] = true;
    else delete next[k];
    onChange({ annotations: Object.keys(next).length ? next : undefined });
  };
  return (
    <ResponseSplit id="mcp-toolset-try" initialBelow={40}>
      <div className="h-full overflow-auto">
        <div className="max-w-3xl p-4 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name" hint="snake_case; the agent calls it by this name.">
              <Input className="mono" value={tool.name} onChange={(e) => onChange({ name: e.target.value })} data-toolset-name="" />
            </Field>
            <Field label="Title" hint="Optional, for people.">
              <Input value={tool.title ?? ''} onChange={(e) => onChange({ title: e.target.value || undefined })} />
            </Field>
          </div>
          <Field label="Description" hint="What it does and when an agent should call it: this is what the agent reads to choose a tool.">
            <Textarea className="field min-h-16" value={tool.description ?? ''} onChange={(e) => onChange({ description: e.target.value || undefined })} data-toolset-description="" />
          </Field>
          <div className="flex items-center gap-4 text-xs">
            <Toggle label="Read-only hint" checked={annotations.readOnlyHint === true} onChange={(v) => setAnnotation('readOnlyHint', v)} />
            <Toggle label="Destructive hint" checked={annotations.destructiveHint === true} onChange={(v) => setAnnotation('destructiveHint', v)} />
          </div>
          <Field label="Input schema" hint="JSON Schema of the arguments: properties with a type and a description, and required.">
            <JsonValueEditor
              value={tool.inputSchema ?? EMPTY_SCHEMA}
              onChange={(v) => onChange({ inputSchema: (v ?? EMPTY_SCHEMA) as Record<string, unknown> })}
              path={`mcp-toolset/${index}/schema.json`}
              height={180}
            />
          </Field>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-fg/80">Responses</span>
            <span className="text-xs text-muted">The first response whose `when` matches the arguments answers; the one without `when` is the default.</span>
            <Button size="sm" className="ml-auto" icon={<Plus size={12} />} onClick={() => setResponses([...responses, { text: '' }])} data-toolset-add-response>
              Add response
            </Button>
          </div>
          {responses.map((r, i) => (
            <ResponseCard
              key={i}
              r={r}
              index={i}
              path={`mcp-toolset/${index}/response-${i}`}
              onChange={(next) => patchResponse(i, next)}
              onDelete={() => setResponses(responses.filter((_, j) => j !== i))}
            />
          ))}
          {!responses.length && <span className="text-xs text-muted">No responses: the mock echoes the call's arguments.</span>}
        </div>
      </div>
      <div className="h-full flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
          <span className="text-sm font-medium">Try</span>
          <span className="text-xs text-muted">Calls the tool on the definition as edited (not saved).</span>
          <Button size="sm" variant="primary" className="ml-auto" icon={<Play size={12} />} loading={running} onClick={() => void tryIt()} data-toolset-try>
            Try
          </Button>
        </div>
        <Split id="mcp-toolset-result" initial={40}>
          <div className="h-full overflow-auto">
            <JsonSchemaForm schema={(tool.inputSchema ?? EMPTY_SCHEMA) as never} value={args} onChange={setArgs} />
          </div>
          <div className="h-full min-h-0">
            {result ? (
              'error' in result ? (
                <ErrorPanel error={result.error} context={{ tool: tool.name }} />
              ) : (
                <ToolResult r={result} name={tool.name} />
              )
            ) : (
              <Empty title="Try the tool to see the mock's answer" />
            )}
          </div>
        </Split>
      </div>
    </ResponseSplit>
  );
}

const KIND_HINT: Record<ResponseKind, string> = {
  text: "Text; {{args.name}} is replaced by the call's argument, {{$guid}} and other dynamic variables give a fresh value.",
  json: 'A JSON answer (also sent as structured content); {{args.name}} works in its strings.',
  script: 'JavaScript run in the sandbox with `args` in scope: `(args) => result`, or a body with `return`. A string is text; anything else is JSON. No network or files.',
  content: 'Raw MCP content items (text, image …), as recorded from a real server.',
};

/** One response of a tool: its condition, kind (text, JSON, script, raw content), value and error flag. */
function ResponseCard({ r, index, path, onChange, onDelete }: { r: McpMockResponse; index: number; path: string; onChange(r: McpMockResponse): void; onDelete(): void }) {
  const kind = kindOf(r);
  const [conditional, setConditional] = useState(!!r.when);
  const changeKind = (k: ResponseKind) => {
    const base: McpMockResponse = { ...(r.when ? { when: r.when } : {}), ...(r.isError ? { isError: true } : {}) };
    onChange(
      k === 'text'
        ? { ...base, text: r.text ?? '' }
        : k === 'json'
          ? { ...base, json: r.json ?? {} }
          : k === 'script'
            ? { ...base, script: r.script ?? '(args) => ({ ok: true, args })' }
            : { ...base, content: r.content ?? [] },
    );
  };
  return (
    <div className="border border-line rounded-lg p-3 grid gap-2" data-toolset-response={index}>
      <div className="flex items-center gap-2 flex-wrap">
        <Badge tone={r.isError ? 'bad' : 'default'}>{r.when ? 'when' : 'default'}</Badge>
        <Select className="w-32" aria-label="Response kind" value={kind} onChange={(e) => changeKind(e.target.value as ResponseKind)}>
          <option value="text">Text</option>
          <option value="json">JSON</option>
          <option value="script">Script</option>
          <option value="content">Raw content</option>
        </Select>
        <Toggle
          label="Only when arguments match"
          checked={conditional}
          onChange={(v) => {
            setConditional(v);
            const next = { ...r };
            if (v) next.when = r.when ?? {};
            else delete next.when;
            onChange(next);
          }}
        />
        <Toggle label="Tool error (isError)" checked={!!r.isError} onChange={(v) => onChange(v ? { ...r, isError: true } : (({ isError: _e, ...rest }) => rest)(r))} />
        <IconButton label="Delete this response" className="ml-auto" onClick={onDelete}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      {conditional && (
        <Field label="When the arguments contain" hint="A JSON object; every value must equal the call's argument.">
          <JsonValueEditor value={r.when ?? {}} onChange={(v) => onChange({ ...r, when: (v ?? {}) as Record<string, unknown> })} path={`${path}/when.json`} height={80} />
        </Field>
      )}
      <Field label={kind === 'text' ? 'Text' : kind === 'json' ? 'JSON' : kind === 'script' ? 'Script' : 'Content items'} hint={KIND_HINT[kind]}>
        {kind === 'text' ? (
          <Textarea className="field mono min-h-16" value={r.text ?? ''} onChange={(e) => onChange({ ...r, text: e.target.value })} data-toolset-text="" />
        ) : kind === 'script' ? (
          <div className="border border-line rounded-lg overflow-hidden" style={{ height: 140 }}>
            <CodeEditor language="javascript" value={r.script ?? ''} onChange={(script) => onChange({ ...r, script })} path={`${path}/script.js`} />
          </div>
        ) : kind === 'json' ? (
          <JsonValueEditor value={r.json} onChange={(json) => onChange({ ...r, json })} path={`${path}/json.json`} height={140} />
        ) : (
          <JsonValueEditor value={r.content ?? []} onChange={(content) => onChange({ ...r, content: Array.isArray(content) ? content : [] })} path={`${path}/content.json`} height={140} />
        )}
      </Field>
    </div>
  );
}
