// Screenshot steps for the documentation website. Loaded by the main process in capture mode (scripts/capture.cjs).
// Drives the real UI (demo servers + a throwaway copy of the example workspace, its own profile) and writes JPEGs to
// docs/public/images/. Every step waits for what it needs on screen (an element, a text, a finished run): no fixed
// delays as synchronisation. A step that cannot get there fails the whole run with what was on screen, so a broken
// step never leaves a wrong screenshot behind.
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join } = require('node:path');

const OUT = process.env.TESTPION_CAPTURE_DIR;
const W = 1440;
const H = 900;
const J = JSON.stringify;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Helpers injected into the page: visible elements only (views stay mounted while hidden), text, React inputs. */
const HELPERS = `
window.__cap = {
  shown(e) {
    return !!e && e.getClientRects().length > 0 && e.checkVisibility({ visibilityProperty: true });
  },
  all(sel, root = document) {
    return [...root.querySelectorAll(sel)].filter((e) => this.shown(e));
  },
  one(sel) {
    return this.all(sel)[0];
  },
  text(e) {
    return (e?.textContent ?? '').replace(/\\s+/g, ' ').trim();
  },
  /** A visible control whose text is \`text\` (or starts with it), or whose aria-label is. */
  byText(text, sel = 'button, [role=tab], [role=radio], [role=menuitem], [role=option], a') {
    const els = this.all(sel);
    return els.find((e) => this.text(e) === text || e.getAttribute('aria-label') === text) ?? els.find((e) => this.text(e).startsWith(text));
  },
  /** The text on screen: main (or the whole page), whitespace folded. */
  screen(sel = 'main') {
    return (document.querySelector(sel) ?? document.body).innerText.replace(/\\s+/g, ' ');
  },
  input(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  },
  /** A key pressed where the focus is (it bubbles to the window's shortcuts). */
  key(key, opts = {}) {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
  },
  page() {
    const dialogs = this.all('[role=dialog]').map((d) => d.innerText.slice(0, 200)).join(' | ');
    return ((dialogs ? 'dialogs: ' + dialogs + ' || ' : '') + 'main: ' + this.screen()).replace(/\\s+/g, ' ').slice(0, 900);
  },
};
true;`;

// the throwaway example workspace's own data, written through the app (its RPCs, as the UI and agents do)
const EVAL_DATASET = [
  ['Cancel my appointment on Friday', 'cancellation', 'cancel'],
  ["Please cancel Rex's grooming", 'cancellation', 'cancel'],
  ["I need a refill of Rex's prescription", 'refill', 'pharmacy'],
  ['Can you refill the flea medicine?', 'refill', 'pharmacy'],
  ['Can I book a check-up for Tuesday?', 'booking', 'booking'],
  ['Schedule a vaccination for my cat', 'booking', 'booking'],
  ['Move my appointment to next week', 'booking', 'booking'],
  ['What are your opening hours?', 'other', 'general'],
  ['Do you treat rabbits?', 'other', 'general'],
  ['My dog ate chocolate, what should I do?', 'other', 'urgent'],
]
  .map(([input, expected, tag], i) => JSON.stringify({ id: `case-${i + 1}`, input, expected, tags: [tag] }))
  .join('\n');
const evaluation = (id, name, model, prompt) => ({
  id,
  name,
  data: {
    name,
    type: 'llm',
    provider: 'mock-llm',
    model,
    temperature: 0,
    system: '',
    prompt,
    format: 'json',
    datasetFormat: 'jsonl',
    dataset: EVAL_DATASET,
    expectedField: 'expected',
    evaluators: [
      { type: 'exact-match', path: '$.intent', expected: '{{expected}}' },
      { type: 'latency', max: 5000 },
    ],
    concurrency: 4,
    retries: 0,
  },
});
const PROMPT = 'Classify the customer intent. Respond with JSON {"intent": "cancellation" | "refill" | "booking" | "other"}.\n\nCustomer: {{input}}';
// three variants of one evaluation (a prompt change and a smaller model) for the matrix
const EVALUATIONS = [
  evaluation('cap-eval-1', 'Intent classification', 'mock-gpt', PROMPT),
  evaluation('cap-eval-2', 'Intent classification (desk hint)', 'mock-gpt', `${PROMPT}\nAnswer as the appointment desk.`),
  evaluation('cap-eval-3', 'Intent classification (small model)', 'mock-small', PROMPT),
];

// a data-driven flow for the Scale stage: one run per row of a CSV; the row without a species is refused (422)
const SCALE_FLOW = 'rest/register-patients.yaml';
const SCALE_TEXT = `# Registers each patient of datasets/new-patients.csv, reads it back and removes it again: Run with data runs it once per row.
name: Register patients
defaults:
  type: http
tests:
  - id: token
    name: Get a token
    method: POST
    url: "{{baseUrl}}/auth/token"
    body:
      type: form-urlencoded
      fields:
        - { key: client_id, value: "{{clientId}}" }
        - { key: client_secret, value: "{{clientSecret}}" }
        - { key: grant_type, value: client_credentials }
    extract: { accessToken: $.access_token }
    assertions: [{ type: status, expected: 200 }]
  - id: register
    name: Register the patient
    dependsOn: token
    method: POST
    url: "{{baseUrl}}/patients"
    auth: { type: bearer, token: "{{accessToken}}" }
    body: { name: "{{name}}", species: "{{species}}" }
    extract: { patientId: $.id }
    assertions: [{ type: status, expected: 201 }]
  - id: read
    name: Read it back
    dependsOn: register
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 200 }, { type: equals, path: $.name, expected: "{{name}}" }]
  - id: remove
    name: Remove it
    dependsOn: read
    method: DELETE
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 204 }]
`;
const SCALE_CSV = 'name,species\nBiscuit,dog\nPepper,cat\nClover,rabbit\nMango,parrot\nNameless,\nWaffles,dog\nJuniper,cat\nOtis,ferret\n';
// a flow for the designer: a token, then a patient's whole life, its checks side by side (a frame), a note
const FLOW = 'rest/new-patient.yaml';
const FLOW_TEXT = `# A patient's whole life through the API, built in the flow designer: each step waits for the ones it needs.
name: New patient, end to end
defaults:
  type: http
tests:
  - id: token
    name: Get a token
    method: POST
    url: "{{baseUrl}}/auth/token"
    body:
      type: form-urlencoded
      fields:
        - { key: client_id, value: "{{clientId}}" }
        - { key: client_secret, value: "{{clientSecret}}" }
        - { key: grant_type, value: client_credentials }
    extract: { accessToken: $.access_token }
    assertions: [{ type: status, expected: 200 }]
  - id: register
    name: Register a patient
    dependsOn: token
    method: POST
    url: "{{baseUrl}}/patients"
    auth: { type: bearer, token: "{{accessToken}}" }
    body: { name: Biscuit, species: dog }
    extract: { patientId: $.id }
    assertions: [{ type: status, expected: 201 }]
  - id: read
    name: Read it back
    dependsOn: register
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 200 }, { type: equals, path: $.name, expected: Biscuit }]
  - id: listed
    name: It is in the list
    dependsOn: register
    method: GET
    url: "{{baseUrl}}/patients"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 200 }]
  - id: refused
    name: A wrong token is refused
    dependsOn: register
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: not-a-real-token }
    assertions: [{ type: status, expected: 403 }]
  - id: remove
    name: Remove it
    dependsOn: [read, listed, refused]
    method: DELETE
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 204 }]
  - id: gone
    name: It is gone
    dependsOn: remove
    method: GET
    url: "{{baseUrl}}/patients/{{patientId}}"
    auth: { type: bearer, token: "{{accessToken}}" }
    assertions: [{ type: status, expected: 404 }]
`;

module.exports = async function run(win) {
  mkdirSync(OUT, { recursive: true });
  win.setContentSize(W, H);
  // keep painting while the window is covered or the screen is locked, or capturePage returns stale frames
  win.webContents.setBackgroundThrottling(false);
  const js = (code) =>
    win.webContents.executeJavaScript(code, true).catch((e) => {
      throw new Error(`${e.message} in: ${code.replace(/\s+/g, ' ').slice(0, 300)}`);
    });
  /** Wait until `expr` (JavaScript in the page; may use await) is truthy; on timeout, fail with what is on screen. */
  const until = async (expr, what, ms = 20000) => {
    const end = Date.now() + ms;
    for (;;) {
      if (await js(`(async () => { try { return !!(${expr}); } catch { return false; } })()`)) return;
      if (Date.now() > end) {
        // TESTPION_CAPTURE_DEBUG=<dir>: the window as it was, to see why
        if (process.env.TESTPION_CAPTURE_DEBUG) writeFileSync(join(process.env.TESTPION_CAPTURE_DEBUG, 'failed.jpg'), (await win.webContents.capturePage()).toJPEG(80));
        throw new Error(`timed out waiting for ${what}; ${await js('__cap.page()')}`);
      }
      await sleep(100);
    }
  };
  /** Click the element `expr` finds, as soon as it is there (found and clicked in one go). */
  const clickOn = (expr, what, ms) =>
    // (an SVG element, a step of the flow canvas, has no click())
    until(`(() => { const e = ${expr}; if (!e) return false; if (e.click) e.click(); else e.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`, what, ms);
  /** Click the visible control with this text. */
  const click = (text, sel) => clickOn(`__cap.byText(${J(text)}${sel ? `, ${J(sel)}` : ''})`, `"${text}"`);
  /** Click the first visible element matching a selector. */
  const clickSel = (sel, what = sel) => clickOn(`__cap.one(${J(sel)})`, what);
  /** Open the rail's More… menu (it opens on pointer down). */
  const openMore = async () => {
    await clickOn(`(() => { const m = __cap.one('nav [aria-label="More views"]'); m?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return m; })()`, 'the rail\'s More…');
    await until(`__cap.one('[role=menu]')`, 'the More… menu');
  };
  /** Go to a view by its rail label: its rail item, or (a view the rail shows under More…) the More… menu's item. */
  const nav = async (label) => {
    // close what is open (a menu, a dialog) first
    await js(`__cap.all('[role=menu], [role=dialog]').length && __cap.key('Escape'); true`);
    await until(`!__cap.all('[role=menu]').length`, 'the open menu to close');
    if (!(await js(`!!__cap.one('nav [aria-label="${label}"]')`))) {
      await openMore();
      await click(label, '[role=menuitem]');
    } else await clickSel(`nav [aria-label="${label}"]`, `the ${label} rail item`);
    await until(`document.querySelector('nav [aria-label="${label}"][aria-current="page"]')`, `the ${label} view`);
  };
  const tab = (text) => click(text, '[role=tab]');
  /** A tab of the response (right of, or below, the request's own tabs: the last one of that name). */
  const responseTab = async (text) => {
    const find = `__cap.all('main [role=tab]').filter((t) => __cap.text(t).startsWith(${J(text)})).pop()`;
    await clickOn(find, `the response tab ${text}`);
  };
  const invoke = (method, params) => js(`window.aps.invoke(${J(method)}, ${J(params ?? {})})`);
  /** Type into the focused element, like the keyboard does. */
  const type = (text) => {
    for (const ch of text) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
  };
  const enter = () => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    win.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  };
  /** A real mouse click in the middle of the element `expr` finds (focus and pointer events as a person's click). */
  const realClick = async (expr, what) => {
    await until(expr, what);
    const r = await js(`(() => { const b = (${expr}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', x: r.x, y: r.y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x: r.x, y: r.y, button: 'left', clickCount: 1 });
  };
  // the pointer rests on the empty middle of the status bar: no hover highlight, no edge panel opening on hover
  const park = () => win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(W / 2), y: H - 3 });
  /** Wait until nothing is loading and the transient toasts are gone (an error toast fails the run). */
  const settle = async ({ toasts = false } = {}) => {
    const error = await js(`__cap.all('[data-sonner-toast][data-type=error]').map((t) => __cap.text(t)).join(' | ')`);
    if (error) throw new Error(`an error toast is on screen: ${error}`);
    if (!toasts) await until(`!__cap.all('[data-sonner-toast]').length`, 'the toasts to go', 15000);
    await until(`!__cap.all('.animate-spin, [aria-busy=true]').length`, 'loading to finish', 15000);
    // two frames, then the CSS transitions (150-200 ms) end
    await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 350))))`);
  };
  /** A screenshot of the window; `toasts: true` keeps the message on screen (the shot is of it). */
  const shot = async (name, opts) => {
    park();
    await settle(opts);
    // force a full repaint: a window that isn't visible on screen (covered, locked screen) otherwise keeps
    // stale regions; a one-pixel resize makes the compositor redraw everything
    win.setContentSize(W, H + 1);
    await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))`);
    win.setContentSize(W, H);
    win.webContents.invalidate();
    await js(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => r(true), 200))))`);
    const img = await win.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
    const out = img.resize({ width: W, quality: 'best' });
    writeFileSync(join(OUT, `${name}.jpg`), out.toJPEG(88));
    console.log(`[capture] ${name}.jpg ${J(out.getSize())}`);
  };
  /**
   * A new test file, written the way another editor (or git) puts it in the workspace, and shown in the Tests list: the
   * view lists files that appear on disk (a change made outside the app is reported at once); should the list miss it,
   * the file is written again until the list has it.
   */
  const addTestFile = async (path, text) => {
    const root = (await invoke('ws.current')).path;
    const abs = join(root, 'tests', ...path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    for (let i = 0; ; i++) {
      writeFileSync(abs, text);
      try {
        return await until(fileRow(path), `the file ${path} in the Tests list`, 4000);
      } catch (e) {
        if (i === 4) throw e;
      }
    }
  };
  /** The run of a test file, a suite or a collection that finished last (runs.list, newest first). */
  const runsFinished = (n = 1, name) =>
    until(
      `(await window.aps.invoke('runs.list', { limit: 30 })).items.filter((r) => ${name ? `r.name === ${J(name)} && ` : ''}r.durationMs !== undefined).length >= ${n}`,
      `${n} finished run(s)${name ? ` of ${name}` : ''}`,
      90000,
    );

  // ---------------------------------------------------------------- start: the workspace is open, Home on screen
  await js(HELPERS);
  await until(`document.body.innerText.includes('Veterinary API (example)') && __cap.one('nav [aria-label="Home"]')`, 'the workspace to open', 30000);
  park();
  // a fresh profile opens on Home
  await until(`document.querySelector('nav [aria-label="Home"][aria-current="page"]') && __cap.one('section[aria-label=Activity]')`, 'Home');
  // the guided tour opens by itself the first time Home shows Get started (a fresh profile: now); Next goes to the
  // Send button of a new request
  await until(`__cap.one('section[aria-label="Get started"]') && __cap.one('[role=dialog][data-coachmark]')`, 'the guided tour to open on Home');
  await click('Next', '[role=dialog][data-coachmark] button');
  await until(`__cap.one('[role=dialog][data-coachmark]')?.getAttribute('data-coachmark') === '1' && __cap.one('[data-coachmark-ring]') && __cap.one('[data-tour="send"]')`, 'the tour at the Send button');
  await shot('guided-tour');
  await click('Skip tour', '[role=dialog][data-coachmark] button');
  await until(`!__cap.one('[role=dialog][data-coachmark]')`, 'the tour to close');
  await nav('Home');
  await shot('home');
  // the rail: five views, More… for the others
  await openMore();
  await until(`__cap.all('[role=menu] [role=menuitem]').some((m) => __cap.text(m) === 'Debugger')`, 'the views under More…');
  await shot('rail-more');
  await js(`__cap.key('Escape'); true`);
  await until(`!__cap.all('[role=menu]').length`, 'the More… menu to close');

  // ---------------------------------------------------------------- REST: a request of the collection, sent
  const EXPLORER = 'aside[aria-label="Collections explorer"]';
  const FILTER = `${EXPLORER} input[placeholder^="Filter"]`;
  /**
   * Open a request of the explorer by name, for good: the filter shows it (wherever it is folded); a click opens a
   * preview tab, which the double-click keeps (the next request opened would replace a preview).
   */
  const openRequest = async (name) => {
    await until(`__cap.one(${J(FILTER)})`, 'the explorer filter');
    await js(`__cap.input(__cap.one(${J(FILTER)}), ${J(name)}); true`);
    const row = `__cap.all('${EXPLORER} [data-tree-row]').find((b) => !b.hasAttribute('aria-expanded') && __cap.text(b).endsWith(${J(name)}))`;
    await until(`(() => { const r = ${row}; r?.click(); r?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return r; })()`, `the explorer row "${name}"`);
    await until(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]').some((t) => __cap.text(t).includes(${J(name)}))`, `the tab of "${name}"`);
    await js(`__cap.input(__cap.one(${J(FILTER)}), ''); true`);
    await until(`!__cap.one(${J(FILTER)}).value`, 'the filter to clear');
  };
  const sendAndWait = async () => {
    await click('Send', 'main button');
    await until(`/\\b200 OK\\b/.test(__cap.screen()) && /Time \\d+ ms/.test(__cap.screen())`, 'the response');
  };
  // the Collections rail item opens the request editors with the explorer
  await nav('Collections');
  // a token first (the collection's requests use it): its access token (a JWT) decoded in the JWT tab
  await openRequest('Get access token');
  // the blank tab a fresh profile starts with
  await js(`__cap.one('[aria-label="Close New HTTP request"]')?.click(); true`);
  await until(`!__cap.one('[aria-label="Close New HTTP request"]')`, 'the blank tab to close');
  await sendAndWait();
  await responseTab('JWT');
  await until(`__cap.screen().includes('Decoded locally')`, 'the decoded token');
  await shot('rest-jwt');

  await openRequest('List patients');
  await sendAndWait();
  // the JSON tree (the request also has a visualizer, which the Body tab shows first)
  await click('Pretty', 'main [role=radio]');
  await until(`__cap.screen().includes('"items"') && __cap.screen().includes('"total"')`, 'the JSON tree');
  await shot('rest');
  // the JSONPath filter: the response's own paths suggested as you type
  const JSONPATH = `__cap.one('main input[aria-label="Filter with JSONPath"]')`;
  await until(JSONPATH, 'the JSONPath filter');
  await realClick(JSONPATH, 'the JSONPath filter');
  await until(`document.activeElement === ${JSONPATH}`, 'the focus in the filter');
  // (a window in the background gets no focus events: the field is told, as a focused window would tell it)
  await js(`${JSONPATH}.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); true`);
  type('$.it');
  await until(`__cap.all('[role=listbox] [role=option]').length >= 3 && ${JSONPATH}.value === '$.it'`, 'the path suggestions');
  await shot('response-filter');
  await js(`__cap.key('Escape'); true`);
  await until(`!__cap.all('[role=listbox]').length`, 'the suggestions to close');
  await js(`__cap.input(${JSONPATH}, ''); true`);
  await until(`!${JSONPATH}.value && __cap.screen().includes('"total"')`, 'the filter to clear');
  // the response's timeline: connection set-up, waiting and download
  await responseTab('Timeline');
  await until(`__cap.screen().includes('waiting (TTFB)')`, 'the timeline');
  await shot('rest-timeline');
  await responseTab('Body');

  // Diff vs previous: a patient registered, the list sent again and compared with the response before
  await openRequest('Create patient');
  await click('Send', 'main button');
  await until(`/\\b201\\b/.test(__cap.screen()) && /Time \\d+ ms/.test(__cap.screen())`, 'the patient created');
  await clickOn(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab]').find((t) => __cap.text(t).includes('List patients'))`, 'the List patients tab');
  await until(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]').some((t) => __cap.text(t).includes('List patients'))`, 'the list on screen');
  await sendAndWait();
  const diffAction = `__cap.all('main button').find((b) => __cap.text(b) === 'Diff vs previous')`;
  if (await js(`!!${diffAction}`)) await clickOn(diffAction, 'Diff vs previous');
  else {
    await clickOn(`(() => { const m = __cap.one('main button[aria-label="Response actions"]'); m?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return m; })()`, 'the response actions');
    await click('Diff vs previous', '[role=menuitem]');
  }
  await until(`__cap.one('main [data-response-diff]') && /added|changed/i.test(__cap.screen('main [data-response-diff]'))`, 'the diff against the previous response');
  await shot('response-diff');
  await clickSel('main [data-response-diff] button[aria-label="Close the diff"]', 'Close the diff');
  await until(`!__cap.one('main [data-response-diff]')`, 'the diff to close');

  // Undo instead of a question: a request deleted from the explorer, the message with Undo
  const logOut = `__cap.all('${EXPLORER} [data-tree-row]').find((b) => __cap.text(b).endsWith('Log out (expires the cookie)'))`;
  // the collection, its REST requests and the Cookie session folder unfolded, one level per try
  const unfold = `__cap.all('${EXPLORER} [data-tree-row][aria-expanded="false"]').find((b) => ['Veterinary API', 'REST', 'Cookie session'].some((n) => __cap.text(b).startsWith(n)))`;
  await until(`${logOut} || ((${unfold})?.click(), false)`, 'the Log out request in the explorer');
  await js(`${logOut}.focus(); __cap.key('Delete'); true`);
  await until(`__cap.all('[data-sonner-toast]').some((t) => /Deleted the request/.test(__cap.text(t)))`, 'the Undo message');
  await shot('undo-toast', { toasts: true });
  await clickOn(`__cap.all('[data-sonner-toast] button').find((b) => __cap.text(b) === 'Undo')`, 'Undo');
  await until(`${logOut}`, 'the request back in the explorer');

  // the right edge's Info panel for the request on screen (the token request): where it is saved, its variables and
  // where each comes from (the secret masked), the runs that included it
  await clickOn(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab]').find((t) => __cap.text(t).includes('Get access token'))`, 'the Get access token tab');
  await until(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]').some((t) => __cap.text(t).includes('Get access token'))`, 'the token request on screen');
  await clickSel('[aria-label="Info (unpinned panel)"]', 'the Info edge tab');
  await until(`__cap.one('[role=region][aria-label="Info"]') && __cap.screen('[role=region][aria-label="Info"]').length > 80`, 'the Info panel');
  await shot('info-panel');
  await clickSel('[aria-label="Info (unpinned panel)"]', 'the Info edge tab');
  await until(`!__cap.one('[role=region][aria-label="Info"]')`, 'the Info panel to close');

  // Quick Open (Ctrl+P): any item by name, the ones opened lately first
  await js(`__cap.key('p', { ctrlKey: true }); true`);
  await until(`__cap.one('[role=dialog] input')`, 'Quick Open');
  type('patient');
  await until(`__cap.all('[role=dialog] [role=option]').length >= 4`, 'Quick Open results');
  await shot('quick-open');
  await js(`__cap.key('Escape'); true`);
  await until(`!__cap.one('[role=dialog]')`, 'Quick Open to close');

  // ---------------------------------------------------------------- GraphQL: a new tab, introspect, run
  await js(`(() => { const p = __cap.one('[aria-label="New tab"]'); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true; })()`);
  await click('GraphQL', '[role=menuitem]');
  await until(`__cap.byText('Introspect', 'main button')`, 'the GraphQL editor');
  await click('Introspect', 'main button');
  await until(`__cap.byText('Schema', 'main button') && !__cap.all('main .animate-spin').length`, 'the schema');
  await click('Run', 'main button');
  await until(`/"data"/.test(__cap.screen())`, 'the GraphQL response');
  await shot('graphql');

  // ---------------------------------------------------------------- MCP: connect, run a tool, the protocol trace
  const mcpRow = `__cap.all('${EXPLORER} [data-tree-row]').find((b) => !b.hasAttribute('aria-expanded') && __cap.text(b).includes('customer-mcp'))`;
  await clickOn(mcpRow, 'the customer-mcp server in the explorer');
  await click('Connect', 'main button');
  // the example's own stdio server: allowed for this (throwaway) workspace when TestPion asks before running it
  await until(`__cap.byText('Run once', '[role=dialog] button') || __cap.byText('Disconnect', 'main button')`, 'the server to start (or the ask to run it)');
  await js(`__cap.byText('Run once', '[role=dialog] button')?.click(); true`);
  const customerId = `[...document.querySelectorAll('main label')].filter((l) => __cap.shown(l)).find((l) => l.textContent.includes('customer_id'))?.querySelector('input')`;
  await until(customerId, 'the search_customer form');
  await js(`__cap.input(${customerId}, '123'); true`);
  await click('Execute', 'main button');
  await until(`__cap.screen().includes('Ada Lovelace')`, 'the tool result');
  await shot('mcp');
  await tab('Protocol trace');
  await until(`__cap.screen().includes('tools/call')`, 'the protocol trace');
  // the tools/call message, opened
  // the answer to the tools/call (the last message)
  const callRow = `__cap.all('main button').filter((b) => __cap.text(b).includes('tools/call')).pop()`;
  await clickOn(callRow, 'the tools/call message');
  await shot('mcp-trace');
  // calls, failures and time per tool
  await tab('Usage');
  await until(`__cap.screen().includes('search_customer') && /p95/i.test(__cap.screen())`, 'the MCP usage');
  await shot('mcp-usage');

  // ---------------------------------------------------------------- AI Lab: the playground, its usage
  await nav('AI Lab');
  await clickSel('main button[title^="Run"]', 'the Run button of the playground');
  await until(`/tokens/i.test(__cap.screen()) && /"intent"|intent/.test(__cap.screen()) && !__cap.all('main .animate-spin').length`, 'the AI response');
  await shot('ai-lab');
  // tokens, cost and time per model
  await tab('Usage');
  await until(`/mock-gpt/.test(__cap.screen())`, 'the AI usage');
  await shot('ai-usage');
  await tab('Playground');

  // ---------------------------------------------------------------- Evaluations: three saved variants run, then the matrix
  // three saved evaluations, written through the app (as the Save button does)
  const lib = await invoke('lib.get', { kind: 'evaluations' });
  await invoke('lib.save', { kind: 'evaluations', library: { ...lib, items: [...(lib.items ?? []), ...EVALUATIONS] } });
  await nav('Evaluations');
  const savedRow = (name) => `__cap.all('main [data-tree-row], main button').find((b) => __cap.text(b).startsWith(${J(name)}) && __cap.text(b).includes('cases'))`;
  await clickOn(savedRow('Intent classification'), 'the saved evaluations');
  // the saved one is open (10 cases, not the 3 of the default draft): run it
  await clickOn(`__cap.all('main button').find((b) => __cap.text(b) === 'Run 10 cases')`, 'the saved evaluation, open');
  await runsFinished(1, EVALUATIONS[0].name);
  // the other two variants, one after the other, run the way the saved list's Run does: the desk hint (3 cases fail) last
  for (const e of [EVALUATIONS[2], EVALUATIONS[1]]) {
    await invoke('eval.runDraft', { draft: e.data, environment: 'Development' });
    await runsFinished(1, e.name);
  }
  await until(`/Duration/.test(__cap.screen()) && /Exact match/.test(__cap.screen())`, 'the run of the evaluation');
  await shot('evaluations');
  await click('Matrix', '[role=radio]');
  await until(`__cap.one('[data-eval-matrix]') && __cap.all('[data-matrix-row]').filter((r) => r.dataset.matrixRow !== 'loading').length >= 10 && __cap.all('[data-matrix-column]').length === 3`, 'the matrix');
  // the first variant as the baseline: the others' cells coloured by regression, with the change
  const baseline = `__cap.one('[data-eval-matrix] select[aria-label="Baseline run"]')`;
  const firstRun = `[...${baseline}.options].find((o) => o.value && o.textContent.startsWith('Intent classification') && !o.textContent.includes('('))`;
  await until(firstRun, 'the runs in the baseline picker');
  await js(`__cap.input(${baseline}, ${firstRun}.value); true`);
  await until(`__cap.one('[data-eval-matrix]').dataset.baseline && __cap.all('[data-cell-change="regressed"]').length >= 3`, 'the matrix against the baseline');
  await shot('eval-matrix');
  await click('Run', '[role=radio]');

  // the bottom panel's Problems (the status bar's count): the latest run, the desk hint's, failed 3 cases
  await clickSel('[data-status=problems]', 'the Problems count');
  await until(`__cap.one('[data-bottom-tab=problems][aria-selected=true]') && /[1-9][0-9]* failures? ·/.test(document.body.innerText)`, 'the Problems tab');
  await shot('problems');
  await clickSel('[data-status=problems]', 'the Problems count');


  // ---------------------------------------------------------------- Tests: run everything, then open a result
  await nav('Tests');
  await click('Run all tests', 'main button');
  await until(`(await window.aps.invoke('runs.list', { limit: 1 })).items.some((r) => r.name === 'All tests' && r.durationMs !== undefined)`, 'the run of all tests', 120000);
  await click('Booking agent uses the right tools', 'main button');
  await until(`__cap.screen().includes('Booking agent uses the right tools') && /Checks|Assertions/.test(__cap.screen())`, 'the agent test result');
  await shot('tests');

  // the flow designer: a test file's Flow tab, its steps, a frame and a note
  const fileRow = (path) => `__cap.all('main [data-tree-row]').find((b) => __cap.text(b).endsWith(${J(path.split('/').pop())}))`;
  const openFile = async (path) => {
    await clickOn(fileRow(path), `the file ${path} in the Tests list`);
    await until(`__cap.one('[data-tab-id="file:${path}"][aria-selected="true"]')`, `the tab of ${path}`);
  };
  // a new flow, then a frame, a note and a webhook that starts it: the designer's own edits, through the app
  await addTestFile(FLOW, FLOW_TEXT);
  await invoke('tests.flowEdit', { file: FLOW, op: { op: 'addFrame', title: 'Checks, side by side', color: 'blue', steps: ['read', 'listed', 'refused'] } });
  await invoke('tests.flowEdit', {
    file: FLOW,
    op: { op: 'addNote', note: { x: 0, y: 300, w: 504, h: 80, color: 'yellow', text: '**Leaves nothing behind**: the patient is removed at the end, so the flow can run again.' } },
  });
  await invoke('tests.flowEdit', { file: FLOW, op: { op: 'setWebhook', webhook: { path: '/hooks/new-patient' } } });
  await openFile(FLOW);
  await tab('Flow');
  await until(`__cap.all('[data-flow-designer] [data-flow-node]').length === 7 && __cap.screen('[data-flow-designer]').includes('Leaves nothing behind') && __cap.screen('[data-flow-designer]').includes('Checks, side by side')`, 'the flow designer with its note and frame');
  // a run lights the steps up
  await click('Run flow', '[data-flow-designer] button');
  await until(`__cap.all('[data-flow-designer] [data-flow-node]').every((n) => n.dataset.status === 'passed')`, 'the flow run', 30000);
  // a step selected: the inspector edits it
  await clickOn(`__cap.all('[data-flow-designer] [data-flow-node]').find((n) => __cap.text(n).includes('Register a pati'))`, 'the Register a patient step');
  await until(`__cap.one('[data-step-inspector]')`, 'the inspector of the step');
  await shot('flow-designer');
  // the Deploy panel: a schedule, the webhook, an MCP tool for agents, CI
  await clickSel('[data-flow-designer] [data-flow-deploy]', 'the Deploy button');
  await until(`__cap.one('[data-deploy-panel]') && __cap.all('[data-deploy-panel] [data-deploy-target]').length >= 4`, 'the Deploy panel');
  await shot('flow-deploy');
  await js(`__cap.key('Escape'); document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await until(`!__cap.one('[data-deploy-panel]')`, 'the Deploy panel to close');

  // Scale: Run with data… runs a flow once per row of a CSV; the grid shows each row's steps
  await addTestFile(SCALE_FLOW, SCALE_TEXT);
  await invoke('col.uploadDataFile', { name: 'new-patients.csv', text: SCALE_CSV });
  await openFile(SCALE_FLOW);
  await clickSel('[data-run-with-data-open]', 'Run with data…');
  await until(`__cap.one('[data-run-with-data] select[aria-label="Data source"]')`, 'the Run with data dialog');
  const csv = (await invoke('datasets.list')).find((d) => d.name.endsWith('new-patients.csv'));
  if (!csv) throw new Error('the new-patients.csv dataset is not listed');
  const source = `__cap.one('[data-run-with-data] select[aria-label="Data source"]')`;
  await until(`[...${source}.options].some((o) => o.value === ${J(csv.path)})`, 'the dataset in the list');
  await js(`__cap.input(${source}, ${J(csv.path)}); true`);
  await clickSel('[data-scale-start]', 'Start');
  await until(`__cap.one('[data-flow-data-grid]')?.dataset.running === 'false' && __cap.all('[data-data-row]').length === 8`, 'the data run to finish', 60000);
  // the row that failed: its steps and the failing step's answer
  await clickOn(`__cap.all('[data-data-row]').find((r) => r.dataset.status === 'failed')`, 'the failed row');
  await until(`__cap.all('[data-row-step]').length >= 2 && __cap.screen().includes('422')`, 'the steps of the failed row');
  await shot('flow-scale');

  // ---------------------------------------------------------------- Traces: the booking agent's trace
  await nav('Traces');
  await until(`__cap.one('main input[placeholder^="Filter traces"]')`, 'the trace filter');
  await js(`__cap.input(__cap.one('main input[placeholder^="Filter traces"]'), 'Booking agent'); true`);
  const traceRow = `__cap.all('main button').find((b) => /spans/.test(b.textContent) && b.textContent.includes('Booking agent uses the right tools'))`;
  await clickOn(traceRow, 'the traces');
  await until(`__cap.screen().includes('mcp create_appointment')`, 'the trace waterfall');
  // the agent's tool call: what it sent and got back
  await clickOn(`__cap.all('main [role=row], main button, main li').filter((e) => __cap.text(e).startsWith('mcp create_appointment')).pop()`, 'the MCP span');
  await until(`__cap.screen().includes('customer_id')`, 'the tool call payload');
  await shot('traces');

  // ---------------------------------------------------------------- Load test
  await nav('Load');
  await click('Start load test', 'main button');
  await until(`__cap.byText('Stop', 'main button')`, 'the load test to start');
  await until(`!__cap.byText('Stop', 'main button') && __cap.byText('Start load test', 'main button')`, 'the load test to finish', 90000);
  await shot('load');

  // ---------------------------------------------------------------- Monitors: one scheduled check with a few runs, one paused
  const m = await invoke('monitor.save', { monitor: { name: 'Diagnostics', collectionId: 'veterinary-api', selection: ['fld-diag'], environment: 'Development', everyMinutes: 15, enabled: true } });
  await invoke('monitor.save', { monitor: { name: 'Whole API (nightly)', collectionId: 'veterinary-api', environment: 'Development', everyMinutes: 1440, enabled: false } });
  for (let i = 0; i < 5; i++) await invoke('monitor.run', { id: m.id });
  await nav('Monitors');
  await until(`__cap.screen().includes('Diagnostics') && __cap.screen().includes('Whole API (nightly)')`, 'the monitors');
  await shot('monitors');

  // ---------------------------------------------------------------- the HTTP Debugger: a session of a clinic's traffic (from a HAR, so nothing has to listen), a 404 selected
  await nav('Debugger');
  const t0 = Date.now() - 90_000;
  const calls = [
    ['chrome', 'GET', '/api/patients', 200, 42], ['chrome', 'GET', '/api/patients/7', 200, 18], ['chrome', 'GET', '/api/appointments?date=today', 200, 63],
    ['node', 'POST', '/api/appointments', 201, 88], ['node', 'GET', '/api/patients/41', 404, 9], ['python', 'GET', '/api/vaccines', 200, 120],
    ['python', 'PUT', '/api/patients/7/vitals', 200, 47], ['chrome', 'GET', '/api/invoices?status=open', 500, 310], ['node', 'DELETE', '/api/appointments/12', 204, 21],
    ['chrome', 'GET', '/api/patients?search=byron', 200, 35], ['python', 'POST', '/api/labs/results', 201, 152], ['node', 'GET', '/api/patients/99', 404, 8],
    ['chrome', 'GET', '/api/staff', 200, 29], ['node', 'PATCH', '/api/appointments/13', 200, 54], ['chrome', 'GET', '/api/reports/daily', 200, 410],
  ];
  const entries = calls.map(([app, method, path, status, ms], i) => {
    const body = status >= 400 ? J({ error: status === 404 ? 'not_found' : 'internal', message: status === 404 ? 'Patient not found' : 'Invoice service timed out' }) : status === 204 ? '' : J({ id: 7 + i, name: ['Byron', 'Biscuit', 'Pepper'][i % 3], species: ['dog', 'cat', 'rabbit'][i % 3] });
    const noBody = method === 'GET' || method === 'DELETE';
    return {
      startedDateTime: new Date(t0 + i * 5200).toISOString(),
      time: ms,
      request: {
        method,
        url: 'http://api.vetclinic.test:8080' + path,
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'accept', value: 'application/json' }, { name: 'authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x' }, { name: 'user-agent', value: app === 'chrome' ? 'Mozilla/5.0 Chrome/141' : app === 'node' ? 'node' : 'python-requests/2.32' }],
        queryString: [],
        cookies: [],
        headersSize: -1,
        bodySize: noBody ? 0 : 64,
        ...(noBody ? {} : { postData: { mimeType: 'application/json', text: '{"petId":7,"note":"annual check"}' } }),
      },
      response: {
        status,
        statusText: status === 404 ? 'Not Found' : status === 500 ? 'Internal Server Error' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'OK',
        httpVersion: 'HTTP/1.1',
        headers: [{ name: 'content-type', value: 'application/json' }, { name: 'x-request-id', value: 'req-' + (1000 + i) }],
        cookies: [],
        content: { size: body.length, mimeType: 'application/json', text: body },
        redirectURL: '',
        headersSize: -1,
        bodySize: body.length,
      },
      cache: {},
      timings: { send: 1, wait: Math.round(ms * 0.8), receive: Math.round(ms * 0.2) },
      serverIPAddress: '10.20.0.15',
      _testpion: { id: 'cap-' + i, kind: 'http', application: app, clientPort: 52000 + i, pid: { chrome: 8124, node: 4116, python: 9532 }[app], serverAddress: '10.20.0.15:8080' },
    };
  });
  await invoke('debug.openSession', { text: J({ log: { version: '1.2', creator: { name: 'TestPion', version: '1' }, entries } }) });
  const row404 = `__cap.all('main [role=row][data-exchange]').find((r) => r.textContent.includes('/api/patients/41'))`;
  await until(`__cap.all('main [role=row][data-exchange]').length === ${calls.length}`, 'the captured requests');
  await clickOn(row404, 'the 404');
  await until(`__cap.screen().includes('GET /api/patients/41 HTTP/1.1') && __cap.screen().includes('req-1004')`, 'the 404 in the details');
  await js(`document.querySelector('main [data-dock]')?.getAttribute('data-dock') !== 'summary' && document.querySelector('[data-tool-rail] button[aria-label=Summary]')?.click(); true`);
  await until(`document.querySelector('main [data-dock]')?.getAttribute('data-dock') === 'summary'`, 'the Summary panel');
  // the response's body
  await responseTab('Content');
  await until(`__cap.screen().includes('Patient not found')`, 'the 404 body');
  await shot('debugger');
  await invoke('debug.clear');

  // ---------------------------------------------------------------- Home again, with the activity of all of the above
  await nav('Home');
  await until(`(() => { const a = __cap.one('section[aria-label=Activity]'); a?.scrollIntoView({ block: 'start' }); return !!a; })()`, 'the Activity section');
  await until(`__cap.one('section[aria-label=Activity] svg') && !/Nothing in the last/.test(__cap.screen('section[aria-label=Activity]'))`, 'the activity charts');
  await shot('home-activity');

  // ---------------------------------------------------------------- the Debugger's session tabs (after Home's activity,
  // which a saved capture session would show): the clinic's capture saved; the reverse proxy for one API fills the live
  // capture (rows marked reverse), and the saved session opens in a tab beside it
  await nav('Debugger');
  await invoke('debug.openSession', { text: J({ log: { version: '1.2', creator: { name: 'TestPion', version: '1' }, entries } }) });
  await until(`__cap.all('main [role=row][data-exchange]').length === ${calls.length}`, 'the session again');
  await invoke('debug.saveSession', { name: 'clinic-morning' });
  await invoke('debug.clear');
  const reverse = await invoke('record.start', { target: 'http://127.0.0.1:4010' });
  for (const path of ['/health', '/echo?patient=7&visit=annual', '/patients', '/health', '/echo?patient=12&visit=vaccination'])
    await invoke('http.send', { request: { method: 'GET', url: reverse.url + path, headers: [], body: { type: 'none' } } }).catch(() => undefined);
  await until(`__cap.all('main [role=row][data-exchange] [data-source="reverse"]').length === 5`, 'the reverse proxy rows in the grid');
  await clickOn(`(() => { const b = __cap.all('main button').find((x) => /^Session/.test(__cap.text(x))); b?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return b; })()`, 'the Session menu');
  await clickOn(`__cap.all('[role=menuitem]').find((m) => /^Open clinic-morning/.test(__cap.text(m)))`, 'the saved session in the Session menu');
  await until(`__cap.one('[data-session-tab="clinic-morning"]')`, 'the saved session in its tab');
  await clickOn(`__cap.all('[role=tablist][aria-label="Open sessions"] [role=tab]').find((t) => /Live capture/.test(__cap.text(t)))`, 'the Live capture tab');
  await until(`!__cap.one('[data-session-tab]') && __cap.all('main [role=row][data-exchange]').length === 5`, 'the live capture again');
  await clickOn(`__cap.all('main [role=row][data-exchange]').find((r) => r.textContent.includes('patient=7'))`, 'a reverse proxy row');
  await until(`__cap.screen().includes('GET /echo?patient=7&visit=annual HTTP/1.1')`, 'the row in the details');
  await shot('debugger-sessions');
  await invoke('record.stop');
  await invoke('debug.clear');

  // ---------------------------------------------------------------- a run's Charts tab (the test run from above)
  await nav('Tests');
  await clickOn(`__cap.all('main [role=tab]').filter((x) => __cap.text(x).startsWith('Runs')).pop()`, 'the Runs tab');
  const allRun = `__cap.all('main button').find((b) => b.textContent.includes('All tests') && b.querySelector('.bg-ok, .bg-bad'))`;
  await clickOn(allRun, 'the run of all tests in Runs');
  await tab('Charts');
  await until(`__cap.all('main svg, main canvas').length >= 3 && /slowest/i.test(__cap.screen())`, 'the charts');
  await shot('run-charts');

  // ---------------------------------------------------------------- Settings ▸ Keyboard: every shortcut, rebindable
  await nav('Settings');
  await tab('Keyboard');
  await until(`__cap.all('[data-shortcut-row]').length > 30`, 'the shortcuts');
  await shot('settings-keyboard');

  // ---------------------------------------------------------------- compact density: the request editor, tighter
  const density = async (label) => {
    await nav('Settings');
    await tab('Appearance');
    await click(label, 'main [role=radio], main button');
    await click('Save settings', 'main button');
    await until(`document.documentElement.dataset.density === ${J(label.toLowerCase())}`, `the ${label} density`);
  };
  await density('Compact');
  await nav('Collections');
  await clickOn(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab]').find((t) => __cap.text(t).includes('List patients'))`, 'the List patients tab');
  await until(`__cap.all('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]').some((t) => __cap.text(t).includes('List patients'))`, 'the request in compact density');
  await click('Pretty', 'main [role=radio]');
  await until(`__cap.screen().includes('"total"')`, 'the JSON tree in compact density');
  await shot('density-compact');
  await density('Comfortable');
  // the terminal opens over the run's charts, as before
  await nav('Tests');
  await until(`__cap.screen().includes('Charts') && /slowest/i.test(__cap.screen())`, 'the run charts again');

  // ---------------------------------------------------------------- the bottom panel's Terminal, testpion on its PATH
  if (await js(`!!document.querySelector('[data-status=terminal]')`)) {
    await clickSel('[data-status=terminal]', 'the Terminal');
    await until(`__cap.one('[data-terminal-box] .xterm-rows') && /\\S/.test(__cap.one('[data-terminal-box] .xterm-rows').innerText)`, 'the shell to start', 30000);
    await until(`/[>$#] ?$/m.test(__cap.one('[data-terminal-box] .xterm-rows').innerText.trimEnd())`, 'the shell prompt', 30000);
    // a short prompt: the workspace's folder (a temporary one, under the user's own folder) stays off the picture
    type(process.platform === 'win32' ? "function prompt { 'PS veterinary-workspace> ' }; Clear-Host" : "PS1='veterinary-workspace $ '; clear");
    enter();
    await until(`/veterinary-workspace[^\\n]*[>$] ?$/.test(__cap.one('[data-terminal-box] .xterm-rows').innerText.trim()) && __cap.one('[data-terminal-box] .xterm-rows').innerText.trim().split('\\n').filter((l) => l.trim()).length === 1`, 'the short prompt', 15000);
    // the app's own command line: a request sent from it (nothing that prints the workspace's folder: the capture's is
    // a temporary one in the user's own folder)
    type('testpion send "{{baseUrl}}/health" -e Development');
    enter();
    await until(`__cap.one('[data-terminal-box] .xterm-rows').innerText.includes('"status": "ok"') && /veterinary-workspace[^\\n]*[>$] ?$/.test(__cap.one('[data-terminal-box] .xterm-rows').innerText.trim())`, 'the request sent from the terminal', 60000);
    await shot('terminal');
    await clickSel('[data-status=terminal]', 'the Terminal');
    await until(`!__cap.one('[data-terminal-box]')`, 'the bottom panel to close');
  } else console.log('[capture] skipped terminal.jpg: no shell on this platform');

  // ---------------------------------------------------------------- the AI features, with a scripted offline model
  // (last, so the shots above stay as they were). Two providers are added to the throwaway workspace: a local Ollama
  // for small tasks (only previewed here: nothing is sent to it) and an offline mock model whose answers are scripted
  // (x-mock-rules: a regular expression on the last user message → the answer), so the dialogs show a realistic,
  // verified proposal. No real model and no key.
  const AI_CHECKS = [
    { type: 'status', expected: 200 },
    { type: 'header', header: 'content-type', expected: 'json' },
    { type: 'exists', path: '$.id' },
    { type: 'equals', path: '$.id', expected: '1' },
    { type: 'type', path: '$.name', expected: 'string' },
    { type: 'equals', path: '$.species', expected: 'dog' },
    { type: 'equals', path: '$.ownerId', expected: '123' },
  ];
  const AI_FLOW = {
    name: 'Patients lifecycle',
    summary: 'Registers a patient, reads it back by the id the create returned, and checks that an unknown patient answers 404.',
    assumptions: ['POST /patients answers 201 with the new id in $.id', 'Patient 999 does not exist on any server the flow runs against'],
    steps: [
      {
        id: 'create-patient',
        request: 'req-create',
        extract: { patientId: '$.id' },
        assertions: [
          { type: 'status', expected: 201 },
          { type: 'exists', path: '$.id' },
          { type: 'equals', path: '$.name', expected: 'Biscuit' },
        ],
      },
      {
        id: 'read-patient',
        request: 'req-get',
        dependsOn: ['create-patient'],
        url: '{{baseUrl}}/patients/{{patientId}}',
        assertions: [
          { type: 'status', expected: 200 },
          { type: 'equals', path: '$.species', expected: 'dog' },
        ],
      },
      { id: 'unknown-patient', request: 'req-get', url: '{{baseUrl}}/patients/999', negative: true, assertions: [{ type: 'status', expected: 404 }] },
      // a request the folder does not have: TestPion drops the step and says so in the review
      { id: 'discharge-patient', request: 'req-discharge', dependsOn: ['read-patient'] },
    ],
  };
  const own = (await invoke('ai.providers')).filter((p) => !p.builtIn).map(({ hasKey: _k, needsKey: _n, ...p }) => p);
  await invoke('ai.saveProviders', {
    providers: [
      ...own.filter((p) => p.id !== 'ollama-local' && p.id !== 'demo-ai'),
      { id: 'ollama-local', name: 'Ollama (local)', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', defaultModel: 'llama3.2' },
      {
        id: 'demo-ai',
        name: 'Offline demo model',
        kind: 'mock',
        baseUrl: 'mock://local',
        defaultModel: 'demo',
        headers: [
          {
            key: 'x-mock-rules',
            value: J([
              { match: 'required":\\["checks"', response: J({ checks: AI_CHECKS }) },
              { match: '"source"', response: J(AI_FLOW) },
            ]),
          },
        ],
      },
    ],
  });
  const appSettings = await invoke('settings.get');
  await invoke('settings.save', {
    ...appSettings,
    assistantProvider: 'demo-ai',
    assistantModel: 'demo',
    ai: { small: { provider: 'ollama-local', model: 'llama3.2' }, large: { provider: 'demo-ai', model: 'demo' }, localOnly: true, maxTokensPerCall: 16000, dailyTokens: 250000, dailyBudgetUsd: 2 },
  });
  // the window reads the settings when it starts: start it again (the workspace and the profile stay)
  const loaded = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.reload();
  await loaded;
  await js(HELPERS);
  await until(`document.body.innerText.includes('Veterinary API (example)') && __cap.one('nav [aria-label="Collections"]')`, 'the workspace to open again', 30000);
  park();

  // "What will be sent…": a request that cannot connect, its error's Explain with AI (a small task: the local model)
  await nav('Collections');
  await js(`(() => { const p = __cap.one('[aria-label="New tab"]'); p.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return true; })()`);
  await click('HTTP request', '[role=menuitem]');
  const URL_INPUT = `__cap.one('main input[aria-label="Request URL"]')`;
  await until(URL_INPUT, 'the URL field of the new request');
  await js(`__cap.input(${URL_INPUT}, 'http://127.0.0.1:1/patients?access_token=abcdef123456&page=2'); true`);
  await click('Send', 'main button');
  await until(`__cap.one('main [role=alert] [data-ai-preview-open]')`, 'the error with its AI action', 30000);
  await clickSel('main [role=alert] [data-ai-preview-open]', 'What will be sent…');
  await until(`__cap.one('[data-ai-preview] [data-ai-estimate]') && /stays on this computer/.test(__cap.text(__cap.one('[data-ai-preview] [data-ai-model]')))`, 'What will be sent, with the local model', 20000);
  await shot('ai-what-will-be-sent');
  await js(`__cap.key('Escape'); true`);
  await until(`!__cap.one('[data-ai-preview]')`, 'What will be sent to close');

  // a flow from a folder: Save as example on a new patient (so the flow can run on a mock), then the folder's menu
  /** A response action: a button when the panel is wide, else in its ⋯ menu. */
  const responseAction = async (label) => {
    const button = `__cap.all('main button').find((b) => __cap.text(b) === ${J(label)})`;
    if (await js(`!!${button}`)) return clickOn(button, label);
    await clickOn(`(() => { const m = __cap.one('main button[aria-label="Response actions"]'); m?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); return m; })()`, 'the response actions');
    await click(label, '[role=menuitem]');
  };
  // a fresh token (the earlier one may have expired while the shots above were taken)
  await openRequest('Get access token');
  await sendAndWait();
  await openRequest('Create patient');
  await click('Send', 'main button');
  await until(`/\\b201\\b/.test(__cap.screen()) && /Time \\d+ ms/.test(__cap.screen())`, 'the patient created');
  await responseAction('Save as example');
  await until(`__cap.byText('Save', '[role=dialog] button')`, 'the Save as example dialog');
  await click('Save', '[role=dialog] button');
  await until(`__cap.all('[data-sonner-toast]').some((t) => /Saved example/.test(__cap.text(t)))`, 'the example saved');
  const patients = `__cap.all('${EXPLORER} [data-tree-row][aria-expanded]').find((b) => __cap.text(b).startsWith('Patients'))`;
  const unfoldRest = `__cap.all('${EXPLORER} [data-tree-row][aria-expanded="false"]').find((b) => ['Veterinary API', 'REST'].some((n) => __cap.text(b).startsWith(n)))`;
  await until(`${patients} || ((${unfoldRest})?.click(), false)`, 'the Patients folder in the explorer');
  await js(`(() => { const r = ${patients}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 20, clientY: b.top + 8, button: 2 })); return true; })()`);
  await click('Generate integration flow with AI…', '[role=menuitem]');
  await until(`__cap.one('[data-flow-generate-dialog]') && /tokens in/.test(__cap.text(__cap.one('[data-flow-estimate]')))`, 'the Generate integration flow dialog with its estimate', 20000);
  await realClick(`__cap.one('[data-flow-generate-dialog] input[aria-label="Hint for the flow"]')`, 'the hint field');
  type('include a patient that does not exist');
  await until(`__cap.one('[data-flow-generate-dialog] input[aria-label="Hint for the flow"]').value.length > 10 && /tokens in/.test(__cap.text(__cap.one('[data-flow-estimate]')))`, 'the hint and the estimate');
  await shot('ai-flow-generate');
  await clickSel('[data-flow-generate]', 'Generate');
  await until(`__cap.one('[data-flow-proposal] [data-flow-node]') && __cap.all('[data-flow-proposal-badges] [data-verification]').length >= 3 && __cap.one('[data-flow-proposal-notes]')`, 'the flow proposal, verified', 30000);
  await shot('ai-flow-review');
  await clickSel('[data-proposal-discard]', 'Discard');
  await until(`!__cap.one('[data-flow-proposal]')`, 'the review to close');

  // Suggest assertions on a patient: the review opens by itself, a pinned id and owner flagged with safer forms
  await openRequest('Get patient');
  await sendAndWait();
  await responseAction('Suggest assertions');
  await until(`__cap.one('[data-proposal] [data-proposal-safer]') && __cap.all('[data-proposal] [data-proposal-item]').length >= 6`, 'the review of the suggested checks', 30000);
  await shot('ai-suggest-assertions');
  await clickOn(`__cap.all('[role=dialog] button').find((b) => __cap.text(b) === 'Close')`, 'Close');
  await until(`!__cap.one('[data-proposal]')`, 'the review to close');
  // the assistant ran the task in the right edge's panel: close it, and slide the panel away
  await js(`__cap.one('[aria-label="Close assistant"]')?.click(); true`);
  await clickSel('[aria-label="Assistant (unpinned panel)"]', 'the Assistant edge tab');
  await until(`!__cap.one('[role=region][aria-label="Assistant"]')`, 'the assistant panel to close');

  // Settings ▸ AI assistant: the models per task, Local only, the limits
  await nav('Settings');
  await tab('AI assistant');
  await until(`(() => { const p = __cap.one('[data-ai-settings]'); p?.scrollIntoView({ block: 'center' }); return p; })()`, 'the AI settings');
  await shot('settings-ai');

  // AI Lab ▸ Usage: the AI features' calls above, from the app
  await nav('AI Lab');
  await tab('Usage');
  await until(`__cap.one('[data-ai-feature-usage] table') && /generate-assertions/.test(__cap.screen('[data-ai-feature-usage]'))`, 'the AI features usage');
  await shot('ai-feature-usage');

  // ---------------------------------------------------------------- Explain and fix failures (triage), Why is this flaky?
  // (last of all: they change a saved request and add a test file). A collection run passes, then fails because its
  // check pins the id the server gave the new patient; a test that reads a background job before it is done fails, and
  // passes only after retries, a few runs in a row (flaky). The offline model's scripted answers name that result.
  const API = 'http://127.0.0.1:4010';
  const finished = async (runId, what) => {
    await until(`await window.aps.invoke('runs.summary', { runId: ${J(runId)} })`, what, 90000);
    return invoke('runs.summary', { runId });
  };
  const token = (await (await fetch(`${API}/auth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_id=demo&client_secret=demo-secret&grant_type=client_credentials' })).json()).access_token;
  // the id the server gives the next patient: one registered now says where its counter is
  const probe = await (await fetch(`${API}/patients`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: J({ name: 'Pepper', species: 'cat', ownerId: '456' }) })).json();
  const nextId = String(Number(probe.id) + 1);
  const vet = await invoke('col.get', { id: 'veterinary-api' });
  const findItem = (items, id) => {
    for (const i of items) {
      if (i.id === id) return i;
      const f = i.items && findItem(i.items, id);
      if (f) return f;
    }
  };
  const create = findItem(vet.items, 'req-create');
  create.assertions = [...(create.assertions ?? []), { type: 'equals', path: '$.id', expected: nextId }];
  await invoke('col.save', vet);
  const checkIndex = create.assertions.length - 1;
  const runCreate = async () => finished((await invoke('col.run', { collectionId: 'veterinary-api', selection: ['req-token', 'req-create'], name: 'Veterinary API', environment: 'Development' })).runId, 'the collection run');
  const passing = await runCreate();
  if (passing.failed || passing.errors) throw new Error(`the first run of Create patient should pass: ${J(passing)}`);
  const failing = await runCreate();
  if (failing.failed !== 1 || failing.errors) throw new Error(`the second run of Create patient should fail (the pinned id): ${J(failing)}`);
  const failed = (await invoke('runs.results', { runId: failing.runId, status: 'failed' })).items[0];
  if (!failed) throw new Error('no failed result in the triage run');
  const nowId = String(Number(nextId) + 1);
  const TRIAGE = {
    summary: 'Create patient pins the id of the new patient, which the server makes up.',
    causes: [
      {
        groups: ['g1'],
        kind: 'stale-test',
        title: "The new patient's id is pinned",
        explanation: `The check expects id "${nextId}"; the server gave the new patient "${nowId}" because the last passing run registered "${nextId}". The status is still 201: the API works, the expected id is out of date.`,
        confidence: 0.8,
        evidence: [`$.id is "${nowId}" in the failing response, "${nextId}" in the last passing one`, 'the status is 201 in both'],
        fix: { type: 'check', result: failed.id, checkIndex, replacement: { type: 'equals', path: '$.id', expected: nowId } },
      },
    ],
  };
  // the flaky test: Start the report, then Read it (running twice, then done); with retries it passes
  await nav('Tests');
  await addTestFile(
    'jobs/report.yaml',
    `# Starts the monthly report job and reads its result.
name: Monthly report
defaults:
  type: http
tests:
  - id: start
    name: Start the report
    method: POST
    url: "{{baseUrl}}/jobs"
    extract: { jobId: $.id }
    assertions:
      - { type: status, expected: 201 }
  - id: result
    name: Read the report
    dependsOn: start
    method: GET
    url: "{{baseUrl}}/jobs/{{jobId}}"
    assertions:
      - { type: status, expected: 200 }
      - { type: equals, path: $.status, expected: done }
`,
  );
  for (const retries of [0, 2, 0, 2, 0, 2]) await finished((await invoke('tests.run', { paths: ['jobs/report.yaml'], name: 'Monthly report', retries, environment: 'Development' })).runId, 'the report run');
  const FLAKY = {
    pattern: 'timing',
    title: 'The report is read before the job has finished',
    explanation: 'Every failing run read the job while it was still "running"; the passing runs read it once it was "done", after retries. The job finishes on its own a moment later: the test reads too early.',
    confidence: 0.9,
    evidence: ['$.status is "running" in every failing run and "done" in every passing one', 'it passed only after a retry'],
    fix: { type: 'step', set: { until: { if: "$.status == 'done'", every: '200ms', timeout: '10s' } } },
  };
  const providers = (await invoke('ai.providers')).filter((p) => !p.builtIn).map(({ hasKey: _k, needsKey: _n, ...p }) => p);
  const demo = providers.find((p) => p.id === 'demo-ai');
  const rules = JSON.parse(demo.headers.find((h) => h.key === 'x-mock-rules').value);
  demo.headers = [{ key: 'x-mock-rules', value: J([{ match: '"groups"', response: J(TRIAGE) }, { match: '"signals"', response: J(FLAKY) }, ...rules]) }];
  await invoke('ai.saveProviders', { providers });
  // the window starts again, so the Tests view lists the runs made above (the workspace and the profile stay)
  const reloaded = new Promise((r) => win.webContents.once('did-finish-load', r));
  win.webContents.reload();
  await reloaded;
  await js(HELPERS);
  await until(`document.body.innerText.includes('Veterinary API (example)') && __cap.one('nav [aria-label="Tests"]')`, 'the workspace to open again', 30000);
  park();
  await nav('Tests');

  // Runs ▸ right-click the failed run ▸ Explain and fix failures with AI…: the groups and the estimate
  await clickOn(`__cap.all('main [role=tab]').filter((x) => __cap.text(x).startsWith('Runs')).pop()`, 'the Runs tab');
  const failedRow = `__cap.one('[data-run-row="${failing.runId}"]')`;
  await until(failedRow, 'the failed run in Runs');
  await js(`(() => { const r = ${failedRow}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 10, button: 2 })); return true; })()`);
  await click('Explain and fix failures with AI…', '[role=menuitem]');
  await until(`__cap.one('[data-ai-analysis="triage"]') && /failure/.test(__cap.text(__cap.one('[data-ai-analysis-subject]'))) && /tokens in/.test(__cap.text(__cap.one('[data-ai-analysis-estimate]')))`, 'the triage dialog with its estimate', 20000);
  await shot('ai-triage-dialog');
  // Explain and fix: the cause with its evidence, the fix verified (it follows an API change) and TestPion's safer form
  await clickOn(`__cap.one('[role=dialog] [data-ai-analyse]')`, 'Explain and fix');
  await until(`__cap.one('[data-proposal] [data-finding]') && __cap.one('[data-proposal] [data-proposal-safer]')`, 'the triage review with its finding and the safer form', 30000);
  await shot('ai-triage-review');
  await clickOn(`__cap.all('[role=dialog] button').find((b) => __cap.text(b) === 'Close')`, 'Close');
  await until(`!__cap.one('[data-proposal]')`, 'the review to close');

  // Problems ▸ the flaky test ▸ Why is this flaky? ▸ Analyse ▸ Attempt to fix: the pattern, the signature, the verdict
  await clickSel('[data-status=problems]', 'the Problems count');
  const flakyRow = `__cap.all('[data-problem="flaky"]').find((r) => __cap.text(r).includes('Read the report'))`;
  await until(flakyRow, 'the flaky test in Problems');
  await js(`(() => { const r = ${flakyRow}; const b = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: b.left + 40, clientY: b.top + 8, button: 2 })); return true; })()`);
  await click('Why is this flaky?', '[role=menuitem]');
  await until(`__cap.one('[data-ai-analysis="flaky"]') && /tokens in/.test(__cap.text(__cap.one('[data-ai-analysis-estimate]')))`, 'the flaky dialog with its estimate', 20000);
  await clickOn(`__cap.one('[role=dialog] [data-ai-analyse]')`, 'Analyse');
  await until(`__cap.one('[data-proposal] [data-finding]') && __cap.one('[data-attempt-fix]:not([disabled])')`, 'the flaky review', 30000);
  await clickSel('[data-attempt-fix]', 'Attempt to fix');
  await until(`__cap.one('[data-attempt-verdict="stable"]') && /passed 5\\/5/.test(__cap.text(__cap.one('[data-attempt-verdict]')))`, 'the verdict of the attempt', 90000);
  await shot('ai-flaky-review');
  await clickOn(`__cap.all('[role=dialog] button').find((b) => __cap.text(b) === 'Close')`, 'Close');
  await until(`!__cap.one('[data-proposal]')`, 'the review to close');
};
