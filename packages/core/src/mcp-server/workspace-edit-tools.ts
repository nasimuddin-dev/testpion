import { applyTidy, tidyCollection } from '../storage/collection-tidy.js';
import { moveCollectionVariablesToEnvironments } from '../storage/move-variables.js';
import { replaceInCollection, REPLACE_FIELDS, type ReplaceField } from '../storage/collection-replace.js';
import type { Collection, CollectionFolder, CollectionNode, HttpRequestSpec, KeyValue, SavedHttpRequest } from '../model/types.js';
import { ApsError } from '../errors.js';
import { externalizeSecrets, type SecretPlaceholder } from '../import/save-request.js';
import { Redactor } from '../util/redact.js';
import { shortId } from '../util/ids.js';
import type { WorkspaceStore } from '../storage/workspace.js';
import { commandLine, isCommandTrusted } from '../storage/trust.js';
import { McpSession } from '../protocols/mcp/client.js';
import { str, type Tool } from './tool.js';

/**
 * MCP tools that let an agent change a workspace the way a person does in the app: edit, move and delete requests,
 * create collections and folders, set collection variables, and test the workspace's own MCP servers. Secrets an
 * agent types into a request become {{variables}} (never written), as in save_request.
 */

type Flat = { node: CollectionNode; folder: string };

export interface EditToolsDeps {
  store: WorkspaceStore;
  redactor: Redactor;
  collections(): Collection[];
  findCollection(ref: unknown): Collection;
  findRequest(c: Collection, ref: unknown): Flat;
  /** The engine context for the workspace's MCP servers (resolved variables, redaction, cookies). */
  mcpSession(ref: string): Promise<McpSession>;
}


/** The folder a path such as "Auth / Tokens" names, created when missing; '' or undefined is the collection itself. */
function folderItems(c: Collection, path: string | undefined): CollectionNode[] {
  let items = c.items;
  for (const part of (path ?? '').split('/').map((p) => p.trim()).filter(Boolean)) {
    let f = items.find((n): n is CollectionFolder => n.kind === 'folder' && n.name.toLowerCase() === part.toLowerCase());
    if (!f) {
      f = { kind: 'folder', id: shortId('fld-'), name: part, items: [] };
      items.push(f);
    }
    items = f.items;
  }
  return items;
}

/** Remove a node wherever it is; returns it. */
function takeOut(items: CollectionNode[], id: string): CollectionNode | undefined {
  const i = items.findIndex((n) => n.id === id);
  if (i >= 0) return items.splice(i, 1)[0];
  for (const n of items) {
    if (n.kind !== 'folder') continue;
    const r = takeOut(n.items, id);
    if (r) return r;
  }
  return undefined;
}

const headersOf = (v: unknown): KeyValue[] | undefined => {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return (v as Array<{ key: string; value: string; enabled?: boolean }>).map((h) => ({ key: String(h.key), value: String(h.value ?? ''), enabled: h.enabled !== false }));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([key, value]) => ({ key, value: String(value), enabled: true }));
  throw new ApsError('ValidationError', 'headers must be an object {name: value} or a list of {key, value}');
};

export function workspaceEditTools(d: EditToolsDeps): Tool[] {
  const { store, redactor, findCollection, findRequest } = d;
  const replaceTool: Tool = {
    name: 'replace_in_collection',
    write: true,
    description:
      "Find and replace across a collection's requests: URLs, query parameters, headers, bodies, auth fields, scripts and names (`fields` narrows it; `folder` limits it to a folder). Case-insensitive unless caseSensitive; `regex` for a regular expression ($1 … for groups). It previews by default (`apply` false): every change with the request, where and before / after; call again with apply: true to save them.",
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id' },
        find: { type: 'string', description: 'Text (or regular expression) to find' },
        replace: { type: 'string', description: 'What to put instead' },
        regex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' },
        fields: { type: 'array', items: { type: 'string', enum: REPLACE_FIELDS }, description: 'Where to look (default: everywhere)' },
        folder: { type: 'string', description: 'Only this folder (name or id)' },
        apply: { type: 'boolean', description: 'Save the changes (default false: preview)' },
      },
      required: ['collection', 'find', 'replace'],
    },
    run: (a) => {
      const c = findCollection(a.collection);
      let folderId: string | undefined;
      if (a.folder) {
        const want = String(a.folder).toLowerCase();
        const find = (nodes: CollectionNode[]): string | undefined => {
          for (const n of nodes) if (n.kind === 'folder') {
            if (n.id.toLowerCase() === want || n.name.toLowerCase() === want) return n.id;
            const inner = find(n.items);
            if (inner) return inner;
          }
          return undefined;
        };
        folderId = find(c.items);
        if (!folderId) throw new ApsError('ConfigurationError', `No folder "${String(a.folder)}" in "${c.name}"`);
      }
      const r = replaceInCollection(c, { find: String(a.find ?? ''), replace: String(a.replace ?? ''), regex: a.regex === true, caseSensitive: a.caseSensitive === true, fields: Array.isArray(a.fields) ? (a.fields.map(String) as ReplaceField[]) : undefined, folderId });
      if (a.apply === true && r.matches.length) store.saveCollection(r.collection);
      const red = (v: string) => (redactor ? redactor.redactString(v) : v);
      return { collection: c.name, changes: r.matches.length, applied: a.apply === true && r.matches.length > 0, matches: r.matches.slice(0, 200).map((m) => ({ ...m, before: red(m.before).slice(0, 300), after: red(m.after).slice(0, 300) })) };
    },
  };
  const summary = (c: Collection, n: SavedHttpRequest, folder: string, placeholders: SecretPlaceholder[] = []) => ({
    collection: c.name,
    collectionId: c.id,
    id: n.id,
    name: n.name,
    folder,
    method: n.request.method,
    url: n.request.url,
    headers: n.request.headers?.length ?? 0,
    placeholders,
    ...(placeholders.length ? { next: `Ask the user to add ${placeholders.map((p) => p.variable).join(', ')} as secret variables of an environment.` } : {}),
  });
  const folderOf = (c: Collection, id: string): string => {
    const walk = (nodes: CollectionNode[], path: string[]): string | undefined => {
      for (const n of nodes) {
        if (n.id === id) return path.join(' / ');
        if (n.kind === 'folder') {
          const r = walk(n.items, [...path, n.name]);
          if (r !== undefined) return r;
        }
      }
      return undefined;
    };
    return walk(c.items, []) ?? '';
  };

  const moveVarsTool: Tool = {
    name: 'move_variables_to_environments',
    write: true,
    description:
      "Move collection variables into environments. A collection variable wins over every environment, so a base URL kept in a collection (common in Postman imports) can't differ per environment; moved, each environment gets the collection's value (one that already has the variable keeps its own) and the collection loses it. `keys` default to all of the collection's variables; `dryRun` says what would happen without saving.",
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id' },
        keys: { type: 'array', items: { type: 'string' }, description: 'Variables to move (default: all)' },
        environments: { type: 'array', items: { type: 'string' }, description: 'Environment names or ids' },
        dryRun: { type: 'boolean' },
      },
      required: ['collection', 'environments'],
    },
    run: (a) =>
      moveCollectionVariablesToEnvironments(store, {
        collectionId: findCollection(a.collection).id,
        keys: Array.isArray(a.keys) ? a.keys.map(String) : undefined,
        environments: Array.isArray(a.environments) ? a.environments.map(String) : [],
        dryRun: a.dryRun === true,
      }),
  };
  const tidyTool: Tool = {
    name: 'collection_tidy',
    write: true,
    description:
      "What piles up in a collection: duplicate requests (same method, URL and body), hosts typed into URLs instead of a {{variable}}, empty folders, collection variables nothing uses. Returns the findings; removeDuplicates (keeps the first of each), removeEmptyFolders and removeUnusedVariables also fix those and save. For a typed-in host, use replace_in_collection to put a variable in its place.",
    inputSchema: {
      type: 'object',
      properties: {
        collection: { type: 'string', description: 'Collection name or id' },
        removeDuplicates: { type: 'boolean' },
        removeEmptyFolders: { type: 'boolean' },
        removeUnusedVariables: { type: 'boolean' },
        useCollectionAuth: { type: 'boolean', description: "Make a repeated Authorization header the collection's auth (those requests inherit it)" },
      },
      required: ['collection'],
    },
    run: (a) => {
      const c = findCollection(a.collection);
      const findings = tidyCollection(c);
      const fix = { removeDuplicates: a.removeDuplicates === true, removeEmptyFolders: a.removeEmptyFolders === true, removeUnusedVariables: a.removeUnusedVariables === true, useCollectionAuth: a.useCollectionAuth === true };
      let removed = 0;
      if (fix.removeDuplicates || fix.removeEmptyFolders || fix.removeUnusedVariables || fix.useCollectionAuth) {
        const r = applyTidy(c, fix);
        removed = r.removed;
        if (removed) store.saveCollection(r.collection);
      }
      return { collection: c.name, findings: findings.map((f) => ({ ...f, ids: f.ids.slice(0, 50), where: f.where.slice(0, 50) })), removed };
    },
  };
  return [
    replaceTool,
    moveVarsTool,
    tidyTool,
    {
      name: 'update_request',
      write: true,
      description:
        'Change a saved REST request: any of name, method, url, headers (replaces them all; an object {name: value} or a list of {key, value, enabled}), body (a string; JSON when it parses, else text; "" removes it), description, preRequestScript, testScript. Fields left out keep their value. Secret values (Authorization, API keys, passwords) are not written: they become {{variables}} listed in `placeholders`. Use set_request_checks for checks and move_request to move it.',
      inputSchema: {
        type: 'object',
        properties: {
          collection: str('Collection name or id'),
          request: str('Request name or id'),
          name: str('New name'),
          method: str('HTTP method'),
          url: str('URL, with {{variables}}'),
          headers: { type: ['object', 'array'], description: 'All headers: {name: value} or [{key, value, enabled}]' },
          body: str('The body as text ("" removes it)'),
          description: str('Documentation of the request (Markdown)'),
          preRequestScript: str('The pre-request script (pm.* API); "" removes it'),
          testScript: str('The post-response script (pm.test …); "" removes it'),
        },
        required: ['collection', 'request'],
      },
      run: (a) => {
        const c = findCollection(a.collection);
        const { node } = findRequest(c, a.request);
        if (node.kind !== 'http') throw new ApsError('ValidationError', `"${node.name}" is not a REST request (update only works for REST requests yet)`);
        const req: HttpRequestSpec = { ...node.request };
        if (a.method !== undefined) req.method = String(a.method).toUpperCase();
        if (a.url !== undefined) req.url = String(a.url);
        const headers = headersOf(a.headers);
        if (headers) req.headers = headers;
        if (a.body !== undefined) {
          const text = String(a.body);
          req.body = text ? { type: /^\s*[{[]/.test(text) ? 'json' : 'text', content: text } : undefined;
        }
        const { request: safe, placeholders } = externalizeSecrets(req, redactor);
        const next: SavedHttpRequest = {
          ...node,
          request: safe,
          ...(a.name !== undefined ? { name: String(a.name).trim() || node.name } : {}),
          ...(a.description !== undefined ? { description: String(a.description) || undefined } : {}),
          ...(a.preRequestScript !== undefined ? { preRequestScript: String(a.preRequestScript) || undefined } : {}),
          ...(a.testScript !== undefined ? { testScript: String(a.testScript) || undefined } : {}),
        };
        const map = (nodes: CollectionNode[]): CollectionNode[] => nodes.map((n) => (n.kind === 'folder' ? { ...n, items: map(n.items) } : n.id === node.id ? next : n));
        const saved = store.saveCollection({ ...c, items: map(c.items) });
        return summary(saved, next, folderOf(saved, next.id), placeholders);
      },
    },
    {
      name: 'move_request',
      write: true,
      description: 'Move a request (or a folder) to a folder of the same or another collection. `folder` is a path such as "Auth / Tokens" (created when missing); "" is the top of the collection.',
      inputSchema: {
        type: 'object',
        properties: { collection: str('Collection name or id of the request'), request: str('Request or folder name or id'), toCollection: str('Target collection (default: the same)'), folder: str('Target folder path; "" for the top level') },
        required: ['collection', 'request'],
      },
      run: (a) => {
        const from = structuredClone(findCollection(a.collection));
        const ref = String(a.request ?? '').toLowerCase();
        const all: CollectionNode[] = [];
        const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
        walk(from.items);
        const target = all.find((n) => n.id.toLowerCase() === ref) ?? all.find((n) => n.name.toLowerCase() === ref);
        if (!target) throw new ApsError('ConfigurationError', `No request or folder "${String(a.request)}" in "${from.name}"`);
        const to = a.toCollection && String(a.toCollection).toLowerCase() !== from.id.toLowerCase() && String(a.toCollection).toLowerCase() !== from.name.toLowerCase() ? structuredClone(findCollection(a.toCollection)) : from;
        const taken = takeOut(from.items, target.id)!;
        const dest = folderItems(to, a.folder === undefined ? undefined : String(a.folder));
        if (target.kind === 'folder' && to === from && JSON.stringify(dest).includes(`"id":"${target.id}"`)) throw new ApsError('ValidationError', 'A folder cannot be moved into itself');
        dest.push(taken);
        store.saveCollection(from);
        if (to !== from) store.saveCollection(to);
        return { moved: taken.name, kind: taken.kind, collection: to.name, folder: folderOf(to, taken.id) };
      },
    },
    {
      name: 'delete_request',
      write: true,
      description: 'Delete a request or a folder (with everything in it) from a collection. The deleted item is returned, so it can be put back with save_request if that was a mistake. Deleting a whole collection is left to the user (the app keeps it in the trash for 30 days).',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), request: str('Request or folder name or id') }, required: ['collection', 'request'] },
      run: (a) => {
        const c = structuredClone(findCollection(a.collection));
        const ref = String(a.request ?? '').toLowerCase();
        const all: CollectionNode[] = [];
        const walk = (nodes: CollectionNode[]) => nodes.forEach((n) => (all.push(n), n.kind === 'folder' && walk(n.items)));
        walk(c.items);
        const target = all.find((n) => n.id.toLowerCase() === ref) ?? all.find((n) => n.name.toLowerCase() === ref);
        if (!target) throw new ApsError('ConfigurationError', `No request or folder "${String(a.request)}" in "${c.name}"`);
        const removed = takeOut(c.items, target.id);
        store.saveCollection(c);
        return { deleted: target.name, kind: target.kind, collection: c.name, item: removed };
      },
    },
    {
      name: 'create_collection',
      write: true,
      description: 'Create an empty collection (name, optional description and variables). save_request with `create: true` also creates one on the way.',
      inputSchema: {
        type: 'object',
        properties: { name: str('Collection name'), description: str('What the collection is for (Markdown)'), variables: { type: 'object', description: 'Collection variables {name: value} (plain values only; secrets belong in secret environment variables)' } },
        required: ['name'],
      },
      run: (a) => {
        const name = String(a.name ?? '').trim();
        if (!name) throw new ApsError('ValidationError', 'Give the collection a name');
        if (d.collections().some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new ApsError('ValidationError', `A collection named "${name}" exists already`);
        const variables: KeyValue[] = Object.entries((a.variables as Record<string, unknown>) ?? {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
        const saved = store.saveCollection({ schemaVersion: '1.0', id: shortId('col-'), name, description: a.description ? String(a.description) : undefined, version: 0, variables, items: [], updatedAt: new Date().toISOString() } as Collection);
        return { id: saved.id, name: saved.name, variables: variables.map((v) => v.key) };
      },
    },
    {
      name: 'create_folder',
      write: true,
      description: 'Create a folder (or a path of folders such as "Auth / Tokens") in a collection.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), folder: str('Folder path, e.g. "Auth / Tokens"') }, required: ['collection', 'folder'] },
      run: (a) => {
        const c = structuredClone(findCollection(a.collection));
        const path = String(a.folder ?? '').trim();
        if (!path) throw new ApsError('ValidationError', 'Give the folder a name');
        folderItems(c, path);
        store.saveCollection(c);
        return { collection: c.name, folder: path };
      },
    },
    {
      name: 'set_collection_variable',
      write: true,
      description: 'Set (or with `value: null`, remove) a collection variable: plain values only, shared by every request of the collection ({{name}}). Secrets belong in secret environment variables, which the user sets in the app.',
      inputSchema: { type: 'object', properties: { collection: str('Collection name or id'), name: str('Variable name'), value: { type: ['string', 'number', 'boolean', 'null'], description: 'The value; null removes the variable' } }, required: ['collection', 'name'] },
      run: (a) => {
        const c = structuredClone(findCollection(a.collection));
        const key = String(a.name ?? '').trim();
        if (!key) throw new ApsError('ValidationError', 'Give the variable a name');
        if (a.value !== null && /key|token|secret|password|credential/i.test(key) && String(a.value ?? '').length > 0) {
          throw new ApsError('ValidationError', `"${key}" looks like a secret: collection variables are written to the workspace file. Ask the user to add it as a secret environment variable instead.`);
        }
        const vars = (c.variables ?? []).filter((v) => v.key !== key);
        if (a.value !== null && a.value !== undefined) vars.push({ key, value: String(a.value), enabled: true });
        store.saveCollection({ ...c, variables: vars });
        return { collection: c.name, variables: vars.map((v) => v.key) };
      },
    },
    {
      name: 'list_mcp_servers',
      description: 'The MCP servers saved in the workspace (the MCP view): id, name, transport (stdio, streamable-http, sse, mock) and target. Stdio servers are programs: they run from here only after the user allowed the command in the app (Connect ▸ Always for this workspace).',
      inputSchema: { type: 'object', properties: {} },
      run: () =>
        store.getMcpServers().map((s) => ({
          id: s.id,
          name: s.name,
          transport: s.transport,
          target: s.transport === 'stdio' ? commandLine(s.command, s.args ?? []) : s.transport === 'mock' ? s.mockFile : redactor.redactUrl(s.url),
          ...(s.transport === 'stdio' ? { allowed: isCommandTrusted(store, s.command, s.args ?? []) } : {}),
        })),
    },
    {
      name: 'mcp_server_tools',
      write: true,
      description: 'Connect to one of the workspace\'s MCP servers and list what it offers: tools (with input schemas), resources and prompts, plus its server info. Use it before mcp_call_tool. A stdio server runs only when the user allowed its command in the app.',
      inputSchema: { type: 'object', properties: { server: str('Server name or id (list_mcp_servers)') }, required: ['server'] },
      run: async (a) => {
        const s = await d.mcpSession(String(a.server));
        try {
          const disc = await s.discover();
          return { serverInfo: disc.serverInfo, instructions: disc.instructions, tools: disc.tools, resources: disc.resources.slice(0, 200), prompts: disc.prompts };
        } finally {
          await s.close();
        }
      },
    },
    {
      name: 'mcp_call_tool',
      write: true,
      description: 'Call a tool of one of the workspace\'s MCP servers with arguments and return its result (content, structured content, isError, duration): the way to test an MCP server. {{variables}} in the server\'s settings resolve from the environment. A stdio server runs only when the user allowed its command in the app.',
      inputSchema: {
        type: 'object',
        properties: { server: str('Server name or id'), tool: str('Tool name'), arguments: { type: 'object', description: 'The tool\'s arguments' }, timeoutMs: { type: 'number', description: 'Give up after this long (default 60000)' } },
        required: ['server', 'tool'],
      },
      run: async (a) => {
        const s = await d.mcpSession(String(a.server));
        try {
          const r = await s.callTool(String(a.tool), (a.arguments as Record<string, unknown>) ?? {}, { timeoutMs: Math.min(Math.max(Number(a.timeoutMs) || 60_000, 1000), 600_000) });
          return { isError: r.isError, durationMs: r.durationMs, content: r.content, structuredContent: r.structuredContent };
        } finally {
          await s.close();
        }
      },
    },
  ];
}
