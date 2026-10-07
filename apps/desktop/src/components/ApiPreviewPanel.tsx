import { ChevronDown, ChevronRight, ExternalLink, FlaskConical, Lock, Workflow } from 'lucide-react';
import { useState } from 'react';
import { asError, call } from '../api';
import { confirmAction, useApp } from '../store';
import { TreeBadge } from './CollectionTree';
import { Badge, Button, Empty, Menu } from './ui';
import { generateFlows } from '../lib/files';

interface OutlineOperation {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  tag: string;
  parameters: Array<{ name: string; in: string; required: boolean; type: string; description?: string }>;
  requestBody?: { contentType: string; required: boolean; schema: string };
  responses: Array<{ code: string; description?: string; contentType?: string; schema?: string }>;
  security: string[];
  request?: unknown;
}

export interface ApiOutline {
  title: string;
  version?: string;
  description?: string;
  servers: string[];
  tags: Array<{ name: string; description?: string; operations: OutlineOperation[] }>;
  operations: number;
}

const codeTone = (c: string): 'ok' | 'default' | 'warn' | 'bad' => (/^2/.test(c) ? 'ok' : /^3/.test(c) ? 'default' : /^4/.test(c) ? 'warn' : /^5/.test(c) ? 'bad' : 'default');

function Operation({ op }: { op: OutlineOperation }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-t border-line/60" data-operation={`${op.method} ${op.path}`}>
      <button className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-panel" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} className="shrink-0 text-muted" /> : <ChevronRight size={13} className="shrink-0 text-muted" />}
        <TreeBadge label={op.method} className={`method-${op.method}`} />
        <span className={`mono text-sm ${op.deprecated ? 'line-through text-muted' : ''}`}>{op.path}</span>
        <span className="text-sm text-muted truncate">{op.summary}</span>
        {op.security.length > 0 && <Lock size={12} className="ml-auto shrink-0 text-muted" aria-label={`Needs ${op.security.join(', ')}`} />}
      </button>
      {open && (
        <div className="px-8 pb-3 grid gap-3 text-sm">
          {op.description && <p className="text-muted whitespace-pre-wrap">{op.description}</p>}
          <div className="flex items-center gap-2 flex-wrap">
            {op.operationId && <span className="mono text-xs text-muted">{op.operationId}</span>}
            {op.deprecated && <Badge tone="warn">deprecated</Badge>}
            {op.security.map((s) => (
              <Badge key={s}>{s}</Badge>
            ))}
            {op.request != null && (
              <Button
                size="sm"
                className="ml-auto"
                icon={<ExternalLink size={12} />}
                onClick={() => useApp.getState().openIntent('rest', { request: op.request, name: op.summary ?? `${op.method} ${op.path}` })}
              >
                Open as request
              </Button>
            )}
          </div>
          {op.parameters.length > 0 && (
            <table className="text-xs w-full">
              <thead className="text-muted text-left">
                <tr>
                  <th className="font-normal py-1">Parameter</th>
                  <th className="font-normal">In</th>
                  <th className="font-normal">Type</th>
                  <th className="font-normal">Description</th>
                </tr>
              </thead>
              <tbody>
                {op.parameters.map((p) => (
                  <tr key={`${p.in}:${p.name}`} className="border-t border-line/50 align-top">
                    <td className="mono py-1 pr-3">
                      {p.name}
                      {p.required && <span className="text-bad">*</span>}
                    </td>
                    <td className="pr-3 text-muted">{p.in}</td>
                    <td className="mono pr-3">{p.type}</td>
                    <td className="text-muted">{p.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {op.requestBody && (
            <div>
              <div className="text-xs text-muted mb-1">
                Request body · {op.requestBody.contentType}
                {op.requestBody.required ? '' : ' · optional'}
              </div>
              {op.requestBody.schema && <pre className="mono text-xs bg-panel rounded p-2 overflow-auto max-h-64">{op.requestBody.schema}</pre>}
            </div>
          )}
          <div className="grid gap-1">
            <div className="text-xs text-muted">Responses</div>
            {op.responses.map((r) => (
              <div key={r.code} className="grid gap-1">
                <div className="flex items-center gap-2">
                  <Badge tone={codeTone(r.code)}>{r.code}</Badge>
                  <span className="text-xs">{r.description}</span>
                  {r.contentType && <span className="text-xs text-muted mono">{r.contentType}</span>}
                </div>
                {r.schema && <pre className="mono text-xs bg-panel rounded p-2 overflow-auto max-h-64 ml-1">{r.schema}</pre>}
              </div>
            ))}
          </div>
        </div>
      )}
    </li>
  );
}

/** An API definition as its readers see it: the operations by tag, each with its parameters, body and responses, and Open as request. */
/** Write the first test suite from the definition: a file per tag, each operation's example and one invalid request. */
async function generateTests(spec: string) {
  const ok = await confirmAction({
    title: 'Generate tests from this definition?',
    message: `A test file per tag under tests/, with each operation's example (its documented status, the OpenAPI contract, latency) and one invalid request that must get a 4xx, and a suite that runs them. Test files that exist are kept.`,
    confirmLabel: 'Generate tests',
  });
  if (!ok) return;
  try {
    const r = await call<{ written: Array<{ path: string; tests: number }>; skipped: string[] }>('openapi.generateTests', { path: spec });
    const n = r.written.reduce((k, f) => k + f.tests, 0);
    useApp
      .getState()
      .toast(
        r.written.length
          ? `${r.written.length} files, ${n} tests${r.skipped.length ? ` (${r.skipped.length} kept as they were)` : ''}: review the example values, then run the suite`
          : `Every file exists already: ${r.skipped.join(', ')}`,
        r.written.length ? 'success' : 'warning',
        r.written.length ? { label: 'Open Tests', onClick: () => useApp.getState().setView('tests') } : undefined,
      );
  } catch (e) {
    useApp.getState().toast(asError(e).message, 'error');
  }
}

export function ApiPreviewPanel({ outline, error, spec }: { outline?: ApiOutline; error?: string; spec?: string }) {
  if (error) return <Empty title="Couldn't read the document">{error}</Empty>;
  if (!outline) return <Empty title="Reading the document…" />;
  return (
    <div className="h-full overflow-auto" data-api-preview>
      <div className="px-3 py-3 border-b border-line grid gap-1">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{outline.title}</span>
          {outline.version && <Badge>v{outline.version}</Badge>}
          <span className="text-xs text-muted">{outline.operations} operations</span>
          {spec && (
            <Menu
              trigger={
                <Button size="sm" className="ml-auto" icon={<FlaskConical size={12} />}>
                  Generate tests
                </Button>
              }
              width={300}
              items={[
                { label: 'A test per operation (example + an invalid request)', icon: <FlaskConical size={14} />, onSelect: () => void generateTests(spec) },
                { label: 'Integration flows (create, read, update, list, delete)', icon: <Workflow size={14} />, onSelect: () => void generateFlows({ path: spec }, confirmAction) },
              ]}
            />
          )}
        </div>
        {outline.servers.length > 0 && <div className="mono text-xs text-muted">{outline.servers.join(' · ')}</div>}
        {outline.description && <p className="text-sm text-muted whitespace-pre-wrap max-h-24 overflow-auto">{outline.description}</p>}
      </div>
      {outline.tags.map((t) => (
        <section key={t.name} className="px-1 py-2">
          <h3 className="px-2 text-sm font-semibold flex items-baseline gap-2">
            {t.name}
            {t.description && <span className="text-xs text-muted font-normal truncate">{t.description}</span>}
          </h3>
          <ul className="mt-1">
            {t.operations.map((op) => (
              <Operation key={`${op.method} ${op.path}`} op={op} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
