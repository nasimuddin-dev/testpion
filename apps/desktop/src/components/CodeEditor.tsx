import Editor, { type OnMount } from '@monaco-editor/react';
import { useEffect, useMemo, useState, type ComponentProps } from 'react';
import { useApp } from '../store';
import { useDoc } from '../lib/docs';
import { Spinner } from './ui';
import { setEditorJsonSchema, setEditorLocalVariables } from '../editor-intel';
import { collectionOf, useVarPopover, variableAt } from '../lib/var-popover';

/**
 * Monaco (several MB with its language workers) loads the first time an editor is shown, not at
 * startup. The setup module bundles it locally (no CDN) and registers themes and languages.
 */
let monacoReady: Promise<unknown> | undefined;
let monacoLoaded = false;
export const loadMonaco = () => (monacoReady ??= import('../monaco').then(() => void (monacoLoaded = true)));

function useMonaco(): boolean {
  const [ready, setReady] = useState(monacoLoaded);
  useEffect(() => {
    if (!ready) void loadMonaco().then(() => setReady(true));
  }, [ready]);
  return ready;
}

export function useEditorTheme(): string {
  const theme = useApp((s) => s.settings?.theme ?? 'system');
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  return dark ? 'aps-dark' : 'aps-light';
}

export function CodeEditor({
  value,
  onChange,
  language = 'json',
  readOnly,
  height = '100%',
  onMount,
  path,
  minimal,
  placeholder,
  jsonSchema,
  localVariables,
}: {
  value: string;
  onChange?(v: string): void;
  language?: string;
  readOnly?: boolean;
  height?: string | number;
  onMount?: OnMount;
  path?: string;
  minimal?: boolean;
  placeholder?: string;
  /** JSON Schema for a JSON editor (needs `path`): completion of keys and values, hover and validation. */
  jsonSchema?: unknown;
  /** {{variables}} defined for this editor only (needs `path`), e.g. a prompt's inputs: not flagged as unknown, and offered in completion. */
  localVariables?: string[];
}) {
  const theme = useEditorTheme();
  const fontSize = useApp((s) => s.settings?.fontSize ?? 14);
  const ready = useMonaco();
  const doc = useDoc();
  // one options object per setting: the wrapper re-applies options to the editor whenever this is a new object,
  // which with every render of a view (and many open tabs) kept Monaco busy with nothing
  const options = useMemo<NonNullable<ComponentProps<typeof Editor>['options']>>(
    () => ({
    readOnly,
    minimap: { enabled: false },
    fontSize,
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    tabSize: 2,
    lineNumbers: minimal ? 'off' : 'on',
    glyphMargin: false,
    folding: !minimal,
    lineDecorationsWidth: minimal ? 4 : 8,
    renderLineHighlight: minimal ? 'none' : 'line',
    automaticLayout: true,
    fixedOverflowWidgets: true,
    quickSuggestions: language === 'graphql' ? { other: true, strings: false, comments: false } : undefined,
    scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    }),
    [readOnly, fontSize, minimal, language],
  );
  useEffect(() => {
    if (!path || !jsonSchema) return;
    setEditorJsonSchema(path, jsonSchema);
    return () => setEditorJsonSchema(path, undefined);
  }, [path, jsonSchema]);
  const localKey = localVariables?.join(',');
  useEffect(() => {
    if (!path || !localVariables?.length) return;
    setEditorLocalVariables(path, localVariables);
    return () => setEditorLocalVariables(path, undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, localKey]);
  // A hidden tab (a GraphQL, gRPC, WebSocket or MCP document that is open but not shown) keeps its state and its
  // connection, but not a live editor: every open tab's editors took part in every layout and every keystroke
  // (kept mounted while hidden: the tab comes back as it was, cursor and scroll included)
  // (a document tab only: a hidden view keeps its editors, and their undo history, as it always did)
  if (doc.docId !== undefined && !doc.active) return <div style={{ height }} />;
  if (!ready) return <div className="h-full w-full grid place-items-center"><Spinner /></div>;
  // Monaco only accepts text: a value that arrives as an object (e.g. GraphQL variables saved as JSON) would
  // throw inside createModel and take the whole window down, so show it as formatted JSON instead
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2);
  return (
    <div className="h-full w-full min-h-0 relative">
      {!text && placeholder && <div className="absolute left-14 top-1 text-muted text-sm pointer-events-none z-10 mono">{placeholder}</div>}
      <Editor
        height={height}
        language={language}
        value={text}
        path={path}
        theme={theme}
        loading={<Spinner />}
        onChange={(v) => onChange?.(v ?? '')}
        onMount={(editor, monaco) => {
          // a double-click on a {{variable}} shows what it holds (the same popover as everywhere)
          editor.onMouseDown((e) => {
            const pos = e.target.position;
            const model = editor.getModel();
            if (e.event.detail !== 2 || !pos || !model) return;
            const name = variableAt(model.getLineContent(pos.lineNumber), pos.column - 1);
            if (!name) return;
            const b = e.event.browserEvent;
            useVarPopover.getState().show({ name, x: b.clientX - 40, y: b.clientY + 10, collectionId: collectionOf(editor.getDomNode()) });
          });
          onMount?.(editor, monaco);
        }}
        options={options}
      />
    </div>
  );
}
