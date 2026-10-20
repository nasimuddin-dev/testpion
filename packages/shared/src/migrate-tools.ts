/**
 * The tools a person switches from, with the short "how do I get my collection out" the Import dialog shows when
 * **Home ▸ Migrate from…** opens it with one tool chosen. The migration guides (docs/migrate/<id>.md) are generated from
 * the importers' support table in core; a test keeps the two lists the same set of tools. Plain text: the dialog shows it
 * as it is.
 */
export const MIGRATE_TOOLS = {
  postman: {
    label: 'Postman',
    how: 'In Postman, open the collection ▸ ⋯ ▸ Export ▸ Collection v2.1, and each environment ▸ ⋯ ▸ Export. A whole account: Settings ▸ Data export gives one ZIP of everything. A Git-connected collection: choose its folder. Or paste a Postman API key below and a link or id (postman:collection/<id>).',
  },
  insomnia: { label: 'Insomnia', how: 'In Insomnia, open the collection menu ▸ Export ▸ choose Insomnia v5 (YAML) or v4 (JSON). Design documents (OpenAPI) in the export are kept in specs/; unit tests become tests of their request, and the cookie jar comes along.' },
  bruno: { label: 'Bruno', how: 'Choose the collection folder itself (the one with bruno.json or opencollection.yml); its .env comes along. A ZIP of the folder works too, and so does a link to a public GitHub or GitLab folder.' },
  hoppscotch: { label: 'Hoppscotch', how: 'In Hoppscotch, open the collection ▸ ⋯ ▸ Export (a JSON file), and Environments ▸ ⋯ ▸ Export. pw.* and hopp.* scripts are converted to TestPion scripts.' },
  thunder: { label: 'Thunder Client', how: 'In Thunder Client (VS Code), open Collections ▸ ⋯ ▸ Export (a JSON file), and Env ▸ ⋯ ▸ Export. Its tests and tc.* scripts are converted.' },
  yaak: { label: 'Yaak', how: 'In Yaak, open the workspace menu ▸ Export Data (a JSON file), or choose the git-sync folder (yaak.*.yaml files).' },
  httpie: { label: 'HTTPie', how: 'In HTTPie for Desktop, open the collection ▸ ⋯ ▸ Export (a JSON file); environments the same way. A copied `http` command can be pasted.' },
  apidog: { label: 'Apidog', how: 'In Apidog, open Project settings ▸ Export data ▸ Apidog (JSON). An OpenAPI or Postman export of the project works too and keeps more of the design.' },
  other: { label: 'Another tool', how: 'OpenAPI / Swagger, HAR, cURL, .http files, WSDL, AsyncAPI and GraphQL schemas import as they are. Paste a cURL command, drop a file, or choose a folder.' },
} as const;

export type MigrateTool = keyof typeof MIGRATE_TOOLS;
