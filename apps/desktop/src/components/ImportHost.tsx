import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Upload } from 'lucide-react';
import { toastError, useApp } from '../store';
import type { ImportSource } from '../types';
import { dragHasImportable, readDrop } from '../lib/import-files';
import { importBundleFile, isBundleFile } from '../lib/transfer';
import { ImportDialog, type MigrateTool } from './ImportDialog';

interface Request {
  initial?: ImportSource;
  tool?: MigrateTool;
  /** Show the tool choice (Home's "Migrate from…"). */
  migrate?: boolean;
  /** A new key per request, so a second drop while the dialog is open starts over. */
  n: number;
}

const useImportHost = create<{ request: Request | null; open(r: Omit<Request, 'n'>): void; close(): void }>((set, get) => ({
  request: null,
  open: (r) => set({ request: { ...r, n: (get().request?.n ?? 0) + 1 } }),
  close: () => set({ request: null }),
}));

/** Open the Import dialog from anywhere (Home's "Migrate from…", a drop), with something to read or a tool to explain. */
export const openImport = (r: Omit<Request, 'n'> = {}): void => useImportHost.getState().open(r);

/**
 * Mounted once in the window: the Import dialog for what is dropped on it (files, a folder, a link), with the overlay that
 * says so while something is dragged over, and for `openImport()`. A drag of something else (a request in the tree, a
 * flow block) is left to the element that handles it: only files and links count.
 */
export function ImportHost() {
  const { request, close } = useImportHost();
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!dragHasImportable(e.dataTransfer)) return;
      depth.current++;
      setOver(true);
    };
    const onOver = (e: DragEvent) => {
      if (!dragHasImportable(e.dataTransfer)) return;
      // a drop elsewhere would make the browser navigate to the file
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const onDrop = (e: DragEvent) => {
      depth.current = 0;
      setOver(false);
      if (!e.dataTransfer || !dragHasImportable(e.dataTransfer)) return;
      e.preventDefault();
      // a drop on a file input or an element that takes files itself keeps working
      if ((e.target as HTMLElement | null)?.closest?.('[data-accepts-drop]')) return;
      // a bundle has its own Import (it previews and merges items); this listener is the only one on the window, so exactly one dialog opens
      const bundle = [...(e.dataTransfer.files ?? [])].find((f) => isBundleFile(f.name));
      if (bundle) return void importBundleFile(bundle).catch(toastError);
      readDrop(e.dataTransfer).then(
        (src) => (src ? openImport({ initial: src }) : useApp.getState().toast('Nothing importable in what was dropped', 'warning')),
        toastError,
      );
    };
    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);
  return (
    <>
      {over && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-bg/80 pointer-events-none" data-import-drop-overlay>
          <div className="border-2 border-dashed border-accent rounded-xl px-10 py-8 text-center">
            <Upload size={28} className="mx-auto mb-2 text-accent" />
            <div className="text-lg font-medium">Drop to import</div>
            <div className="text-sm text-muted">Collections, environments, API definitions, a bundle (.testpion.zip), a folder or a link. You see what will be created before anything is written.</div>
          </div>
        </div>
      )}
      {request && <ImportDialog key={request.n} initial={request.initial} tool={request.tool} migrate={request.migrate} onClose={close} onDone={() => undefined} />}
    </>
  );
}
