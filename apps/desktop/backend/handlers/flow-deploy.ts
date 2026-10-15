/**
 * RPC handlers: deploy a flow. flows.webhooks.* start, stop and describe the webhook server (core flow-webhooks.ts) that
 * runs flows with a `webhook:` block when something calls their path, with the app's secrets and current values; it
 * stops when the workspace changes or the app quits. tests.deployStatus says where one flow is deployed (a monitor, its
 * webhook, an MCP tool, a CI pipeline).
 */
import { ApsError, flowDeployStatus, productionAllowed, startFlowWebhookServer, webhookFlows, type FlowWebhookServer } from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';

/** The webhook server of each backend (one at a time). */
const servers = new WeakMap<Backend, FlowWebhookServer>();

/** Stop the backend's webhook server (workspace switch, app quit); nothing when none runs. */
export async function stopFlowWebhooks(be: Backend): Promise<void> {
  const s = servers.get(be);
  if (!s) return;
  servers.delete(be);
  await s.close().catch(() => undefined);
}

export function flowDeployHandlers(be: Backend): Handlers {
  const status = () => {
    const s = servers.get(be);
    // not serving: the hooks it would serve (no url)
    if (!s)
      return {
        serving: false,
        hooks: be.store ? webhookFlows(be.store.path('tests')).map((h) => ({ file: h.file, path: h.path, secret: !!h.secret, ...(h.problem ? { problem: h.problem } : {}) })) : [],
      };
    return {
      serving: true,
      port: s.port,
      url: s.url,
      hooks: s.hooks().map((h) => ({ file: h.file, path: h.path, url: h.url, secret: h.secret, ...(h.inputs ? { inputs: h.inputs } : {}), ...(h.problem ? { problem: h.problem } : {}) })),
    };
  };
  return {
    'flows.webhooks.start': async ({ port, host, environment }: { port?: number; host?: string; environment?: string }) => {
      const store = be.ws;
      if (port !== undefined && !(Number.isInteger(port) && port >= 0 && port <= 65535)) throw new ApsError('ValidationError', 'The port is 0 to 65535', { suggestions: [] });
      if (environment && !store.getEnvironment(environment)) throw new ApsError('ValidationError', `No environment "${environment}"`, { suggestions: [] });
      await stopFlowWebhooks(be);
      const allowed = productionAllowed();
      try {
        const s = await startFlowWebhookServer({
          store,
          // the production guard asked before serving (production-guard.ts): that consent covers the webhook runs in that
          // environment, and only those (a flow that names another production environment is refused data changes)
          context: (c) => be.context({ environment: c.environment, allowProduction: allowed && (c.environment ?? environment) === environment }),
          environment,
          host: host || '127.0.0.1',
          port: port ?? 4020,
          onRun: (e) => {
            be.logger[e.status < 400 ? 'info' : 'warn'](`Webhook ${e.method} ${e.path}: ${e.status}${e.error ? ` (${e.error})` : ''}`, { file: e.file, runId: e.runId });
            be.host.emit('flows.webhook.call', e);
          },
        });
        // a workspace switch while it started: the new workspace is not served
        if (be.store !== store) {
          await s.close();
          throw new ApsError('ConfigurationError', 'The workspace changed while the webhook server started', { suggestions: [] });
        }
        servers.set(be, s);
        be.logger.info(`Serving flow webhooks on ${s.url}`);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE') throw new ApsError('NetworkError', `Port ${port ?? 4020} is in use`, { suggestions: ['Pick another port, or 0 for any free port.'] });
        throw e;
      }
      return status();
    },
    'flows.webhooks.stop': async () => {
      await stopFlowWebhooks(be);
      return status();
    },
    'flows.webhooks.status': () => status(),
    'tests.deployStatus': ({ file }: { file: string }) => {
      const s = servers.get(be);
      return flowDeployStatus(be.ws, file, s ? { serving: { url: s.url } } : {});
    },
  };
}
