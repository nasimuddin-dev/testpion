import { createEngineContext } from '../../engine.js';
import { ApsError } from '../../errors.js';
import { compareRequestAcrossEnvironments } from '../../runner/env-request-compare.js';
import { compareEnvironments, environmentMatrix } from '../../storage/env-compare.js';
import { addVariablesToEnvironments, requireEnvironment, setEnvironmentVariables } from '../../storage/env-edit.js';
import { str } from '../tool.js';
import type { Tool } from '../tool.js';
import type { ModuleToolDeps } from './deps.js';

/** Environments: set a variable, order, compare, the matrix and one request across environments. */
export function environmentTools(d: ModuleToolDeps): Tool[] {
  const { store, secrets, settings, redactor, findCollection, checkEnvironment } = d;
  return [
    {
      name: 'set_environment_variable',
      write: true,
      description: 'Set plain (non-secret) variables of an environment, e.g. { "baseUrl": "https://staging.example.com" }; `create` makes the environment if needed; `alsoIn` adds them to other environments where they are missing (empty, or the same value with `copyValues`). Secret variables are refused: the user sets those in the app.',
      inputSchema: { type: 'object', properties: { environment: str('Environment name or id'), values: { type: 'object', additionalProperties: { type: 'string' }, description: 'key → value' }, create: { type: 'boolean' }, alsoIn: { type: 'array', items: { type: 'string' }, description: 'Other environments to add them to where they are missing' }, copyValues: { type: 'boolean', description: 'With alsoIn: the same values (default: empty)' } }, required: ['environment', 'values'] },
      run: async (a) => {
        const values = Object.fromEntries(Object.entries((a.values ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
        const env = setEnvironmentVariables(store, String(a.environment), values, { create: a.create === true });
        const also = Array.isArray(a.alsoIn) && a.alsoIn.length ? await addVariablesToEnvironments(store, env.id, Object.keys(values), a.alsoIn.map(String), { copy: a.copyValues === true }) : undefined;
        return { environment: env.name, set: Object.keys(values), ...(also ? { also } : {}) };
      },
    },
    {
      name: 'reorder_environments',
      write: true,
      description: 'Set the display order of environments (the order of the environment picker). Environments not listed keep their order after the listed ones.',
      inputSchema: { type: 'object', properties: { order: { type: 'array', items: { type: 'string' }, description: 'Environment names or ids, first to last' } }, required: ['order'] },
      run: (a) => {
        const refs = Array.isArray(a.order) ? a.order.map((x) => String(x)) : [];
        return store.reorderEnvironments(refs.map((r) => requireEnvironment(store, r).id)).map((e) => e.name);
      },
    },
    {
      name: 'compare_environments',
      description:
        'Compare two environments variable by variable: keys only in one of them, keys whose values differ, disabled variables, and secrets that are set on one side only. Returns statuses, never values. Use it when a request works in one environment and fails in another.',
      inputSchema: { type: 'object', properties: { left: str('Environment name or id'), right: str('Environment name or id'), includeSame: { type: 'boolean', description: 'Also list variables that are the same' } }, required: ['left', 'right'] },
      run: (a) => {
        const get = (ref: unknown) => {
          const e = store.getEnvironment(String(ref));
          if (!e) throw new ApsError('ConfigurationError', `No environment "${String(ref)}". Available: ${store.listEnvironments().map((x) => x.name).join(', ') || 'none'}`);
          return e;
        };
        const d = compareEnvironments(get(a.left), get(a.right), { secrets, redactor });
        return a.includeSame ? d : { ...d, rows: d.rows.filter((r) => r.status !== 'same') };
      },
    },
    {
      name: 'environment_matrix',
      description: 'Every variable across every environment of the workspace: for each, whether it is set, empty, missing or disabled in each environment (and whether it is a secret), incomplete variables first. Never returns values. Use it to find a variable that one environment lacks.',
      inputSchema: { type: 'object', properties: { onlyIncomplete: { type: 'boolean', description: 'Only variables that are missing, empty or disabled somewhere' } } },
      run: (a) => {
        const m = environmentMatrix(store, { secrets });
        return a.onlyIncomplete ? { ...m, rows: m.rows.filter((r) => r.incompleteIn.length) } : m;
      },
    },
    {
      name: 'compare_request_across_environments',
      write: true,
      description:
        'Send one saved request with two environments (its scripts, auth and checks run as usual) and compare the responses: status, time, headers and a field-by-field JSON body diff. Sensitive values are masked. Production environments are refused unless the server allows them.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request name or id'), left: str('First environment'), right: str('Second environment') }, required: ['collection', 'request', 'left', 'right'] },
      run: async (a) => {
        const left = checkEnvironment(a.left);
        const right = checkEnvironment(a.right);
        if (!left || !right) throw new ApsError('ConfigurationError', 'Give two environments (left and right)');
        const c = findCollection(a.collection);
        return compareRequestAcrossEnvironments({ collection: c, request: String(a.request), left, right, context: (environment) => createEngineContext({ store, secrets, settings, environment, collectionId: c.id }) });
      },
    },
  ];
}
