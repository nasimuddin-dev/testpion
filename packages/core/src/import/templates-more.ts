import { normalizeTemplate } from './templates.js';
import { DYNAMIC_VARIABLES } from '../vars/dynamic.js';

/**
 * Variable and dynamic-value syntax of the tools beyond Postman, Insomnia and Bruno, as TestPion's `{{name}}`:
 *
 * - Thunder Client: `{{#guid}}`, `{{#timestamp}}`, `{{#date, 'YYYY-MM-DD'}}`, `{{#number, 1, 10}}` …
 * - Yaak: `${[ var ]}` and `${[ uuid.v4() ]}`, `${[ timestamp.iso8601() ]}`, `${[ faker.… ]}`
 * - Hoppscotch: `<<var>>`, `<<$guid>>`
 * - HTTPie: `{{var}}`
 *
 * A value the mapping does not know is kept as it was, and returned in `unknown` so the importer can report it: a
 * template is never left as a silent literal.
 */

const DYNAMIC = new Set(DYNAMIC_VARIABLES.map((v) => v.name));

/** Thunder's `{{#name…}}` generators → TestPion dynamic variables. */
const THUNDER: Record<string, string> = {
  guid: '$guid',
  uuid: '$guid',
  timestamp: '$timestamp',
  date: '$isoTimestamp',
  dateiso: '$isoTimestamp',
  isodate: '$isoTimestamp',
  email: '$randomEmail',
  bool: '$randomBoolean',
  boolean: '$randomBoolean',
  string: '$randomAlphaNumeric',
  number: '$randomInt',
  int: '$randomInt',
  firstname: '$randomFirstName',
  lastname: '$randomLastName',
  fullname: '$randomFullName',
  phone: '$randomPhoneNumber',
  url: '$randomUrl',
  ip: '$randomIP',
  ipv6: '$randomIPV6',
  color: '$randomColor',
  word: '$randomWord',
  words: '$randomWords',
  sentence: '$randomPhrase',
};

/** Yaak's function calls inside `${[ … ]}` → TestPion dynamic variables. */
const YAAK: Record<string, string> = {
  'uuid.v4()': '$guid',
  'uuid.v7()': '$guid',
  'timestamp.iso8601()': '$isoTimestamp',
  'timestamp.unix()': '$timestamp',
  'timestamp.millis()': '$timestampMs',
  'random.integer()': '$randomInt',
};

export interface TemplateResult {
  text: string;
  /** Templates the mapping did not know (they stay as written). */
  unknown: string[];
}

export function normalizeThunder(s: unknown): TemplateResult {
  const unknown: string[] = [];
  const text = normalizeTemplate(s).replace(/\{\{#([A-Za-z][\w]*)([^}]*)\}\}/g, (all, name: string, args: string) => {
    const to = THUNDER[name.toLowerCase()];
    if (!to || !DYNAMIC.has(to)) {
      unknown.push(all);
      return all;
    }
    const a = args.split(',').map((x) => x.trim()).filter(Boolean);
    // {{#number, 1, 10}} is a range; {{#date, 'YYYY-MM-DD'}} has a format TestPion's variables do not take
    if (/^(number|int)$/i.test(name) && a.length === 2 && a.every((x) => /^-?\d+$/.test(x))) return `{{$randomInt(${a[0]},${a[1]})}}`;
    if (a.length) unknown.push(all);
    return `{{${to}}}`;
  });
  return { text, unknown };
}

export function normalizeYaak(s: unknown): TemplateResult {
  const unknown: string[] = [];
  const text = normalizeTemplate(s).replace(/\$\{\[\s*([\s\S]*?)\s*\]\}/g, (all, body: string) => {
    const b = body.trim();
    if (/^[A-Za-z_][\w.-]*$/.test(b)) return `{{${b}}}`;
    const to = YAAK[b.replace(/\s+/g, '')];
    if (to) return `{{${to}}}`;
    const env = /^env\.([A-Za-z_][\w.-]*)$/.exec(b);
    if (env) return `{{${env[1]}}}`;
    // random.range(min, max) of Yaak's random function plugin: a whole number between the two
    const range = /^random\.range\(\s*(-?\d+)\s*,\s*(-?\d+)\s*\)$/.exec(b);
    if (range && Number(range[1]) <= Number(range[2])) return `{{$randomInt(${range[1]},${range[2]})}}`;
    unknown.push(all);
    return all;
  });
  return { text, unknown };
}

export function normalizeHoppscotch(s: unknown): string {
  return normalizeTemplate(s).replace(/<<(\$?[\w.-]+)>>/g, '{{$1}}');
}

/**
 * The namespaces of the template functions Yaak ships itself (its own plugins: hash, encode, json, regex, file,
 * request/response/cookie readers, prompts, fake data). A function in one of them that has no TestPion variable is a Yaak
 * function with no equivalent; any other namespace is a function a plugin brought, which TestPion cannot run.
 */
const YAAK_BUILT_IN = /^\$\{\[\s*(?:hash|encode|decode|json|xml|regex|fs|os|prompt|request|response|cookie|faker|timestamp|uuid|random|base64|url)\./;

/** Unknown Yaak templates split into Yaak's own functions and plugin functions (for two plain findings). */
export function splitYaakUnknown(unknown: readonly string[]): { builtIn: string[]; plugin: string[] } {
  const builtIn: string[] = [];
  const plugin: string[] = [];
  for (const u of distinct([...unknown])) (YAAK_BUILT_IN.test(u) ? builtIn : plugin).push(u);
  return { builtIn, plugin };
}

/** The distinct templates of a list, for one finding. */
export const distinct = (list: string[]): string[] => [...new Set(list)];
