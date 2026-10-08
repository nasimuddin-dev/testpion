import { editorLanguageOfText } from '../data-languages';
import { BookmarkPlus, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError } from '../store';
import type { SavedExample } from '../types';
import { CodeEditor } from './CodeEditor';
import { Badge, cx, Empty, IconButton, statusTone } from './ui';
import { focusRow, InlineRename } from './TreeParts';

const languageOf = (ex: SavedExample) => {
  const ct = ex.headers.find((h) => h.key.toLowerCase() === 'content-type')?.value ?? '';
  if (/json/i.test(ct) || /^\s*[{[]/.test(ex.body)) return 'json';
  if (/html/i.test(ct)) return 'html';
  if (/xml/i.test(ct)) return 'xml';
  return editorLanguageOfText(ex.body);
};

/**
 * The saved examples of a request (Postman "examples"): a list on the left, the selected example's
 * status, headers and body on the right. Changes are saved to the collection straight away.
 */
export function ExamplesPanel({ collectionId, requestId, examples, onChange }: { collectionId?: string; requestId?: string; examples: SavedExample[]; onChange(examples: SavedExample[]): void }) {
  const [selected, setSelected] = useState<string | undefined>(examples[0]?.id);
  /** The example whose name is being edited in place (the pencil, or F2 on it in the list). */
  const [renaming, setRenaming] = useState<string>();
  const current = examples.find((e) => e.id === selected) ?? examples[0];

  const persist = async (next: SavedExample[]) => {
    if (!collectionId || !requestId) return;
    try {
      onChange(await call<SavedExample[]>('col.setExamples', { collectionId, requestId, examples: next }));
    } catch (e) {
      toastError(e);
    }
  };

  if (!examples.length)
    return (
      <Empty icon={<BookmarkPlus size={26} />} title="No examples yet">
        {collectionId ? (
          <>
            Send the request, then click <b>Save as example</b> above the response. Examples document the API and are served by the mock server.
          </>
        ) : (
          <>Save this request to a collection first, then save responses as examples.</>
        )}
      </Empty>
    );

  return (
    <div className="h-full flex min-h-0">
      <div role="listbox" aria-label="Examples" className="w-56 shrink-0 border-r border-line overflow-auto py-1">
        {examples.map((ex) => (
          <button
            key={ex.id}
            role="option"
            aria-selected={ex.id === current?.id}
            onClick={() => setSelected(ex.id)}
            onKeyDown={(e) => {
              if (e.key === 'F2') {
                e.preventDefault();
                setSelected(ex.id);
                setRenaming(ex.id);
              }
            }}
            data-rename-id={ex.id}
            title="F2 renames"
            className={cx('w-full flex items-center gap-2 text-left px-3 py-1.5 text-sm', ex.id === current?.id ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-hover')}
          >
            <Badge tone={statusTone(ex.status)}>{ex.status}</Badge>
            <span className="truncate">{ex.name}</span>
          </button>
        ))}
      </div>
      {current && (
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex items-center gap-2 px-3 h-9 border-b border-line text-sm shrink-0">
            <Badge tone={statusTone(current.status)}>
              {current.status} {current.statusText}
            </Badge>
            {renaming === current.id ? (
              <InlineRename
                className="max-w-80"
                value={current.name}
                label="Example name"
                onCommit={(name) => {
                  setRenaming(undefined);
                  void persist(examples.map((e) => (e.id === current.id ? { ...e, name } : e)));
                  focusRow(current.id);
                }}
                onCancel={() => (setRenaming(undefined), focusRow(current.id))}
              />
            ) : (
              <span className="font-medium truncate">{current.name}</span>
            )}
            {current.request && (
              <span className="text-xs text-muted mono truncate" title={`${current.request.method} ${current.request.url}`}>
                {current.request.method} {current.request.url}
              </span>
            )}
            <span className="ml-auto" />
            <IconButton
              label="Rename example (F2)"
              onClick={() => setRenaming(current.id)}
            >
              <Pencil size={14} />
            </IconButton>
            <IconButton label="Delete example" onClick={async () => (await confirmAction({ title: 'Delete example', message: `Delete the example "${current.name}"?`, detail: 'Mock servers stop serving it.', confirmLabel: 'Delete example', danger: true })) && void persist(examples.filter((e) => e.id !== current.id))}>
              <Trash2 size={14} />
            </IconButton>
          </div>
          {current.headers.length > 0 && (
            <details className="border-b border-line text-sm shrink-0">
              <summary className="px-3 py-1.5 cursor-pointer text-muted text-xs">Headers ({current.headers.length})</summary>
              <table className="w-full text-xs mb-1">
                <tbody>
                  {current.headers.map((h, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-1 mono text-muted w-1/3">{h.key}</td>
                      <td className="mono break-all pr-3">{h.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
          <div className="flex-1 min-h-0">
            <CodeEditor value={current.body} language={languageOf(current)} readOnly path={`example-${current.id}`} />
          </div>
        </div>
      )}
    </div>
  );
}
