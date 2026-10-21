import { existsSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the app keeps its data (workspace list, settings, trust decisions): a module of its own so light modules can find it without importing the workspace store. */
export function defaultAppDir(): string {
  // earlier names of the variable: FLUXPION_HOME (0.5), PROTOPION_HOME (0.4), PROTOLENS_HOME (0.2–0.3), APS_HOME (0.1)
  const explicit = process.env.TESTPION_HOME || process.env.FLUXPION_HOME || process.env.PROTOPION_HOME || process.env.PROTOLENS_HOME || process.env.APS_HOME;
  if (explicit) return explicit;
  const dir = join(homedir(), '.testpion');
  // one-time move of the data folder of earlier versions: ".fluxpion" (0.5), ".protopion" (0.4), ".protolens" (0.2–0.3), ".aipstudio" (0.1)
  for (const legacy of [join(homedir(), '.fluxpion'), join(homedir(), '.protopion'), join(homedir(), '.protolens'), join(homedir(), '.aipstudio')]) {
    if (existsSync(dir) || !existsSync(legacy)) continue;
    try {
      renameSync(legacy, dir);
    } catch {
      return legacy; // in use or not permitted: keep using it rather than losing data
    }
  }
  return dir;
}
