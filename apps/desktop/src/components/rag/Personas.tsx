import { Pencil, Plus, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import type { ListedPersona } from '@testpion/core';
import { call } from '../../api';
import { toastError, useApp } from '../../store';
import { useRpc } from '../../lib/use-rpc';
import { Badge, Button, Field, IconButton, Input, Modal, Spinner, Textarea, Toggle } from '../ui';

interface Draft {
  id: string;
  label: string;
  text: string;
  attack: boolean;
  /** Editing an existing persona: its id stays. */
  existing: boolean;
}

const EMPTY: Draft = { id: '', label: '', text: '', attack: false, existing: false };
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * Personas for simulated users: the built-in ones (read-only) and the team's own, kept in `personas.yaml` of the
 * workspace. A dataset record names one in its `persona` column and gives a `goal`; a model then plays that user against
 * the bot. The same list as `testpion rag personas`.
 */
export function Personas() {
  const [stamp, setStamp] = useState(0);
  const list = useRpc<ListedPersona[]>('rag.personas', { stamp }, { keep: true });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const reload = () => setStamp((s) => s + 1);
  if (!list)
    return (
      <div className="p-4">
        <Spinner />
      </div>
    );
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await call('rag.personaSave', { persona: { id: draft.id.trim().toLowerCase(), label: draft.label.trim(), text: draft.text.trim(), attack: draft.attack } });
      setDraft(null);
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (p: ListedPersona) => {
    try {
      const gone = await call<ListedPersona>('rag.personaDelete', { id: p.id });
      reload();
      useApp
        .getState()
        .toast(`Deleted the persona ${p.label}`, 'success', undefined, { undo: () => call('rag.personaSave', { persona: gone }).then(reload), restored: `Restored the persona ${p.label}` });
    } catch (e) {
      toastError(e);
    }
  };
  const id = draft?.id.trim().toLowerCase() ?? '';
  const taken = !!draft && !draft.existing && list.some((p) => p.id === id);
  const why = !draft
    ? undefined
    : !ID.test(id)
      ? 'Give it an id: lower-case letters, digits and dashes'
      : taken
        ? `There is already a persona "${id}"`
        : !draft.text.trim()
          ? 'Describe the user in words'
          : undefined;
  return (
    <section className="mt-8 max-w-2xl" data-rag-personas>
      <div className="flex items-center gap-2 mb-1">
        <h3 className="font-semibold flex items-center gap-2">
          <UserRound size={15} /> Personas for simulated users
        </h3>
        <div className="flex-1" />
        <Button size="sm" icon={<Plus size={12} />} onClick={() => setDraft(EMPTY)} data-rag-persona-new>
          New persona
        </Button>
      </div>
      <p className="text-muted mb-3">
        A test case with a <span className="mono text-xs">persona</span> and a <span className="mono text-xs">goal</span> is a conversation a model plays against your bot until the goal is met, it
        gives up, or the turn limit. Your own personas are kept in <span className="mono text-xs">personas.yaml</span> of the workspace.
      </p>
      <div className="rounded-lg border border-line divide-y divide-line/70">
        {list.map((p) => (
          <div key={p.id} className="flex items-start gap-3 px-3 py-2" data-rag-persona={p.id} data-source={p.source}>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{p.label}</span>
                <span className="mono text-xs text-muted">{p.id}</span>
                {p.attack && <Badge tone="warn">Attacker</Badge>}
                {p.source === 'built-in' ? <Badge>Built in</Badge> : <Badge tone="ok">Yours</Badge>}
              </div>
              <div className="text-xs text-muted line-clamp-2" title={p.text}>
                {p.text}
              </div>
            </div>
            {p.source === 'workspace' && (
              <>
                <IconButton label={`Edit ${p.label}`} onClick={() => setDraft({ id: p.id, label: p.label, text: p.text, attack: !!p.attack, existing: true })}>
                  <Pencil />
                </IconButton>
                <IconButton label={`Delete ${p.label}`} onClick={() => void remove(p)} data-rag-persona-delete={p.id}>
                  <Trash2 />
                </IconButton>
              </>
            )}
          </div>
        ))}
      </div>
      {draft && (
        <Modal
          title={draft.existing ? `Edit the persona ${draft.id}` : 'New persona'}
          onClose={() => setDraft(null)}
          onSubmit={() => void (!why && !busy && save())}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!!why || busy} reason={why} onClick={() => void save()} data-rag-persona-save>
                Save
              </Button>
            </>
          }
        >
          <div className="grid gap-3" data-rag-persona-dialog>
            <Field label="Id" hint="What a test case writes in its persona column">
              <Input
                value={draft.id}
                disabled={draft.existing}
                onChange={(e) => setDraft({ ...draft, id: e.target.value })}
                placeholder="night-nurse"
               
                data-rag-persona-id
              />
            </Field>
            <Field label="Name">
              <Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Night nurse" />
            </Field>
            <Field label="The user in words" hint="How they write, what they leave out until asked, when they give up">
              <Textarea
                value={draft.text}
                onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                rows={5}
                placeholder="A nurse at the end of a night shift who writes short messages with abbreviations, and stops after one answer that does not help."
                data-rag-persona-text
              />
            </Field>
            <Toggle
              checked={draft.attack}
              onChange={(attack) => setDraft({ ...draft, attack })}
              label="An attacker: the goal is something the bot must not do"
              title="For red teaming: a goal that is met is a failed test (the check attack-resisted)"
            />
          </div>
        </Modal>
      )}
    </section>
  );
}
