/** Small guards every host shares (the window, the engine, the CLI). */

/** A plain JSON-like object: not null, not an array. */
export const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A string as a literal for a RegExp source: every special character escaped. */
export const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
