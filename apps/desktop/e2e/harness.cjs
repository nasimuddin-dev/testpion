/**
 * Runs an end-to-end plan inside the app's main process (TESTPION_CAPTURE_SCRIPT points here; see run-e2e.mjs).
 * Each step's code runs in the window; its result, a screenshot and the window's console errors go to
 * E2E_OUT/report.json. The runner (run-e2e.mjs) checks the results against the plan's expectations.
 *
 * Env: E2E_PLAN (plan file), E2E_OUT (output folder), E2E_STUB_OPEN / E2E_STUB_SAVE (answer the next native
 * open / save dialogs with this path; E2E_STUB_SAVE=CANCEL cancels).
 */
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function run(win) {
  const OUT = process.env.E2E_OUT;
  const { dialog } = require('electron');
  if (process.env.E2E_STUB_OPEN) dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [process.env.E2E_STUB_OPEN] });
  if (process.env.E2E_STUB_SAVE)
    dialog.showSaveDialog = async () => (process.env.E2E_STUB_SAVE === 'CANCEL' ? { canceled: true, filePath: '' } : { canceled: false, filePath: process.env.E2E_STUB_SAVE });
  const errors = [];
  const steps = [];
  win.webContents.on('console-message', (e, level, message) => {
    const lvl = typeof level === 'number' ? level : e?.level;
    const msg = typeof message === 'string' ? message : e?.message;
    // "ResizeObserver loop completed with undelivered notifications" is the browser saying a layout settled a frame late (Monaco in a resized pane); not an app error
    if ((lvl === 3 || lvl === 'error') && !/ResizeObserver loop/.test(String(msg))) errors.push(String(msg).slice(0, 400));
  });
  // uncaught exceptions with their stack (the console message alone is often just "x is not a function")
  try {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.on('message', (_e, method, params) => {
      if (method === 'Runtime.exceptionThrown') errors.push(String(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text).slice(0, 1200));
    });
    await win.webContents.debugger.sendCommand('Runtime.enable');
  } catch {
    // another debugger is attached (DevTools): console errors still count
  }
  win.setContentSize(1440, 900);
  win.show();
  await sleep(6000);
  const js = (code) => win.webContents.executeJavaScript(code).catch((e) => `ERR ${e.message}`);
  // React / scheduler internals, which every profile is full of; what matters is which app function sits above them
  const REACT = /^(reconcile|commit|update|begin|complete|perform|render|flush|schedule|dispatch|mount|use[A-Z]|work|prepare|finish|markUpdate|get[A-Z]|is[A-Z]|create|push|pop|set|track|read|resolve|throw|handle|bailout|attempt|run|ensure|process|enqueue|clone|reuse|append|insert|remove|prop|diff|safely|recursively|cancel|request|detach|retry|jsx|Fragment|Component|Element|Portal|Provider|Consumer|Lazy|Memo|ForwardRef|Suspense|Offscreen|Profiler|Mode|Fiber|Root|Hook|Context|Ref|Effect|Transition|Priority|Lane|Sync|Idle|Passive|Layout|Host|Text|Native|Dom|Event|listen|batched|discrete|continuous|default|unstable|scheduler|invoke|call|apply|bind|map|forEach|filter|reduce|find|some|every|slice|concat|join|split|indexOf|includes|Object|Array|String|Number|Boolean|Symbol|Map|Set|WeakMap|Promise|JSON|Math|Date|RegExp|Error|Function|Reflect|Proxy|console|window|document|performance|requestAnimationFrame|setTimeout|clearTimeout|queueMicrotask|MessageChannel|anonymous)/;
  const profile = async (name, code) => {
    const dbg = win.webContents.debugger;
    await dbg.sendCommand('Profiler.enable');
    await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 200 });
    await dbg.sendCommand('Profiler.start');
    const result = await js(`(async () => ${code})()`);
    const { profile: prof } = await dbg.sendCommand('Profiler.stop');
    writeFileSync(join(OUT, `${name}.cpuprofile`), JSON.stringify(prof));
    // inclusive time per app function (React internals left out): a sample counts once for each function on its stack
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const counts = new Map();
    for (const id of prof.samples) counts.set(id, (counts.get(id) ?? 0) + 1);
    const total = prof.samples.length;
    const incl = new Map();
    for (const [id, c] of counts) {
      const seen = new Set();
      for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const f = byId.get(cur).callFrame;
        const file = (f.url || '').split('/').pop();
        if (!f.functionName || !file || REACT.test(f.functionName)) continue; // app code only (React's own functions left out)
        const key = `${f.functionName} ${file.replace(/-[\w-]+\.js$/, '')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        incl.set(key, (incl.get(key) ?? 0) + c);
      }
    }
    const top = [...incl].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, c]) => `${((c / total) * 100).toFixed(0)}% ${k}`);
    return `${result} | profile (${total} samples): ${top.join(' · ')}`;
  };
  await js(readFileSync(join(__dirname, 'helpers.js'), 'utf8'));
  const plan = require(process.env.E2E_PLAN);
  let n = 0;
  for (const step of plan) {
    const [name, code, shot = true] = step;
    const errorsBefore = errors.length;
    const started = Date.now();
    // "main:" steps run here, in the main process, outside the app's own code: like another editor or `git pull`
    // changing files (they get `require` and `home`, the test's TESTPION_HOME)
    // "profile:" steps run the renderer code under the CPU profiler and write <step>.cpuprofile (open it in
    // DevTools ▸ Performance) plus the top self-time functions into the result
    const result = code.startsWith('main:')
      ? await new (Object.getPrototypeOf(async () => {}).constructor)('require', 'home', code.slice(5))(require, process.env.TESTPION_HOME).then(
          (r) => (r === undefined ? 'done' : r),
          (e) => `ERR ${e.message}`,
        )
      : code.startsWith('profile:')
        ? await profile(name, code.slice(8))
        : await js(`(async () => ${code})()`);
    const entry = { name, result: typeof result === 'string' ? result : JSON.stringify(result), ms: Date.now() - started, errors: errors.slice(errorsBefore) };
    if (shot !== false) {
      await sleep(700);
      entry.screenshot = `${String(++n).padStart(2, '0')}-${name}.png`;
      writeFileSync(join(OUT, entry.screenshot), (await win.webContents.capturePage()).toPNG());
    }
    steps.push(entry);
  }
  writeFileSync(join(OUT, 'report.json'), JSON.stringify({ steps, errors }, null, 2));
};
