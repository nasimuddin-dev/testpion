import type { NormalizedError } from '../api';

/** The workspace folders whose files an error can name (a file of the workspace the person can open in their file manager). */
const FOLDERS = 'collections|environments|tests|datasets|specs|mocks|debugger|baselines|exports|runs|reports|\\.local';
const RELATIVE = new RegExp(`(?:^|[\\s"'(\\[])((?:${FOLDERS})/[^\\s"'<>|?*:()\\[\\]]+\\.[A-Za-z0-9]{1,8})`);
const TAIL = /^[^\s"'<>|?*:]+\.[A-Za-z0-9]{1,8}/;

const norm = (p: string) => p.replace(/\\/g, '/');

/**
 * The file of the workspace an error is about, as a path inside it (`collections/shop.json`), or undefined: from the error's
 * details (`file`, `path`) or from a path in its text, absolute (under the open workspace) or relative. The backend checks that
 * the file is there before showing it.
 */
export function fileInError(err: Pick<NormalizedError, 'message' | 'why' | 'details'>, root: string | undefined): string | undefined {
  const base = root ? norm(root).replace(/\/$/, '') : undefined;
  const inside = (p: string): string | undefined => {
    const abs = norm(p);
    if (base && abs.toLowerCase().startsWith(base.toLowerCase() + '/')) return abs.slice(base.length + 1);
    return /^[A-Za-z]:\/|^\//.test(abs) ? undefined : abs.replace(/^\.\//, '');
  };
  for (const key of ['file', 'path']) {
    const v = err.details?.[key];
    if (typeof v === 'string' && v) {
      const rel = inside(v);
      if (rel && !rel.startsWith('..')) return rel;
    }
  }
  const text = norm(`${err.message} ${err.why ?? ''}`);
  if (base) {
    const at = text.toLowerCase().indexOf(base.toLowerCase() + '/');
    if (at >= 0) {
      const tail = TAIL.exec(text.slice(at + base.length + 1));
      if (tail) return tail[0];
    }
  }
  return RELATIVE.exec(text)?.[1];
}
