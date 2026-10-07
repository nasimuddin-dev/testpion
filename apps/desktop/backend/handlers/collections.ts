/** RPC handlers: Collections (requests, folders, examples, import/export) and their mock servers. */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { ApsError, dbKindOf, redactDbUrl, isSqliteDataset, collectionVariableFlow, listWorkspaceDatasets, readDataset, sqliteTables, fetchImportText, bruFilesToBrunoExport, collectionToBru, importIntoWorkspace, diffOpenApi, lintOpenApi, openApiOutline, workspaceApiCoverage, apiCoverageMarkdown, securityLint, certificateLint, listCertificates, variableFlow, startRecorder, recordingToCollection, type RecordedExchange, collectionToOpenApiText, collectionToHttpFile, exampleFromResponse, startMockServer, collectionMarkdown, collectionHtml, exportPostmanCollection, withRequestExamples, type SavedExample, convertCollectionScripts, importRequestSnippet, isRequestSnippet, type Collection, collectionSavedItems, duplicateCollection, shortId, requestBodySchema, loadOpenApi } from '@testpion/core';
import type { Backend, Handlers, CollectionRunParams } from '../backend.js';

/** An API definition's workspace path: a JSON or YAML file directly in specs/. */
const SPEC_PATH = /^specs\/[^/\\]+\.(json|ya?ml)$/i;

export function collectionsHandlers(be: Backend): Handlers {
  return {
    'col.list': () => be.ws.listCollections(),
    'col.save': (c: Collection) => {
      const r = be.ws.saveCollection(c);
      be.refreshMock(c.id);
      return r;
    },

    'mock.start': async ({ collectionId, port, delayMs, fallbackUrl }: { collectionId: string; port?: number; delayMs?: number; fallbackUrl?: string }) => {
      await be.mocks.get(collectionId)?.close();
      be.mocks.delete(collectionId);
      const c = be.ws.getCollection(collectionId);
      if (fallbackUrl && !/^https?:\/\/.+/i.test(fallbackUrl.trim())) throw new ApsError('ValidationError', 'The fallback must be an http(s) URL');
      const m = await startMockServer(c, { port: port ?? 0, delayMs, fallbackUrl: fallbackUrl?.trim() || undefined, onRequest: (e) => be.host.emit('mock.request', { collectionId, ...e, time: new Date().toISOString() }) });
      be.mocks.set(collectionId, m);
      be.logger.info(`Mock server for ${c.name} listening on ${m.url}`, { routes: m.routes.length });
      return be.mockInfo(collectionId);
    },
    'mock.stop': async ({ collectionId }: { collectionId: string }) => {
      await be.mocks.get(collectionId)?.close();
      be.mocks.delete(collectionId);
    },
    'mock.status': ({ collectionId }: { collectionId: string }) => be.mockInfo(collectionId),
    /** Copy a collection with its folders, requests, gRPC calls and connections (new ids throughout). */
    'col.duplicate': ({ id }: { id: string }) => duplicateCollection(be.ws, id, () => shortId('n-')),
    'col.delete': ({ id }: { id: string }) => {
      void be.mocks.get(id)?.close();
      be.mocks.delete(id);
      return be.ws.deleteCollection(id);
    },
    /** Save a response as an example of a saved request (sensitive headers and values are masked). */
    'col.addExample': (p: { collectionId: string; requestId: string; name: string; environment?: string; response: Parameters<typeof exampleFromResponse>[0]; request?: SavedExample['request'] }) => {
      const ctx = be.context({ environment: p.environment, collectionId: p.collectionId });
      const example = exampleFromResponse(p.response, { name: p.name, redactor: ctx.redactor, request: p.request });
      const c = withRequestExamples(be.ws.getCollection(p.collectionId), p.requestId, (list) => [...list, example]);
      be.ws.saveCollection(c);
      be.refreshMock(p.collectionId);
      return example;
    },
    /** Markdown documentation of a collection (the given draft, or the saved one), with secrets masked. */
    'col.docs': ({ id, collection, environment }: { id?: string; collection?: Collection; environment?: string }) => {
      const c = collection ?? be.ws.getCollection(id!);
      const ctx = be.context({ environment, collectionId: collection ? undefined : c.id });
      try {
        return collectionMarkdown(c, { redactor: ctx.redactor });
      } finally {
        void ctx.dispose();
      }
    },
    /** The documentation as a self-contained HTML page, saved through the host (or downloaded in a browser). */
    'col.exportDocsHtml': async ({ id, collection, environment }: { id?: string; collection?: Collection; environment?: string }) => {
      const c = collection ?? be.ws.getCollection(id!);
      const ctx = be.context({ environment, collectionId: collection ? undefined : c.id });
      try {
        const html = collectionHtml(c, { redactor: ctx.redactor });
        const name = `${c.name.replace(/[\\/:*?"<>|]+/g, '-')}.html`;
        return await be.saveOrDownload(name, [{ name: 'HTML', extensions: ['html'] }], (dest) => writeFileSync(dest, html), () => Buffer.from(html));
      } finally {
        await ctx.dispose();
      }
    },
    /** Replace a saved request's examples (rename, edit, delete). */
    'col.setExamples': (p: { collectionId: string; requestId: string; examples: SavedExample[] }) => {
      be.ws.saveCollection(withRequestExamples(be.ws.getCollection(p.collectionId), p.requestId, () => p.examples));
      be.refreshMock(p.collectionId);
      return p.examples;
    },
    /** Rewrite a collection's scripts between tp.* and pm.*; `dryRun` only counts. */
    'col.convertScripts': ({ collectionId, to, dryRun }: { collectionId: string; to: 'tp' | 'pm'; dryRun?: boolean }) => {
      const c = be.ws.getCollection(collectionId);
      const r = convertCollectionScripts(c, to === 'tp' ? 'pm' : 'tp', to);
      if (!dryRun && r.changed) be.ws.saveCollection(r.collection);
      return { changed: r.changed, replacements: r.replacements, skipped: r.skipped, collection: dryRun ? r.collection : undefined };
    },
    'col.import': ({ text, fileName }: { text: string; fileName?: string }) => {
      // ".env.staging" / "staging.env" → "staging"; a bare ".env" keeps the default name
      const envName = fileName ? fileName.replace(/^\.env\.?/, '').replace(/\.env$/, '') || undefined : undefined;
      if (isRequestSnippet(text)) {
        // a copied cURL / fetch / PowerShell request goes into the "Imported" collection; secrets become {{variables}}
        const r = importRequestSnippet(be.ws.listCollections().filter((c) => !c.problem), text, be.logger.redactor);
        const saved = be.ws.saveCollection(r.collection);
        return { format: r.format, collection: saved.name, collectionId: saved.id, request: r.node.name, placeholders: r.placeholders };
      }
      // an OpenAPI document is kept in specs/ and its requests get an openapi contract check
      // .env imports: secret-looking values go to the OS secret store, never into workspace files
      const r = importIntoWorkspace(be.ws, text, { name: envName, secrets: be.secrets });
      return { format: r.format, collection: r.collection?.name, environment: r.environments?.map((e) => e.name).join(', ') || r.environment?.name, specPath: r.specPath, contractChecks: r.contractChecks, scriptWarnings: r.scriptWarnings, savedItems: r.savedItems, notes: r.notes };
    },
    /** Record traffic: a reverse proxy on 127.0.0.1 in front of `target`; every exchange is sent as a `record.exchange` event. */
    'record.start': async ({ target, port }: { target: string; port?: number }) => {
      await be.recorder?.close();
      const summary = (e: RecordedExchange) => ({ id: e.id, time: e.time, method: e.method, path: be.logger.redactor.redactUrl(`http://x${e.path}`).slice(8), status: e.status, durationMs: e.durationMs, error: e.error });
      be.recorder = await startRecorder({ target, port, onExchange: (e) => be.host.emit('record.exchange', summary(e)) });
      return { url: be.recorder.url, target: be.recorder.target };
    },
    'record.stop': async () => {
      await be.recorder?.close();
      const n = be.recorder?.exchanges.length ?? 0;
      return { exchanges: n };
    },
    'record.status': () => (be.recorder ? { url: be.recorder.url, target: be.recorder.target, exchanges: be.recorder.exchanges.length } : null),
    /** Save what was recorded as a collection (secrets become {{variables}}; responses become examples). */
    'record.save': ({ name }: { name: string }) => {
      if (!be.recorder?.exchanges.length) throw new ApsError('ValidationError', 'Nothing recorded yet');
      const r = recordingToCollection(be.recorder.exchanges, { name: name.trim() || 'Recorded', target: be.recorder.target, redactor: be.logger.redactor });
      const saved = be.ws.saveCollection(r.collection);
      return { collectionId: saved.id, name: saved.name, requests: r.requests, placeholders: r.placeholders.map((p) => p.variable) };
    },
    'record.clear': () => void be.recorder?.exchanges.splice(0),
    /** Security findings in a collection's request definitions (typed-in secrets, secrets in URLs, plain http …). */
    'col.securityLint': ({ id, environment }: { id: string; environment?: string }) => {
      const c = be.ws.getCollection(id);
      // variables the requests use that the environment, collection, workspace and globals don't define
      const ctx = be.context({ environment, collectionId: id });
      try {
        return [...securityLint(c, be.settings.redactFields), ...certificateLint(c, (u) => ctx.vars.resolve(u), listCertificates(be.ws)), ...variableFlow(c, Object.keys(ctx.vars.toObject()))];
      } finally {
        void ctx.dispose();
      }
    },
    /** OpenAPI documents kept in the workspace (specs/), for comparing versions. */
    'openapi.specs': () => {
      const dir = be.ws.path('specs');
      return existsSync(dir) ? readdirSync(dir).filter((f) => /\.(json|ya?ml)$/i.test(f)).map((f) => `specs/${f}`) : [];
    },
    /**
     * The JSON Schema a request's body should follow, from the operation it maps to in one of the workspace's API
     * definitions (specs/): the body editor completes and checks against it. {{variables}} in the URL resolve first.
     */
    'openapi.bodySchema': ({ method, url, environment }: { method: string; url: string; environment?: string }) => {
      const dir = be.ws.path('specs');
      if (!existsSync(dir) || !url) return null;
      const ctx = be.context({ environment });
      try {
        const resolved = ctx.vars.resolve(url);
        for (const f of readdirSync(dir).filter((x) => /\.(json|ya?ml)$/i.test(x)).sort()) {
          try {
            const r = requestBodySchema(loadOpenApi(readFileSync(join(dir, f), 'utf8')), method, resolved);
            if (r) return { ...r, spec: `specs/${f}` };
          } catch {
            /* not an OpenAPI document, or unreadable: the next one */
          }
        }
        return null;
      } finally {
        void ctx.dispose();
      }
    },
    /** The text of an OpenAPI document kept in the workspace (specs/), for its editor tab. */
    'openapi.spec.get': ({ path }: { path: string }) => {
      if (!SPEC_PATH.test(path)) throw new ApsError('ValidationError', `Not an API definition in specs/: ${path}`);
      return { path, text: readFileSync(be.ws.safePath(path), 'utf8') };
    },
    /** Save an OpenAPI document edited in its tab (only files in specs/). */
    'openapi.spec.save': ({ path, text }: { path: string; text: string }) => {
      if (!SPEC_PATH.test(path)) throw new ApsError('ValidationError', `Not an API definition in specs/: ${path}`);
      writeFileSync(be.ws.safePath(path), text);
      return { path };
    },
    /** An OpenAPI document as a reader sees it: operations by tag, parameters, bodies, responses, a request per operation. */
    'openapi.outline': ({ path, text }: { path?: string; text?: string }) => {
      if (text === undefined && (!path || !SPEC_PATH.test(path))) throw new ApsError('ValidationError', `Not an API definition in specs/: ${path ?? ''}`);
      return openApiOutline(text ?? readFileSync(be.ws.safePath(path!), 'utf8'));
    },
    /** Lint problems of an OpenAPI document (the text being edited, or a document in specs/), with their places. */
    'openapi.lint': ({ path, text, disable }: { path?: string; text?: string; disable?: string[] }) => {
      if (text === undefined && (!path || !SPEC_PATH.test(path))) throw new ApsError('ValidationError', `Not an API definition in specs/: ${path ?? ''}`);
      return lintOpenApi(text ?? readFileSync(be.ws.safePath(path!), 'utf8'), { disable });
    },
    /** Breaking and other changes between two OpenAPI versions; each side is a workspace path, a link or the text. */
    'openapi.diff': async ({ old, new: next }: { old: { path?: string; url?: string; text?: string }; new: { path?: string; url?: string; text?: string } }) => {
      const read = async (s: { path?: string; url?: string; text?: string }) =>
        s.text ?? (s.url ? (await fetchImportText(s.url)).text : s.path ? readFileSync(be.ws.safePath(s.path), 'utf8') : '');
      return diffOpenApi(await read(old), await read(next));
    },
    /** API coverage of an OpenAPI document by test runs (default: the latest) and optionally the request history. */
    'openapi.coverage': async (p: { spec: { path?: string; url?: string; text?: string }; runs?: string[]; history?: number; baseUrl?: string; excludeDeprecated?: boolean }) => {
      const s = p.spec ?? {};
      const text = s.text ?? (s.url ? (await fetchImportText(s.url)).text : s.path ? readFileSync(be.ws.safePath(s.path), 'utf8') : '');
      if (!text.trim()) throw new ApsError('ValidationError', 'Choose an OpenAPI document');
      const { report, sources } = await workspaceApiCoverage(be.ws, text, {
        runs: p.runs?.length ? p.runs : undefined,
        history: p.history && p.history > 0 ? Math.min(p.history, 10_000) : undefined,
        baseUrl: p.baseUrl?.trim() || undefined,
        excludeDeprecated: p.excludeDeprecated,
      });
      return { report, sources, markdown: apiCoverageMarkdown(report) };
    },
    /** Import from a link: an OpenAPI URL, a raw GitHub file, a Postman API link … (downloaded, then imported as text). */
    'col.importUrl': async ({ url }: { url: string }) => {
      const f = await fetchImportText(url);
      return { ...((await be.handlers['col.import']!({ text: f.text, fileName: f.fileName })) as object), url: f.url };
    },
    /** A Bruno collection folder, as the picked files (path inside the folder + text): bruno.json and .bru files. */
    'col.importBrunoFolder': ({ name, files }: { name?: string; files: Array<{ path: string; text: string }> }) => {
      if (!files?.some((f) => f.path.endsWith('.bru'))) throw new ApsError('ValidationError', 'That folder has no .bru files', { suggestions: ['Choose the folder that holds bruno.json.'] });
      const exported = bruFilesToBrunoExport(files, files.some((f) => f.path === 'bruno.json') ? undefined : name);
      return be.handlers['col.import']!({ text: JSON.stringify(exported), fileName: name });
    },
    'col.importFile': async () => {
      const f = await be.host.openDialog?.({ filters: [{ name: 'API definitions, collections, .env and .http files', extensions: ['json', 'yaml', 'yml', 'har', 'env', 'wsdl', 'xml', 'bru', 'http', 'rest'] }, { name: 'All files', extensions: ['*'] }] });
      if (!f) return null;
      return be.handlers['col.import']!({ text: readFileSync(f, 'utf8'), fileName: basename(f) });
    },
    'col.run': (p: CollectionRunParams) => be.startCollectionRun(p),
    /** Run again only the requests that failed in a collection run (one iteration). */
    'col.rerunFailed': ({ runId, collectionId, environment }: { runId: string; collectionId: string; environment?: string }) => {
      const r = be.ws.failedTestIds(runId);
      if (!r.ids.length) throw new ApsError('ValidationError', 'Nothing failed in that run');
      const c = be.ws.getCollection(collectionId);
      return be.startCollectionRun({ collectionId, selection: r.ids, environment, name: `Failed requests of ${c.name}` });
    },
    /** Which requests set and use each variable of a collection, in run order, with likely mistakes flagged. */
    'col.variableFlow': ({ collectionId }: { collectionId: string }) => {
      const defined = [...be.ws.listEnvironments().flatMap((e) => e.variables.map((v) => v.key)), ...(be.ws.workspace.variables ?? []).map((v) => v.key), ...(be.settings.globalVariables ?? []).map((v) => v.key)];
      return collectionVariableFlow(be.ws.getCollection(collectionId), defined);
    },
    /** Data files in the workspace's datasets/ folder (for the Collection Runner and tests), newest first. */
    'datasets.list': () =>
      listWorkspaceDatasets(be.ws).map((d) => ({ path: join(be.ws.root, d.path), name: d.path.replace(/^datasets\//, ''), size: d.size, modified: d.modified, format: d.format, tables: d.tables })),
    /** The text of a dataset file in the workspace's datasets/ folder (CSV, JSON, JSONL, Markdown; up to 20 MB). */
    'datasets.read': ({ path }: { path: string }) => {
      const root = be.ws.path('datasets');
      const file = be.ws.safePath(relative(root, path), root);
      if (!/\.(csv|tsv|json|jsonl|ndjson|md)$/i.test(file)) throw new ApsError('ValidationError', 'Only CSV, JSON, JSONL and Markdown datasets can be opened as text');
      if (statSync(file).size > 20 * 1024 * 1024) throw new ApsError('ValidationError', 'The dataset is larger than 20 MB');
      return { name: relative(root, file).split(sep).join('/'), text: readFileSync(file, 'utf8') };
    },
    /** Save rows (CSV text, e.g. a response's table) as datasets/<name>.csv; never overwrites: name-2.csv etc. */
    'datasets.saveCsv': ({ name, text }: { name: string; text: string }) => {
      if (text.length > 50 * 1024 * 1024) throw new ApsError('ValidationError', 'The data is larger than 50 MB');
      const base = basename(name).replace(/\.csv$/i, '').replace(/[^\w.-]+/g, '_').slice(0, 100) || 'data';
      const dir = be.ws.path('datasets');
      mkdirSync(dir, { recursive: true });
      let dest = join(dir, `${base}.csv`);
      for (let i = 2; existsSync(dest); i++) dest = join(dir, `${base}-${i}.csv`);
      writeFileSync(dest, text);
      be.host.emit('data.changed', { kind: 'datasets' });
      return { path: dest, name: relative(dir, dest).split(sep).join('/') };
    },
    /**
     * A data file uploaded from the browser (no native file picker): it is stored in the workspace's
     * datasets/uploads folder and previewed like a picked file.
     */
    'col.uploadDataFile': async ({ name, text }: { name: string; text: string }) => {
      if (text.length > 50 * 1024 * 1024) throw new ApsError('ValidationError', 'The data file is larger than 50 MB');
      const safe = basename(name).replace(/[^\w.-]+/g, '_').slice(0, 120) || 'data.csv';
      if (!/\.(csv|json|jsonl)$/i.test(safe)) throw new ApsError('ValidationError', 'Use a .csv, .json or .jsonl file');
      const dir = be.ws.path('datasets', 'uploads');
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, safe);
      writeFileSync(dest, text);
      return be.handlers['col.previewDataFile']!({ path: dest });
    },
    /** Pick a CSV/JSON data file for a collection run; returns a preview of its rows. */
    'col.pickDataFile': async () => {
      const f = await be.host.openDialog?.({ filters: [{ name: 'Data files', extensions: ['csv', 'json', 'jsonl', 'db', 'sqlite', 'sqlite3'] }] });
      return f ? be.handlers['col.previewDataFile']!({ path: f }) : null;
    },
    'col.previewDataFile': async ({ path, query, environment }: { path: string; query?: string; environment?: string }) => {
      // a PostgreSQL / MySQL database (a URL, {{variables}} allowed, or env:NAME): its tables, and the rows of the query
      if (dbKindOf(path) || /^env:\w+$/.test(path) || /^\{\{/.test(path.trim())) {
        const name = redactDbUrl(path);
        let tables: string[] = [];
        try {
          const kind = dbKindOf(path) ?? 'postgres';
          const list = kind === 'postgres' ? "SELECT table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY 1" : 'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY 1';
          tables = (await be.readRunData(path, list, environment)).map((r) => String(r.t ?? r.T ?? r.TABLE_NAME ?? ''));
        } catch (e) {
          // a wrong URL or password is said once, here, rather than on every query
          if ((e as ApsError).kind === 'NetworkError' || !query) throw e;
        }
        if (!query) return { path, name, count: 0, columns: [], preview: [], tables, query: '' };
        const rows = await be.readRunData(path, query, environment);
        const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
        return { path, name, count: rows.length, columns, preview: rows.slice(0, 20), tables, query };
      }
      // a SQLite database needs a query: start with its first table
      let tables: string[] | undefined;
      if (isSqliteDataset(path)) {
        tables = sqliteTables(path);
        const select = (t: string) => `SELECT * FROM "${t.replace(/"/g, '""')}"`;
        if (!query) {
          // the first table that has rows (else the first table)
          for (const t of tables) {
            const it = readDataset({ path, query: select(t), limit: 1 })[Symbol.asyncIterator]();
            if (!(await it.next()).done) {
              query = select(t);
              break;
            }
          }
          query ??= tables[0] ? select(tables[0]) : undefined;
        }
        if (!query) return { path, name: basename(path), count: 0, columns: [], preview: [], tables, query: '' };
      }
      const rows = await be.readRunData(path, query, environment);
      const columns = [...new Set(rows.slice(0, 50).flatMap((r) => Object.keys(r)))];
      return { path, name: basename(path), count: rows.length, columns, preview: rows.slice(0, 20), ...(tables ? { tables, query } : {}) };
    },
    /** Export a collection as TestPion JSON or a Postman v2.1 collection (`notes` lists what Postman can't hold). */
    'col.export': async ({ id, format = 'testpion' }: { id: string; format?: 'testpion' | 'postman' | 'openapi' | 'bruno' | 'http' }) => {
      const c = be.ws.getCollection(id);
      if (format === 'bruno') {
        // a Bruno collection folder, with the workspace's environments (secret values never); written into a chosen folder
        const files = collectionToBru(c, be.ws.listEnvironments());
        const parent = await be.host.openDialog?.({ directory: true });
        if (!parent) {
          if (!be.host.openDialog) throw new ApsError('ValidationError', 'Exporting a Bruno folder needs the desktop app', { suggestions: ['Use testpion export "<collection>" --format bruno --out <folder>.'] });
          return { name: c.name, notes: [] as string[] };
        }
        // a folder name, never a path: a collection called ".." must not write outside the chosen folder
        const out = join(parent, c.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+/, '').trim() || 'collection');
        for (const f of files) {
          const p = join(out, ...f.path.split('/'));
          mkdirSync(dirname(p), { recursive: true });
          writeFileSync(p, f.text);
        }
        return { path: out, name: c.name, notes: [] as string[] };
      }
      if (format === 'http') {
        // one .http file for VS Code REST Client and the JetBrains HTTP Client
        const { text, notes } = collectionToHttpFile(c);
        const name = `${c.name}.http`;
        const dest = await be.host.saveDialog?.({ defaultPath: name, filters: [{ name: 'HTTP requests', extensions: ['http', 'rest'] }] });
        if (dest) writeFileSync(dest, text);
        return { path: dest, text: dest ? undefined : text, name, notes };
      }
      if (format === 'openapi') {
        // an OpenAPI 3.1 description of the collection's HTTP requests (YAML)
        const text = collectionToOpenApiText(c);
        const name = `${c.name}.openapi.yaml`;
        const dest = await be.host.saveDialog?.({ defaultPath: name, filters: [{ name: 'OpenAPI', extensions: ['yaml', 'yml'] }] });
        if (dest) writeFileSync(dest, text);
        return { path: dest, text: dest ? undefined : text, name, notes: [] as string[] };
      }
      // a TestPion collection file carries its gRPC calls and connections too (Postman's format can't)
      const savedItems = collectionSavedItems(be.ws, c.id);
      const { collection, notes } =
        format === 'postman'
          ? exportPostmanCollection(c)
          : { collection: { ...c, ...(savedItems ? { savedItems } : {}) } as unknown as Record<string, unknown>, notes: [] as string[] };
      if (format === 'postman' && savedItems) notes.push(`${Object.values(savedItems).reduce((n, l) => n + (l?.length ?? 0), 0)} gRPC call(s) or connection(s) aren't in the Postman file (its format has no place for them); export in TestPion's format to keep them`);
      const name = format === 'postman' ? `${c.name}.postman_collection.json` : `${c.name}.collection.json`;
      const dest = await be.host.saveDialog?.({ defaultPath: name, filters: [{ name: 'Collection', extensions: ['json'] }] });
      if (dest) writeFileSync(dest, JSON.stringify(collection, null, 2));
      return { path: dest, collection: dest ? undefined : collection, name, notes };
    },
  };
}
