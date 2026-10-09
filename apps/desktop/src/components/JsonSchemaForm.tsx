import { Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Textarea } from './ui';

type Schema = {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  enum?: unknown[];
  description?: string;
  default?: unknown;
  title?: string;
  format?: string;
  anyOf?: Schema[];
  oneOf?: Schema[];
};

function typeOf(s: Schema): string {
  if (s.enum) return 'enum';
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t) return t;
  if (s.properties) return 'object';
  if (s.anyOf || s.oneOf) return typeOf((s.anyOf ?? s.oneOf)![0]!);
  return 'string';
}

/** Generates an input form from a JSON Schema (MCP tool input schemas). Falls back to raw JSON for complex shapes. */
export function JsonSchemaForm({ schema, value, onChange }: { schema: Schema; value: Record<string, unknown>; onChange(v: Record<string, unknown>): void }) {
  const props = schema.properties ?? {};
  if (!Object.keys(props).length) return <div className="text-sm text-muted p-3">This tool takes no arguments.</div>;
  return (
    <div className="p-3 flex flex-col gap-3">
      {Object.entries(props).map(([k, s]) => (
        <SchemaField key={k} name={k} schema={s} required={schema.required?.includes(k)} value={value[k]} onChange={(v) => onChange(v === undefined ? omit(value, k) : { ...value, [k]: v })} />
      ))}
    </div>
  );
}

function omit(o: Record<string, unknown>, k: string) {
  const { [k]: _, ...rest } = o;
  return rest;
}

function SchemaField({ name, schema, required, value, onChange }: { name: string; schema: Schema; required?: boolean; value: unknown; onChange(v: unknown): void }) {
  const t = typeOf(schema);
  const label = (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="mono font-medium">{name}</span>
      {required && <span className="text-bad">required</span>}
      <span className="text-muted">{t}{schema.format ? ` · ${schema.format}` : ''}</span>
    </div>
  );
  let input: React.ReactNode;
  if (t === 'enum')
    input = (
      <select className="field" value={value === undefined ? '' : JSON.stringify(value)} onChange={(e) => onChange(e.target.value ? JSON.parse(e.target.value) : undefined)}>
        <option value="">—</option>
        {schema.enum!.map((v) => (
          <option key={JSON.stringify(v)} value={JSON.stringify(v)}>
            {String(v)}
          </option>
        ))}
      </select>
    );
  else if (t === 'boolean')
    input = (
      <select className="field w-32" value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  else if (t === 'number' || t === 'integer')
    input = <input className="field w-48" type="number" step={t === 'integer' ? 1 : 'any'} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />;
  else if (t === 'array' && schema.items && ['string', 'number', 'integer'].includes(typeOf(schema.items))) {
    const arr = (Array.isArray(value) ? value : []) as unknown[];
    input = (
      <div className="flex flex-col gap-1">
        {arr.map((v, i) => (
          <div key={i} className="flex gap-1">
            <input className="field flex-1" value={String(v)} onChange={(e) => onChange(arr.map((x, j) => (j === i ? (typeOf(schema.items!) === 'string' ? e.target.value : Number(e.target.value)) : x)))} />
            <IconButton label="Remove" onClick={() => onChange(arr.filter((_, j) => j !== i))}>
              <Trash2 size={13} />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus size={12} />} onClick={() => onChange([...arr, typeOf(schema.items!) === 'string' ? '' : 0])}>
            Add item
          </Button>
        </div>
      </div>
    );
  } else if (t === 'object' || t === 'array')
    input = (
      <Textarea
        className="field mono min-h-20 text-xs"
        placeholder={t === 'object' ? '{ }' : '[ ]'}
        defaultValue={value === undefined ? '' : JSON.stringify(value, null, 2)}
        onBlur={(e) => {
          try {
            onChange(e.target.value.trim() ? JSON.parse(e.target.value) : undefined);
          } catch {
            /* keep */
          }
        }}
      />
    );
  else input = <input className="field mono" value={value === undefined ? '' : String(value)} placeholder={schema.default !== undefined ? `default: ${schema.default}` : ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)} />;
  return (
    <label className="flex flex-col gap-1">
      {label}
      {input}
      {schema.description && <span className="text-xs text-muted">{schema.description}</span>}
    </label>
  );
}
