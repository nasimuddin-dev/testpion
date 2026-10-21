/** A deep copy through JSON (what a document, a request or a proposal is made of); undefined stays undefined. */
export const jsonClone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));
