import type { Collection, Environment } from '../model/types.js';
import type { ArazzoFlowFile } from './arazzo.js';
import type { ImportScriptsSummary } from './import-scripts.js';
import type { ScriptTool } from '../scripts/convert/index.js';

/**
 * The intermediate import model (import-compat plan 4a). Every importer is a pure parser from its source format to an
 * `ImportDocument`; one shared pipeline (pipeline.ts) then converts the scripts, makes node ids unique, places the
 * findings on their items and builds the compatibility report (report.ts). Nothing here touches a workspace: writing
 * is `importIntoWorkspace` / `planImport`, so the same document backs the preview, the import and the undo.
 *
 * The collections are TestPion's own model (the common currency the editor, runner and exporters speak), carried with
 * what the parser could not represent as `findings`: nothing is dropped silently.
 */

/**
 * `info`: worth knowing, nothing was lost (a value came over as a secret, a name was changed);
 * `changed`: imported with a change (an auth scheme replaced, a template tag converted, a script line marked TODO);
 * `not-imported`: left out, the finding says why.
 */
export type FindingSeverity = 'info' | 'changed' | 'not-imported';

export interface ImportFinding {
  /** A stable code (`AUTH_UNSUPPORTED`, `TEMPLATE_TAG`, `SCRIPT_API`, `VALUE_NEEDED` …): the report groups by it. */
  code: string;
  severity: FindingSeverity;
  /** The item concerned: its path of names (`['Users', 'Create user']`), `[]` for the collection or the file as a whole. */
  where: string[];
  /** The field of the item (`auth`, `body`, `script:test`, `settings.disableCookies`). */
  field?: string;
  /** The finding as one line. Also the `notes` entry of the import result (which predates findings and stays for compatibility). */
  message: string;
  suggestion?: string;
  /** The original text (a template tag, a script line), for "show me what it was". */
  original?: string;
  /** Not a note of the import result (a finding the report adds to what `notes` always said). */
  reportOnly?: boolean;
}

/** The findings of one import, collected while parsing. */
export class Findings {
  readonly list: ImportFinding[] = [];
  add(f: Omit<ImportFinding, 'where'> & { where?: string[] }): void {
    this.list.push({ where: [], ...f });
  }
  /** A legacy note (a line of text): classified by its wording, see `findingFromNote`. */
  note(text: string, where?: string[]): void {
    this.list.push(findingFromNote(text, where));
  }
  notes(texts: string[]): void {
    for (const t of texts) this.note(t);
  }
}

/** Codes of findings that need an action by the user before the imported collection works. */
export const ACTION_CODES: ReadonlySet<string> = new Set(['VALUE_NEEDED', 'AUTH_UNSUPPORTED', 'TEMPLATE_TAG_UNSUPPORTED', 'SCRIPT_API']);

/**
 * A note written as a line of text (the form every importer used before findings) as a finding: its code and severity
 * come from its wording, the item from its leading `"Name":`. The importers that know better (Postman, Insomnia,
 * Bruno, Hoppscotch and the shared auth mapping) add structured findings; this keeps the rest correct.
 */
export function findingFromNote(text: string, where?: string[]): ImportFinding {
  const quoted = /^(?:Folder |Environment )?"([^"]+)"/.exec(text)?.[1];
  const w = where ?? (quoted ? [quoted] : []);
  const t = text;
  const rule = (code: string, severity: FindingSeverity): ImportFinding => ({ code, severity, where: w, message: text });
  if (/^Values needed:/i.test(t)) return rule('VALUE_NEEDED', 'changed');
  if (/is not supported, so it was set to No auth|auth "[^"]+".* is not supported/.test(t)) return rule('AUTH_UNSUPPORTED', 'changed');
  if (/TODO\(import\)/.test(t)) return rule('SCRIPT_API', 'changed');
  if (/template tag|\{% ?\w+/i.test(t)) return rule(/stays as text|not supported|unsupported/i.test(t) ? 'TEMPLATE_TAG_UNSUPPORTED' : 'TEMPLATE_TAG', 'changed');
  if (/not imported|are not imported|was not imported|were not imported|cannot be imported|is not imported/i.test(t)) return rule('NOT_IMPORTED', 'not-imported');
  if (/\.env: /.test(t)) return rule('SECRET_VALUES', 'info');
  if (/renamed because/.test(t)) return rule('IDS_RENAMED', 'info');
  return rule('NOTE', 'changed');
}

export interface ImportDocument {
  /** What `detectFormat` returned. */
  format: string;
  /** The tool and version the file came from, when it says (`Postman`, `Insomnia 5.1`). */
  tool?: string;
  version?: string;
  /** How many files the import read (a folder or an archive has several) and their size. */
  fileCount: number;
  bytes: number;
  collections: Collection[];
  environments: Environment[];
  /** Secret values by environment id and variable (a .env file): to the secret store, never workspace files. */
  secretValues?: Record<string, Record<string, string>>;
  /** gRPC calls and connections (library items), by kind. */
  savedItems?: unknown;
  flows?: ArazzoFlowFile[];
  /** A schema or definition to keep in the workspace (a GraphQL SDL: specs/graphql/<name>.graphql). */
  specFile?: { path: string; text: string };
  findings: ImportFinding[];
  /** The script API the source speaks: its scripts are converted to `tp.*` by the pipeline. */
  scriptTool?: ScriptTool;
  /** Set by the pipeline: what happened to the scripts. */
  scripts?: ImportScriptsSummary;
}

/** An empty document for a format (the importers fill it in). */
export function newDocument(format: string, text: string, extra: Partial<ImportDocument> = {}): ImportDocument {
  return { format, fileCount: 1, bytes: Buffer.byteLength(text), collections: [], environments: [], findings: [], ...extra };
}
