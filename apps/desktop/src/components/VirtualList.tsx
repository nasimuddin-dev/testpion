import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { scaledRow, useDensity } from '../lib/density';
import { listWindow, windowKeys } from '../lib/list-window';
import { dedupeKeys, reportDuplicateKeys, reportsDuplicateKeys, type ListKey } from '../lib/unique-keys';

/** The element that scrolls `el` (its nearest ancestor with overflow auto or scroll). */
function scrollingAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p;
  return null;
}

/** No row paints outside the list's box (defence in depth: rows are absolutely placed inside it). */
const CONTAIN = 'layout paint';

/**
 * Fixed-row-height virtual list: renders only visible rows, so 1M rows cost the same as 50. With `scrollParent` it has
 * no scroll box of its own: it scrolls with the element around it (a tree in a sidebar with other sections above and
 * below it). `keyOf` keeps a row's component when rows above it come and go; keys are unique among the rows drawn (a
 * repeat is reported in development builds and drawn as a row of its own, see lib/unique-keys). `scrollKey` scrolls
 * to `scrollToIndex` again even when the index is the same. `keepIndex` keeps that row mounted while it is off
 * screen (the row being dragged). The container carries `data-virtual-list` and how many rows it draws
 * (`data-vl-drawn`); each row carries its key (`data-vl-key`), so a test can check them against the model.
 */
export function VirtualList<T>({
  items,
  rowHeight: givenRowHeight,
  render,
  className,
  overscan = 8,
  scrollToIndex,
  scrollKey,
  onEndReached,
  keyOf,
  scrollParent = false,
  keepIndex,
  name = 'VirtualList',
  role,
  label,
}: {
  items: T[];
  rowHeight: number;
  render(item: T, index: number): ReactNode;
  className?: string;
  overscan?: number;
  scrollToIndex?: number;
  scrollKey?: unknown;
  onEndReached?(): void;
  keyOf?(item: T, index: number): ListKey;
  scrollParent?: boolean;
  /** A row to keep drawn even when it is off screen (the row being dragged). */
  keepIndex?: number;
  /** Names the list in the development report of a repeated key. */
  name?: string;
  /** The list's role for screen readers (`tree` when its rows are tree items) and its name. */
  role?: string;
  label?: string;
}) {
  // rows follow the density (Settings ▸ Appearance): the given height is the comfortable one
  const rowHeight = scaledRow(givenRowHeight, useDensity());
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scrollFrame = useRef<number | undefined>(undefined);
  const pendingScrollTop = useRef(0);
  /** With scrollParent: the element that scrolls, and where the list starts in it. */
  const outer = useRef<{ box: HTMLElement; measure(): void } | undefined>(undefined);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!scrollParent) {
      const ro = new ResizeObserver(() => setHeight(el.clientHeight));
      ro.observe(el);
      setHeight(el.clientHeight);
      return () => ro.disconnect();
    }
    const box = scrollingAncestor(el);
    if (!box) return;
    // the part of the list on screen: from where the box's view starts (relative to the list's top) for the box's height
    const measure = () => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top;
      setScrollTop(-top);
      setHeight(box.clientHeight);
    };
    outer.current = { box, measure };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    const onScroll = () => {
      if (scrollFrame.current !== undefined) return;
      scrollFrame.current = requestAnimationFrame(() => {
        scrollFrame.current = undefined;
        measure();
      });
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      ro.disconnect();
      box.removeEventListener('scroll', onScroll);
      outer.current = undefined;
    };
  }, [scrollParent]);
  // what is above the list may have grown or shrunk with it (a section opened): measure again when the rows change
  useEffect(() => outer.current?.measure(), [items]);
  useEffect(() => {
    if (scrollToIndex === undefined || !ref.current) return;
    const el = ref.current;
    if (outer.current) {
      const { box } = outer.current;
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop + scrollToIndex * rowHeight;
      if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - rowHeight) box.scrollTop = Math.max(0, top - box.clientHeight / 3);
      return;
    }
    const top = scrollToIndex * rowHeight;
    if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - rowHeight) el.scrollTop = Math.max(0, top - el.clientHeight / 3);
  }, [scrollToIndex, rowHeight, scrollKey]);
  useEffect(
    () => () => {
      if (scrollFrame.current !== undefined) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );
  // development builds check the whole list once per change of it (a repeat off screen is a bug too)
  const keyOfRef = useRef(keyOf);
  keyOfRef.current = keyOf;
  useEffect(() => {
    const k = keyOfRef.current;
    if (!k || !reportsDuplicateKeys()) return;
    const r = dedupeKeys(items.map(k));
    if (r.duplicates.length) reportDuplicateKeys(name, r.duplicates, (i) => items[i]);
  }, [items, name]);
  const { end, indexes } = listWindow({ count: items.length, rowHeight, scrollTop, height, overscan, keepIndex });
  useEffect(() => {
    if (onEndReached && end >= items.length - 5 && items.length) onEndReached();
  }, [end, items.length, onEndReached]);
  const { keys } = windowKeys(items, indexes, keyOf);
  const rows: ReactNode[] = indexes.map((i, at) => (
    <div key={keys[at]} data-vl-key={keys[at]} style={{ position: 'absolute', top: i * rowHeight, height: rowHeight, left: 0, right: 0 }}>
      {render(items[i]!, i)}
    </div>
  ));
  if (scrollParent)
    return (
      <div ref={ref} className={`relative${className ? ` ${className}` : ''}`} style={{ height: items.length * rowHeight, contain: CONTAIN }} data-virtual-list={name} data-vl-drawn={rows.length} role={role} aria-label={label}>
        {rows}
      </div>
    );
  return (
    <div
      ref={ref}
      className={`overflow-auto relative${className ? ` ${className}` : ''}`}
      style={{ contain: CONTAIN }}
      data-virtual-list={name}
      data-vl-drawn={rows.length}
      role={role}
      aria-label={label}
      onScroll={(e) => {
        pendingScrollTop.current = e.currentTarget.scrollTop;
        // Scrolling can emit far more events than frames. Coalescing updates
        // keeps large lists responsive while preserving the same visible rows.
        if (scrollFrame.current !== undefined) return;
        scrollFrame.current = requestAnimationFrame(() => {
          scrollFrame.current = undefined;
          setScrollTop(pendingScrollTop.current);
        });
      }}
    >
      <div style={{ height: items.length * rowHeight, position: 'relative' }}>{rows}</div>
    </div>
  );
}
