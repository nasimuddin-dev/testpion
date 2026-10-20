import type { ImportFormat } from '@testpion/shared';

/**
 * What each importer declares it supports, as data: the single source of the migration guides (docs/migrate/*.md are
 * generated from it, see migrate-docs.ts) and of a test that fails when a format the importer detects has no entry, when an
 * importer has no page, or when a page on disk differs from what is generated. Edit the importer and this table together:
 * a claim here is checked by the fixtures in tests/fixtures/import/<tool>/.
 */

export interface ImporterSupport {
  /** The page name: docs/migrate/<id>.md. */
  id: 'postman' | 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder' | 'yaak' | 'httpie' | 'apidog';
  name: string;
  /** Formats `detectFormat` returns for this tool's files (every importable tool format belongs to exactly one importer). */
  formats: ImportFormat[];
  /** The versions and file shapes read. */
  reads: string[];
  /** How to get the files out of the tool. */
  exportSteps: string[];
  /** What to give TestPion (a file, a folder, a link). */
  give: string;
  /** What comes over as it was. */
  maps: string[];
  /** What comes over changed (converted, moved, or approximated), each reported. */
  converted: string[];
  /** What does not come over; the report lists it. */
  notMapped: string[];
  /** The script API the tool speaks and where its mapping table is. */
  scripts?: { api: string; table: 'postman' | 'insomnia' | 'bruno' | 'thunder' | 'hoppscotch' };
  /** Variables, dynamic values and template tags. */
  templates?: string;
  /** What TestPion can write back for it. */
  writeBack?: string;
  /** What a second import of the same source matches on. */
  updateKey: string;
  /** The capability matrix (the overview page): yes, partly, or no. */
  matrix: Record<MatrixFeature, 'yes' | 'partly' | 'no'>;
}

export const MATRIX_FEATURES = ['Folders and requests', 'Auth', 'Variables and environments', 'Scripts converted to tp.*', 'Tests and assertions', 'Saved responses', 'gRPC and WebSocket', 'Updates on re-import', 'Write back (export)'] as const;
export type MatrixFeature = (typeof MATRIX_FEATURES)[number];
const m = (...v: Array<'yes' | 'partly' | 'no'>): Record<MatrixFeature, 'yes' | 'partly' | 'no'> => Object.fromEntries(MATRIX_FEATURES.map((f, i) => [f, v[i]!])) as Record<MatrixFeature, 'yes' | 'partly' | 'no'>;

export const IMPORTER_SUPPORT: ImporterSupport[] = [
  {
    id: 'postman',
    name: 'Postman',
    formats: ['postman', 'postman-v1', 'postman-v3', 'postman-env'],
    reads: ['Collection v2.0 and v2.1 (JSON)', 'Collection v1 (the first export format)', 'Collection v3: the file-based format of Postman\'s Git integration (a folder of `*.request.yaml` files with `.resources/definition.yaml`), and the Native Git layout (`postman/collections`, `environments`, `globals`)', 'Environments and globals (JSON or YAML)', 'The data export of an account (a ZIP of collections, environments and globals)', 'A link or an id with your Postman API key (`postman:collection/<id>`)'],
    exportSteps: ['Collections: **⋯ ▸ Export ▸ Collection v2.1** (JSON).', 'Environments and globals: **Environments ▸ ⋯ ▸ Export**.', 'Everything at once: **Settings ▸ Data ▸ Export data** gives one ZIP; give TestPion the ZIP.', 'Git integration: give TestPion the folder (or the repository link).'],
    give: 'The files, the ZIP or the folder (drop them on the window, or **Import** ▸ choose). By API: `testpion import postman:collection/<id> --postman-api-key …`; the key is sent only to api.getpostman.com and is never kept.',
    maps: ['Folders (with description), requests, params, path variables, headers, bodies (raw, urlencoded, form-data, file, GraphQL)', 'Auth: basic, bearer, API key, digest, OAuth 1, OAuth 2, AWS Signature, JWT, NTLM, Hawk, Akamai EdgeGrid', 'Collection, folder and request variables, scripts, descriptions and saved responses (examples)', 'Request, folder and collection settings (redirects, cookies, URL encoding, TLS versions, HTTP/1 only)', 'Environments, and globals as the workspace\'s globals'],
    converted: ['`pm.*` scripts become `tp.*` (`pm.*` keeps working through an alias; *Keep pm.** leaves them)', 'The old `postman.*`, `tests[]` and `responseBody` forms become `tp.*` calls', 'A secret environment value goes to the secret store; one the export does not hold is listed as a value to enter', 'Simple `pm.test` shapes can be lifted into assertions (an option of the import)'],
    notMapped: ['Auth schemes TestPion has not (ASAP, WSSE): the request gets No auth and a disabled placeholder header', '`pm.datasets` and `pm.mock` (marked `TODO(import)`; `pm.state` is `tp.state`)', '`{{vault:name}}` secrets (a value to enter), mock servers, monitors and Flows (Postman does not export them)', 'Settings with no equivalent (`insecureHTTPParser`, `tlsCipherSelection` …)'],
    scripts: { api: '`pm.*`, `postman.*` and the legacy globals', table: 'postman' },
    templates: 'Variables keep `{{name}}`; the `$random…` dynamic variables of Postman are the same names in TestPion.',
    writeBack: '`testpion export <collection>` writes a Postman v2.1 collection and `export-environment` an environment.',
    updateKey: 'the item `id` of each request and folder, and the collection\'s `_postman_id` (Native Git: the id in `.postman/resources.yaml`)',
    matrix: m('yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'no', 'yes', 'yes'),
  },
  {
    id: 'insomnia',
    name: 'Insomnia',
    formats: ['insomnia'],
    reads: ['v5 YAML (`collection.insomnia.rest/5.x`, what Insomnia 10+ exports)', 'v4 JSON (`_type: export`)'],
    exportSteps: ['**Application menu ▸ Export Data**, or a collection\'s **⋯ ▸ Export** (v5 YAML).', 'A git-sync folder of Insomnia can be given as it is.'],
    give: 'The file (drop it on the window or **Import** ▸ choose).',
    maps: ['Requests, folders (with their headers, auth, variables, scripts and descriptions), params, path params, headers, bodies by MIME type', 'Auth: basic, bearer, API key, digest, OAuth 1, OAuth 2, AWS (IAM), NTLM, Hawk, JWT', 'Environments (the base environment is merged into each sub-environment) and the request settings (redirects, URL encoding, cookies)', 'gRPC and WebSocket requests (as the collection\'s gRPC calls and connections), design documents (kept in `specs/`)', 'Unit tests: each becomes a `tp.test` of the request it sends', 'The cookie jar goes to the workspace\'s cookie jar'],
    converted: ['`insomnia.*` scripts become `tp.*` (`insomnia.baseEnvironment` and `collectionVariables` become `tp.environment`)', '`{% uuid %}`, `{% now %}`, `{% faker %}`, `{% base64 %}`, `{% hash %}`, `{% prompt %}` become dynamic variables, variables or script lines; **`{% response %}` request chaining** becomes a variable set by the other request\'s test script', 'A collection-level setting does not exist in Insomnia: none is lost on the way in'],
    notMapped: ['Auth schemes TestPion has not (ASAP, netrc): No auth and a disabled placeholder header', 'Template tags without an equivalent (`{% cookie %}`, `{% jsonpath %}`, `{% file %}` …) stay as text and are reported', '`insomnia.parentFolders`, `insomnia.request.auth.update`, `proxy`, `certificate` (marked `TODO(import)`)', 'Socket.IO and MCP items of a v5 file, mock routes'],
    scripts: { api: '`insomnia.*`', table: 'insomnia' },
    templates: '`{{ _.name }}` and `{{ _[\'a-b\'] }}` become `{{name}}`; template tags as above.',
    writeBack: '`testpion export <collection> --format insomnia` (v5 YAML) or `--format insomnia-v4` (JSON), with the workspace\'s environments.',
    updateKey: 'the `_id` of each request and folder (`meta.id` in v5)',
    matrix: m('yes', 'yes', 'yes', 'yes', 'yes', 'no', 'yes', 'yes', 'yes'),
  },
  {
    id: 'bruno',
    name: 'Bruno',
    formats: ['bruno', 'opencollection'],
    reads: ['A collection folder (`bruno.json`, `collection.bru`, `folder.bru`, request `.bru` files, `environments/`, `.env`)', 'OpenCollection YAML (Bruno 3.1\'s default): a folder with `opencollection.yml`, or one bundled file', 'The JSON export and a single `.bru` file', 'A GitHub or GitLab link to a public repository or folder'],
    exportSteps: ['Nothing to export: a Bruno collection **is** a folder. Give TestPion the folder, a ZIP of it, or a link to its repository.', 'Or **Collection ▸ ⋯ ▸ Export** for the JSON file.'],
    give: 'The folder, the ZIP, or `https://github.com/<owner>/<repo>/tree/<branch>/<folder>` (public repositories only; nothing is executed, no credential is sent).',
    maps: ['Folders (docs, headers, auth, scripts, variables), requests, params, headers, bodies (JSON, XML, text, form, multipart, GraphQL, file, SPARQL as text)', 'Auth: basic, bearer, digest, API key, AWS, OAuth 2, NTLM, Akamai EdgeGrid, JWT', 'Environments with secrets as values to enter, the collection\'s `.env` file (values to the secret store, `{{process.env.X}}` becomes `{{X}}`)', 'Assertions and tests, `settings` blocks, custom `http` methods, response examples', 'gRPC and WebSocket requests (as the collection\'s gRPC calls and connections)', 'Folder and collection headers stay folder and collection headers'],
    converted: ['`bru.*`, `req.*`, `res.*`, `test` and `expect` become `tp.*` (`bru.sendRequest` and `bru.cookies.jar()` have equivalents)', '`req.setTimeout(ms)` and `req.setMaxRedirects(n)` with a constant move to the request\'s settings', '`bru.getProcessEnv(\'X\')` reads the variable `X`; a name the import has no value for is listed as a value to enter', '`vars:pre-request` and `vars:post-response` become script lines'],
    notMapped: ['Auth schemes TestPion has not (WSSE, OAuth 2 implicit): No auth and a placeholder header', '`bru.getAuthMode`, `req.getTimeout`, `res.setBody` and other calls with no equivalent (marked `TODO(import)`)', 'The `.proto` file of a gRPC request (choose it again), `bruno.json` proxy and client certificates', 'npm modules a script `require`s beyond the ones the sandbox has'],
    scripts: { api: '`bru.*`, `req`, `res`, `test`, `expect`', table: 'bruno' },
    templates: '`{{var}}` stays; `{{process.env.X}}` becomes `{{X}}`; Bruno\'s `{{$random…}}` are Postman\'s names.',
    writeBack: '`testpion export <collection> --format bruno --out <folder>` (.bru files) or `--format opencollection` (YAML, a folder or one file).',
    updateKey: 'the path of each request file (names inside the folder)',
    matrix: m('yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'),
  },
  {
    id: 'hoppscotch',
    name: 'Hoppscotch',
    formats: ['hoppscotch'],
    reads: ['Collection exports (JSON; REST and GraphQL collections)', 'Environment exports'],
    exportSteps: ['**Collections ▸ ⋯ ▸ Export** (a JSON file).', '**Environments ▸ ⋯ ▸ Export**.'],
    give: 'The files (drop them on the window or **Import** ▸ choose).',
    maps: ['Folders and requests, params, headers, bodies by content type, request variables', 'Collection and folder headers, variables and scripts', 'Auth: basic, bearer, digest, API key, OAuth 2 (client credentials, password, authorization code), JWT', 'Saved responses (examples), GraphQL requests', 'Environments, with the secret flag (secret values to enter)'],
    converted: ['`pw.*` and `hopp.*` scripts become `tp.*`; Jest-style matchers (`toBe`, `toBeLevel2xx`, `toHaveLength` …) become chai (`to.equal`, `to.be.within(200, 299)` …); the `pm.*` layer of Hoppscotch scripts becomes `tp.*`', '`<<name>>` becomes `{{name}}`', 'Request variables become lines that set them before the request'],
    notMapped: ['Auth schemes TestPion has not (AWS signature, Hawk, Akamai): No auth and a placeholder header', '`hopp.fetch`, `hopp.cookies` (marked `TODO(import)`)', 'The OAuth 2 implicit grant'],
    scripts: { api: '`pw.*`, `hopp.*`', table: 'hoppscotch' },
    templates: '`<<name>>` and `<<$guid>>` become `{{name}}` and `{{$guid}}`.',
    updateKey: 'the `_ref_id` of each request and folder when the export has one, else the item path',
    matrix: m('yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'no', 'yes', 'no'),
  },
  {
    id: 'thunder',
    name: 'Thunder Client',
    formats: ['thunder'],
    reads: ['Collection exports (`clientName: "Thunder Client"`: `folders` and `requests`)', 'Environment exports'],
    exportSteps: ['**Collections ▸ ⋯ ▸ Export** (a JSON file).', '**Env ▸ ⋯ ▸ Export**.'],
    give: 'The files (drop them on the window or **Import** ▸ choose).',
    maps: ['Folders (headers, auth) and requests in order, params and path params, headers, bodies (JSON, XML, text, form, form-data, GraphQL, binary), docs', 'Auth: basic, bearer, API key, digest, OAuth 1, OAuth 2, AWS, NTLM, Hawk', 'Environments', 'The collection id (for a later update)'],
    converted: ['The GUI tests (response code, time, header, body, JSON query) become TestPion assertions where there is one (status, latency, header, contains, equals) and test code otherwise', 'Post-request "set environment variable" actions become script lines', '`tc.*` scripts become `tp.*` (`expect` becomes `tp.expect`)', '`{{#guid}}`, `{{#timestamp}}`, `{{#number, 1, 10}}`, `{{#email}}` … become dynamic variables'],
    notMapped: ['Auth schemes TestPion has not: No auth and a placeholder header', 'A GUI test or generator with no equivalent (`{{#date, \'format\'}}` formats)', 'The collection\'s base URL (put it in a variable)'],
    scripts: { api: '`tc.*`', table: 'thunder' },
    templates: '`{{#name}}` generators become `{{$…}}` dynamic variables; `{{var}}` stays.',
    updateKey: 'the `_id` of each request and folder, and the `collectionId`',
    matrix: m('yes', 'yes', 'yes', 'yes', 'yes', 'no', 'no', 'yes', 'no'),
  },
  {
    id: 'yaak',
    name: 'Yaak',
    formats: ['yaak'],
    reads: ['The workspace export (JSON, `yaakSchema`)', 'A git-sync folder (`yaak.<id>.yaml`, one file per model)'],
    exportSteps: ['**Workspace menu ▸ Export Data** (JSON), or turn on directory sync and give TestPion the folder.'],
    give: 'The file or the folder.',
    maps: ['Folders (headers, auth, description) and requests in order, URL parameters, headers, bodies (JSON, XML, text, form, multipart, GraphQL, binary)', 'Auth: basic, bearer, API key, digest, NTLM, JWT, OAuth 1, OAuth 2, AWS, Hawk', 'The workspace\'s headers and description, environments (the base environment is merged into the others)', 'gRPC and WebSocket requests (as the collection\'s gRPC calls and connections)'],
    converted: ['`${[ name ]}` becomes `{{name}}`; `${[ uuid.v4() ]}` and `${[ timestamp.iso8601() ]}` become dynamic variables'],
    notMapped: ['`${[ response.body.path(…) ]}`: reading another request\'s response stays as text and is reported (chain it with a script or a flow)', 'Auth plugins TestPion has not: No auth and a placeholder header', 'The `.proto` file of a gRPC request'],
    updateKey: 'the `id` of each request and folder, and the workspace id',
    matrix: m('yes', 'yes', 'yes', 'no', 'no', 'no', 'yes', 'yes', 'no'),
  },
  {
    id: 'httpie',
    name: 'HTTPie',
    formats: ['httpie'],
    reads: ['HTTPie for Desktop collection and environment exports (`meta.format: "httpie"`)'],
    exportSteps: ['**Collection ▸ ⋯ ▸ Export** (a JSON file); environments the same way. A copied `http` command also imports (paste it).'],
    give: 'The file (drop it on the window or **Import** ▸ choose).',
    maps: ['Collections as folders (nested), requests, query and path parameters, headers, cookies', 'Bodies: text with its format, form and multipart (files), GraphQL, file', 'Auth: basic, bearer, digest, API key, NTLM, with inheritance from the collection', 'Docs, environments (variables)'],
    converted: ['Nothing is rewritten: HTTPie has no scripts'],
    notMapped: ['Auth schemes TestPion has not: No auth and a placeholder header', 'A file body the export gives without a path (choose it again)'],
    updateKey: 'the item path',
    matrix: m('yes', 'yes', 'yes', 'no', 'no', 'no', 'no', 'yes', 'no'),
  },
  {
    id: 'apidog',
    name: 'Apidog',
    formats: ['apidog'],
    reads: ['The Apidog project export (`apidogProject`; Apifox\'s `apifoxProject` too)', 'Apidog\'s OpenAPI and Postman exports import as those formats'],
    exportSteps: ['**Project settings ▸ Export data ▸ Apidog** (JSON). OpenAPI or Postman exports work as well and keep more of the design.'],
    give: 'The file (drop it on the window or **Import** ▸ choose).',
    maps: ['The folder tree and the endpoints as requests under `{{baseUrl}}`, with query, path, header and cookie parameters and their examples', 'Request bodies: an example when there is one, else a sample made from the JSON schema; urlencoded and multipart', 'Responses as examples (the written ones, else a sample of the schema)', 'Custom scripts (Postman\'s `pm.*`, which runs), environments with their base URL and variables, global variables'],
    converted: ['`{id}` path parameters become `:id`'],
    notMapped: ['Pre/post operations other than custom scripts (database, assertions, extract variable …)', 'Schemas as such (the OpenAPI export keeps them: it is also kept in `specs/` when you import that)'],
    updateKey: 'the item path',
    matrix: m('yes', 'yes', 'yes', 'yes', 'no', 'yes', 'no', 'yes', 'no'),
  },
];

/** Every format `detectFormat` can return that belongs to one of the tools above, from the table. */
export const TOOL_FORMATS: ReadonlySet<ImportFormat> = new Set(IMPORTER_SUPPORT.flatMap((s) => s.formats));
