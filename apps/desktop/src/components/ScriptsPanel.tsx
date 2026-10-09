import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import { Package, Code2, Info } from 'lucide-react';
import { SNIPPETS } from '../lib/snippets';
import { setActiveScriptEditor } from '../lib/script-editor';
import { CodeEditor } from './CodeEditor';
import { useWidth } from './charts';
import { CommandPalette } from './Shell';
import { LinkButton, PinnablePanel, Tabs, Tooltip, cx } from './ui';

const ScriptPackagesDialog = lazy(() => import('./ScriptPackagesDialog').then((m) => ({ default: m.ScriptPackagesDialog })));

type Editor = Parameters<OnMount>[0];

/** Narrower than this, the script list (Pre-request / Post-response) becomes tabs above the editor. */
const NARROW = 700;

/**
 * Pre-request / Post-response scripts with a snippet list (Postman layout). Scripts use the
 * `tp` script API (Postman-compatible) and run in a WebAssembly sandbox. The snippets are a pinnable panel
 * (unpinned, the editor takes the room); Ctrl+Shift+I in the editor picks a snippet by name and inserts it at the cursor.
 */
export function ScriptsPanel({ pre, post, onPre, onPost }: { pre: string; post: string; onPre(v: string): void; onPost(v: string): void }) {
  const [which, setWhich] = useState<'pre' | 'post'>(() => (pre && !post ? 'pre' : 'post'));
  const [packagesOpen, setPackagesOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [hostRef, width] = useWidth<HTMLDivElement>();
  const narrow = width > 0 && width < NARROW;
  const editorRef = useRef<Editor>(undefined);
  const unregister = useRef<() => void>(undefined);
  useEffect(() => () => unregister.current?.(), []);
  const helpId = useId();
  const value = which === 'pre' ? pre : post;
  const set = which === 'pre' ? onPre : onPost;
  const snippets = SNIPPETS.filter((s) => s.kind === 'both' || s.kind === (which === 'pre' ? 'pre' : 'test'));
  const append = (code: string) => set((value.trim() ? value.replace(/\s*$/, '\n\n') : '') + code + '\n');
  /** The quick pick inserts where the cursor is (the panel's list appends, as it always has). */
  const insertAtCursor = (code: string) => {
    const ed = editorRef.current;
    const sel = ed?.getSelection();
    if (!ed || !sel) return append(code);
    ed.executeEdits('snippet', [{ range: sel, text: code, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };
  const help = (
    <>
      {which === 'pre' ? 'Runs before the request is sent — set variables or change tp.request.' : 'Runs after the response — write tp.test(...) checks and save values with tp.environment.set(...).'} Write <code>tp.*</code> scripts;
      scripts written for Postman (<code>pm.*</code>) also run unchanged. Scripts run in a sandbox without file or network access. Ctrl+Shift+I inserts a snippet.
    </>
  );
  const info = (
    <>
      <Tooltip content={<span className="block max-w-80 font-normal">{help}</span>}>
        <button type="button" aria-label="About scripts" aria-describedby={helpId} className="inline-flex items-center justify-center h-6 w-6 rounded-md text-muted hover:text-fg hover:bg-hover" data-scripts-help>
          <Info size={13} />
        </button>
      </Tooltip>
      <span id={helpId} className="sr-only">
        {help}
      </span>
    </>
  );
  const packagesButton = (className: string) => (
    <button className={cx('flex items-center gap-2 text-muted hover:text-fg hover:bg-hover', className)} title="Shared code that scripts load with tp.require('name')" onClick={() => setPackagesOpen(true)}>
      <Package size={13} /> Packages…
    </button>
  );
  const kinds = [
    ['pre', 'Pre-request', pre],
    ['post', 'Post-response', post],
  ] as const;
  const dot = <span className="w-1.5 h-1.5 rounded-full bg-ok ml-auto" title="Has a script" />;
  return (
    <div ref={hostRef} className="h-full flex min-h-0" data-scripts-layout={narrow ? 'tabs' : 'column'}>
      {!narrow && (
        <div className="w-40 shrink-0 border-r border-line py-1 text-sm flex flex-col" role="tablist" aria-label="Script">
          {kinds.map(([id, label, code]) => (
            <button key={id} role="tab" aria-selected={which === id} onClick={() => setWhich(id)} className={cx('w-full text-left px-3 py-1.5 flex items-center gap-2', which === id ? 'bg-accent/10 text-accent font-medium' : 'hover:bg-hover')}>
              {label}
              {code.trim() && dot}
            </button>
          ))}
          {packagesButton('w-full text-left px-3 py-1.5 mt-2 border-t border-line')}
          <div className="mt-auto px-2 pt-1">{info}</div>
        </div>
      )}
      {packagesOpen && (
        <Suspense fallback={null}>
          <ScriptPackagesDialog onClose={() => setPackagesOpen(false)} />
        </Suspense>
      )}
      <div className="flex-1 min-w-0 flex flex-col" data-script-editor-column>
        {narrow && (
          <Tabs
            tabs={kinds.map(([id, label, code]) => ({ id, label: code.trim() ? <>{label} {dot}</> : label }))}
            value={which}
            onChange={setWhich}
            right={
              <>
                {info}
                {packagesButton('h-7 px-2 rounded-md text-xs')}
              </>
            }
          />
        )}
        <div className="flex-1 min-h-0" data-script-editor>
          <CodeEditor
            key={which}
            language="javascript"
            value={value}
            onChange={set}
            placeholder={which === 'pre' ? 'tp.variables.set("nonce", tp.uuid());' : 'tp.test("Status code is 200", () => tp.response.to.have.status(200));'}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
              const open = () => setPicking(true);
              // addAction registers in Monaco's global command registry: released with the editor, or every closed
              // Scripts editor stays alive through it (soak test: 250 detached nodes per closed tab)
              const action = editor.addAction({
                id: 'testpion.insertSnippet',
                label: 'Insert Snippet…',
                keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyI],
                contextMenuGroupId: 'navigation',
                run: open,
              });
              editor.onDidDispose(() => action.dispose());
              const register = () => {
                unregister.current?.();
                const root = editor.getDomNode();
                if (root) unregister.current = setActiveScriptEditor({ root, insertSnippet: open });
              };
              editor.onDidFocusEditorWidget(register);
              if (editor.hasWidgetFocus()) register();
            }}
          />
        </div>
      </div>
      <PinnablePanel id="scripts.snippets" title="Snippets" side="right" defaultWidth={240}>
        {({ close }) => (
          <div className="flex-1 overflow-auto py-1" data-snippets>
            {snippets.map((s) => (
              <LinkButton key={s.label} className="w-full text-left px-3 py-1 text-xs" icon={<Code2 size={12} className="shrink-0" />} onClick={() => (append(s.code), close())}>
                {s.label}
              </LinkButton>
            ))}
          </div>
        )}
      </PinnablePanel>
      {picking && (
        <CommandPalette
          label="Insert snippet"
          placeholder="Insert a snippet… (type to filter)"
          empty="No matching snippets"
          commands={snippets.map((s) => ({ id: s.label, label: s.label, hint: s.kind === 'both' ? undefined : s.kind === 'pre' ? 'Pre-request' : 'Test', icon: <Code2 size={16} />, run: () => insertAtCursor(s.code) }))}
          onClose={() => {
            setPicking(false);
            editorRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
