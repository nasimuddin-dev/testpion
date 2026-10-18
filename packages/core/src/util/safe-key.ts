/**
 * Whether a key of an object that came from outside (an import, a bundle, a hand-edited file) can be copied onto a
 * plain object by assignment. `__proto__` set by `out[k] = v` changes the copy's prototype instead of adding a
 * property, and `constructor` / `prototype` are what code that walks an object by its keys trips over next: the
 * copy-on-write helpers skip them (such a key never holds a value anyone meant to keep).
 */
export const safeKey = (k: string): boolean => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
