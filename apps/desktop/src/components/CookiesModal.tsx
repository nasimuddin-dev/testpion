import { Cookie, Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { confirmAction, promptText, toastError, useApp } from '../store';
import { Badge, Button, cx, Empty, Field, IconButton, Input, Modal, Toggle } from './ui';

export interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  hostOnly?: boolean;
}

/** Host of a request URL (`{{baseUrl}}/x` and bare hosts work too), or '' when it cannot be parsed. */
export function hostOf(url: string | undefined): string {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?([^/:?#{}\s]+)/i.exec((url ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

const blank = (domain: string): JarCookie => ({ name: '', value: '', domain, path: '/' });

/** `2026-09-27T10:00:00.000Z` ⇄ the value of a `datetime-local` input (local time). */
const toLocalInput = (iso?: string) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : undefined);

/**
 * Postman-style "Manage cookies" dialog. Cookies live in the workspace cookie jar: filled by
 * Set-Cookie responses, sent with matching requests, kept on this machine only and encrypted.
 */
export function CookiesModal({ initialDomain, onClose }: { initialDomain?: string; onClose(): void }) {
  const toast = useApp((s) => s.toast);
  const [cookies, setCookies] = useState<JarCookie[]>([]);
  const [persistent, setPersistent] = useState(true);
  const [extraDomains, setExtraDomains] = useState<string[]>(initialDomain ? [initialDomain] : []);
  const [domain, setDomain] = useState(initialDomain ?? '');
  const [editing, setEditing] = useState<{ original?: JarCookie; draft: JarCookie } | null>(null);
  const [filter, setFilter] = useState('');

  const reload = () =>
    call<{ cookies: JarCookie[]; persistent: boolean }>('cookies.list').then((r) => {
      setCookies(r.cookies);
      setPersistent(r.persistent);
    });
  useEffect(() => {
    void reload();
  }, []);

  const domains = useMemo(() => [...new Set([...cookies.map((c) => c.domain), ...extraDomains])].sort(), [cookies, extraDomains]);
  useEffect(() => {
    if (!domain && domains.length) setDomain(domains[0]!);
  }, [domain, domains]);
  const shown = cookies.filter((c) => c.domain === domain && (!filter || c.name.toLowerCase().includes(filter.toLowerCase())));
  const count = (d: string) => cookies.filter((c) => c.domain === d).length;

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    try {
      await fn();
      await reload();
      if (done) toast(done, 'success');
    } catch (e) {
      toastError(e);
    }
  };

  const addDomain = async () => {
    const d = (await promptText('Add domain', { placeholder: 'api.example.com', okLabel: 'Add', message: 'Cookies you add here are sent to this domain and its subdomains.' }))?.trim().replace(/^\./, '').toLowerCase();
    if (!d) return;
    setExtraDomains((x) => [...x, d]);
    setDomain(d);
  };

  const save = () =>
    editing &&
    act(async () => {
      const o = editing.original;
      await call('cookies.set', { cookie: editing.draft, replace: o && { name: o.name, domain: o.domain, path: o.path } });
      setEditing(null);
    }, 'Cookie saved');

  return (
    <Modal
      title="Cookies"
      onClose={onClose}
      width={900}
      footer={
        <>
          <span className="mr-auto text-xs text-muted inline-flex items-center gap-1.5">
            <Lock size={12} />
            {persistent ? 'Kept on this machine only, encrypted with the OS credential store. Never written to workspace files.' : 'No OS credential store available: cookies are kept in memory until the app closes. Never written to workspace files.'}
          </span>
          <Button variant="ghost" disabled={!cookies.length} onClick={async () => (await confirmAction({ title: 'Delete all cookies', message: 'Delete every cookie saved for this workspace?', detail: 'Sites will ask you to sign in again where a cookie kept you signed in.', confirmLabel: 'Delete all cookies', danger: true })) && void act(() => call('cookies.clear', {}), 'All cookies deleted')}>
            Clear all
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="flex gap-3 h-[52vh]">
        <div className="w-60 shrink-0 flex flex-col border border-line rounded-md">
          <div className="flex items-center justify-between px-3 h-9 border-b border-line text-xs font-medium text-muted">
            Domains
            <IconButton label="Add domain" onClick={() => void addDomain()}>
              <Plus size={14} />
            </IconButton>
          </div>
          <div role="listbox" aria-label="Cookie domains" className="flex-1 overflow-auto py-1">
            {domains.map((d) => (
              <button
                key={d}
                role="option"
                aria-selected={d === domain}
                onClick={() => {
                  setDomain(d);
                  setEditing(null);
                }}
                className={cx('w-full flex items-center justify-between gap-2 text-left px-3 py-1.5 text-sm', d === domain ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-hover')}
              >
                <span className="truncate mono">{d}</span>
                <Badge>{count(d)}</Badge>
              </button>
            ))}
            {!domains.length && <p className="px-3 py-2 text-xs text-muted">No cookies yet. Cookies from responses appear here automatically.</p>}
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col">
          {!domain ? (
            <Empty icon={<Cookie size={28} />} title="No cookies yet" action={<Button icon={<Plus size={13} />} onClick={() => void addDomain()}>Add domain</Button>}>
              Send a request whose response sets cookies, or add a domain to create cookies by hand.
            </Empty>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-2">
                <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter cookies" aria-label="Filter cookies" className="max-w-56" />
                <span className="mr-auto" />
                <Button size="sm" icon={<Plus size={13} />} onClick={() => setEditing({ draft: blank(domain) })}>
                  Add cookie
                </Button>
                <Button size="sm" variant="ghost" disabled={!count(domain)} onClick={() => void act(() => call('cookies.clear', { domain }), `Cookies of ${domain} deleted`)}>
                  Clear domain
                </Button>
              </div>
              <div className="flex-1 overflow-auto border border-line rounded-md">
                {shown.length ? (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-panel">
                      <tr className="text-left text-xs text-muted">
                        <th className="px-3 py-1.5">Name</th>
                        <th>Value</th>
                        <th>Path</th>
                        <th>Expires</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((c) => (
                        <tr key={`${c.name}|${c.path}`} className="border-t border-line hover:bg-hover cursor-pointer" onClick={() => setEditing({ original: c, draft: { ...c } })}>
                          <td className="px-3 py-1.5 mono">
                            {c.name}
                            {c.httpOnly && <span className="ml-1.5 text-[10px] text-muted">HttpOnly</span>}
                            {c.secure && <span className="ml-1.5 text-[10px] text-muted">Secure</span>}
                          </td>
                          <td className="mono truncate max-w-64" title={c.value}>
                            {c.value}
                          </td>
                          <td className="mono text-muted">{c.path}</td>
                          <td className="text-muted text-xs">{c.expires ? new Date(c.expires).toLocaleString() : 'Session'}</td>
                          <td className="text-right pr-1">
                            <IconButton
                              label={`Delete ${c.name}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                void act(() => call('cookies.delete', { domain: c.domain, name: c.name, path: c.path }));
                              }}
                            >
                              <Trash2 size={14} />
                            </IconButton>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <Empty title={filter ? 'No matching cookies' : `No cookies for ${domain}`} />
                )}
              </div>
              {editing && (
                <div className="mt-3 border border-line rounded-md p-3 grid grid-cols-2 gap-3 text-sm">
                  <Field label="Name">
                    <Input autoFocus value={editing.draft.name} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, name: e.target.value } })} className="mono" />
                  </Field>
                  <Field label="Value">
                    <Input value={editing.draft.value} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, value: e.target.value } })} className="mono" />
                  </Field>
                  <Field label="Path">
                    <Input value={editing.draft.path} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, path: e.target.value } })} className="mono" />
                  </Field>
                  <Field label="Expires" hint="Empty = session cookie">
                    <Input type="datetime-local" value={toLocalInput(editing.draft.expires)} onChange={(e) => setEditing({ ...editing, draft: { ...editing.draft, expires: fromLocalInput(e.target.value) } })} />
                  </Field>
                  <div className="col-span-2 flex items-center gap-5">
                    <Toggle checked={!!editing.draft.secure} onChange={(secure) => setEditing({ ...editing, draft: { ...editing.draft, secure } })} label="Secure (HTTPS only)" />
                    <Toggle checked={!!editing.draft.httpOnly} onChange={(httpOnly) => setEditing({ ...editing, draft: { ...editing.draft, httpOnly } })} label="HttpOnly" />
                    <Toggle checked={!editing.draft.hostOnly} onChange={(v) => setEditing({ ...editing, draft: { ...editing.draft, hostOnly: !v } })} label="Include subdomains" />
                    <span className="mr-auto" />
                    <Button variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                    <Button variant="primary" disabled={!editing.draft.name.trim()} onClick={() => void save()}>
                      {editing.original ? 'Save' : 'Add'}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
