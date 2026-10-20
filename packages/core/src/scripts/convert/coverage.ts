/**
 * What the script converter knows, as data: the single source for the converter, its tests and the documentation
 * (docs/getting-started/import-fidelity.md lists these tables). A member in the "missing" lists has no TestPion
 * equivalent: the converter marks it `// TODO(import)` and reports it.
 */

/** Postman's legacy `postman.*` calls (pre-`pm` sandbox) and the `tp.*` call that replaces each. */
export const POSTMAN_LEGACY_CALLS: Record<string, string> = {
  setEnvironmentVariable: 'tp.environment.set',
  getEnvironmentVariable: 'tp.environment.get',
  clearEnvironmentVariable: 'tp.environment.unset',
  clearEnvironmentVariables: 'tp.environment.clear',
  setGlobalVariable: 'tp.globals.set',
  getGlobalVariable: 'tp.globals.get',
  clearGlobalVariable: 'tp.globals.unset',
  clearGlobalVariables: 'tp.globals.clear',
  setNextRequest: 'tp.execution.setNextRequest',
  getResponseHeader: 'tp.response.headers.get',
  // (postman.getResponseCookie returns { name, value }; tp.cookies.get returns the value: left as it is, it still runs)
};

/**
 * Postman sandbox members TestPion has no equivalent for: Datasets (SQL over a dataset) and Mock (match a saved example).
 * `pm.state` is `tp.state` (kept as globals named `state.<key>`). The hint says what to use instead.
 */
export const POSTMAN_MISSING = ['datasets', 'mock'];
export const POSTMAN_MISSING_HINT: Record<string, string> = {
  datasets: 'TestPion datasets feed the runner (data file, tp.iterationData); there is no SQL over them in a script',
  mock: "TestPion's mock server serves the saved examples (Collection > Mock): point the request at it instead of matching in a script",
};

/** `insomnia.*` members TestPion has nothing for. A path prefix. */
export const INSOMNIA_MISSING = ['parentFolders', 'request.auth.update', 'request.proxy', 'request.certificate'];

/**
 * Bruno's `bru.*` calls that have a TestPion equivalent, as `tp.*` (TestPion scripts speak tp.*). `req`, `res`, `test`
 * and `expect` keep running through the shim (scripts/bruno.ts). A value is the replacement of `bru.<name>` (the call's own
 * parentheses and arguments follow it), or, for a key ending in `()`, a whole expression for a call without arguments.
 */
export const BRU_TO_TP: Record<string, string> = {
  getEnvVar: 'tp.environment.get',
  setEnvVar: 'tp.environment.set',
  hasEnvVar: 'tp.environment.has',
  deleteEnvVar: 'tp.environment.unset',
  'getEnvName()': 'tp.environment.name',
  getGlobalEnvVar: 'tp.globals.get',
  setGlobalEnvVar: 'tp.globals.set',
  getVar: 'tp.variables.get',
  runRequest: 'tp.execution.runRequest',
  // runtime variables last for the rest of the run, like Bruno's (the shim does the same)
  setVar: 'tp.collectionVariables.set',
  hasVar: 'tp.variables.has',
  deleteVar: 'tp.collectionVariables.unset',
  getCollectionVar: 'tp.collectionVariables.get',
  getFolderVar: 'tp.variables.get',
  getRequestVar: 'tp.variables.get',
  // .env values are imported as environment variables; secrets too
  getProcessEnv: 'tp.variables.get',
  getSecretVar: 'tp.variables.get',
  interpolate: 'tp.variables.replaceIn',
  'getRequestName()': 'tp.info.requestName',
  setNextRequest: 'tp.execution.setNextRequest',
  'runner.setNextRequest': 'tp.execution.setNextRequest',
  'runner.skipRequest': 'tp.execution.skipRequest',
  'runner.stopExecution()': 'tp.execution.setNextRequest(null)',
};

/** `bru.*` the shim runs as it is (no rewrite needed, no warning). */
export const BRU_SHIM = new Set(['sleep', 'cwd']);
