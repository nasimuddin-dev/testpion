import { Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Button, Field, Input, Modal, Select, Toggle, Textarea } from './ui';

interface Outline {
  tags: Array<{ operations: Array<{ method: string; path: string; operationId?: string; summary?: string; requestBody?: { contentType: string } }> }>;
}

export interface GeneratedData {
  path: string;
  file: string;
  rows: number;
  columns: string[];
}

const SAMPLE_SCHEMA = `type: object
properties:
  name: { type: string }
  email: { type: string, format: email }
  species: { type: string, enum: [cat, dog, rabbit] }
  weight: { type: number, minimum: 0.5, maximum: 40 }
`;

/**
 * Generate test data for a run: rows from an API definition operation's request body or a JSON schema, saved in the
 * workspace's datasets/ and used as the run's data.
 */
export function GenerateDataDialog({ onClose, onDone }: { onClose(): void; onDone(d: GeneratedData): void }) {
  const [specs, setSpecs] = useState<string[]>([]);
  const [spec, setSpec] = useState('');
  const [outline, setOutline] = useState<Outline>();
  const [operation, setOperation] = useState('');
  const [source, setSource] = useState<'operation' | 'schema'>('operation');
  const [schema, setSchema] = useState(SAMPLE_SCHEMA);
  const [name, setName] = useState('');
  const [rows, setRows] = useState('20');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void call<string[]>('openapi.specs').then((s) => {
      setSpecs(s);
      if (s[0]) setSpec(s[0]);
      else setSource('schema');
    });
  }, []);
  useEffect(() => {
    if (!spec) return;
    setOutline(undefined);
    void call<Outline>('openapi.outline', { path: spec }).then(setOutline, () => setOutline({ tags: [] }));
  }, [spec]);
  const ops = useMemo(() => (outline?.tags ?? []).flatMap((t) => t.operations).filter((o) => o.requestBody && /json/.test(o.requestBody.contentType)), [outline]);
  useEffect(() => {
    if (ops[0] && !ops.some((o) => `${o.method} ${o.path}` === operation)) setOperation(`${ops[0].method} ${ops[0].path}`);
  }, [ops]);
  useEffect(() => {
    // a name from the operation, until the person types one
    if (source === 'operation' && operation && !name) setName(operation.split(' ')[1]!.replace(/[{}]/g, '').split('/').filter(Boolean).join('-') || 'data');
  }, [operation, source]);

  const generate = async () => {
    setBusy(true);
    try {
      const out = await call<GeneratedData>('datasets.generate', {
        name: name.trim() || 'data',
        rows: Number(rows) || 20,
        ...(source === 'operation' ? { spec, operation } : { schema }),
        overwrite,
      });
      useApp.getState().toast(`${out.path}: ${out.rows} rows (${out.columns.join(', ')})`, 'success');
      onDone(out);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Generate test data"
      onClose={onClose}
      width={620}
      footer={
        <Button variant="primary" icon={<Wand2 size={13} />} disabled={busy || (source === 'operation' && !operation)} onClick={() => void generate()}>
          Generate
        </Button>
      }
    >
      <div className="grid gap-3 text-sm" data-generate-data>
        <p className="text-muted">
          Rows of realistic values (emails, names, cities, prices, dates, values of each enum, numbers in each range) saved in the workspace&apos;s datasets/ folder. Each row is one iteration of the
          run.
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant={source === 'operation' ? 'primary' : undefined} disabled={!specs.length} onClick={() => setSource('operation')}>
            From an API operation
          </Button>
          <Button size="sm" variant={source === 'schema' ? 'primary' : undefined} onClick={() => setSource('schema')}>
            From a JSON schema
          </Button>
        </div>
        {source === 'operation' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="API definition">
              <Select value={spec} onChange={(e) => setSpec(e.target.value)} aria-label="API definition">
                {specs.map((s) => (
                  <option key={s} value={s}>
                    {s.replace(/^specs\//, '')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Operation (its request body)">
              <Select value={operation} onChange={(e) => setOperation(e.target.value)} aria-label="Operation">
                {ops.map((o) => (
                  <option key={`${o.method} ${o.path}`} value={`${o.method} ${o.path}`}>
                    {o.method} {o.path}
                    {o.summary ? ` · ${o.summary}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            {outline && !ops.length && <p className="col-span-2 text-xs text-muted">No operation of this document has a JSON request body.</p>}
          </div>
        ) : (
          <Field label="JSON schema of one row (YAML or JSON)">
            <Textarea autoGrow={false} className="field mono text-xs h-40" value={schema} onChange={(e) => setSchema(e.target.value)} aria-label="JSON schema" spellCheck={false} />
          </Field>
        )}
        <div className="flex items-end gap-3 flex-wrap">
          <Field label="Name" className="flex-1 min-w-[12rem]">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="patients" aria-label="Dataset name" />
          </Field>
          <Field label="Rows" className="w-24">
            <Input type="number" min={1} max={100000} value={rows} onChange={(e) => setRows(e.target.value)} aria-label="Rows" />
          </Field>
          <Toggle checked={overwrite} onChange={setOverwrite} label="Replace one of the same name" />
        </div>
        <p className="text-xs text-muted flex items-center gap-1">
          <Sparkles size={12} /> Agents and the terminal do the same: <span className="mono">generate_dataset</span>, <span className="mono">testpion generate-data</span>.
        </p>
      </div>
    </Modal>
  );
}
