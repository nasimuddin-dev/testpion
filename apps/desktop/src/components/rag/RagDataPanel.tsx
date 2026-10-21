import { Database, Radio } from 'lucide-react';
import { useState } from 'react';
import { useRpc } from '../../lib/use-rpc';
import { AiAction } from '../ai/AiAction';
import { Badge, Button, Empty, Spinner, cx } from '../ui';
import { RagCaptureDialog } from './RagCaptureDialog';
import { RagTestsetDialog } from './RagTestsetDialog';

interface DatasetRow {
  path: string;
  name: string;
  format: string;
  records?: number;
}

const useDatasets = () => useRpc<{ datasets: DatasetRow[] }>('rag.testset.sources', undefined, { reloadOn: ['data.changed'], keep: true });

/** AI Lab ▸ RAG ▸ Data, the list: the datasets of the workspace with their record counts (the files of datasets/). */
export function RagDatasetsList() {
  const data = useDatasets();
  if (!data)
    return (
      <div className="p-4 grid place-items-center">
        <Spinner />
      </div>
    );
  return (
    <div className="flex flex-col min-h-0 h-full" data-rag-datasets-list>
      <div className="px-2 py-1.5 border-b border-line text-xs font-semibold text-muted uppercase tracking-wide">Datasets</div>
      <div className="flex-1 min-h-0 overflow-auto">
        {data.datasets.map((d) => (
          <div key={d.path} className={cx('px-3 py-2 border-b border-line/60 text-sm')} data-rag-dataset-row={d.name}>
            <div className="flex items-center gap-1.5">
              <Database size={12} className="text-muted" />
              <span className="truncate font-medium">{d.name}</span>
              <Badge>{d.format}</Badge>
            </div>
            <div className="text-xs text-muted">{d.records !== undefined ? `${d.records} record${d.records === 1 ? '' : 's'}` : 'records not counted'}</div>
            {d.format === 'jsonl' && (
              <AiAction
                variant="link"
                label="Draft reference answers…"
                hint="The AI writes a reference answer for each record that has none, from the passages that record retrieved (not from the system’s own answer); each draft is checked against its passages and offered for you to review before anything is written."
                request={() => ({ task: 'rag-draft-references', title: `Draft reference answers for ${d.name}`, context: { dataset: d.name } })}
              />
            )}
          </div>
        ))}
        {!data.datasets.length && <Empty title="No datasets yet">Generate a test set from your documents, or build one from real calls. A dataset is a file in datasets/ that an evaluation runs.</Empty>}
      </div>
    </div>
  );
}

/** AI Lab ▸ RAG ▸ Data, the page: the two ways to make a dataset (from documents with AI, from captured calls without it). */
export function RagDataIntro() {
  const [dialog, setDialog] = useState<'generate' | 'capture'>();
  return (
    <>
      <h2 className="text-lg font-semibold mb-1">Datasets for a RAG system</h2>
      <p className="text-muted max-w-2xl mb-4">
        An evaluation needs questions. Make them from your own documents, with reference answers and the passages they come from, each one checked before you see it; or build them from the calls your users already made.
      </p>
      <div className="flex gap-2 flex-wrap mb-6" data-rag-data-actions>
        <AiAction variant="primary" label="Generate a test set from documents…" hint="The AI writes questions with reference answers from chunks of your documents; every question is verified and offered for review. Cost and what will be sent are shown first." open={() => setDialog('generate')} request={() => ({ task: 'rag-generate-testset', title: 'Generate a RAG test set', context: {} })} preview={false} />
        <Button icon={<Radio size={13} />} onClick={() => setDialog('capture')} data-rag-capture-open>
          Create dataset from captured calls…
        </Button>
      </div>
      <ol className="list-decimal pl-5 text-muted flex flex-col gap-1 max-w-2xl">
        <li>From documents: pick files, a folder or public pages; TestPion splits them into passages the same way every time and the AI asks single-hop, multi-hop, abstract, unanswerable and adversarial questions about them.</li>
        <li>Each question is checked: its reference is supported by its passages, an unanswerable one is not answerable from your documents, and nothing repeats. Review them, then add the ones you want to the dataset.</li>
        <li>From calls: History, a saved Debugger session, a HAR file or a run become records with the question, the answer and the retrieved contexts; secrets and personal data are masked and nothing is sent to a model.</li>
      </ol>
      {dialog === 'generate' && <RagTestsetDialog onClose={() => setDialog(undefined)} />}
      {dialog === 'capture' && <RagCaptureDialog onClose={() => setDialog(undefined)} />}
    </>
  );
}
