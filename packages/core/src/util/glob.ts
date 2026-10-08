import { escapeRegex } from './redact.js';

/**
 * A glob as a case-insensitive RegExp matching the whole string: `*` matches any run and `?` one character.
 * With `segments` the glob is a path: `*` and `?` stop at a separator (`/` or `\`, which match each other) and
 * `**` crosses directories (`src/**\/*.yaml`). With `question: false` a `?` is literal (model names, prices).
 */
export function globToRegex(glob: string, opts: { segments?: boolean; question?: boolean } = {}): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (opts.segments && glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/' || glob[i + 1] === '\\') i++;
      } else re += opts.segments ? '[^/\\\\]*' : '.*';
    } else if (c === '?' && opts.question !== false) re += opts.segments ? '[^/\\\\]' : '.';
    else if (opts.segments && (c === '/' || c === '\\')) re += '[/\\\\]';
    else re += escapeRegex(c);
  }
  return new RegExp(`^${re}$`, 'i');
}
