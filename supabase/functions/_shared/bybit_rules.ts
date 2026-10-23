// How a Bybit log line is tagged, shared by import-bybit (the Data Export
// CSVs) and sync-bybit (the same logs through the API) -- see import-bybit
// for what each kind means for the balance.

export const INTERNAL_KINDS = new Set(['transfer_internal', 'earn_internal', 'card_usd']);

export const RULES = {
  internalKinds: INTERNAL_KINDS,
  earnKinds: new Set(['earn_internal']),
  savingsTicker: 'SAVINGS:Bybit USD',
};

// A Funding account line, by its description and type ("Earn" / "Easy Earn
// | Flexible Subscription", "Bybit Card" / "Sale", ...): the CSV's Type and
// Description, the API's showBusiTypeEn and descriptionEn.
export function fundKind(desc: string, type: string, coin: string): string {
  const d = desc.toLowerCase();
  if (coin === 'USD') return 'card_usd';
  if (/subscription|redemption|auto-earn/.test(d)) return 'earn_internal';
  if (/transfer (to|from) unified trading/.test(d)) return 'transfer_internal';
  if (/interest distribution|rewards distribution/.test(d)) return 'interest';
  if (type === 'Deposit') return 'deposit';
  if (type === 'Withdraw' || type === 'Withdrawal') return 'withdrawal';
  if (type === 'Bybit Card') return 'card';
  if (type === 'Convert') return 'convert';
  if (type === 'Airdrop' || type === 'Rewards') return 'reward';
  if (type === 'Transfer in' || type === 'Transfer out') return 'transfer';
  return 'other';
}

// A Unified Trading line by the API's type, which names what the CSV shows
// as "--" (FLEXIBLE_STAKING_SUBSCRIPTION / _REDEMPTION: money to and from
// Earn; CURRENCY_BUY / _SELL: a small-balance conversion's legs).
export function utaKind(type: string): string {
  if (type === 'TRADE') return 'trade';
  if (type === 'TRANSFER_IN' || type === 'TRANSFER_OUT') return 'transfer_internal';
  if (type === 'CURRENCY_BUY' || type === 'CURRENCY_SELL') return 'convert';
  if (/STAKING|EARN|SAVING/.test(type)) return 'earn_internal';
  return type.toLowerCase();
}
