import type { Collection } from '../model/types.js';
import { ApsError } from '../errors.js';
import { shortId } from '../util/ids.js';
import { importWsdl } from './wsdl.js';
import { parseBruno, parseHoppscotch, parseInsomnia } from './other-tools.js';
import { importDotenv } from './dotenv.js';
import { importAsyncApi } from './asyncapi.js';
import { importHttpFile } from './http-file.js';
import type { ImportScriptsMode } from './import-scripts.js';
import { importArazzo } from './arazzo.js';
import { importGraphqlSdl } from './graphql-sdl.js';
import { detectFormat } from './detect.js';
import { parseOpenApi } from './openapi-import.js';
import { parsePostman, parsePostmanEnvironment } from './postman-import.js';
import { parseHar } from './har-import.js';
import { parseOpenCollection } from './opencollection-import.js';
import { Findings, newDocument, type ImportDocument } from './model.js';
import { finishDocument, legacyResult, type ImportAnyResult } from './pipeline.js';
import { buildReport, type ImportReport } from './report.js';

/**
 * The import entry points. `parseImport` reads any supported text into an import document (model.ts), `finishDocument`
 * (pipeline.ts) converts its scripts and makes its ids unique, `buildReport` (report.ts) says what came over and what
 * did not. `importAny` is those three as the result the CLI, the app and MCP have always had.
 */

export { detectFormat } from './detect.js';
export { sampleFromSchema, importOpenApi } from './openapi-import.js';
export { importPostman, importPostmanEnvironment } from './postman-import.js';
export { importHar } from './har-import.js';
export type { ImportAnyResult } from './pipeline.js';

/** Read any supported text into an import document (scripts not yet converted, ids not yet made unique). */
export function parseImport(text: string, opts: { name?: string } = {}): ImportDocument {
  const format = detectFormat(text);
  switch (format) {
    case 'openapi':
    case 'swagger':
      return parseOpenApi(text, format);
    case 'postman':
      return parsePostman(text);
    case 'postman-env':
      return parsePostmanEnvironment(text);
    case 'har':
      return parseHar(text);
    case 'insomnia':
      return parseInsomnia(text);
    case 'bruno':
      return parseBruno(text);
    case 'opencollection':
      return parseOpenCollection(text);
    case 'hoppscotch':
      return parseHoppscotch(text);
    case 'graphql-sdl': {
      const r = importGraphqlSdl(text, opts.name);
      const f = new Findings();
      f.notes(r.notes);
      return newDocument(format, text, { tool: 'GraphQL', collections: [r.collection], specFile: r.specFile, findings: f.list });
    }
    case 'wsdl':
      return newDocument(format, text, { tool: 'WSDL', collections: [importWsdl(text).collection] });
    case 'http-file': {
      const r = importHttpFile(text, { name: opts.name?.replace(/\.(http|rest)$/i, '') || undefined });
      const f = new Findings();
      f.notes(r.notes);
      return newDocument(format, text, { tool: '.http file', collections: [r.collection], findings: f.list });
    }
    case 'asyncapi': {
      const r = importAsyncApi(text);
      return newDocument(format, text, { tool: 'AsyncAPI', collections: [r.collection], environments: r.environment ? [r.environment] : [], savedItems: r.savedItems });
    }
    case 'dotenv': {
      const r = importDotenv(text, opts.name);
      return newDocument(format, text, { tool: '.env', environments: [r.environment], secretValues: { [r.environment.id]: r.secretValues } });
    }
    case 'arazzo': {
      // without the OpenAPI documents (importIntoWorkspace finds them): operationPath steps still convert
      const r = importArazzo(text);
      const f = new Findings();
      f.notes(r.notes);
      return newDocument(format, text, { tool: 'Arazzo', flows: r.flows, findings: f.list });
    }
    case 'aps-collection': {
      // `savedItems` (its gRPC calls and connections) are restored by importIntoWorkspace, not kept in the collection
      const { savedItems: _items, ...c } = JSON.parse(text) as Collection & { savedItems?: unknown };
      // a native import keeps its node ids: finishDocument makes them unique in the workspace
      return newDocument(format, text, { tool: 'TestPion', collections: [{ ...c, id: c.id || shortId('col-') }] });
    }
    default: {
      // a file that is meant to be JSON but doesn't parse: say where, not just "unknown format"
      const t = text.trimStart();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          JSON.parse(t);
        } catch (e) {
          const msg = (e as Error).message;
          const pos = /position (\d+)/.exec(msg);
          const at = pos ? (() => { const before = t.slice(0, Number(pos[1])).split('\n'); return ` (line ${before.length}, column ${before.at(-1)!.length + 1})`; })() : '';
          throw new ApsError('ValidationError', `The file is not valid JSON${at}: ${msg.replace(/ in JSON at position \d+.*$/s, '')}`, {
            suggestions: ['Fix the JSON (a stray backslash or a missing comma is common), then import it again.'],
          });
        }
      }
      throw new ApsError('ValidationError', `Unrecognised import format (${format})`, {
        suggestions: ['Supported: OpenAPI 3 / Swagger 2 (JSON or YAML), Postman v2.1 collections & environments, Insomnia (v4 export, v5 YAML), Bruno collections (folder, .bru file or export, OpenCollection YAML), Hoppscotch collections, WSDL 1.1 and 2.0 (SOAP), AsyncAPI 2 and 3 (Kafka, MQTT, WebSocket), .http / .rest files (REST Client, JetBrains), .env files, HAR, GraphQL schemas (SDL), TestPion collections and workspace exports, Arazzo 1.0 workflows (as flow files).'],
      });
    }
  }
}

/** A text read, converted and checked: the document with its report (nothing is written anywhere). */
export function importDocument(text: string, opts: { name?: string; scripts?: ImportScriptsMode; takenIds?: Iterable<string> } = {}): { document: ImportDocument; report: ImportReport } {
  const document = finishDocument(parseImport(text, opts), opts);
  return { document, report: buildReport(document) };
}

/**
 * Import any supported document into a collection (and optionally an environment). Node ids (folders, requests) are
 * made unique: against `takenIds` (the workspace's other collections, `workspaceNodeIds`) and within the file, so an
 * imported collection never shares ids with another one (a TestPion file imported twice, say); a note says how many changed.
 */
export function importAny(text: string, opts: { name?: string; scripts?: ImportScriptsMode; takenIds?: Iterable<string> } = {}): ImportAnyResult {
  return legacyResult(finishDocument(parseImport(text, opts), opts));
}
