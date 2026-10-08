import AjvModule, { type ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { BoundedMap } from './collections.js';

// ajv ships CJS; normalise default export under NodeNext/ESM
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule.default;
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as unknown as (a: unknown) => void;

/** One validator for every JSON Schema check: lenient (strict: false), every error reported, warnings silent. */
const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
addFormats(ajv);
// OpenAPI's own formats (numbers and strings of any content): accepted, like most validators do
for (const f of ['int32', 'int64', 'float', 'double', 'byte', 'binary', 'password']) ajv.addFormat(f, true);

/** Compiled schemas by key (the schema's JSON, a hash …): a schema is compiled once however often it is checked. */
const byKey = new BoundedMap<string, ValidateFunction>(500);
// the same schema object validates many values (a tool's arguments per call, a dataset's records): compiled once
const byObject = new WeakMap<object, ValidateFunction>();

/**
 * The validate function of a schema, compiled once per `key` (the schema's JSON when not given) and once per schema
 * object. A function builds the schema only when it is not compiled yet (it then needs a key).
 */
export function compileSchema(schema: unknown | (() => object), key?: string): ValidateFunction {
  const obj = schema && typeof schema === 'object' ? (schema as object) : undefined;
  let v = obj && byObject.get(obj);
  if (!v) {
    const k = key ?? JSON.stringify(schema);
    v = byKey.get(k);
    if (!v) {
      v = ajv.compile(typeof schema === 'function' ? (schema as () => object)() : (schema as object));
      byKey.set(k, v);
    }
    if (obj) byObject.set(obj, v);
  }
  return v;
}
