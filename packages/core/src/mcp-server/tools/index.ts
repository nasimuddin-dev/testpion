import type { AppSettings, Collection } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import type { DebuggerExchange } from '../../debugger/proxy.js';
import type { Redactor } from '../../util/redact.js';
import { ApsError } from '../../errors.js';
import { createEngineContext } from '../../engine.js';
import { McpSession } from '../../protocols/mcp/client.js';
import { commandLine, isCommandTrusted } from '../../storage/trust.js';
import { aiTools } from '../ai-tools.js';
import { arazzoTools } from '../arazzo-tools.js';
import { importTools } from '../import-tools.js';
import { datasetTools } from '../dataset-tools.js';
import { debuggerTools } from '../debugger-tools.js';
import { deployTools } from '../deploy-tools.js';
import { evalAgentTools } from '../eval-agent-tools.js';
import { flowGraphTools } from '../flow-graph-tools.js';
import { gitTools } from '../git-tools.js';
import { historyTools, type HistoryToolsDeps } from '../history-tools.js';
import { kindTools } from '../kind-tools.js';
import { mockTools } from '../mock-tools.js';
import { openApiTools } from '../openapi-tools.js';
import { ragTools } from '../rag-tools.js';
import { ragEvalTools } from '../rag-eval-tools.js';
import { recordingTools } from '../recording-tools.js';
import { refTools } from '../ref-tools.js';
import { scaleTools } from '../scale-tools.js';
import type { Tool } from '../tool.js';
import { workspaceEditTools, type EditToolsDeps } from '../workspace-edit-tools.js';
import { bundleTools } from './bundle-tools.js';
import { itemTools } from './item-tools.js';
import { outputTools } from './output-tools.js';
import { gitItemTools } from './git-item-tools.js';
import { gitOpsTools } from './git-ops-tools.js';
import { gitSetupTools } from './git-setup-tools.js';
import { searchAskTools } from './search-ask-tools.js';

/** What the tool modules need from the server: the workspace, its secrets and settings, and the lookups the server shares. */
export interface ModuleToolDeps {
  store: WorkspaceStore;
  secrets: SecretStore;
  settings: AppSettings;
  redactor: Redactor;
  collections(): Collection[];
  findCollection(ref: unknown): Collection;
  findRequest: EditToolsDeps['findRequest'] & HistoryToolsDeps['findRequest'];
  /** An OpenAPI document given as an http(s) link, a path inside the workspace or the text itself. */
  readSpec(ref: string): Promise<string>;
  /** What debugger_capture captured in this server; flow_from_exchanges reads it too. */
  captured: DebuggerExchange[];
  /** The environment's name when it exists and may be sent to (the server's rule), undefined for none. */
  checkEnvironment(name: unknown): string | undefined;
}

/**
 * The tools of every module, in the server's order (testpion-mcp.ts adds its own inline tools before them, then the
 * flows' tools): a new tool goes into the module of its subject, or a new module listed here, with its name added to
 * the pinned list in tests/integration/workspace-run.test.ts. The file that composes the server stops growing per tool.
 */
export function moduleTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, redactor, findCollection, findRequest, checkEnvironment } = d;
  return [
    ...historyTools({ store, redactor, findCollection, findRequest }),
    ...refTools({ store }),
    ...kindTools({ store }),
    ...itemTools({ store }),
    ...outputTools({ store, redactor }),
    ...bundleTools({ store }),
    ...searchAskTools({ store, secrets, settings }),
    ...mockTools({ store }),
    ...datasetTools({ store }),
    ...arazzoTools({ store }),
    ...importTools({ store }),
    ...gitTools({ store, findCollection, redactor }),
    ...gitItemTools({ store }),
    ...gitOpsTools({ store, redactor }),
    ...gitSetupTools({ store, redactor }),
    ...openApiTools({ store, readSpecRef: d.readSpec, context: (environment) => createEngineContext({ store, secrets, settings, environment }) }),
    ...debuggerTools({ redactor, store, session: d.captured }),
    ...recordingTools({ store, redactor, secrets, session: d.captured }),
    ...flowGraphTools({ store }),
    ...scaleTools({ store, secrets, settings, redactor, checkEnvironment }),
    ...deployTools({ store }),
    ...evalAgentTools({ store }),
    ...ragTools({ store, secrets, settings, checkEnvironment }),
    ...ragEvalTools({ store, secrets, settings, checkEnvironment }),
    ...aiTools({ store, secrets, settings, checkEnvironment }),
    ...workspaceEditTools({
      store,
      redactor,
      collections: d.collections,
      findCollection,
      findRequest,
      // the workspace's MCP servers, with the environment's variables; a stdio server only when the user allowed its command
      mcpSession: async (ref) => {
        const ctx = createEngineContext({ store, secrets, settings });
        const r = ref.toLowerCase();
        const cfg = ctx.services.mcpServers.find((x) => x.id.toLowerCase() === r) ?? ctx.services.mcpServers.find((x) => x.name.toLowerCase() === r);
        if (!cfg) {
          await ctx.dispose();
          throw new ApsError('ConfigurationError', `No MCP server "${ref}" in the workspace. Available: ${ctx.services.mcpServers.map((x) => x.name).join(', ') || 'none'}`);
        }
        if (cfg.transport === 'stdio' && !isCommandTrusted(store, cfg.command, cfg.args ?? [])) {
          await ctx.dispose();
          throw new ApsError('ConfigurationError', `"${cfg.name}" is a program (${commandLine(cfg.command, cfg.args ?? [])}) the user has not allowed to run from here`, {
            suggestions: ['Ask the user to open the server in TestPion (MCP view), press Connect and choose "Always for this workspace"; then try again.'],
          });
        }
        const session = new McpSession(cfg, ctx.redactor, { cookieJar: ctx.services.cookieJar });
        await session.connect(30_000);
        const close = session.close.bind(session);
        session.close = async () => {
          await close();
          await ctx.dispose();
        };
        return session;
      },
    }),
  ];
}
