// The page's own code: the classic scripts index.html loads from js/app/, in
// the order it loads them, joined into one source -- one global scope, as in
// the browser. For tests that run the page's functions in node:vm.
import { readFileSync } from 'node:fs';

export function pageScript() {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const srcs = [...html.matchAll(/<script src="\.\/(js\/app\/[^"?]+)(?:\?[^"]*)?"><\/script>/g)].map(m => m[1]);
  if (!srcs.length) throw new Error('index.html loads no js/app/ scripts');
  return srcs.map(p => readFileSync(new URL('../' + p, import.meta.url), 'utf8')).join('\n');
}
