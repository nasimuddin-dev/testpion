// The HTTP Debugger, "Capture all traffic": one click starts the proxy and points the system proxy at it (a stand-in
// here, so the run never touches the real setting), a program that follows the system proxy would show up; Stop puts the
// setting back. The button is hidden while the system proxy points at TestPion.
// Part of the end-to-end UI regression suite (see e2e/run-e2e.mjs and .claude/skills/ui-regression).
const { withExpect } = require('../lib.cjs');

const button = (label) => `[...document.querySelectorAll('main button')].find((b) => b.offsetParent && b.textContent.trim() === ${JSON.stringify(label)})`;
const steps = [
  [
    'one-click-capture-all',
    `(async () => {
      await __t.view('Debugger');
      const b = await __t.waitFor(() => ${button('Capture all traffic')}, 6000); if (!b) return 'NO BUTTON';
      await __t.real.click(b);
      const sub = await __t.waitFor(() => [...document.querySelectorAll('main *')].map((x) => x.textContent?.trim() ?? '').find((t) => /the system proxy points here/.test(t) && /Proxy address http:\/\/127\.0\.0\.1:\d+/.test(t)), 8000);
      const st = await window.aps.invoke('debug.status');
      const gone = !${button('Capture all traffic')};
      return (sub ? 'on' : 'NO STATUS') + ' | systemProxy: ' + st.systemProxy + ' | running: ' + st.running + ' | button hidden: ' + gone;
    })()`,
  ],
  [
    'stop-restores',
    `(async () => {
      await __t.real.click(${button('Stop')});
      const back = await __t.waitFor(() => ${button('Capture all traffic')}, 8000);
      const st = await window.aps.invoke('debug.status');
      return 'systemProxy: ' + st.systemProxy + ' | running: ' + st.running + ' | button back: ' + !!back;
    })()`,
  ],
];

module.exports = withExpect(
  steps,
  {
    'one-click-capture-all': /^on \| systemProxy: true \| running: true \| button hidden: true$/,
    'stop-restores': /^systemProxy: false \| running: false \| button back: true$/,
  },
  { env: { TESTPION_FAKE_SYSTEM_PROXY: '1' } },
);
