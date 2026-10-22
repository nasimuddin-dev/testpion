import { describe, it, expect } from 'vitest';
import { renderVisualizer, runScript } from '../../packages/core/src/index.js';

const response = { status: 200, headers: [['content-type', 'application/json']] as Array<[string, string]>, body: JSON.stringify([{ name: 'Rex', species: 'dog' }, { name: 'Tom', species: 'cat' }]), time: 12 };

describe('pm.visualizer (Postman Visualizer)', () => {
  it('records the template and data from a test script', async () => {
    const out = await runScript(
      `const template = '<table>{{#each rows}}<tr><td>{{name}}</td><td>{{species}}</td></tr>{{/each}}</table>';
       pm.visualizer.set(template, { rows: pm.response.json() });`,
      { variables: {}, response },
    );
    expect(out.error).toBeUndefined();
    expect(out.visualizer?.template).toContain('{{#each rows}}');
    expect(out.visualizer?.data).toEqual({ rows: [{ name: 'Rex', species: 'dog' }, { name: 'Tom', species: 'cat' }] });
    const r = await renderVisualizer(out.visualizer!.template, out.visualizer!.data);
    expect(r.error).toBeUndefined();
    expect(r.html).toBe('<table><tr><td>Rex</td><td>dog</td></tr><tr><td>Tom</td><td>cat</td></tr></table>');
  });

  it('clear() and not calling it are different', async () => {
    expect((await runScript(`pm.visualizer.set('<b>x</b>'); pm.visualizer.clear();`, { variables: {}, response })).visualizer).toBeNull();
    expect((await runScript(`pm.test('ok', () => {});`, { variables: {}, response })).visualizer).toBeUndefined();
    const fn = await runScript(`pm.visualizer.set('<b>{{x}}</b>', { x: 1, f: function () {} });`, { variables: {}, response });
    expect(fn.visualizer?.data).toEqual({ x: 1 });
  });

  it('escapes {{values}}, blocks prototype access and keeps renders isolated', async () => {
    expect((await renderVisualizer('<p>{{v}}</p>', { v: '<img src=x onerror=alert(1)>' })).html).toBe('<p>&lt;img src&#x3D;x onerror&#x3D;alert(1)&gt;</p>');
    expect((await renderVisualizer('{{constructor.name}}|{{__proto__}}', {})).html).toBe('|');
    expect((await renderVisualizer('{{json v}}', { v: { a: 1 } })).html).toBe('{\n  &quot;a&quot;: 1\n}');
    expect((await renderVisualizer('{{#each}}', {})).error).toMatch(/Visualizer template error/);
  });
});
