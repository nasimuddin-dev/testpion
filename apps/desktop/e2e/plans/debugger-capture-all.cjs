// The HTTP Debugger, "Capture all traffic": one click starts the proxy and points the system proxy at it (a stand-in
// here, so the run never touches the real setting), a program that follows the system proxy would show up; Stop puts the
// setting back. The button is hidden while the system proxy points at TestPion. The certificate question (a stand-in for the
// machine's trust: whichever branch this computer takes is reported) is declined, and the HTTPS menu asks again; nothing is installed.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect, step } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
const steps = [
  step(
    'one-click-capture-all',
    `await __t.view('Debugger');
      // one start control: no "Start capturing" button beside Capture all traffic
      const dup = ${button('Start capturing')};
      const b = await __t.waitFor(() => ${button('Capture all traffic')}, 6000); if (!b) return 'NO BUTTON';
      await __t.real.click(b);
      // the certificate question appears when this computer does not (or cannot tell if it does) trust the root: the plan never installs one
      const dialogButton = (t) => [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === t);
      const ask = await __t.waitFor(() => dialogButton('Keep HTTPS as tunnels') || [...document.querySelectorAll('main *')].map((x) => x.textContent?.trim() ?? '').find((t) => /the system proxy points here/.test(t)), 12000);
      const asked = !!dialogButton('Keep HTTPS as tunnels');
      if (asked) await __t.real.click(dialogButton('Keep HTTPS as tunnels'));
      const sub = await __t.waitFor(() => [...document.querySelectorAll('main *')].map((x) => x.textContent?.trim() ?? '').find((t) => /the system proxy points here/.test(t) && /Proxy address http:\\/\\/127\\.0\\.0\\.1:\\d+/.test(t)), 8000);
      const st = await window.aps.invoke('debug.status');
      const gone = !${button('Capture all traffic')};
      return (sub ? 'on' : 'NO STATUS') + ' | systemProxy: ' + st.systemProxy + ' | running: ' + st.running + ' | button hidden: ' + gone + ' | start button: ' + !!dup + ' | decrypt: ' + (asked ? st.decrypt === false : 'n/a');`,
  ),
  step(
    'https-menu-asks-again',
    `// declined once: the HTTPS menu still has the one-click path (or, when this computer trusts the root, decryption is already on)
      const st0 = await window.aps.invoke('debug.status');
      if (st0.decrypt) return 'already decrypting (trusted)';
      const trigger = document.querySelector('main button[aria-label="HTTPS (tunnels)"]'); if (!trigger) return 'NO HTTPS MENU';
      trigger.click(); await __t.sleep(500);
      const item = await __t.waitFor(() => [...document.querySelectorAll('[role=menuitem]')].find((m) => /^See inside HTTPS/.test(m.textContent.trim())), 3000); if (!item) return 'NO ITEM';
      item.click();
      const dlg = await __t.waitFor(() => [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === 'Keep HTTPS as tunnels'), 12000);
      const unsure = !dlg;
      if (dlg) await __t.real.click(dlg);
      else { const ok = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === 'Turn on decryption'); if (ok) { const c = [...document.querySelectorAll('[role=dialog] button')].find((x) => x.textContent.trim() === 'Keep HTTPS as tunnels'); c && (await __t.real.click(c)); } }
      await __t.waitFor(() => !document.querySelector('[role=dialog]'), 4000);
      return unsure ? 'no question (trust unknown or decryption went on)' : 'asked again';`,
  ),
  step(
    'stop-restores',
    `await __t.sleep(600);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await __t.sleep(300);
      await __t.real.click(${button('Stop')});
      const back = await __t.waitFor(() => ${button('Capture all traffic')}, 8000);
      const st = await window.aps.invoke('debug.status');
      return 'systemProxy: ' + st.systemProxy + ' | running: ' + st.running + ' | button back: ' + !!back;`,
  ),
];

module.exports = withExpect(
  steps,
  {
    'one-click-capture-all': /^on \| systemProxy: true \| running: true \| button hidden: true \| start button: false \| decrypt: (true|n\/a)$/,
    'https-menu-asks-again': /^(asked again|already decrypting \(trusted\)|no question .*)$/,
    'stop-restores': /^systemProxy: false \| running: false \| button back: true$/,
  },
  { env: { TESTPION_FAKE_SYSTEM_PROXY: '1' } },
);
