import type * as Monaco from 'monaco-editor';

/**
 * Dataset formats in the editor, coloured so a record reads at a glance:
 * - JSON Lines: each line coloured like JSON (keys, strings, numbers, true/false/null, in the theme's JSON colours)
 *   and checked on its own, so records one per line are not one broken JSON document; a line that is not a JSON
 *   object is marked with what is wrong with it.
 * - CSV: each column in its own colour (six, then they repeat), quoted fields with commas kept whole.
 * - HTTP: a raw request or response (code snippets): the request or status line, header names, a JSON body.
 */

import { detectLanguage } from './lib/highlight';

/** Colours of the CSV columns, for the dark and the light theme (the same hues as the app's tokens). */
export const CSV_COLUMN_COLOURS = {
  dark: ['7fb2ff', '9ee6b8', 'fbbf77', 'c4a5fd', 'f9a8d4', '67e8f9'],
  light: ['1d5fd6', '15803d', 'b45309', '7c3aed', 'be185d', '0e7490'],
};

/** The editor language for a data file or a dataset format: json, jsonl/ndjson, csv/tsv, md. */
export function dataLanguageOf(nameOrFormat: string): string {
  const ext = nameOrFormat.toLowerCase().split('.').pop() ?? '';
  if (ext === 'json') return 'json';
  if (ext === 'jsonl' || ext === 'ndjson') return 'jsonl';
  if (ext === 'csv') return 'csv';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'yaml' || ext === 'yml') return 'yaml';
  return 'plaintext';
}

function installJsonl(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'jsonl', extensions: ['.jsonl', '.ndjson'], aliases: ['JSON Lines', 'jsonl'] });
  monaco.languages.setLanguageConfiguration('jsonl', {
    brackets: [
      ['{', '}'],
      ['[', ']'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
  });
  monaco.languages.setMonarchTokensProvider('jsonl', {
    tokenizer: {
      root: [
        // a key: a string followed by a colon
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
        [/"(?:[^"\\]|\\.)*$/, 'string.invalid'],
        [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/[{}[\]]/, '@brackets'],
        [/[,:]/, 'delimiter'],
      ],
    },
  });

  const validate = (model: Monaco.editor.ITextModel) => {
    if (model.isDisposed()) return;
    const markers: Monaco.editor.IMarkerData[] = [];
    if (model.getLanguageId() === 'jsonl')
      for (let n = 1; n <= model.getLineCount(); n++) {
        const line = model.getLineContent(n);
        if (!line.trim()) continue;
        let message: string | undefined;
        try {
          const v = JSON.parse(line);
          if (!v || typeof v !== 'object' || Array.isArray(v)) message = 'Each line is one record: a JSON object such as {"input": "…", "expected": "…"}.';
        } catch (e) {
          message = `Line ${n} is not valid JSON: ${(e as Error).message}`;
        }
        if (message) markers.push({ severity: monaco.MarkerSeverity.Error, message, startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: line.length + 1 });
      }
    monaco.editor.setModelMarkers(model, 'jsonl', markers);
  };

  // checked as you type, and again when an editor switches a model to or from JSON Lines (the format picker)
  monaco.editor.onDidCreateModel((m) => {
    let t: ReturnType<typeof setTimeout> | undefined;
    m.onDidChangeContent(() => {
      if (m.getLanguageId() !== 'jsonl') return;
      clearTimeout(t);
      t = setTimeout(() => validate(m), 250);
    });
    m.onDidChangeLanguage(() => validate(m));
    if (m.getLanguageId() === 'jsonl') validate(m);
  });
}

function installCsv(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'csv', extensions: ['.csv'], aliases: ['CSV', 'csv'] });
  const n = CSV_COLUMN_COLOURS.dark.length;
  // a field: quoted ("a, b" with "" for a quote) or up to the next comma; one state per column, back to the first at a line's end
  const field = /(?:"(?:[^"]|"")*"?|[^,"]+)/.source;
  const states: Record<string, Monaco.languages.IMonarchLanguageRule[]> = {};
  for (let i = 0; i < n; i++) {
    const token = `csv.column${i}`;
    const next = `@column${(i + 1) % n}`;
    states[`column${i}`] = [
      [/,$/, { token: 'delimiter.csv', next: '@column0' }],
      [new RegExp(`${field}$`), i === 0 ? token : { token, next: '@column0' }],
      [new RegExp(field), token],
      [/,/, { token: 'delimiter.csv', next }],
    ];
  }
  monaco.languages.setMonarchTokensProvider('csv', { start: 'column0', tokenizer: { root: states.column0!, ...states } });
}

function installHttp(monaco: typeof Monaco): void {
  monaco.languages.register({ id: 'http', extensions: ['.http', '.rest'], aliases: ['HTTP', 'http'] });
  monaco.languages.setMonarchTokensProvider('http', {
    tokenizer: {
      root: [
        [/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)(\s+)(\S+)(.*)$/, ['keyword', '', 'string', 'comment']],
        [/^(HTTP\/[\d.]+)(\s+)(\d{3})(.*)$/, ['keyword', '', 'number', '']],
        [/^(#|\/\/).*$/, 'comment'],
        [/^([\w-]+)(:)(.*)$/, ['string.key.json', 'delimiter', '']],
        // the body starts at the first line that is not a header (the blank line before it has no tokens to switch on)
        [/^(?=\s*[[{<"])/, { token: '', next: '@body' }],
      ],
      body: [
        [/"(?:[^"\\]|\\.)*"(?=\s*:)/, 'string.key.json'],
        [/"(?:[^"\\]|\\.)*"/, 'string.value.json'],
        [/-?\b\d+(?:\.\d+)?\b/, 'number'],
        [/\b(?:true|false|null)\b/, 'keyword'],
        [/^###.*$/, { token: 'comment', next: '@root' }],
      ],
    },
  });
}

/** The editor language for a text whose format is not declared (a saved example, a text body): from what it looks like. */
export function editorLanguageOfText(text: string): string {
  const l = detectLanguage(text);
  return l === 'plain' ? 'plaintext' : l;
}

export function installDataLanguages(monaco: typeof Monaco): void {
  installJsonl(monaco);
  installCsv(monaco);
  installHttp(monaco);
}

/** Theme rules for the data languages (added to each theme's rules). */
export function dataLanguageThemeRules(theme: 'dark' | 'light'): Monaco.editor.ITokenThemeRule[] {
  return [...CSV_COLUMN_COLOURS[theme].map((c, i) => ({ token: `csv.column${i}`, foreground: c })), { token: 'delimiter.csv', foreground: theme === 'dark' ? '6b6b76' : '9ca3af' }];
}
