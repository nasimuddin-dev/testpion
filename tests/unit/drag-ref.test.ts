import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// menus-uniform P0-1: every drag shows one small chip (never a snapshot of a row the OS could leave on screen), the chip
// is removed a frame later, and a window-level session clears every tree's drag state however the drag ends.

/** A minimal DOM: an element that can be appended and removed, a body, a window that dispatches events. */
class FakeEl {
  textContent = '';
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  parent?: FakeBody;
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  remove() {
    this.parent?.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = undefined;
  }
}
class FakeBody {
  children: FakeEl[] = [];
  appendChild(el: FakeEl) {
    el.parent = this;
    this.children.push(el);
  }
}
const body = new FakeBody();
const frames: Array<() => void> = [];
const win = new EventTarget();
const g = globalThis as Record<string, unknown>;
const saved = { window: g.window, document: g.document, requestAnimationFrame: g.requestAnimationFrame };

beforeAll(() => {
  g.window = win;
  g.document = { createElement: () => new FakeEl(), body };
  g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
});
afterAll(() => Object.assign(g, saved));

const dataTransfer = () => {
  const data = new Map<string, string>();
  return {
    effectAllowed: 'move',
    get types() {
      return [...data.keys()];
    },
    setData: (k: string, v: string) => void data.set(k, v),
    getData: (k: string) => data.get(k) ?? '',
    setDragImage: vi.fn(),
  };
};

describe('drag image chip and drag session', () => {
  it('setDragRefs sets a detached chip as the drag image and removes it after a frame', async () => {
    const { setDragRefs, readDragRefs } = await import('../../apps/desktop/src/lib/drag-ref');
    const dt = dataTransfer();
    setDragRefs({ dataTransfer: dt } as unknown as DragEvent, [{ kind: 'request', collectionId: 'c', requestId: 'r' }], 'GET Wikipedia edits, live');
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    const [chip, x, y] = dt.setDragImage.mock.calls[0]!;
    expect((chip as FakeEl).textContent).toBe('GET Wikipedia edits, live');
    expect([x, y]).toEqual([8, 8]);
    expect(body.children).toEqual([chip]);
    expect((chip as FakeEl).style.position).toBe('fixed');
    frames.splice(0).forEach((f) => f());
    expect(body.children).toEqual([]);
    expect(dt.effectAllowed).toBe('copyMove');
    expect(readDragRefs({ dataTransfer: dt } as unknown as DragEvent)).toEqual([{ kind: 'request', collectionId: 'c', requestId: 'r' }]);
    // several items: one chip that counts them; a second drag replaces the first chip
    const dt2 = dataTransfer();
    setDragRefs(
      { dataTransfer: dt2 } as unknown as DragEvent,
      [
        { kind: 'request', collectionId: 'c', requestId: 'r' },
        { kind: 'request', collectionId: 'c', requestId: 's' },
      ],
      'x',
    );
    setDragRefs({ dataTransfer: dataTransfer() } as unknown as DragEvent, [{ kind: 'collection', collectionId: 'c' }], 'y');
    expect((dt2.setDragImage.mock.calls[0]![0] as FakeEl).textContent).toBe('2 items');
    expect(body.children).toHaveLength(1);
    frames.splice(0).forEach((f) => f());
    expect(body.children).toHaveLength(0);
    win.dispatchEvent(new Event('dragend'));
  });

  it('a drag session ends on drop, dragend, Escape, pointerdown and window blur; other keys do not end it', async () => {
    const { setDragRefs, onDragSessionEnd } = await import('../../apps/desktop/src/lib/drag-ref');
    const clear = vi.fn();
    const off = onDragSessionEnd(clear);
    const start = () => setDragRefs({ dataTransfer: dataTransfer() } as unknown as DragEvent, [{ kind: 'collection', collectionId: 'c' }], 'c');
    const key = (k: string) => Object.assign(new Event('keydown'), { key: k });
    let n = 0;
    for (const end of [new Event('drop'), new Event('dragend'), key('Escape'), new Event('pointerdown'), new Event('blur')]) {
      start();
      win.dispatchEvent(key('a'));
      expect(clear).toHaveBeenCalledTimes(n);
      win.dispatchEvent(end);
      expect(clear).toHaveBeenCalledTimes(++n);
      // the listeners are gone once it ended: nothing more is cleared until the next drag
      win.dispatchEvent(new Event('drop'));
      expect(clear).toHaveBeenCalledTimes(n);
    }
    off();
    start();
    win.dispatchEvent(new Event('drop'));
    expect(clear).toHaveBeenCalledTimes(n);
    frames.splice(0).forEach((f) => f());
  });

  it('a drop action runs after the drop event', async () => {
    vi.useFakeTimers();
    try {
      const { deferDrop } = await import('../../apps/desktop/src/lib/drag-ref');
      const action = vi.fn();
      deferDrop(action);
      expect(action).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(action).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
