import { Eye, Pencil } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { outputFileName } from '@testpion/shared';
import { asError, call } from '../api';
import { useApp } from '../store';
import type { Collection } from '../types';
import { OutputActions } from './output/OutputFrame';
import type { OutputSpec } from './output/output-core';
import { Markdown } from './Markdown';
import { Bar, Segmented, Textarea, useDebounced } from './ui';

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

  // the documentation as shown (Markdown), or as one self-contained HTML page the backend lays out; sensitive values are masked in both
  const spec = useMemo<OutputSpec>(
    () => ({
      id: 'collection.docs',
      what: 'documentation',
      name: outputFileName({ name: collection.name, ext: '' }),
      formats: [
        { key: 'md', format: 'md', label: 'Markdown', default: true, build: () => markdown },
        { key: 'html', format: 'html', label: 'HTML page', build: () => call<string>('col.docsHtml', { collection, environment: env }) },
      ],
      empty: markdown ? undefined : 'No documentation yet',
    }),
    [collection, markdown, env],
  );

  return (
    <div className="h-full flex flex-col min-h-0" data-output="collection.docs">
      <Bar>
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
        <OutputActions spec={spec} />
      </Bar>
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
