import { CheckSquare, ListChecks, Square, Terminal } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { compileWhere, parseWhere, type DebuggerCommand } from '@testpion/shared';
import { useApp } from '../../store';
import { plural } from '../../lib/format';
import { setDebuggerCommandHandler } from '../../lib/debugger-commands';
import type { MenuItem } from '../ui';
import type { Rule } from '../DebuggerRules';
import type { Exchange } from './model';
import type { ListFilter } from './useExchangeList';
import type { DockPanel } from './ToolRail';
import { ReplayDialog } from './ReplayDialog';
import { SelectDialog } from './SelectDialog';
import { ProgramPicker } from './ProgramPicker';

interface Tools {
  rows: Exchange[];
  selectedIds: string[];
  select(ids: string[]): void;
  setFilter(f: (f: ListFilter) => ListFilter): void;
  openDock(p: DockPanel): void;
  setRuleDraft(r: Partial<Rule>): void;
  onOpen(e: Exchange): void;
  remove(ids: string[]): void;
  clear(): void;
  quickRule(kind: Rule['kind'], name: string, match: Rule['match']): void;
}

/**
 * The Debugger's selection and replay tools in one place, so the view stays small: Edit ▸ Select matching…, the command
 * bar's verbs (shared/debugger-select.ts), Resend several times and the running-program picker.
 */
export function useGridTools(t: Tools): { dialogs: ReactNode; replay(ids: string[], times?: number): void; editItems: MenuItem[]; pickProgram(): void } {
  const [replayFor, setReplayFor] = useState<{ ids: string[]; times?: number }>();
  const [selectOpen, setSelectOpen] = useState(false);
  const [picker, setPicker] = useState(false);
  const toast = useApp.getState().toast;
  const byId = useMemo(() => new Map(t.rows.map((r) => [r.id, r])), [t.rows]);
  const selectBy = (where: string, say: string) => {
    const p = parseWhere(where);
    if (!p.ok) return toast(p.error, 'error');
    const test = compileWhere(p.clauses);
    const ids = t.rows.filter(test).map((r) => r.id);
    if (!ids.length) return toast(`No row matches ${say}`, 'info');
    t.select(ids);
    toast(`Selected ${plural(ids.length, 'row')}: ${say}`);
  };
  // the command bar (Ctrl+K, then !) runs these while the Debugger is on screen
  useEffect(
    () =>
      setDebuggerCommandHandler({
        describe: (c: DebuggerCommand) =>
          c.verb === 'filter' ? `Filter the list to "${c.text}"` : c.verb === 'select' ? `Select ${c.say}` : c.verb === 'breakpoint' ? `Hold requests whose URL contains "${c.url}" at a breakpoint…` : c.verb === 'delete' ? 'Delete the selected rows' : c.verb === 'clear' ? 'Clear the session' : 'Open the Structure panel (rows by domain)',
        run: (c: DebuggerCommand) => {
          switch (c.verb) {
            case 'filter':
              return t.setFilter((f) => ({ ...f, text: c.text, deep: false }));
            case 'select':
              return selectBy(c.where, c.say);
            case 'breakpoint':
              return t.setRuleDraft({ kind: 'breakpoint', enabled: true, name: `Break on ${c.url}`, match: { url: `*${c.url}*` }, breakpoint: 'request' });
            case 'delete':
              return t.selectedIds.length ? t.remove(t.selectedIds) : toast('Select rows first (Select matching…, Ctrl+click)', 'info');
            case 'clear':
              return t.clear();
            case 'hosts':
              return t.openDock('structure');
          }
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t.rows, t.selectedIds],
  );
  const editItems: MenuItem[] = [
    { label: 'Select matching…', icon: <ListChecks size={14} />, title: 'Select every row that satisfies conditions on the columns, to delete, save, make into a flow or resend', disabled: !t.rows.length, reason: 'Nothing captured yet', onSelect: () => setSelectOpen(true) },
    { label: 'Select all', icon: <CheckSquare size={14} />, shortcut: 'Ctrl+A', disabled: !t.rows.length, reason: 'Nothing captured yet', onSelect: () => t.select(t.rows.map((r) => r.id)) },
    { label: 'Invert the selection', icon: <Square size={14} />, disabled: !t.rows.length, reason: 'Nothing captured yet', onSelect: () => t.select(t.rows.filter((r) => !t.selectedIds.includes(r.id)).map((r) => r.id)) },
    { label: 'Select none', disabled: !t.selectedIds.length, reason: 'Nothing is selected', onSelect: () => t.select([]) },
    { label: 'Command bar…', icon: <Terminal size={14} />, separator: true, title: '? text, >200kb, =404, @host, select …, bp url, delete, clear, hosts', onSelect: () => useApp.getState().set({ paletteOpen: true, paletteQuery: '!' }) },
  ];
  const dialogs = (
    <>
      {replayFor && (
        <ReplayDialog
          rows={t.rows.filter((r) => replayFor.ids.includes(r.id)).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))}
          start={replayFor.times}
          onClose={() => setReplayFor(undefined)}
          onOpen={(e) => (setReplayFor(undefined), t.onOpen(e))}
        />
      )}
      {selectOpen && <SelectDialog rows={t.rows} onSelect={t.select} onClose={() => setSelectOpen(false)} />}
      {picker && <ProgramPicker onPick={(name) => t.quickRule('only', `Capture only Application = ${name}`, { application: name })} onClose={() => setPicker(false)} />}
    </>
  );
  return {
    dialogs,
    editItems,
    pickProgram: () => setPicker(true),
    replay: (ids, times) => {
      const known = ids.filter((id) => byId.has(id));
      if (!known.length) return toast('Select requests to send again', 'error');
      setReplayFor({ ids: known, times });
    },
  };
}
