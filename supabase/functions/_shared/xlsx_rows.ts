// Lightweight .xlsx reader: unzip (fflate) and read the sheets' XML
// directly -- rows as { columnLetter: text }. A full SheetJS parse of a large
// broker report (T-Bank's since-2020 one: ~1 MB, 2,550 rows) took ~3x the
// CPU and memory, enough to hit the Edge Function limits; this needs neither
// styles nor formulas, just cell text in sheet order.

import { strFromU8, unzipSync } from 'npm:fflate@0.8.2';

const xmlText = (s: string) => s.replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export type XlsxRow = Record<string, string>;

export function xlsxRows(bytes: Uint8Array, maxRows = Infinity): XlsxRow[] {
  // Some writers (Ziraat's) use other part names and namespace-prefixed tags
  // (<x:row>, <x:c>), so neither is assumed.
  const files = unzipSync(bytes, { filter: f => /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i.test(f.name) });
  const sharedName = Object.keys(files).find(n => /sharedStrings\.xml$/i.test(n));
  const shared = sharedName
    ? [...strFromU8(files[sharedName]).matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g)].map(m => xmlText(m[1]))
    : [];
  const order = (n: string) => Number(n.match(/(\d+)\.xml$/i)?.[1] ?? 0);
  const sheets = Object.keys(files).filter(n => /worksheets\//i.test(n)).sort((a, b) => order(a) - order(b));
  const out: XlsxRow[] = [];
  for (const name of sheets) {
    const xml = strFromU8(files[name]);
    for (const rm of xml.matchAll(/<(?:\w+:)?row[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
      const row: XlsxRow = {};
      let next = 0;   // cells without an r="" reference follow the previous one
      for (const cm of rm[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const [, attrs, inner = ''] = cm;
        const ref = attrs.match(/\br="([A-Z]+)\d+"/)?.[1];
        const idx = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : next;
        next = idx + 1;
        let col = '', n = idx + 1;
        while (n > 0) { col = String.fromCharCode(65 + (n - 1) % 26) + col; n = Math.floor((n - 1) / 26); }
        const v = inner.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/)?.[1];
        const text = v === undefined ? xmlText(inner) : /t="s"/.test(attrs) ? (shared[Number(v)] ?? '') : xmlText(v);
        const clean = text.replace(/\s+/g, ' ').trim();
        if (clean) row[col] = clean;
      }
      if (Object.keys(row).length) out.push(row);
      if (out.length >= maxRows) return out;
    }
  }
  return out;
}
