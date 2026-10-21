// Writes dist/fast-index.json after the build: what `testpion --version` and `testpion --help` print, in a file small
// enough to read without loading the command line (about 500 modules). bin/testpion.js answers those two from it.
// The index is made from the real program, so the two answers cannot drift apart; a test compares them anyway.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { buildProgram } = await import('../dist/index.js');
const program = buildProgram();

const commands = program.commands
  .filter((c) => !c._hidden)
  .map((c) => ({
    name: c.name(),
    aliases: c.aliases(),
    description: c.description(),
    summary: c.summary(),
    // `<name>`, `[name]`, `<name...>`: how the usage line writes each argument
    args: c.registeredArguments.map((a) => `${a.required ? '<' : '['}${a.name()}${a.variadic ? '...' : ''}${a.required ? '>' : ']'}`),
    // the listing only says "[options]"; which options is for the command's own help
    hasOptions: c.options.length > 0,
    group: c.helpGroup(),
  }));

const index = { name: program.name(), version: program.version(), description: program.description(), commands };
writeFileSync(fileURLToPath(new URL('../dist/fast-index.json', import.meta.url)), JSON.stringify(index));
console.log(`fast-index.json: ${commands.length} commands`);
