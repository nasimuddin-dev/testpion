import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { casesToJsonl, datasetFormatOfName, datasetRecords, SHOULD_CALL, SHOULD_NOT_CALL, type CaseRow, type DatasetTextFormat } from '@testpion/shared';
import { call } from '../../api';
import { useSticky } from '../../lib/sticky';
import { pickTextFile } from '../../lib/files';
import { toastError } from '../../store';
import { Button, Callout, cx, Input, Segmented, Select, Split } from '../ui';
import { CodeEditor } from '../CodeEditor';
import { CaseTable } from './CaseTable';
import { PasteCasesDialog } from './PasteCasesDialog';

/** The editor's language for each dataset format: colours, and each format's own checks (JSONL line by line). */
const EDITOR_LANGUAGE = { json: 'json', jsonl: 'jsonl', csv: 'csv', md: 'markdown' } as const;

/** An agent's case columns in plain words (AU-19): the task, and the tools it should and should not call. */
export const AGENT_HEADINGS: Record<string, string> = { input: 'Task for the agent', [SHOULD_CALL]: 'Should call', [SHOULD_NOT_CALL]: 'Should not call' };

interface CasesDraft {
  type: 'llm' | 'rag' | 'agent';
  dataset: string;
  datasetFormat: DatasetTextFormat;
  expectedField: string;
}

/**
 * The Test cases tab of an evaluation. A prompt evaluation shows the cases as a table you type in or paste into (AU-10);
 * "Edit as text" is the same cases as the file's own text (JSONL, JSON, CSV, Markdown), and a bot with sources keeps the text
 * editor, its import and its column mapping. Moved out of EvaluationsView.
 */
export function CasesPane({
  d,
  set,
  count,
  readAs,
  preview,
  previewKeys,
  vars,
  ragTarget,
  datasets,
  onImport,
  onMap,
  onExportRag,
  onExample,
  onGenerate,
}: {
  d: CasesDraft;
  set(p: Partial<CasesDraft>): void;
  count: number;
  /** The format the text really has. */
  readAs: DatasetTextFormat;
  preview: Array<Record<string, unknown>>;
  previewKeys: string[];
  vars: string[];
  /** The evaluation calls a bot with sources. */
  ragTarget: boolean;
  datasets: Array<{ path: string; name: string }>;
  onImport(): void;
  onMap(): void;
  onExportRag(to: 'ragas' | 'deepeval'): void;
  onExample(): void;
  /** Write cases with AI (AU-13): the button is shown for a prompt evaluation when this is given. */
  onGenerate?(): void;
}) {
  const [view, setView] = useSticky<'table' | 'text'>('eval:casesView', 'table', { persist: true });
  const [pasting, setPasting] = useState(false);
  // a bot with sources keeps its text editor: its records hold lists and objects
  const table = d.type !== 'rag' && view === 'table';
  const inputName = vars.find((v) => v !== d.expectedField) ?? 'input';
  const apply = (rows: CaseRow[], mode: 'add' | 'replace') => {
    const own = mode === 'add' ? datasetRecords(d.dataset, d.datasetFormat) : [];
    set({ dataset: casesToJsonl([...own, ...rows]), datasetFormat: 'jsonl' });
  };
  const load = (text: string, name: string) => set({ dataset: text, datasetFormat: datasetFormatOfName(name) ?? 'jsonl' });
  const columns = Array.from(new Set(datasetRecords(d.dataset, d.datasetFormat, 200).flatMap((r) => Object.keys(r))));
  return (
    <div className="h-full flex flex-col">
      {pasting && <PasteCasesDialog inputName={inputName} expectedField={d.expectedField} onApply={apply} onClose={() => setPasting(false)} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-sm border-b border-line">
        {d.type !== 'rag' && (
          <Segmented
            label="Test cases as"
            size="xs"
            value={view}
            onChange={setView}
            options={[
              { value: 'table', label: 'Table', title: 'One row per case: type in the cells, paste from a spreadsheet' },
              { value: 'text', label: 'Edit as text', title: 'The cases as the text of a file: JSONL, JSON, CSV or Markdown' },
            ]}
          />
        )}
        {!table &&
          (['jsonl', 'json', 'csv', 'md'] as const).map((f) => (
            <label key={f} className="flex items-center gap-1">
              <input type="radio" checked={d.datasetFormat === f} onChange={() => set({ datasetFormat: f })} /> {f.toUpperCase()}
            </label>
          ))}
        <label className="ml-auto flex items-center gap-1 text-xs text-muted whitespace-nowrap">
          Expected answer column
          {table && columns.length > 0 ? (
            <Select className="h-6 min-h-6 w-32 text-xs py-0" value={d.expectedField} onChange={(e) => set({ expectedField: e.target.value })} aria-label="Expected answer column">
              {!columns.includes(d.expectedField) && <option value={d.expectedField}>{d.expectedField}</option>}
              {columns.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          ) : (
            <Input className="h-6 min-h-6 w-24 text-xs" value={d.expectedField} onChange={(e) => set({ expectedField: e.target.value })} />
          )}
        </label>
        {d.type === 'rag' && (
          <>
            <Button size="sm" onClick={onImport} title="Read the test cases of another tool (Ragas, DeepEval, BEIR, NVIDIA, promptfoo; only data is read) as cases for a bot with sources" data-rag-import>
              Import…
            </Button>
            <Button size="sm" onClick={onMap} title="Choose which column is the question, the expected answer, the right document ids …" data-rag-map-columns>
              Map columns…
            </Button>
            <Select className="h-7 min-h-7 py-0 text-xs max-w-32" aria-label="Export the test cases" value="" onChange={(e) => e.target.value && onExportRag(e.target.value as 'ragas' | 'deepeval')}>
              <option value="">Export as…</option>
              <option value="ragas">Ragas</option>
              <option value="deepeval">DeepEval</option>
            </Select>
          </>
        )}
        {d.type === 'llm' && onGenerate && (
          <Button size="sm" icon={<Sparkles size={12} />} onClick={onGenerate} title="Have AI write test cases from the prompt, an API definition, saved requests, documents or real calls; you read them before they are added" data-cases-generate>
            Generate with AI…
          </Button>
        )}
        {table && (
          <Button size="sm" onClick={() => setPasting(true)} title="Cells copied from a spreadsheet, a CSV file, JSONL lines or a JSON list" data-cases-paste>
            Paste cases…
          </Button>
        )}
        <Button size="sm" onClick={() => void pickTextFile('.jsonl,.json,.csv,.tsv,.md,.ndjson').then((f) => f && load(f.text, f.name))}>
          Load file…
        </Button>
        {datasets.length > 0 && (
          <Select
            className="h-7 min-h-7 py-0 text-xs max-w-48"
            aria-label="Load saved test cases"
            value=""
            onChange={async (e) => {
              if (!e.target.value) return;
              try {
                const r = await call<{ name: string; text: string }>('datasets.read', { path: e.target.value });
                load(r.text, r.name);
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <option value="">or saved test cases…</option>
            {datasets.map((x) => (
              <option key={x.path} value={x.path}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
      </div>
      {table ? (
        <div className="flex-1 min-h-0">
          <CaseTable text={d.dataset} format={d.datasetFormat} expectedField={d.expectedField} vars={vars} onChange={(dataset) => set({ dataset, datasetFormat: 'jsonl' })} onPaste={() => setPasting(true)} onExample={onExample} headings={d.type === 'agent' ? AGENT_HEADINGS : undefined} />
        </div>
      ) : (
        <>
          {readAs !== d.datasetFormat && (
            <Callout
              tone="warn"
              className="m-2 mb-0"
              data-format-mismatch="jsonl"
              action={
                <Button size="sm" onClick={() => set({ datasetFormat: readAs })}>
                  Switch to {readAs.toUpperCase()}
                </Button>
              }
            >
              This text has one JSON object per line, so it is read as {readAs.toUpperCase()}, not as one JSON document.
            </Callout>
          )}
          <div className="flex-1 min-h-0">
            <Split id="eval-dataset" direction="vertical" initial={65}>
              <CodeEditor language={EDITOR_LANGUAGE[readAs]} value={d.dataset} onChange={(dataset) => set({ dataset })} />
              <div className="h-full overflow-auto p-2 text-xs">
                <div className="text-muted mb-1">
                  Preview · {count} cases · each column is available as {'{{column}}'} in the prompt and checks
                  {d.type === 'rag' && (ragTarget ? ' · for a bot with sources: question, reference (the expected answer), reference_ids (the right document ids), reference_contexts' : ' · cases for a bot with sources need question, contexts [{id,text}] and optionally answer/expected')}
                </div>
                {preview.length > 0 && (
                  <table className="w-full">
                    <thead>
                      <tr>
                        {previewKeys.map((k) => (
                          <th key={k} className={cx('text-left px-1 font-medium', vars.includes(k) || k === d.expectedField ? 'text-accent' : 'text-muted')}>
                            {k}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((r, i) => (
                        <tr key={i} className="border-t border-line">
                          {previewKeys.map((k) => (
                            <td key={k} className="px-1 py-0.5 mono truncate max-w-48">
                              {typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </Split>
          </div>
        </>
      )}
    </div>
  );
}
