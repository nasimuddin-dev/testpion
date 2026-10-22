/**
 * Postman's words and TestPion's: where a Postman user finds what they know. One list feeds the Postman migration page
 * (docs/migrate/postman.md, generated), the Migrate-from-Postman dialog and the command palette (typing "runner" or
 * "newman" finds the row).
 */
export interface PostmanWord {
  /** What Postman calls it. */
  theirs: string;
  /** What TestPion calls it. */
  ours: string;
  /** Where to find it (the click path, or the command). */
  where: string;
  /** Words to type in the palette to find it, besides the label. */
  aliases: string[];
  /** The palette command that opens it: `go-<view id>` or the id of a command in App.tsx. */
  paletteId: string;
}

export const POSTMAN_WORDS: PostmanWord[] = [
  { theirs: 'Collection Runner', ours: 'Run collection', where: 'a collection ▸ Run (also its ⋯ menu in the explorer)', aliases: ['runner', 'collection runner', 'run collection'], paletteId: 'run-collection' },
  { theirs: 'Newman', ours: 'testpion run-collection', where: 'the command line: `testpion run-collection <collection>`', aliases: ['newman', 'cli', 'ci'], paletteId: 'm-ci' },
  { theirs: 'Mock servers', ours: 'Mock server', where: 'a collection ▸ Mock (serves its saved examples)', aliases: ['mock', 'mock server', 'mocks'], paletteId: 'mock-server' },
  { theirs: 'Flows', ours: 'Test files (flows)', where: 'Tests ▸ a test file or flow; the flow designer', aliases: ['flows', 'flow', 'workflow'], paletteId: 'go-tests' },
  { theirs: 'Globals', ours: 'Globals', where: 'Environments ▸ Globals', aliases: ['globals', 'global variables'], paletteId: 'open-globals' },
  { theirs: 'Vault', ours: 'Secret variables', where: 'Environments: a variable marked secret is kept in the operating system\'s secret store', aliases: ['vault', 'secrets', 'secret'], paletteId: 'go-environments' },
  { theirs: 'Interceptor and Proxy', ours: 'HTTP Debugger', where: 'More… ▸ Debugger (capture through a proxy)', aliases: ['interceptor', 'proxy', 'capture', 'debugger'], paletteId: 'go-debugger' },
  { theirs: 'Monitors', ours: 'Monitors', where: 'More… ▸ Monitors', aliases: ['monitor', 'schedule'], paletteId: 'go-monitors' },
  { theirs: 'Environments', ours: 'Environments', where: 'Environments', aliases: ['environment', 'env'], paletteId: 'go-environments' },
  { theirs: 'Collection variables', ours: 'Collection variables', where: 'a collection ▸ Variables', aliases: ['collection variables'], paletteId: 'go-collections' },
];
