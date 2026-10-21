import { useState } from 'react';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { pickTextFile } from '../../lib/files';
import { Button, Callout, Field, Modal, Select } from '../ui';

type Format = 'auto' | 'ragas' | 'deepeval' | 'nvidia' | 'promptfoo' | 'beir';

const FORMATS: Array<{ id: Format; label: string; hint: string }> = [
  { id: 'auto', label: 'Find it from the columns', hint: 'Ragas, DeepEval, NVIDIA retriever data and promptfoo files are recognised by their column names.' },
  { id: 'ragas', label: 'Ragas', hint: 'An EvaluationDataset / SingleTurnSample file: user_input, reference, reference_contexts, reference_context_ids, response, retrieved_contexts.' },
  { id: 'deepeval', label: 'DeepEval', hint: 'Goldens or test cases: input, expected_output, context, actual_output, retrieval_context.' },
  { id: 'nvidia', label: 'NVIDIA retriever data', hint: 'query + pos_doc / positive_passages (the gold chunks) and optional negatives.' },
  { id: 'promptfoo', label: 'promptfoo tests', hint: 'A config or list of tests (YAML or JSON): vars (the question, a context) and assertions (the expected value).' },
  { id: 'beir', label: 'BEIR (queries + qrels)', hint: 'queries.jsonl, the qrels file (query-id, corpus-id, score) and optionally corpus.jsonl for the gold texts.' },
];

/**
 * Import a dataset another tool wrote (data only: nothing in a file is executed) as RAG records: Ragas, DeepEval, NVIDIA
 * retriever data, promptfoo tests, and BEIR's three files. What was left out or changed is said. One dialog for every format.
 */
export function RagImportDialog({ onImport, onClose }: { onImport(text: string): void; onClose(): void }) {
  const [format, setFormat] = useState<Format>('auto');
  const [files, setFiles] = useState<{ file?: { name: string; text: string }; qrels?: { name: string; text: string }; corpus?: { name: string; text: string } }>({});
  const [notes, setNotes] = useState<string[]>([]);
  // how many records came in: the dialog stays open to show the notes, and a second Import would add the same records again
  const [imported, setImported] = useState<number>();
  const f = FORMATS.find((x) => x.id === format)!;
  const pick = async (key: 'file' | 'qrels' | 'corpus', accept = '.jsonl,.json,.csv,.tsv,.ndjson,.yaml,.yml') => {
    const picked = await pickTextFile(accept);
    if (picked) {
      setFiles((s) => ({ ...s, [key]: picked }));
      setImported(undefined);
      setNotes([]);
    }
  };
  const run = async () => {
    try {
      const r =
        format === 'beir'
          ? await call<{ count: number; notes: string[]; text: string }>('rag.importBeir', { queries: files.file!.text, qrels: files.qrels!.text, corpus: files.corpus?.text })
          : await call<{ from: string; count: number; notes: string[]; text: string }>('rag.convert', { text: files.file!.text, name: files.file!.name, from: format === 'auto' ? undefined : format });
      setNotes(r.notes);
      setImported(r.count);
      onImport(r.text);
      useApp.getState().toast(`Imported ${r.count} records${r.notes.length ? `. ${r.notes[0]}` : ''}`, r.notes.length ? 'info' : 'success');
      if (!r.notes.length) onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const ready = !!files.file && (format !== 'beir' || !!files.qrels) && imported === undefined;
  return (
    <Modal
      title="Import a dataset"
      onClose={onClose}
      width={600}
      footer={
        <>
          <Button onClick={onClose}>{imported !== undefined ? 'Close' : 'Cancel'}</Button>
          <Button variant="primary" disabled={!ready} onClick={() => void run()} data-rag-import-run>
            Import
          </Button>
        </>
      }
    >
      <div className="grid gap-3 text-sm" data-rag-import-dialog>
        <Field label="Format" hint={f.hint}>
          <Select value={format} onChange={(e) => setFormat(e.target.value as Format)} aria-label="Dataset format">
            {FORMATS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </Select>
        </Field>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void pick('file')} data-rag-import-file>
            {format === 'beir' ? 'Queries…' : 'Choose the file…'}
          </Button>
          <span className="text-xs text-muted">{files.file?.name ?? 'no file'}</span>
        </div>
        {format === 'beir' && (
          <>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void pick('qrels', '.tsv,.txt,.csv,.qrels')} data-rag-import-qrels>
                Qrels…
              </Button>
              <span className="text-xs text-muted">{files.qrels?.name ?? 'required'}</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void pick('corpus', '.jsonl,.json')}>
                Corpus…
              </Button>
              <span className="text-xs text-muted">{files.corpus?.name ?? 'optional: fills the gold texts'}</span>
            </div>
          </>
        )}
        {imported !== undefined && (
          <p className="text-ok" role="status" data-rag-import-done>
            Imported {imported} {imported === 1 ? 'record' : 'records'}. Choose another file to import more.
          </p>
        )}
        {notes.map((n) => (
          <Callout key={n} tone="warn">
            {n}
          </Callout>
        ))}
      </div>
    </Modal>
  );
}
