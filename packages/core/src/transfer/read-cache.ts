import type { WorkspaceStore } from '../storage/workspace.js';

/**
 * The store for a run that only reads (an export, an import preview). Every adapter asks the store for the whole file it
 * needs for one item: the library of 2,500 prompts for each prompt, the environments for each environment. The store
 * parses the file each time (it caches only the text), so a run of N items parsed N times. Here each such read is made
 * once and handed out again. The run must not write through this store, and what it returns must not be changed (the
 * adapters copy on change; the secret stripper copies on write).
 */
export function cachedReads(store: WorkspaceStore): WorkspaceStore {
  const memo = new Map<string, unknown>();
  const once = <T>(key: string, read: () => T): T => {
    if (memo.has(key)) return memo.get(key) as T;
    const value = read();
    memo.set(key, value);
    return value;
  };
  return new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      switch (prop) {
        case 'getLibrary':
          return (kind: string) => once(`library:${kind}`, () => target.getLibrary(kind));
        case 'listEnvironments':
          return () => once('environments', () => target.listEnvironments());
        case 'getMcpServers':
          return () => once('mcp-servers', () => target.getMcpServers());
        case 'getProviders':
          return () => once('providers', () => target.getProviders());
        case 'listCollections':
          return () => once('collections', () => target.listCollections());
        case 'getCollection':
          return (id: string) => once(`collection:${id}`, () => target.getCollection(id));
        default:
          // a method of the real store keeps the real store as `this` (private fields are not reachable through a proxy)
          return value.bind(target);
      }
    },
  });
}
