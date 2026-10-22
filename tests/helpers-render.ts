import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { ReactElement } from 'react';

/**
 * Rendering the window's components in unit tests, without a DOM (react-test-renderer). Import tests/helpers-render-setup
 * before this module: it installs the browser stubs and the render counter (tests/helpers-render-hook.ts) before React
 * loads. In a test:
 *
 *   const r = await render(createElement(ConsolePanel));
 *   renders.reset(); ... act ...; renders.mounts('ConsoleRow') === 1
 */
export { renders } from './helpers-render-hook';

/** Render an element, settled (effects run), with a mock ref object for host nodes (scrollIntoView and friends). */
export async function render(el: ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(el, { createNodeMock: () => ({ scrollIntoView() {}, focus() {}, getBoundingClientRect: () => ({ top: 0, left: 0, width: 800, height: 600 }), clientHeight: 600, clientWidth: 800, scrollTop: 0, scrollHeight: 0 }) });
  });
  return r;
}

/** Every instance under the root whose props match. */
export const findAll = (r: ReactTestRenderer, pred: (i: ReactTestInstance) => boolean): ReactTestInstance[] => r.root.findAll(pred);

export { act };
