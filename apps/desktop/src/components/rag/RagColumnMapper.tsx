import { useEffect, useState } from 'react';
import type { ColumnMapping, RagField } from '@testpion/core';
import { call } from '../../api';
import { toastError } from '../../store';
import { useDebounced } from '../ui';
import { Badge, Button, Callout, Field, Modal, Select } from '../ui';

interface Mapped {
  columns: string[];
  fields: Array<{ field: RagField; label: string; required?: true; list?: true }>;
  mapping: ColumnMapping;
  count: number;
  preview: Array<Record<string, unknown>>;
  kept: string[];
  notes: string[];
  text: string;
}

/**
 * The dataset column mapper: a dataset whose columns are named as its author liked (prompt, gold_answer, doc_ids) is read
 * as RAG records by choosing which column is the question, the reference answer, the gold chunk ids … The guess comes from
 * the names other tools use; the preview shows the records the choice gives, and the columns that are not mapped stay as
 * extra fields ({{variables}}). Apply rewrites the dataset as TestPion's JSON Lines.
 */
export function RagColumnMapper({ dataset, format, onApply, onClose }: { dataset: string; format: string; onApply(text: string): void; onClose(): void }) {
  const [mapping, setMapping] = useState<ColumnMapping>();
  const [m, setM] = useState<Mapped>();
  const debounced = useDebounced(mapping, 150);
  useEffect(() => {
    let live = true;
    void call<Mapped>('rag.columns', { text: dataset, name: `dataset.${format === 'md' ? 'jsonl' : format}`, mapping: debounced }).then(
      (r) => {
        if (!live) return;
        setM(r);
        setMapping((cur) => cur ?? r.mapping);
      },
      (e) => live && toastError(e),
    );
    return () => {
      live = false;
    };
  }, [dataset, format, debounced]);
  const set = (field: RagField, col: string) => setMapping({ ...(mapping ?? {}), [field]: col || undefined });
  return (
    <Modal
      title="Map the columns of the dataset"
      onClose={onClose}
      width={820}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!m || !m.count || !mapping?.question} onClick={() => m && (onApply(m.text), onClose())} data-rag-mapper-apply>
            Use these {m?.count ?? 0} records
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-rag-mapper>
        {!m ? (
          <div className="text-muted">Reading the columns …</div>
        ) : (
          <>
            <div className="text-xs text-muted">Your dataset has these columns: {m.columns.map((c) => <Badge key={c}>{c}</Badge>).reduce<React.ReactNode[]>((a, b, i) => (i ? [...a, ' ', b] : [b]), [])}. Choose which one holds each part of a RAG record.</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-2">
              {m.fields.map((f) => (
                <Field key={f.field} label={`${f.label}${f.required ? ' *' : ''}`}>
                  <Select value={mapping?.[f.field] ?? ''} onChange={(e) => set(f.field, e.target.value)} aria-label={f.label} data-rag-map-field={f.field}>
                    <option value="">{f.required ? 'Choose a column' : 'None'}</option>
                    {m.columns.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            {m.notes.map((n) => (
              <Callout key={n} tone="warn">
                {n}
              </Callout>
            ))}
            <div>
              <div className="text-xs text-muted mb-1">
                The records this gives ({m.count}){m.kept.length ? ` · kept as extra fields: ${m.kept.join(', ')}` : ''}
              </div>
              <pre className="mono text-xs p-2 rounded-lg border border-line max-h-48 overflow-auto whitespace-pre-wrap" data-rag-mapper-preview>
                {m.preview.map((r) => JSON.stringify(r)).join('\n')}
              </pre>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
