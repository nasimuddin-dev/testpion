import { Braces, FileText, MessageSquare } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { asError, call, on, type NormalizedError } from '../../api';
import { toastError } from '../../store';
import { formatMs, plural } from '../../lib/format';
import { JsonTree } from '../JsonView';
import { useSticky } from '../../lib/sticky';
import { ErrorPanel } from '../Results';
import { Badge, Button, cx, Empty, Field, Input, SectionTitle, Split } from '../ui';

/** The MCP view's Resources and Prompts panels: browse, read and fill in what a server offers. */

export interface Tool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}
export interface Discovery {
  serverInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  instructions?: string;
  tools: Tool[];
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  resourceTemplates: Array<{ uriTemplate: string; name: string; description?: string }>;
  prompts: Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
}

/**
 * A text field with the server's suggestions (completion/complete) for a prompt argument or a resource
 * template parameter, fetched as you type.
 */
function CompletingInput({
  serverId,
  completionRef,
  name,
  value,
  context,
  onChange,
  className,
  placeholder,
}: {
  serverId: string;
  completionRef: { type: 'ref/prompt'; name: string } | { type: 'ref/resource'; uri: string };
  name: string;
  value: string;
  context?: Record<string, string>;
  onChange(v: string): void;
  className?: string;
  placeholder?: string;
}) {
  const [values, setValues] = useState<string[]>([]);
  const listId = useMemo(() => `mcp-complete-${Math.random().toString(36).slice(2)}`, []);
  const key = JSON.stringify([completionRef, name, value, context]);
  useEffect(() => {
    const t = setTimeout(() => {
      void call<{ values: string[] }>('mcp.complete', { serverId, ref: completionRef, argument: { name, value }, context }).then(
        (r) => setValues(r.values),
        () => setValues([]),
      );
    }, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, key]);
  return (
    <>
      <Input
        className={className}
        list={listId}
        value={value}
        placeholder={placeholder ?? (values.length ? `e.g. ${values.slice(0, 3).join(', ')}` : undefined)}
        onChange={(e) => onChange(e.target.value)}
        aria-label={name}
      />
      <datalist id={listId}>
        {values.map((v) => (
          <option key={v} value={v} />
        ))}
      </datalist>
    </>
  );
}

/** Parameters of a URI template (RFC 6570 names, operators left out): patient://{id} → ["id"]. */
const templateParams = (t: string) => [...t.matchAll(/\{[+#./;?&]?([^}]+)\}/g)].flatMap((m) => m[1]!.split(',').map((x) => x.replace(/\*$|:\d+$/, '')));
const fillTemplate = (t: string, v: Record<string, string>) =>
  t.replace(/\{[+#./;?&]?([^}]+)\}/g, (_, names: string) =>
    names
      .split(',')
      .map((n) => encodeURIComponent(v[n.replace(/\*$|:\d+$/, '')] ?? ''))
      .join(','),
  );

export function ResourcesPanel({ serverId, disc }: { serverId: string; disc: Discovery }) {
  const [uri, setUri] = useSticky(`mcp:${serverId}:resource`, disc.resources[0]?.uri ?? '');
  const [template, setTemplate] = useState<string>();
  const [params, setParams] = useState<Record<string, string>>({});
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());
  const [updatedAt, setUpdatedAt] = useState<string>();
  const canSubscribe = !!(disc.capabilities as { resources?: { subscribe?: boolean } } | undefined)?.resources?.subscribe;
  const uriRef = useRef(uri);
  uriRef.current = uri;
  useEffect(
    () =>
      on<{ serverId: string; uri: string }>('mcp.resourceUpdated', (e) => {
        if (e.serverId !== serverId || e.uri !== uriRef.current) return;
        setUpdatedAt(new Date().toLocaleTimeString());
        void read(e.uri);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverId],
  );
  const toggleSubscribe = async () => {
    const on_ = subscribed.has(uri);
    try {
      await call(on_ ? 'mcp.unsubscribe' : 'mcp.subscribe', { serverId, uri });
      const next = new Set(subscribed);
      if (on_) next.delete(uri);
      else next.add(uri);
      setSubscribed(next);
    } catch (e) {
      toastError(e);
    }
  };
  const [content, setContent] = useSticky<{ contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>; durationMs: number } | { error: NormalizedError } | undefined>(
    `mcp:${serverId}:resourceContent`,
    undefined,
  );
  const [loading, setLoading] = useState(false);
  const read = async (u = uri) => {
    setLoading(true);
    try {
      setContent(await call('mcp.read', { serverId, uri: u }));
    } catch (e) {
      setContent({ error: asError(e) });
    } finally {
      setLoading(false);
    }
  };
  return (
    <Split id="mcp-res" initial={30}>
      <div className="h-full overflow-auto">
        <SectionTitle>Resources</SectionTitle>
        {disc.resources.map((r) => (
          <button key={r.uri} className={cx('w-full text-left px-3 py-1.5 hover:bg-hover', uri === r.uri && 'bg-accent/10')} onClick={() => (setTemplate(undefined), setUri(r.uri), void read(r.uri))}>
            <div className="text-sm flex items-center gap-1.5">
              <FileText size={12} className="text-muted" /> {r.name}
            </div>
            <div className="text-xs text-muted mono truncate">{r.uri}</div>
          </button>
        ))}
        <SectionTitle>Templates</SectionTitle>
        {disc.resourceTemplates.map((r) => (
          <button
            key={r.uriTemplate}
            className={cx('w-full text-left px-3 py-1.5 hover:bg-hover', template === r.uriTemplate && 'bg-accent/10')}
            onClick={() => (setTemplate(r.uriTemplate), setParams({}), setUri(fillTemplate(r.uriTemplate, {})))}
          >
            <div className="text-sm flex items-center gap-1.5">
              <Braces size={12} className="text-muted" /> {r.name}
            </div>
            <div className="text-xs text-muted mono truncate">{r.uriTemplate}</div>
          </button>
        ))}
      </div>
      <div className="h-full flex flex-col">
        {template && templateParams(template).length > 0 && (
          <div className="flex flex-wrap gap-2 px-2 pt-2 items-center">
            <span className="text-xs text-muted mono">{template}</span>
            {templateParams(template).map((p) => (
              <CompletingInput
                key={p}
                className="w-40 h-7 min-h-7 mono text-xs"
                serverId={serverId}
                completionRef={{ type: 'ref/resource', uri: template }}
                name={p}
                placeholder={p}
                value={params[p] ?? ''}
                context={params}
                onChange={(v) => {
                  const next = { ...params, [p]: v };
                  setParams(next);
                  setUri(fillTemplate(template, next));
                }}
              />
            ))}
          </div>
        )}
        <div className="flex gap-2 p-2 border-b border-line">
          <Input className="flex-1 mono" value={uri} onChange={(e) => (setUri(e.target.value), setTemplate(undefined))} placeholder="resource URI (fill template parameters, e.g. customer://123)" />
          {canSubscribe && (
            <Button
              variant={subscribed.has(uri) ? 'soft' : 'default'}
              title={subscribed.has(uri) ? 'Stop getting updates for this resource' : 'Get told (and re-read) when the server says this resource changed'}
              disabled={!uri}
              onClick={() => void toggleSubscribe()}
            >
              {subscribed.has(uri) ? 'Subscribed' : 'Subscribe'}
            </Button>
          )}
          <Button variant="primary" loading={loading} onClick={() => read()}>
            Read
          </Button>
        </div>
        {subscribed.has(uri) && updatedAt && <div className="px-3 py-1 text-xs text-accent border-b border-line">Updated by the server at {updatedAt}; read again automatically.</div>}
        <div className="flex-1 min-h-0 overflow-auto flex flex-col">
          {content &&
            ('error' in content ? (
              <ErrorPanel error={content.error} />
            ) : (
              content.contents.map((c, i) => {
                let parsed: unknown;
                try {
                  parsed = c.text ? JSON.parse(c.text) : undefined;
                } catch {
                  parsed = undefined;
                }
                // one content item (the usual case) fills the panel; several get a fixed height each
                const single = content.contents.length === 1;
                return (
                  <div key={i} className={cx('border-b border-line', single && 'flex-1 min-h-0 flex flex-col')}>
                    <div className="px-3 py-1 text-xs text-muted">{[c.uri, c.mimeType, formatMs(content.durationMs)].filter(Boolean).join(' · ')}</div>
                    {parsed !== undefined ? (
                      <div className={single ? 'flex-1 min-h-0' : 'h-80'}>
                        <JsonTree data={parsed} />
                      </div>
                    ) : (
                      <pre className="px-3 pb-3 mono text-xs whitespace-pre-wrap">{c.text ?? `<binary ${c.blob?.length ?? 0} base64 chars>`}</pre>
                    )}
                  </div>
                );
              })
            ))}
        </div>
      </div>
    </Split>
  );
}

export function PromptsPanel({ serverId, prompts }: { serverId: string; prompts: Discovery['prompts'] }) {
  const [sel, setSel] = useSticky(`mcp:${serverId}:prompt`, prompts[0]?.name);
  const [args, setArgs] = useSticky<Record<string, string>>(`mcp:${serverId}:promptArgs`, {});
  const [out, setOut] = useSticky<{ messages: unknown[]; description?: string } | { error: NormalizedError } | undefined>(`mcp:${serverId}:promptOut`, undefined);
  const p = prompts.find((x) => x.name === sel);
  return (
    <Split id="mcp-prompts" initial={30}>
      <div className="h-full overflow-auto">
        {prompts.map((x) => (
          <button
            key={x.name}
            className={cx('w-full text-left px-3 py-2 border-b border-line/60', sel === x.name ? 'bg-accent/10' : 'hover:bg-hover')}
            onClick={() => (setSel(x.name), setOut(undefined))}
          >
            <div className="text-sm font-medium flex items-center gap-1.5">
              <MessageSquare size={12} className="text-muted" /> {x.name}
            </div>
            {x.description && <div className="text-xs text-muted">{x.description}</div>}
          </button>
        ))}
        {!prompts.length && <Empty title="No prompts" />}
      </div>
      <div className="h-full flex flex-col">
        {p && (
          <div className="p-3 border-b border-line flex flex-col gap-2">
            {(p.arguments ?? []).map((a) => (
              <Field key={a.name} label={`${a.name}${a.required ? ' *' : ''}`} hint={a.description}>
                <CompletingInput
                  serverId={serverId}
                  completionRef={{ type: 'ref/prompt', name: p.name }}
                  name={a.name}
                  value={args[a.name] ?? ''}
                  context={args}
                  onChange={(v) => setArgs({ ...args, [a.name]: v })}
                />
              </Field>
            ))}
            <div>
              <Button variant="primary" onClick={() => call('mcp.prompt', { serverId, name: p.name, args }).then(setOut, (e) => setOut({ error: asError(e) }))}>
                Get prompt
              </Button>
            </div>
          </div>
        )}
        <div className="flex-1 min-h-0 overflow-auto">
          {!out ? (
            <Empty icon={<MessageSquare size={24} />} title="Get the prompt to see its messages">
              The server fills its template with the arguments above and returns the messages an AI client would send to the model.
            </Empty>
          ) : 'error' in out ? (
            <ErrorPanel error={out.error} />
          ) : (
            <PromptMessages out={out} />
          )}
        </div>
      </div>
    </Split>
  );
}

/** A prompt's messages as a conversation (role and text), with the raw JSON one click away. */
function PromptMessages({ out }: { out: { messages: unknown[]; description?: string } }) {
  const [json, setJson] = useState(false);
  const messages = out.messages as Array<{ role: string; content: { type: string; text?: string; resource?: { uri: string; text?: string } } }>;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm">
        <span className="text-muted">{plural(messages.length, 'message')}</span>
        {out.description && <span className="text-muted truncate">· {out.description}</span>}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setJson(!json)}>
          {json ? 'Messages' : 'JSON'}
        </Button>
      </div>
      {json ? (
        <div className="h-96">
          <JsonTree data={out} />
        </div>
      ) : (
        <div className="p-3 flex flex-col gap-2">
          {messages.map((m, i) => (
            <div key={i} className={cx('rounded-lg border border-line p-3', m.role === 'assistant' ? 'bg-accent-soft/40' : 'bg-panel')}>
              <Badge tone={m.role === 'assistant' ? 'accent' : 'default'}>{m.role}</Badge>
              <pre className="mt-2 text-sm whitespace-pre-wrap font-sans">{m.content?.text ?? m.content?.resource?.text ?? JSON.stringify(m.content, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
