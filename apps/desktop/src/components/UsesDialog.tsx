import { useEffect, useState } from 'react';
import type { ItemRef } from '@testpion/shared';
import { asError, call } from '../api';
import { useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { EmptyNote, LinkButton, Modal } from './ui';

interface UseRow {
  kind: string;
  id: string;
  name: string;
  via: string;
  ref?: ItemRef;
}
interface ItemUses {
  item: { kind: string; id: string; name: string };
  uses: UseRow[];
  usedBy: UseRow[];
  missing: Array<{ to: string; reason: string }>;
}

/**
 * "Uses and used by…" of any item (the row menus' one action, lib/node-menu.ts): what the item names in the workspace
 * and what names it, from the engine's reading (`item.uses`: the same as `testpion item uses` and MCP `item_uses`).
 * A row with a ref opens its item.
 */
export function UsesDialog() {
  const ref = useApp((s) => s.usesOf)!;
  const close = () => useApp.getState().set({ usesOf: undefined });
  const [data, setData] = useState<ItemUses>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError(undefined);
    call<ItemUses>('item.uses', { ref }).then(
      (r) => live && setData(r),
      (e) => live && setError(asError(e).message),
    );
    return () => {
      live = false;
    };
  }, [ref]);
  const list = (title: string, rows: UseRow[], none: string) => (
    <section className="mb-4">
      <h3 className="text-xs font-semibold mb-1">{title}</h3>
      {rows.length ? (
        <ul className="text-sm">
          {rows.map((u) => (
            <li key={`${u.kind}:${u.id}`} className="flex items-baseline gap-2 py-0.5 min-w-0">
              <span className="text-xs text-muted shrink-0 w-24 truncate">{u.kind}</span>
              {u.ref ? (
                <LinkButton
                  className="truncate"
                  onClick={() => {
                    close();
                    void openRef(u.ref!);
                  }}
                >
                  {u.name}
                </LinkButton>
              ) : (
                <span className="truncate">{u.name}</span>
              )}
              <span className="text-xs text-muted truncate ml-auto">{u.via}</span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyNote>{none}</EmptyNote>
      )}
    </section>
  );
  return (
    <Modal title={data ? `Uses and used by: ${data.item.name}` : 'Uses and used by'} onClose={close} width={620}>
      {error ? (
        <p className="text-sm text-bad">{error}</p>
      ) : !data ? (
        <EmptyNote>Reading the workspace…</EmptyNote>
      ) : (
        <>
          {list('It uses', data.uses, 'Nothing else in the workspace.')}
          {list('Used by', data.usedBy, 'Nothing in the workspace names it.')}
          {data.missing.length > 0 && (
            <section>
              <h3 className="text-xs font-semibold mb-1">Named but not in the workspace</h3>
              <ul className="text-sm">
                {data.missing.map((m) => (
                  <li key={m.to} className="flex items-baseline gap-2 py-0.5">
                    <span className="truncate">{m.to}</span>
                    <span className="text-xs text-muted ml-auto">{m.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </Modal>
  );
}
