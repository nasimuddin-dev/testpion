import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import { BRUNO_TYPES, PM_TYPES } from './lib/snippets';
import { installEditorIntel } from './editor-intel';
import { buildSchema, type GraphQLSchema } from 'graphql';
import { getAutocompleteSuggestions, getDiagnostics, Position } from 'graphql-language-service';

/** Bundle Monaco locally (no CDN) so the editor works offline and under a strict CSP. */
self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === 'json') return new JsonWorker();
    if (label === 'typescript' || label === 'javascript') return new TsWorker();
    return new EditorWorker();
  },
};
loader.config({ monaco });
// the editors, for the UI regression suite (e2e) and for debugging from the devtools console
(window as unknown as { __monaco: typeof monaco }).__monaco = monaco;

// Script editor IntelliSense for the Postman-compatible pm API. Scripts run as the body of an async
// function, so a top-level `return` (TS 1108) and `await` (TS 1308, 1375, 1378) are allowed.
monaco.typescript.javascriptDefaults.addExtraLib(PM_TYPES, 'file:///testpion/pm.d.ts');
monaco.typescript.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [1108, 1308, 1375, 1378] });
monaco.typescript.javascriptDefaults.setCompilerOptions({ target: monaco.typescript.ScriptTarget.ES2020, allowNonTsExtensions: true, checkJs: false, lib: ['es2020'] });

// Bruno's bru / req / res / test globals, only while a script that uses them is open: always
// declaring `res` would clash with the common Postman `const res = pm.response.json()`.
let brunoLib: monaco.IDisposable | undefined;
let brunoTimer: ReturnType<typeof setTimeout> | undefined;
const syncBrunoTypes = () => {
  clearTimeout(brunoTimer);
  brunoTimer = setTimeout(() => {
    const uses = monaco.editor.getModels().some((m) => !m.isDisposed() && m.getLanguageId() === 'javascript' && /^\/\/ Bruno script|\bbru\./m.test(m.getValue()));
    if (uses && !brunoLib) brunoLib = monaco.typescript.javascriptDefaults.addExtraLib(BRUNO_TYPES, 'file:///testpion/bruno.d.ts');
    else if (!uses && brunoLib) {
      brunoLib.dispose();
      brunoLib = undefined;
    }
  }, 300);
};
monaco.editor.onDidCreateModel((m) => {
  syncBrunoTypes();
  m.onDidChangeContent(syncBrunoTypes);
  m.onDidChangeLanguage(syncBrunoTypes);
});
monaco.editor.onWillDisposeModel(syncBrunoTypes);

// match the app's navy/blue tokens (styles.css) so editors blend into the panels
monaco.editor.defineTheme('aps-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'string', foreground: '9ee6b8' },
    { token: 'string.key.json', foreground: '7fb2ff' },
    { token: 'number', foreground: 'fbbf77' },
    { token: 'keyword', foreground: 'c4a5fd' },
    { token: 'comment', foreground: '6b6b76', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#090f20',
    'editorGutter.background': '#090f20',
    'editor.lineHighlightBackground': '#101629',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#3f4866',
    'editorLineNumber.activeForeground': '#9ba4be',
    'editor.selectionBackground': '#2f7bff45',
    'editor.inactiveSelectionBackground': '#2f7bff22',
    'editorCursor.foreground': '#1ff0ff',
    'editorIndentGuide.background1': '#20283f',
    'editorWidget.background': '#161d32',
    'editorWidget.border': '#333c58',
    'editorSuggestWidget.background': '#161d32',
    'editorSuggestWidget.border': '#333c58',
    'editorSuggestWidget.selectedBackground': '#20283f',
    'scrollbarSlider.background': '#333c5866',
    'scrollbarSlider.hoverBackground': '#333c58aa',
  },
});
monaco.editor.defineTheme('aps-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'string', foreground: '15803d' },
    { token: 'string.key.json', foreground: '1d5fd6' },
    { token: 'number', foreground: 'c2410c' },
    { token: 'keyword', foreground: '7c3aed' },
    { token: 'comment', foreground: '8a8a95', fontStyle: 'italic' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.lineHighlightBackground': '#f4f6fc',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#b4b4bd',
    'editorLineNumber.activeForeground': '#6b6b76',
    'editor.selectionBackground': '#2f7bff2e',
    'editorCursor.foreground': '#2f7bff',
    'editorIndentGuide.background1': '#ececf0',
    'editorWidget.border': '#e4e4e9',
    'editorSuggestWidget.selectedBackground': '#eaf1ff',
  },
});

/* ------------------------------------------------------------------ GraphQL language */

monaco.languages.register({ id: 'graphql', extensions: ['.graphql', '.gql'] });
monaco.languages.setLanguageConfiguration('graphql', {
  comments: { lineComment: '#' },
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
});
monaco.languages.setMonarchTokensProvider('graphql', {
  keywords: ['query', 'mutation', 'subscription', 'fragment', 'on', 'type', 'interface', 'union', 'enum', 'input', 'scalar', 'schema', 'extend', 'directive', 'implements', 'true', 'false', 'null'],
  tokenizer: {
    root: [
      [/#.*$/, 'comment'],
      [/"""/, 'string', '@block'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/\$[A-Za-z_]\w*/, 'variable'],
      [/@[A-Za-z_]\w*/, 'annotation'],
      [/[A-Za-z_]\w*/, { cases: { '@keywords': 'keyword', '[A-Z]\\w*': 'type', '@default': 'identifier' } }],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, 'number'],
      [/[{}()[\]]/, '@brackets'],
      [/[!:=|&.]+/, 'delimiter'],
    ],
    block: [
      [/"""/, 'string', '@pop'],
      [/./, 'string'],
    ],
  },
});

let currentSchema: GraphQLSchema | undefined;

export function setGraphQLSchema(sdl: string | undefined): void {
  try {
    currentSchema = sdl ? buildSchema(sdl) : undefined;
  } catch {
    currentSchema = undefined;
  }
  for (const m of monaco.editor.getModels()) if (m.getLanguageId() === 'graphql') validateGraphQLModel(m);
}

const kindMap: Record<number, monaco.languages.CompletionItemKind> = {
  1: monaco.languages.CompletionItemKind.Text,
  2: monaco.languages.CompletionItemKind.Method,
  3: monaco.languages.CompletionItemKind.Function,
  5: monaco.languages.CompletionItemKind.Field,
  6: monaco.languages.CompletionItemKind.Variable,
  7: monaco.languages.CompletionItemKind.Class,
  10: monaco.languages.CompletionItemKind.Property,
  13: monaco.languages.CompletionItemKind.Enum,
  14: monaco.languages.CompletionItemKind.Keyword,
  20: monaco.languages.CompletionItemKind.EnumMember,
  22: monaco.languages.CompletionItemKind.Struct,
};

monaco.languages.registerCompletionItemProvider('graphql', {
  triggerCharacters: ['{', '(', ':', '@', '$', ' ', '\n'],
  provideCompletionItems(model, position) {
    const word = model.getWordUntilPosition(position);
    const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
    if (!currentSchema) return { suggestions: [] };
    const items = getAutocompleteSuggestions(currentSchema, model.getValue(), new Position(position.lineNumber - 1, position.column - 1));
    return {
      suggestions: items.map((i) => ({
        label: i.label,
        kind: kindMap[i.kind ?? 5] ?? monaco.languages.CompletionItemKind.Field,
        detail: i.detail ?? (i.type ? String(i.type) : undefined),
        documentation: i.documentation ?? undefined,
        insertText: i.label,
        range,
      })),
    };
  },
});

monaco.languages.registerHoverProvider('graphql', {
  provideHover(model, position) {
    if (!currentSchema) return null;
    const word = model.getWordAtPosition(position);
    if (!word) return null;
    const t = currentSchema.getType(word.word);
    if (t) return { contents: [{ value: `**${t.name}**${t.description ? `\n\n${t.description}` : ''}` }] };
    return null;
  },
});

export function validateGraphQLModel(model: monaco.editor.ITextModel): void {
  const text = model.getValue();
  const diags = text.trim() ? getDiagnostics(text, currentSchema) : [];
  monaco.editor.setModelMarkers(
    model,
    'graphql',
    diags.map((d) => ({
      severity: d.severity === 1 ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      message: typeof d.message === 'string' ? d.message : d.message.value,
      startLineNumber: d.range.start.line + 1,
      startColumn: d.range.start.character + 1,
      endLineNumber: d.range.end.line + 1,
      endColumn: d.range.end.character + 1,
    })),
  );
}

monaco.editor.onDidCreateModel((m) => {
  if (m.getLanguageId() !== 'graphql') return;
  let t: ReturnType<typeof setTimeout> | undefined;
  m.onDidChangeContent(() => {
    clearTimeout(t);
    t = setTimeout(() => validateGraphQLModel(m), 250);
  });
  validateGraphQLModel(m);
});

installEditorIntel(monaco);

export { monaco };
