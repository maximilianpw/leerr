import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Keep the probe inside the lint scope, and always remove it afterwards.
const directory = mkdtempSync('server/lint-probe-');
try {
  const path = join(directory, 'violation.ts');
  writeFileSync(path, 'export const doubled = [1, 2, 3].filter(n => n > 1).map(n => n * 2);\n');
  const result = spawnSync('node_modules/.bin/oxlint', ['--threads', '1', '--config', 'oxlint.config.ts', path], { encoding: 'utf8' });
  const output = result.stdout + result.stderr;
  if (result.status !== 1 || !output.includes('no-array-filter-map')) {
    process.stderr.write(output);
    throw new Error('Anti-slop activation check failed. See docs/server-development.md for constrained Linux allocator prerequisites.');
  }
  process.stdout.write('PASS: anti-slop/no-array-filter-map rejects a deliberate violation.\n');
} finally { rmSync(directory, { recursive: true, force: true }); }
