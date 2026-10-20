import type * as Yaml from 'yaml';
// (js-yaml ships no types; only `load` and `CORE_SCHEMA` are used, through the declaration in js-yaml.d.ts)
import { nodeRequire } from './lazy-require.js';

/**
 * The yaml library, loaded at first use rather than when the engine is imported (see lazy-require.ts). The functions
 * here have the names and types of yaml's own, so a module that only calls yaml inside its functions imports them from
 * here instead of from 'yaml' (and its types with `import type`).
 */
let yamlMod: typeof Yaml | undefined;
export const yaml = (): typeof Yaml => (yamlMod ??= typeof require === 'function' ? require('yaml') : nodeRequire('yaml'));

export const parseYaml = ((...args: Parameters<typeof Yaml.parse>) => yaml().parse(...args)) as typeof Yaml.parse;
/**
 * A big YAML document (a collection of thousands of requests) parsed with js-yaml, which is several times faster than the `yaml`
 * library: the import's budget is a few seconds for 10,000 requests. Only for documents of 256 KB or more that have no anchors or
 * aliases (the `yaml` library caps alias expansion, js-yaml does not) and only through the YAML 1.2 core schema (no timestamps,
 * no merge keys), which is what `yaml` reads by default; anything js-yaml does not take goes to the `yaml` library, whose
 * messages are the better ones. The last result is kept so detecting a format and reading it do not parse twice: callers must
 * not change what they get.
 */
let jsYamlMod: typeof import('js-yaml') | undefined;
let lastText: string | undefined;
let lastValue: unknown;
export function parseYamlShared(text: string): unknown {
  if (text === lastText) return lastValue;
  let value: unknown;
  let done = false;
  if (text.length >= 256 * 1024 && !/(^|[\s[{,:-])[&*][A-Za-z0-9_-]+/m.test(text)) {
    try {
      jsYamlMod ??= (typeof require === 'function' ? require('js-yaml') : nodeRequire('js-yaml')) as typeof import('js-yaml');
      value = jsYamlMod.load(text, { schema: jsYamlMod.CORE_SCHEMA });
      done = true;
    } catch {
      /* the yaml library reads it, or says what is wrong */
    }
  }
  if (!done) value = parseYaml(text);
  lastText = text;
  lastValue = value;
  return value;
}

export const stringifyYaml = ((...args: Parameters<typeof Yaml.stringify>) => yaml().stringify(...args)) as typeof Yaml.stringify;
export const parseDocument = ((...args: Parameters<typeof Yaml.parseDocument>) => yaml().parseDocument(...args)) as typeof Yaml.parseDocument;
export const isMap = ((node: unknown) => yaml().isMap(node)) as typeof Yaml.isMap;
export const isSeq = ((node: unknown) => yaml().isSeq(node)) as typeof Yaml.isSeq;
export const isScalar = ((node: unknown) => yaml().isScalar(node)) as typeof Yaml.isScalar;
export const isPair = ((node: unknown) => yaml().isPair(node)) as typeof Yaml.isPair;
/** A new yaml LineCounter (positions of parse errors and nodes). */
export const lineCounter = (): Yaml.LineCounter => new (yaml().LineCounter)();
