import { plural } from '../lib/format';
import { ChevronDown, KeyRound, TriangleAlert } from 'lucide-react';
import { selectEnvironments, useApp } from '../store';
import { openRef } from '../lib/open-ref';
import { useUndefinedVariables } from '../lib/request-variables';
import { useVarPopover } from '../lib/var-popover';
import { useRef } from 'react';
import { Badge, Menu, cx, type MenuItem } from './ui';

type Env = { id?: string; name: string; color?: string; isProduction?: boolean; problem?: string };

/** An environment's colour: its own, else red for production and green otherwise; none: the line colour. */
export const envColor = (e?: Pick<Env, 'color' | 'isProduction'>) => (e ? (e.color ?? (e.isProduction ? 'var(--bad)' : 'var(--ok)')) : 'var(--line-strong)');

function Dot({ color, ring }: { color: string; ring?: boolean }) {
  return <span className={cx('inline-block w-2.5 h-2.5 rounded-full shrink-0', ring && 'ring-2 ring-bad/40')} style={{ background: color }} aria-hidden />;
}

/**
 * WF-05: an environment the same way everywhere — its colour dot and name, PRODUCTION in red. Run headers (Collection
 * runner, monitors, Load, Evaluations, flows), the status bar and the pickers use it.
 */
export function EnvBadge({ name, className }: { name?: string; className?: string }) {
  const env = useApp((s) => (name ? s.workspace?.environments.find((e) => e.name === name) : undefined));
  return (
    <span
      className={cx('inline-flex items-center gap-1.5 min-w-0', className)}
      data-env-badge={name ?? ''}
      title={name ? `Environment: ${name}${env?.isProduction ? ' (production)' : ''}` : 'No environment'}
    >
      <Dot color={envColor(env)} />
      <span className="truncate">{name ?? 'No environment'}</span>
      {env?.isProduction && <Badge tone="bad">PRODUCTION</Badge>}
    </span>
  );
}

/**
 * WF-05: the one environment picker, in three looks: `topbar` (the window's active environment, a pill), `status` (the
 * status bar's segment: the same menu), `inline` (a field in a form: the Collection runner, a monitor, Load — `value` and
 * `onChange` set what that form uses, the active one by default). Environments whose file can't be read are listed and
 * disabled with why; production is marked; Manage environments… goes to them.
 */
export function EnvSelect({
  variant = 'inline',
  value,
  onChange,
  ariaLabel = 'Environment',
}: {
  variant?: 'topbar' | 'status' | 'inline';
  value?: string;
  onChange?(name: string | undefined): void;
  ariaLabel?: string;
}) {
  const envs = useApp(selectEnvironments) as Env[];
  const active = useApp((s) => s.environment);
  const controlled = !!onChange;
  const current = controlled ? value : active;
  const set = (name: string | undefined) => (onChange ? onChange(name) : useApp.getState().setEnvironment(name));
  const envObj = envs.find((e) => e.name === current);
  const items: MenuItem[] = [
    { label: 'No environment', icon: <Dot color="var(--line-strong)" />, onSelect: () => set(undefined) },
    ...envs.map((e) =>
      // a name from a hand-edited file is text here whatever it holds (an object would blank the window)
      e.problem
        ? { label: `${String(e.name)}  (cannot be read)`, icon: <TriangleAlert size={13} className="text-bad" />, danger: true, disabled: true, title: e.problem, onSelect: () => undefined }
        : { label: e.isProduction ? `${String(e.name)}  (production)` : String(e.name), icon: <Dot color={envColor(e)} ring={e.isProduction} />, onSelect: () => set(e.name) },
    ),
    { label: 'Manage environments…', icon: <KeyRound size={14} />, separator: true, onSelect: () => void openRef({ kind: 'environment' }) },
  ];
  const label = current === undefined || current === null || current === '' ? 'No environment' : String(current);
  const title = envObj ? `${controlled ? 'Environment' : 'Active environment'}: ${envObj.name}${envObj.isProduction ? ' (production)' : ''}` : 'No environment: choose one';
  const trigger =
    variant === 'topbar' ? (
      <button
        aria-label={ariaLabel}
        title={title}
        className={cx(
          'flex items-center gap-2 h-8 pl-2.5 pr-2 rounded-full border bg-field shadow-sm text-sm max-w-56 transition-colors data-[state=open]:bg-hover',
          envObj?.isProduction ? 'border-bad/50' : 'border-line-strong hover:border-muted/50',
        )}
      >
        <Dot color={envColor(envObj)} />
        <span className="truncate">{label}</span>
        <ChevronDown size={13} className="text-muted shrink-0" />
      </button>
    ) : variant === 'status' ? (
      <button aria-label={ariaLabel} title={`${title} (click to switch)`} data-status="environment" className="flex items-center gap-1.5 hover:text-fg">
        <span className="w-2 h-2 rounded-full" style={{ background: envColor(envObj) }} />
        <span>{label}</span>
        {envObj?.isProduction && <Badge tone="bad">PRODUCTION</Badge>}
      </button>
    ) : (
      <button aria-label={ariaLabel} title={title} className={cx('field h-8 flex items-center gap-2 px-2 text-sm text-left min-w-40 max-w-80', envObj?.isProduction && 'border-bad/50')}>
        <Dot color={envColor(envObj)} />
        <span className="truncate flex-1">{label}</span>
        {envObj?.isProduction && <Badge tone="bad">PRODUCTION</Badge>}
        <ChevronDown size={13} className="text-muted shrink-0" />
      </button>
    );
  const menu = <Menu items={items} width={240} align={variant === 'status' ? 'start' : undefined} trigger={trigger} />;
  // the window's active environment (top bar, status bar): a badge when the request on screen uses undefined variables
  return controlled ? menu : (
    <span className="inline-flex items-center gap-1">
      {menu}
      <UndefinedVariablesBadge variant={variant === 'status' ? 'status' : 'topbar'} environment={envObj?.name} />
    </span>
  );
}

/**
 * The {{variables}} the request on screen uses that the active environment, its collection and the globals don't
 * define (lib/request-variables.ts, the same resolution as the field highlighting and the Info panel): a red count;
 * each opens the variable popover to add it to the environment (and to the others, Also add to).
 */
function UndefinedVariablesBadge({ variant, environment }: { variant: 'topbar' | 'status'; environment?: string }) {
  const { names, collectionId } = useUndefinedVariables();
  const anchor = useRef<HTMLButtonElement>(null);
  if (!names.length) return null;
  const where = environment ? `the environment "${environment}"` : 'any environment (none is active)';
  const add = (name: string) => {
    const r = anchor.current?.getBoundingClientRect();
    useVarPopover.getState().show({ name, collectionId, x: Math.max(8, Math.min((r?.left ?? 8) - 120, innerWidth - 360)), y: variant === 'status' ? Math.max(8, (r?.top ?? 400) - 260) : (r?.bottom ?? 40) + 4 });
  };
  return (
    <Menu
      width={280}
      align={variant === 'status' ? 'start' : 'end'}
      items={names.slice(0, 30).map((n) => ({
        label: environment ? `Add {{${n}}} to ${environment}…` : `Define {{${n}}}…`,
        icon: <TriangleAlert size={13} className="text-bad" />,
        title: `{{${n}}} is not defined in ${where}, its collection or the globals`,
        onSelect: () => add(n),
      }))}
      trigger={
        <button
          ref={anchor}
          data-undefined-vars={names.length}
          aria-label={`${plural(names.length, 'undefined variable')} in this request`}
          title={`Not defined in ${where}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ' …' : ''}. Click to add them.`}
          className={cx('inline-flex items-center gap-1 rounded-full font-semibold text-white bg-bad tabular-nums', variant === 'status' ? 'h-4 px-1.5 text-3xs' : 'h-5 px-1.5 text-2xs')}
        >
          <TriangleAlert size={variant === 'status' ? 10 : 11} aria-hidden />
          {names.length > 99 ? '99+' : names.length}
        </button>
      }
    />
  );
}
