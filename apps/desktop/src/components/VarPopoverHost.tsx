import { useEffect, useState } from 'react';
import { clearVariablesCache, inspectVariables, type VarInfo } from '../lib/vars-cache';
import { collectionOf, useVarPopover, variableAt, VARS_CHANGED } from '../lib/var-popover';
import { useApp } from '../store';
import { VarPopover } from './VarInput';

/** Longer field values are not looked at on hover (request bodies live in code editors, which show their own). */
const HOVER_MAX_CHARS = 20_000;

/**
 * WF-14: hovering any text field that uses {{variables}} (auth, settings, MCP tool arguments, a monitor's webhook …)
 * shows where each comes from, as fields with variable highlighting do: one lookup per field value and environment
 * (the variables cache answers repeats), the field's own tooltip kept above it.
 */
/** What each field was last looked up with, and its own tooltip (weak: a field that goes away takes its entry along). */
const hovered = new WeakMap<Element, { key: string; title: string }>();

function showSourcesOnHover(t: HTMLInputElement | HTMLTextAreaElement): void {
  const value = t.value;
  if (value.length > HOVER_MAX_CHARS || !value.includes('{{')) return;
  const env = useApp.getState().environment;
  const key = `${env ?? ''}\u0000${value}`;
  const seen = hovered.get(t);
  if (seen?.key === key) return;
  const own = seen ? seen.title : t.title;
  hovered.set(t, { key, title: own });
  const names = new Set([...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map((m) => m[1]!.trim().split('.')[0]!));
  void inspectVariables({ environment: env, collectionId: collectionOf(t), template: value }).then((list) => {
    if (hovered.get(t)?.key !== key) return; // the value or the environment changed meanwhile
    const lines = list.filter((v) => names.has(v.name)).map((v) => (v.scope ? `${v.name} = ${v.secret ? '••••••' : v.value} (${v.scope})` : `${v.name}: not defined in the current environment`));
    t.title = [own, ...lines, lines.length ? '(double-click a variable to see or edit it)' : ''].filter(Boolean).join('\n');
  });
}

/**
 * Shows the {{variable}} popover wherever it was asked for, and opens it on a double-click on a variable in any text
 * field (inputs and text areas everywhere: auth, settings, tool arguments …). Code editors report their own
 * double-clicks; fields with variable highlighting open it on a single click. Hovering such a field shows where its
 * variables come from (showSourcesOnHover).
 */
export function VarPopoverHost() {
  const open = useVarPopover((s) => s.open);
  const env = useApp((s) => s.environment);
  const [info, setInfo] = useState<{ name: string; info?: VarInfo }>();

  useEffect(() => {
    const onDouble = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement)) return;
      // a field with variable highlighting already opened it on the first click
      if (t.closest('[data-var-input]')) return;
      const name = variableAt(t.value, t.selectionStart ?? 0);
      if (!name) return;
      const r = t.getBoundingClientRect();
      useVarPopover.getState().show({ name, x: Math.max(r.left, e.clientX - 40), y: t instanceof HTMLTextAreaElement ? e.clientY + 8 : r.bottom, collectionId: collectionOf(t) });
    };
    const onOver = (e: PointerEvent) => {
      const t = e.target;
      if ((t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) && !t.closest('[data-var-input]')) showSourcesOnHover(t);
    };
    document.addEventListener('dblclick', onDouble);
    document.addEventListener('pointerover', onOver, true);
    return () => {
      document.removeEventListener('dblclick', onDouble);
      document.removeEventListener('pointerover', onOver, true);
    };
  }, []);

  useEffect(() => {
    if (!open) return setInfo(undefined);
    let live = true;
    const base = open.name.split('.')[0]!;
    void inspectVariables({ environment: env, collectionId: open.collectionId, template: `{{${base}}}` }).then((list) => live && setInfo({ name: open.name, info: list.find((v) => v.name === base) }));
    return () => {
      live = false;
    };
  }, [open, env]);

  if (!open || info?.name !== open.name) return null;
  return (
    <VarPopover
      key={`${open.name}@${open.x},${open.y}`}
      name={open.name}
      info={info.info}
      environment={env}
      collectionId={open.collectionId}
      x={open.x}
      y={open.y}
      onClose={() => useVarPopover.getState().hide()}
      onSaved={() => {
        clearVariablesCache();
        window.dispatchEvent(new Event(VARS_CHANGED));
      }}
    />
  );
}
