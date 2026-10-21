/**
 * MCP tool for AI-9 (contract drift): `contract_drift` compares an OpenAPI document of the workspace with real traffic
 * (History, a HAR file or a run) and returns what differs — found deterministically, no model — and, with `ai: true`, the
 * model's explanation per finding and the fix as a proposal (a spec patch made from what was observed, a contract check),
 * verified against the same traffic. `propose: true` makes TestPion's own patches a proposal without a model. Nothing is
 * written: `ai_apply_proposal` applies, after the user agrees.
 */
import { contractDrift, draftDriftProposal, sourceOf } from '../../ai/contract-drift.js';
import { driftMarkdown } from '../../openapi/drift.js';
import { ApsError } from '../../errors.js';
import type { AppSettings } from '../../model/types.js';
import type { SecretStore } from '../../storage/secrets.js';
import type { WorkspaceStore } from '../../storage/workspace.js';
import { createProposer, forAgent, PRIVACY } from './ai-propose.js';
import { str, type Tool } from '../tool.js';

export function aiDriftTools({ store, secrets, settings }: { store: WorkspaceStore; secrets: SecretStore; settings: AppSettings }): Tool[] {
  const propose = createProposer({ store, secrets, settings });
  return [
    {
      name: 'contract_drift',
      description:
        "Compare an API definition (OpenAPI under specs/) with real traffic and report the drift, deterministically: an endpoint, a status or a content type the document lacks; a field the schema does not have; a type that differs from the schema; a required field that is missing; a null the schema forbids; a value outside an enum — each with where (operation, status, JSON path), what the document says, what was seen, how many of the responses had it and a few examples. The traffic is History (the newest `limit`, optionally one `host` or saved request), a HAR file (`har`, e.g. a saved Debugger session) or a run (`runId`: the responses its HTTP results stored). With `ai: true` TestPion's model (the user's key or a local model) explains each finding — who is right (the document is outdated, the API has a bug, a test is stale), the impact, the action — and the fix is returned as a proposal: spec patches TestPion makes from what was observed (never written by the model) and contract checks pinned to saved requests, each verified against the same traffic (the drift must be gone, no other may appear, the document must lint no worse). `propose: true` offers TestPion's own patches without a model (additions are ticked, changes of type or required fields are not). Nothing is written: apply the proposal with ai_apply_proposal after the user agrees (ai_undo_proposal restores the file).",
      inputSchema: {
        type: 'object',
        properties: {
          spec: str('The API definition in the workspace, e.g. specs/clinic.yaml (openapi_outline lists them)'),
          source: { type: 'string', enum: ['history', 'har', 'run'], description: 'Where the traffic comes from (default history; har when `har` is given, run when `runId` is)' },
          limit: { type: 'number', description: 'History: how many of the newest responses (default 300, most 2000)' },
          host: str('History: only responses from this host (127.0.0.1:4010)'),
          requestId: str('History: only responses of this saved request'),
          har: str('A HAR file: a path in the workspace'),
          runId: str('A run id (or "last"): its HTTP results with the responses they stored'),
          ai: { type: 'boolean', description: 'Have the model explain the findings and propose the fix (a proposal; falls back to TestPion’s own patches without a model)' },
          propose: { type: 'boolean', description: 'TestPion’s own patches as a proposal, no model' },
          hint: str('An extra instruction for the model, e.g. "the nickname field is new in v2"'),
          privacy: PRIVACY,
          environment: str('Environment whose variable names the model may know'),
          format: { type: 'string', enum: ['json', 'markdown'], description: 'The report as json (default) or Markdown' },
          dryRun: { type: 'boolean', description: 'With ai: send nothing, return what would be sent and the estimate' },
        },
        required: ['spec'],
      },
      run: async (a) => {
        const spec = String(a.spec ?? '').replace(/\\/g, '/');
        if (!spec) throw new ApsError('ValidationError', 'spec is required: an API definition of the workspace (specs/clinic.yaml; openapi_outline lists them)');
        const source = sourceOf({ kind: a.source, limit: a.limit, host: a.host, requestId: a.requestId, har: a.har, runId: a.runId });
        const next = (p: { id: string }) => `Show the user each finding (proposal.findings: who is right, the impact, the evidence) and each patch (proposal.items[].after against .before, its verification); apply the ones they agree with by ai_apply_proposal { id: "${p.id}", items: [...] }; ai_undo_proposal restores the document.`;
        if (a.ai === true)
          return propose({ task: 'contract-drift', item: { kind: 'spec', path: spec }, context: { options: { source } }, a, draft: (reason) => draftDriftProposal(store, spec, source, { surface: 'mcp', reason }), next });
        if (a.propose === true) {
          const p = await draftDriftProposal(store, spec, source, { surface: 'mcp' });
          return { proposal: forAgent(p), next: next(p) };
        }
        const report = await contractDrift(store, spec, source);
        return a.format === 'markdown'
          ? { markdown: driftMarkdown(report, spec), patchable: report.patchable }
          : { ...report, next: `contract_drift { spec: "${spec}", ai: true } explains the findings and proposes the fix (propose: true makes TestPion’s own patches without a model).` };
      },
    },
  ];
}
