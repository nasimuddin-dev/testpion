/** The request editor: params, auth, headers, body, cookies, scripts, tests, examples, docs and settings. */
import { editorLanguageOfText } from '../../data-languages';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../store';
import type { BodyConfig, HttpRequestSpec, KeyValue, SavedExample } from '../../types';
import { ExamplesPanel } from '../../components/ExamplesPanel';
import { Markdown } from '../../components/Markdown';
import { ScriptsPanel } from '../../components/ScriptsPanel';
import type { ScriptAiContext } from '../../components/ai/script-ai';

import { AssertionEditor } from '../../components/AssertionEditor';
import { AuthEditor } from '../../components/AuthEditor';
import { CodeEditor } from '../../components/CodeEditor';
import { call } from '../../api';
import { COMMON_HEADERS, HEADER_VALUES, KeyValueEditor } from '../../components/KeyValueEditor';
import { LinkButton, Field, Input, Tabs, Textarea } from '../../components/ui';
import { RequestSettings } from '../../components/RequestSettings';
import { RestTab } from './types';
import { switchBodyType, type BodyStash } from '../../lib/body';

export function RequestEditor({
  tab,
  update,
  setReq,
  setParams,
  setExamples,
  scriptAi,
  onSend,
  onSave,
}: {
  /** Send the request, and save it (to a collection when it is not in one): the Examples tab's empty state offers them. */
  onSend?(): void;
  onSave?(): void;
  tab: RestTab;
  update(p: Partial<RestTab>): void;
  setReq(p: Partial<HttpRequestSpec>): void;
  setParams(p: KeyValue[]): void;
  setExamples(e: SavedExample[]): void;
  /** What the script editor's AI menu knows about this request (RestView builds it). */
  scriptAi?: ScriptAiContext;
}) {
  const [sub, setSub] = useState<'params' | 'auth' | 'headers' | 'body' | 'cookies' | 'scripts' | 'tests' | 'examples' | 'docs' | 'settings'>('params');
  const r = tab.request;
  const count = (a?: Array<{ enabled?: boolean }>) => a?.filter((x) => x.enabled !== false).length || undefined;
  return (
    <div className="h-full flex flex-col min-h-0">
      <Tabs label="Request"
        value={sub}
        onChange={setSub}
        tabs={[
          { id: 'params', label: 'Params', badge: count(r.params) },
          { id: 'auth', label: 'Authorization' },
          { id: 'headers', label: 'Headers', badge: count(r.headers) },
          { id: 'body', label: 'Body', badge: r.body && r.body.type !== 'none' ? r.body.type : undefined },
          { id: 'cookies', label: 'Cookies', badge: count(r.cookies) },
          { id: 'scripts', label: 'Scripts', badge: (tab.preRequestScript ? 1 : 0) + (tab.testScript ? 1 : 0) || undefined },
          { id: 'tests', label: 'Tests', badge: tab.assertions.length || undefined },
          { id: 'examples', label: 'Examples', badge: tab.examples?.length || undefined },
          { id: 'docs', label: 'Docs', badge: tab.description?.trim() ? '•' : undefined },
          { id: 'settings', label: 'Settings' },
        ]}
      />
      <div className="flex-1 min-h-0 overflow-auto">
        {sub === 'params' && (
          <div className="p-2">
            <div className="text-xs font-semibold text-muted px-1 pb-1">Query params</div>
            <KeyValueEditor rows={r.params ?? []} onChange={setParams} keyPlaceholder="Key" bulkEdit />
            {!!r.pathVariables?.length && (
              <>
                <div className="text-xs font-semibold text-muted px-1 pt-4 pb-1">Path variables</div>
                <KeyValueEditor rows={r.pathVariables} onChange={(pathVariables) => setReq({ pathVariables: pathVariables.filter((v) => r.pathVariables!.some((x) => x.key === v.key)) })} keyPlaceholder="Key" fixedKeys />
              </>
            )}
            <p className="text-xs text-muted px-2 pt-3">
              The query string in the URL bar and this table stay in sync. Use <span className="mono">/:name</span> in the path for path variables. Values may use {'{{variables}}'}.
            </p>
          </div>
        )}
        {sub === 'auth' && <AuthEditor auth={r.auth} onChange={(auth) => setReq({ auth })} />}
        {sub === 'headers' && (
          <div className="p-2">
            <KeyValueEditor rows={r.headers ?? []} onChange={(headers) => setReq({ headers })} keyPlaceholder="Header" suggestions={COMMON_HEADERS} valueSuggestions={HEADER_VALUES} />
          </div>
        )}
        {sub === 'body' && <BodyEditor stashKey={tab.id} body={r.body ?? { type: 'none' }} onChange={(body) => setReq({ body })} method={r.method} url={r.url} />}
        {sub === 'cookies' && (
          <div className="p-2">
            <KeyValueEditor rows={r.cookies ?? []} onChange={(cookies) => setReq({ cookies })} keyPlaceholder="Cookie" />
            <p className="text-xs text-muted px-1 pt-2">
              Matching cookies from the workspace cookie jar are added automatically; cookies here win when the name is the same. Use the cookie button next to Send to see or edit the jar.
            </p>
          </div>
        )}
        {sub === 'scripts' && <ScriptsPanel pre={tab.preRequestScript ?? ''} post={tab.testScript ?? ''} onPre={(v) => update({ preRequestScript: v })} onPost={(v) => update({ testScript: v })} ai={scriptAi} />}
        {sub === 'docs' && <DocsEditor value={tab.description ?? ''} onChange={(description) => update({ description })} />}
        {sub === 'examples' && <ExamplesPanel key={tab.id} collectionId={tab.collectionId} requestId={tab.requestId} examples={tab.examples ?? []} onChange={setExamples} onSend={onSend} onSave={onSave} />}
        {sub === 'tests' && <AssertionEditor checks={tab.assertions} onChange={(assertions) => update({ assertions })} groups={['Response', 'Body']} />}
        {sub === 'settings' && <RequestSettings settings={r.settings ?? {}} onChange={(settings) => setReq({ settings })} />}
      </div>
    </div>
  );
}

/** Pretty-print JSON (keeping {{variables}} intact) or indent XML. */
export function beautify(text: string, type: string): string {
  if (type === 'json') {
    // protect unquoted {{vars}} so the JSON parses, then restore them
    const vars: string[] = [];
    const safe = text.replace(/\{\{[^{}]+\}\}/g, (m) => `"__VAR${vars.push(m) - 1}__"`);
    try {
      return JSON.stringify(JSON.parse(safe), null, 2).replace(/"__VAR(\d+)__"/g, (_, i) => vars[Number(i)]!);
    } catch {
      useApp.getState().toast('The body is not valid JSON', 'error');
      return text;
    }
  }
  let depth = 0;
  return text
    .replace(/>\s*</g, '>\n<')
    .split('\n')
    .map((line) => {
      const l = line.trim();
      if (/^<\//.test(l)) depth = Math.max(0, depth - 1);
      const out = '  '.repeat(depth) + l;
      if (/^<[^!?/][^>]*[^/]>$/.test(l) && !/<\/[^>]+>$/.test(l)) depth++;
      return out;
    })
    .join('\n');
}

/**
 * What each body type held, per request tab, so switching type and back (JSON → None → JSON, or to a form
 * and back) restores it, as in Postman. Kept for the session; only the selected type is saved.
 */
const bodyStash = new Map<string, BodyStash>();
function BodyEditor({ body, onChange, stashKey = 'default', method, url }: { body: BodyConfig; onChange(b: BodyConfig): void; stashKey?: string; method?: string; url?: string }) {
  // the schema of the body from the API definition the request belongs to (specs/): completion and checks in the editor
  const environment = useApp((s) => s.environment);
  const [spec, setSpec] = useState<{ schema: unknown; spec: string; path: string; summary?: string } | null>(null);
  useEffect(() => {
    if (body.type !== 'json' || !url || !method) return setSpec(null);
    let live = true;
    const t = setTimeout(() => {
      void call<{ schema: unknown; spec: string; path: string; summary?: string } | null>('openapi.bodySchema', { method, url, environment })
        .then((r) => live && setSpec(r))
        .catch(() => live && setSpec(null));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [body.type, method, url, environment]);
  // a body typed as text that is really JSON or XML: offer the right editor (completion, checks, beautify)
  const looksLike = useMemo((): 'json' | 'xml' | 'html' | undefined => {
    if (body.type !== 'text' || !('content' in body) || !body.content.trim()) return undefined;
    const t = body.content.trim();
    if (/^[{[]/.test(t)) {
      try {
        JSON.parse(t);
        return 'json';
      } catch {
        return undefined;
      }
    }
    if (/^<\?xml|^<[a-zA-Z][\w:-]*[\s>]/.test(t)) return /<html|<!doctype html/i.test(t) ? 'html' : 'xml';
    return undefined;
  }, [body]);
  const types: Array<[BodyConfig['type'], string]> = [
    ['none', 'None'],
    ['json', 'JSON'],
    ['xml', 'XML'],
    ['text', 'Text'],
    ['html', 'HTML'],
    ['form-urlencoded', 'Form URL-encoded'],
    ['multipart', 'Multipart form'],
    ['binary', 'Binary file'],
  ];
  const setType = (t: BodyConfig['type']) => {
    if (t === body.type) return;
    let stash = bodyStash.get(stashKey);
    if (!stash) bodyStash.set(stashKey, (stash = { byType: {} }));
    onChange(switchBodyType(body, t, stash));
  };
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex gap-3 px-3 py-1.5 text-sm flex-wrap items-center border-b border-line">
        {(body.type === 'json' || body.type === 'xml') && (
          <LinkButton className="order-last ml-auto text-xs" onClick={() => onChange({ ...body, content: beautify(body.content, body.type) })}>
            Beautify
          </LinkButton>
        )}
        {types.map(([t, label]) => (
          <label key={t} className="flex items-center gap-1 cursor-pointer">
            <input type="radio" name="body-type" checked={body.type === t} onChange={() => setType(t)} />
            {label}
          </label>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {body.type === 'none' && <div className="p-4 text-sm text-muted">This request has no body.</div>}
        {looksLike && (
          <div className="px-3 py-1 text-xs text-muted border-b border-line flex items-center gap-2">
            This looks like {looksLike.toUpperCase()}.
            <LinkButton  onClick={() => setType(looksLike)}>
              Edit it as {looksLike.toUpperCase()}
            </LinkButton>
          </div>
        )}
        {'content' in body && (
          <div className="h-full flex flex-col min-h-0">
            {spec && body.type === 'json' && (
              <div className="px-3 py-1 text-xs text-muted border-b border-line truncate" title={`The editor completes and checks the body against this operation's schema (${spec.spec})`}>
                Schema from <b>{spec.spec}</b> · {spec.path}
                {spec.summary ? ` · ${spec.summary}` : ''}
              </div>
            )}
            <div className="flex-1 min-h-0">
              <CodeEditor
                language={body.type === 'json' ? 'json' : body.type === 'xml' ? 'xml' : body.type === 'html' ? 'html' : editorLanguageOfText(body.content)}
                value={body.content}
                onChange={(content) => onChange({ ...body, content })}
                path={body.type === 'json' ? `body/${stashKey}.json` : undefined}
                jsonSchema={body.type === 'json' && spec ? spec.schema : undefined}
              />
            </div>
          </div>
        )}
        {(body.type === 'form-urlencoded' || body.type === 'multipart') && (
          <div className="p-2 overflow-auto h-full">
            <KeyValueEditor rows={body.fields} onChange={(fields) => onChange({ ...body, fields })} keyPlaceholder="Field" allowFile={body.type === 'multipart'} />
          </div>
        )}
        {body.type === 'binary' && (
          <div className="p-4 flex flex-col gap-3 max-w-xl">
            <Field label="File path" hint="The file is streamed from disk when the request is sent.">
              <Input className="mono" value={body.filePath} onChange={(e) => onChange({ ...body, filePath: e.target.value })} />
            </Field>
            <Field label="Content-Type">
              <Input value={body.contentType ?? ''} placeholder="application/octet-stream" onChange={(e) => onChange({ ...body, contentType: e.target.value || undefined })} />
            </Field>
          </div>
        )}
      </div>
    </div>
  );
}

/** Request documentation: Markdown source and a live preview side by side. */
function DocsEditor({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <div className="h-full grid grid-cols-2 gap-3 p-2 min-h-0">
      <Textarea autoGrow={false}
        className="field h-full resize-none mono text-sm"
        placeholder={'Document this request in Markdown: what it does, required parameters, error cases…'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Request documentation (Markdown)"
      />
      <div className="overflow-auto border border-line rounded-md p-3">
        {value.trim() ? <Markdown source={value} /> : <p className="text-sm text-muted">The preview appears here. The collection’s Docs tab shows the documentation of every request.</p>}
      </div>
    </div>
  );
}
