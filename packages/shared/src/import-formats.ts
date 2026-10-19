/**
 * The formats the importer recognises (core's `detectFormat`) and the file extensions each one comes in. The file
 * pickers of every Import (the Import dialog, the workspace menu's Import…, the native dialogs) take their filter from
 * here, so a format the importer learns is a file the pickers offer: `detectFormat` returns an `ImportFormat`, and the
 * compiler insists every one of them has its extensions below.
 */
export const IMPORT_FORMATS = {
  openapi: ['json', 'yaml', 'yml'],
  swagger: ['json', 'yaml', 'yml'],
  postman: ['json'],
  'postman-env': ['json'],
  har: ['har', 'json'],
  'aps-collection': ['json'],
  'aps-workspace': ['json'],
  'graphql-sdl': ['graphql', 'gql', 'graphqls', 'sdl'],
  insomnia: ['json', 'yaml', 'yml'],
  bruno: ['bru', 'json'],
  opencollection: ['yml', 'yaml', 'json'],
  hoppscotch: ['json'],
  dotenv: ['env'],
  wsdl: ['wsdl', 'xml'],
  asyncapi: ['yaml', 'yml', 'json'],
  'http-file': ['http', 'rest'],
  arazzo: ['yaml', 'yml', 'json'],
} as const satisfies Record<string, readonly string[]>;

/** A format `detectFormat` recognises. */
export type ImportFormat = keyof typeof IMPORT_FORMATS;

/** A request copied as cURL, fetch, PowerShell or HTTPie, saved to a file: imported into the "Imported" collection. */
export const REQUEST_COMMAND_EXTENSIONS = ['txt', 'sh', 'ps1'] as const;

/** Every extension an Import file picker offers (without the dot), each once. */
export const IMPORT_FILE_EXTENSIONS: readonly string[] = [...new Set([...Object.values(IMPORT_FORMATS).flat(), ...REQUEST_COMMAND_EXTENSIONS])];

/** The `accept` of a browser file input for an Import (".json,.yaml,…"). */
export const IMPORT_FILE_ACCEPT = IMPORT_FILE_EXTENSIONS.map((e) => `.${e}`).join(',');

/** The filters of a native Import file dialog: the importable files (named `label`), then all files. */
export function importFileFilters(label: string): Array<{ name: string; extensions: string[] }> {
  return [
    { name: label, extensions: [...IMPORT_FILE_EXTENSIONS] },
    { name: 'All files', extensions: ['*'] },
  ];
}
