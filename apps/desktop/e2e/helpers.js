window.__t = (() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  /** Wait until `fn()` is truthy (checked every 50 ms), at most `ms`; returns its value or undefined. */
  const waitFor = async (fn, ms = 2000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const v = fn();
      if (v) return v;
    }
    return undefined;
  };
  const aside = () => document.querySelector('aside[aria-label="Collections explorer"]');
  const rows = () => [...(aside()?.querySelectorAll('[data-tree-row]') ?? [])];
  const row = (text) => rows().find((b) => b.textContent.trim() === text) ?? rows().find((b) => b.textContent.trim().endsWith(text)) ?? rows().find((b) => b.textContent.includes(text));
  const esc = async () => {
    for (let i = 0; i < 3; i++) {
      const el = document.querySelector('[role=menu]') || document.querySelector('[role=dialog]');
      if (!el) break;
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(350);
    }
  };
  return {
    sleep,
    waitFor,
    esc,
    view: async (label) => { await esc(); document.querySelector(`nav [aria-label="${label}"]`)?.click(); await sleep(1200); return !!document.querySelector(`nav [aria-label="${label}"][aria-current="page"]`); },
    requests: async () => { await esc(); window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, altKey: true, bubbles: true })); await sleep(1200); return !!aside(); },
    expand: async (text) => { const r = row(text); if (!r) return `NO ROW ${text}`; if (r.getAttribute('aria-expanded') === 'false') r.click(); await sleep(500); return 'ok'; },
    open: async (text) => { const r = row(text); if (!r) return `NO ROW ${text}`; r.click(); await sleep(1800); return 'ok'; },
    // a new tab of a kind (WebSocket, GraphQL, gRPC …) from the tab strip's + menu (a request opens first, so the strip is there)
    newTab: async (label) => {
      await esc();
      if (!document.querySelector('[aria-label="New tab"]')) { await window.__t.requests(); await window.__t.find('Custom headers'); }
      const plus = document.querySelector('[aria-label="New tab"]');
      if (!plus) return 'NO NEW TAB BUTTON';
      plus.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); await sleep(500);
      const item = [...document.querySelectorAll('[role=menuitem]')].find((x) => x.textContent.trim().startsWith(label));
      item?.click(); await sleep(1500);
      return item ? 'ok' : `NO MENU ITEM ${label}`;
    },
    // open an item anywhere in the explorer (collapsed collections, categories, API definitions): filter, click, clear
    find: async (text) => {
      const f = document.querySelector('aside input[placeholder^="Filter"]');
      if (!f) return `NO FILTER`;
      const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(f, v); f.dispatchEvent(new Event('input', { bubbles: true })); };
      set(text); await sleep(900);
      const r = [...document.querySelectorAll('aside [data-tree-row], aside button')].find((b) => b.offsetParent && b.getAttribute('aria-expanded') === null && b.textContent.trim().endsWith(text));
      r?.click(); await sleep(1800);
      set(''); await sleep(400);
      return r ? 'ok' : `NO ROW ${text}`;
    },
    menu: async (text) => {
      await esc();
      const r = row(text);
      if (!r) return `NO ROW ${text}`;
      (r.closest('[draggable]') || r.parentElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: Math.min(500, r.getBoundingClientRect().top + 10) }));
      // wait for the menu (a closing menu can swallow the first right-click: then right-click once more)
      if (!(await waitFor(() => document.querySelector('[role=menu]'), 1200))) {
        (r.closest('[draggable]') || r.parentElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 160, clientY: Math.min(500, r.getBoundingClientRect().top + 10) }));
        await waitFor(() => document.querySelector('[role=menu]'), 1500);
      }
      await sleep(150);
      return [...document.querySelectorAll('[role=menu]:last-of-type [role=menuitem]')].map((m) => m.textContent.trim()).join(' | ') || 'NO MENU';
    },
    header: async (label) => { await esc(); aside()?.querySelector(`button[aria-label^="${label}"]`)?.click(); await sleep(1000); return (document.querySelector('[role=dialog]')?.innerText ?? document.querySelector('[role=menu]')?.innerText ?? 'NOTHING').slice(0, 80); },
    tab: async (label) => { const all = [...document.querySelectorAll('main [role=tab]')].filter((x) => x.textContent.trim().startsWith(label)); const t = all.find((x) => x.offsetParent !== null) ?? all[0]; t?.click(); await sleep(900); return !!t; },
    // a response action: a button when the panel is wide, else an item of its ⋯ menu ("Response actions")
    responseAction: async (label) => {
      let b = [...document.querySelectorAll('main button')].find((x) => x.offsetParent && x.textContent.trim() === label);
      if (!b) {
        const more = [...document.querySelectorAll('main button[aria-label="Response actions"]')].find((x) => x.offsetParent);
        if (!more) return false;
        more.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); more.click();
        b = await waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => m.textContent.trim() === label), 1500);
        if (!b) return false;
      }
      b.click(); await sleep(1200); return true;
    },
    button: async (label) => { const b = [...document.querySelectorAll('main button')].find((x) => x.offsetParent && (x.textContent.trim() === label || x.getAttribute('aria-label') === label)); b?.click(); await sleep(1200); return !!b; },
    key: async (k, mods = {}) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...mods })); await sleep(900); return (document.querySelector('[role=dialog]')?.innerText ?? 'NONE').slice(0, 60); },
    tabMenu: async () => { await esc(); const t = document.querySelector('[role=tablist][aria-label="Open requests"] [role=tab][aria-selected="true"]'); const open = () => t?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 400, clientY: 60 })); open(); if (!(await waitFor(() => document.querySelector('[role=menuitem]'), 1200))) { open(); await waitFor(() => document.querySelector('[role=menuitem]'), 1500); } await sleep(150); return [...document.querySelectorAll('[role=menuitem]')].map((m) => m.textContent.trim()).join(' | ') || 'NO MENU'; },
    crumb: () => [...document.querySelectorAll('nav[aria-label="Where this request is saved"]')].filter((n) => n.offsetParent).map((n) => n.innerText.replace(/\n/g, ' › ')).join(''),
    visibleText: () => { const c = document.querySelector('main > div.relative'); const v = c && [...c.children].find((d) => d.style.display !== 'none'); return (v?.innerText ?? document.querySelector('main')?.innerText ?? '').slice(0, 120).replace(/\n/g, ' · '); },
    varPopover: async () => { const inp = [...document.querySelectorAll('main input')].find((i) => i.offsetParent && /\{\{/.test(i.value)); if (!inp) return 'NO VAR FIELD'; const m = /\{\{/.exec(inp.value); inp.focus(); inp.setSelectionRange(m.index + 3, m.index + 3); inp.dispatchEvent(new MouseEvent('click', { bubbles: true })); await sleep(800); return (document.querySelector('[role=dialog][aria-label^="Variable"]')?.innerText ?? 'NONE').slice(0, 80).replace(/\n/g, ' '); },
  };
})();
'ready'
