import { BoundedMap } from '../util/collections.js';

/**
 * Documents that were assembled as objects (a picked Bruno, Yaak or Postman v3 folder) and then written as one text for the importer, which
 * parsed it again. `handOff` keeps the object under its text for the importer, which `takeParsed`s it instead of parsing (and the
 * format check only looks, `peekParsed`). Taking removes the entry: nobody else holds the object the importer then changes. Few and short-lived.
 */
const handedOff = new BoundedMap<string, unknown>(3);
/** An object nobody took (a format check of a file that was never imported) is let go after this long. */
const KEEP_MS = 20_000;
let expiry: ReturnType<typeof setTimeout> | undefined; // bounded: one timer that empties the 3-entry map

/** `text` is `JSON.stringify(value)`: the next reader of exactly that text gets the object. */
export function handOff(text: string, value: unknown): string {
  handedOff.set(text, value);
  clearTimeout(expiry);
  expiry = setTimeout(() => handedOff.clear(), KEEP_MS);
  expiry.unref?.();
  return text;
}

/** The parsed JSON of `text`: the object it was assembled from when handed off (once), else a parse. */
export function takeParsed<T = any>(text: string): T {
  if (handedOff.has(text)) {
    const v = handedOff.get(text);
    handedOff.delete(text);
    return v as T;
  }
  return JSON.parse(text) as T;
}

/** The handed-off object for `text`, left in place (for a read-only look); undefined when there is none. */
export function peekParsed(text: string): unknown {
  return handedOff.get(text);
}
