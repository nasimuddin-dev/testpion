/** `testpion flows`: the flows (test files and suites with an expose: block) the MCP server offers to agents as tools. */
import { Command } from 'commander';
import { exposedFlows, inputRequired } from '@testpion/core';
import { bold, dim, printJson, red, withWorkspace, yellow } from '../shared.js';

export function registerFlowsCommand(program: Command): void {
  program
    .command('flows')
    .description('list the flows exposed as MCP tools (test files and suites with an expose: block): tool name, file and inputs')
    .option('-w, --workspace <nameOrPath>', 'workspace name or directory (default: nearest workspace.json)')
    .option('--json', 'print as JSON')
    .action((o: { workspace?: string; json?: boolean }) =>
      withWorkspace(o.workspace, (store) => {
        const flows = exposedFlows(store);
        if (o.json) return printJson(flows);
        if (!flows.length) {
          console.log(yellow('No flow is exposed as a tool yet.'));
          console.log(dim('Add to a test file or suite:  expose: { tool: checkout_flow, description: …, inputs: [{ name: customerId }] }  (or Tests ▸ file menu ▸ Expose as MCP tool… in the app).'));
          return;
        }
        for (const f of flows) {
          const inputs = f.inputs.map((i) => `${i.name}${inputRequired(i) ? '' : '?'}${i.default !== undefined ? `=${i.default}` : ''}`).join(', ');
          console.log(`${f.problem ? red(f.tool || '(invalid)') : bold(f.tool)}  ${dim(`tests/${f.file}`)}${inputs ? `  (${inputs})` : ''}`);
          if (f.description) console.log(`  ${f.description}`);
          if (f.problem) console.log(`  ${red(f.problem)}`);
        }
        console.log(dim(`\n${flows.length} flow${flows.length > 1 ? 's' : ''}; agents call them by name through \`testpion mcp-server\` (testpion flows --json for the details).`));
      }),
    );
}
