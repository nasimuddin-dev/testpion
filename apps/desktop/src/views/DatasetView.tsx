import { Copy, Database, Play, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { asError, call, on } from '../api';
import { persisted, toastError, useApp } from '../store';
import { useIntent, useSaveShortcut } from '../hooks';
import { useDoc } from '../lib/docs';
import { useSticky } from '../lib/sticky';
import { copyText } from '../lib/clipboard';
import { plural } from '../lib/format';
import { datasetBadge, datasetYaml } from '../lib/datasets';
import { dataLanguageOf } from '../data-languages';
import { CodeEditor } from '../components/CodeEditor';
import { JsonTable } from '../components/JsonTable';
import { useSingleEditorTab } from '../components/EditorTabs';
import { Badge, Button, Empty, Field, Input, Tabs } from '../components/ui';

type Tab = 'preview' | 'file';

/** Which dataset each tab shows (each tab is its own document). */
const tabDataset = persisted<{ dataset?: string }>('dataset', {});

interface OpenedDataset {
  name: string;
  path: string;
  text: string;
  format: string;
  size: number;
  /** A SQLite database: not shown as text. */
  binary: boolean;
}

interface Preview {
  count: number;
  columns: Array<{ name: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  tables?: string[];
  query?: string;
}

const PREVIEW_ROWS = 200;

/**
 * A dataset (a file in the workspace's datasets/ folder) in its own tab, like an API definition: the first rows as a
 * table with each column's kind of value, the file itself in the editor (Save, Ctrl+S), how many rows and columns it
 * has, and the two things people do with one: run a collection with it, or copy the `dataset:` block for a test.
 */
export function DatasetView() {
  const { docId } = useDoc();
  const docState = useMemo(() => tabDataset.forDoc(docId), [docId]);
  const [name, setName] = useState<string | undefined>(() => docState.load().dataset);
  useEffect(() => docState.save({ dataset: name }), [name, docState]);
  const [tab, setTab] = useSticky<Tab>(`dataset:tab:${docId ?? 'main'}`, 'preview');
  useIntent('dataset', (p) => {
    if (p?.dataset) setName(p.dataset as string);
    if (p?.tab === 'preview' || p?.tab === 'file') setTab(p.tab);
  });

  const [file, setFile] = useState<OpenedDataset>();
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  // a SQLite database: the query whose rows the preview shows
  const [query, setQuery] = useState('');

  const loadPreview = useCallback(async (ds: string, q?: string) => {
    try {
      setPreview(await call<Preview>('datasets.preview', { name: ds, limit: PREVIEW_ROWS, query: q || undefined }));
    } catch (e) {
      setPreview(undefined);
      setError(asError(e).message);
    }
  }, []);
  const load = useCallback(
    async (ds: string) => {
      setError(undefined);
      try {
        const f = await call<OpenedDataset>('datasets.open', { name: ds });
        setFile(f);
        setText(f.text);
        setSaved(f.text);
        await loadPreview(ds);
      } catch (e) {
        setFile(undefined);
        setPreview(undefined);
        setError(asError(e).message);
      }
    },
    [loadPreview],
  );
  useEffect(() => {
    if (name) void load(name);
  }, [name, load]);
  const dirty = text !== saved;
  // the file changed elsewhere (a run appended rows, an agent, the Collection Runner's Generate…): shown fresh unless edited here
  useEffect(() => {
    if (!name) return;
    return on<{ kind?: string }>('data.changed', (p) => {
      if (p?.kind === 'datasets' && !dirty) void load(name);
    });
  }, [name, dirty, load]);

  const save = async () => {
    if (!name || !dirty) return;
    try {
      await call('datasets.write', { name, text });
      setSaved(text);
      useApp.getState().toast(`Saved datasets/${name}`, 'success');
      await loadPreview(name, query);
    } catch (e) {
      toastError(e);
    }
  };
  useSaveShortcut('dataset', () => void save());

  const badge = datasetBadge(file?.format ?? (name ? dataLanguageOf(name) : ''));
  useSingleEditorTab('dataset', name ? { title: name, badge: badge.text, badgeClass: badge.cls, item: name, dirty } : undefined);

  const runCollection = () => {
    if (!file) return;
    useApp.getState().openIntent('collections', { run: true, dataPath: file.path });
  };
  const useInTest = () => void copyText(datasetYaml(name!, file?.binary ? query : undefined), 'the dataset block for a test file');

  if (!name)
    return (
      <Empty icon={<Database size={28} />} title="Open a dataset">
        Pick a file under <b>Datasets</b> in the sidebar: the rows it holds, its columns, and the file itself. Tests and collection runs read it.
      </Empty>
    );
  const columnTypes = preview ? Object.fromEntries(preview.columns.map((c) => [c.name, c.type])) : undefined;
  return (
    <div className="h-full flex flex-col min-w-0" data-dataset-view={name}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line shrink-0 min-w-0">
        <Database size={16} className="text-muted shrink-0" />
        <span className="font-semibold truncate" title={file?.path}>
          {name}
        </span>
        <Badge>{badge.text}</Badge>
        {preview && !(file?.binary && !query) && (
          <span className="text-xs text-muted shrink-0" data-dataset-counts>
            {plural(preview.count, 'row')} · {plural(preview.columns.length, 'column')}
          </span>
        )}
        {file && <span className="text-xs text-muted shrink-0">{(file.size / 1024).toFixed(1)} KB</span>}
        <span className="flex-1" />
        <Button icon={<Play size={14} />} disabled={!file} onClick={runCollection} title="Open the Collection Runner with this dataset as its data; pick the collection there">
          Run a collection with this dataset
        </Button>
        <Button icon={<Copy size={14} />} onClick={useInTest} title="Copy the `dataset:` block that makes a YAML test read this file">
          Use in a test
        </Button>
        {!file?.binary && (
          <Button icon={<Save size={14} />} disabled={!dirty} onClick={() => void save()} title="Save (Ctrl+S)">
            Save
          </Button>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'preview', label: 'Preview' },
          { id: 'file', label: 'File' },
        ]}
      />
      <div className="flex-1 min-h-0 flex flex-col">
        {error && !file ? (
          <Empty title="Couldn't open the dataset">{error}</Empty>
        ) : tab === 'preview' ? (
          <>
            {file?.binary && (
              <div className="flex items-end gap-2 px-3 py-2 border-b border-line shrink-0">
                <Field label="Query" className="flex-1" hint={preview?.tables?.length ? `Tables: ${preview.tables.join(', ')}` : undefined}>
                  <Input
                    className="mono"
                    value={query}
                    placeholder={preview?.tables?.[0] ? `SELECT * FROM ${preview.tables[0]}` : 'SELECT …'}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void loadPreview(name, query)}
                    aria-label="SQL query for the rows"
                  />
                </Field>
                <Button onClick={() => void loadPreview(name, query)} disabled={!query.trim()}>
                  Run query
                </Button>
              </div>
            )}
            {preview && preview.rows.length ? (
              <div className="flex-1 min-h-0" data-dataset-preview>
                <JsonTable rows={preview.rows} path={`datasets/${name}`} columnTypes={columnTypes} />
                {preview.count > preview.rows.length && (
                  <p className="text-xs text-muted px-2 py-1 border-t border-line">
                    The first {PREVIEW_ROWS} of {plural(preview.count, 'row')}; the File tab has them all.
                  </p>
                )}
              </div>
            ) : (
              <Empty title={error ?? (file?.binary && !query ? 'A database: write a query' : 'No rows yet')}>
                {error
                  ? ''
                  : file?.binary
                    ? 'Its rows are those of a SELECT; the tables are listed above.'
                    : 'Add rows in the File tab (a CSV starts with its header line), or generate test data from the sidebar.'}
              </Empty>
            )}
          </>
        ) : file?.binary ? (
          <Empty title="A SQLite database">It isn't edited as text; the Preview tab reads it with a query.</Empty>
        ) : (
          <CodeEditor language={dataLanguageOf(name)} path={`datasets/${name}`} value={text} onChange={setText} />
        )}
      </div>
    </div>
  );
}
