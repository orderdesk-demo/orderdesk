/**
 * npm test: runs every *.test.mjs suite except the browser test, one after another.
 * The browser test needs Chrome: npm run test:ui
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const dir = path.join(ROOT, 'tests');
const suites = readdirSync(dir)
  .filter((file) => file.endsWith('.test.mjs') && file !== 'ui.test.mjs')
  .sort();

const results = suites.map((file) => {
  const { status } = spawnSync(process.execPath, [path.join(dir, file)], { cwd: ROOT, stdio: 'inherit' });
  return { file, ok: status === 0 };
});

console.log('\n==================== Summary ====================');
for (const { file, ok } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${file}`);
console.log('\nBrowser end-to-end test (needs Chrome): npm run test:ui');
process.exit(results.every((r) => r.ok) ? 0 : 1);
