import type * as Monaco from 'monaco-editor';
import { call } from './api';
import { useApp } from './store';
import { inspectVariables, type VarInfo } from './lib/vars-cache';

/**
 * Editor intelligence for every code editor (Monaco): {{variable}} completion, hover and highlighting in
 * all languages, pm / tp script snippets, and JSON Schema completion + validation for JSON editors
 * (MCP tool arguments, gRPC messages …). Installed once, when Monaco loads.
 */

export type { VarInfo };

const DYNAMIC_FALLBACK: VarInfo[] = [
  { name: '$guid', scope: 'dynamic', value: 'A random UUID' },
  { name: '$timestamp', scope: 'dynamic', value: 'Unix time in seconds' },
  { name: '$isoTimestamp', scope: 'dynamic', value: 'The current time, ISO-8601' },
  { name: '$randomInt', scope: 'dynamic', value: 'A whole number from 0 to 1000' },
];
let DYNAMIC: VarInfo[] = DYNAMIC_FALLBACK;
let dynamicLoaded: Promise<void> | undefined;
/** The engine's list of dynamic variables ($guid, $randomFirstName …), fetched once. */
export function dynamicVariables(): Promise<VarInfo[]> {
  return loadDynamic().then(() => DYNAMIC);
}
function loadDynamic(): Promise<void> {
  dynamicLoaded ??= call<Array<{ name: string; description: string }>>('vars.dynamic')
    .then((list) => void (DYNAMIC = list.map((d) => ({ name: d.name, scope: 'dynamic', value: d.description }))))
    .catch(() => undefined);
  return dynamicLoaded;
}

/* ------------------------------------------------------------------ variables (shared cache, lib/vars-cache) */

/** Variables of the active environment (plus collection, workspace and global ones) and the dynamic ones. */
export function editorVariables(): Promise<VarInfo[]> {
  const env = useApp.getState().environment;
  return Promise.all([inspectVariables({ environment: env || undefined }), loadDynamic()])
    .then(([list]) => [...list.filter((v) => v.name !== 'workspaceDir'), ...DYNAMIC])
    .catch(() => DYNAMIC);
}

/** Defined somewhere, or resolved at run time (dynamic values, {{$env.NAME}}, secret references). */
export function isKnownVariable(name: string, known: Set<string>): boolean {
  return known.has(name) || /^\$(env\.|secret|randomInt\()/.test(name);
}

/** The variable reference around a position: `{{name}}` or an unfinished `{{nam`. */
function varAt(line: string, column: number): { name: string; start: number; end: number; open: boolean } | undefined {
  const before = line.slice(0, column - 1);
  const open = /\{\{\s*([\w.$-]*)$/.exec(before);
  if (open) {
    const rest = /^([\w.$-]*)\s*(\}\})?/.exec(line.slice(column - 1))!;
    // the typed part of the name ends at the cursor: the replaced range starts there (not at the braces)
    return { name: open[1]! + rest[1]!, start: column - open[1]!.length, end: column + rest[1]!.length, open: !rest[2] };
  }
  return undefined;
}

const LANGUAGES = ['json', 'javascript', 'typescript', 'plaintext', 'yaml', 'xml', 'html', 'graphql', 'markdown', 'proto', 'shell'];

/* ------------------------------------------------------------------ tp.* snippets (pm.* is the same API) */

const SNIPPETS: Array<{ label: string; detail: string; body: string }> = [
  { label: 'tp.test', detail: 'Test with an assertion', body: "tp.test('${1:status is 200}', () => {\n\ttp.response.to.have.status(${2:200});\n});" },
  { label: 'tp.test status code', detail: 'Status code is …', body: "tp.test('Status code is ${1:200}', () => {\n\ttp.response.to.have.status(${1:200});\n});" },
  { label: 'tp.test response time', detail: 'Response time below …', body: "tp.test('Response time is below ${1:500} ms', () => {\n\ttp.expect(tp.response.responseTime).to.be.below(${1:500});\n});" },
  { label: 'tp.test json field', detail: 'JSON field equals …', body: "tp.test('${1:field} is ${2:value}', () => {\n\tconst json = tp.response.json();\n\ttp.expect(json.${1:field}).to.eql(${3:'${2:value}'});\n});" },
  { label: 'tp.test json type', detail: 'JSON field has type …', body: "tp.test('${1:id} is a ${2:number}', () => {\n\ttp.expect(tp.response.json().${1:id}).to.be.a('${2:number}');\n});" },
  { label: 'tp.test header', detail: 'Header is present', body: "tp.test('Has ${1:Content-Type}', () => {\n\ttp.response.to.have.header('${1:Content-Type}');\n});" },
  { label: 'tp.test body contains', detail: 'Body contains text', body: "tp.test('Body contains ${1:text}', () => {\n\ttp.expect(tp.response.text()).to.include('${1:text}');\n});" },
  { label: 'tp.test json schema', detail: 'Response matches a JSON Schema', body: "const schema = {\n\ttype: 'object',\n\trequired: [${1:'id'}],\n};\ntp.test('Matches the schema', () => {\n\ttp.response.to.have.jsonSchema(schema);\n});" },
  { label: 'tp.environment.set', detail: 'Save a value for the next requests', body: "tp.environment.set('${1:token}', tp.response.json().${2:access_token});" },
  { label: 'tp.collectionVariables.set', detail: 'Save a collection variable', body: "tp.collectionVariables.set('${1:name}', ${2:value});" },
  { label: 'tp.environment.get', detail: 'Read an environment variable', body: "const ${1:value} = tp.environment.get('${2:name}');" },
  { label: 'tp.sendRequest', detail: 'Send another request from a script', body: "tp.sendRequest('${1:https://example.com}', (err, res) => {\n\tif (err) return console.log(err);\n\t${2:console.log(res.json());}\n});" },
  { label: 'tp.execution.setNextRequest', detail: 'Choose the next request of a run', body: "tp.execution.setNextRequest('${1:Request name}');" },
  { label: 'tp.visualizer.set', detail: 'Show the response as HTML', body: "tp.visualizer.set(`\n\t<table>{{#each items}}<tr><td>{{name}}</td></tr>{{/each}}</table>\n`, { items: tp.response.json()${1:} });" },
  { label: 'tp.variables.set date (moment)', detail: 'A date for the request, e.g. a week from now', body: "tp.variables.set('${1:dueDate}', moment().add(${2:7}, '${3:days}').format('${4:YYYY-MM-DD}'));" },
  { label: 'tp.variables.set fake value', detail: 'A made-up value (dynamic variable)', body: "tp.variables.set('${1:name}', tp.variables.replaceIn('{{\\$${2:randomFullName}}}'));" },
  { label: 'tp.test lodash', detail: 'Check a list with lodash', body: "tp.test('${1:Every item has an id}', () => {\n\tconst items = tp.response.json()${2:.items};\n\ttp.expect(_.every(items, '${3:id}')).to.be.true;\n});" },
  { label: 'tp.request.headers.upsert', detail: 'Set a request header (pre-request)', body: "tp.request.headers.upsert({ key: '${1:X-Request-Id}', value: ${2:tp.variables.replaceIn('{{\\$uuid}}')} });" },
];

/* ------------------------------------------------------------------ JSON schemas per editor model */

const schemas = new Map<string, unknown>();
let monacoRef: typeof Monaco | undefined;

/** Give the JSON editor with this `path` (see CodeEditor) a JSON Schema: completion, hover and validation. */
export function setEditorJsonSchema(path: string, schema: unknown | undefined): void {
  if (schema) schemas.set(path, schema);
  else schemas.delete(path);
  if (!monacoRef) return;
  monacoRef.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    enableSchemaRequest: false,
    schemas: [...schemas].map(([p, s]) => ({ uri: `inmemory://schema/${encodeURIComponent(p)}`, fileMatch: [p, `*${p}`], schema: s as never })),
  });
}

/* ------------------------------------------------------------------ variables of one editor */

const locals = new Map<string, string[]>();

/** Names that are defined for the editor with this `path` only, e.g. a prompt's input variables. */
export function setEditorLocalVariables(path: string, names: string[] | undefined): void {
  if (names?.length) locals.set(path, names);
  else locals.delete(path);
}

function localVariablesOf(model: Monaco.editor.ITextModel): VarInfo[] {
  const uri = model.uri.toString();
  for (const [path, names] of locals) if (uri === path || uri.endsWith(`/${path}`) || model.uri.path.replace(/^\//, '') === path) return names.map((name) => ({ name, scope: 'input' }));
  return [];
}

/* ------------------------------------------------------------------ install */

export function installEditorIntel(monaco: typeof Monaco): void {
  monacoRef = monaco;
  setEditorJsonSchema('__none__', undefined);

  // {{variable}} completion in every language
  for (const lang of LANGUAGES)
    monaco.languages.registerCompletionItemProvider(lang, {
      triggerCharacters: ['{'],
      provideCompletionItems: async (model, position) => {
        const line = model.getLineContent(position.lineNumber);
        const at = varAt(line, position.column);
        if (!at) return { suggestions: [] };
        const vars = [...localVariablesOf(model), ...(await editorVariables())];
        const range = new monaco.Range(position.lineNumber, at.start, position.lineNumber, position.column);
        return {
          suggestions: vars.map((v, i) => ({
            label: { label: v.name, description: v.scope },
            kind: v.scope === 'dynamic' ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable,
            detail: v.secret ? '•••••• (secret)' : v.value,
            documentation: { value: `**{{${v.name}}}** · ${v.scope ?? 'unknown scope'}${v.secret ? '\n\nSecret: the value is never shown.' : v.value ? `\n\n\`${v.value.slice(0, 200)}\`` : ''}` },
            insertText: at.open ? `${v.name}}}` : v.name,
            range,
            sortText: String(i).padStart(4, '0'),
          })),
        };
      },
    });

  // hover: what a {{variable}} resolves to, and where it comes from
  for (const lang of LANGUAGES)
    monaco.languages.registerHoverProvider(lang, {
      provideHover: async (model, position) => {
        const line = model.getLineContent(position.lineNumber);
        for (const m of line.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) {
          const start = m.index! + 1;
          const end = start + m[0].length;
          if (position.column < start || position.column > end) continue;
          const v = (await editorVariables()).find((x) => x.name === m[1]) ?? (isKnownVariable(m[1]!, new Set()) ? { name: m[1]!, scope: 'resolved at run time', value: m[1]!.startsWith('$env.') ? `environment variable ${m[1]!.slice(5)}` : 'secret' } : undefined);
          return {
            range: new monaco.Range(position.lineNumber, start, position.lineNumber, end),
            contents: [
              v
                ? { value: `**{{${v.name}}}** · ${v.scope ?? ''}\n\n${v.secret ? '•••••• (secret)' : `\`${(v.value ?? '').slice(0, 300)}\``}` }
                : { value: `**{{${m[1]}}}** is not defined in the active environment, collection, workspace or globals.` },
            ],
          };
        }
        return null;
      },
    });

  // highlight {{variables}}: blue when defined, red when not
  monaco.editor.onDidCreateEditor((ed) => {
    const editor = ed as Monaco.editor.ICodeEditor;
    let ids: string[] = [];
    let t: ReturnType<typeof setTimeout> | undefined;
    const paint = async () => {
      const model = editor.getModel();
      if (!model) return;
      const text = model.getValue();
      if (!text.includes('{{')) {
        ids = editor.deltaDecorations(ids, []);
        return;
      }
      const known = new Set([...localVariablesOf(model), ...(await editorVariables())].map((v) => v.name));
      // a script is not a template: {{x}} in it is resolved only where the script asks (tp.variables.replaceIn), and a
      // visualizer's Handlebars template uses the same braces for its own fields, so an unknown name is not an error there
      const script = model.getLanguageId() === 'javascript';
      const decos: Monaco.editor.IModelDeltaDecoration[] = [];
      for (const m of text.matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) {
        const ok = isKnownVariable(m[1]!, known);
        if (!ok && script) continue;
        const s = model.getPositionAt(m.index!);
        const e = model.getPositionAt(m.index! + m[0].length);
        decos.push({ range: new monaco.Range(s.lineNumber, s.column, e.lineNumber, e.column), options: { inlineClassName: ok ? 'editor-var' : 'editor-var-missing', hoverMessage: ok ? undefined : { value: `**{{${m[1]}}}** is not defined` } } });
        if (decos.length > 2000) break;
      }
      ids = editor.deltaDecorations(ids, decos);
    };
    const schedule = () => {
      clearTimeout(t);
      t = setTimeout(() => void paint(), 200);
    };
    editor.onDidChangeModelContent(schedule);
    editor.onDidChangeModel(schedule);
    schedule();
  });

  // variable names inside pm.environment.get('…') / pm.variables.set("…") / pm.globals.has(`…`) …
  const SCOPE_OF: Record<string, string | undefined> = { environment: 'environment', globals: 'global', collectionVariables: 'collection', variables: undefined, iterationData: undefined };
  monaco.languages.registerCompletionItemProvider('javascript', {
    triggerCharacters: ["'", '"', '`'],
    provideCompletionItems: async (model, position) => {
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      const m = /(?:pm|tp)\.(environment|globals|collectionVariables|variables|iterationData)\.(?:get|set|has|unset)\(\s*(['"`])([\w.$-]*)$/.exec(lineBefore);
      if (!m) return { suggestions: [] };
      const scope = SCOPE_OF[m[1]!];
      const vars = (await editorVariables()).filter((v) => v.scope !== 'dynamic' && (!scope || v.scope === scope));
      const range = new monaco.Range(position.lineNumber, position.column - m[3]!.length, position.lineNumber, position.column);
      return {
        suggestions: vars.map((v, i) => ({
          label: { label: v.name, description: v.scope },
          kind: monaco.languages.CompletionItemKind.Variable,
          detail: v.secret ? '•••••• (secret)' : v.value,
          insertText: v.name,
          range,
          sortText: String(i).padStart(4, '0'),
        })),
      };
    },
  });

  // pm / tp snippets in scripts
  monaco.languages.registerCompletionItemProvider('javascript', {
    // after "pm." only providers registered for '.' are asked
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => {
      const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
      // "pm.te" / "tp.environment.s": the snippet replaces the whole expression typed so far
      const expr = /(?:^|[^\w.$])((?:pm|tp)(?:\.\w*)*)$/.exec(lineBefore);
      if (!expr && /\.\s*\w*$/.test(lineBefore)) return { suggestions: [] }; // other member access: the type information handles it
      const word = model.getWordUntilPosition(position);
      const startColumn = expr ? position.column - expr[1]!.length : word.startColumn;
      const range = new monaco.Range(position.lineNumber, startColumn, position.lineNumber, position.column);
      return {
        // tp.* is the app's name for the API; someone typing pm. (Postman habits) gets the same snippets under pm.
        suggestions: (expr?.[1]?.startsWith('pm') ? SNIPPETS.map((s) => ({ ...s, label: s.label.replace(/^tp\./, 'pm.'), body: s.body.replace(/\btp\./g, 'pm.') })) : SNIPPETS).map((s) => ({
          label: s.label,
          kind: monaco.languages.CompletionItemKind.Snippet,
          detail: s.detail,
          documentation: { value: '```js\n' + s.body.replace(/\$\{\d+:([^}]*)\}/g, '$1').replace(/\$\{\d+\}/g, '') + '\n```' },
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          filterText: s.label,
          sortText: `~${s.label}`,
          range,
        })),
      };
    },
  });
}
