import { Plus, Trash2 } from 'lucide-react';
import { Button, Field, IconButton, Input, Select, Toggle } from '../ui';
import type { Rule } from '../DebuggerRules';

/**
 * The rule editor's fields for the shaping rules: find-and-replace in bodies and a status to answer with (modify), a file or
 * folder to answer from (reply), a path rewrite (redirect), host remapping, injected failures and WebSocket frame rules.
 * Each is one block of the same editor; `set` merges a change into the rule being edited.
 */
type SetRule = (patch: Partial<Rule>) => void;
type Replace = NonNullable<Rule['requestReplace']>[number];

/** A list of find-and-replace rows: the text to find, what replaces it, as a regular expression or as written. */
function ReplaceList({ label, hint, list, onChange }: { label: string; hint: string; list: Replace[]; onChange(l: Replace[]): void }) {
  const change = (i: number, patch: Partial<Replace>) => onChange(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <Field label={label} hint={hint}>
      <div className="grid gap-1.5">
        {list.map((r, i) => (
          <div key={i} className="flex items-center gap-2" data-replace-row>
            <Input className="flex-1 mono" aria-label={`${label}: text to find`} placeholder="Find" value={r.find} onChange={(e) => change(i, { find: e.target.value })} />
            <Input className="flex-1 mono" aria-label={`${label}: replacement`} placeholder="Replace with" value={r.replace} onChange={(e) => change(i, { replace: e.target.value })} />
            <Toggle checked={!!r.regex} onChange={(v) => change(i, { regex: v || undefined })} label="Pattern" title="Find is a regular expression; $1 in the replacement is its first group" />
            <IconButton size="md" label="Remove this replacement" onClick={() => onChange(list.filter((_, j) => j !== i))}>
              <Trash2 />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...list, { find: '', replace: '' }])}>
            Add a replacement
          </Button>
        </div>
      </div>
    </Field>
  );
}

/** Modify: replacements in the bodies and a status to answer with. */
export function ModifyShapingFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  return (
    <>
      <ReplaceList label="Replace in the request body" hint="Applied in order; text-like bodies only" list={r.requestReplace ?? []} onChange={(l) => set({ requestReplace: l.length ? l : undefined })} />
      <ReplaceList label="Replace in the response body" hint="A compressed body is read, changed and sent unencoded" list={r.responseReplace ?? []} onChange={(l) => set({ responseReplace: l.length ? l : undefined })} />
      <Field label="Answer with this status instead" hint="Empty: the server's own" className="w-56">
        <Input type="number" min={100} max={599} value={r.setStatus ?? ''} onChange={(e) => set({ setStatus: e.target.value ? Number(e.target.value) : undefined })} />
      </Field>
    </>
  );
}

/** Reply: the body from text, a file of the workspace, or a folder (the request path names the file in it). */
export function ReplySourceFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const reply = r.reply ?? { status: 200 };
  const source = reply.file !== undefined ? 'file' : reply.folder !== undefined ? 'folder' : 'text';
  const put = (patch: Partial<NonNullable<Rule['reply']>>) => set({ reply: { ...reply, ...patch } });
  return (
    <>
      <Field label="Body from" className="w-64">
        <Select
          value={source}
          onChange={(e) => {
            const v = e.target.value;
            put({ file: v === 'file' ? '' : undefined, folder: v === 'folder' ? '' : undefined, stripPrefix: v === 'folder' ? reply.stripPrefix : undefined });
          }}
        >
          <option value="text">The text below</option>
          <option value="file">A file of the workspace</option>
          <option value="folder">A folder of the workspace</option>
        </Select>
      </Field>
      {source === 'file' && (
        <Field label="File" hint="A path inside the workspace; read at every request, so an edit shows at once. $1 is a group of the URL pattern /…/">
          <Input className="mono" value={reply.file ?? ''} onChange={(e) => put({ file: e.target.value })} placeholder="mocks/users.json" />
        </Field>
      )}
      {source === 'folder' && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Folder" hint="The request path names the file inside it (index.html for a folder)">
            <Input className="mono" value={reply.folder ?? ''} onChange={(e) => put({ folder: e.target.value })} placeholder="mocks" />
          </Field>
          <Field label="Leave out the path start" hint="Optional, e.g. /api">
            <Input className="mono" value={reply.stripPrefix ?? ''} onChange={(e) => put({ stripPrefix: e.target.value || undefined })} placeholder="/api" />
          </Field>
        </div>
      )}
    </>
  );
}

/** Redirect: the optional path rewrite (Map Remote). */
export function RedirectRewriteFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const rw = r.redirect?.rewrite;
  const put = (patch: Partial<NonNullable<NonNullable<Rule['redirect']>['rewrite']>>) => set({ redirect: { ...(r.redirect ?? {}), rewrite: { from: '', to: '', ...(rw ?? {}), ...patch } } });
  return (
    <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
      <Field label="Change the path: find" hint="A pattern with *, or a regular expression; empty: keep the path">
        <Input className="mono" value={rw?.from ?? ''} onChange={(e) => put({ from: e.target.value })} placeholder="/api/*" />
      </Field>
      <Field label="Becomes" hint="$1 is the first * or group">
        <Input className="mono" value={rw?.to ?? ''} onChange={(e) => put({ to: e.target.value })} placeholder="/v2/$1" />
      </Field>
      <Toggle checked={!!rw?.regex} onChange={(v) => put({ regex: v || undefined })} label="Pattern" title="Find is a regular expression" />
    </div>
  );
}

/** Remap: the host to move (Matches ▸ Host) and where it goes. */
export function RemapFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const m = r.remap ?? { to: '' };
  const put = (patch: Partial<NonNullable<Rule['remap']>>) => set({ remap: { ...m, ...patch } });
  return (
    <>
      <p className="text-xs text-muted">The host in Matches is reached at the address below, like an entry of the hosts file. Without “Keep the Host header” the server sees the new host.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Go to" hint="A host, an IP address, or host:port">
          <Input className="mono" value={m.to} onChange={(e) => put({ to: e.target.value })} placeholder="localhost:3000" data-remap-to />
        </Field>
        <Field label="Protocol">
          <Select value={m.scheme ?? 'auto'} onChange={(e) => put({ scheme: e.target.value as 'auto' | 'http' | 'https' })}>
            <option value="auto">As the request</option>
            <option value="http">http</option>
            <option value="https">https</option>
          </Select>
        </Field>
      </div>
      <Toggle checked={!!m.preserveHost} onChange={(v) => put({ preserveHost: v || undefined })} label="Keep the Host header and the TLS name" title="The server still sees the original host; only the address it is reached at changes" />
    </>
  );
}

/** Fault: what fails and how often. */
export function FaultFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const f = r.fault ?? { action: 'drop' as const };
  const put = (patch: Partial<NonNullable<Rule['fault']>>) => set({ fault: { ...f, ...patch } });
  return (
    <div className="grid grid-cols-2 gap-3">
      <Field label="What fails">
        <Select value={f.action} onChange={(e) => put({ action: e.target.value as NonNullable<Rule['fault']>['action'] })}>
          <option value="drop">The connection is dropped</option>
          <option value="timeout">The request is never answered</option>
          <option value="truncate">The response is cut short</option>
          <option value="error">An error status is answered</option>
        </Select>
      </Field>
      <Field label="How often (%)" hint="Of the matching requests; 100: every one">
        <Input type="number" min={1} max={100} value={f.percent ?? 100} onChange={(e) => put({ percent: e.target.value ? Number(e.target.value) : undefined })} />
      </Field>
      {f.action === 'truncate' && (
        <Field label="Bytes kept" hint="The rest of the body never arrives">
          <Input type="number" min={0} value={f.bytes ?? 1024} onChange={(e) => put({ bytes: Number(e.target.value) })} />
        </Field>
      )}
      {f.action === 'error' && (
        <Field label="Status">
          <Input type="number" min={100} max={599} value={f.status ?? 503} onChange={(e) => put({ status: Number(e.target.value) })} />
        </Field>
      )}
      {f.action === 'timeout' && (
        <Field label="Gives up after (ms)" hint="The program usually gives up first; at most 5 minutes">
          <Input type="number" min={1} max={300000} value={f.timeoutMs ?? 30000} onChange={(e) => put({ timeoutMs: Number(e.target.value) })} />
        </Field>
      )}
    </div>
  );
}

/** Frame: what happens to WebSocket frames of the connections that match. */
export function FrameFields({ r, set }: { r: Partial<Rule>; set: SetRule }) {
  const f = r.frame ?? { action: 'drop' as const };
  const put = (patch: Partial<NonNullable<Rule['frame']>>) => set({ frame: { ...f, ...patch } });
  return (
    <>
      <p className="text-xs text-muted">Matches picks the WebSocket connections (Host, URL). Only whole text frames are changed; the server is asked not to compress them.</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Frames">
          <Select value={f.direction ?? 'both'} onChange={(e) => put({ direction: e.target.value as 'sent' | 'received' | 'both' })}>
            <option value="both">Both ways</option>
            <option value="sent">Sent by the program</option>
            <option value="received">Received from the server</option>
          </Select>
        </Field>
        <Field label="Action">
          <Select value={f.action} onChange={(e) => put({ action: e.target.value as NonNullable<Rule['frame']>['action'] })}>
            <option value="drop">Drop (never forwarded)</option>
            <option value="replace">Change the text</option>
            <option value="break">Pause for editing</option>
            <option value="delay">Hold back</option>
          </Select>
        </Field>
        <Field label="Only when the text has" hint="Text, or /a pattern/">
          <Input className="mono" value={f.when ?? ''} onChange={(e) => put({ when: e.target.value || undefined })} placeholder="optional" />
        </Field>
      </div>
      {f.action === 'replace' && (
        <div className="grid grid-cols-[1fr_1fr_auto] gap-3 items-end">
          <Field label="Find" hint="Empty: the whole frame">
            <Input className="mono" value={f.find ?? ''} onChange={(e) => put({ find: e.target.value })} />
          </Field>
          <Field label="Replace with">
            <Input className="mono" value={f.replace ?? ''} onChange={(e) => put({ replace: e.target.value })} />
          </Field>
          <Toggle checked={!!f.regex} onChange={(v) => put({ regex: v || undefined })} label="Pattern" />
        </div>
      )}
      {f.action === 'delay' && (
        <Field label="Hold back (ms)" className="w-48">
          <Input type="number" min={1} max={60000} value={f.delayMs ?? 1000} onChange={(e) => put({ delayMs: Number(e.target.value) })} />
        </Field>
      )}
      {f.action === 'break' && <p className="text-xs text-muted">Each matching frame waits in the breakpoint panel (it goes on by itself after two minutes): edit its text and continue, or abort to drop it.</p>}
    </>
  );
}
