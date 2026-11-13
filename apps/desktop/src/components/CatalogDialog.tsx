import { Download } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { asError, call } from '../api';
import { attempt, useApp } from '../store';
import { saveCatalogPage } from './output/run-specs';
import { openRef } from '../lib/open-ref';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';
import { Badge, Button, EmptyNote, FilterInput, LinkButton, Modal } from './ui';

/** From `col.catalog` (workspaceCatalog in core). */
interface CatalogApi {
  id: string;
  name: string;
  summary?: string;
  requests: number;
  folders: number;
  methods: Record<string, number>;
  hosts: string[];
  specs: Array<{ path: string; title?: string; version?: string; operations: number; withRequest: number }>;
  environments: string[];
  monitors: Array<{ id: string; name: string; enabled: boolean; status?: 'passed' | 'failed' | 'error' }>;
  tests: string[];
  calls: { grpc: number; websocket: number; loadTests: number };
  owners: string[];
}
interface Catalog {
  workspace: { name: string };
  apis: CatalogApi[];
  specsWithoutRequests: Array<{ path: string; title?: string; operations: number }>;
  mcpServers: Array<{ id: string; name: string; transport: string }>;
}

const SITE_COMMAND = 'testpion docs --site ./api-catalog -w .';

/**
 * The API catalog: every API (collection) of the workspace with what belongs to it: its requests, the API definition
 * it implements and how much of it has requests, environments, monitors, tests and owners. The same reading as
 * `testpion docs --catalog` and the MCP tool `api_catalog`; Save as a page writes it as one HTML file to share.
 */
export function CatalogDialog() {
  const close = () => useApp.getState().set({ catalogOpen: false });
  const [data, setData] = useState<Catalog>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState('');
  useEffect(() => {
    let live = true;
    call<Catalog>('col.catalog').then(
      (r) => live && setData(r),
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, []);
  const ql = q.trim().toLowerCase();
  const apis = (data?.apis ?? []).filter((a) => !ql || [a.name, a.summary ?? '', ...a.hosts, ...a.owners, ...a.specs.map((s) => `${s.path} ${s.title ?? ''}`)].some((t) => t.toLowerCase().includes(ql)));
  const go = (ref: Parameters<typeof openRef>[0]) => {
    close();
    void openRef(ref);
  };
  const row = (label: string, value: ReactNode, key = label) => [
    <dt key={`${key}:t`} className="text-muted">
      {label}
    </dt>,
    <dd key={`${key}:d`} className="min-w-0 break-words">
      {value}
    </dd>,
  ];
  const monitorState = (m: CatalogApi['monitors'][number]) => (!m.enabled ? 'off' : m.status === 'passed' ? 'passing' : m.status ? 'failing' : 'no run yet');
  return (
    <Modal
      title="API catalog"
      onClose={close}
      width={760}
      footer={
        data?.apis.length ? (
          <>
            <LinkButton className="text-xs mr-auto" title="The command that writes the catalog as a site: index.html, catalog.json and a documentation page per API" onClick={() => void copyText(SITE_COMMAND, 'the command')}>
              Copy the command that builds the site
            </LinkButton>
            <Button icon={<Download size={13} />} onClick={() => void attempt(saveCatalogPage)}>
              Save as a page…
            </Button>
          </>
        ) : undefined
      }
    >
      {error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : !data ? (
        <EmptyNote>Reading the workspace…</EmptyNote>
      ) : !data.apis.length ? (
        <EmptyNote>This workspace has no collections yet. An API appears here once it has a collection.</EmptyNote>
      ) : (
        <div data-catalog>
          {data.apis.length > 3 && <FilterInput className="w-full mb-3" placeholder="Filter by name, host, API definition or owner" label="Filter the APIs" value={q} onChange={setQ} />}
          {apis.map((a) => (
            <article key={a.id} className="border border-line rounded-md p-3 mb-2" data-catalog-api={a.id}>
              <h3 className="text-sm font-semibold flex items-center gap-2 flex-wrap">
                <LinkButton onClick={() => go({ kind: 'collection', collectionId: a.id })}>{a.name}</LinkButton>
                <span className="text-xs text-muted font-normal">
                  {plural(a.requests, 'request')}
                  {a.folders ? ` in ${plural(a.folders, 'folder')}` : ''}
                </span>
                {Object.entries(a.methods).map(([m, n]) => (
                  <Badge key={m}>
                    {m} {n}
                  </Badge>
                ))}
              </h3>
              {a.summary && <p className="text-sm mt-1">{a.summary}</p>}
              <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 text-sm mt-2">
                {a.hosts.length > 0 && row('Calls', <span className="mono text-xs">{a.hosts.join('  ')}</span>)}
                {a.specs.map((s) =>
                  row(
                    'API definition',
                    <>
                      <LinkButton className="mono text-xs" onClick={() => go({ kind: 'spec', path: s.path })}>
                        {s.path}
                      </LinkButton>{' '}
                      <span className="text-muted text-xs">
                        {s.withRequest} of {plural(s.operations, 'operation')} {s.withRequest === 1 ? 'has' : 'have'} a request
                      </span>
                    </>,
                    s.path,
                  ),
                )}
                {a.environments.length > 0 && row('Environments', a.environments.join(', '))}
                {a.monitors.length > 0 &&
                  row(
                    'Monitors',
                    a.monitors.map((m) => (
                      <span key={m.id} className="mr-3">
                        <LinkButton onClick={() => go({ kind: 'monitor', monitorId: m.id })}>{m.name}</LinkButton>{' '}
                        <Badge tone={monitorState(m) === 'passing' ? 'ok' : monitorState(m) === 'failing' ? 'bad' : undefined}>{monitorState(m)}</Badge>
                      </span>
                    )),
                  )}
                {a.tests.length > 0 &&
                  row(
                    'Tests',
                    a.tests.map((t) => (
                      <LinkButton key={t} className="mono text-xs mr-3" onClick={() => go({ kind: 'test', path: t.replace(/^tests\//, '') })}>
                        {t}
                      </LinkButton>
                    )),
                  )}
                {a.calls.grpc + a.calls.websocket + a.calls.loadTests > 0 &&
                  row('Also', [a.calls.grpc && plural(a.calls.grpc, 'gRPC call'), a.calls.websocket && plural(a.calls.websocket, 'connection'), a.calls.loadTests && plural(a.calls.loadTests, 'load test')].filter(Boolean).join(' · '))}
                {a.owners.length > 0 && row('Owners', a.owners.join(', '))}
              </dl>
            </article>
          ))}
          {!apis.length && <EmptyNote>No API matches the filter.</EmptyNote>}
          {data.specsWithoutRequests.length > 0 && (
            <section className="mt-4">
              <h3 className="text-xs font-semibold mb-1">API definitions without requests</h3>
              <ul className="text-sm">
                {data.specsWithoutRequests.map((s) => (
                  <li key={s.path}>
                    <LinkButton className="mono text-xs" onClick={() => go({ kind: 'spec', path: s.path })}>
                      {s.path}
                    </LinkButton>{' '}
                    <span className="text-muted text-xs">{plural(s.operations, 'operation')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </Modal>
  );
}
