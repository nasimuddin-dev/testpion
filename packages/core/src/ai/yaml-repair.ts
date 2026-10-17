/**
 * YAML that models write, made safe before it is verified (shared by every task that answers with a test or flow file):
 *
 * - `quoteTemplateValues`: a plain YAML value cannot start with `{` — `url: {{baseUrl}}/pets` is a parse error (a flow
 *   map), the mistake models make most. Values that start with `{{` are double-quoted; quoted values, block scalars
 *   (`|`, `>`) and flow maps (`{ type: status }`) are left alone, and running it twice changes nothing.
 * - `explainYamlError`: the parser's message ("Unexpected scalar at node end at line 7, column 21") with its likely cause
 *   in plain words — an unquoted `{{`, a tab, bad indentation, a duplicate key — so a repair turn tells the model what
 *   to change instead of echoing the parser.
 */

/** `key: value` or `- value` (with an optional `- key: value`): the part before the value, and the value. */
const VALUE_LINE = /^(\s*(?:-\s+)*(?:(?:"[^"]*"|'[^']*'|[^\s#'"{}[\],][^:#]*?)\s*:\s+|-\s+))(.*)$/;
const BLOCK_START = /:\s*[|>][+-]?\d*\s*(#.*)?$/;

/** The value and a trailing comment (` # …` outside the value's braces). */
function splitComment(v: string): { value: string; comment: string } {
  let depth = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v[i]!;
    if (c === '{') depth++;
    else if (c === '}') depth = Math.max(0, depth - 1);
    else if (c === '#' && depth === 0 && /\s/.test(v[i - 1] ?? '')) return { value: v.slice(0, i).trimEnd(), comment: ` ${v.slice(i)}` };
  }
  return { value: v.trimEnd(), comment: '' };
}

/** Quote every plain value that starts with `{{` (see the module comment). */
export function quoteTemplateValues(text: string): { text: string; fixed: number } {
  const lines = text.split(/(\r?\n)/);
  let fixed = 0;
  let blockIndent = -1;
  for (let i = 0; i < lines.length; i += 2) {
    const line = lines[i]!;
    const indent = line.length - line.trimStart().length;
    // inside a block scalar: its lines are text, never touched
    if (blockIndent >= 0) {
      if (!line.trim() || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (BLOCK_START.test(line)) {
      blockIndent = indent + (/^\s*-\s/.test(line) ? 2 : 0);
      continue;
    }
    const m = VALUE_LINE.exec(line);
    if (!m || !m[2]!.startsWith('{{')) continue;
    const { value, comment } = splitComment(m[2]!);
    lines[i] = `${m[1]}"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"${comment}`;
    fixed++;
  }
  return { text: lines.join(''), fixed };
}

/** The parser's message with its likely cause in plain words (see the module comment); unknown messages are returned as they are. */
export function explainYamlError(message: string, text?: string): string {
  const lineNo = Number(/line (\d+)/i.exec(message)?.[1] ?? 0);
  const line = text && lineNo ? (text.split(/\r?\n/)[lineNo - 1] ?? '') : '';
  const why = (() => {
    if (/(:|-)\s+\{\{/.test(line) && !/(:|-)\s+["']\{\{/.test(line)) return 'a value that starts with {{ must be in double quotes in YAML (url: "{{baseUrl}}/pets", not url: {{baseUrl}}/pets)';
    if (/\t/.test(line) || /tab/i.test(message)) return 'YAML is indented with spaces only: replace the tabs with spaces';
    if (/unique|duplicate/i.test(message)) return 'a key appears twice in the same map (two `url:` or two `assertions:` in one step): keep one';
    if (/indent|same column|compact mapping|single line|Nested mappings/i.test(message))
      return 'the indentation is off: every key of a step starts at the same column, and nested keys are indented by two more spaces';
    if (/Unexpected scalar|Unexpected flow|Missing , or :|flow (map|collection)|Implicit map keys/i.test(message))
      return 'a value has a character YAML reads as syntax: quote values that contain ": ", start with {, [, *, &, !, |, >, %, @ or a backtick, or hold {{variables}}';
    return '';
  })();
  return why ? `${message} — likely cause: ${why}` : message;
}
