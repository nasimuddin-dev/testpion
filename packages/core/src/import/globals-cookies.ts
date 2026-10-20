import type { Environment } from '../model/types.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { shortId, slugify } from '../util/ids.js';
import type { Created } from './import-receipt.js';
import type { ImportDocument } from './model.js';
import type { ImportSinks, WorkspaceImportResult } from './workspace-import.js';

/**
 * The parts of an import that are not workspace files: Postman's globals (the workspace's globals on this computer) and
 * Insomnia's cookie jar (the workspace's cookie jar). The host lends a sink (the app has both stores); without one the
 * globals become an environment, so no value is lost, and the cookies are listed as not imported. The result says which.
 */
export function importGlobalsAndCookies(store: WorkspaceStore, doc: ImportDocument, sinks: ImportSinks | undefined, out: WorkspaceImportResult, made: Created): void {
  if (doc.globals?.length) {
    if (sinks?.globals) {
      void sinks.globals.set(doc.globals);
      made.globals = doc.globals.map((g) => g.key);
      out.globals = doc.globals.length;
    } else {
      const taken = store.listEnvironments();
      let name = 'Postman globals';
      for (let i = 2; taken.some((x) => x.name.toLowerCase() === name.toLowerCase()); i++) name = `Postman globals ${i}`;
      const env: Environment = {
        id: `${slugify(name)}-${shortId().slice(-4)}`,
        name,
        variables: doc.globals.map((g) => ({ key: g.key, value: g.secret ? '' : g.value, ...(g.secret ? { secret: true } : {}), enabled: true })),
      };
      store.saveEnvironment(env);
      made.environments.push({ id: env.id, name: env.name });
      (out.environments ??= []).push(env);
      out.environment ??= env;
      (out.notes ??= []).push(`The ${doc.globals.length} global variable${doc.globals.length === 1 ? '' : 's'} came over as the environment "${name}": this host has no workspace globals store (the app does)`);
      for (const g of doc.globals) if (g.secret && g.value) (out.secretsToSet ??= []).push(`${name} › ${g.key}`);
    }
  }
  if (doc.cookies?.length) {
    if (sinks?.cookies) {
      sinks.cookies.add(doc.cookies.map((c) => ({ ...c, domain: c.domain.replace(/^\./, '').toLowerCase() })));
      made.cookies = doc.cookies.map((c) => ({ name: c.name, domain: c.domain.replace(/^\./, '').toLowerCase(), path: c.path }));
      out.cookies = doc.cookies.length;
    } else (out.notes ??= []).push(`${doc.cookies.length} cookie${doc.cookies.length === 1 ? ' was' : 's were'} not imported: the cookie jar is kept by the app`);
  }
}
