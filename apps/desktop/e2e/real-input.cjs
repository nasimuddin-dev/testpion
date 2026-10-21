/**
 * Real input for e2e steps: mouse, wheel and keys sent through Chromium's DevTools protocol (Input.dispatchMouseEvent,
 * Input.dispatchKeyEvent, Input.insertText) from the main process. Unlike events dispatched on an element from the page,
 * these go through hit-testing, pointer capture, focus, the click / dblclick / contextmenu synthesis and default
 * actions exactly as a user's do — so a plan finds the bugs a user would (an element under another, a capture that
 * retargets a click, a key a parent handler swallows).
 *
 * The harness calls install(win) once the debugger is attached, and injects PAGE after helpers.js. A step then uses
 *   await __t.real.click(target, { shift, ctrl, alt, button: 'right', dx, dy })   target: selector | element | { x, y }
 *   await __t.real.dblclick(target)        await __t.real.move(target)          await __t.real.rightClick(target)
 *   await __t.real.drag(from, to, { steps, shift })                             await __t.real.down(t) / up(t)
 *   await __t.real.wheel(target, deltaY, { ctrl })                              await __t.real.type('text')  (insertText)
 *   await __t.real.keys('abc')   (one keyDown / keyUp per character)            await __t.real.key('Delete', { ctrl })
 *   await __t.real.dnd(from, to, { steps, over })   an HTML5 drag and drop: the press and moves start the page's own drag
 *     (its dragstart sets the data), Chromium hands the drag to the protocol (Input.setInterceptDrags), and it is moved
 *     (dragEnter / dragOver, through `over` points first) and dropped at `to` with that data.
 *   await __t.real.dropFiles(to, ['C:/path/a.json', 'C:/path/folder'], { over })   files (or folders) dragged in from the OS:
 *     dragEnter / dragOver / drop with the paths as the drag's files, as the file manager's drag would carry them.
 * Each resolves once Chromium has dispatched the events (with 'ok', or 'ERR …').
 */
const BINDING = '__e2eReal';

function install(win) {
  const dbg = win.webContents.debugger;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** A real HTML5 drag: the page starts it (dragstart with its data), the protocol carries it to `to` and drops it. */
  const dragAndDrop = async ({ from, to, over = [], steps = 6 }) => {
    let data;
    const onMsg = (_e, method, params) => {
      if (method === 'Input.dragIntercepted') data = params.data;
    };
    dbg.on('message', onMsg);
    await dbg.sendCommand('Input.setInterceptDrags', { enabled: true });
    try {
      const mouse = (type, p, extra = {}) => dbg.sendCommand('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'none', ...extra });
      await mouse('mouseMoved', from);
      await mouse('mousePressed', from, { button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps && !data; i++) {
        await mouse('mouseMoved', { x: from.x + i * 4, y: from.y + i * 2 }, { button: 'left', buttons: 1 });
        await sleep(30);
      }
      for (let i = 0; i < 20 && !data; i++) await sleep(25);
      if (!data) throw new Error('the page started no drag (is the element draggable?)');
      const drag = (type, p) => dbg.sendCommand('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
      const path = [...over, to];
      await drag('dragEnter', path[0]);
      for (const p of path) {
        await drag('dragOver', p);
        await sleep(40);
      }
      await drag('drop', to);
    } finally {
      dbg.removeListener('message', onMsg);
      await dbg.sendCommand('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
      await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 }).catch(() => undefined);
    }
  };
  dbg.on('message', async (_e, method, params) => {
    if (method !== 'Runtime.bindingCalled' || params.name !== BINDING) return;
    let id = 0;
    let result = 'ok';
    try {
      const msg = JSON.parse(params.payload);
      id = msg.id;
      for (const c of msg.cmds) {
        if (c.t === 'wait') await sleep(c.ms);
        else if (c.t === 'mouse') await dbg.sendCommand('Input.dispatchMouseEvent', c.p);
        else if (c.t === 'key') await dbg.sendCommand('Input.dispatchKeyEvent', c.p);
        else if (c.t === 'text') await dbg.sendCommand('Input.insertText', { text: c.text });
        else if (c.t === 'dnd') await dragAndDrop(c);
        else if (c.t === 'dropFiles') {
          const data = { items: [], files: c.files, dragOperationsMask: 1 };
          const drag = (type, p) => dbg.sendCommand('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
          const path = [...c.over, c.to];
          await drag('dragEnter', path[0]);
          for (const p of path) {
            await drag('dragOver', p);
            await sleep(40);
          }
          await drag('drop', c.to);
        }
      }
    } catch (e) {
      result = `ERR ${e.message}`;
    }
    await dbg
      .sendCommand('Runtime.evaluate', { expression: `window.__e2eRealDone && window.__e2eRealDone(${JSON.stringify(id)}, ${JSON.stringify(result)})`, contextId: params.executionContextId })
      .catch(() => undefined);
  });
  return dbg.sendCommand('Runtime.addBinding', { name: BINDING });
}

const PAGE = `(() => {
  if (!window.__t) return;
  let seq = 0;
  const pending = new Map();
  window.__e2eRealDone = (id, r) => { const p = pending.get(id); pending.delete(id); if (p) p(r); };
  const send = (cmds) => typeof window.${BINDING} !== 'function' ? Promise.resolve('ERR no real input (debugger not attached)') : new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); window.${BINDING}(JSON.stringify({ id, cmds })); });
  const el = (t) => (typeof t === 'string' ? [...document.querySelectorAll(t)].find((x) => x.getClientRects().length) : t);
  /** The point of a target: an element's centre (plus dx, dy), or { x, y } as given. */
  const pt = (t, o = {}) => {
    const e = el(t);
    if (!e) throw new Error('no element ' + t);
    if (e instanceof Element) { const r = e.getBoundingClientRect(); return { x: r.left + (o.fx ?? 0.5) * r.width + (o.dx ?? 0), y: r.top + (o.fy ?? 0.5) * r.height + (o.dy ?? 0) }; }
    return { x: e.x + (o.dx ?? 0), y: e.y + (o.dy ?? 0) };
  };
  const mods = (o = {}) => (o.alt ? 1 : 0) | (o.ctrl ? 2 : 0) | (o.meta ? 4 : 0) | (o.shift ? 8 : 0);
  const m = (type, p, o = {}, extra = {}) => ({ t: 'mouse', p: { type, x: p.x, y: p.y, modifiers: mods(o), button: 'none', ...extra } });
  const wait = (ms) => ({ t: 'wait', ms });
  const btn = (o) => o.button ?? 'left';
  const bits = (b) => (b === 'right' ? 2 : b === 'middle' ? 4 : 1);
  const run = async (build) => { try { return await send(build()); } catch (e) { return 'ERR ' + e.message; } };
  const KEYS = { Enter: [13, 'Enter', '\\r'], Escape: [27, 'Escape'], Delete: [46, 'Delete'], Backspace: [8, 'Backspace'], Tab: [9, 'Tab'], ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'], F2: [113, 'F2'], F8: [119, 'F8'], F9: [120, 'F9'], F10: [121, 'F10'], ContextMenu: [93, 'ContextMenu'], ' ': [32, 'Space', ' '] };
  const keyEv = (key, o = {}) => {
    let vk, code, text;
    if (KEYS[key]) [vk, code, text] = KEYS[key];
    else if (/^[a-z]$/i.test(key)) { vk = key.toUpperCase().charCodeAt(0); code = 'Key' + key.toUpperCase(); text = key; }
    else if (/^[0-9]$/.test(key)) { vk = key.charCodeAt(0); code = 'Digit' + key; text = key; }
    else { vk = 0; code = ''; text = key; }
    // with Ctrl / Alt / Meta a key types nothing (a shortcut)
    if (o.ctrl || o.alt || o.meta) text = undefined;
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods(o) };
    return [{ t: 'key', p: { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) } }, { t: 'key', p: { type: 'keyUp', ...base } }];
  };
  const click = (t, o = {}, count = 1) => run(() => {
    const p = pt(t, o);
    const out = [m('mouseMoved', p, o), wait(16)];
    for (let c = 1; c <= count; c++) out.push(m('mousePressed', p, o, { button: btn(o), buttons: bits(btn(o)), clickCount: c }), wait(o.hold ?? 20), m('mouseReleased', p, o, { button: btn(o), buttons: 0, clickCount: c }), wait(40));
    return out;
  });
  window.__t.real = {
    pt,
    /** The pointer to a target ({ pressed: true }: with the left button held, a drag in progress). */
    move: (t, o = {}) => run(() => [m('mouseMoved', pt(t, o), o, o.pressed ? { button: 'left', buttons: 1 } : {}), wait(16)]),
    down: (t, o = {}) => run(() => { const p = pt(t, o); return [m('mouseMoved', p, o), wait(16), m('mousePressed', p, o, { button: btn(o), buttons: bits(btn(o)), clickCount: 1 })]; }),
    up: (t, o = {}) => run(() => [m('mouseReleased', pt(t, o), o, { button: btn(o), buttons: 0, clickCount: 1 })]),
    click: (t, o = {}) => click(t, o, 1),
    /**
     * A click on something that moves when the pointer arrives (a toast: the stack of toasts spreads out under the pointer): the
     * pointer goes there first, the target is waited for until it stops moving, and the click is made where it is now. The press
     * of a plain click lands on the place the target had before the pointer moved, so it hit the toast above or nothing.
     */
    clickSettled: async (t, o = {}) => {
      const e = el(t);
      if (!(e instanceof Element)) return click(t, o, 1);
      await run(() => [m('mouseMoved', pt(e, o), o), wait(16)]);
      let last = '';
      for (let i = 0, same = 0; i < 40 && same < 3; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const r = e.getBoundingClientRect();
        const now = [r.x, r.y, r.width, r.height].map(Math.round).join(',');
        same = now === last ? same + 1 : 0;
        last = now;
      }
      return click(e, o, 1);
    },
    dblclick: (t, o = {}) => click(t, o, 2),
    rightClick: (t, o = {}) => click(t, { ...o, button: 'right' }, 1),
    /** Press at \`from\`, move in \`steps\` steps to \`to\`, release there. */
    drag: (from, to, o = {}) => run(() => {
      const a = pt(from, o.from ?? {});
      const b = pt(to, o.to ?? {});
      const n = o.steps ?? 12;
      const out = [m('mouseMoved', a, o), wait(16), m('mousePressed', a, o, { button: 'left', buttons: 1, clickCount: 1 }), wait(30)];
      for (let i = 1; i <= n; i++) out.push(m('mouseMoved', { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, o, { button: 'left', buttons: 1 }), wait(o.stepMs ?? 16));
      out.push(wait(o.holdMs ?? 30), m('mouseReleased', b, o, { button: 'left', buttons: 0, clickCount: 1 }), wait(30));
      return out;
    }),
    wheel: (t, deltaY, o = {}) => run(() => { const p = pt(t, o); return [m('mouseMoved', p, o), m('mouseWheel', p, o, { deltaX: o.deltaX ?? 0, deltaY }), wait(30)]; }),
    /** Text into the focused element as an IME would (input events, no key events). */
    type: (text) => run(() => [{ t: 'text', text }, wait(20)]),
    /** One keyDown / keyUp per character (keydown handlers see every key). */
    keys: (text, o = {}) => run(() => [...text].flatMap((ch) => [...keyEv(ch, o), wait(8)])),
    key: (key, o = {}) => run(() => [...keyEv(key, o), wait(30)]),
    /** An HTML5 drag and drop from \`from\` to \`to\` (through \`over\` targets first): see dragAndDrop. */
    /** Files or folders from the OS dropped on a target (their absolute paths): the drag the file manager would start. */
    dropFiles: (to, files, o = {}) => run(() => [{ t: 'dropFiles', to: pt(to, o.to ?? {}), files, over: (o.over ?? []).map((x) => pt(x)) }, wait(120)]),
    dnd: (from, to, o = {}) => run(() => [{ t: 'dnd', from: pt(from, o.from ?? {}), to: pt(to, o.to ?? {}), over: (o.over ?? []).map((x) => pt(x)), steps: o.steps }, wait(60)]),
  };
})()`;

module.exports = { install, PAGE };
