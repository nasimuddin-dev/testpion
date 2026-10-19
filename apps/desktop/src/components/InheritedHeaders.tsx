import type { KeyValue } from '../types';
import { KeyValueEditor } from './KeyValueEditor';

/** Headers a collection or folder sends with every request inside (one editor for both, so they read the same). */
export function InheritedHeaders({ rows, onChange, where }: { rows: KeyValue[] | undefined; onChange(rows: KeyValue[]): void; where: 'collection' | 'folder' }) {
  return (
    <div className="p-2" data-inherited-headers={where}>
      <p className="text-xs text-muted pb-2 px-1">
        Sent with every request {where === 'folder' ? 'in this folder' : 'in this collection'}. A request's own header of the same name wins; {where === 'folder' ? "an inner folder's wins over this folder's" : "a folder's wins over the collection's"}. Postman, Insomnia and Bruno imports put
        their folder and collection headers here.
      </p>
      <KeyValueEditor rows={rows ?? []} onChange={onChange} keyPlaceholder="Header" />
    </div>
  );
}
