/** The switch that lets a packaged app run a capture script (the UI regression suite against an installed build, screenshots). */
export const CAPTURE_SWITCH = '--testpion-capture';

/**
 * The capture script the app may run, or undefined. `TESTPION_CAPTURE_SCRIPT` makes the app `require()` a module from its
 * environment with the main process's rights. A development build takes it as before. A packaged build ignores the variable
 * unless the program was also started with `--testpion-capture` on its command line: anything that can only set an
 * environment variable for the user's session (a shell profile, a launcher) must not turn the installed app into a Node
 * runtime. The suite that drives an installed build passes the switch.
 */
export function captureScript(env: NodeJS.ProcessEnv, argv: readonly string[], packaged: boolean): { script?: string; ignored?: string } {
  const script = env.TESTPION_CAPTURE_SCRIPT;
  if (!script) return {};
  if (!packaged || argv.includes(CAPTURE_SWITCH)) return { script };
  return { ignored: script };
}
