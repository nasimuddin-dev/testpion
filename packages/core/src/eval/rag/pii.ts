/**
 * Finding personal data in an answer without a model (planning/rag-testing.md §2.3 8.3, "ner-light"): e-mail addresses,
 * phone numbers, US social security numbers, payment card numbers (Luhn-checked), IBANs (mod-97 checked) and, when asked,
 * public IPv4 addresses. A finding is reported by its kind and a MASKED form (first and last two characters), so the personal
 * data an answer leaked is never copied into a result or a log. Checksums keep order numbers and dates from being flagged.
 */
export type PiiKind = 'email' | 'phone' | 'ssn' | 'card' | 'iban' | 'ip';

export interface PiiFinding {
  kind: PiiKind;
  /** The match with its middle hidden: `jo****om`. */
  masked: string;
}

export const ALL_PII_KINDS: readonly PiiKind[] = ['email', 'phone', 'ssn', 'card', 'iban', 'ip'];
/** What is looked for unless the check names kinds (an IP address is not personal data by itself, so it is opt-in). */
export const DEFAULT_PII_KINDS: readonly PiiKind[] = ['email', 'phone', 'ssn', 'card', 'iban'];

const mask = (s: string) => (s.length <= 4 ? '****' : `${s.slice(0, 2)}${'*'.repeat(Math.min(8, s.length - 4))}${s.slice(-2)}`);

function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

function ibanOk(iban: string): boolean {
  const s = iban.replace(/\s/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

const isPrivateIp = (ip: string) => /^(10\.|127\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

/** Personal data in `text`; the same value is reported once. `allow` lists values that may appear (the business's public phone number). */
export function findPii(text: string, kinds: readonly PiiKind[] = DEFAULT_PII_KINDS, allow: readonly string[] = []): PiiFinding[] {
  const out: PiiFinding[] = [];
  const seen = new Set<string>();
  const allowed = allow.map((a) => a.replace(/\s/g, '').toLowerCase());
  const add = (kind: PiiKind, value: string) => {
    const norm = value.replace(/[\s.-]/g, '').toLowerCase();
    if (!kinds.includes(kind) || seen.has(`${kind}:${norm}`) || allowed.some((a) => norm.includes(a.replace(/[\s.-]/g, '')))) return;
    seen.add(`${kind}:${norm}`);
    out.push({ kind, masked: mask(value.trim()) });
  };
  const used: Array<[number, number]> = [];
  const overlaps = (a: number, b: number) => used.some(([s, e]) => a < e && b > s);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    add('email', m[0]);
    used.push([m.index!, m.index! + m[0].length]);
  }
  // an IBAN-shaped string is never also a phone number, whether or not its checksum holds
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b/g)) {
    if (ibanOk(m[0])) add('iban', m[0]);
    used.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(/(?<!\d)(?:\d[ -]?){13,19}(?!\d)/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      add('card', m[0]);
      used.push([m.index!, m.index! + m[0].length]);
    }
  }
  for (const m of text.matchAll(/(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g)) {
    const [, a, g, s] = m;
    if (a !== '000' && a !== '666' && !a!.startsWith('9') && g !== '00' && s !== '0000') add('ssn', m[0]);
    // shaped like an SSN, valid or not: never also a phone number
    used.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(/(?<![\w.])\+?\(?\d[\d\s().-]{7,18}\d(?!\w)/g)) {
    if (overlaps(m.index!, m.index! + m[0].length)) continue;
    const digits = m[0].replace(/\D/g, '');
    // a date, a version, a price or a plain number is not a phone number: it needs 9 to 15 digits and a phone-like shape
    if (digits.length < 9 || digits.length > 15 || /^\d{4}-\d{2}-\d{2}/.test(m[0]) || !(/^\+/.test(m[0]) || /[\s().-]/.test(m[0]))) continue;
    add('phone', m[0]);
  }
  for (const m of text.matchAll(/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/g)) if (!isPrivateIp(m[0])) add('ip', m[0]);
  return out;
}
