// A-4, A-5 · Prompt versions: the offline sample is run (10 of 10), its prompt is saved as the version "Original" with the result of
// the run made with it beside it; a second version that was never run is added, and "Make current" on it asks first and says
// why ("has not been run"); confirming makes it the prompt, and the list shows which version is in use.
// Offline: the demo model only; no key is used.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const steps = [
  step(
    'the-sample-is-run',
    `await __t.view('AI Lab'); await __t.sleep(1200);
     await __t.real.click(vis('[data-start-sample]')[0]);
     const head = await __t.waitFor(() => vis('[data-eval-headline-text]').find((h) => /\\d+ of \\d+ passed/.test(h.textContent)), 60000);
     return 'headline: ' + (head ? head.textContent.trim() : 'NONE');`,
  ),
  step(
    'versions-start-empty-and-the-prompt-is-not-a-version',
    `const t = tab('Prompt'); if (!t) return 'NO TAB Prompt';
     await __t.real.click(t); await __t.sleep(800);
     const bar = await __t.waitFor(() => document.querySelector('[data-prompt-versions]'), 5000); if (!bar) return 'NO BAR';
     await __t.real.click(bar.querySelector('summary')); await __t.sleep(600);
     return 'summary: ' + bar.querySelector('[data-version-summary]')?.textContent.trim() + ' | save enabled: ' + !bar.querySelector('[data-version-save]').disabled;`,
  ),
  step(
    'save-the-prompt-as-a-version',
    `await __t.real.click(document.querySelector('[data-version-save]'));
     const box = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] input')].find((i) => i.offsetParent), 4000); if (!box) return 'NO NAME BOX';
     await __t.real.click(box); await __t.real.type('Original'); await __t.sleep(200);
     const ok = [...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Save version'); if (!ok) return 'NO BUTTON';
     await __t.real.click(ok);
     const row = await __t.waitFor(() => document.querySelector('[data-version="Original"] [data-version-result]'), 8000); if (!row) return 'NO ROW';
     const r = document.querySelector('[data-version="Original"]');
     return 'result: ' + row.textContent.trim() + ' | in use: ' + (r.getAttribute('data-version-current') === 'true') + ' | save disabled again: ' + document.querySelector('[data-version-save]').disabled;`,
  ),
  // a second version that was never run, added to the saved evaluation as another editor would write it
  step(
    'another-version-that-was-never-run',
    `const lib = await window.aps.invoke('lib.get', { kind: 'evaluations' });
     const item = lib.items.find((i) => i.name === 'Sample: support intents');
     // the id is the hash of the prompt and the system prompt, as the engine writes it
     const sys = (item.data.system ?? '').trim();
     const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('Classify: {{input}}' + String.fromCharCode(0) + sys)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
     const versions = [...(item.data.promptVersions ?? []), { id: hex, name: 'Shorter', prompt: 'Classify: {{input}}', at: new Date().toISOString(), note: 'a shorter wording' }];
     await window.aps.invoke('lib.save', { kind: 'evaluations', library: { ...lib, items: lib.items.map((i) => (i.id === item.id ? { ...i, data: { ...i.data, promptVersions: versions } } : i)) } });
     const row = await __t.waitFor(() => document.querySelector('[data-version="Shorter"]'), 8000); if (!row) return 'NO ROW';
     return 'result: ' + row.querySelector('[data-version-result]').textContent.trim() + ' | make current offered: ' + !!row.querySelector('[data-version-use]');`,
  ),
  // what a version changes against the prompt in use, word by word
  step(
    'changes-are-shown-word-by-word',
    `await __t.real.click(document.querySelector('[data-version-changes="Shorter"]'));
     const panel = await __t.waitFor(() => { const p = document.querySelector('[data-version-diff="Shorter"]'); return p && p.querySelector('[data-diff-segment]') ? p : null; }, 6000); if (!panel) return 'NO DIFF';
     const kinds = [...new Set([...panel.querySelectorAll('[data-diff-segment]')].map((x) => x.getAttribute('data-diff-segment')))].sort().join(',');
     const sentence = panel.querySelector('p')?.textContent.trim();
     await __t.real.click(document.querySelector('[data-version-changes="Shorter"]')); await __t.sleep(300);
     return 'sentence: ' + /^Shorter to the prompt in use\\. Prompt: (Added|Removed) \\d+ words?/.test(sentence ?? '') + ' | segments: ' + kinds + ' | closed again: ' + !document.querySelector('[data-version-diff]');`,
  ),
  step(
    'making-it-current-asks-first-and-says-why',
    `await __t.real.click(document.querySelector('[data-version-use="Shorter"]'));
     const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog], [role=alertdialog]')].find((d) => /has not been run/.test(d.textContent)), 6000); if (!dlg) return 'NO DIALOG';
     const text = dlg.textContent.replace(/\\s+/g, ' ').trim();
     const yes = [...dlg.querySelectorAll('button')].find((b) => /Make it current anyway/.test(b.textContent)); if (!yes) return 'NO CONFIRM BUTTON';
     const asked = /has not been run: nothing says how it does/.test(text);
     await __t.real.click(yes); await __t.sleep(1200);
     const saved = (await window.aps.invoke('lib.get', { kind: 'evaluations' })).items.find((i) => i.name === 'Sample: support intents');
     return 'asked: ' + asked + ' | prompt now: ' + saved.data.prompt + ' | in use: ' + document.querySelector('[data-version-current=true]')?.getAttribute('data-version');`,
  ),
];

module.exports = withExpect(steps, {
  'the-sample-is-run': /^headline: 10 of 10 passed$/,
  'versions-start-empty-and-the-prompt-is-not-a-version': /^summary: none saved yet \| save enabled: true$/,
  'save-the-prompt-as-a-version': /^result: 10 of 10 passed \(100%\) \| in use: true \| save disabled again: true$/,
  'another-version-that-was-never-run': /^result: not run yet \| make current offered: true$/,
  'changes-are-shown-word-by-word': /^sentence: true \| segments: (add,same|add,del,same|add,del) \| closed again: true$/,
  'making-it-current-asks-first-and-says-why': /^asked: true \| prompt now: Classify: \{\{input\}\} \| in use: Shorter$/,
});
