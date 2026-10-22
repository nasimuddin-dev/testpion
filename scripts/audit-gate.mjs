// The dependency gate of CI: `npm audit --omit=dev --audit-level=high`, except the advisories that scripts/audit-allow.json
// lists with the reason they do not apply. A listed advisory also has an `until` date: past it the gate fails again, so an
// exception is looked at again instead of being forgotten. Run it locally: node scripts/audit-gate.mjs
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const allow = JSON.parse(readFileSync(join(here, 'audit-allow.json'), 'utf8')).advisories ?? [];
const r = spawnSync('npm audit --omit=dev --json', { encoding: 'utf8', shell: true, cwd: join(here, '..'), maxBuffer: 64 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(r.stdout);
} catch {
  console.error('npm audit gave no report:\n' + (r.stderr || r.stdout));
  process.exit(2);
}
if (report.error) {
  console.error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const level = { low: 1, moderate: 2, high: 3, critical: 4 };
const failures = [];
const allowedSeen = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  if ((level[v.severity] ?? 0) < level.high) continue;
  // the advisories behind this package (a dependency chain lists the advisory objects of the package that has them)
  const ids = (v.via ?? []).filter((x) => typeof x === 'object').map((x) => String(x.url ?? '').split('/').pop());
  if (!ids.length) continue; // a package that is only vulnerable through another: that one is judged by its own advisories
  const open = ids.filter((id) => {
    const a = allow.find((e) => e.id === id);
    if (!a) return true;
    if (a.until && a.until < today) {
      failures.push(`${name}: the exception for ${id} expired on ${a.until} (${a.reason})`);
      return false;
    }
    allowedSeen.push(`${name} ${id}: ${a.reason}`);
    return false;
  });
  if (open.length) failures.push(`${name} (${v.severity}): ${open.join(', ')}${v.fixAvailable ? ' — a fix is available: npm audit fix' : ''}`);
}
for (const a of allowedSeen) console.log(`allowed: ${a}`);
if (failures.length) {
  console.error('Dependency audit failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('Dependency audit: no high or critical advisory in the production dependencies that is not listed in scripts/audit-allow.json');
