import { useEffect, useId, useReducer, useRef, useState } from 'react';
import { Check, ChevronDown, Copy, Download, KeyRound, ShieldCheck, TriangleAlert, X } from 'lucide-react';
import { OUTPUT_FORMATS, outputSurface } from '@testpion/shared';
import { call } from '../../api';
import { useApp } from '../../store';
import { scopedKey } from '../../lib/ws-scope';
import { cx, IconButton, Menu, Spinner, Tooltip, type MenuItem } from '../ui';
import { copyOutput, defaultFormat, formatKey, formatLabel, onRunningChange, registerControl, running, saveOutput, saveWithSecrets, type OutputFormatSpec, type OutputSpec } from './output-core';

/** The size of the control's buttons: the same in every output (the e2e consistency check reads it). */
export const OUTPUT_BUTTON = 'h-7 w-7';

const lastKey = (id: string) => scopedKey(`aps.output.format.${id}`) ?? `aps.output.format.${id}`;
function lastFormat(spec: OutputSpec): OutputFormatSpec | undefined {
  try {
    const k = localStorage.getItem(lastKey(spec.id));
    return (k && spec.formats.find((f) => formatKey(f) === k)) || undefined;
  } catch {
    return undefined;
  }
}
function rememberFormat(spec: OutputSpec, f: OutputFormatSpec): void {
  try {
    localStorage.setItem(lastKey(spec.id), formatKey(f));
  } catch {
    // remembering is a convenience
  }
}

/**
 * The down arrow of every output: Copy, then Download (a click saves the default format, or the one chosen last on this
 * kind of output), then ▾ (choose the format, copy as, include secrets). One look and one place everywhere: it is put
 * there by OutputHeader / OutputActions, never by a surface itself. Ctrl+Shift+S runs the one nearest to the focus.
 */
export function OutputDownload({ spec: given }: { spec: OutputSpec }) {
  // the active environment, unless the surface knows its own: its secret values are masked, production is said
  const activeEnv = useApp((s) => s.environment);
  const production = useApp((s) => !!(s.environment && s.workspace?.environments.find((e) => e.name === s.environment)?.isProduction));
  const spec: OutputSpec = { ...given, environment: given.environment ?? activeEnv, production: given.production ?? production };
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onRunningChange(rerender), []);
  const [menuOpen, setMenuOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const live = useRef(spec);
  live.current = spec;
  // one save at a time per control (two grids of a panel may share a surface id)
  const key = useId();
  const job = running.get(key) ?? running.get(spec.id);
  const info = outputSurface(spec.id);
  const redactedByDefault = info?.redaction === 'redacted-default';
  // the console and the log never hold the secrets: "Include secrets…" would save the same masked file
  const canIncludeSecrets = redactedByDefault && !info?.capturedRedacted;
  const disabled = !!spec.empty || !spec.formats.length;
  const preferred = () => lastFormat(live.current) ?? defaultFormat(live.current);
  const save = (f: OutputFormatSpec | undefined) => {
    if (!f) return;
    rememberFormat(live.current, f);
    void saveOutput(live.current, f, { key });
  };
  useEffect(() => {
    const el = button.current;
    if (!el) return;
    return registerControl(el, { download: () => !disabled && save(preferred()), openMenu: () => !disabled && setMenuOpen(true) });
  });
  const current = preferred();
  const textFormats = spec.formats.filter((f) => OUTPUT_FORMATS[f.format].text);
  const copyFormat = current && OUTPUT_FORMATS[current.format].text ? current : textFormats[0];
  const items: MenuItem[] = [
    ...spec.formats.map((f) => ({
      label: formatLabel(f),
      icon: f === current ? <Check size={14} /> : <span className="inline-block w-3.5" />,
      shortcut: `.${(f.fileName ?? '').match(/\.(\w{1,16})$/)?.[1] ?? OUTPUT_FORMATS[f.format].ext}`,
      onSelect: () => save(f),
    })),
    ...(textFormats.length > 1
      ? [
          {
            label: 'Copy as',
            icon: <Copy size={14} />,
            separator: true,
            onSelect: () => undefined,
            items: textFormats.map((f) => ({ label: formatLabel(f), onSelect: () => void copyOutput(live.current, f) })),
          },
        ]
      : []),
    ...(canIncludeSecrets
      ? [
          {
            label: 'Include secrets…',
            icon: <KeyRound size={14} />,
            separator: textFormats.length <= 1,
            title: 'Save with the values masked by default (asks first)',
            onSelect: () => undefined,
            items: spec.formats.map((f) => ({ label: formatLabel(f), onSelect: () => void saveWithSecrets(live.current, f, key) })),
          },
        ]
      : []),
    ...(spec.production ? [{ label: 'From the production environment', icon: <TriangleAlert size={14} />, disabled: true, separator: true, onSelect: () => undefined }] : []),
  ];
  const what = spec.what;
  const reason = spec.empty ?? (spec.formats.length ? undefined : 'Nothing to download');
  const progress = job && (job.total ? `${Math.round((job.bytes / job.total) * 100)} %` : undefined);
  return (
    <div className="inline-flex items-center shrink-0 gap-0.5" data-output-control={spec.id} title={reason}>
      {redactedByDefault && (
        <Tooltip
          content={
            canIncludeSecrets
              ? 'Saved and copied with secrets masked (tokens, passwords, Authorization headers). ▾ Include secrets… to keep them.'
              : 'Secrets are masked as they are captured (tokens, passwords, Authorization headers): they are never kept, so never saved.'
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
        onClick={() => save(preferred())}
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
            <IconButton label="Choose a download format" className={cx(OUTPUT_BUTTON, 'w-5 rounded-l-none -ml-0.5')} disabled={disabled} data-output-formats={spec.id}>
              <ChevronDown size={12} />
            </IconButton>
          }
        />
      )}
    </div>
  );
}
