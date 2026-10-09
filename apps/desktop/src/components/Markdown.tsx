import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { cx } from './ui';

type Render = (source: string) => string;
let render: Render | undefined;
let loading: Promise<Render> | undefined;

/** The Markdown parser and the sanitiser load with the first Markdown shown, not at startup. */
function loadRenderer(): Promise<Render> {
  return (loading ??= Promise.all([import('dompurify'), import('marked')]).then(([{ default: DOMPurify }, { marked }]) => {
    // links open in the system browser (Electron routes window.open to shell.openExternal)
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')?.match(/^https?:/i)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    return (render = (source) => DOMPurify.sanitize(marked.parse(source, { gfm: true, async: false }) as string, { ADD_ATTR: ['target'] }));
  }));
}

/** Render Markdown (GitHub flavoured) as sanitised HTML. In-page `#anchor` links scroll within the view. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const [ready, setReady] = useState(!!render);
  useEffect(() => {
    if (!ready) void loadRenderer().then(() => setReady(true));
  }, [ready]);
  const html = useMemo(() => (ready && render ? render(source) : ''), [source, ready]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!href?.startsWith('#')) return;
    e.preventDefault();
    e.currentTarget.querySelector(`[id="${CSS.escape(decodeURIComponent(href.slice(1)))}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  return <div className={cx('markdown', className)} aria-busy={!ready || undefined} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
