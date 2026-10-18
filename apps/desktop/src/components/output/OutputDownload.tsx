import { useEffect, useId, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, Copy, Download, KeyRound, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { OUTPUT_FORMATS, outputSurface } from '@testpion/shared';
import { call } from '../../api';
import { useApp } from '../../store';
import { scopedKey } from '../../lib/ws-scope';
import { LABEL } from '../../lib/vocabulary';
import { cx, IconButton, Menu, Spinner, Tooltip, type MenuItem } from '../ui';
import { copyOutput, defaultFormat, formatKey, formatLabel, onRunningChange, registerControl, running, saveOutput, saveWithSecrets, type OutputFormatSpec, type OutputSpec } from './output-core';

/** The size of the control's buttons: the same in every output (the e2e consistency check reads it). */
export const OUTPUT_BUTTON = 'h-7 w-7';

/*
 * The format chosen last on each kind of output: a tiny store over localStorage. Every output bar on screen reads it on
 * each render (the console's on every console event), so it is read from storage once per key and kept here; a save
 * writes both and tells the bars.
 */
const lastKey = (id: string) => scopedKey(`aps.output.format.${id}`) ?? `aps.output.format.${id}`;
const remembered = new Map<string, string | undefined>();
const bars = new Set<() => void>();
function lastFormatKey(id: string): string | undefined {
  const k = lastKey(id);
  if (!remembered.has(k)) {
    let v: string | undefined;
    try {
      v = localStorage.getItem(k) ?? undefined;
    } catch {
      // remembering is a convenience
    }
    remembered.set(k, v);
  }
  return remembered.get(k);
}
function rememberFormat(spec: OutputSpec, f: OutputFormatSpec): void {
  const k = lastKey(spec.id);
  remembered.set(k, formatKey(f));
  try {
    localStorage.setItem(k, formatKey(f));
  } catch {
    // remembering is a convenience
  }
  bars.forEach((fn) => fn());
}
const subscribe = (fn: () => void) => (bars.add(fn), () => void bars.delete(fn));

// made once: the tick of the chosen format and the blank of the others (React skips an element it has already rendered)
const CHOSEN = <Check size={14} />;
const BLANK = <span className="inline-block w-3.5" />;

/**
 * The down arrow of every output: Copy, then Download (a click saves the default format, or the one chosen last on this
 * kind of output), then ▾ (choose the format, copy as, include secrets). One look and one place everywhere: it is put
 * there by OutputHeader / OutputActions, never by a surface itself. Ctrl+Shift+S runs the one nearest to the focus.
 */
export function OutputDownload({ spec: given }: { spec: OutputSpec }) {
  // the active environment, unless the surface knows its own: its secret values are masked, production is said
  const activeEnv = useApp((s) => s.environment);
  const environments = useApp((s) => s.workspace?.environments);
  const production = useMemo(() => !!(activeEnv && environments?.find((e) => e.name === activeEnv)?.isProduction), [activeEnv, environments]);
  const spec = useMemo<OutputSpec>(() => ({ ...given, environment: given.environment ?? activeEnv, production: given.production ?? production }), [given, activeEnv, production]);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onRunningChange(rerender), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  // one save at a time per control (two grids of a panel may share a surface id)
  const key = useId();
  const job = running.get(key) ?? running.get(spec.id);
  const info = outputSurface(spec.id);
  const redactedByDefault = info?.redaction === 'redacted-default';
  // the console, the log, run reports, traces … never hold the secrets: "Include secrets…" would save the same masked file
  const canIncludeSecrets = redactedByDefault && !info?.capturedRedacted && !spec.masked;
  const disabled = !!spec.empty || !spec.formats.length;
  const lastChosen = useSyncExternalStore(subscribe, () => lastFormatKey(spec.id));
  const current = useMemo(() => (lastChosen && spec.formats.find((f) => formatKey(f) === lastChosen)) || defaultFormat(spec), [spec, lastChosen]);
  // what a shortcut or a late click acts on: the spec and format of the latest render, not of the render that registered
  const live = useRef({ spec, current });
  live.current = { spec, current };
  const save = (f: OutputFormatSpec | undefined) => {
    if (!f) return;
    rememberFormat(live.current.spec, f);
    void saveOutput(live.current.spec, f, { key });
  };
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    return registerControl(el, { download: () => !disabled && save(live.current.current), openMenu: () => !disabled && setMenuOpen(true) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` reads the live ref; the registration changes only with `disabled`
  }, [disabled]);
  const textFormats = useMemo(() => spec.formats.filter((f) => OUTPUT_FORMATS[f.format].text), [spec]);
  const copyFormat = current && OUTPUT_FORMATS[current.format].text ? current : textFormats[0];
  const items = useMemo<MenuItem[]>(
    () => [
      ...spec.formats.map((f) => ({
        label: formatLabel(f),
        icon: f === current ? CHOSEN : BLANK,
        shortcut: `.${(f.fileName ?? '').match(/\.(\w{1,16})$/)?.[1] ?? OUTPUT_FORMATS[f.format].ext}`,
        onSelect: () => save(f),
      })),
      ...(textFormats.length > 1
        ? [
            {
              label: LABEL.copyAs,
              icon: <Copy size={14} />,
              separator: true,
              onSelect: () => undefined,
              items: textFormats.map((f) => ({ label: formatLabel(f), onSelect: () => void copyOutput(live.current.spec, f) })),
            },
          ]
        : []),
      ...(canIncludeSecrets
        ? [
            {
              label: LABEL.includeSecrets,
              icon: <KeyRound size={14} />,
              separator: textFormats.length <= 1,
              title: 'Save with the values masked by default (asks first)',
              onSelect: () => undefined,
              items: spec.formats.map((f) => ({ label: formatLabel(f), onSelect: () => void saveWithSecrets(live.current.spec, f, key) })),
            },
          ]
        : []),
      ...(spec.production ? [{ label: LABEL.fromProductionEnvironment, icon: <TriangleAlert size={14} />, disabled: true, separator: true, onSelect: () => undefined }] : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `save` and `key` are stable for the control's life
    [spec, current, textFormats, canIncludeSecrets],
  );
  const what = spec.what;
  const reason = spec.empty ?? (spec.formats.length ? undefined : 'Nothing to download');
  const progress = job && (job.total ? `${Math.round((job.bytes / job.total) * 100)} %` : undefined);
  return (
    // why the control is off is the one tooltip style of the app, on the group: a disabled button takes no pointer
    <Tooltip content={reason}>
      <span className="inline-flex items-center shrink-0 gap-0.5" data-output-control={spec.id}>
        {redactedByDefault && (
          <Tooltip
            content={
              canIncludeSecrets
                ? 'Saved and copied with secrets masked (tokens, passwords, Authorization headers). ▾ Include secrets… to keep them.'
                : 'Secrets are masked before this output is built (tokens, passwords, Authorization headers), so it is always saved and copied without them.'
            }
          >
            <span className="inline-flex items-center gap-0.5 text-[0.7rem] text-muted px-1" data-output-redacted>
              <ShieldCheck size={12} />
              <span>Redacted</span>
            </span>
          </Tooltip>
        )}
        <IconButton label={`Copy ${what}`} className={OUTPUT_BUTTON} disabled={disabled || !copyFormat} onClick={() => copyFormat && void copyOutput(spec, copyFormat)} data-output-copy={spec.id}>
          <Copy size={14} />
        </IconButton>
        <IconButton
          ref={button}
          label={job ? `Saving ${what}${progress ? ` (${progress})` : ''}…` : `Download ${what}${current ? ` (${formatLabel(current)})` : ''}`}
          className={cx(OUTPUT_BUTTON, 'rounded-r-none')}
          disabled={disabled || !!job}
          onClick={() => save(current)}
          data-output-download={spec.id}
        >
          {job ? <Spinner size={13} /> : <Download size={14} />}
        </IconButton>
        {job ? (
          <IconButton label={`Cancel saving the ${what}`} className={cx(OUTPUT_BUTTON, 'w-5 rounded-l-none')} onClick={() => void call('output.cancel', { jobId: job.jobId })} data-output-cancel>
            <X size={12} />
          </IconButton>
        ) : (
          <Menu
            open={menuOpen}
            onOpenChange={setMenuOpen}
            width={250}
            items={items}
            trigger={
              <IconButton label={LABEL.chooseDownloadFormat} className={cx(OUTPUT_BUTTON, 'w-5 rounded-l-none -ml-0.5')} disabled={disabled} data-output-formats={spec.id}>
                <ChevronDown size={12} />
              </IconButton>
            }
          />
        )}
      </span>
    </Tooltip>
  );
}
