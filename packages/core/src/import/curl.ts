import type { AuthConfig, BodyConfig, HttpRequestSpec, KeyValue } from '../model/types.js';
import { ApsError } from '../errors.js';

/**
 * Split a shell command line into arguments. Handles single/double quotes, backslash escapes,
 * line continuations (`\` + newline for bash, `^` + newline for cmd, backtick for PowerShell)
 * and ANSI-C `$'…'` strings as produced by browser "Copy as cURL".
 */
export function shellSplit(input: string): string[] {
  const s = input.replace(/\\\r?\n|\^\r?\n|`\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
    } else if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      const ansi = c === '$';
      i += ansi ? 2 : 1;
      while (i < s.length && s[i] !== "'") {
        if (ansi && s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1]!;
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          i += 2;
        } else cur += s[i++];
      }
      i++;
      has = true;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length && /["\\$`]/.test(s[i + 1]!)) i++;
        cur += s[i++];
      }
      i++;
      has = true;
    } else if (c === '\\' && i + 1 < s.length) {
      cur += s[i + 1];
      i += 2;
      has = true;
    } else {
      cur += c;
      i++;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function isCurlCommand(text: string): boolean {
  return /^\s*curl(\.exe)?\s/i.test(text);
}

/**
 * Undo cmd.exe caret escaping as produced by Chrome's "Copy as cURL (cmd)": `^"` quotes, `^X`
 * escaped characters, `^` + newline continuations and `^` + blank line for newlines inside strings.
 */
function unescapeCmd(input: string): string {
  return input
    .replace(/\^\r?\n\r?\n/g, '\u0000')
    .replace(/\^\r?\n/g, ' ')
    .replace(/\^(.)/g, '$1')
    .replace(/\u0000/g, '\n');
}

/** Parse a `curl` command (e.g. from browser devtools "Copy as cURL", bash or cmd) into a request. */
export function parseCurl(command: string): HttpRequestSpec {
  const text = command.trim();
  const args = shellSplit(/\^"/.test(text) ? unescapeCmd(text) : text);
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0]!)) throw new ApsError('ValidationError', 'Not a curl command');
  return parseCurlArgs(args);
}

/** Build a request from curl-style arguments (`args[0]` is the program name). */
export function parseCurlArgs(args: string[]): HttpRequestSpec {
  let method: string | undefined;
  let url = '';
  const headers: KeyValue[] = [];
  const data: string[] = [];
  const urlencoded: string[] = [];
  const form: Array<KeyValue & { kind?: 'text' | 'file' }> = [];
  let json = false;
  let get = false;
  let auth: AuthConfig | undefined;
  let digest = false;
  let sigv4: string | undefined;
  const cookies: KeyValue[] = [];
  const settings: HttpRequestSpec['settings'] = {};
  const next = (i: number) => {
    if (i + 1 >= args.length) throw new ApsError('ValidationError', `Missing value for ${args[i]}`);
    return args[i + 1]!;
  };
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    // --flag=value form
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : undefined;
    const val = () => (inline !== undefined ? inline : next(i++));
    switch (flag) {
      case '-X':
      case '--request':
        method = val().toUpperCase();
        break;
      case '-H':
      case '--header': {
        const h = val();
        const c = h.indexOf(':');
        if (c > 0) {
          const key = h.slice(0, c).trim();
          const value = h.slice(c + 1).trim();
          if (/^cookie$/i.test(key)) for (const part of value.split(/;\s*/)) {
            const e = part.indexOf('=');
            if (e > 0) cookies.push({ key: part.slice(0, e), value: part.slice(e + 1) });
          }
          else headers.push({ key, value });
        }
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary':
      case '--data-ascii':
        data.push(val().replace(/^@/, '@'));
        break;
      case '--data-urlencode':
        urlencoded.push(val());
        break;
      case '--json':
        data.push(val());
        json = true;
        break;
      case '-F':
      case '--form':
      case '--form-string': {
        const f = val();
        const e = f.indexOf('=');
        const key = f.slice(0, e);
        const v = f.slice(e + 1);
        form.push(v.startsWith('@') && flag !== '--form-string' ? { key, value: v.slice(1).replace(/;type=.*$/, ''), kind: 'file' } : { key, value: v, kind: 'text' });
        break;
      }
      case '-u':
      case '--user': {
        const u = val();
        const c = u.indexOf(':');
        auth = { type: 'basic', username: c >= 0 ? u.slice(0, c) : u, password: c >= 0 ? u.slice(c + 1) : '' };
        break;
      }
      case '--digest':
        digest = true;
        break;
      case '--basic':
        break;
      case '--aws-sigv4':
        // "aws:amz:<region>:<service>"
        sigv4 = val();
        break;
      case '-b':
      case '--cookie':
        for (const part of val().split(/;\s*/)) {
          const e = part.indexOf('=');
          if (e > 0) cookies.push({ key: part.slice(0, e), value: part.slice(e + 1) });
        }
        break;
      case '-A':
      case '--user-agent':
        headers.push({ key: 'User-Agent', value: val() });
        break;
      case '-e':
      case '--referer':
        headers.push({ key: 'Referer', value: val() });
        break;
      case '-G':
      case '--get':
        get = true;
        break;
      case '-I':
      case '--head':
        method = 'HEAD';
        break;
      case '-k':
      case '--insecure':
        settings.insecure = true;
        break;
      case '-L':
      case '--location':
        settings.followRedirects = true;
        break;
      case '--url':
        url = val();
        break;
      case '-x':
      case '--proxy':
        settings.proxy = val();
        break;
      case '-m':
      case '--max-time':
        settings.timeoutMs = Number(val()) * 1000;
        break;
      // flags that take a value we ignore
      case '-o':
      case '--output':
      case '-w':
      case '--write-out':
      case '--connect-timeout':
      case '--retry':
      case '-c':
      case '--cookie-jar':
      case '--cacert':
      case '--cert':
      case '--key':
        val();
        break;
      default:
        if (!a.startsWith('-') && !url) url = a;
      // other boolean flags (--compressed, -s, -v, -i …) are ignored
    }
  }
  if (!url) throw new ApsError('ValidationError', 'No URL found in the curl command');
  if (json) {
    if (!headers.some((h) => /^content-type$/i.test(h.key))) headers.push({ key: 'Content-Type', value: 'application/json' });
    if (!headers.some((h) => /^accept$/i.test(h.key))) headers.push({ key: 'Accept', value: 'application/json' });
  }

  // split query string into params
  let base = url;
  const params: KeyValue[] = [];
  const q = url.indexOf('?');
  if (q >= 0) {
    base = url.slice(0, q);
    for (const part of url.slice(q + 1).split('&')) {
      if (!part) continue;
      const e = part.indexOf('=');
      const dec = (x: string) => {
        try {
          return decodeURIComponent(x.replace(/\+/g, ' '));
        } catch {
          return x;
        }
      };
      params.push({ key: dec(e >= 0 ? part.slice(0, e) : part), value: dec(e >= 0 ? part.slice(e + 1) : '') });
    }
  }

  let body: BodyConfig | undefined;
  if (get) {
    for (const d of [...data, ...urlencoded]) for (const part of d.split('&')) {
      const e = part.indexOf('=');
      params.push({ key: e >= 0 ? part.slice(0, e) : part, value: e >= 0 ? part.slice(e + 1) : '' });
    }
  } else if (form.length) body = { type: 'multipart', fields: form };
  else if (urlencoded.length && !data.length)
    body = {
      type: 'form-urlencoded',
      fields: urlencoded.map((u) => {
        const e = u.indexOf('=');
        return { key: e >= 0 ? u.slice(0, e) : u, value: e >= 0 ? u.slice(e + 1) : '' };
      }),
    };
  else if (data.length) {
    const raw = data.join('&');
    const ct = headers.find((h) => /^content-type$/i.test(h.key))?.value ?? '';
    if (/json/i.test(ct) || (!ct && /^\s*[{[]/.test(raw))) body = { type: 'json', content: prettyMaybe(raw) };
    else if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(raw)))
      body = {
        type: 'form-urlencoded',
        fields: raw.split('&').map((p) => {
          const e = p.indexOf('=');
          const dec = (x: string) => {
            try {
              return decodeURIComponent(x.replace(/\+/g, ' '));
            } catch {
              return x;
            }
          };
          return { key: dec(e >= 0 ? p.slice(0, e) : p), value: dec(e >= 0 ? p.slice(e + 1) : '') };
        }),
      };
    else if (/xml/i.test(ct)) body = { type: 'xml', content: raw };
    else body = { type: 'text', content: raw };
    // form bodies set their own content type
    if (body.type === 'form-urlencoded') {
      const i = headers.findIndex((h) => /^content-type$/i.test(h.key));
      if (i >= 0) headers.splice(i, 1);
    }
  }
  // -u with --digest / --aws-sigv4 is Digest or AWS Signature auth, not Basic
  if (auth?.type === 'basic' && digest) auth = { type: 'digest', username: auth.username, password: auth.password };
  if (auth?.type === 'basic' && sigv4) {
    const [, , region = '', service = ''] = sigv4.split(':');
    const session = headers.findIndex((h) => /^x-amz-security-token$/i.test(h.key));
    auth = { type: 'awsv4', accessKey: auth.username, secretKey: auth.password, region, service, ...(session >= 0 ? { sessionToken: headers[session]!.value } : {}) };
    if (session >= 0) headers.splice(session, 1);
  }
  const bearer = headers.findIndex((h) => /^authorization$/i.test(h.key) && /^bearer\s/i.test(h.value));
  if (bearer >= 0 && !auth) {
    auth = { type: 'bearer', token: headers[bearer]!.value.replace(/^bearer\s+/i, '') };
    headers.splice(bearer, 1);
  }
  return {
    method: method ?? (body ? 'POST' : 'GET'),
    url: base,
    params,
    headers,
    cookies: cookies.length ? cookies : undefined,
    auth: auth ?? { type: 'none' },
    body: body ?? { type: 'none' },
    settings: Object.keys(settings).length ? settings : undefined,
  };
}

function prettyMaybe(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
