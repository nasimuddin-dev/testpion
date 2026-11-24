// Portable mode (Windows): a folder named `data` next to TestPion.exe (the unpacked .zip build), or next to the portable
// .exe, makes that copy keep everything in it: workspaces, settings, saved secrets, the window's profile. Nothing is
// written to the person's profile folder, so the folder can live on a USB stick or a shared drive and be carried along.
// Without the folder the copy behaves like an installed one. A TESTPION_HOME set by hand wins (it is a choice already).
const { existsSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

/** The `data` folder this copy keeps everything in, or undefined when it is not in portable mode. */
function portableDataDir({ packaged, platform = process.platform, execPath = process.execPath, env = process.env, isDir = defaultIsDir } = {}) {
  if (!packaged || platform !== 'win32') return undefined;
  if (env.TESTPION_HOME) return undefined;
  // the portable .exe unpacks itself to a temporary folder on each start and says where it was started from
  const dir = join(env.PORTABLE_EXECUTABLE_DIR || dirname(execPath), 'data');
  return isDir(dir) ? dir : undefined;
}

function defaultIsDir(p) {
  try {
    return existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

module.exports = { portableDataDir };
