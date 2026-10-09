import { describe, expect, it } from 'vitest';
import { MAX_PRETTY, prettyBody, prettyMarkup } from '../../apps/desktop/src/lib/pretty.js';

// "Pretty" for a body: JSON indented, HTML and XML one element per line by nesting, everything else as it is.
describe('pretty bodies', () => {
  it('JSON is indented', () => {
    expect(prettyBody('{"a":1,"b":[true,null]}')).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
  });

  it('a minified page is laid out by nesting; short text elements stay on one line; void elements do not nest', () => {
    const html = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><title>Google</title></head><body><div id="a"><p>Hello <b>you</b></p><br><img src="x.png"></div></body></html>';
    expect(prettyMarkup(html)).toBe(
      [
        '<!doctype html>',
        '<html lang="en">',
        '  <head>',
        '    <meta charset="UTF-8">',
        '    <title>Google</title>',
        '  </head>',
        '  <body>',
        '    <div id="a">',
        '      <p>',
        '        Hello',
        '        <b>you</b>',
        '      </p>',
        '      <br>',
        '      <img src="x.png">',
        '    </div>',
        '  </body>',
        '</html>',
      ].join('\n'),
    );
  });

  it('script and style keep their content as it is, inside their element', () => {
    const html = '<head><script nonce="n">var a = "<b>";\nif (a) { go(); }</script><style>p { color: red }</style></head>';
    const out = prettyMarkup(html).split('\n');
    expect(out).toEqual(['<head>', '  <script nonce="n">', '    var a = "<b>";', '    if (a) { go(); }', '  </script>', '  <style>', '    p { color: red }', '  </style>', '</head>']);
  });

  it('XML with a declaration, comments, self-closing tags and CDATA', () => {
    const xml = '<?xml version="1.0"?><!-- pets --><pets><pet id="1"/><pet id="2"><name>Rex</name><note><![CDATA[a < b]]></note></pet></pets>';
    expect(prettyBody(xml, 'application/xml')).toBe(
      ['<?xml version="1.0"?>', '<!-- pets -->', '<pets>', '  <pet id="1"/>', '  <pet id="2">', '    <name>Rex</name>', '    <note>', '      <![CDATA[a < b]]>', '    </note>', '  </pet>', '</pets>'].join('\n'),
    );
  });

  it('plain text, broken JSON and texts past the limit come back unchanged', () => {
    expect(prettyBody('just words')).toBe('just words');
    expect(prettyBody('{"a": ')).toBe('{"a": ');
    const big = '<a>' + 'x'.repeat(MAX_PRETTY) + '</a>';
    expect(prettyBody(big)).toBe(big);
  });
});
