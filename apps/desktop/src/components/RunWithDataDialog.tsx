import { FileSpreadsheet, Layers, Play, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { selectEnvironments, toastError, useApp } from '../store';
import { hasNativeDialogs, pickTextFile } from '../lib/files';
import { Button, Field, Input, Modal, Segmented, Select, Toggle, cx } from './ui';

interface DataFile {
  path: string;
  name: string;
  count?: number;
  tables?: string[];
  query?: string;
}

/** What the dialog started: a data-driven run or an environment matrix (its id: data-… / matrix-…). */
export type ScaleStart = { id: string; kind: 'data' | 'matrix' };

/**
 * "Run with data…": a flow file once per row of a data file (a workspace dataset, a file picked or uploaded, a
 * database URL with a query, or the file's own `data:`) with rows at once and Stop at the first failing row; or "in
 * environments": the flow in each environment picked, compared step by step. Starts tests.dataRun / tests.matrixRun
 * and hands the id to `onStarted` (the Tests view shows its grid). The flow designer can open it for its file.
 */
export function RunWithDataDialog({ file, initial = 'data', onClose, onStarted }: { file: string; initial?: 'data' | 'matrix'; onClose(): void; onStarted(s: ScaleStart): void }) {
  const [mode, setMode] = useState<'data' | 'matrix'>(initial);
  const envs = useApp(selectEnvironments);
  const activeEnv = useApp((s) => s.environment);
  const [datasets, setDatasets] = useState<DataFile[]>([]);
  const [source, setSource] = useState('');
  const [picked, setPicked] = useState<DataFile>();
  const [url, setUrl] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState('');
  const [concurrency, setConcurrency] = useState('1');
  const [bail, setBail] = useState(false);
  const [environment, setEnvironment] = useState(activeEnv ?? '');
  const [chosen, setChosen] = useState<string[]>(activeEnv ? [activeEnv] : []);
  const [starting, setStarting] = useState(false);
  useEffect(() => void call<DataFile[]>('datasets.list').then(setDatasets, () => setDatasets([])), []);

  const all = [...datasets, ...(picked && !datasets.some((d) => d.path === picked.path) ? [picked] : [])];
  const current = all.find((d) => d.path === source);
  const needsQuery = !!url || !!current?.tables?.length || /\.(db|db3|sqlite|sqlite3)$/i.test(source);
  const pick = async () => {
    try {
      let d: DataFile | null;
      if (hasNativeDialogs()) d = await call<DataFile | null>('col.pickDataFile');
      else {
        const f = await pickTextFile('.csv,.json,.jsonl');
        d = f ? await call<DataFile>('col.uploadDataFile', { name: f.name, text: f.text }) : null;
      }
      if (d) {
        setPicked(d);
        setSource(d.path);
        setUrl('');
        if (d.query) setQuery(d.query);
      }
    } catch (e) {
      useApp.getState().toast(`Could not read the data file: ${asError(e).message}`, 'error');
    }
  };
  const start = async () => {
    setStarting(true);
    try {
      if (mode === 'data') {
        const r = await call<{ id: string }>('tests.dataRun', {
          file,
          data: url.trim() || source || undefined,
          dataQuery: needsQuery && query.trim() ? query.trim() : undefined,
          limit: Number(limit) > 0 ? Number(limit) : undefined,
          concurrency: Math.min(32, Math.max(1, Number(concurrency) || 1)),
          bail,
          environment: environment || undefined,
        });
        onStarted({ id: r.id, kind: 'data' });
      } else {
        const r = await call<{ id: string }>('tests.matrixRun', { file, environments: chosen });
        onStarted({ id: r.id, kind: 'matrix' });
      }
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setStarting(false);
    }
  };
  const usable = envs.filter((e) => !e.problem);
  return (
    <Modal
      title={`Run ${file.split('/').pop()} at scale`}
      onClose={onClose}
      onSubmit={() => void start()}
      width={560}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Play size={12} />} loading={starting} disabled={mode === 'matrix' && !chosen.length} reason="Tick at least one environment" data-scale-start onClick={() => void start()}>
            {mode === 'data' ? 'Run per row' : `Run in ${chosen.length} environment${chosen.length === 1 ? '' : 's'}`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-run-with-data>
        <Segmented
          label="Run the flow"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'data', label: 'Once per data row', icon: <FileSpreadsheet size={12} /> },
            { value: 'matrix', label: 'In several environments', icon: <Layers size={12} /> },
          ]}
        />
        {mode === 'data' ? (
          <>
            <Field label="Data" hint="Each row is one run of the flow: its columns are variables ({{email}}), with {{$row.email}} and {{$index}} (from 0). CSV, JSON, JSONL or a SQLite database.">
              <div className="flex gap-2">
                <Select className="flex-1" aria-label="Data source" value={url ? '' : source} onChange={(e) => (setSource(e.target.value), setUrl(''))}>
                  <option value="">The file’s own data:</option>
                  {all.map((d) => (
                    <option key={d.path} value={d.path}>
                      {d.name}
                      {d.count !== undefined ? ` (${d.count} rows)` : ''}
                    </option>
                  ))}
                </Select>
                <Button icon={<Upload size={12} />} onClick={() => void pick()}>
                  Pick a file…
                </Button>
              </div>
            </Field>
            <Field label="Or a database" hint="postgres://… / mysql://… ({{variables}} from the environment work, e.g. for the password) or env:NAME">
              <Input className="mono" aria-label="Database URL" placeholder="postgres://user:{{dbPassword}}@localhost:5432/app" value={url} onChange={(e) => setUrl(e.target.value)} />
            </Field>
            {needsQuery && (
              <Field label="Query" hint="The SELECT whose rows are the runs (read-only)">
                <Input className="mono" aria-label="Query" placeholder="SELECT * FROM users" value={query} onChange={(e) => setQuery(e.target.value)} />
              </Field>
            )}
            <div className="grid grid-cols-3 gap-2">
              <Field label="Environment">
                <Select aria-label="Environment" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                  <option value="">No environment</option>
                  {usable.map((e) => (
                    <option key={e.name} value={e.name}>
                      {e.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rows at once">
                <Input type="number" min={1} max={32} aria-label="Rows at once" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
              </Field>
              <Field label="At most (rows)">
                <Input type="number" min={1} aria-label="Row limit" placeholder="all" value={limit} onChange={(e) => setLimit(e.target.value)} />
              </Field>
            </div>
            <Toggle checked={bail} onChange={setBail} label="Stop at the first failing row" />
          </>
        ) : (
          <Field label="Environments" hint="The flow runs once in each, side by side: each step's status and time, and the values it extracted with those that differ marked.">
            <div className="flex flex-col rounded-md border border-line max-h-64 overflow-auto" role="group" aria-label="Environments">
              {usable.length ? (
                usable.map((e) => {
                  const on = chosen.includes(e.name);
                  return (
                    <label key={e.name} className={cx('flex items-center gap-2 px-2.5 py-1.5 text-sm border-b border-line/50 last:border-0 cursor-pointer hover:bg-hover', on && 'bg-accent/5')}>
                      <input type="checkbox" checked={on} data-matrix-env={e.name} onChange={() => setChosen((c) => (on ? c.filter((x) => x !== e.name) : [...c, e.name]))} />
                      {e.name}
                    </label>
                  );
                })
              ) : (
                <span className="p-2.5 text-xs text-muted">No environments yet: add some in Environments.</span>
              )}
            </div>
          </Field>
        )}
      </div>
    </Modal>
  );
}
