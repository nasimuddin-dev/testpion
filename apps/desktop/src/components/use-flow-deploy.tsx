import { useCallback, useEffect, useState } from 'react';
import { Bot, CalendarClock, Play, Webhook, Workflow } from 'lucide-react';
import { asError, call } from '../api';
import { openRef } from '../lib/open-ref';
import { useApp } from '../store';
import { type DeployStatus } from './FlowDeploy';
import type { MenuItem } from './ui';

/**
 * The Start node's trigger and the Deploy panel of the flow designer: what the file is deployed as (a schedule, a webhook, an
 * MCP tool), read from the engine, and the trigger menu that turns each on or opens it. `enableWebhook` is the edit that
 * switches the webhook on or off (the designer's `apply`).
 */
export function useFlowDeploy(o: { file: string; exposed: string | undefined; environment: string | undefined; onExpose?(): void; enableWebhook(on: boolean): Promise<unknown> }) {
  const { file, exposed, environment, onExpose } = o;
  const [deploy, setDeploy] = useState<{ status?: DeployStatus; error?: string }>({});
  const loadDeploy = useCallback(() => {
    call<DeployStatus>('tests.deployStatus', { file }).then(
      (status) => setDeploy({ status }),
      (e) => setDeploy({ error: asError(e).message }),
    );
  }, [file]);
  useEffect(() => loadDeploy(), [loadDeploy, exposed]);
  const setWebhook = async (on: boolean) => {
    // enabled without a path: the engine gives it /hooks/<the file's name>
    const r = await o.enableWebhook(on);
    if (r) loadDeploy();
  };
  // the monitor that runs this file (opened the one way, openRef), or a new one prefilled with it
  const schedule = () =>
    deploy.status?.schedule ? void openRef({ kind: 'monitor', monitorId: deploy.status.schedule.monitorId }) : useApp.getState().openIntent('monitors', { create: { testFile: file } });
  const triggerItems: MenuItem[] = [
    { label: 'Manual', icon: <Play size={14} />, onSelect: () => useApp.getState().toast('The flow runs when you click Run flow, or from the terminal: testpion test tests/' + file) },
    { label: deploy.status?.schedule ? 'Schedule: open the monitor' : 'Schedule…', icon: <CalendarClock size={14} />, onSelect: schedule },
    { label: deploy.status?.webhook ? 'Webhook (on)' : 'Webhook', icon: <Webhook size={14} />, onSelect: () => (deploy.status?.webhook ? useApp.getState().toast('Webhook: Deploy ▸ Webhook copies its URL and serves it') : void setWebhook(true)) },
    { label: exposed !== undefined ? 'MCP tool (exposed)…' : 'MCP tool…', icon: <Bot size={14} />, onSelect: () => onExpose?.(), disabled: !onExpose, reason: 'Save the flow as a test file first' },
    { label: 'CI…', icon: <Workflow size={14} />, onSelect: () => useApp.getState().set({ ci: { tests: [file], environment } }) },
  ];
  return { deploy, loadDeploy, setWebhook, schedule, triggerItems };
}
