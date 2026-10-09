// Not part of the suite (the _ prefix): when each step of the start happened in the main process (main.ts records
// them: the bundle loaded, Electron ready, window created, backend ready, page loaded, ready to show), how long the
// main process has been up when the first step runs, and the renderer's own timing: navigation to load, and the
// scripts it loaded.
const { withExpect, step } = require('../lib.cjs');
module.exports = withExpect(
  [
    [
      'main-marks',
      `(async () => { const s = await window.aps.startup(); const m = s?.marks ?? {}; return 'marks (ms since start): ' + ['mainLoaded', 'electronReady', 'windowCreated', 'backendReady', 'domReady', 'didFinishLoad', 'readyToShow', 'shown'].filter((k) => m[k] !== undefined).map((k) => k + ' ' + m[k]).join(' | ') + ' | backend constructed in ' + s?.backendMs + ' ms'; })()`,
      false,
    ],
    [
      'main-uptime',
      `main: return 'main uptime ms: ' + Math.round(process.uptime() * 1000) + ' | heap MB ' + Math.round(process.memoryUsage().heapUsed / 1048576) + ' | rss MB ' + Math.round(process.memoryUsage().rss / 1048576);`,
      false,
    ],
    step(
      'renderer-timing',
      `const n = performance.getEntriesByType('navigation')[0]; const res = performance.getEntriesByType('resource').filter((r) => /\\.js$/.test(r.name)); const js = res.reduce((s, r) => s + (r.transferSize || r.encodedBodySize || 0), 0);
    return 'dom loaded ms: ' + Math.round(n.domContentLoadedEventEnd) + ' | load ms: ' + Math.round(n.loadEventEnd) + ' | js files: ' + res.length + ' | js KB: ' + Math.round(js / 1024) + ' | scripts: ' + res.map((r) => r.name.split('/').pop().replace(/-[\\w-]+\\.js$/, '') + ' ' + Math.round((r.transferSize || r.encodedBodySize) / 1024) + 'KB').join(', ');`,
      false,
    ),
  ],
  { 'main-marks': /marks \(ms since start\): mainLoaded \d+ \| electronReady \d+ \| windowCreated \d+ \| backendReady \d+/ },
);
