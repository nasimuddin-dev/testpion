import { ApsError, normalizeError, type ErrorKind } from '@testpion/core';

/**
 * A light check of the parameters of RPC calls, before the handler runs: every host (the window, the web bridge, a
 * future cloud server, an agent over MCP) gets "<method>: missing <param>" instead of a TypeError from deep inside.
 *
 * A type is one of s (string), n (number), b (boolean), o (object, not an array), a (array), sa (array of strings),
 * x (any value but undefined); `|null` also allows null; a trailing `?` makes the parameter optional (null then counts as
 * absent and is dropped before the call).
 */
type ParamType = string;
type ParamSpec = Record<string, ParamType>;

/** Parameters that, wherever they appear, name something by its id or name: always a string. */
const COMMON: ParamSpec = {
  environment: 's?',
  environmentId: 's?',
  collectionId: 's?',
  requestId: 's?',
  folderId: 's?',
  runId: 's?',
  serverId: 's?',
  providerId: 's?',
};

/** The parameters each method needs (and the types of the optional ones a wrong value would break). */
export const RPC_PARAMS: Record<string, ParamSpec> = {
  'ai.chat': { provider: 's', model: 's', prompt: 's?', system: 's?' },
  'ai.compare': { models: 'a', prompt: 's?' },
  'ai.models': { providerId: 's' },
  'ai.saveProviders': { providers: 'a', keys: 'o?' },
  'ai.setAppKey': { key: 's|null' },
  'app.openExternal': { url: 's' },
  'asyncapi.outline': { path: 's?', text: 's?' },
  'baselines.save': { runId: 's', name: 's?' },
  'certificates.check': { host: 's' },
  'col.addExample': { collectionId: 's', requestId: 's', name: 's?', response: 'o', request: 'o?' },
  'col.convertScripts': { collectionId: 's', to: 's', dryRun: 'b?' },
  'col.delete': { id: 's' },
  'col.docs': { id: 's?', collection: 'o?' },
  'col.duplicate': { id: 's' },
  'col.export': { id: 's', format: 's?' },
  'col.exportDocsHtml': { id: 's?', collection: 'o?' },
  'col.get': { id: 's' },
  'col.import': { text: 's', fileName: 's?', keepPm: 'b?' },
  'col.importBrunoFolder': { name: 's?', files: 'a' },
  'col.previewDataFile': { path: 's', query: 's?' },
  'col.replace': { collectionId: 's', find: 's', replace: 's', fields: 'a?' },
  'col.run': { collectionId: 's', selection: 'sa?', dataPath: 's?', dataQuery: 's?', iterations: 'n?', delayMs: 'n?', name: 's?' },
  'col.save': { id: 's', name: 's?', items: 'a?', variables: 'a?' },
  'col.securityLint': { id: 's' },
  'col.setExamples': { collectionId: 's', requestId: 's', examples: 'a' },
  'col.tidy': { collectionId: 's' },
  'col.tidyApply': { collectionId: 's' },
  'col.tree': { ids: 'sa?' },
  'col.uploadDataFile': { name: 's', text: 's' },
  'col.variableFlow': { collectionId: 's' },
  'cookies.clear': { domain: 's?' },
  'cookies.delete': { domain: 's', name: 's', path: 's?' },
  'cookies.set': { cookie: 'o', replace: 'o?' },
  'currentValues.set': { scope: 's', owner: 's?', key: 's', value: 'x' },
  'datasets.appendRow': { name: 's', row: 'o' },
  'datasets.create': { name: 's', format: 's?' },
  'datasets.read': { path: 's' },
  'datasets.saveCsv': { name: 's', text: 's' },
  'datasets.write': { name: 's', text: 's' },
  'debug.decrypt': { on: 'b?', noDecrypt: 'sa?' },
  'debug.delete': { ids: 'sa' },
  'debug.deleteSession': { name: 's' },
  'debug.exchanges': { host: 's?', method: 's?', text: 's?', kind: 's?', application: 's?', type: 's?', limit: 'n?', offset: 'n?' },
  'debug.openSession': { name: 's?', path: 's?', text: 's?', base64: 's?' },
  'debug.profile': { action: 's', name: 's', from: 's?' },
  'debug.saveFilterPreset': { name: 's', filter: 'o' },
  'debug.saveRule': { rule: 'o' },
  'env.delete': { id: 's' },
  'env.diff': { left: 's', right: 's' },
  'env.export': { id: 's', format: 's?' },
  'env.quickLook': {},
  'env.save': { env: 'o', secrets: 'o?' },
  'env.secretStatus': { envId: 's', keys: 'sa' },
  'eval.run': { template: 'o', name: 's?', datasetText: 's?', datasetPath: 's?', datasetFormat: 's?', limit: 'n?' },
  'eval.runDraft': { draft: 'o' },
  'feedback.compose': { kind: 's', title: 's', description: 's', steps: 's?', expected: 's?', where: 's?', diagnostics: 'sa?', errors: 'sa?' },
  'git.clone': { url: 's', dest: 's?', branch: 's?' },
  'git.commit': { message: 's', paths: 'sa?' },
  'git.deleteBranch': { branch: 's' },
  'git.diff': { path: 's' },
  'git.discard': { files: 'a' },
  'git.fixSecrets': { findings: 'a', environmentId: 's' },
  'git.history': { itemId: 's?', limit: 'n?' },
  'git.init': { remote: 's?' },
  'git.itemHistory': { collectionId: 's', itemId: 's', limit: 'n?' },
  'git.openFolder': { path: 's' },
  'git.renameBranch': { from: 's', to: 's' },
  'git.resolve': { path: 's', side: 's?', resolutions: 'o?' },
  'git.restoreFile': { rev: 's' },
  'git.restoreItem': { collectionId: 's', itemId: 's', rev: 's' },
  'git.stage': { paths: 'sa' },
  'git.switch': { branch: 's', from: 's?' },
  'git.unstage': { paths: 'sa' },
  'gql.introspect': { request: 'o' },
  'gql.mock.start': { sdl: 's', port: 'n?', overrides: 'o?' },
  'gql.send': { request: 'o' },
  'gql.subscribe': { request: 'o', operationName: 's?', connectionParams: 's?' },
  'grpc.grpcurl': { target: 's', method: 's', message: 's?', metadata: 'a?', protoFiles: 'sa?' },
  'grpc.parseGrpcurl': { text: 's' },
  'grpc.reflect': { target: 's', metadata: 'a?', tlsOptions: 'o?' },
  'grpc.send': { target: 's', method: 's?', metadata: 'a?', tlsOptions: 'o?' },
  'history.compare': { before: 's', after: 's' },
  'history.delete': { id: 's' },
  'history.exportHar': { query: 's?', kind: 's?', limit: 'n?' },
  'history.forRequest': { requestId: 's', limit: 'n?' },
  'history.get': { id: 's' },
  'history.list': { query: 's?', kind: 's?', failed: 'b?', limit: 'n?', offset: 'n?' },
  'history.response': { id: 's' },
  'http.code': { request: 'o', language: 's' },
  'http.compareEnvironments': { request: 'o', left: 's', right: 's' },
  'http.copyCode': { request: 'o', language: 's' },
  'http.curl': { request: 'o' },
  'http.parseCurl': { text: 's' },
  'http.parseSnippet': { text: 's' },
  'http.send': { request: 'o', id: 's?', name: 's?', preRequestScript: 's?', testScript: 's?', assertions: 'a?' },
  'kafka.connect': { url: 's', reads: 'a?' },
  'lib.save': { kind: 's', library: 'o' },
  'load.start': { config: 'o', collection: 'o?' },
  'load.thresholds': { rules: 'sa', snapshot: 'o' },
  'mcp.mock.call': { definition: 'o', tool: 's', args: 'o?' },
  'mcp.mock.parse': { text: 's' },
  'mcp.mock.read': { file: 's', name: 's?' },
  'mcp.mock.write': { file: 's', definition: 'o?', text: 's?' },
  'mcp.saveTest': { serverId: 's', tool: 's', args: 'o?', assertions: 'a?', name: 's' },
  'mock.start': { collectionId: 's', port: 'n?', delayMs: 'n?', fallbackUrl: 's?' },
  'monitor.daily': { id: 's', days: 'n?', tzOffsetMin: 'n?' },
  'monitor.requests': { id: 's', runs: 'n?' },
  'monitor.results': { id: 's', limit: 'n?' },
  'monitor.run': { id: 's' },
  'monitor.save': { monitor: 'o' },
  'monitor.testWebhook': { webhook: 's', name: 's?' },
  'mqtt.connect': { url: 's', subscriptions: 'a?' },
  'openapi.bodySchema': { method: 's', url: 's' },
  'openapi.diff': { old: 'o', new: 'o' },
  'openapi.generateFlows': { path: 's?', overwrite: 'b?' },
  'openapi.lint': { path: 's?', text: 's?', disable: 'sa?' },
  'openapi.outline': { path: 's?', text: 's?' },
  'openapi.spec.save': { path: 's', text: 's' },
  'packages.delete': { name: 's' },
  'packages.save': { name: 's', code: 's' },
  'prompt.variables': { template: 's' },
  'report.workspace': { days: 'n?', tzOffsetMin: 'n?' },
  'runs.exportReport': { runId: 's', format: 's' },
  'runs.flaky': { runs: 'n?' },
  'runs.latestResults': { names: 'sa' },
  'runs.openReport': { runId: 's', format: 's' },
  'runs.paused': { runId: 's' },
  'runs.resume': { runId: 's', action: 's', vars: 'o?' },
  'runs.scoreTrend': { runIds: 'sa?', name: 's?', limit: 'n?' },
  'runs.setBreakpoints': { runId: 's', ids: 'sa' },
  'schema.validate': { schema: 'o|b', data: 'x?' },
  'secrets.allow': { environment: 's', refs: 'sa?' },
  'secrets.refs': { environment: 's' },
  'settings.describeCertificates': { pem: 's' },
  'sio.connect': { url: 's', path: 's?', headers: 'a?', auth: 's?' },
  'stats.requests': { collectionId: 's' },
  'tests.delete': { path: 's' },
  'tests.expose': { path: 's', expose: 'o|null' },
  'tests.exposure': { path: 's' },
  'tests.exportArazzo': { path: 's', spec: 's?', workflowId: 's?', save: 'b?' },
  'tests.flow': { file: 's', raw: 'b?' },
  'tests.flowEdit': { file: 's', op: 'o' },
  'tests.flowBreakpoints': { file: 's', ids: 'sa' },
  'tests.flowPin': { file: 's', stepId: 's' },
  'tests.flowRun': { file: 's', ids: 'sa?', from: 's?', to: 's?', seedRunId: 's?', debug: 'b?', breakpoints: 'sa?', usePins: 'b?', concurrency: 'n?', retries: 'n?' },
  'tests.flowRunResults': { file: 's', runId: 's' },
  'tests.flowRuns': { file: 's', limit: 'n?' },
  'tests.flowState': { file: 's' },
  'tests.flowUnpin': { file: 's', stepId: 's' },
  'tests.lint': { content: 's', path: 's?' },
  'tests.preview': { path: 's' },
  'tests.read': { path: 's' },
  'tests.run': { paths: 'sa', name: 's?', grep: 's?', tags: 'sa?', concurrency: 'n?', retries: 'n?' },
  'tests.saveFrom': { name: 's', source: 'o', assertions: 'a?' },
  'tests.write': { path: 's', content: 's' },
  'traces.exportOtlp': { ids: 'sa', endpoint: 's', headers: 'a?' },
  'traces.get': { id: 's' },
  'vars.inspect': { template: 's?' },
  'vars.moveToEnvironments': { collectionId: 's', keys: 'sa?', environments: 'sa' },
  'vars.rename': { from: 's', to: 's' },
  'vars.setInEnvironment': { environment: 's', name: 's', value: 's' },
  'vars.unused': {},
  'vars.usages': { name: 's' },
  'ws.create': { name: 's' },
  'ws.delete': { ref: 's' },
  'ws.details': { ref: 's' },
  'ws.duplicate': { ref: 's', name: 's' },
  'ws.export': { ref: 's?' },
  'ws.importFile': { text: 's', fileName: 's?', keepPm: 'b?' },
  'ws.open': { ref: 's?' },
  'ws.rename': { ref: 's', name: 's' },
  'ws.search': { query: 's' },
  'ws.update': { name: 's?', description: 's?', variables: 'a?' },
  'wsock.connect': { url: 's', protocols: 'sa?', headers: 'a?' },
};

const NAMES: Record<string, string> = { s: 'a string', n: 'a number', b: 'true or false', o: 'an object', a: 'a list', sa: 'a list of strings', x: 'a value', null: 'null' };

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case 's':
      return typeof v === 'string';
    case 'n':
      return typeof v === 'number' && Number.isFinite(v);
    case 'b':
      return typeof v === 'boolean';
    case 'o':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    case 'a':
      return Array.isArray(v);
    case 'sa':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'null':
      return v === null;
    default:
      return v !== undefined;
  }
}

/**
 * The parameters of a call checked against its method's table (and the common ids), or a ValidationError naming the
 * method and the parameter. Optional parameters sent as null are dropped (the handlers treat them as absent).
 */
export function checkRpcParams(method: string, params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) params = {};
  if (typeof params !== 'object' || Array.isArray(params))
    throw new ApsError('ValidationError', `${method}: the parameters must be an object, not ${Array.isArray(params) ? 'a list' : typeof params}`);
  let p = params as Record<string, unknown>;
  const spec = { ...COMMON, ...RPC_PARAMS[method] };
  for (const [key, raw] of Object.entries(spec)) {
    const optional = raw.endsWith('?');
    const types = (optional ? raw.slice(0, -1) : raw).split('|');
    const v = p[key];
    if (v === undefined || (v === null && optional && !types.includes('null'))) {
      if (!optional) throw new ApsError('ValidationError', `${method}: missing ${key}`, { details: { method, param: key } });
      if (v === null) {
        if (p === params) p = { ...p };
        delete p[key];
      }
      continue;
    }
    if (!types.some((t) => isType(v, t))) throw new ApsError('ValidationError', `${method}: ${key} must be ${types.map((t) => NAMES[t] ?? t).join(' or ')}`, { details: { method, param: key } });
  }
  return p;
}

/**
 * A handler wrapped with the parameter check; what it throws other than an ApsError (a TypeError from a value it did
 * not expect, a Node error) becomes a normalised error, an InternalError naming the method when it is a bug.
 * A handler that answers synchronously still does.
 */
export function guardHandler<F extends (p: never) => unknown>(method: string, fn: F): F {
  const fail = (e: unknown): never => {
    if (e instanceof ApsError) throw e;
    const n = normalizeError(e);
    const code = (e as { code?: unknown } | undefined)?.code;
    // JavaScript's own errors and Node's wrong-argument errors are bugs here, whatever the core build calls them
    const bug = (code === undefined && (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError)) || code === 'ERR_INVALID_ARG_TYPE' || code === 'ERR_INVALID_ARG_VALUE';
    const kind = (bug && !/fetch failed|^terminated$/i.test(n.message) ? 'InternalError' : n.kind) as ErrorKind;
    const message = kind === ('InternalError' as ErrorKind) && !n.message.startsWith(`${method}:`) ? `${method}: ${n.message}` : n.message;
    throw new ApsError(kind, message, { why: n.why || undefined, suggestions: n.suggestions?.length ? n.suggestions : undefined, details: { ...n.details, method }, cause: e });
  };
  return ((params: unknown) => {
    let r: unknown;
    try {
      r = fn(checkRpcParams(method, params) as never);
    } catch (e) {
      return fail(e);
    }
    return r instanceof Promise ? r.catch(fail) : r;
  }) as unknown as F;
}
