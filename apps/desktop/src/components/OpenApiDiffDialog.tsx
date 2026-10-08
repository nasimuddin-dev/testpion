import { CircleAlert, CircleCheck, FileUp, GitCompare, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { pickTextFile } from '../lib/files';
import { Button, cx, Field, Input, ModalOrPanel, Select } from './ui';

interface ApiChange {
  level: 'breaking' | 'non-breaking';
  kind: string;
  where: string;
  message: string;
}
interface OpenApiDiff {
  breaking: ApiChange[];
  nonBreaking: ApiChange[];
  operations: { old: number; new: number; added: number; removed: number };
}
/** One side of the comparison: a document kept in the workspace, a link, or a file's text. */
export interface Side {
  path?: string;
  url?: string;
  text?: string;
  fileName?: string;
}

export function SidePicker({ label, specs, value, onChange }: { label: string; specs: string[]; value: Side; onChange(s: Side): void }) {
  const mode = value.text !== undefined ? 'file' : value.url !== undefined ? 'link' : 'spec';
  return (
    <Field label={label}>
      <div className="flex gap-2">
        <Select
          className="w-40 shrink-0"
          value={mode}
          aria-label={`${label}: source`}
          onChange={(e) => onChange(e.target.value === 'link' ? { url: '' } : e.target.value === 'file' ? { text: '', fileName: '' } : { path: specs[0] })}
        >
          <option value="spec">In this workspace</option>
          <option value="link">Link</option>
          <option value="file">File</option>
        </Select>
        {mode === 'spec' &&
          (specs.length ? (
            <Select className="flex-1" value={value.path ?? ''} aria-label={label} onChange={(e) => onChange({ path: e.target.value })}>
              {specs.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          ) : (
            <span className="text-sm text-muted self-center">No OpenAPI documents in specs/ yet (importing one keeps it there).</span>
          ))}
        {mode === 'link' && <Input className="flex-1 mono" aria-label={label} placeholder="https://…/openapi.json" value={value.url ?? ''} onChange={(e) => onChange({ url: e.target.value })} />}
        {mode === 'file' && (
          <Button
            className="flex-1 justify-start"
            icon={<FileUp size={13} />}
            onClick={() => void pickTextFile('.json,.yaml,.yml').then((f) => f && onChange({ text: f.text, fileName: f.name }))}
          >
            {value.fileName || 'Choose file…'}
          </Button>
        )}
      </div>
    </Field>
  );
}

/** Compare two OpenAPI versions and list what can break clients (same engine as `testpion openapi-diff`). */
export function OpenApiDiffDialog({ onClose, inline, before: fixedBefore }: { onClose(): void; /** In an API definition's tab, comparing that document (the previous version) with another. */ inline?: boolean; before?: string }) {
  const [specs, setSpecs] = useState<string[]>([]);
  const [before, setBefore] = useState<Side>({ path: undefined });
  const [after, setAfter] = useState<Side>({ path: undefined });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OpenApiDiff>();
  useEffect(() => {
    void call<string[]>('openapi.specs').then((s) => {
      setSpecs(s);
      const first = fixedBefore ?? s[0];
      setBefore({ path: first });
      const other = s.find((x) => x !== first);
      setAfter(other ? { path: other } : { url: '' });
    });
  }, []);
  const ready = (s: Side) => !!(s.path || s.url?.trim() || s.text);
  const compare = async () => {
    setBusy(true);
    try {
      setResult(await call<OpenApiDiff>('openapi.diff', { old: before, new: after }));
    } catch (e) {
      setResult(undefined);
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalOrPanel
      inline={inline}
      title="Compare OpenAPI versions"
      onClose={onClose}
      width={760}
      footer={
        <Button variant="primary" icon={<GitCompare size={13} />} loading={busy} disabled={!ready(before) || !ready(after)} onClick={() => void compare()}>
          Compare
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">Lists what can break existing clients: removed operations or success responses, new required parameters or body fields, changed types, removed or now-optional response fields. In CI: <span className="mono">testpion openapi-diff old new --fail-on-breaking</span>.</p>
        {fixedBefore ? (
          <p className="text-sm">
            Previous version: <span className="mono">{fixedBefore}</span>
          </p>
        ) : (
          <SidePicker label="Previous version" specs={specs} value={before} onChange={setBefore} />
        )}
        <SidePicker label="New version" specs={specs} value={after} onChange={setAfter} />
        {result && (
          <div className={cx('flex flex-col gap-2 overflow-auto', !inline && 'max-h-[46vh]')}>
            <div className="text-sm text-muted flex items-center gap-2">
              {result.operations.old} → {result.operations.new} operations ({result.operations.added} added, {result.operations.removed} removed)
              {!!(result.breaking.length + result.nonBreaking.length) && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon={<Sparkles size={12} />}
                  onClick={() => {
                    useApp.getState().set({ assistant: { task: 'explain-api-changes', title: 'Impact of the API changes', context: { breaking: result.breaking.slice(0, 80), other: result.nonBreaking.slice(0, 80), operations: result.operations } } });
                    onClose();
                  }}
                >
                  Explain with AI
                </Button>
              )}
            </div>
            {result.breaking.length ? (
              <div>
                <div className="text-sm font-medium text-bad flex items-center gap-1.5 mb-1">
                  <CircleAlert size={14} /> {result.breaking.length} breaking change{result.breaking.length > 1 ? 's' : ''}
                </div>
                <ul className="text-sm flex flex-col gap-1">
                  {result.breaking.map((c, i) => (
                    <li key={i}>
                      <span className="mono text-xs">{c.where}</span>: {c.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="text-sm text-ok flex items-center gap-1.5">
                <CircleCheck size={14} /> No breaking changes
              </div>
            )}
            {!!result.nonBreaking.length && (
              <div>
                <div className="text-sm font-medium mb-1">
                  {result.nonBreaking.length} other change{result.nonBreaking.length > 1 ? 's' : ''}
                </div>
                <ul className="text-sm text-muted flex flex-col gap-1">
                  {result.nonBreaking.map((c, i) => (
                    <li key={i}>
                      <span className="mono text-xs">{c.where}</span>: {c.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalOrPanel>
  );
}
