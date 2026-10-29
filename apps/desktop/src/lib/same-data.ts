/** The text of a value with the keys of every object in order, so two values hold "the same data" whatever order their keys came in. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : p > q ? 1 : 0))) : x));

/**
 * Whether two values hold the same data, whatever order their object keys are in: a saved item is written in its stable order and a
 * draft in the editor keeps the order it was made in, so comparing their text would call an untouched item changed.
 */
export const sameData = (a: unknown, b: unknown): boolean => canon(a) === canon(b);
