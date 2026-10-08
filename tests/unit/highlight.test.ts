import { describe, expect, it } from 'vitest';
import { detectLanguage, highlight, MAX_CHARS, type Token } from '../../apps/desktop/src/lib/highlight.js';

// Syntax colours for read-only code: the language is detected, the text is cut into tokens of the editor theme's
// kinds, and joining the tokens gives the text back unchanged.
const kinds = (tokens: Token[]) => tokens.filter((t) => t.kind).map((t) => `${t.kind}:${t.text.trim()}`);
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join('');

describe('detecting the language', () => {
  it('JSON, XML, raw HTTP, YAML and plain text', () => {
    expect(detectLanguage('  {"a": 1}')).toBe('json');
    expect(detectLanguage('[1, 2]')).toBe('json');
    expect(detectLanguage('<note><to>x</to></note>')).toBe('xml');
    expect(detectLanguage('GET https://api.example.com/users HTTP/1.1\nAccept: */*')).toBe('http');
    expect(detectLanguage('HTTP/1.1 200 OK\nContent-Type: text/plain')).toBe('http');
    expect(detectLanguage('name: CI\non:\n  push:\n    branches: [main]\n')).toBe('yaml');
    expect(detectLanguage('Hello world, this is a sentence.')).toBe('plain');
    expect(detectLanguage('')).toBe('plain');
  });
});

describe('tokens', () => {
  it('JSON: keys, strings, numbers, keywords', () => {
    const text = '{"name": "Rex", "age": 3, "ok": true, "tag": null}';
    const t = highlight(text);
    expect(joined(t)).toBe(text);
    expect(kinds(t)).toEqual(expect.arrayContaining(['key:"name"', 'string:"Rex"', 'number:3', 'keyword:true', 'keyword:null']));
  });

  it('YAML: keys, values by kind, comments, list items', () => {
    const text = 'name: CI # the workflow\nretries: 2\nenabled: true\nsteps:\n  - run: npm test\n  - "quoted"';
    const t = highlight(text);
    expect(joined(t)).toBe(text);
    expect(kinds(t)).toEqual(expect.arrayContaining(['key:name', 'string:CI', 'comment:# the workflow', 'number:2', 'keyword:true', 'key:run', 'string:"quoted"']));
  });

  it('XML: tags, attributes and their values, comments', () => {
    const text = '<!-- a --><pet id="7"><name>Rex</name></pet>';
    const t = highlight(text);
    expect(joined(t)).toBe(text);
    expect(kinds(t)).toEqual(expect.arrayContaining(['comment:<!-- a -->', 'tag:<pet', 'attr:id', 'string:"7"', 'tag:</name']));
  });

  it('raw HTTP: the method, the URL, header names, and the body in its own language', () => {
    const text = 'POST https://api.example.com/pets HTTP/1.1\nContent-Type: application/json\n\n{"name": "Rex"}';
    const t = highlight(text);
    expect(joined(t)).toBe(text);
    expect(kinds(t)).toEqual(expect.arrayContaining(['method:POST', 'string:https://api.example.com/pets', 'key:Content-Type', 'key:"name"', 'string:"Rex"']));
  });

  it('plain text, and a text too long to colour, come back as one plain token', () => {
    expect(highlight('just words')).toEqual([{ text: 'just words' }]);
    const big = '{"a": "' + 'x'.repeat(MAX_CHARS) + '"}';
    expect(highlight(big)).toEqual([{ text: big }]);
  });
});
