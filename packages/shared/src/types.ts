import type { VariableType } from './variable-types.js';

/** A row of a key/value table: a header, a query parameter, a form field, a variable. */
export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
  /** A variable's type (variable-types.ts): number, boolean or JSON instead of text. Only variables have one. */
  valueType?: VariableType;
}
