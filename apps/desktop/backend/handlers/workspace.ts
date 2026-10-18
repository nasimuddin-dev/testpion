/** RPC handlers: Workspaces, environments, current values, cookies and variables. */
import { describeVariables } from '../var-descriptions.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  ApsError,
  listTrash,
  removeItem,
  restoreFromTrash,
  purgeTrash,
  compareEnvironments,
  environmentMatrix,
  WorkspaceStore,
  WORKSPACE_FORMATS,
  exportSummary,
  importWorkspaceBundle,
  workspaceExportFileName,
  exportPostmanEnvironment,
  DYNAMIC_VARIABLES,
  variableUsages,
  renameVariable,
  environmentToDotenv,
  type CookieInput,
  secretKeys,
  templateVariables,
  itemInfo,
  onboardingProgress,
  DEFAULT_BASE_URLS,
  type Environment,
  type WorkspaceBundle,
  findLiteralSecrets,
  unusedVariables,
  findEnvironment,
  setEnvironmentVariables,
  addVariablesToEnvironments,
  makeGitReady,
  requireCollectionFor,
  requireEnvironment,
  isWorkspaceDir,
  resolveItemRef,
  toItemRef,
  samePath,
  type RefResolution,
  importFileFilters,
} from '@testpion/core';
import type { Backend, Handlers } from '../backend.js';
import { takeOpenLinks } from '../open-links.js';

export function workspaceHandlers(be: Backend): Handlers {
  return {
    'ws.list': () => be.manager.list(),
    'ws.current': () =>
      be.store && {
        ...be.store.workspace,
        path: be.store.root,
        environments: be.store.listEnvironments(),
        migrations: be.store.migrationsApplied,
      },
    'ws.create': ({ name }: { name: string }) => {
      const s = be.manager.create(name);
      s.saveProviders([{ id: 'offline', name: 'Offline mock', kind: 'mock', baseUrl: DEFAULT_BASE_URLS.mock! }]);
      const root = s.root;
      s.close();
      be.openStore(root);
      return be.handlers['ws.current']!({});
    },
    /** Make the open workspace git-ready (.gitignore, .gitattributes, git-friendly collection files); safe to repeat. */
    'ws.gitReady': () => makeGitReady(be.ws),
    /** What this start added to the user's examples workspace from a newer app version (told once). */
    'ws.examplesAdded': () => {
      const added = be.examplesAdded;
      be.examplesAdded = [];
      return added;
    },
    /** Open the examples workspace that ships with the app (copied into the data folder the first time). */
    'ws.openExamples': () => {
      const info = be.installExamples();
      if (!info) throw new ApsError('ConfigurationError', 'This installation has no examples workspace', { suggestions: [] });
      be.openStore(info.path);
      return be.handlers['ws.current']!({});
    },
    /** Two environments side by side: values (secrets masked, never sent) and what differs. */
    'env.diff': ({ left, right }: { left: string; right: string }) => {
      const get = (ref: string) => {
        const e = be.ws.getEnvironment(ref);
        if (!e) throw new ApsError('ConfigurationError', `No environment "${ref}"`, { suggestions: [] });
        return e;
      };
      return compareEnvironments(get(left), get(right), { values: true, secrets: be.secrets, redactor: be.logger.redactor });
    },
    /** Every variable across every environment: statuses only (set, empty, missing, off), never values. */
    'env.matrix': () => environmentMatrix(be.ws, { secrets: be.secrets }),
    'ws.open': async ({ ref }: { ref?: string }) => {
      let path = ref ? be.manager.resolve(ref) : undefined;
      if (!ref && be.host.openDialog) {
        const dir = await be.host.openDialog({ directory: true });
        if (!dir) return null;
        path = dir;
        if (!isWorkspaceDir(dir))
          throw new ApsError('ConfigurationError', `${dir} is not a TestPion workspace (it has no TestPion workspace.json)`, {
            suggestions: ['Choose the folder that contains workspace.json, e.g. a workspace kept in a git repository.', 'To start a new workspace use New; to bring in a Postman collection or OpenAPI file use Import.'],
          });
        be.settings = be.manager.rememberWorkspacePath(dir);
      }
      if (!ref && !be.host.openDialog) throw new ApsError('ValidationError', 'There is no folder picker here: give the path of the workspace folder');
      if (!path) throw new ApsError('ConfigurationError', `Workspace ${ref} not found`);
      be.openStore(path);
      return be.handlers['ws.current']!({});
    },
    'ws.update': async ({ name, description, variables }: { name?: string; description?: string; variables?: Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }> }) => {
      const ws = be.ws;
      let vars = variables;
      if (vars) {
        // the secret values go to the secret store first: the file only gets the blanked value once they are safe there
        for (const v of vars)
          if (v.secret && v.value)
            try {
              await be.secrets.set(secretKeys.workspaceVar(ws.id, v.key), v.value);
            } catch (e) {
              throw new ApsError('ConfigurationError', `Could not keep the secret workspace variable ${v.key} in the secret store: ${(e as Error).message}. Nothing was saved.`, {
                suggestions: ['Check the secret store (Settings > Secrets), then save again.'],
              });
            }
        vars = vars.map((v) => (v.secret ? { ...v, value: '' } : v));
      }
      return ws.updateWorkspace({ ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}), ...(vars ? { variables: vars } : {}) });
    },
    'ws.duplicate': ({ ref, name }: { ref: string; name: string }) => be.manager.duplicate(ref, name),
    /** A workspace with counts (collections, environments, tests) and whether deleting removes its files. */
    'ws.details': ({ ref }: { ref: string }) => ({ ...be.manager.details(ref), current: !!be.store && samePath(be.manager.details(ref).path, be.store.root) }),
    /** Rename any workspace; the open one goes through its store so the UI state stays in sync. */
    'ws.rename': ({ ref, name }: { ref: string; name: string }) => {
      const p = be.manager.resolve(ref);
      if (p && be.store && samePath(p, be.store.root)) return be.ws.updateWorkspace({ name: name.trim() });
      return be.manager.rename(ref, name);
    },
    /**
     * Delete a workspace (or, for a folder the user opened, remove it from the list). Deleting the open
     * workspace switches to another one first; the last workspace can't be deleted.
     */
    'ws.delete': ({ ref }: { ref: string }) => {
      const p = be.manager.resolve(ref);
      if (!p) throw new ApsError('ConfigurationError', `Workspace "${ref}" not found`);
      let switchedTo: string | undefined;
      // the open one by any name (a link to it, its real path): switched away from before its folder goes
      if (be.store && samePath(p, be.store.root)) {
        const other = be.manager.list().find((w) => !samePath(w.path, p));
        if (!other) throw new ApsError('ValidationError', 'This is your only workspace. Create another workspace first, then delete this one.');
        be.openStore(other.path);
        switchedTo = other.name;
      }
      const r = be.manager.delete(p);
      return { ...r, switchedTo, list: be.manager.list() };
    },
    'ws.export': async ({ ref }: { ref?: string } = {}) => {
      // any workspace can be exported; one that isn't open is read without opening it in the app
      const p = ref ? be.manager.resolve(ref) : undefined;
      const other = p && be.store && !samePath(p, be.store.root) ? WorkspaceStore.open(p) : undefined; // the open one by any name is read as it is open
      try {
        const store = other ?? be.ws;
        const bundle = store.exportBundle();
        // what is in it, what was replaced by {{variables}} and what was left out (the toast says it, as the CLI does)
        const summary = exportSummary(bundle);
        const fileName = workspaceExportFileName(store.workspace.name);
        // no save dialog (browser / cloud): the caller downloads the bundle
        if (!be.host.saveDialog) return { bundle, name: store.workspace.name, fileName, ...summary };
        const dest = await be.host.saveDialog({ defaultPath: fileName, filters: [{ name: 'Workspace', extensions: ['json'] }] });
        if (!dest) return { cancelled: true };
        writeFileSync(dest, JSON.stringify(bundle, null, 2));
        return { path: dest, name: store.workspace.name, fileName, ...summary };
      } finally {
        other?.close();
      }
    },
    'ws.import': ({ bundle, name }: { bundle: WorkspaceBundle; name?: string }) => {
      const r = importWorkspaceBundle(be.manager, bundle, name);
      const root = r.store.root;
      r.store.close();
      be.openStore(root);
      return { ...(be.handlers['ws.current']!({}) as object), notes: r.notes, valuesNeeded: r.valuesNeeded, files: r.files };
    },
    /**
     * "Import…" from the workspace menu: a TestPion workspace export becomes a new workspace; anything the
     * collection importer understands (Postman, OpenAPI, HAR, TestPion collections) is added to the open one.
     */
    /** Import… with the native file dialog: a workspace export, or a collection / definition / .env added to this workspace. */
    'ws.importPick': async ({ keepPm }: { keepPm?: boolean } = {}) => {
      const f = await be.host.openDialog?.({ filters: importFileFilters('Workspace exports, collections, API definitions, GraphQL schemas, .env, .http') });
      if (!f) return null;
      return be.handlers['ws.importFile']!({ text: readFileSync(f, 'utf8'), fileName: basename(f), keepPm });
    },
    /** A workspace export opens as a workspace; anything else is imported into this one (Postman / Insomnia scripts become `tp.*` unless `keepPm`). */
    'ws.importFile': ({ text, fileName, keepPm }: { text: string; fileName?: string; keepPm?: boolean }) => {
      let data: { format?: string } | undefined;
      try {
        data = JSON.parse(text);
      } catch {
        /* YAML (OpenAPI) or not JSON: the collection importer decides */
      }
      // a workspace export by its content (the name may be .testpion.json, or .apsworkspace.json from before 0.50)
      if (data?.format && WORKSPACE_FORMATS.has(data.format)) {
        const r = importWorkspaceBundle(be.manager, data as unknown as WorkspaceBundle);
        const root = r.store.root;
        r.store.close();
        be.openStore(root);
        return { kind: 'workspace', name: be.ws.workspace.name, notes: r.notes, valuesNeeded: r.valuesNeeded, files: r.files };
      }
      const r = be.handlers['col.import']!({ text, fileName, keepPm }) as { format: string; collection?: string; environment?: string };
      return { kind: 'collection', ...r, workspace: be.ws.workspace.name };
    },
    'ws.search': ({ query }: { query: string }) => be.search?.search(query, 60) ?? [],
    /**
     * Whether an ItemRef still points at something in the open workspace, its name, and when it doesn't, why and the
     * nearest thing still there (openRef in the window asks before it opens anything it can't check itself). Indexed
     * lookups only: one answer per click, as fast with 9,000 requests as with 9. A Debugger exchange lives in the
     * window's session list: the Debugger view checks that one.
     */
    'ref.resolve': ({ ref }: { ref: unknown }): RefResolution => {
      const r = toItemRef(ref);
      if (!be.store) return { ok: false, ref: (r ?? ref) as RefResolution['ref'], reason: 'unavailable', message: 'No workspace is open', next: { label: 'Open a workspace', view: 'home' } };
      return resolveItemRef(be.store, ref);
    },
    /**
     * WF-20 the context panel: one item's file, the runs that included it, and the {{variables}} it uses with where each
     * comes from in this environment (secrets masked, never sent to the window).
     */
    'ref.info': ({ ref, environment }: { ref: unknown; environment?: string }) => {
      const r = toItemRef(ref);
      if (!r) throw new ApsError('ValidationError', 'That is not a link to something in TestPion');
      const { text, ...info } = itemInfo(be.ws, r);
      const ctx = be.context({ environment, collectionId: info.collectionId });
      try {
        const variables = describeVariables(ctx.vars, (text ? templateVariables(text) : []).slice(0, 200), 200);
        return { ...info, variables };
      } finally {
        void ctx.dispose();
      }
    },
    /** WF-22 Home's Get started: the first loop's steps, done from what the workspace holds, each with what it opens. */
    'ws.onboarding': () => onboardingProgress(be.ws),
    /** testpion://open links that started the app before the window was ready (see open-links.ts). */
    'app.takeOpenLinks': () => takeOpenLinks(),

    /** Saved items with folders of one kind (websocket, ai-prompts, mcp …), stored in library/<kind>.json. */
    /* Script packages (tp.require): packages/<name>.js in the workspace */
    'packages.list': () => be.ws.listScriptPackages(),
    'packages.get': ({ name }: { name: string }) => be.ws.readScriptPackage(name) ?? null,
    'packages.save': ({ name, code }: { name: string; code: string }) => be.ws.saveScriptPackage(name, code),
    'packages.delete': ({ name }: { name: string }) => be.ws.deleteScriptPackage(name),
    'lib.get': ({ kind }: { kind: string }) => be.ws.getLibrary(kind),
    'lib.save': ({ kind, library }: { kind: string; library: { folders: string[]; items: Array<{ id: string; name: string; folder?: string; collectionId?: string; data: unknown }> } }) => {
      const current = be.ws.getLibrary(kind).items;
      const before = new Map(current.map((i) => [i.id, JSON.stringify(i.data)]));
      // a gRPC call or connection is saved in a collection (new ones, and ones moved: never out of one)
      const had = new Map(current.map((i) => [i.id, i.collectionId]));
      requireCollectionFor(be.ws, kind, library.items.filter((i) => !had.has(i.id) || (had.get(i.id) && !i.collectionId)));
      const saved = be.ws.saveLibrary(kind, library);
      // workspace files are shared (git, exports): point out credentials typed in instead of {{variables}}
      // (only for new or changed items, so renaming or moving doesn't repeat the warning)
      const warnings = library.items
        .filter((i) => before.get(i.id) !== JSON.stringify(i.data))
        .flatMap((i) => findLiteralSecrets(i.data, be.logger.redactor).map((where) => `${i.name}: ${where}`));
      return { ...saved, warnings };
    },
    'env.list': () => be.ws.listEnvironments(),
    'env.save': async ({ env, secrets }: { env: Environment; secrets?: Record<string, string> }) => {
      for (const [k, v] of Object.entries(secrets ?? {})) if (v) await be.secrets.set(secretKeys.envVar(env.id, k), v);
      return be.ws.saveEnvironment(env);
    },
    /** Set one variable in an environment (from the {{variable}} popover): updates it, or adds it; secret ones stay in the secret store. */
    /** Variables defined in this environment (or, without one, in the workspace) that nothing in the workspace reads. */
    'vars.unused': ({ environment }: { environment?: string } = {}) => {
      const scope = environment ? `environment ${be.ws.getEnvironment(environment)?.name ?? environment}` : 'workspace';
      return [...new Set(unusedVariables(be.ws).find((x) => x.scope === scope)?.unused ?? [])];
    },
    /** Set (or add) a variable in an environment; `alsoIn` adds it to other environments where it is missing (WF-14), empty or `copy`. */
    'vars.setInEnvironment': async ({ environment, name, value, alsoIn, copy }: { environment: string; name: string; value: string; alsoIn?: string[]; copy?: boolean }) => {
      const env = findEnvironment(be.ws, environment);
      if (!env) throw new ApsError('ConfigurationError', 'Choose an environment first (top bar), then add the variable to it');
      await setEnvironmentVariables(be.ws, env.id, { [name]: value }, { secrets: be.secrets });
      const also = alsoIn?.length ? await addVariablesToEnvironments(be.ws, env.id, [name], alsoIn, { copy, secrets: be.secrets }) : [];
      return { environment: env.name, secret: !!env.variables.find((v) => v.key === name)?.secret, also };
    },
    /** Variables of one environment added to others where they are missing (after adding new ones in the Environments view). */
    'vars.addToEnvironments': ({ from, keys, to, copy }: { from: string; keys: string[]; to: string[]; copy?: boolean }) => addVariablesToEnvironments(be.ws, from, keys, to, { copy, secrets: be.secrets }),
    /** Delete an environment to Recently deleted (the kind's `ops` facet; its secret values stay in the secret store). */
    'env.delete': ({ id }: { id: string }) => removeItem(be.ws, { kind: 'environment', environmentId: id }),
    /** Recently deleted items, every kind of the trash (storage/trash.ts KINDS), 30 days. */
    'trash.list': () => listTrash(be.ws),
    'trash.restore': ({ id }: { id: string }) => restoreFromTrash(be.ws, id),
    'trash.purge': ({ id }: { id?: string }) => purgeTrash(be.ws, id),
    'env.reorder': ({ ids }: { ids: string[] }) => be.ws.reorderEnvironments(ids),
    'currentValues.summary': () => be.currentValues?.summary(),
    'currentValues.get': ({ scope, owner }: { scope: 'environment' | 'globals' | 'collectionVariables'; owner?: string }) => {
      const values = be.currentValues?.get(scope, owner ?? '') ?? {};
      // never send secret values to the UI: mask sensitive keys
      return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, be.logger.redactor.isSensitiveKey(k) ? '••••••' : v]));
    },
    /** Set a current value now (e.g. a response field saved to a variable); sensitive keys and secret variables are kept encrypted. */
    'currentValues.set': async ({ scope, owner, key, value }: { scope: 'environment' | 'globals' | 'collectionVariables'; owner?: string; key: string; value: unknown }) => {
      if (!be.currentValues) throw new ApsError('ConfigurationError', 'Current values are not available here');
      const secret = scope === 'environment' && !!be.ws.getEnvironment(owner ?? '')?.variables.some((v) => v.key === key && v.secret);
      await be.currentValues.set(scope, owner ?? '', key, value, secret || be.logger.redactor.isSensitiveKey(key));
    },
    'currentValues.reset': ({ scope, owner }: { scope?: 'environment' | 'globals' | 'collectionVariables'; owner?: string }) => be.currentValues?.reset(scope, owner),
    /** Postman's environment "quick look": initial and current values of the active environment and globals, secrets masked. */
    /** Every variable a request can use, by scope: its collection's, the environment's, the workspace's and the globals (secrets masked). */
    'env.quickLook': ({ environment, collectionId }: { environment?: string; collectionId?: string }) => {
      const mask = '••••••';
      const r = be.logger.redactor;
      const rows = (vars: Array<{ key: string; value: string; enabled?: boolean; secret?: boolean }>, current: Record<string, unknown>) => {
        const keys = [...new Set([...vars.map((v) => v.key), ...Object.keys(current)])].filter(Boolean);
        return keys.map((key) => {
          const v = vars.find((x) => x.key === key);
          const sensitive = !!v?.secret || r.isSensitiveKey(key);
          const show = (x: unknown) => (x === undefined ? undefined : sensitive ? mask : typeof x === 'string' ? x : JSON.stringify(x));
          return { key, initial: v ? (v.secret ? mask : show(v.value)) : undefined, current: show(current[key]), secret: sensitive, enabled: v?.enabled !== false };
        });
      };
      // an unknown or unreadable environment says so (never an empty look that hides why)
      const env = environment ? requireEnvironment(be.ws, environment) : undefined;
      let collection: { id: string; name: string; variables: ReturnType<typeof rows> } | undefined;
      try {
        const c = collectionId ? be.ws.getCollection(collectionId) : undefined;
        if (c) collection = { id: c.id, name: c.name, variables: rows(c.variables ?? [], be.currentValues?.get('collectionVariables', c.id) ?? {}) };
      } catch {
        /* a collection that no longer exists: no section */
      }
      return {
        collection,
        environment: env ? { id: env.id, name: env.name, isProduction: !!env.isProduction, variables: rows(env.variables, be.currentValues?.get('environment', env.name) ?? {}) } : undefined,
        workspace: rows(be.ws.workspace.variables ?? [], {}),
        globals: rows(be.settings.globalVariables ?? [], be.currentValues?.get('globals', '') ?? {}),
      };
    },

    'cookies.list': () => ({ cookies: be.cookieStore?.jar.list() ?? [], persistent: be.cookieStore?.persistent ?? false }),
    'cookies.set': ({ cookie, replace }: { cookie: CookieInput; replace?: { name: string; domain: string; path?: string } }) => {
      const jar = be.jar();
      if (replace) jar.remove(replace.domain, replace.name, replace.path);
      return jar.set(cookie);
    },
    'cookies.delete': ({ domain, name, path }: { domain: string; name: string; path?: string }) => be.jar().remove(domain, name, path),
    'cookies.clear': ({ domain }: { domain?: string }) => be.jar().clear(domain),
    'env.secretStatus': ({ envId, keys }: { envId: string; keys: string[] }) => Object.fromEntries(keys.map((k) => [k, !!be.secrets.get(secretKeys.envVar(envId, k))])),
    'vars.inspect': ({ environment, collectionId, template }: { environment?: string; collectionId?: string; template?: string }) => {
      const ctx = be.context({ environment, collectionId });
      try {
        return describeVariables(ctx.vars, template ? templateVariables(template) : Object.keys(ctx.vars.toObject()));
      } finally {
        // asked on every keystroke and hover: the context it opened must not outlive the answer
        void ctx.dispose();
      }
    },

    /** The dynamic variables ({{$guid}}, {{$randomFirstName}} …) with what each one gives. */
    'vars.dynamic': () => DYNAMIC_VARIABLES,
    /** Where a variable is used or defined (requests, scripts, environments, collection/folder/workspace variables, test files). */
    'vars.usages': ({ name }: { name: string }) => variableUsages(be.ws, name),
    /** Rename a variable everywhere in the workspace; secret values move with it. */
    'vars.rename': async ({ from, to }: { from: string; to: string }) => renameVariable(be.ws, from, to, { secrets: be.secrets }),

    /** Export an environment in Postman's format (secret values are never included). */
    'env.export': async ({ id, format }: { id: string; format?: 'postman' | 'dotenv' }) => {
      const env = be.ws.getEnvironment(id);
      if (!env) throw new ApsError('ConfigurationError', `Environment "${id}" not found`);
      if (format === 'dotenv') {
        const text = environmentToDotenv(env);
        const name = `.env.${env.name.replace(/[^\w.-]+/g, '-').toLowerCase()}`;
        const dest = await be.host.saveDialog?.({ defaultPath: name, filters: [{ name: '.env file', extensions: ['env', '*'] }] });
        if (dest) writeFileSync(dest, text);
        return { path: dest, text: dest ? undefined : text, name };
      }
      const out = exportPostmanEnvironment(env);
      const name = `${env.name}.postman_environment.json`;
      const dest = await be.host.saveDialog?.({ defaultPath: name, filters: [{ name: 'Environment', extensions: ['json'] }] });
      if (dest) writeFileSync(dest, JSON.stringify(out, null, 2));
      return { path: dest, environment: dest ? undefined : out, name };
    },
  };
}
