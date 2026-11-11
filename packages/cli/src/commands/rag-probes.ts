/**
 * `testpion rag probes list|add`: the seeded safety probe sets (jailbreaks, planted instructions, personal data, abuse, bias,
 * off-topic requests, harmless look-alikes). `add` writes them into the workspace as datasets (`datasets/probes-<set>.jsonl`),
 * never over a file that is there, so your own probes added to a file are kept; run them with the `safety` preset.
 */
import { Command } from 'commander';
import { PERSONAS, PERSONAS_FILE, PROBE_SETS, SIMULATE_DEFAULT_TURNS, SIMULATE_MAX_TURNS, listProbeSets, readPersonas, seedProbeSets, type Persona } from '@testpion/core';
import { EXIT, CliError, bold, dim, green, printJson, withWorkspace, yellow } from '../shared.js';

/** The personas of the workspace the command runs in (or -w names); none outside a workspace. */
async function ownPersonas(workspace?: string): Promise<Persona[]> {
  try {
    return await withWorkspace(workspace, (store, ephemeral) => (ephemeral ? [] : readPersonas(store.root)));
  } catch (e) {
    if (workspace) throw e;
    return [];
  }
}

export function registerRagProbeCommands(rag: Command): void {
  rag
    .command('personas')
    .description('the built-in personas of a simulated user: a dataset record with a persona (one of these ids, or your own words) and a goal is a conversation a model plays until the goal is met, it gives up, or max_turns')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory: its own personas (personas.yaml) are listed too')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action(async (o: { json?: boolean; workspace?: string }) => {
      const own = await ownPersonas(o.workspace);
      const columns = { persona: 'one of the ids, or a description of the user in words', goal: 'what the user wants (expected_outcome works too)', question: 'optional: the opening message (left out, the model writes it)', max_turns: `most user messages (default ${SIMULATE_DEFAULT_TURNS}, at most ${SIMULATE_MAX_TURNS})`, simulate: 'true: a simulated user without naming a persona (the plain one)' };
      if (o.json) return printJson({ personas: [...PERSONAS.map((p) => ({ ...p, source: 'built-in' })), ...own.map((p) => ({ ...p, source: 'workspace' }))], file: PERSONAS_FILE, columns, example: { id: 'booking-terse', persona: 'terse', goal: 'Book a visit for a dog on Tuesday morning', max_turns: 6 } });
      for (const p of PERSONAS) console.log(`${bold(p.id.padEnd(10))} ${p.text}`);
      for (const p of own) console.log(`${bold(p.id.padEnd(10))} ${p.text} ${dim(`(${PERSONAS_FILE})`)}`);
      console.log('');
      console.log(dim('A dataset line: {"id": "booking-terse", "persona": "terse", "goal": "Book a visit for a dog on Tuesday morning"}'));
      console.log(dim('The simulated user runs on the judge of the evaluation; score the conversation with goal-accuracy, user-friction, knowledge-retention …'));
    });

  const probes = rag.command('probes').description('seeded safety probe sets: prompts a safe RAG system should refuse, resist or answer carefully, as datasets in the workspace (run them with --preset safety)');

  probes
    .command('list')
    .description('the built-in probe sets, and which are in the workspace (with how many records they hold now)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print as JSON (for scripts and AI agents)')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        const list = ephemeral ? PROBE_SETS.map((s) => ({ id: s.id, title: s.title, description: s.description, metrics: s.metrics, file: `datasets/probes-${s.id}.jsonl`, builtIn: s.records.length, inWorkspace: false })) : listProbeSets(store);
        if (o.json) return printJson({ sets: list });
        for (const s of list) {
          console.log(`${bold(s.id.padEnd(12))} ${s.title} ${dim(`· ${s.builtIn} built-in${s.inWorkspace ? ` · in the workspace (${(s as { records?: number }).records} records)` : ''}`)}`);
          console.log(`  ${dim(s.description)}`);
          console.log(`  ${dim(`metrics: ${s.metrics.join(', ')}`)}`);
        }
        console.log(dim('\n`testpion rag probes add` writes them to datasets/; run a set with `testpion rag run <evaluation> --preset safety`.'));
      }),
    );

  probes
    .command('add')
    .description('write the probe sets into the workspace as datasets; a file that exists is left as it is (it may hold your own probes)')
    .argument('[sets...]', 'which sets (default: all)')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory')
    .option('--json', 'print { written, skipped, unknown } as JSON')
    .action((sets: string[], o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store, ephemeral) => {
        if (ephemeral) throw new CliError('No workspace found: run inside a workspace or pass -w <nameOrPath>', EXIT.CONFIG_ERROR);
        const r = seedProbeSets(store, sets);
        if (o.json) return printJson(r);
        for (const f of r.written) console.log(`${green('Wrote')} ${f}`);
        for (const f of r.skipped) console.log(`${yellow('Kept')}  ${f} ${dim('(it exists: your lines stay)')}`);
        if (r.unknown.length) throw new CliError(`No probe set called ${r.unknown.map((u) => `"${u}"`).join(', ')}. Sets: ${PROBE_SETS.map((s) => s.id).join(', ')}`, EXIT.CONFIG_ERROR);
        console.log(dim('Add your own probes as lines of the same files: id, question, probe, should_refuse, canaries, tags.'));
      }),
    );
}
