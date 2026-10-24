// T-Invest REST (invest-public-api.tbank.ru), shared by sync-tbank and
// sync-estimates (the declared dividends of any MOEX share). Its certificate
// is the Russian root CA's: trusted for this connection only.

import { RUSSIAN_TRUSTED_ROOT_CA } from './russian_root_ca.ts';

const API = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1.';

let client: Deno.HttpClient | null = null;
// deno-lint-ignore no-explicit-any
export async function tinvest(token: string, method: string, body: Record<string, unknown>): Promise<any> {
  client ??= Deno.createHttpClient({ caCerts: [RUSSIAN_TRUSTED_ROOT_CA] });
  const res = await fetch(API + method, {
    method: 'POST', client,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } as RequestInit);
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`T-Invest ${method}: HTTP ${res.status} ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(`T-Invest ${out?.code ?? res.status} ${out?.message ?? ''} ${out?.description ?? ''} (${method})`.trim());
  return out;
}

// deno-lint-ignore no-explicit-any
export const money = (m: any) => m ? Number(m.units ?? 0) + Number(m.nano ?? 0) / 1e9 : 0;
