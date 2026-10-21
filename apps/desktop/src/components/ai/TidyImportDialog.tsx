import { useState } from 'react';
import type { AiTaskResult, Proposal, ProposalItem } from '@testpion/core';
import { call } from '../../api';
import { useCollectionTree } from '../../lib/collections-store';
import { plural } from '../../lib/format';
import { AiEstimateLine } from './AiEstimateLine';
import { type AssistantRequest, type TidyImportRequest } from '../../store';
import { Badge, Button, Modal, Toggle, useDebounced } from '../ui';
import { AiPreviewDialog, type AiPrivacy } from './AiPreviewDialog';
import { ProposalReview } from './ProposalReview';
import { AiBusyLine, AiErrorPanel, AiHintField, AiPrimaryButton, AiPrivacyRow, AiRunFooter, AiTitle, applyProposalItems, initialPrivacy, proposalReviewProps, skippedNote, useAiEstimate, useAiRun } from './ai-run';

/**
 * "Tidy this import with AI" (AI-10): after a Postman / curl / HAR / Insomnia / Bruno import, or on any collection. TestPion
 * finds the hosts, tokens, tracking and duplicate requests and the chains a saved example confirms itself; the model names
 * and groups. The result opens in the one ProposalReview as separate changes (each verified: the collection stays valid
 * and every request sends what it sent), accepted one by one, with Undo. Without a model: the setup action and the
 * changes TestPion finds without AI.
 */
export function TidyImportDialog({ request, onClose }: { request: TidyImportRequest; onClose(): void }) {
  const cols = useCollectionTree();
  const col = cols.find((c) => c.id === request.collectionId);
  const leftovers = request.task === 'import-leftovers';
  const [flow, setFlow] = useState(false);
  const [hint, setHint] = useState('');
  const [privacy, setPrivacy] = useState<AiPrivacy>(initialPrivacy());
  const { busy, error, run, stop } = useAiRun('ti');
  const [proposal, setProposal] = useState<Proposal>();
  const [previewing, setPreviewing] = useState<AssistantRequest>();
  const params = (extra: { hint?: string; privacy?: AiPrivacy } = {}) => ({
    task: leftovers ? 'import-leftovers' : 'tidy-import',
    item: { kind: 'collection', collectionId: request.collectionId },
    context: leftovers ? {} : { options: { flow, ...(request.source ? { source: request.source } : {}) } },
    hint: extra.hint ?? (hint.trim() || undefined),
    privacy: extra.privacy ?? privacy,
  });
  const key = useDebounced(JSON.stringify(params()), 400);
  const estimate = useAiEstimate(proposal ? undefined : () => call<AiTaskResult>('ai.preview', JSON.parse(key) as Record<string, unknown>), [key, proposal]);

  const generate = (extra: { hint?: string; privacy?: AiPrivacy; noAi?: boolean } = {}) =>
    run(
      (id) =>
        extra.noAi && !leftovers
          ? call<{ proposal?: Proposal; problems?: string[] }>('ai.tidyImport', { collectionId: request.collectionId, source: request.source, noAi: true })
          : call<{ proposal?: Proposal; problems?: string[] }>('ai.runTask', { ...params(extra), requestId: id }),
      (r) => {
        if (!r.proposal) throw new Error(`Nothing to tidy${r.problems?.length ? `: ${r.problems.join('; ')}` : ''}.`);
        setProposal(r.proposal);
      },
    );
  const accept = async (items: ProposalItem[]) => {
    if (!proposal) return;
    const r = await applyProposalItems<{ applied: unknown[]; skipped: Array<{ reason: string }> }>(proposal, items, (r) => `Applied ${plural(r.applied.length, 'change')} to ${col?.name ?? 'the collection'}${skippedNote(r, true)}`);
    if (r) onClose();
  };

  if (proposal)
    return (
      <ProposalReview
        {...proposalReviewProps(proposal, {
          onClose,
          reset: () => setProposal(undefined),
          regenerate: (h) => {
            setHint(h);
            void generate({ hint: h });
          },
        })}
        acceptLabel="Apply selected changes"
        onAccept={accept}
      />
    );

  const cancel = () => (stop(), onClose());
  return (
    <Modal
      title={<AiTitle>{leftovers ? 'Fix what the import left with AI' : 'Tidy this import with AI'}</AiTitle>}
      onClose={cancel}
      width={640}
      footer={
        <AiRunFooter
          busy={!!busy}
          onPreview={() => setPreviewing({ task: leftovers ? 'import-leftovers' : 'tidy-import', title: leftovers ? 'Fix what the import left' : 'Tidy this import', context: params().context, item: params().item as AssistantRequest['item'], privacy })}
          onCancel={cancel}
          onStop={stop}
        >
          <AiPrimaryButton onClick={() => void generate()} data-tidy-generate="">
            {leftovers ? 'Rewrite the scripts' : 'Tidy'}
          </AiPrimaryButton>
        </AiRunFooter>
      }
    >
      <div className="grid gap-3 text-sm" data-tidy-import-dialog>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge>{col?.name ?? request.collectionId}</Badge>
          {request.source && <span className="text-xs text-muted">imported from {request.source}</span>}
        </div>
        <AiHintField value={hint} onChange={setHint} placeholder="e.g. group by resource, keep the login first" label="Hint for the tidy" />
        {!leftovers && <Toggle checked={flow} onChange={setFlow} label="Also write a flow that wires the requests" />}
        <AiPrivacyRow value={privacy} onChange={setPrivacy} />
        <AiEstimateLine estimate={estimate} data-tidy-estimate="" />
        {leftovers ? (
          <p className="text-xs text-muted">
            TestPion finds the scripts the import marked as needing a rewrite (they call something with no equivalent in TestPion's script API); the model rewrites each one with tp.*. The marked script, the request and its saved response are sent, never header values or tokens. Each rewritten script is checked: it must not use another tool's API, and it
            is run in the sandbox against the saved response (never against the real API). Nothing changes before you accept, and Undo puts it back.
          </p>
        ) : (
          <p className="text-xs text-muted">
            TestPion finds the hosts and tokens typed into requests, tracking, static and duplicate requests, and the ids an earlier saved response returns; the model names the requests, groups them in folders and picks the chains. Request URLs, names and a short
            saved response are sent, never header values or tokens. Every change is checked: the collection stays valid and every request sends exactly what it sent. Nothing changes before you accept, and Undo puts it back.
          </p>
        )}
        {busy && <AiBusyLine>{leftovers ? 'Rewriting and checking the scripts…' : 'Tidying and checking the changes…'}</AiBusyLine>}
        {error && (
          <AiErrorPanel error={error} onClose={onClose} data-tidy-error="">
            {!leftovers && (
              <Button size="sm" onClick={() => void generate({ noAi: true })} data-tidy-draft>
                Use what TestPion finds without AI
              </Button>
            )}
          </AiErrorPanel>
        )}
      </div>
      {previewing && (
        <AiPreviewDialog
          request={previewing}
          onClose={() => setPreviewing(undefined)}
          onSend={(p) => {
            setPreviewing(undefined);
            setPrivacy(p);
            void generate({ privacy: p });
          }}
        />
      )}
    </Modal>
  );
}
