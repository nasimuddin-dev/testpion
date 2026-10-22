/**
 * Import this first in a renderer test: the browser stubs and the render counter go in before React loads (this module
 * imports nothing of React itself; tests/helpers-render.ts, which does, comes after).
 */
import { installBrowserStubs, installRenderCounter } from './helpers-render-hook';

installBrowserStubs();
installRenderCounter();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
