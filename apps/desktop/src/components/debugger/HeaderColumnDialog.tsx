import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { Button, Field, Input, Select, Modal } from '../ui';
import { MAX_HEADER_COLUMNS, headerKey, type HeaderColumnDef } from './grid-columns';

/** Columns ▸ Add column from a header…: a header of the request or the response becomes a column (X-Request-Id, Cache-Control …). */
export function HeaderColumnDialog({ existing, onAdd, onClose }: { existing: HeaderColumnDef[]; onAdd(c: HeaderColumnDef): void; onClose(): void }) {
  const [name, setName] = useState('');
  const [side, setSide] = useState<HeaderColumnDef['side']>('response');
  const clean = name.trim();
  const problem = !clean
    ? 'Type the header name'
    : !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/.test(clean)
      ? 'A header name has letters, digits and - only'
      : existing.some((c) => headerKey(c) === headerKey({ name: clean, side }))
        ? 'That column is already there'
        : existing.length >= MAX_HEADER_COLUMNS
          ? `At most ${MAX_HEADER_COLUMNS} header columns`
          : undefined;
  const add = () => {
    if (problem) return;
    onAdd({ name: clean, side });
    onClose();
  };
  return (
    <Modal
      title="Add a column from a header"
      onClose={onClose}
      width={460}
      onSubmit={add}
      footer={
        <>
          <Button icon={<X size={13} />} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Check size={13} />} disabled={!!problem} reason={problem} onClick={add}>
            Add column
          </Button>
        </>
      }
    >
      <div className="grid gap-3" data-header-column-dialog>
        <p className="text-xs text-muted">Shows one header of every exchange as a column you can sort. Secret headers (Authorization, Cookie) show as ***.</p>
        <Field label="Header name" hint="X-Request-Id, Cache-Control, Server …">
          <Input className="mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="X-Request-Id" aria-label="Header name" />
        </Field>
        <Field label="Read it from">
          <Select value={side} aria-label="Read it from" onChange={(e) => setSide(e.target.value as HeaderColumnDef['side'])}>
            <option value="response">the response</option>
            <option value="request">the request</option>
          </Select>
        </Field>
      </div>
    </Modal>
  );
}
