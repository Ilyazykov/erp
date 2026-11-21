// A refactoring's guard: the page as committed (a git ref, HEAD by default)
// and as it is in the working tree, each run through the same steps on the
// same synthetic data (snap.mjs), must give the same DOM, the same Plotly
// calls, the same errors and the same form values at every step.
// Run: npm install (once), then node tests/page_snapshot/compare.mjs [ref]
// (Chrome: the macOS default path, or set CHROME). Exit code 1 on a difference;
// the snapshots stay in the folder it prints, to diff by hand.
import { execSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './snap.mjs';
import { FIXTURE } from './make_fixture.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ref = process.argv[2] || 'HEAD';
const work = mkdtempSync(join(tmpdir(), 'erp-snap-'));
const before = join(work, 'site-' + ref.replace(/[^\w.-]/g, '_'));
mkdirSync(before);
// what the page loads: index.html, its scripts and styles, the data it fetches
const paths = ['index.html', 'js', 'css', 'data'].filter(p => {
  try { execSync(`git cat-file -e ${ref}:${p}`, { cwd: REPO, stdio: 'ignore' }); return true; } catch { return false; }
});
execSync(`git archive ${ref} ${paths.join(' ')} | tar -x -C "${before}"`, { cwd: REPO, shell: '/bin/sh' });

console.log(`snapshots in ${work}`);
await snapshot(before, join(work, 'before'), FIXTURE);
await snapshot(REPO, join(work, 'after'), FIXTURE);

const a = readdirSync(join(work, 'before')).sort(), b = readdirSync(join(work, 'after')).sort();
const diffs = [];
for (const f of new Set([...a, ...b])) {
  if (!a.includes(f) || !b.includes(f)) { diffs.push(`${f}: only ${a.includes(f) ? 'before' : 'after'}`); continue; }
  const x = readFileSync(join(work, 'before', f), 'utf8').split('\n'), y = readFileSync(join(work, 'after', f), 'utf8').split('\n');
  const i = x.findIndex((l, k) => l !== y[k]);
  if (i >= 0 || x.length !== y.length) {
    const k = i >= 0 ? i : Math.min(x.length, y.length);
    diffs.push(`${f}, line ${k + 1}:\n  before: ${(x[k] ?? '(end)').slice(0, 300)}\n  after:  ${(y[k] ?? '(end)').slice(0, 300)}`);
  }
}
const steps = new Set(a.map(f => f.split('.')[0])).size;
const errors = a.filter(f => f.endsWith('.errors.txt')).map(f => readFileSync(join(work, 'before', f), 'utf8')).filter(Boolean);
if (errors.length) console.log(`(the page as of ${ref} itself reports errors in ${errors.length} step(s): see before/*.errors.txt)`);
if (diffs.length) {
  console.log(`${diffs.length} of ${a.length} files differ (${steps} steps):\n` + diffs.slice(0, 30).join('\n'));
  process.exit(1);
}
console.log(`the same: ${steps} steps, ${a.length} files`);
