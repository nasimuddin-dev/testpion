/** A row of a key/value table: a header, a query parameter, a form field, a variable. */
export interface KeyValue {
  key: string;
  value: string;
  enabled?: boolean;
  description?: string;
}
