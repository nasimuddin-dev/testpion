import { ApsError, HISTORY_KINDS, looksLikeHostPath, normalizeError, type ErrorKind } from '@testpion/core';

/**
 * A light check of the parameters of RPC calls, before the handler runs: every host (the window, the web bridge, a
 * future cloud server, an agent over MCP) gets "<method>: missing <param>" instead of a TypeError from deep inside.
 *
 * A type is one of s (string), wp / wpa (a path / a list of paths inside the workspace, checked by the handler with safePath), p (a path on the host computer: gated by the host's localFiles capability, see hostPathsOf), pn (a
 * name or such a path), n (number), b (boolean), o (object, not an array), a (array), sa (array of strings),
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
  /** Consent to send to (or run against) a production environment (production-guard.ts). */
  allowProduction: 'b?',
};

/** The parameters each method needs (and the types of the optional ones a wrong value would break). */
export const RPC_PARAMS: Record<string, ParamSpec> = {
  'import.preview': { files: 'a?', text: 's?', url: 's?', folderName: 's?', keepPm: 'b?' },
  'import.apply': { sessionId: 's', keepPm: 'b?', replaceSpec: 'b?' },
  'import.cancel': { sessionId: 's' },
  'import.undo': { receipts: 'sa', force: 'b?' },
  'import.report': { id: 's' },
  'import.reportMarkdown': { report: 'o' },
  'import.setPostmanKey': { key: 's' },
  'agents.init': { targets: 'sa?', force: 'b?', dryRun: 'b?' },
  'ai.chat': { provider: 's', model: 's', prompt: 's?', system: 's?' },
  'ai.compare': { models: 'a', prompt: 's?' },
  'ai.models': { providerId: 's' },
  'ai.saveProviders': { providers: 'a', keys: 'o?' },
  'ai.setAppKey': { key: 's|null' },
  'ai.runTask': { task: 's', question: 's?', context: 'o?', history: 'a?', privacy: 's?', hint: 's?', path: 'wp?', provider: 's?', model: 's?', maxTokens: 'n?', response: 'o?', previous: 'o?', preferStable: 'b?' },
  'ai.preview': { task: 's', question: 's?', context: 'o?', history: 'a?', privacy: 's?' },
  'ai.generateFlow': { collectionId: 's', folderId: 's?', hint: 's?', privacy: 's?', path: 'wp?', dryRun: 'b?', noAi: 'b?' },
  'ai.specGaps': { spec: 's', categories: 'sa?', operations: 'sa?', gapsOnly: 'b?', includeDelete: 'b?' },
  'ai.specTests': { spec: 's', categories: 'sa?', operations: 'sa?', gapsOnly: 'b?', includeDelete: 'b?', hint: 's?', privacy: 's?', path: 'wp?', dryRun: 'b?', noAi: 'b?' },
  'ai.tidyImport': { collectionId: 's', flow: 'b?', source: 's?', hint: 's?', privacy: 's?', dryRun: 'b?', noAi: 'b?' },
  'ai.securityTests': { collectionId: 's', folderId: 's?', identities: 'o?', probes: 'sa?', includeWrite: 'b?', includeDelete: 'b?', rate: 'n?', max: 'n?', hint: 's?', privacy: 's?', path: 'wp?', dryRun: 'b?', noAi: 'b?' },
  'ai.securityRun': { path: 'wp', environment: 's' },
  'ai.driftReport': { spec: 's', source: 'o?' },
  'ai.driftExplain': { spec: 's', source: 'o?', hint: 's?', privacy: 's?', dryRun: 'b?', noAi: 'b?' },
  'ai.reverifyProposal': { id: 's', item: 's?', after: 's?', data: 'x?', verifiers: 'sa?', response: 'o?', previous: 'o?' },
  'ai.proposal': { id: 's' },
  'ai.proposals': { status: 's?' },
  'ai.applyProposal': { id: 's', items: 'sa?', recordOnly: 'b?' },
  'ai.discardProposal': { id: 's' },
  'ai.undoProposal': { id: 's' },
  'ai.taskUsage': { days: 'n?' },
  'search.ask': { question: 's', scope: 'sa?', noAi: 'b?', privacy: 's?', dryRun: 'b?', requestId: 's?' },
  'search.query': { query: 'o', scope: 'sa?' },
  'search.fields': {},
  'assistant.ask': { task: 's', question: 's?', context: 'x?', history: 'a?' },
  'rpc.cancel': { id: 's' },
  'app.openExternal': { url: 's' },
  'asyncapi.outline': { path: 'wp?', text: 's?' },
  'bundle.export': { selection: 'a?', section: 's?', folder: 'o?', all: 'b?', uses: 'b?', datasets: 's?', providers: 'b?', format: 's?', title: 's?', dryRun: 'b?', workspaceVariables: 'b?', exclude: 'sa?' },
  'bundle.preview': { pick: 'b?', base64: 's?', path: 'p?', fileName: 's?' },
  'bundle.apply': { planId: 's', onConflict: 's?', decisions: 'o?', only: 'sa?', workspaceVariables: 's?', into: 'o?' },
  'bundle.undo': { importId: 's', planId: 's?' },
  'eval.compare': { run: 's', baseline: 's', threshold: 'n?', maxRegressions: 'n?', failOnMissing: 'b?', limit: 'n?' },
  'eval.matrix': { runs: 'sa', baseline: 's?', threshold: 'n?', filter: 's?', tag: 's?', search: 's?', sort: 's?', column: 'n?', dir: 's?', offset: 'n?', limit: 'n?' },
  'eval.matrixResult': { runId: 's', resultId: 's' },
  'baselines.save': { runId: 's', name: 's?' },
  'certificates.check': { host: 's' },
  'col.addExample': { collectionId: 's', requestId: 's', name: 's?', response: 'o', request: 'o?' },
  'col.convertScripts': { collectionId: 's', to: 's', dryRun: 'b?' },
  'col.delete': { id: 's' },
  'col.docs': { id: 's?', collection: 'o?' },
  'col.duplicate': { id: 's' },
  'col.export': { id: 's', format: 's?' },
  'col.docsHtml': { id: 's?', collection: 'o?', environment: 's?' },
  'col.get': { id: 's' },
  'col.getMany': { ids: 'sa' },
  'col.import': { text: 's', fileName: 's?', keepPm: 'b?' },
  'col.importBrunoFolder': { name: 's?', files: 'a' },
  'col.previewDataFile': { path: 'p', query: 's?' },
  'col.replace': { collectionId: 's', find: 's', replace: 's', fields: 'a?' },
  'col.run': { collectionId: 's', selection: 'sa?', dataPath: 'p?', dataQuery: 's?', iterations: 'n?', delayMs: 'n?', name: 's?' },
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
  'datasets.read': { path: 'wp' },
  'datasets.saveCsv': { name: 's', text: 's' },
  'datasets.write': { name: 's', text: 's' },
  'debug.columns': { columns: 'a?' },
  'debug.snippet': { id: 's', language: 's' },
  'debug.select': { where: 's' },
  'debug.programs': {},
  'debug.replay': { ids: 'sa', times: 'n?', concurrency: 'n?', delayMs: 'n?', stopOnFailure: 'b?', confirmRemote: 'b?', environment: 's?' },
  'debug.createFlow': { ids: 'sa?', since: 's?', name: 's?', drop: 'sa?', keepNoise: 'b?', noiseHosts: 'sa?', dryRun: 'b?', overwrite: 'b?' },
  'debug.decrypt': { on: 'b?', noDecrypt: 'sa?' },
  'debug.delete': { ids: 'sa' },
  'debug.deleteSession': { name: 's' },
  'debug.exchanges': { where: 's?', host: 's?', method: 's?', text: 's?', kind: 's?', application: 's?', type: 's?', limit: 'n?', offset: 'n?' },
  'debug.testScript': { rule: 'o', id: 's' },
  'debug.scriptRun': { id: 's' },
  'debug.bodyView': { id: 's', view: 's', side: 's?' },
  'debug.openSession': { name: 's?', path: 'wp?', text: 's?', base64: 's?', append: 'b?' },
  'debug.openBrowser': { browser: 's?', url: 's?' },
  'debug.selfTest': { url: 's', method: 's?', headers: 'o?', body: 's?' },
  'debug.start': { port: 'n?', lan: 'b?' },
  'debug.pause': { on: 'b?' },
  'debug.gateway': {},
  'debug.speed': {},
  'debug.setSpeed': { preset: 's?', downKbps: 'n?', upKbps: 'n?', latencyMs: 'n?' },
  'debug.importHosts': { path: 'p?' },
  'debug.setGateway': { config: 'o', password: 's|null?', passphrases: 'o?' },
  'debug.testGateway': { url: 's?' },
  'debug.exportSaz': { name: 's?' },
  'debug.importFarx': { path: 'wp?', base64: 's?', text: 's?', dryRun: 'b?' },
  'debug.diff': { with: 's', ignoreQuery: 'b?', includeSize: 'b?', includeTunnels: 'b?' },
  'debug.shareBundle': { name: 's?', notes: 's?', withRules: 'b?' },
  'debug.openBundle': { path: 'wp?', base64: 's?', append: 'b?', withRules: 'b?', rulesOnly: 'b?' },
  'debug.largeSession': { on: 'b?' },
  'debug.launch': { command: 's', args: 'sa?', kind: 's?', cwd: 'wp?', preview: 'b?' },
  'debug.annotate': { ids: 'sa', note: 's?', mark: 's?' },
  'debug.autoBreakpoint': { mode: 's' },
  'debug.resumeAll': { abort: 'b?' },
  'debug.systemProxy': { on: 'b' },
  'debug.certificate': { action: 's?' },
  'debug.view': { session: 's?' },
  'debug.profile': { action: 's', name: 's', from: 's?' },
  'debug.record': { on: 'b?' },
  'debug.saveFilterPreset': { name: 's', filter: 'o' },
  'debug.saveRule': { rule: 'o' },
  'env.delete': { id: 's' },
  'env.diff': { left: 's', right: 's' },
  'env.export': { id: 's', format: 's?' },
  'env.quickLook': {},
  'env.save': { env: 'o', secrets: 'o?' },
  'env.secretStatus': { envId: 's', keys: 'sa' },
  'eval.run': { template: 'o', name: 's?', datasetText: 's?', datasetPath: 'p?', datasetFormat: 's?', limit: 'n?' },
  'eval.runDraft': { draft: 'o', confirm: 'b?' },
  'eval.estimate': { draft: 'o', limit: 'n?' },
  'eval.tryCheck': { draft: 'o', check: 'o', caseNumber: 'n?', dryRun: 'b?' },
  'ai.sample': { run: 'b?' },
  'rag.trySample': { run: 'b?' },
  'ai.demoModel': {},
  'eval.generateCases': { source: 's', draft: 'o', count: 'n?', evaluation: 's?', spec: 'wp?', collection: 's?', folder: 's?', paths: 'wpa?', urls: 'sa?', historyLimit: 'n?', hint: 's?', provider: 's?', dryRun: 'b?', privacy: 's?' },
  'eval.casesOfProposal': { id: 's', items: 'sa?' },
  'eval.trust': { run: 's', metric: 's?', count: 'n?', label: 'o?' },
  'eval.summary': { run: 's', against: 's?' },
  'eval.caseDiff': { run: 's', case: 's', against: 's?' },
  'eval.trajectory': { run: 's', case: 's' },
  'eval.why': { run: 's', case: 's' },
  'eval.runVariants': { draft: 'o', confirm: 'b?', dryRun: 'b?' },
  'eval.variantsSummary': { draft: 'o', runs: 'sa?' },
  'rag.check': { target: 'o' },
  'rag.targets': {},
  'rag.customMetrics': {},
  'rag.metrics': { columns: 'sa?', hasTarget: 'b?' },
  'rag.metricCheck': { name: 's', options: 'o?' },
  'rag.probeSets': {},
  'rag.probeSets.add': { sets: 'sa?' },
  'rag.image': { ref: 's' },
  'rag.estimate': { draft: 'o', probe: 'b?' },
  'rag.estimateRescore': { runId: 's', evaluators: 'a', evaluation: 's?', judge: 'o?' },
  'rag.metric.try': { metric: 's', options: 'o?', evaluation: 's?', sample: 'o?', resultId: 's?', target: 's?', question: 's?', judge: 'o?', dryRun: 'b?' },
  'rag.matrix': { runId: 's', offset: 'n?', limit: 'n?', thresholds: 'o?', failure: 's?', query: 's?', sort: 's?', all: 'b?', ci: 'b?', external: 'o?' },
  'rag.matrixCi': { runId: 's', keys: 'sa' },
  'rag.sample': { runId: 's', resultId: 's' },
  'rag.compare': { runId: 's', baselineId: 's', minDelta: 'n?' },
  'rag.rescore': { runId: 's', evaluators: 'a?', evaluation: 's?', judge: 'o?' },
  'rag.columns': { text: 's', name: 's?', mapping: 'o?' },
  'rag.importBeir': { queries: 's', qrels: 's', corpus: 's?', limit: 'n?' },
  'rag.author.context': {},
  'rag.author.inputs': { target: 's', dataset: 's?' },
  'rag.calibrate': { run: 's', labels: 's?', metrics: 'sa?', tune: 'b?', thresholds: 'o?' },
  'rag.calibrate.example': { metric: 's', run: 's', result: 's', expect: 's?', name: 's?', labels: 's?' },
  'rag.calibrate.apply': { metric: 's', threshold: 'n', evaluation: 's?', calibration: 'o?' },
  'rag.capture.sources': {},
  'rag.capture.preview': { from: 's', target: 's?', history: 'sa?', session: 's?', run: 's?', har: 's?', messages: 's?', messagesUrl: 's?', exchanges: 'sa?', name: 's?', questionPath: 's?', dedupe: 'x?', limit: 'n?', sample: 'n?', seed: 'x?', since: 's?', until: 's?', onlySuccess: 'b?', maskPii: 'b?', asQuestions: 'b?', overwrite: 'b?' },
  'rag.capture.create': { from: 's', target: 's?', history: 'sa?', session: 's?', run: 's?', har: 's?', messages: 's?', messagesUrl: 's?', exchanges: 'sa?', name: 's?', questionPath: 's?', dedupe: 'x?', limit: 'n?', sample: 'n?', seed: 'x?', since: 's?', until: 's?', onlySuccess: 'b?', maskPii: 'b?', asQuestions: 'b?', overwrite: 'b?' },
  'rag.label.clear': { run: 's', labels: 's?', result: 's', metric: 's' },
  'rag.label.list': { run: 's', labels: 's?', result: 's?' },
  'rag.label.set': { run: 's', result: 's', metric: 's', label: 's', note: 's?', labels: 's?' },
  'rag.testset.sources': {},
  'rag.testset.estimate': { paths: 'wpa?', urls: 'sa?', count: 'n?', types: 'sa?', name: 's?', seed: 'x?', judge: 'x?', noJudge: 'b?', personas: 'sa?', styles: 'sa?', dedupe: 's?', embedder: 's?' },
  'rag.testset.generate': { paths: 'wpa?', urls: 'sa?', count: 'n?', types: 'sa?', name: 's?', seed: 'x?', judge: 'x?', noJudge: 'b?', personas: 'sa?', styles: 'sa?', dedupe: 's?', embedder: 's?' },
  'rag.trend': { evaluation: 's?', runIds: 'sa?', metrics: 'sa?', runs: 'n?', since: 's?', minDelta: 'n?' },
  'bundle.imports': {},
  'git.large': {},
  'git.largeCheck': {},
  'rag.customMetric.check': { text: 's', id: 's?' },
  'rag.customMetric.delete': { id: 's' },
  'rag.customMetric.examples': { text: 's', id: 's?', only: 'a?', judge: 'o?', environment: 's?' },
  'rag.customMetric.get': { id: 's', kind: 's?' },
  'rag.customMetric.save': { id: 's', text: 's', overwrite: 'b?' },
  'rag.customMetric.usedBy': { id: 's' },
  'rag.pivot': { runIds: 'sa', labels: 'o?' },
  'rag.convert': { text: 's', name: 's?', from: 's?', to: 's?' },
  'rag.judgePreview': { metric: 's', sample: 'o', judge: 'o?', environment: 's?' },
  'rag.map': { response: 'o', mapping: 'o' },
  'rag.probe': { target: 'o', question: 's', environment: 's?' },
  'diagnostics.get': {},
  'diagnostics.zip': {},
  'ws.openProblem': {},
  'http.unresolved': { request: 'o', environment: 's?', collectionId: 's?', requestId: 's?', preRequestScript: 's?' },
  'settings.export': {},
  'settings.import': { doc: 'o', dryRun: 'b?', confirmSecurity: 'b?' },
  'settings.reset': { keys: 'sa?' },
  'ws.revealFile': { path: 'p' },
  'diagnostics.bundle': {},
  'feedback.compose': { kind: 's', title: 's', description: 's', steps: 's?', expected: 's?', where: 's?', diagnostics: 'sa?', errors: 'sa?' },
  'flows.webhooks.start': { port: 'n?', host: 's?' },
  'flows.webhooks.status': {},
  'flows.webhooks.stop': {},
  'git.autoFetchSet': { enabled: 'b' },
  'git.clone': { url: 's', dest: 'p?', branch: 's?' },
  'git.commit': { message: 's', paths: 'wpa?' },
  'git.deleteBranch': { branch: 's' },
  'git.diff': { path: 'wp' },
  'git.discard': { files: 'a' },
  'git.fixSecrets': { findings: 'a', environmentId: 's' },
  'git.fixStaged': { findings: 'a', environmentId: 's' },
  'git.fix': { hook: 'b?', untrack: 'b?' },
  'git.fixPlan': { hook: 'b?', untrack: 'b?' },
  'git.largeTrack': { file: 'wp', mode: 's', source: 's?', dryRun: 'b?' },
  'git.shareSession': { name: 's', dryRun: 'b?', bundle: 'b?', notes: 's?' },
  'git.unshareSession': { name: 's' },
  'git.codeownersPlan': { owner: 's?' },
  'git.codeownersWrite': { owner: 's?' },
  'git.allowSecret': { finding: 'o', reason: 's' },
  'git.disallowSecret': { hash: 's' },
  'git.itemBlame': { ref: 'x?', itemId: 's?', file: 'wp?', limit: 'n?' },
  'git.lastChange': { ref: 'x?', itemId: 's?', file: 'wp?' },
  'git.itemDiscard': { ref: 'x?', itemId: 's?', file: 'wp?', dryRun: 'b?' },
  'git.itemRestore': { rev: 's', ref: 'x?', itemId: 's?', file: 'wp?', dryRun: 'b?' },
  'git.itemStage': { ref: 'x?', itemId: 's?', file: 'wp?', unstage: 'b?', dryRun: 'b?' },
  'git.itemVersions': { ref: 'x?', itemId: 's?', file: 'wp?', limit: 'n?' },
  'git.stashApply': { index: 'n?', hash: 's?', pop: 'b?' },
  'git.stashDrop': { index: 'n?', hash: 's?' },
  'git.stashPush': { name: 's', dryRun: 'b?' },
  'git.stashShow': { index: 'n?', hash: 's?' },
  'git.target': { ref: 'x?', itemId: 's?', file: 'wp?' },
  'git.undo': { id: 's?' },
  'git.init': { remote: 's?' },
  'git.openFolder': { path: 'p' },
  'git.renameBranch': { from: 's', to: 's' },
  'git.resolve': { path: 'wp', side: 's?', resolutions: 'o?' },
  'git.stage': { paths: 'wpa' },
  'git.switch': { branch: 's', from: 's?' },
  'git.unstage': { paths: 'wpa' },
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
  'auth.fetchToken': { auth: 'o' },
  'http.curl': { request: 'o' },
  'http.parseCurl': { text: 's' },
  'http.parseSnippet': { text: 's' },
  'http.send': { request: 'o', id: 's?', name: 's?', preRequestScript: 's?', testScript: 's?', assertions: 'a?' },
  'kafka.connect': { url: 's', reads: 'a?' },
  'lib.save': { kind: 's', library: 'o' },
  'kinds.list': { kind: 's?', all: 'b?' },
  'item.remove': { ref: 'x' },
  'item.restore': { trashId: 's' },
  'workspace.revealFile': { path: 'wp' },
  'openapi.spec.rename': { path: 'wp', to: 's' },
  'openapi.spec.delete': { path: 'wp' },
  'load.start': { config: 'o', collection: 'o?' },
  'load.thresholds': { rules: 'sa', snapshot: 'o' },
  'mcp.deleteServer': { serverId: 's' },
  'mcp.mock.call': { definition: 'o', tool: 's', args: 'o?' },
  'mcp.mock.parse': { text: 's' },
  'mcp.mock.read': { file: 'wp', name: 's?' },
  'mcp.mock.write': { file: 'wp', definition: 'o?', text: 's?' },
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
  'openapi.generateFlows': { path: 'wp?', overwrite: 'b?' },
  'openapi.lint': { path: 'wp?', text: 's?', disable: 'sa?' },
  'openapi.outline': { path: 'wp?', text: 's?' },
  'openapi.replaceSpec': { kept: 's', original: 's' },
  'openapi.spec.save': { path: 'wp', text: 's' },
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
  'scripts.allow': { host: 's?', secrets: 'b?' },
  'scripts.forget': { host: 's?', secrets: 'b?', all: 'b?' },
  'scripts.trust': {},
  'secrets.allow': { environment: 's', refs: 'sa?' },
  'secrets.refs': { environment: 's' },
  'settings.describeCertificates': { pem: 's' },
  'sio.connect': { url: 's', path: 's?', headers: 'a?', auth: 's?' },
  'stats.requests': { collectionId: 's' },
  'terminal.ack': { id: 's', parsed: 'n', epoch: 'n?' },
  'terminal.create': { shell: 's?', cols: 'n?', rows: 'n?', cwd: 'p?' },
  'terminal.kill': { id: 's' },
  'terminal.list': { withOutput: 'b?' },
  'terminal.resize': { id: 's', cols: 'n', rows: 'n' },
  'terminal.write': { id: 's', data: 's' },
  'tests.delete': { path: 'wp' },
  'tests.move': { from: 'wp', to: 'wp' },
  'tests.deployStatus': { file: 'wp' },
  'tests.expose': { path: 'wp', expose: 'o|null' },
  'tests.exposure': { path: 'wp' },
  'tests.exportArazzo': { path: 'wp', spec: 's?', workflowId: 's?', save: 'b?' },
  'tests.flow': { file: 'wp', raw: 'b?', text: 's?' },
  'tests.flowEdit': { file: 'wp', op: 'o' },
  'tests.flowBreakpoints': { file: 'wp', ids: 'sa' },
  'tests.flowPin': { file: 'wp', stepId: 's' },
  'tests.flowRun': { file: 'wp', ids: 'sa?', from: 's?', to: 's?', seedRunId: 's?', debug: 'b?', breakpoints: 'sa?', usePins: 'b?', concurrency: 'n?', retries: 'n?' },
  'tests.flowRunResults': { file: 'wp', runId: 's' },
  'tests.flowRuns': { file: 'wp', limit: 'n?' },
  'tests.dataRun': { file: 'wp', data: 's?', dataQuery: 's?', limit: 'n?', concurrency: 'n?', bail: 'b?' },
  'tests.matrixRun': { file: 'wp', environments: 'sa' },
  'tests.scaleCancel': { id: 's' },
  'tests.scaleRuns': { file: 'wp?', limit: 'n?' },
  'tests.scaleRun': { id: 's' },
  'tests.scaleRows': { id: 's', offset: 'n?', limit: 'n?', status: 's?' },
  'tests.scaleRow': { id: 's', index: 'n' },
  'tests.flowTimeline': { file: 'wp?' },
  'tests.flowTimelineHtml': { file: 'wp?' },

  'tests.flowState': { file: 'wp' },
  'tests.flowUnpin': { file: 'wp', stepId: 's' },
  'tests.lint': { content: 's', path: 'wp?' },
  'tests.locate': { testId: 's' },
  'tests.preview': { path: 'wp' },
  'tests.read': { path: 'wp' },
  'tests.run': { paths: 'wpa', name: 's?', grep: 's?', tags: 'sa?', concurrency: 'n?', retries: 'n?' },
  'tests.saveFrom': { name: 's?', source: 'o?', ref: 'o?', assertions: 'a?' },
  'tests.write': { path: 'wp', content: 's' },
  'traces.exportOtlp': { ids: 'sa', endpoint: 's', headers: 'a?' },
  'traces.get': { id: 's' },
  'vars.inspect': { template: 's?' },
  'vars.moveToEnvironments': { collectionId: 's', keys: 'sa?', environments: 'sa' },
  'vars.rename': { from: 's', to: 's' },
  'vars.setInEnvironment': { environment: 's', name: 's', value: 's', alsoIn: 'sa?', copy: 'b?' },
  'vars.addToEnvironments': { from: 's', keys: 'sa', to: 'sa', copy: 'b?' },
  'vars.unused': {},
  'runs.runAgain': { runId: 's', resultIds: 'sa?' },
  'runs.ci': { runId: 's' },
  'debug.saveToCollection': { ids: 'sa?', since: 's?', collectionId: 's?', name: 's?', group: 's?', environment: 's?', keepNoise: 'b?' },
  'vars.usages': { name: 's' },
  'ws.create': { name: 's' },
  'ws.delete': { ref: 's' },
  'ws.details': { ref: 's' },
  'ws.duplicate': { ref: 's', name: 's' },
  'ws.export': { ref: 's?', format: 's?', legacy: 'b?' },
  'ws.import': { bundle: 'o', name: 's?' },
  'ws.importFile': { text: 's?', base64: 's?', fileName: 's?', keepPm: 'b?' },
  'ws.open': { ref: 'pn?' },
  'ws.rename': { ref: 's', name: 's' },
  'ws.search': { query: 's' },
  'output.save': { surface: 's', format: 's', suggestedName: 's', label: 's?', content: 'o?', source: 'o?', includeSecrets: 'b?', jobId: 's?' },
  'output.copy': { surface: 's', format: 's', suggestedName: 's?', content: 'o?', source: 'o?', includeSecrets: 'b?' },
  'output.cancel': { jobId: 's' },
  'output.reveal': { jobId: 's', open: 'b?' },
  'ref.resolve': { ref: 'x' },
  'ref.info': { ref: 'x', environment: 's?' },
  'ws.update': { name: 's?', description: 's?', variables: 'a?' },
  'wsock.connect': { url: 's', protocols: 'sa?', headers: 'a?' },
};

/**
 * The range of the numbers that size work or time, wherever a method takes them: a call from a bridge client, an agent or a
 * mis-click with `iterations: 1e9` or `concurrency: 1e6` is refused instead of starting it. Generous: nothing a person sets is near them.
 */
export const RPC_RANGES: Record<string, readonly [number, number]> = {
  iterations: [0, 100_000],
  concurrency: [0, 256],
  retries: [0, 50],
  delayMs: [0, 3_600_000],
  days: [0, 3650],
  runs: [0, 10_000],
  limit: [0, 1_000_000],
  port: [0, 65_535],
  count: [0, 10_000],
};

/** Parameters that take one of a fixed list of values (an unknown one is a mistake, not an empty answer). */
export const RPC_VALUES: Record<string, Record<string, readonly string[]>> = {
  'history.list': { kind: HISTORY_KINDS },
  'history.exportHar': { kind: HISTORY_KINDS },
};

/**
 * The places on the host computer a call names (the `p` and `pn` parameters): checked by the backend against the host's
 * `localFiles` capability (assertHostPath) before the handler runs. `p` is always a host path; `pn` is a name, and a host
 * path only when it looks like one (an absolute path, ~, a UNC or file: path).
 */
export function hostPathsOf(method: string, params: unknown): string[] {
  const spec = RPC_PARAMS[method];
  if (!spec || !params || typeof params !== 'object') return [];
  const out: string[] = [];
  for (const [key, raw] of Object.entries(spec)) {
    const types = raw.replace(/\?$/, '').split('|');
    const v = (params as Record<string, unknown>)[key];
    if (typeof v !== 'string' || !v) continue;
    if (types.includes('p') || (types.includes('pn') && looksLikeHostPath(v))) out.push(v);
  }
  return out;
}

const NAMES: Record<string, string> = { wp: 'a string', wpa: 'a list of strings', p: 'a path', pn: 'a name or a path', s: 'a string', n: 'a number', b: 'true or false', o: 'an object', a: 'a list', sa: 'a list of strings', x: 'a value', null: 'null' };

function isType(v: unknown, t: string): boolean {
  switch (t) {
    case 's':
    case 'p':
    case 'pn':
    case 'wp':
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
    case 'wpa':
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
    const range = RPC_RANGES[key];
    if (range && typeof v === 'number' && (v < range[0] || v > range[1])) throw new ApsError('ValidationError', `${method}: ${key} must be from ${range[0]} to ${range[1].toLocaleString('en-US')}`, { details: { method, param: key, min: range[0], max: range[1] } });
    const allowed = RPC_VALUES[method]?.[key];
    if (allowed && v !== '' && !allowed.includes(v as string))
      throw new ApsError('ValidationError', `${method}: unknown ${key} "${String(v)}"`, { suggestions: [`Use one of: ${allowed.join(', ')}`], details: { method, param: key, valid: allowed } });
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
