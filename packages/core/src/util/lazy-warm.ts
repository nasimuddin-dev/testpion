/**
 * The libraries that load on first use (LAZY_MODULES in the desktop build, nodeRequire here) and are then used in the middle of
 * work the person watches: a JSONPath check on a response, a YAML test file, a WSDL. In Electron the main thread also drives
 * the window, so a first synchronous load of one of them during a capture skips frames (perf-debugger measured 200 ms gaps).
 * The host calls this once the window is up and idle: each library is loaded in its own turn of the event loop, so no single
 * stall is longer than one library's parse, and the start itself stays as fast as before.
 */
import { queryAll } from './jsonpath.js';
import { yaml } from './lazy-yaml.js';
import { warmXmlParser } from '../import/wsdl.js';

const STEPS: Array<() => unknown> = [() => yaml(), () => queryAll({ a: 1 }, '$.a'), () => warmXmlParser()];

/** Load the hot-path libraries one per tick; errors are swallowed (a library that fails to load fails the same way at first use). */
export function warmLazyLibraries(schedule: (fn: () => void) => void = (fn) => setTimeout(fn, 0)): void {
  const next = (i: number) => {
    if (i >= STEPS.length) return;
    schedule(() => {
      try {
        STEPS[i]!();
      } catch {
        /* reported at first real use */
      }
      next(i + 1);
    });
  };
  next(0);
}
