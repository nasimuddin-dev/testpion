import { ChevronDown, ChevronRight } from 'lucide-react';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import { aiLabelOf, bodyViewsOf, bytesOfBase64, formatBytes, plural, graphqlOf, imageFacts, looksLikeGraphql, parseForm, parseXml, svgFacts, syntaxLanguageOf, type BodyViewId, type XmlNode } from '@testpion/shared';
import { call } from '../../api';
import { Badge, Empty } from '../ui';
import { trafficKindLabel } from '../../lib/traffic-kinds';
import { CodeBlock } from '../CodeBlock';
import { JsonTree, RawView } from '../JsonView';
import type { Exchange } from './model';
import { AiCallView } from './AiCallView';

/**
 * The content-aware views of a body (FG-8, FG-19, FG-20): the tabs that fit what the body is. Which ones is decided by the
 * shared `bodyViewsOf` (the CLI and the MCP tool read the same); text formats are read here from the masked body, binary
 * protocols are decoded on the host (`debug.bodyView`) where the masking applies to what was read out.
 */
export interface ViewTab {
  id: string;
  label: string;
  badge?: string | number;
  render(): ReactNode;
}

const TAB_NAME: Record<BodyViewId, string> = {
  image: 'Image',
  xml: 'XML',
  html: 'Preview',
  form: 'Form',
  graphql: trafficKindLabel('graphql'),
  ai: 'AI call',
  msgpack: 'MessagePack',
  protobuf: 'Protobuf',
  signalr: 'SignalR',
  socketio: 'Socket.IO',
  syntax: 'Syntax',
};

const cell = 'px-2 py-1 border-b border-line/60';

/** What `debug.bodyView` returns for a GraphQL call (the shared reader's shape). */
type GraphqlViewData = NonNullable<ReturnType<typeof graphqlOf>>;

function Table({ head, rows, name }: { head: string[]; rows: ReactNode[][]; name: string }) {
  return (
    <table className="text-xs w-full border-collapse" data-view-table={name}>
      <thead className="sticky top-0 bg-panel text-muted">
        <tr>
          {head.map((h) => (
            <th key={h} className="text-left font-medium px-2 py-1 border-b border-line">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="hover:bg-hover">
            {r.map((c, j) => (
              <td key={j} className={`${cell} ${j === 0 ? 'whitespace-nowrap align-top' : 'mono break-all'}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The views that fit one side of an exchange, as tabs. Cheap: reads the content type and the first characters. */
export function bodyViewTabs(e: Exchange, side: 'request' | 'response'): ViewTab[] {
  const text = side === 'request' ? e.requestBody : e.responseBody;
  const ct = side === 'request' ? e.requestHeaders['content-type'] : e.contentType;
  if (e.kind === 'tunnel') return [];
  const gql = looksLikeGraphql({ url: e.url, requestContentType: e.requestHeaders['content-type'], requestBody: e.requestBody });
  const views = bodyViewsOf({ contentType: ct, url: e.url, text, graphql: gql && graphqlOf({ method: e.method, url: e.url, requestContentType: e.requestHeaders['content-type'], requestBody: e.requestBody, responseBody: e.responseBody }) !== undefined, ai: aiLabelOf({ url: e.url, requestHeaders: e.requestHeaders, requestBody: e.requestBody }) !== undefined });
  return views.map((v) => ({
    id: `view-${v}`,
    label: TAB_NAME[v],
    render: () => <ViewBody e={e} side={side} view={v} />,
  }));
}

function ViewBody({ e, side, view }: { e: Exchange; side: 'request' | 'response'; view: BodyViewId }) {
  const text = side === 'request' ? e.requestBody : e.responseBody;
  const ct = side === 'request' ? e.requestHeaders['content-type'] : e.contentType;
  const note = (side === 'request' ? e.requestBodyTruncated : e.responseBodyTruncated) ? 'The capture kept only the first part of this body, so the view may end early.' : undefined;
  switch (view) {
    case 'image':
      return <ImageView e={e} text={text} contentType={ct} />;
    case 'xml':
      return <XmlTree text={text} note={note} />;
    case 'html':
      return <HtmlPreview text={text} note={note} />;
    case 'form':
      return <FormView text={text} contentType={ct} />;
    case 'graphql':
      return <GraphqlView e={e} side={side} />;
    case 'ai':
      return <AiCallView e={e} />;
    case 'syntax':
      return text ? <RawView text={text} language={syntaxLanguageOf(ct, e.url)} /> : <NotKept side={side} />;
    default:
      return <DecodedView e={e} side={side} view={view} />;
  }
}

function NotKept({ side }: { side: string }) {
  return (
    <Empty title="Body not kept">
      The {side} body is empty, larger than the capture keeps, or was let go to save memory. Capture it again to see this view.
    </Empty>
  );
}

/* ---------------------------------------------------------------- image */

/** The image, with its format, dimensions and size. A raster image is drawn from the bytes the capture kept; an SVG is drawn as an image (nothing in it runs). */
const ImageView = memo(function ImageView({ e, text, contentType }: { e: Exchange; text?: string; contentType?: string }) {
  const view = useMemo(() => {
    if (e.responseBodyBase64) {
      const bytes = bytesOfBase64(e.responseBodyBase64);
      const facts = bytes ? imageFacts(bytes, e.responseBodyBytes) : undefined;
      return facts ? { src: `data:image/${facts.format === 'ico' ? 'x-icon' : facts.format};base64,${e.responseBodyBase64}`, facts } : undefined;
    }
    if (text && /<svg[\s>]/i.test(text)) return { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`, facts: svgFacts(text, e.responseBodyBytes) };
    return undefined;
  }, [e.responseBodyBase64, e.responseBodyBytes, text]);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [view?.src]);
  if (!view) return <Empty title="Image not kept">The capture keeps images up to its body limit. This one ({contentType ?? 'image'}, {formatBytes(e.responseBodyBytes)}) is larger, or was let go to save memory.</Empty>;
  const f = view.facts;
  return (
    <div className="h-full flex flex-col min-h-0" data-view="image">
      <div className="px-3 py-1.5 text-xs flex gap-2 items-center border-b border-line shrink-0 flex-wrap">
        <Badge>{f.format.toUpperCase()}</Badge>
        {f.width && f.height ? <span className="mono" data-image-size>{f.width} × {f.height} px</span> : <span className="text-muted">size in pixels unknown</span>}
        <span className="text-muted">{formatBytes(f.bytes)}</span>
        {f.note && <span className="text-warn">{f.note}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto p-3 grid place-items-start" style={{ backgroundImage: 'conic-gradient(color-mix(in srgb, currentColor 14%, transparent) 25%, transparent 0 50%, color-mix(in srgb, currentColor 14%, transparent) 0 75%, transparent 0)', backgroundSize: '16px 16px' }}>
        {broken ? (
          <div className="bg-panel rounded p-3 text-sm text-bad">The bytes do not draw as {f.format}: the file may be cut short or damaged.</div>
        ) : (
          <img src={view.src} alt={`Response body as ${f.format}`} className="max-w-full h-auto" onError={() => setBroken(true)} />
        )}
      </div>
    </div>
  );
});

/* ---------------------------------------------------------------- XML */

function XmlNodeRow({ n, depth }: { n: XmlNode; depth: number }) {
  const kids = n.children ?? [];
  const [open, setOpen] = useState(depth < 3);
  if (n.name === '#text') return <div className="pl-5 mono text-xs break-all" style={{ paddingLeft: depth * 14 + 20 }}>{n.text}</div>;
  if (n.name === '#comment') return <div className="mono text-xs text-muted break-all" style={{ paddingLeft: depth * 14 + 20 }}>{`<!-- ${n.text} -->`}</div>;
  if (n.name === '#cdata') return <div className="mono text-xs break-all" style={{ paddingLeft: depth * 14 + 20 }}>{`<![CDATA[${n.text}]]>`}</div>;
  const onlyText = kids.length === 1 && kids[0]!.name === '#text';
  return (
    <div>
      <div className="flex items-start gap-1 text-xs mono hover:bg-hover" style={{ paddingLeft: depth * 14 + 4 }}>
        {kids.length && !onlyText ? (
          <button type="button" className="shrink-0 mt-0.5 text-muted" aria-label={open ? `Collapse ${n.name}` : `Expand ${n.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="break-all">
          <span className="syn-tag">{n.name}</span>
          {(n.attrs ?? []).map(([k, v]) => (
            <span key={k}>
              {' '}
              <span className="syn-attr">{k}</span>=<span className="syn-string">"{v}"</span>
            </span>
          ))}
          {onlyText && <span className="ml-2">{kids[0]!.text}</span>}
          {!open && kids.length > 0 && !onlyText && <span className="text-muted"> … {kids.length}</span>}
        </span>
      </div>
      {open && !onlyText && kids.map((c, i) => <XmlNodeRow key={i} n={c} depth={depth + 1} />)}
    </div>
  );
}

/** XML as a tree you can fold: elements, attributes, text, comments. Entities declared in a DOCTYPE are never expanded. */
function XmlTree({ text, note }: { text?: string; note?: string }) {
  const r = useMemo(() => (text ? parseXml(text) : undefined), [text]);
  if (!text) return <NotKept side="response" />;
  if (!r?.root) return <Empty title="Not XML">{r?.error ?? 'The body does not parse as XML.'} The Content tab shows it as text.</Empty>;
  return (
    <div className="h-full flex flex-col min-h-0" data-view="xml">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-line shrink-0">
        {plural(r.elements, 'element')}
        {r.error && <span className="text-warn"> · {r.error}</span>}
        {note && <span className="text-warn"> · {note}</span>}
      </div>
      <div className="flex-1 min-h-0 overflow-auto py-1">
        <XmlNodeRow n={r.root} depth={0} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- HTML */

/** What the preview may do: nothing runs, nothing loads from the network, a link goes nowhere. */
const PREVIEW_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

export function previewDocument(html: string): string {
  // the policy comes first, so a policy of the page itself can only narrow it further; a link opens nowhere (no popups in the sandbox)
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><base target="_blank">${html}`;
}

/** The page drawn in a sandboxed frame: scripts off (sandbox with no permissions), no network (Content-Security-Policy), links inert. */
function HtmlPreview({ text, note }: { text?: string; note?: string }) {
  const doc = useMemo(() => (text ? previewDocument(text) : undefined), [text]);
  if (!doc) return <NotKept side="response" />;
  return (
    <div className="h-full flex flex-col min-h-0" data-view="html">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-line shrink-0">
        A picture of the page: scripts, forms and network loads are switched off, so styles and images from the web do not show. {note}
      </div>
      <iframe title="Preview of the response" sandbox="" referrerPolicy="no-referrer" srcDoc={doc} className="flex-1 min-h-0 w-full bg-white" data-html-preview />
    </div>
  );
}

/* ---------------------------------------------------------------- form and multipart */

function FormView({ text, contentType }: { text?: string; contentType?: string }) {
  const r = useMemo(() => (text !== undefined ? parseForm(contentType, text) : undefined), [text, contentType]);
  if (text === undefined) return <NotKept side="request" />;
  if (!r) return <Empty title="Not a form">The content type is not application/x-www-form-urlencoded or multipart/form-data, so there are no fields to list.</Empty>;
  if (!r.parts.length) return <Empty title="No fields">The form body is empty.</Empty>;
  return (
    <div data-view="form">
      <div className="px-3 py-1.5 text-xs text-muted border-b border-line">
        {r.kind === 'multipart' ? 'Multipart form' : 'URL-encoded form'}: {plural(r.parts.length, r.kind === 'multipart' ? 'part' : 'field')}
        {r.truncated && ' (the first 500 are listed)'}
      </div>
      {r.kind === 'multipart' ? (
        <Table
          name="multipart"
          head={['Name', 'File', 'Type', 'Size', 'Value']}
          rows={r.parts.map((p) => [p.name, p.filename ?? '', p.contentType ?? '', formatBytes(p.size), p.value ?? (p.filename ? '(file content is not shown)' : '')])}
        />
      ) : (
        <Table name="urlencoded" head={['Field', 'Value']} rows={r.parts.map((p) => [p.name, p.value ?? ''])} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- GraphQL */

/** The operation, its formatted query and variables, and the errors the response carried: read on the host, so a variable named like a secret is masked. */
function GraphqlView({ e, side }: { e: Exchange; side: 'request' | 'response' }) {
  const [g, setG] = useState<GraphqlViewData | null>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    setG(undefined);
    setFailed(undefined);
    void call<{ ok: boolean; data?: GraphqlViewData }>('debug.bodyView', { id: e.id, view: 'graphql', side: 'request' }).then(
      (x) => live && setG(x.ok && x.data ? x.data : null),
      (err) => live && setFailed((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [e.id, e.responseBodyBytes, e.requestBodyBytes]);
  if (failed) return <Empty title="Could not read the call">{failed}</Empty>;
  if (g === undefined) return <div className="p-3 text-sm text-muted">Reading…</div>;
  if (g === null) return <Empty title="Not a GraphQL call">The request has no "query" to read.</Empty>;
  return (
    <div className="p-3 grid gap-3 text-sm overflow-auto" data-view="graphql">
      {g.errors.length > 0 && (
        <div className="rounded border border-bad/40 bg-bad/5 p-2 grid gap-1" data-graphql-errors>
          <div className="font-semibold text-bad">
            {plural(g.errors.length, 'error')} in the response{g.partial ? ' (some data came back too)' : ''}
          </div>
          {g.errors.map((x, i) => (
            <div key={i} className="text-xs">
              <span className="font-medium">{x.message}</span>
              {x.path && <span className="text-muted"> · at {x.path}</span>}
              {x.line !== undefined && <span className="text-muted"> · line {x.line}{x.column !== undefined ? `, column ${x.column}` : ''}</span>}
              {x.code && <span className="ml-1"><Badge tone="bad">{x.code}</Badge></span>}
            </div>
          ))}
        </div>
      )}
      {side === 'response' && g.errors.length === 0 && g.hasData !== undefined && <div className="text-xs text-muted">{g.hasData ? 'The response has data and no errors.' : 'The response has no data.'}</div>}
      {g.operations.map((o, i) => (
        <div key={i} className="grid gap-2">
          <div className="flex items-center gap-2">
            <Badge tone="accent">{o.type}</Badge>
            <span className="font-semibold">{o.name ?? 'anonymous'}</span>
            {o.rootField && o.rootField !== o.name && <span className="text-xs text-muted">runs {o.rootField}</span>}
          </div>
          <CodeBlock className="p-2 text-xs mono whitespace-pre rounded border border-line bg-panel overflow-auto" language="code" text={o.query} />
          {o.variables !== undefined && (
            <div>
              <div className="text-xs font-semibold text-muted mb-1">Variables</div>
              <div className="rounded border border-line max-h-60 overflow-auto">{typeof o.variables === 'object' && o.variables !== null ? <JsonTree data={o.variables} /> : <CodeBlock className="p-2 text-xs mono" text={String(o.variables)} />}</div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- decoded on the host */

interface Decoded {
  ok: boolean;
  error?: string;
  data?: { value?: unknown; fields?: unknown; messages?: Array<{ kind: string; name?: string; data?: unknown }> };
  text?: string;
}

/** MessagePack, Protobuf (field by field), SignalR and Socket.IO: decoded on the host when the tab opens, masked like any body. */
function DecodedView({ e, side, view }: { e: Exchange; side: 'request' | 'response'; view: BodyViewId }) {
  const [r, setR] = useState<Decoded>();
  const [failed, setFailed] = useState<string>();
  useEffect(() => {
    let live = true;
    setR(undefined);
    setFailed(undefined);
    void call<Decoded>('debug.bodyView', { id: e.id, view, side }).then(
      (x) => live && setR(x),
      (err) => live && setFailed((err as Error).message),
    );
    return () => {
      live = false;
    };
  }, [e.id, view, side, e.responseBodyBytes, e.requestBodyBytes]);
  if (failed) return <Empty title="Could not decode">{failed}</Empty>;
  if (!r) return <div className="p-3 text-sm text-muted">Decoding…</div>;
  if (!r.ok) return <Empty title="Not decoded">{r.error ?? 'The body could not be read as this format.'}</Empty>;
  return (
    <div className="h-full min-h-0 overflow-auto" data-view={view}>
      {view === 'msgpack' && r.data?.value !== undefined && typeof r.data.value === 'object' && r.data.value !== null ? <JsonTree data={r.data.value} /> : view === 'signalr' || view === 'socketio' ? (
        <Table name={view} head={['Kind', 'Name', 'Data']} rows={(r.data?.messages ?? []).map((m) => [m.kind, m.name ?? '', m.data === undefined ? '' : JSON.stringify(m.data)])} />
      ) : (
        <CodeBlock className="p-3 text-xs mono whitespace-pre-wrap break-all" text={r.text ?? ''} />
      )}
    </div>
  );
}
