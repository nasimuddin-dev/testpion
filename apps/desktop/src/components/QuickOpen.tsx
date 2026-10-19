import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ITEM_KIND_LABEL, toItemRef, type ItemRef } from '@testpion/shared';
import { call } from '../api';
import { useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { recentItems } from '../lib/recent-items';
import { MODE_OF_PREFIX, quickOpenRows, parseQuickQuery, type QuickMode, type QuickRow } from '../lib/quick-open';
import { CommandPalette, type PaletteCommand } from './Shell';
import { refIcon } from './RefLink';
import { Sparkles } from 'lucide-react';
import { startAskSearch } from './ai/ask-search';

interface Hit {
  kind: string;
  id: string;
  title: string;
  subtitle?: string;
  ref?: unknown;
}

/**
 * WF-01: the command palette as Quick Open (lib/quick-open.ts): items by default (recent ones first, then the workspace
 * search), `>` commands, `@` the focused editor, `#` environments and variables, `?` help. One palette, one look.
 */
export function QuickOpen({ commands, here }: { commands: PaletteCommand[]; here: PaletteCommand[] }) {
  // the mode it opened in (store.paletteQuery: '' items, '>' commands, '#' environments; unset: commands)
  const base: QuickMode = MODE_OF_PREFIX[useApp((s) => s.paletteQuery) ?? '>'] ?? 'items';
  const workspace = useApp((s) => s.workspace);
  const active = useApp((s) => s.environment);
  const [hits, setHits] = useState<{ text: string; items: Hit[] }>();
  const seq = useRef(0);
  const baseRef = useRef(base);
  baseRef.current = base;
  const recent = useMemo(() => recentItems(), []);
  // the search runs on what is typed in items mode, a moment after the last key; an older answer never replaces a newer one
  const onQueryChange = useCallback((q: string) => {
    const { mode, text } = parseQuickQuery(q, baseRef.current);
    const n = ++seq.current;
    if (mode !== 'items' || !text) return;
    const t = setTimeout(() => {
      void call<Hit[]>('ws.search', { query: text }).then(
        (items) => n === seq.current && setHits({ text, items }),
        () => n === seq.current && setHits({ text, items: [] }),
      );
    }, 120);
    return () => clearTimeout(t);
  }, []);
  const resolve = useCallback(
    (q: string) => {
      const { text } = parseQuickQuery(q, base);
      const asRow = (c: PaletteCommand): QuickRow => ({ ...c });
      const r = quickOpenRows(
        q,
        {
          recent,
          hits: hits && hits.text === text ? hits.items.map((h) => ({ ...h, ref: toItemRef(h.ref) })) : undefined,
          commands: commands.map(asRow),
          here: here.map(asRow),
          environments: (workspace?.environments ?? [])
            .filter((e) => !e.problem)
            .map((e) => ({ id: e.id, name: e.name, production: !!e.isProduction, variables: (e.variables ?? []).map((v) => v.key).filter(Boolean) })),
          active,
          open: (ref: ItemRef) => void openRef(ref),
          ask: (question) => startAskSearch({ question }),
          switchEnvironment: (name) => useApp.getState().setEnvironment(name),
          setQuery: (p) => setTimeout(() => useApp.getState().set({ paletteOpen: true, paletteQuery: p }), 0),
          noun: (ref) => ITEM_KIND_LABEL[ref.kind],
        },
        base,
      );
      const byId = new Map([...commands, ...here].map((c) => [c.id, c]));
      return {
        commands: r.rows.map((row): PaletteCommand => byId.get(row.id) ?? { ...row, icon: row.id === 'ask' ? <Sparkles size={16} /> : row.ref ? refIcon(row.ref, 16) : undefined }),
        text: r.text,
        placeholder: r.placeholder,
        empty: r.empty,
      };
    },
    [recent, hits, commands, here, workspace, active, base],
  );
  // closed: the next opening is the plain command palette again (the top bar's Commands), and an answer on its way is dropped
  useEffect(
    () => () => {
      seq.current++;
      useApp.getState().set({ paletteQuery: undefined });
    },
    [],
  );
  return <CommandPalette key={base} commands={commands} resolve={resolve} onQueryChange={onQueryChange} label={base === 'commands' ? 'Command palette' : 'Quick open'} />;
}
