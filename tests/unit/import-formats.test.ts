import { describe, expect, it } from 'vitest';
import { detectFormat, IMPORT_FILE_ACCEPT, IMPORT_FILE_EXTENSIONS, IMPORT_FORMATS, importFileFilters, type ImportFormat } from '../../packages/core/src/index.js';

// One list of importable files (shared/import-formats.ts): every format the importer detects has its extensions there,
// and every Import picker (the dialog's browser input, the native dialogs of Import… and the workspace menu) offers them.
const SAMPLES: Record<ImportFormat, { file: string; text: string }> = {
  openapi: { file: 'api.yaml', text: 'openapi: 3.0.0\ninfo: { title: A, version: "1" }\npaths: {}\n' },
  swagger: { file: 'api.json', text: '{"swagger":"2.0","info":{"title":"A"},"paths":{}}' },
  postman: { file: 'c.json', text: '{"info":{"_postman_id":"x","name":"C"},"item":[]}' },
  'postman-env': { file: 'e.json', text: '{"_postman_variable_scope":"environment","name":"E","values":[]}' },
  har: { file: 'h.har', text: '{"log":{"entries":[]}}' },
  'aps-collection': { file: 'c.json', text: '{"schemaVersion":1,"items":[]}' },
  'aps-workspace': { file: 'w.json', text: '{"format":"testpion-workspace"}' },
  'graphql-sdl': { file: 'schema.graphql', text: 'type Query {\n  pets: [String]\n}\n' },
  insomnia: { file: 'i.json', text: '{"_type":"export","resources":[]}' },
  bruno: { file: 'r.bru', text: 'meta {\n  name: r\n}\n\nget {\n  url: https://x.test\n}\n' },
  hoppscotch: { file: 'h.json', text: '{"folders":[],"requests":[]}' },
  dotenv: { file: '.env', text: 'A=1\n' },
  wsdl: { file: 's.wsdl', text: '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"></definitions>' },
  asyncapi: { file: 'a.yaml', text: 'asyncapi: 3.0.0\ninfo: { title: A, version: "1" }\n' },
  'http-file': { file: 'r.http', text: 'GET https://x.test/pets\n' },
  arazzo: { file: 'f.yaml', text: 'arazzo: 1.0.0\nworkflows: []\n' },
};

describe('importable files', () => {
  it('every format the importer detects comes in a file the pickers offer', () => {
    for (const [format, s] of Object.entries(SAMPLES) as Array<[ImportFormat, { file: string; text: string }]>) {
      expect(detectFormat(s.text), s.file).toBe(format);
      const ext = s.file.split('.').pop()!;
      expect(IMPORT_FORMATS[format], format).toContain(ext);
    }
    const native = importFileFilters('Importable files')[0]!.extensions;
    const accept = IMPORT_FILE_ACCEPT.split(',');
    for (const ext of Object.values(IMPORT_FORMATS).flat()) {
      expect(IMPORT_FILE_EXTENSIONS).toContain(ext);
      expect(native).toContain(ext);
      expect(accept).toContain(`.${ext}`);
    }
  });

  it('GraphQL schemas are offered (.graphql, .gql), and each extension once', () => {
    expect(IMPORT_FILE_EXTENSIONS).toEqual(expect.arrayContaining(['graphql', 'gql', 'bru', 'http', 'rest', 'wsdl', 'har', 'env', 'txt']));
    expect(new Set(IMPORT_FILE_EXTENSIONS).size).toBe(IMPORT_FILE_EXTENSIONS.length);
    expect(importFileFilters('x').at(-1)).toEqual({ name: 'All files', extensions: ['*'] });
  });
});
