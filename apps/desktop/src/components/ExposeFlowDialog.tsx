import { Bot, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { call } from '../api';
import { confirmAction, toastError, useApp } from '../store';
import { Button, Field, IconButton, Input, Modal } from './ui';

interface FlowInput {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
}

interface Exposure {
  tool: string;
  description?: string;
  inputs?: FlowInput[];
}

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

/**
 * Tests ▸ file menu ▸ Expose as MCP tool…: the `expose:` block of a test file or suite (the tool's name, what it does
 * and the variables the flow reads as its arguments), written into the YAML by the backend. Agents connected to the
 * workspace's MCP server see the tool after they reconnect.
 */
export function ExposeFlowDialog({ path, onClose, onChanged }: { path: string; onClose(): void; onChanged(exposed: boolean): void }) {
  const [loaded, setLoaded] = useState<{ expose?: Exposure; suggested: string }>();
  const [tool, setTool] = useState('');
  const [description, setDescription] = useState('');
  const [inputs, setInputs] = useState<FlowInput[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<{ expose?: Exposure; suggested: string }>('tests.exposure', { path }).then(
      (r) => {
        setLoaded(r);
        setTool(r.expose?.tool ?? r.suggested);
        setDescription(r.expose?.description ?? '');
        setInputs(r.expose?.inputs ?? []);
      },
      (e) => {
        toastError(e);
        onClose();
      },
    );
  }, [path]);
  if (!loaded) return null;
  const exposed = !!loaded.expose;
  const problem = !TOOL_NAME.test(tool.trim())
    ? 'The tool name is snake_case: lowercase letters, digits and _ (e.g. checkout_flow).'
    : inputs.some((i) => !VAR_NAME.test(i.name.trim()))
      ? 'Every input needs a variable name (the {{name}} the flow reads).'
      : new Set(inputs.map((i) => i.name.trim())).size !== inputs.length
        ? 'Two inputs have the same name.'
        : undefined;
  const update = (i: number, patch: Partial<FlowInput>) => setInputs(inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const save = async () => {
    setBusy(true);
    try {
      const expose: Exposure = {
        tool: tool.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        ...(inputs.length
          ? {
              inputs: inputs.map((i) => ({
                name: i.name.trim(),
                ...(i.description?.trim() ? { description: i.description.trim() } : {}),
                ...(i.default !== undefined && i.default !== '' ? { default: i.default } : {}),
                ...(i.required !== undefined ? { required: i.required } : {}),
              })),
            }
          : {}),
      };
      await call('tests.expose', { path, expose });
      useApp.getState().toast(`${expose.tool} is an MCP tool of this workspace; connected agents see it after they reconnect`, 'success');
      onChanged(true);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const stop = async () => {
    if (
      !(await confirmAction({
        title: 'Stop exposing',
        message: `Remove the expose: block from tests/${path}? Agents lose the ${loaded.expose?.tool} tool when they reconnect.`,
        confirmLabel: 'Stop exposing',
        danger: true,
      }))
    )
      return;
    setBusy(true);
    try {
      await call('tests.expose', { path, expose: null });
      onChanged(false);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <Bot size={16} className="text-accent" /> {exposed ? 'Exposed as MCP tool' : 'Expose as MCP tool'}
        </span>
      }
      onClose={onClose}
      width={640}
      footer={
        <>
          {exposed && (
            <Button variant="danger" className="mr-auto" disabled={busy} onClick={() => void stop()}>
              Stop exposing
            </Button>
          )}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!!problem} title={problem} onClick={() => void save()}>
            {exposed ? 'Save' : 'Expose'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted leading-relaxed">
          AI agents connected to this workspace (Settings ▸ AI agents) get a tool of this name: calling it runs <span className="mono">tests/{path}</span> with the arguments as variables and returns
          each step's result and the values the flow extracted. This writes an <span className="mono">expose:</span> block into the file.
        </p>
        <Field label="Tool name" hint="snake_case; what the agent calls">
          <Input aria-label="Tool name" value={tool} onChange={(e) => setTool(e.target.value)} placeholder="checkout_flow" spellCheck={false} autoFocus />
        </Field>
        <Field label="Description" hint="What the flow checks and when an agent should run it">
          <textarea
            aria-label="Description"
            className="field min-h-16"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Create an order for a customer and check it can be fetched back"
          />
        </Field>
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-fg/80">Inputs</div>
            <Button size="sm" icon={<Plus size={12} />} onClick={() => setInputs([...inputs, { name: '' }])}>
              Add input
            </Button>
          </div>
          <div className="text-xs text-muted leading-snug">Variables the flow reads as {'{{name}}'}; each becomes an argument of the tool. Without a default an input is required.</div>
          {inputs.length > 0 && (
            <table className="w-full text-xs border-separate border-spacing-y-1">
              <thead className="text-muted text-left">
                <tr>
                  <th className="font-medium pl-1">Name</th>
                  <th className="font-medium">Description</th>
                  <th className="font-medium">Default</th>
                  <th className="font-medium text-center">Required</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inputs.map((i, n) => (
                  <tr key={n} className="group">
                    <td className="w-[26%]">
                      <Input aria-label="Input name" value={i.name} onChange={(e) => update(n, { name: e.target.value })} placeholder="customerId" spellCheck={false} />
                    </td>
                    <td>
                      <Input aria-label="Input description" value={i.description ?? ''} onChange={(e) => update(n, { description: e.target.value })} placeholder="The customer to order for" />
                    </td>
                    <td className="w-[20%]">
                      <Input aria-label="Input default" value={i.default ?? ''} onChange={(e) => update(n, { default: e.target.value })} placeholder="none" spellCheck={false} />
                    </td>
                    <td className="text-center">
                      <input
                        type="checkbox"
                        aria-label="Input required"
                        checked={(i.required ?? i.default === undefined) || i.default === ''}
                        onChange={(e) => update(n, { required: e.target.checked })}
                      />
                    </td>
                    <td className="w-8">
                      <IconButton label="Remove input" onClick={() => setInputs(inputs.filter((_, j) => j !== n))}>
                        <Trash2 size={13} />
                      </IconButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {problem && (tool || inputs.length > 0) && <div className="text-xs text-warn">{problem}</div>}
      </div>
    </Modal>
  );
}
