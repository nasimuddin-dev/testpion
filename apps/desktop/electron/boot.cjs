// The Electron main process's entry (package.json "main"; scripts/build-main.mjs copies it to dist-electron/): it turns
// on V8's compile cache, so the main bundle (main.cjs, several MB) starts from the code compiled at an earlier start
// instead of being parsed and compiled again, then loads the bundle.
const { existsSync } = require('node:fs');
const { join } = require('node:path');
try {
  const { app } = require('electron');
  const appData = app.getPath('appData');
  // the profile main.ts picks: the test profile of screenshots and the UI regression suite (never the user's), or a
  // profile from before the TestPion name (creating a TestPion folder here would make main.ts stop using it)
  const legacy = !existsSync(join(appData, 'TestPion')) && ['FluxPion', 'ProtoPion', 'Protolens'].map((n) => join(appData, n)).find((d) => existsSync(d));
  const capture = process.env.TESTPION_CAPTURE_SCRIPT && process.env.TESTPION_HOME;
  const dir = capture ? join(process.env.TESTPION_HOME, 'electron-profile') : legacy || app.getPath('userData');
  require('node:module').enableCompileCache?.(join(dir, 'v8-cache'));
} catch {
  /* no cache: the bundle is compiled as usual */
}
require('./main.cjs');
