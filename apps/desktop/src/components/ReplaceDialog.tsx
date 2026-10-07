import { Replace, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { Collection } from '../types';
import { Badge, Button, Empty, Field, Input, Modal, Toggle } from './ui';

type Field = 'url' | 'params' | 'headers' | 'body' | 'auth' | 'scripts' | 'name';
const FIELDS: Array<[Field, string]> = [
  ['url', 'URLs'],
  ['params', 'Params'],
  ['headers', 'Headers'],
  ['body', 'Bodies'],
  ['auth', 'Auth'],
  ['scripts', 'Scripts'],
  ['name', 'Names'],
];

interface Match {
  requestId: string;
  request: string;
  field: Field;
  where: string;
  before: string;
  after: string;
}

/**
 * Find and replace across a collection's requests: every change is shown before anything is saved, and Undo puts the
 * collection back as it was.
 */
export function ReplaceDialog({ collection, onClose, onDone, initialFind, initialReplace }: { collection: Collection; onClose(): void; onDone(): void; initialFind?: string; initialReplace?: string }) {
  const [find, setFind] = useState(initialFind ?? '');
  const [replace, setReplace] = useState(initialReplace ?? '');
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [fields, setFields] = useState<Set<Field>>(new Set(FIELDS.map(([f]) => f)));
  const [preview, setPreview] = useState<{ count: number; matches: Match[]; error?: string }>();
  const [busy, setBusy] = useState(false);
  const opts = useMemo(() => ({ collectionId: collection.id, find, replace, regex, caseSensitive, fields: [...fields] }), [collection.id, find, replace, regex, caseSensitive, fields]);

  // the preview follows what is typed, a moment after typing stops
  useEffect(() => {
    if (!find) return setPreview(undefined);
    const t = setTimeout(() => void call<{ count: number; matches: Match[] }>('col.replace', opts).then(setPreview, (e) => setPreview({ count: 0, matches: [], error: asError(e).message })), 300);
    return () => clearTimeout(t);
  }, [opts, find]);

  const apply = async () => {
    setBusy(true);
    try {
      const r = await call<{ count: number }>('col.replace', { ...opts, apply: true });
      onDone();
      onClose();
      // Undo: the collection as it was before
      useApp.getState().toast(`${r.count} changes saved in ${collection.name}`, 'success', {
        label: 'Undo',
        onClick: () => void call('col.save', collection).then(onDone, (e) => useApp.getState().toast(asError(e).message, 'error')),
      });
    } catch (e) {
      useApp.getState().toast(asError(e).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const requests = new Set(preview?.matches.map((m) => m.requestId)).size;
  return (
    <Modal
      title={`Find and replace in ${collection.name}`}
      onClose={onClose}
      width={760}
      footer={
        <Button variant="primary" icon={<Replace size={13} />} disabled={!preview?.count || busy} onClick={() => void apply()}>
          {preview?.count ? `Replace ${preview.count}` : 'Replace'}
        </Button>
      }
    >
      <div className="grid gap-3 text-sm" data-replace-dialog>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Find">
            <Input autoFocus className="mono" value={find} onChange={(e) => setFind(e.target.value)} placeholder="http://old-host:5002" aria-label="Find" />
          </Field>
          <Field label="Replace with">
            <Input className="mono" value={replace} onChange={(e) => setReplace(e.target.value)} placeholder="{{baseUrl}}" aria-label="Replace with" />
          </Field>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Toggle checked={caseSensitive} onChange={setCaseSensitive} label="Match case" />
          <Toggle checked={regex} onChange={setRegex} label="Regular expression" />
          <span className="text-xs text-muted ml-2">Look in</span>
          {FIELDS.map(([f, label]) => (
            <button
              key={f}
              className={`px-2 py-0.5 rounded-full border text-xs ${fields.has(f) ? 'border-accent bg-accent-soft text-fg' : 'border-line text-muted'}`}
              aria-pressed={fields.has(f)}
              onClick={() => {
                const next = new Set(fields);
                if (next.has(f)) next.delete(f);
                else next.add(f);
                setFields(next);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="border border-line rounded-md max-h-[45vh] overflow-auto" data-replace-preview>
          {!find ? (
            <Empty icon={<Search size={22} />} title="Type what to find">
              Every change is listed here before anything is saved.
            </Empty>
          ) : preview?.error ? (
            <p className="p-3 text-bad text-xs">{preview.error}</p>
          ) : !preview ? (
            <p className="p-3 text-xs text-muted">Looking…</p>
          ) : !preview.count ? (
            <p className="p-3 text-xs text-muted">Nothing matches in the chosen fields.</p>
          ) : (
            <>
              <div className="px-3 py-2 text-xs text-muted border-b border-line">
                {preview.count} changes in {requests} request{requests === 1 ? '' : 's'}
                {preview.count > preview.matches.length ? ` (the first ${preview.matches.length} shown)` : ''}
              </div>
              <ul>
                {preview.matches.map((m, i) => (
                  <li key={i} className="px-3 py-1.5 border-b border-line/50 grid gap-0.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="truncate text-xs">{m.request}</span>
                      <Badge>{m.where}</Badge>
                    </div>
                    <div className="mono text-xs break-all text-bad line-through decoration-bad/40">{m.before}</div>
                    <div className="mono text-xs break-all text-ok">{m.after}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
