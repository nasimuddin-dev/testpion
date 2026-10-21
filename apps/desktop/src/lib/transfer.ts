import { baseKind, can, type KindId } from '@testpion/shared';
import type { Act, NodeKind, NodeMenuCtx } from './node-menu-actions';
import { useApp } from '../store';

/**
 * Export… and Import… of every node, from one place (no view has its own): a section header exports or imports its
 * whole kind, an item exports itself. Both open the shared dialogs (ExportBundleDialog, ImportBundleDialog), which
 * call the `bundle.*` RPCs; the item kinds' `export` / `import` capabilities (packages/shared/src/item-kind-list.ts)
 * decide whether a menu shows the item at all, so this only supplies what a view did not.
 */

/** What the Export bundle dialog is asked to export: items (refs), a whole section of a kind, or the whole workspace. */
export interface ExportRequest {
  selection?: unknown[];
  section?: string;
  /** The items in one folder of a list (an API definition folder, a test folder …). */
  folder?: { kind: string; name: string };
  all?: boolean;
  /** Start with "Include everything it uses" on. */
  uses?: boolean;
  title?: string;
}

/** What the Import bundle dialog starts with: a section limits the import to that kind; a file given skips the picker. */
export interface ImportRequest {
  section?: string;
  base64?: string;
  fileName?: string;
  /** Import here…: the bundle's collection is added under this collection (or one of its folders). */
  into?: { collectionId: string; folderId?: string; name: string };
}

export const openExportBundle = (r: ExportRequest): void => useApp.getState().set({ exportBundle: r });
export const openImportBundle = (r: ImportRequest = {}): void => useApp.getState().set({ importBundle: r });

/**
 * A bundle file dropped on the window (or chosen in the Import dialog) → the bundle Import with its preview. The window's one
 * drop listener (components/ImportHost.tsx) calls this for a bundle and opens the general Import for anything else.
 */
export async function importBundleFile(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  openImportBundle({ base64: btoa(bin), fileName: file.name });
}

/** A picked or dropped source that is one bundle file → what the bundle Import starts with (so the one Import entry hands a bundle over to its preview). */
export function bundleRequestOf(src: { files?: Array<{ path: string; text?: string; base64?: string }> }): ImportRequest | undefined {
  const f = src.files?.length === 1 ? src.files[0] : undefined;
  if (!f || !isBundleFile(f.path)) return undefined;
  let base64 = f.base64;
  if (!base64) {
    const bytes = new TextEncoder().encode(f.text ?? '');
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    base64 = btoa(bin);
  }
  return { base64, fileName: f.path };
}

/** The name of a bundle file (.testpion.zip or .testpion.json): such a file goes to the bundle Import, whatever else is dropped with it. */
export const isBundleFile = (name: string): boolean => /\.testpion\.(zip|json)$/i.test(name);

/** Export… and Import… for a node, unless the view gave its own (a collection's Export is a submenu of formats). */
export function transferActions(kind: NodeKind, c: NodeMenuCtx): Partial<Record<'export' | 'import' | 'importHere', Act>> {
  const base = baseKind(kind) as KindId;
  if (kind.startsWith('section:'))
    return {
      ...(can(base, 'export') ? { export: () => openExportBundle({ section: base }) } : {}),
      ...(can(base, 'import') ? { import: () => openImportBundle({ section: base }) } : {}),
    };
  // a folder of a list exports the items in it
  if (kind.startsWith('folder:')) {
    const name = c.folder ?? c.name;
    return can(base, 'export') && name ? { export: () => openExportBundle({ folder: { kind: base, name }, title: name }) } : {};
  }
  if (c.ref && can(base, 'export')) {
    const ref = c.ref;
    // a collection or a folder of one also takes a bundle's requests: Import here…
    const here = c.ref.kind === 'collection' ? { collectionId: c.ref.collectionId } : c.ref.kind === 'folder' ? { collectionId: c.ref.collectionId, folderId: c.ref.folderId } : undefined;
    return {
      export: () => openExportBundle({ selection: [ref], ...(c.name ? { title: c.name } : {}) }),
      ...(here && can(base, 'import') ? { importHere: () => openImportBundle({ into: { ...here, name: c.name ?? 'this collection' } }) } : {}),
    };
  }
  return {};
}
