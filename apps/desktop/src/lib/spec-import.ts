import { call } from '../api';
import { toastError, useApp } from '../store';

/** The part of an import's answer about an API definition that was kept beside a different one of the same name (EX-G3). */
export interface SpecKeptBoth {
  specPath?: string;
  specKeptBoth?: { existing: string };
  collectionId?: string;
  notes?: string[];
}

/**
 * An import that kept both API definitions: "Saved as specs/x-2.yaml · Replace instead". Replace puts the new document
 * in the old one's place (the old one goes to Recently deleted, restorable for 30 days) and points the imported
 * collection's contract checks at it. Returns the notes without the one this toast already says, for the notes toast.
 */
export function toastSpecKeptBoth(r: SpecKeptBoth): string[] | undefined {
  if (!r.specKeptBoth || !r.specPath) return r.notes;
  const kept = r.specPath;
  const original = r.specKeptBoth.existing;
  useApp.getState().toast(`Saved as ${kept}: ${original} holds a different document and was kept`, 'info', {
    label: 'Replace instead',
    onClick: () =>
      void call<{ specPath: string }>('openapi.replaceSpec', { kept, original, collectionId: r.collectionId }).then(
        (done) => useApp.getState().toast(`Replaced ${done.specPath}; the earlier document is in Recently deleted (30 days)`, 'success'),
        toastError,
      ),
  });
  return r.notes?.filter((n) => !n.startsWith(`Saved as ${kept}:`));
}
