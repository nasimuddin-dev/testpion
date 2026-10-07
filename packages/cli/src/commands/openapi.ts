import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { fetchImportText, openApiOutline } from '@testpion/core';
import { EXIT, bold, dim, yellow, CliError } from '../shared.js';

/** `testpion openapi-ops <spec>`: an OpenAPI document's operations, the way its docs read. */
export function registerOpenApiCommands(program: Command): void {
  program
    .command('openapi-ops')
    .description(
      "list an OpenAPI / Swagger document's operations by tag: method, path, summary, parameters, request body and responses (--json adds the schemas as short type outlines and a ready request per operation)",
    )
    .argument('<spec>', 'the document: a file or an http(s) link')
    .option('--tag <tag>', 'only this tag')
    .option('--json', 'print the outline as JSON (for scripts and AI agents)')
    .action(async (ref: string, o: { tag?: string; json?: boolean }) => {
      let outline;
      try {
        outline = openApiOutline(/^https?:\/\//i.test(ref) ? (await fetchImportText(ref)).text : readFileSync(ref, 'utf8'));
      } catch (e) {
        throw new CliError((e as Error).message, EXIT.CONFIG_ERROR);
      }
      const tags = outline.tags.filter((t) => !o.tag || t.name.toLowerCase() === o.tag.toLowerCase());
      if (o.tag && !tags.length) throw new CliError(`No tag "${o.tag}": ${outline.tags.map((t) => t.name).join(', ')}`, EXIT.CONFIG_ERROR);
      if (o.json) return console.log(JSON.stringify({ ...outline, tags }, null, 2));
      console.log(bold(`${outline.title}${outline.version ? ` ${outline.version}` : ''}: ${outline.operations} operations`) + (outline.servers.length ? dim(`  ${outline.servers.join(', ')}`) : ''));
      for (const t of tags) {
        console.log(`\n${bold(t.name)}${t.description ? dim(`  ${t.description.split('\n')[0]}`) : ''}`);
        for (const op of t.operations) {
          const params = op.parameters.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ');
          const codes = op.responses.map((r) => r.code).join(' ');
          const line = `  ${op.method.padEnd(7)} ${op.path}${op.summary ? dim(`  ${op.summary}`) : ''}${params ? dim(`  (${params})`) : ''}${op.requestBody ? dim(`  body ${op.requestBody.contentType}`) : ''}${codes ? dim(`  → ${codes}`) : ''}`;
          console.log(op.deprecated ? yellow(`${line}  deprecated`) : line);
        }
      }
    });
}
