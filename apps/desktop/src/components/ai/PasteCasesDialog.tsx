import { useMemo, useState } from 'react';
import { caseColumns, guessCaseColumns, mapCaseColumns, parsePastedCases, type CaseRow } from '@testpion/shared';
import { plural } from '../../lib/format';
import { Button, Field, Modal, Select, Textarea, Toggle } from '../ui';

/**
 * Paste cases (AU-10): cells copied from a spreadsheet, a CSV, JSONL or a JSON list. The columns are found, the one that
 * holds the input and the one that holds the expected answer are guessed and can be changed, and the cases are added to
 * the table or replace it.
 */
export function PasteCasesDialog({ inputName, expectedField, initial, onApply, onClose }: { inputName: string; expectedField: string; initial?: string; onApply(rows: CaseRow[], mode: 'add' | 'replace'): void; onClose(): void }) {
  const [text, setText] = useState(initial ?? '');
  const [header, setHeader] = useState<boolean | undefined>(undefined);
  const parsed = useMemo(() => parsePastedCases(text, { header }), [text, header]);
  const guess = useMemo(() => guessCaseColumns(parsed?.columns ?? [], expectedField), [parsed, expectedField]);
  const [input, setInput] = useState<string>();
  const [expected, setExpected] = useState<string>();
  const columns = parsed?.columns ?? [];
  const inCol = input && columns.includes(input) ? input : (guess.input ?? columns[0] ?? '');
  const exCol = expected !== undefined && (expected === '' || columns.includes(expected)) ? expected : (guess.expected ?? (columns.length > 1 ? columns.find((c) => c !== inCol) : undefined) ?? '');
  const mapped = (): CaseRow[] => {
    if (!parsed) return [];
    const mapping: Record<string, string> = {};
    if (inCol && inCol !== inputName) mapping[inCol] = inputName;
    if (exCol && exCol !== expectedField) mapping[exCol] = expectedField;
    return mapCaseColumns(parsed.rows, mapping);
  };
  const finalColumns = caseColumns(mapped());
  const apply = (mode: 'add' | 'replace') => {
    onApply(mapped(), mode);
    onClose();
  };
  const why = !parsed ? 'Paste some cases first' : undefined;
  return (
    <Modal
      title="Paste test cases"
      onClose={onClose}
      onSubmit={() => parsed && apply('add')}
      width={620}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button onClick={() => apply('replace')} disabled={!parsed} reason={why} data-paste-replace>
            Replace the table
          </Button>
          <Button variant="primary" onClick={() => apply('add')} disabled={!parsed} reason={why} data-paste-add>
            Add to the table
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-paste-dialog>
        <Field label="Cases" hint="Copy cells from a spreadsheet, or paste a CSV file, JSONL lines or a JSON list. One case per row.">
          <Textarea className="mono text-xs h-40" value={text} onChange={(e) => setText(e.target.value)} placeholder={'message\tanswer\nCancel my appointment\tcancellation'} aria-label="Pasted cases" data-paste-text />
        </Field>
        {parsed ? (
          <>
            <div className="text-sm" data-paste-found>
              Found {plural(parsed.rows.length, 'case')} with {plural(columns.length, 'column')}: {columns.join(', ')}.
            </div>
            {parsed.format === 'csv' && <Toggle checked={header ?? !parsed.headerless} onChange={(v) => setHeader(v)} label="The first row names the columns" />}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Input column" hint={`Becomes “${inputName}”, the name the prompt fills in`}>
                <Select value={inCol} onChange={(e) => setInput(e.target.value)} aria-label="Input column">
                  {columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Expected answer column" hint={`Becomes “${expectedField}”, or none`}>
                <Select value={exCol} onChange={(e) => setExpected(e.target.value)} aria-label="Expected answer column">
                  <option value="">None</option>
                  {columns
                    .filter((c) => c !== inCol)
                    .map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <div className="text-xs text-muted">The table will have the columns: {finalColumns.join(', ')}.</div>
          </>
        ) : (
          <div className="text-sm text-muted">Nothing found yet.</div>
        )}
      </div>
    </Modal>
  );
}
