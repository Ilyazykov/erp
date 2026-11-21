// One snapshot of the working tree into a folder: to check the steps are
// deterministic (two runs, the same files) or to look at a step by hand.
// Run: node tests/page_snapshot/run_once.mjs <out dir>
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { snapshot } from './snap.mjs';
import { FIXTURE } from './make_fixture.mjs';

await snapshot(join(dirname(fileURLToPath(import.meta.url)), '../..'), process.argv[2], FIXTURE);
