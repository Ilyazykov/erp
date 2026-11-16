// Checks the parser of Apple's purchase history (supabase/functions/_shared/
// apple.js, import-apple-purchases): orders, items, prices in each store's
// format, free orders and the page's own lines left out.
// Run: node tests/apple.test.mjs
import { parseApplePurchases, isApplePurchaseHistory, applePrice, appleDay } from '../supabase/functions/_shared/apple.js';

let failures = 0;
const check = (ok, msg) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const text = `
Report a Problem
Sign Out
Apple Account
Found 5 results.

12 Nov 2026
MQZFTJMF3S
Total ₺159,99
YouTube Premium
YouTube Premium
YouTube
Renews 12 Dec 2026
₺159,99

11 Nov 2026
R250GK3L96Z0G6
Total ₺0,00
Some Free App
Some Free App
Some Developer
Free

27 May 2025
MQZDVH0NML
Total ₺1.579,98
Gold Plan - Annual
Gold Plan - Annual
Flightradar24 | Flight Tracker
26 May 2025 - 26 May 2026
₺1.479,99
50 Super Love
50 Super Love
Boo Dating App
₺99,99

25 Feb 2022
MQZ87KY9Z5
Total 149 ₽
25 Feb 2022 - 25 Mar 2022
25 Feb 2022 - 25 Mar 2022
iCloud+ with 200 GB of storage
149 ₽

30 Dec 2019
MQZ16S0NYQ
Total RUB1,149.00
Some Game
Some Game
Some Studio
RUB1,149.00
Free Pack
Free Pack
Some Game
Free
Find a Store
Copyright © 2026 Apple Inc.
`;

check(isApplePurchaseHistory(text), 'recognised as the purchase history');
check(!isApplePurchaseHistory('receipt,date,store'), 'a receipt CSV is not');
check(appleDay('29 Sept 2026') === '2026-09-29', '"Sept" read as September');
check(applePrice('₺9.999,99').value === 9999.99 && applePrice('9,99 €').currency === 'EUR', 'lira and euro prices');
check(applePrice('1 690 ₽').value === 1690 && applePrice('RUB1,234.50').value === 1234.5, 'rouble prices');
check(applePrice('RUBY OYUN VE YAZILIM') === null, 'a developer named RUBY... is no price');

const { orders, free } = parseApplePurchases(text);
check(orders.length === 4 && free === 1, `4 paid orders, 1 free (got ${orders.length}, ${free})`);
const yt = orders[0];
check(yt.orderId === 'MQZFTJMF3S' && yt.date === '2026-11-12' && yt.currency === 'TRY' && yt.total === 159.99, 'the order: ID, day, currency, total');
check(yt.items[0].title === 'YouTube Premium' && yt.items[0].app === 'YouTube' && yt.items[0].period === 'Renews 12 Dec 2026', 'the item: title, app, renewal');
check(orders[1].items.length === 2 && orders[1].total === 1579.98 && orders[1].items[0].period === '26 May 2025 - 26 May 2026', 'two items in one order');
check(orders[2].items[0].title === 'iCloud+ with 200 GB of storage' && orders[2].items[0].period === '25 Feb 2022 - 25 Mar 2022', 'iCloud+: the plan after its period');
check(orders[3].items.length === 1 && orders[3].total === 1149, 'a free add-on in a paid order and the footer left out');
check(orders.every(o => !o.warnings.length), 'the items add up to every total');

if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nall ok');
