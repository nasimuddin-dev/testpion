/**
 * The workspace that the window's saved UI state belongs to. Open tabs, editor drafts, open documents and sticky values
 * are kept per workspace: switching workspace must not bring the other workspace's tabs along (they point at
 * collections and files that are not in this one). Every store of window state keys its entries with `scopedKey`.
 *
 * Until a workspace is open there is no scope: reads find nothing and writes are dropped, so the empty window shown
 * while the workspace loads never overwrites a workspace's saved state.
 */
type Hook = () => void;

let current: string | undefined;
const before = new Set<Hook>();
const after = new Set<Hook>();

/** `key` inside the current workspace's scope, or undefined while no workspace is open. */
export const scopedKey = (key: string): string | undefined => (current ? `ws:${current}:${key}` : undefined);

/**
 * Switch the scope (a workspace was opened). `beforeScopeChange` hooks run in the old scope (write what is pending),
 * `afterScopeChange` hooks in the new one (load its state); both before the new workspace's views mount.
 */
export function setDraftScope(workspaceId: string | undefined): void {
  if (workspaceId === current) return;
  for (const h of before) h();
  current = workspaceId;
  for (const h of after) h();
}

export function beforeScopeChange(h: Hook): () => void {
  before.add(h);
  return () => before.delete(h);
}

export function afterScopeChange(h: Hook): () => void {
  after.add(h);
  return () => after.delete(h);
}
