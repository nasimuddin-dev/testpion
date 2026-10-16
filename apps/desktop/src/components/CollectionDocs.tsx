import { Download, Eye, Globe, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { asError, call } from '../api';
import { toastError, useApp } from '../store';
import type { Collection } from '../types';
import { downloadContent, finishSave, type SaveResult } from '../lib/files';
import { Markdown } from './Markdown';
import { Button, Segmented, useDebounced, Textarea } from './ui';

/**
 * Postman-style collection documentation: the collection description plus every folder and request
 * (description, URL, auth, parameters, headers, body and saved examples), rendered from Markdown the
 * engine generates. The description is edited here; request docs are edited in each request's Docs tab.
 */
export function CollectionDocs({ collection, onDescription }: { collection: Collection; onDescription(description: string): void }) {
  const env = useApp((s) => s.environment);
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [markdown, setMarkdown] = useState('');
  const debounced = useDebounced(collection, 300);
  useEffect(() => {
    call<string>('col.docs', { collection: debounced, environment: env }).then(setMarkdown, (e) => setMarkdown(`> ${asError(e).message}`));
  }, [debounced, env]);

  const exportHtml = async () => {
    try {
      finishSave(await call<SaveResult>('col.exportDocsHtml', { collection, environment: env }), 'Documentation');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 h-10 border-b border-line shrink-0">
        <Segmented
          label="Documentation mode"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'view', label: 'Documentation', icon: <Eye size={12} /> },
            { value: 'edit', label: 'Edit description', icon: <Pencil size={12} /> },
          ]}
        />
        <span className="text-xs text-muted ml-2">Sensitive values are masked. Request docs are written in each request’s Docs tab.</span>
        <Button size="sm" variant="ghost" className="ml-auto" icon={<Download size={12} />} disabled={!markdown} onClick={() => downloadContent(`${collection.name}.md`, markdown, { type: 'text/markdown' })}>
          Export Markdown
        </Button>
        <Button size="sm" variant="ghost" icon={<Globe size={12} />} disabled={!markdown} onClick={() => void exportHtml()}>
          Export HTML
        </Button>
      </div>
      {mode === 'edit' ? (
        <div className="flex-1 min-h-0 grid grid-cols-2 gap-3 p-3">
          <Textarea autoGrow={false}
            className="field h-full resize-none mono text-sm"
            placeholder={'Describe the collection in Markdown: what the API does, how to authenticate, where to get keys…'}
            value={collection.description ?? ''}
            onChange={(e) => onDescription(e.target.value)}
            aria-label="Collection description (Markdown)"
          />
          <div className="overflow-auto border border-line rounded-md p-4">
            {collection.description?.trim() ? <Markdown source={collection.description} /> : <p className="text-sm text-muted">The preview appears here.</p>}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <Markdown source={markdown} className="max-w-4xl px-8 py-6" />
        </div>
      )}
    </div>
  );
}
