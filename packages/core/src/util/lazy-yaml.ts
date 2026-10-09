import type * as Yaml from 'yaml';
import { nodeRequire } from './lazy-require.js';

/**
 * The yaml library, loaded at first use rather than when the engine is imported (see lazy-require.ts). The functions
 * here have the names and types of yaml's own, so a module that only calls yaml inside its functions imports them from
 * here instead of from 'yaml' (and its types with `import type`).
 */
let yamlMod: typeof Yaml | undefined;
export const yaml = (): typeof Yaml => (yamlMod ??= typeof require === 'function' ? require('yaml') : nodeRequire('yaml'));

export const parseYaml = ((...args: Parameters<typeof Yaml.parse>) => yaml().parse(...args)) as typeof Yaml.parse;
export const stringifyYaml = ((...args: Parameters<typeof Yaml.stringify>) => yaml().stringify(...args)) as typeof Yaml.stringify;
export const parseDocument = ((...args: Parameters<typeof Yaml.parseDocument>) => yaml().parseDocument(...args)) as typeof Yaml.parseDocument;
export const isMap = ((node: unknown) => yaml().isMap(node)) as typeof Yaml.isMap;
export const isSeq = ((node: unknown) => yaml().isSeq(node)) as typeof Yaml.isSeq;
export const isScalar = ((node: unknown) => yaml().isScalar(node)) as typeof Yaml.isScalar;
export const isPair = ((node: unknown) => yaml().isPair(node)) as typeof Yaml.isPair;
/** A new yaml LineCounter (positions of parse errors and nodes). */
export const lineCounter = (): Yaml.LineCounter => new (yaml().LineCounter)();
