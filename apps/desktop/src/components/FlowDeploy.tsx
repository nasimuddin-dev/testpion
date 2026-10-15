/**
 * The flow designer's Deploy panel: where a flow runs besides the Run button — on a schedule (a monitor), from a
 * webhook (its `webhook:` block, served by the app), as an MCP tool for agents (`expose:`), and in CI. Each target says
 * its state and offers the one action that sets it up or opens it.
 */
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { Bot, CalendarClock, Copy, Rocket, Square, Play, Webhook, Workflow } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { call } from '../api';
import { toastError, useApp } from '../store';
import { Badge, Button, cx, LinkButton } from './ui';

/** Where a flow is deployed (tests.deployStatus). */
export interface DeployStatus {
  schedule?: { monitorId: string; name: string; every: string; enabled?: boolean; lastStatus?: string };
  webhook?: { path: string; url?: string; serving: boolean; secret: boolean; problem?: string };
  mcp?: { name: string };
  ci: boolean;
  ciFiles?: string[];
}

/** The webhook URL of a path: the served one, else where the app serves webhooks by default. */
export const webhookUrl = (w: NonNullable<DeployStatus['webhook']>) => w.url ?? `http://127.0.0.1:4020${w.path.startsWith('/') ? '' : '/'}${w.path}`;

/** What starts the flow, in a few words (the Start node's trigger). */
export function triggerLabel(status: DeployStatus | undefined, exposed?: string): string {
  const parts = [status?.schedule && 'Schedule', status?.webhook && 'Webhook', (status?.mcp || exposed !== undefined) && 'MCP tool', status?.ci && 'CI'].filter(Boolean);
  return parts.length ? parts.join(' + ') : 'Manual';
}

function Row({ icon, title, state, children, data }: { icon: ReactNode; title: string; state: ReactNode; children: ReactNode; data: string }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-line last:border-b-0" data-deploy-target={data}>
      <span className="grid place-items-center w-8 h-8 rounded-lg bg-accent-soft text-accent shrink-0">{icon}</span>
      <div className="min-w-0 flex-1 grid gap-1">
        <div className="font-medium text-sm">{title}</div>
        <div className="text-xs text-muted">{state}</div>
        <div className="flex flex-wrap gap-1.5">{children}</div>
      </div>
    </div>
  );
}

/**
 * The Deploy button and its panel. `status` is undefined while it is read (or when the app cannot say: "not
 * available"); the actions call back into the designer, which owns the file's edits.
 */
export function DeployPanel({
  file,
  status,
  error,
  onOpen,
  onRefresh,
  onEnableWebhook,
  onDisableWebhook,
  onSchedule,
  onExpose,
  onCi,
}: {
  file: string;
  status?: DeployStatus;
  error?: string;
  onOpen(): void;
  onRefresh(): void;
  onEnableWebhook(): void;
  onDisableWebhook(): void;
  onSchedule(): void;
  onExpose(): void;
  onCi(): void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => useApp.getState().toast(`${what} copied`),
      () => useApp.getState().toast(text),
    );
  const serve = async (on: boolean) => {
    setBusy(true);
    try {
      await call(on ? 'flows.webhooks.start' : 'flows.webhooks.stop', {});
      onRefresh();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const none = status && !status.schedule && !status.webhook && !status.mcp && !status.ci;
  const w = status?.webhook;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) onOpen();
      }}
    >
      <PopoverPrimitive.Trigger asChild>
        <Button size="sm" variant="primary" icon={<Rocket size={12} />} data-flow-deploy aria-label="Deploy" title="Run this flow on a schedule, from a webhook, for an agent or in CI">
          <span className="hidden @[760px]:inline">Deploy</span>
        </Button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={6}
          aria-label="Deploy"
          data-deploy-panel
          className="z-[70] w-[400px] max-w-[94vw] rounded-xl border border-line bg-bg p-3 shadow-lg animate-in fade-in-0 zoom-in-95 duration-150"
        >
          <div className="flex items-center gap-2 pb-1">
            <Rocket size={14} className="text-accent" />
            <span className="font-semibold text-sm flex-1">Deploy</span>
            <span className="mono text-xs text-muted truncate max-w-[220px]">tests/{file}</span>
          </div>
          {error ? (
            <p className="text-xs text-muted py-2" data-deploy-unavailable>
              Deploy targets are not available here: {error}
            </p>
          ) : !status ? (
            <p className="text-xs text-muted py-2">Reading where this flow runs…</p>
          ) : (
            <>
              {none && (
                <p className="text-xs text-muted py-2" data-deploy-hint>
                  This flow only runs when you click Run. Pick a trigger to run it on a schedule, from a webhook, an agent or CI.
                </p>
              )}
              <Row
                data="schedule"
                icon={<CalendarClock size={16} />}
                title="Schedule"
                state={
                  status.schedule ? (
                    <>
                      {status.schedule.name}: {status.schedule.every}
                      {status.schedule.lastStatus ? ` · last run ${status.schedule.lastStatus}` : ' · not run yet'}
                    </>
                  ) : (
                    'A monitor runs the flow every few minutes and tells you when it fails.'
                  )
                }
              >
                <Button size="sm" onClick={() => (setOpen(false), onSchedule())}>
                  {status.schedule ? 'Open' : 'Set up'}
                </Button>
              </Row>
              <Row
                data="webhook"
                icon={<Webhook size={16} />}
                title="Webhook"
                state={
                  w ? (
                    <span className="grid gap-0.5">
                      <span className="mono text-fg break-all" data-deploy-webhook-url>
                        POST {webhookUrl(w)}
                      </span>
                      <span>
                        {w.serving ? <Badge tone="ok">serving</Badge> : <Badge>not served</Badge>} {w.secret ? 'callers send the secret' : 'no secret'}
                        {w.problem ? ` · ${w.problem}` : ''}
                      </span>
                    </span>
                  ) : (
                    'A URL that runs the flow when something POSTs to it (its JSON body becomes the inputs).'
                  )
                }
              >
                {w ? (
                  <>
                    <Button size="sm" icon={<Copy size={12} />} onClick={() => void copy(webhookUrl(w), 'Webhook URL')}>
                      Copy URL
                    </Button>
                    <Button size="sm" icon={<Copy size={12} />} onClick={() => void copy(`curl -X POST ${webhookUrl(w)} -H "content-type: application/json" -d "{}"`, 'curl command')}>
                      Copy curl
                    </Button>
                    <Button
                      size="sm"
                      icon={w.serving ? <Square size={12} /> : <Play size={12} />}
                      loading={busy}
                      onClick={() => void serve(!w.serving)}
                      data-deploy-serve={w.serving ? 'stop' : 'start'}
                    >
                      {w.serving ? 'Stop serving' : 'Start serving'}
                    </Button>
                    <LinkButton onClick={onDisableWebhook}>Disable</LinkButton>
                  </>
                ) : (
                  <Button size="sm" onClick={onEnableWebhook} data-deploy-enable-webhook>
                    Enable
                  </Button>
                )}
              </Row>
              <Row
                data="mcp"
                icon={<Bot size={16} />}
                title="MCP tool"
                state={
                  status.mcp ? (
                    <>
                      Agents call it as <span className="mono text-fg">{status.mcp.name}</span>
                    </>
                  ) : (
                    'Offer the flow to AI agents as a tool of the MCP server.'
                  )
                }
              >
                <Button size="sm" onClick={() => (setOpen(false), onExpose())}>
                  {status.mcp ? 'Edit' : 'Expose…'}
                </Button>
              </Row>
              <Row
                data="ci"
                icon={<Workflow size={16} />}
                title="CI"
                state={status.ci ? `A pipeline runs it: ${(status.ciFiles ?? []).join(', ') || 'yes'}` : 'Run it on every push (GitHub Actions, GitLab, Azure, Jenkins).'}
              >
                <Button size="sm" onClick={() => (setOpen(false), onCi())}>
                  {status.ci ? 'Open the pipeline dialog' : 'Set up…'}
                </Button>
              </Row>
            </>
          )}
          <div className={cx('pt-2 text-[11px] text-muted')}>The flow file stays the one source: every target runs it as it is saved.</div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
