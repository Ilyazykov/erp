// The portfolio-composition donuts embedded in My Portfolio and the stock tabs,
// and the Z-score allocators of the money to invest.

// ---- Portfolio-composition pie charts (embedded in the existing tabs) ----
// All four read the same portfolio_value_usd snapshot once, then slice it
// differently client-side -- no extra network round-trips per chart.
// Same ticker set as data/target_weights.json (equities + the three
// target-list funds TRND/AKME/AKFN). Must include every row shown in the
// Russian-stocks donut, otherwise Actual%/New% are computed against a
// smaller denominator than the RUB columns.
const RU_STOCK_TICKERS = ['SBER', 'YDEX', 'T', 'DOMRF', 'TRND', 'OZON', 'AKME', 'AKFN', 'ROSN', 'VTBR', 'GMKN', 'PLZL', 'IRAO'];
// Same 37-ticker list as US_TICKERS inside loadData()'s renderChart('usstocks')
// closure -- duplicated here (tickers only, weights not needed) since that
// one is local to loadData() and this code runs independently of chart
// rendering/login state.
const US_STOCK_TICKERS = [
  'GOOGL', 'NVDA', 'LLY', 'CAT', 'LIN', 'GE', 'AMZN', 'WMT', 'XOM', 'NEE', 'PLD',
  'JPM', 'BRK-B', 'JNJ', 'META', 'V', 'MA', 'HOOD', 'MSFT', 'AAPL', 'ABBV',
  'TSLA', 'HD', 'PG', 'KO', 'SHEL', 'CVX', 'SHW', 'DUK', 'AMT', 'SOFI', 'XYZ',
  'INTC', 'SPCX', 'FCX', 'SO', 'EQIX',
];



// Same "bulge past the dotted circle = overweight, dip short of it =
// underweight" donut as targetWeights/usTargetWeights/allocTarget above,
// but comparing the USER'S ACTUAL portfolio (from portfolio_value_usd)
// against those same target weights, instead of comparing target-vs-base
// within the strategy itself. Sector angular width = target weight (so
// weights tile the full circle); radial extent = R_BASE * (current/target).
function mpDonutLayout(maxR) {
  return {
    paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117',
    font: { color: '#c9d1d9', size: 10 },
    polar: {
      domain: { x: [0.1, 0.9], y: [0.06, 0.94] },
      bgcolor: '#0d1117',
      radialaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', range: [0, maxR * 1.25], showticklabels: false },
      angularaxis: { gridcolor: '#1e2830', linecolor: '#1e2830', showticklabels: false, rotation: 90, direction: 'clockwise' },
    },
    showlegend: true,
    legend: { bgcolor: '#13191f', bordercolor: '#1e2830', borderwidth: 1, x: 0.5, y: -0.06, xanchor: 'center', yanchor: 'top', orientation: 'h', font: { size: 9 } },
    margin: { t: 10, r: 10, b: 10, l: 10 },
  };
}

// items: [{ label, target, current, color }], target/current in the same
// unit (e.g. USD value, or % — only their ratio matters). `totalUsd` (the
// USD sum this category's current% was computed against) is required to
// turn the target/actual gap into an actionable "buy/sell $X" figure in
// the table; pass it via each item, or as a shared `sharedTotalUsd` third
// arg when every item shares the same denominator. `actionColLabel`
// (optional) lets one call site customize that column's header text (e.g.
// "Target CNY sale (RUB)" for the RUB/CNY donut) instead of the generic
// default, since the same function backs 4 differently-themed tables.

// LEGACY, unmodified: allocates a user-supplied cash injection (plus
// proceeds from selling down overweight Z<-1.5 tickers) across the
// portfolio in fractional dollar amounts -- no whole-share rounding at
// all. Kept exactly as it was before whole-share support was added, so
// the "Account for share price" checkbox can show a genuine before/after,
// not a flag-toggled variant of the new code. Priority order:
//
//   0. pool = userInjectionUsd. Portfolio total for target amounts is
//      original holdings + this injection (selling only moves money from
//      a ticker into the pool; it does not change the total).
//   1. SELL every Z<-1.5 ticker that's currently ABOVE its target (down to
//      target, never below) -- proceeds go into the pool. Absolute target
//      USD = target% × (original total + injection).
//   2. Z>+1.5 tickers that are below target split the pool, each getting
//      a share proportional to ITS OWN shortfall (target - current) --
//      capped so no one gets more than needed to exactly reach target.
//   3. Any pool left over goes the same way to neutral-Z tickers
//      (-1.5 <= Z <= 1.5) that are below target.
//   4. Any pool still left over goes to Z<-1.5 tickers that are below
//      target (didn't get sold in step 1 because they were already
//      underweight).
//
// Returns { deltaUsdByItem, newTotalUsd, leftoverPoolUsd } where
// deltaUsdByItem is signed (negative = sold, positive = bought) and
// newTotalUsd = original total + userInjectionUsd.
function mpAllocatePoolByZPriorityLegacy(usable, totalUsd, userInjectionUsd) {
  const totalTarget = usable.reduce((s, it) => s + it.target, 0);
  const injection = Math.max(0, userInjectionUsd || 0);
  const newTotalUsd = totalUsd + injection;
  const targetUsdOf = (it) => totalTarget > 0 ? (it.target / totalTarget * newTotalUsd) : 0;
  const currentUsdOf = (it) => it.current / 100 * totalUsd;

  const deltaUsdByItem = new Map(usable.map(it => [it, 0]));
  let pool = injection;

  // Step 1: sell overweight Z<-1.5 tickers down to the new target amount.
  usable.forEach(it => {
    if (it.z !== null && it.z !== undefined && it.z < -1.5) {
      const excess = currentUsdOf(it) - targetUsdOf(it);
      if (excess > 0) {
        deltaUsdByItem.set(it, -excess);
        pool += excess;
      }
    }
  });

  // Steps 2-4: fill shortfalls in priority-group order, proportional to
  // each ticker's own shortfall, never exceeding it.
  const isBelowTarget = (it) => currentUsdOf(it) + deltaUsdByItem.get(it) < targetUsdOf(it) - 0.005;
  const shortfallOf = (it) => targetUsdOf(it) - (currentUsdOf(it) + deltaUsdByItem.get(it));
  const groups = [
    usable.filter(it => it.z !== null && it.z !== undefined && it.z > 1.5 && isBelowTarget(it)),
    usable.filter(it => (it.z === null || it.z === undefined || (it.z >= -1.5 && it.z <= 1.5)) && isBelowTarget(it)),
    usable.filter(it => it.z !== null && it.z !== undefined && it.z < -1.5 && isBelowTarget(it)),
  ];
  for (const group of groups) {
    if (pool <= 0 || !group.length) continue;
    const totalShortfall = group.reduce((s, it) => s + shortfallOf(it), 0);
    if (totalShortfall <= 0) continue;
    if (pool >= totalShortfall) {
      group.forEach(it => deltaUsdByItem.set(it, deltaUsdByItem.get(it) + shortfallOf(it)));
      pool -= totalShortfall;
    } else {
      group.forEach(it => deltaUsdByItem.set(it, deltaUsdByItem.get(it) + shortfallOf(it) / totalShortfall * pool));
      pool = 0;
    }
  }

  return { deltaUsdByItem, newTotalUsd, leftoverPoolUsd: pool };
}

// NEW: same priority order as the legacy function above (sell Z<-1.5
// overweight -> fill Z>1.5 shortfalls -> fill neutral -> fill remaining
// Z<-1.5), but real trades happen in whole shares, not fractional dollar
// amounts, so every buy/sell here is rounded to a whole-share quantity
// using `priceUsd`. The dollars lost to rounding don't vanish -- they're
// swept back into the pool and re-offered to the same group (in case a
// cheaper ticker there can still absorb a whole share), then to the next
// group in priority order, repeating until no group can place another
// whole share. Tickers with an unknown priceUsd fall back to unrounded
// (fractional) allocation, since there's no lot size to round to.
//
// Returns the same shape as the legacy function.
function mpAllocatePoolByZPriorityWithLots(usable, totalUsd, userInjectionUsd) {
  const totalTarget = usable.reduce((s, it) => s + it.target, 0);
  const injection = Math.max(0, userInjectionUsd || 0);
  const newTotalUsd = totalUsd + injection;
  const targetUsdOf = (it) => totalTarget > 0 ? (it.target / totalTarget * newTotalUsd) : 0;
  const currentUsdOf = (it) => it.current / 100 * totalUsd;
  // poolAvailable caps the result, not just usdAmount -- when an earlier
  // green-zone ticker's overshoot (see roundToLotAllowOvershoot) eats into
  // what later tickers in the same pass expected to receive, their
  // nominal pro-rata "share" can end up bigger than what's actually left
  // in the pool. Flooring `usdAmount` alone (ignoring the real remaining
  // balance) would then round to a share count the pool can't afford.
  const roundDownToLot = (it, usdAmount, poolAvailable) => {
    if (!it.priceUsd || usdAmount <= 0) return 0;
    const capped = poolAvailable !== undefined ? Math.min(usdAmount, poolAvailable) : usdAmount;
    if (capped <= 0) return 0;
    const shares = Math.floor(capped / it.priceUsd);
    return shares * it.priceUsd;
  };
  // For Z>1.5 (green-zone) tickers only: if the fractional remainder after
  // rounding down is at least half a share AND there's enough pool left to
  // cover the extra cost, round UP instead -- landing a hair past target
  // is fine for a green-zone ticker specifically, per the user's rule.
  // Gray/red-zone tickers never get this -- they only ever round down, so
  // they can approach target but never cross it.
  const roundToLotAllowOvershoot = (it, usdAmount, poolAvailable) => {
    if (!it.priceUsd || usdAmount <= 0) return 0;
    // The floor/fallback path must also be capped by poolAvailable, not
    // just the overshoot path -- usdAmount is this ticker's nominal
    // pro-rata cut, which can exceed what's actually left in the pool if
    // an earlier ticker in this same pass already overshot past its own
    // cut (see roundDownToLot for the same issue on the non-green path).
    const affordableShares = Math.floor(poolAvailable / it.priceUsd);
    const exactShares = usdAmount / it.priceUsd;
    const flooredShares = Math.min(Math.floor(exactShares), affordableShares);
    const remainder = exactShares - Math.floor(exactShares);
    // poolAvailable must cover the FULL cost of the rounded-up share
    // count, not just the incremental "extra" over the pro-rata share --
    // `usdAmount` (this ticker's pro-rata cut) hasn't actually been spent
    // yet at the point this is called, so the whole (flooredShares+1)
    // purchase competes for the same uncommitted pool as every other
    // ticker still to be processed this pass.
    const roundedUpCost = (flooredShares + 1) * it.priceUsd;
    if (remainder > 0 && flooredShares === Math.floor(exactShares) && poolAvailable >= roundedUpCost) {
      return roundedUpCost;
    }
    return Math.max(0, flooredShares) * it.priceUsd;
  };

  const deltaUsdByItem = new Map(usable.map(it => [it, 0]));
  let pool = injection;

  // Step 1: sell overweight Z<-1.5 tickers down to the new target amount,
  // rounding the sale down to whole shares (selling fewer shares than the
  // uncapped excess, never more -- so the position stays at/above target,
  // not dipping below it from an over-eager sale).
  usable.forEach(it => {
    if (it.z !== null && it.z !== undefined && it.z < -1.5) {
      const excess = currentUsdOf(it) - targetUsdOf(it);
      if (excess > 0) {
        const roundedExcess = roundDownToLot(it, excess);
        if (roundedExcess > 0) {
          deltaUsdByItem.set(it, -roundedExcess);
          pool += roundedExcess;
        }
      }
    }
  });

  // Steps 2-4: fill shortfalls in priority-group order, proportional to
  // each ticker's own shortfall, never exceeding it, rounded down to
  // whole shares. Re-loop each group until it can't place another whole
  // share with the pool on hand, then move any remainder to the next
  // group -- this is what lets a smaller/cheaper ticker still get filled
  // when an expensive one's rounding would otherwise strand cash in a
  // group nobody else in it can use.
  const isBelowTarget = (it) => currentUsdOf(it) + deltaUsdByItem.get(it) < targetUsdOf(it) - 0.005;
  const shortfallOf = (it) => targetUsdOf(it) - (currentUsdOf(it) + deltaUsdByItem.get(it));
  const groupFilters = [
    it => it.z !== null && it.z !== undefined && it.z > 1.5,
    it => it.z === null || it.z === undefined || (it.z >= -1.5 && it.z <= 1.5),
    it => it.z !== null && it.z !== undefined && it.z < -1.5,
  ];
  groupFilters.forEach((groupFilter, groupIdx) => {
    const isGreenGroup = groupIdx === 0;
    if (pool <= 0) return;
    // Re-evaluate membership every pass -- isBelowTarget/shortfallOf both
    // depend on deltaUsdByItem, which this loop mutates.
    for (let pass = 0; pass < 50; pass++) {
      const group = usable.filter(it => groupFilter(it) && isBelowTarget(it));
      if (!group.length || pool <= 0) break;
      const totalShortfall = group.reduce((s, it) => s + shortfallOf(it), 0);
      if (totalShortfall <= 0) break;
      let placedThisPass = 0;
      let remainingPool = pool;
      group.forEach(it => {
        const share = pool >= totalShortfall ? shortfallOf(it) : shortfallOf(it) / totalShortfall * pool;
        // remainingPool (not the pre-pass `pool`) is what's actually still
        // uncommitted at this point in the loop -- overshoot spends real
        // money, so it must be checked/deducted against the running
        // balance, not the pass's starting pool (which would let several
        // green tickers in a row each independently "round up" against
        // the same unspent cash and overdraw the pool).
        const rounded = isGreenGroup
          ? roundToLotAllowOvershoot(it, share, remainingPool)
          : roundDownToLot(it, share, remainingPool);
        if (rounded > 0) {
          deltaUsdByItem.set(it, deltaUsdByItem.get(it) + rounded);
          placedThisPass += rounded;
          remainingPool -= rounded;
        }
      });
      pool -= placedThisPass;
      // Pro-rata split (above) rounds each candidate's shortfall-weighted
      // share down independently -- so it routinely leaves cash on the
      // table even when SOME candidate got a share this pass: an expensive
      // ticker's pro-rata cut can be smaller than one of its own lots
      // while a cheap ticker nearby still has room to buy more. Rather
      // than only kicking in once an entire pass places nothing (which let
      // a large basket of pricier below-target tickers get skipped for 50
      // passes straight while a couple of cheap ones nickel-and-dimed the
      // pool -- see the $734-left-unallocated case with 37 US tickers),
      // run a cheapest-first mop-up after EVERY pass: hand out one lot at
      // a time, cheapest candidate first, until nobody left in the group
      // can afford even one more share. This never exceeds a ticker's own
      // shortfall and (for gray/red) never crosses target, matching the
      // same rounding rules as the pro-rata path above -- it only spends
      // pool that pro-rata would otherwise have stranded.
      let placedFallback = 0;
      for (;;) {
        const candidates = usable
          .filter(it => groupFilter(it) && isBelowTarget(it) && it.priceUsd > 0)
          .sort((a, b) => a.priceUsd - b.priceUsd);
        let placedThisRound = 0;
        for (const it of candidates) {
          if (pool <= 0) break;
          const remaining = shortfallOf(it);
          if (remaining <= 0) continue;
          const cost = isGreenGroup
            ? roundToLotAllowOvershoot(it, Math.min(remaining, pool), pool)
            : roundDownToLot(it, Math.min(remaining, pool), pool);
          if (cost > 0) {
            deltaUsdByItem.set(it, deltaUsdByItem.get(it) + cost);
            pool -= cost;
            placedThisRound += cost;
          }
        }
        if (placedThisRound <= 0) break;
        placedFallback += placedThisRound;
      }
      // Last resort, gray (neutral) zone only: round-down-only placement
      // above found NOTHING affordable at all this iteration -- every
      // below-target candidate's own shortfall is smaller than its own
      // lot price (e.g. shortfall $113 but the share costs $164), so
      // rounding down can only ever produce 0 and the money would
      // otherwise be permanently stranded even though the pool has plenty
      // left. Per the user: only when there is truly no other choice,
      // let the single cheapest gray-zone candidate overshoot past target
      // by one lot. Red zone (Z<-1.5) never gets this -- it only ever
      // rounds down, full stop.
      let placedOvershootLastResort = 0;
      if (placedThisPass <= 0 && placedFallback <= 0 && !isGreenGroup && groupIdx === 1) {
        const cheapest = usable
          .filter(it => groupFilter(it) && isBelowTarget(it) && it.priceUsd > 0 && it.priceUsd <= pool)
          .sort((a, b) => a.priceUsd - b.priceUsd)[0];
        if (cheapest) {
          deltaUsdByItem.set(cheapest, deltaUsdByItem.get(cheapest) + cheapest.priceUsd);
          pool -= cheapest.priceUsd;
          placedOvershootLastResort = cheapest.priceUsd;
        }
      }
      // Nothing placed anywhere this iteration (neither pro-rata, the
      // mop-up, nor the last-resort overshoot could afford/place a share)
      // -- further passes would be identical, so stop looping this group
      // and carry the rest forward.
      if (placedThisPass <= 0 && placedFallback <= 0 && placedOvershootLastResort <= 0) break;
    }
  });

  return { deltaUsdByItem, newTotalUsd, leftoverPoolUsd: pool };
}

function mpDrawTargetDonut(divId, noteId, items, sharedTotalUsd, actionColLabel, opts) {
  const plotEl = document.getElementById(divId);
  const noteEl = document.getElementById(noteId);
  const titleEl = document.getElementById(noteId.replace('_note', '_title'));
  const tableEl = document.getElementById(noteId.replace('_note', '_table_wrap'));
  const investRowEl = (opts && opts.investRowId) ? document.getElementById(opts.investRowId) : null;
  if (!plotEl) return;
  const usable = items.filter(it => it.target > 0);
  if (!usable.length || !usable.some(it => it.current > 0)) {
    plotEl.style.display = 'none';
    if (noteEl) noteEl.style.display = 'none';
    if (titleEl) titleEl.style.display = 'none';
    if (investRowEl) investRowEl.style.display = 'none';
    if (tableEl) tableEl.innerHTML = '';
    return;
  }
  plotEl.style.display = '';
  if (investRowEl) investRowEl.style.display = '';
  if (noteEl) noteEl.style.display = '';
  if (titleEl) titleEl.style.display = '';

  const totalTarget = usable.reduce((s, it) => s + it.target, 0);

  // When the user has typed a nonzero "Money to allocate" amount, the
  // donut itself should reflect what the portfolio would look like AFTER
  // that allocation (New %), not the current holdings -- so moving the
  // input updates the chart, not just the table below it. Falls back to
  // Actual % (it.current) whenever there's no injection to simulate, or
  // this donut doesn't use the z-priority allocator at all (StocksBonds/
  // Deposits pass no userInjection*, so displayPctByItem stays null and
  // every it.current is used unchanged).
  let displayPctByItem = null;
  if (opts && opts.zPriorityAllocation && sharedTotalUsd) {
    const userInjectionUsd = opts.userInjectionUsd !== undefined
      ? (opts.userInjectionUsd || 0)
      : (DATA && DATA.currentUsdRub ? (opts.userInjectionRub || 0) / DATA.currentUsdRub : 0);
    if (userInjectionUsd > 0) {
      const respectLotSize = opts.respectLotSize !== false;
      const allocateFn = respectLotSize ? mpAllocatePoolByZPriorityWithLots : mpAllocatePoolByZPriorityLegacy;
      const { deltaUsdByItem } = allocateFn(usable, sharedTotalUsd, userInjectionUsd);
      const newUsdByItem = usable.map(it => (it.current / 100 * sharedTotalUsd) + (deltaUsdByItem.get(it) || 0));
      const allocatedNewUsd = newUsdByItem.reduce((s, v) => s + v, 0);
      if (allocatedNewUsd > 0) {
        displayPctByItem = new Map(usable.map((it, i) => [it, newUsdByItem[i] / allocatedNewUsd * 100]));
      }
    }
  }
  const pctOf = (it) => (displayPctByItem ? displayPctByItem.get(it) : it.current);

  // Sector angular WIDTH = actual (or, with a pending allocation, New)
  // share, so the donut visually tiles up to 100% of what it's showing;
  // RADIAL extent still = that same share vs target -- bulging past the
  // dotted reference circle = overweight vs target, falling short =
  // underweight, regardless of how wide the wedge itself is drawn.
  const totalCurrent = usable.reduce((s, it) => s + pctOf(it), 0);
  let cursor = 0;
  const theta = [];
  const width = [];
  usable.forEach(it => {
    const w = totalCurrent > 0 ? (pctOf(it) / totalCurrent * 360) : (360 / usable.length);
    theta.push(cursor + w / 2);
    width.push(w);
    cursor += w;
  });

  // Radial extent is additive, not multiplicative: an equal-sized gap in
  // percentage points (current% - target%) bulges/dips by the same visual
  // amount regardless of how big the category's own target share is --
  // e.g. RUB at -11.89pp and CNY at +11.89pp end up as mirror-image
  // radii, rather than one dwarfing the other just because its target%
  // happens to be a smaller denominator.
  const R_BASE = 100;
  const PP_SCALE = 2; // radius units per percentage-point of (current - target)
  const radial = usable.map(it => {
    const targetPct = totalTarget > 0 ? (it.target / totalTarget * 100) : 0;
    return Math.max(0, R_BASE + (pctOf(it) - targetPct) * PP_SCALE);
  });
  const maxR = Math.max(R_BASE, ...radial);

  if (tableEl && opts && opts.zPriorityAllocation) {
    const usdRubRate = DATA && DATA.currentUsdRub;
    const totalUsd = sharedTotalUsd;
    // Display everything in USD for tables that opt in (e.g. US stocks --
    // no reason to route through a RUB conversion for a US-dollar book),
    // RUB otherwise (e.g. Russian stocks).
    const displayCcy = opts.displayCurrency === 'USD' ? 'USD' : 'RUB';
    const fmtMoney = (usdAmount) => {
      if (displayCcy === 'USD') return `$${usdAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
      if (!usdRubRate) return 'n/a';
      return `₽${(usdAmount * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    };
    const moneyColLabel = `(${displayCcy})`;
    const canDisplayMoney = displayCcy === 'USD' || !!usdRubRate;
    // Accept the injection directly in USD (opts.userInjectionUsd, e.g. for
    // the US stocks table) or convert from RUB (opts.userInjectionRub, e.g.
    // for the Russian stocks table) -- whichever the caller provides.
    const userInjectionUsd = opts.userInjectionUsd !== undefined
      ? (opts.userInjectionUsd || 0)
      : (usdRubRate ? (opts.userInjectionRub || 0) / usdRubRate : 0);
    // opts.respectLotSize (toggled by a checkbox next to the invest-amount
    // input) switches the whole table between two genuinely separate
    // functions -- the original fractional-dollar allocator (untouched)
    // and the whole-share-aware one -- not a flag inside shared code, so
    // the "old" path can never be silently affected by new-path changes.
    const respectLotSize = opts.respectLotSize !== false;
    const allocateFn = respectLotSize ? mpAllocatePoolByZPriorityWithLots : mpAllocatePoolByZPriorityLegacy;
    const { deltaUsdByItem, newTotalUsd, leftoverPoolUsd } = totalUsd
      ? allocateFn(usable, totalUsd, userInjectionUsd)
      : { deltaUsdByItem: new Map(), newTotalUsd: null, leftoverPoolUsd: 0 };
    let totalCurrentUsd = 0;
    let totalNewUsdAgg = 0;
    const rowData = usable.map(it => {
      const currentUsd = totalUsd ? it.current / 100 * totalUsd : null;
      const deltaUsd = deltaUsdByItem.get(it) || 0;
      const newUsd = currentUsd !== null ? currentUsd + deltaUsd : null;
      return { it, currentUsd, deltaUsd, newUsd };
    });
    // New % is each row's share of the allocated stock total (the New
    // column), not of original+injection which still includes any
    // leftover cash that never made it into a ticker.
    const allocatedNewUsd = rowData.reduce((s, r) => s + (r.newUsd || 0), 0);
    const rowsHtml = rowData.map(({ it, currentUsd, deltaUsd, newUsd }) => {
      const currentStr = (canDisplayMoney && currentUsd !== null) ? fmtMoney(currentUsd) : 'n/a';
      const priceStr = (canDisplayMoney && it.priceUsd) ? fmtMoney(it.priceUsd) : 'n/a';
      let actionStr = '—';
      // Show as "Buy N × price" whenever a per-share price is known (the
      // actual number of whole shares traded), falling back to a plain
      // dollar amount only for tickers with no known priceUsd.
      if (deltaUsd > 0.5) {
        const sharesBought = it.priceUsd ? Math.round(deltaUsd / it.priceUsd) : null;
        actionStr = sharesBought
          ? `Buy ${sharesBought} × ${fmtMoney(it.priceUsd)}`
          : `Buy ${fmtMoney(deltaUsd)}`;
      } else if (deltaUsd < -0.5) {
        const sharesSold = it.priceUsd ? Math.round(Math.abs(deltaUsd) / it.priceUsd) : null;
        actionStr = sharesSold
          ? `Sell ${sharesSold} × ${fmtMoney(it.priceUsd)}`
          : `Sell ${fmtMoney(Math.abs(deltaUsd))}`;
      }
      // Color reflects the Z-score signal (same thresholds as the Yield
      // per Stock & Rebalancing table's own Z-score column above), not
      // whether this row happens to be a buy/hold/sell action.
      const actionCls = it.z === null || it.z === undefined ? 'muted' : (it.z > 1.5 ? 'pos' : (it.z < -1.5 ? 'neg' : 'muted'));
      const targetPct = totalTarget > 0 ? (it.target / totalTarget * 100) : 0;
      let newPctStr = 'n/a';
      let newStr = 'n/a';
      if (newUsd !== null && allocatedNewUsd) {
        newPctStr = `${(newUsd / allocatedNewUsd * 100).toFixed(2)}%`;
        if (canDisplayMoney) {
          newStr = fmtMoney(newUsd);
          totalCurrentUsd += currentUsd;
          totalNewUsdAgg += newUsd;
        }
      }
      return `<tr>
        <td class="ticker"${/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(it.label) ? ` data-chart="${mpEscapeHtml(it.label)}"` : ''} style="color:${it.color}">${mpEscapeHtml(it.label)}</td>
        <td>${currentStr}</td>
        <td>${priceStr}</td>
        <td>${it.current.toFixed(2)}%</td>
        <td>${targetPct.toFixed(2)}%</td>
        <td class="${actionCls}">${actionStr}</td>
        <td>${newStr}</td>
        <td>${newPctStr}</td>
      </tr>`;
    }).join('');
    const totalRow = `<tr class="total-row">
      <td><b>Total</b></td>
      <td><b>${canDisplayMoney ? fmtMoney(totalCurrentUsd) : 'n/a'}</b></td>
      <td></td>
      <td><b>100.00%</b></td>
      <td><b>100.00%</b></td>
      <td><b>${canDisplayMoney ? fmtMoney(totalNewUsdAgg - totalCurrentUsd) : ''}</b></td>
      <td><b>${canDisplayMoney ? fmtMoney(totalNewUsdAgg) : 'n/a'}</b></td>
      <td><b>100.00%</b></td>
    </tr>`;
    tableEl.innerHTML = `<table class="data-table"><thead><tr>
      <th>Label</th><th>Current ${moneyColLabel}</th><th>Price / share</th><th>Actual %</th><th>Target %</th><th>Buy / Sell</th><th>New ${moneyColLabel}</th><th>New %</th>
    </tr></thead><tbody>${rowsHtml}${totalRow}</tbody></table>` +
    // Threshold is in the DISPLAY currency, not USD -- leftoverPoolUsd is
    // always in USD internally, but at RUB scale (~84 RUB/USD) a leftover
    // of e.g. 22 RUB (~$0.26) previously fell under a flat "> 0.5" (USD)
    // check and silently vanished, while a 50 RUB leftover (~$0.59) did
    // show. Compare the actual displayed amount instead, so the message
    // appears whenever there's at least ~0.5 of whichever currency is
    // shown.
    ((displayCcy === 'USD' ? leftoverPoolUsd : leftoverPoolUsd * (usdRubRate || 0)) > 0.5 && canDisplayMoney
      ? `<p class="empty-note">${fmtMoney(leftoverPoolUsd)} left unallocated -- every ticker below target has already been filled to it.</p>`
      : '');
  } else if (tableEl) {
    const usdRubRate = DATA && DATA.currentUsdRub;
    tableEl.innerHTML = `<table class="data-table"><thead><tr>
      <th>Label</th><th>Current (RUB)</th><th>Actual %</th><th>Target %</th>
      <th>${mpEscapeHtml(actionColLabel || 'Buy / Sell (RUB)')}</th>
      <th>Target (RUB)</th>
      <th>Add externally (USD)</th><th>Resulting total (RUB)</th>
    </tr></thead><tbody>${usable.map(it => {
      const targetPct = totalTarget > 0 ? (it.target / totalTarget * 100) : 0;
      const totalUsd = it.totalUsd !== undefined ? it.totalUsd : sharedTotalUsd;
      const diffPct = targetPct - it.current;
      let actionCls = 'muted';
      let rubStr = 'n/a';
      let currentRubStr = 'n/a';
      let targetRubStr = 'n/a';
      let addExternalStr = 'n/a';
      let resultingStr = 'n/a';
      if (totalUsd) {
        const currentUsd = it.current / 100 * totalUsd;
        const targetUsd = targetPct / 100 * totalUsd;
        const otherUsd = totalUsd - currentUsd; // every other category, held fixed
        if (usdRubRate) {
          currentRubStr = `₽${(currentUsd * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
          targetRubStr = `₽${(targetUsd * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        }
        const deltaUsd = diffPct / 100 * totalUsd;
        const verb = deltaUsd >= 0 ? 'Buy' : 'Sell';
        actionCls = deltaUsd > 0.5 ? 'pos' : (deltaUsd < -0.5 ? 'neg' : 'muted');
        if (usdRubRate) {
          rubStr = `${verb} ₽${Math.abs(deltaUsd * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        }
        // Fresh money added ONLY to this category (everything else held
        // fixed) so its share reaches targetPct:
        // (current + X) / (total + X) = targetPct/100
        // => X = (targetPct*other - (100-targetPct)*current) / (100-targetPct)
        if (targetPct < 100) {
          const addUsd = (targetPct * otherUsd - (100 - targetPct) * currentUsd) / (100 - targetPct);
          if (addUsd > 0.5) {
            addExternalStr = `+$${addUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            if (usdRubRate) {
              addExternalStr += ` (₽${(addUsd * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })})`;
              resultingStr = `₽${((currentUsd + addUsd) * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            }
          } else {
            // This category is already at/above target -- there's no "add
            // money here" fix (that would only widen the gap), so nothing
            // changes: resulting total = current total.
            addExternalStr = '—';
            if (usdRubRate) {
              resultingStr = `₽${(currentUsd * usdRubRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
            }
          }
        }
      }
      return `<tr>
        <td class="ticker"${/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(it.label) ? ` data-chart="${mpEscapeHtml(it.label)}"` : ''} style="color:${it.color}">${mpEscapeHtml(it.label)}</td>
        <td>${currentRubStr}</td>
        <td>${it.current.toFixed(2)}%</td>
        <td>${targetPct.toFixed(2)}%</td>
        <td class="${actionCls}">${rubStr}</td>
        <td>${targetRubStr}</td>
        <td class="pos">${addExternalStr}</td>
        <td>${resultingStr}</td>
      </tr>`;
    }).join('')}</tbody></table>`;
  }

  const traces = [
    {
      type: 'barpolar',
      r: radial, theta, width,
      name: 'Your portfolio (relative to target)',
      customdata: usable.map(it => (/^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(it.label) ? it.label : null)),
      marker: {
        color: usable.map(it => it.color),
        opacity: 0.85,
        line: { color: '#0d1117', width: 1 },
      },
      hovertemplate: usable.map((it, i) => {
        const pct = totalTarget > 0 ? (it.target / totalTarget * 100) : 0;
        return `${it.label}<br>Actual: <b>${it.current.toFixed(2)}%</b> (sector angle)<br>` +
               `Target: <b>${pct.toFixed(2)}%</b><extra></extra>`;
      }),
    },
    {
      type: 'scatterpolar', mode: 'lines',
      r: Array.from({ length: 73 }, () => R_BASE),
      theta: Array.from({ length: 73 }, (_, i) => i * 5),
      line: { color: '#e6edf3', width: 1.5, dash: 'dot' },
      name: 'Target (common reference circle)',
      hoverinfo: 'skip',
    },
    {
      type: 'scatterpolar', mode: 'text',
      r: usable.map(() => maxR * 1.14),
      theta,
      text: usable.map(it => it.label),
      textfont: { color: usable.map(it => it.color), size: 10 },
      showlegend: false,
      hoverinfo: 'skip',
    },
  ];
  Plotly.newPlot(divId, traces, mpDonutLayout(maxR), { displayModeBar: false, responsive: true });
  mpChartOnClick(divId);
}

async function mpRenderPortfolioPies() {
  if (!DATA) return;
  const { data, error } = await sb.from('portfolio_value_usd').select('*');
  if (error || !data) return;
  const priced = data.filter(r => r.value_usd !== null);
  const valueByTicker = {};
  const priceUsdByTicker = {};
  priced.forEach(r => {
    valueByTicker[r.ticker] = (valueByTicker[r.ticker] || 0) + r.value_usd;
    if (r.price_usd) priceUsdByTicker[r.ticker] = r.price_usd;
  });
  // portfolio_value_usd only has rows for tickers the user actually holds
  // (it's a left join FROM current_holdings) -- a target-list ticker with
  // zero shares never gets a row there, so its price would otherwise show
  // as n/a and the lot-aware allocator couldn't buy it from zero. Fetch
  // market_prices directly (world-readable, no RLS restriction) for the
  // rest of the target universe to fill those in.
  const targetUniverseTickers = [...RU_STOCK_TICKERS, ...US_STOCK_TICKERS];
  const missingPriceTickers = targetUniverseTickers.filter(t => !(t in priceUsdByTicker));
  if (missingPriceTickers.length) {
    const { data: extraPrices } = await sb.from('market_prices')
      .select('ticker, price_usd').in('ticker', missingPriceTickers);
    (extraPrices || []).forEach(r => {
      if (r.price_usd) priceUsdByTicker[r.ticker] = r.price_usd;
    });
  }

  // 1. US stocks: sector width = each stock's actual (current) weight (see
  //    mpDrawTargetDonut); radial extent = current/target, where target is
  //    the Z-score-adjusted weight -- same "Target" column shown in the US
  //    Stocks Z-score tab's own target-weights table above this chart, not
  //    the pre-Z-score base/strategic weight.
  const usTotal = US_STOCK_TICKERS.reduce((s, t) => s + (valueByTicker[t] || 0), 0);
  const usInvestInputEl = document.getElementById('mp_us_stocks_invest_amount');
  const usUserInjectionUsd = usInvestInputEl ? (parseFloat(usInvestInputEl.value) || 0) : 0;
  const usRespectLotsEl = document.getElementById('mp_us_stocks_respect_lots');
  const usRespectLotSize = usRespectLotsEl ? usRespectLotsEl.checked : true;
  mpDrawTargetDonut('plot_mp_pie_us_stocks', 'mp_pie_us_stocks_note',
    (DATA.usTargetWeightsRaw || []).map((r, i) => ({
      label: r.ticker, target: r.target, current: (valueByTicker[r.ticker] || 0) / (usTotal || 1) * 100,
      color: (DATA.usTickerColors || [])[i % (DATA.usTickerColors || [1]).length],
      z: r.z,
      priceUsd: priceUsdByTicker[r.ticker] || null,
    })), usTotal, null, {
      zPriorityAllocation: true, userInjectionUsd: usUserInjectionUsd,
      investRowId: 'mp_us_stocks_invest_row', displayCurrency: 'USD',
      respectLotSize: usRespectLotSize,
    });

  // 2. Russian stocks: same idea, using the target list (equities + TRND/AKME/AKFN) and its
  //    own Z-score-adjusted Target column.
  const ruStockTotal = RU_STOCK_TICKERS.reduce((s, t) => s + (valueByTicker[t] || 0), 0);
  const ruInvestInputEl = document.getElementById('mp_ru_stocks_invest_amount');
  const ruUserInjectionRub = ruInvestInputEl ? (parseFloat(ruInvestInputEl.value) || 0) : 0;
  const ruRespectLotsEl = document.getElementById('mp_ru_stocks_respect_lots');
  const ruRespectLotSize = ruRespectLotsEl ? ruRespectLotsEl.checked : true;
  mpDrawTargetDonut('plot_mp_pie_ru_stocks', 'mp_pie_ru_stocks_note',
    (DATA.ruTargetWeightsRaw || []).map(r => ({
      label: r.ticker, target: r.target, current: (valueByTicker[r.ticker] || 0) / (ruStockTotal || 1) * 100,
      color: (DATA.ruTickerColors || {})[r.ticker] || '#8b949e',
      z: r.z,
      priceUsd: priceUsdByTicker[r.ticker] || null,
    })), ruStockTotal, null, {
      zPriorityAllocation: true, userInjectionRub: ruUserInjectionRub,
      investRowId: 'mp_ru_stocks_invest_row', respectLotSize: ruRespectLotSize,
    });

  // 3. Russian stocks vs Russian bonds: target from the ERP & Stocks/Bonds
  //    Allocation tab's own base/target allocation. "Stocks" is the same
  //    target-list as chart 2 (ruStockTotal) -- NOT every MOEX
  //    share/ETF held. "Bonds" = anything classified as instrument_type
  //    'bond' on Russian infrastructure -- plain bonds/OFZ, bond/money-
  //    market ETFs (TBRU/SAFE/SBMM/AKMB/AKMM/TLCB/SBBY), and RUB deposits
  //    -- see instrument_type assignment in update-market-prices/index.ts.
  // Credit cards of Russian banks are netted against Russian liquid assets
  // (same rule as the Charts tab -- mpNetCreditIntoLiquid).
  const ruCredit = (await mpFetchCashRows(await mpFetchFxByCurrency(['USD', 'RUB', 'CNY'])))
    .filter(r => r.instrument_type === 'credit' && MP_RU_ACCOUNTS.has(r.account) && r.value_usd !== null)
    .reduce((s, r) => s + r.value_usd, 0);
  const ruLiquid = priced.filter(r => r.infra_region === 'ru' && r.instrument_type === 'liquid' && r.value_usd > 0)
    .reduce((s, r) => s + r.value_usd, 0);
  const ruLiquidFactor = ruLiquid > 0 ? Math.max(0, (ruLiquid + ruCredit) / ruLiquid) : 1;
  const ruValue = r => (r.instrument_type === 'liquid' && r.value_usd > 0 ? r.value_usd * ruLiquidFactor : r.value_usd);
  const ruBondsCurrent = priced
    .filter(r => r.infra_region === 'ru' && ['bond', 'deposit', 'liquid'].includes(r.instrument_type))
    .reduce((s, r) => s + ruValue(r), 0);
  const allocRaw = DATA.ruAllocTargetRaw;
  if (allocRaw) {
    const stocksBondsTotal = ruStockTotal + ruBondsCurrent;
    mpDrawTargetDonut('plot_mp_pie_stocksbonds', 'mp_pie_stocksbonds_note', [
      { label: 'Stocks', target: allocRaw.target.Stocks, current: stocksBondsTotal ? ruStockTotal / stocksBondsTotal * 100 : 0, color: '#4da8c8' },
      { label: 'Bonds', target: allocRaw.target.Bonds, current: stocksBondsTotal ? ruBondsCurrent / stocksBondsTotal * 100 : 0, color: '#f0b429' },
    ], stocksBondsTotal);
  }

  // 4. RUB vs non-RUB bonds/deposits: target from the current w_CNY sigmoid
  //    value (the same figure driving the USD/RUB → CNY Weight chart above).
  // Uses `underlying_currency` (what the asset's holdings are actually
  // denominated in), not `currency` (the exchange's quote currency) --
  // e.g. SBBY/TLCB are quoted in RUB on MOEX but hold CNY bonds, so
  // underlying_currency='CNY' for them even though currency='RUB'. See
  // UNDERLYING_CURRENCY_BY_TICKER in update-market-prices/index.ts.
  // infra_region === 'ru' restricts this to Russian-infrastructure bonds/
  // deposits only (same scope as chart 3 above) -- without it, foreign
  // instrument_type='bond' rows (Revolut money-market funds, Revolut
  // deposits) would inflate "non-RUB" with holdings this chart was never
  // meant to cover.
  const bondDepositRows = priced.filter(r => ['bond', 'deposit', 'liquid'].includes(r.instrument_type) && r.infra_region === 'ru');
  const rubCurrent = bondDepositRows.filter(r => r.underlying_currency === 'RUB').reduce((s, r) => s + ruValue(r), 0);
  const nonRubCurrent = bondDepositRows.filter(r => r.underlying_currency !== 'RUB').reduce((s, r) => s + ruValue(r), 0);
  if (DATA.currentWCny !== undefined && DATA.currentWCny !== null) {
    const bdTotal = rubCurrent + nonRubCurrent;
    // with the buy / sell lines: the yuan as held while the dollar's between them
    const targetNonRubPct = bdTotal ? wCnyTarget(DATA.currentWCny, nonRubCurrent, bdTotal) / bdTotal * 100 : DATA.currentWCny * 100;
    const targetRubPct = 100 - targetNonRubPct;
    mpDrawTargetDonut('plot_mp_pie_deposits', 'mp_pie_deposits_note', [
      { label: 'RUB', target: targetRubPct, current: bdTotal ? rubCurrent / bdTotal * 100 : 0, color: '#4da8c8' },
      { label: 'Non-RUB (CNY/other)', target: targetNonRubPct, current: bdTotal ? nonRubCurrent / bdTotal * 100 : 0, color: '#e05252' },
    ], bdTotal, 'Target CNY sale (RUB)');
  }
}

