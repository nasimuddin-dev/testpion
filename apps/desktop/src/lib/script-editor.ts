/**
 * The script editor the keyboard was last in (a request's Pre-request / Post-response script): the command palette
 * offers "Insert Snippet…" for it while the focus is in it.
 */
interface ScriptEditorHandle {
  /** The editor's element: the command is offered only while the focus is inside it. */
  root: HTMLElement;
  /** Open the snippet quick pick. */
  insertSnippet(): void;
}

let current: ScriptEditorHandle | undefined;

/** A script editor got the focus; returns its unregister (when it unmounts). */
export function setActiveScriptEditor(h: ScriptEditorHandle): () => void {
  current = h;
  return () => {
    if (current === h) current = undefined;
  };
}

/** The script editor that has the focus right now, if any. */
export function focusedScriptEditor(): ScriptEditorHandle | undefined {
  return current && current.root.isConnected && current.root.contains(document.activeElement) ? current : undefined;
}
