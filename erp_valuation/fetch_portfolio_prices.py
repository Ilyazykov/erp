"""
Daily fetcher for the `market_prices` Supabase table -- current, USD-
converted prices for every ticker that can appear in ANY user's imported
broker trades (see supabase/functions/import-trades-csv/index.ts and the
`current_holdings` view in supabase/migrations/20250101000003_holdings_view.sql).

This is the only piece of the "portfolio value in USD" feature that talks
to the network or does any pricing logic -- the frontend (index.html) only
ever reads the finished `portfolio_value_usd` view via supabase-js. See
supabase/migrations/20250101000004_market_prices.sql for that table/view.

Ticker universe
----------------
Rather than hardcode the ticker list, this script first asks Supabase for
the DISTINCT tickers actually present across all users' `trades` (via a
service-role request, which bypasses RLS -- this is the one place in the
repo that is allowed to see cross-user data, and it only ever reads the
`ticker` column, never quantities/prices/user_id). That makes the script
self-updating: any ticker in any future CSV import gets picked up
automatically, with no code change.

If that query fails or comes back empty (e.g. secrets not configured yet,
or running this script locally without credentials), it falls back to
SEED_TICKERS below -- the tickers observed in a real sample export, kept
here only as a reasonable bootstrap/offline-dev set, not as the supported
universe.

Asset classes
-------------
Each ticker is classified into one of:
  - moex: Russian shares, MOEX-listed ETFs/BPIFs, corporate bonds (ISIN
    prefix RU000A...) and OFZ government bonds (ISIN prefix SU...).
    Priced via the MOEX ISS API (iss.moex.com, free, no auth).
  - crypto: BTC, ETH, XAU, XAUT, or any other symbol that isn't
    conclusively MOEX and resolves against Yahoo's <TICKER>-USD symbol.
  - western_etf: UCITS ETFs (VUAA, VWCE, VWRA, CSPX, XSX6, ...) that don't
    resolve on the plain Yahoo US endpoint -- resolved best-effort by
    trying a handful of common exchange suffixes.
  - us_stock: anything else, fetched from the plain Yahoo Finance chart
    endpoint (same endpoint/style as erp_valuation/us_zscore.py).

Any ticker that fails to resolve anywhere is simply skipped (with a
logged reason) -- it will show up in `current_holdings` with a quantity
but no matching row in `market_prices`, and `portfolio_value_usd` already
handles that gracefully (null price/value via a left join).

Currency conversion
--------------------
MOEX prices in RUB are converted to USD using the latest rate in
data/usd_rub_history.csv (the same CSV usd_rub_tracker/scripts/
update_usd_rub.py maintains -- reused as-is here, not re-fetched). Any
other native currency (EUR for most Western ETFs, but also e.g. CNY for
some MOEX-listed corporate bonds) is converted generically via Yahoo's
<CCY>USD=X pair, fetched on demand and cached per run.

Output
------
Upserts (on `ticker`) into the Supabase `market_prices` table via the
PostgREST REST API, authenticated with the service_role key (the anon key
cannot write to this table -- see the migration's RLS policy). Needs:

    SUPABASE_URL                 e.g. https://xxxx.supabase.co
      (or SUPABASE_PROJECT_REF, from which the URL is derived, matching
      the secret already used by .github/workflows/supabase_deploy.yml)
    SUPABASE_SERVICE_ROLE_KEY    Dashboard -> Project Settings -> API
                                  -> "service_role" secret key

Run:
    python erp_valuation/fetch_portfolio_prices.py
"""
from __future__ import annotations

import csv
import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import requests

REPO_ROOT = Path(__file__).resolve().parent.parent
USD_RUB_CSV = REPO_ROOT / "data" / "usd_rub_history.csv"

MOEX_ISS_BASE = "https://iss.moex.com/iss"
YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart"

REQUEST_TIMEOUT = 20
HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}

# Bootstrap/offline-dev ticker set only -- used solely as a fallback when the
# Supabase distinct-ticker query is unavailable. NOT the supported universe;
# see module docstring.
SEED_TICKERS = [
    "AKFN", "AKMB", "AKME", "AKMM", "AMNY", "CSPX", "DOMRF", "GMKN", "GOOGL",
    "IRAO", "META", "MSFT", "MU", "NVDA", "OZON", "PLZL", "ROSN",
    "RU000A1008Y3", "RU000A103661", "RU000A1043K9", "RU000A105104",
    "RU000A1057D4", "RU000A105L27", "RU000A1069P3", "RU000A10AAQ4",
    "RU000A10ANZ8", "RU000A10AZ45", "RU000A10C5L7", "RU000A10CKZ0",
    "RU000A10CMT9", "RU000A10D2Y6", "RU000A10D3S6", "RU000A10D616",
    "RU000A10DD30", "RU000A10DDR0", "RU000A10DT08", "RU000A10E6D0",
    "RU000A10EA08", "RU000A10EF52", "RU000A10EMU3", "RU000A10EYG7",
    "RU000A10EYY0", "RU000A10F7L0", "RU000A10F827", "SAFE", "SBBY", "SBER",
    "SBMM", "SNAP", "SPCX", "SU26212RMFS9", "SU26237RMFS6", "SU26244RMFS2",
    "SU26246RMFS7", "SU26247RMFS5", "SU26248RMFS3", "SU26251RMFS7",
    "SU29007RMFS0", "SU29008RMFS8", "SU29015RMFS3", "SU29020RMFS3",
    "SU29021RMFS1", "T", "TBRU", "TLCB", "TRND", "TSEM", "VTBR", "VUAA",
    "VWCE", "VWRA", "WMT", "XSX6", "YDEX",
    "BTC", "ETH", "XAU", "XAUT",
]

# ISIN prefixes that identify MOEX-traded debt instruments generically.
MOEX_OFZ_ISIN_PREFIX = "SU"          # OFZ government bonds, e.g. SU26212RMFS9
MOEX_CORP_BOND_ISIN_PREFIX = "RU000A"  # corporate bonds, e.g. RU000A10AAQ4

# Yahoo suffixes tried, in order, for Western-exchange ETFs that don't
# resolve on the plain (US) Yahoo symbol. Best-effort: whichever responds
# first with a real price wins. See module docstring.
WESTERN_ETF_SUFFIXES = [".L", ".DE", ".AS", ".SW", ".MI", ".PA"]

# Yahoo symbol overrides for crypto/metal tickers that don't follow the
# plain <TICKER>-USD convention.
CRYPTO_YAHOO_OVERRIDES = {
    "XAU": "GC=F",   # gold spot has no clean Yahoo FX symbol; COMEX gold
                      # futures (USD/troy oz) is the closest reliable proxy
}
KNOWN_CRYPTO_TICKERS = {"BTC", "ETH", "XAU", "XAUT", "SOL", "USDT", "USDC", "BNB", "XRP", "DOGE", "ADA", "TON"}


def log(msg: str) -> None:
    print(msg, flush=True)


def fetch_url(url: str, retries: int = 2) -> str | None:
    last_err = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, headers=HTTP_HEADERS)
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as r:
                return r.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            time.sleep(0.5)
    log(f"  fetch failed for {url}: {last_err}")
    return None


def fetch_json(url: str) -> dict | None:
    text = fetch_url(url)
    if text is None:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        log(f"  bad JSON from {url}: {e}")
        return None


# ---------------------------------------------------------------------------
# USD/RUB conversion (reuses usd_rub_tracker's existing data source/CSV)
# ---------------------------------------------------------------------------

def latest_usd_rub_rate() -> float | None:
    if not USD_RUB_CSV.exists():
        return None
    with USD_RUB_CSV.open("r", newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return None
    return float(rows[-1]["rate"])


# ---------------------------------------------------------------------------
# Supabase REST helpers
# ---------------------------------------------------------------------------

def supabase_config() -> tuple[str, str] | None:
    url = os.environ.get("SUPABASE_URL")
    if not url:
        ref = os.environ.get("SUPABASE_PROJECT_REF")
        if ref:
            url = f"https://{ref}.supabase.co"
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        return None
    return url.rstrip("/"), key


def fetch_distinct_tickers(base_url: str, service_key: str) -> list[str] | None:
    """
    Distinct tickers across ALL users' trades, via a service-role request
    (bypasses RLS). Only ever reads the `ticker` column -- no quantities,
    prices, or user_id leave this function. Returns None on any failure
    (caller falls back to SEED_TICKERS), or a possibly-empty list.
    """
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
    }
    try:
        resp = requests.get(
            f"{base_url}/rest/v1/trades",
            headers=headers,
            params={"select": "ticker"},
            timeout=REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
    except (requests.RequestException, ValueError) as e:
        log(f"  distinct-ticker query failed, will fall back to seed list: {e}")
        return None
    tickers = sorted({r["ticker"].strip() for r in rows if r.get("ticker")})
    return tickers


def upsert_market_prices(base_url: str, service_key: str, rows: list[dict]) -> None:
    if not rows:
        log("No priced rows to upsert.")
        return
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates",
    }
    # updated_at defaults to now() only on INSERT -- a merge-duplicates
    # upsert against an existing row is an UPDATE under the hood, which
    # does NOT re-run the column default, so it must be set explicitly
    # here on every row for updated_at to actually reflect "when this
    # price was last refreshed".
    now_iso = datetime.now(timezone.utc).isoformat()
    for row in rows:
        row["updated_at"] = now_iso
    batch_size = 200
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i + batch_size]
        resp = requests.post(
            f"{base_url}/rest/v1/market_prices",
            headers=headers,
            params={"on_conflict": "ticker"},
            data=json.dumps(batch),
            timeout=REQUEST_TIMEOUT,
        )
        if not resp.ok:
            log(f"  upsert failed for batch {i}-{i + len(batch)}: {resp.status_code} {resp.text[:300]}")
        else:
            log(f"  upserted {len(batch)} rows ({i + len(batch)}/{len(rows)})")


# ---------------------------------------------------------------------------
# Ticker classification
# ---------------------------------------------------------------------------

def classify_ticker(ticker: str) -> str:
    """Returns one of 'moex_ofz', 'moex_bond', 'moex_share_or_etf', 'crypto', 'us_or_western'."""
    t = ticker.upper()
    if t in KNOWN_CRYPTO_TICKERS:
        return "crypto"
    if t.startswith(MOEX_CORP_BOND_ISIN_PREFIX):
        return "moex_bond"
    if t.startswith(MOEX_OFZ_ISIN_PREFIX) and len(t) >= 10 and any(c.isdigit() for c in t):
        return "moex_ofz"
    # Everything else: try MOEX shares/ETFs first (cheap, single request per
    # batch), fall back to US/crypto/Western-ETF resolution via Yahoo.
    return "moex_share_or_etf_or_other"


# ---------------------------------------------------------------------------
# MOEX ISS fetching
# ---------------------------------------------------------------------------

def moex_fetch_shares_batch(tickers: list[str]) -> dict[str, dict]:
    """
    Batched lookup against engines/stock/markets/shares/boards/TQBR/securities.json
    (covers ordinary shares AND MOEX-listed ETFs/BPIFs, which also trade on
    TQBR -- confirmed via ISS securities search, e.g. AKFN/AKMB/TRND).
    Returns {ticker: {price_rub, currency, as_of}} for tickers actually found.
    """
    if not tickers:
        return {}
    out: dict[str, dict] = {}
    joined = ",".join(tickers)
    url = (
        f"{MOEX_ISS_BASE}/engines/stock/markets/shares/boards/TQBR/securities.json"
        f"?securities={joined}&iss.meta=off&iss.only=securities,marketdata"
    )
    data = fetch_json(url)
    if not data:
        return out

    sec_cols = data.get("securities", {}).get("columns", [])
    sec_rows = data.get("securities", {}).get("data", [])
    secs = {row[sec_cols.index("SECID")]: dict(zip(sec_cols, row)) for row in sec_rows}

    md_cols = data.get("marketdata", {}).get("columns", [])
    md_rows = data.get("marketdata", {}).get("data", [])
    mds = {row[md_cols.index("SECID")]: dict(zip(md_cols, row)) for row in md_rows}

    for secid, sec in secs.items():
        md = mds.get(secid, {})
        price = md.get("LAST") or sec.get("PREVLEGALCLOSEPRICE") or sec.get("PREVPRICE")
        if price is None:
            continue
        out[secid] = {
            "price_rub": float(price),
            "currency": sec.get("CURRENCYID") or "RUB",
            "as_of": sec.get("PREVDATE"),
        }
    return out


# Only these ISS "group" values represent an instrument actually traded on
# a real cash equities/bonds market (as opposed to an index/iNAV
# calculation, an OTC/repo quote board, an FX cross, a derivative, etc.).
# The free-text `q=` search matches loosely (e.g. searching "GOOGL" also
# turns up an unrelated OTC quote board entry, "MU" turns up an RTSI index
# basket) -- restricting to these groups plus an exact SECID match is what
# keeps that noise from being mistaken for a real MOEX-traded instrument.
MOEX_TRADEABLE_GROUPS = {"stock_shares", "stock_ppif", "stock_bonds"}


def moex_resolve_via_search(ticker: str) -> dict | None:
    """
    Generic fallback: /iss/securities.json?q=TICKER tells us which
    engine/market/board this instrument actually trades on (SECID may
    differ from the query, e.g. bonds are keyed by ISIN). Used for tickers
    not found on TQBR shares (e.g. bonds, or shares on a non-TQBR board).

    Deliberately strict: requires an exact (case-insensitive) SECID match
    AND a real tradeable group, and is_traded doesn't have to be 1 here
    (a matured/delisted bond is still is_traded=0 but has a valid history
    fallback in moex_fetch_bond) -- but a loose/fuzzy match on an
    index/OTC/repo board is rejected outright rather than risking a wrong
    price for an unrelated instrument (e.g. US tickers like GOOGL/MSFT/
    NVDA/MU/META/SNAP superficially "match" unrelated MOEX OTC quote
    boards or index baskets and must NOT be treated as MOEX securities).
    """
    data = fetch_json(f"{MOEX_ISS_BASE}/securities.json?q={ticker}&iss.meta=off")
    if not data:
        return None
    cols = data.get("securities", {}).get("columns", [])
    rows = data.get("securities", {}).get("data", [])
    candidates = [dict(zip(cols, row)) for row in rows]
    exact = [
        c for c in candidates
        if c.get("secid", "").upper() == ticker.upper()
        and c.get("group") in MOEX_TRADEABLE_GROUPS
        and c.get("primary_boardid")
    ]
    return exact[0] if exact else None


def moex_list_traded_boards(secid: str) -> list[str]:
    """
    /iss/securities/{secid}.json lists EVERY board a security has ever been
    listed on, across every market (shares, repo, ndm, ...) -- most are
    irrelevant. This narrows that down to boards worth trying for a price:
    still-tradeable (is_traded=1), on the actual "shares" market (which is
    where ETFs/BPIFs/stocks quote, not repo/ccp/ndm), ordered so the
    primary board is tried first and the rest follow. Needed because
    `primary_boardid` from the search endpoint is sometimes stale/wrong for
    an instrument that has since moved its main liquidity to a different
    board (e.g. a CNY-denominated BPIF whose real board is TQTY, not TQBR).
    """
    data = fetch_json(f"{MOEX_ISS_BASE}/securities/{secid}.json?iss.meta=off&iss.only=boards")
    if not data:
        return []
    cols = data.get("boards", {}).get("columns", [])
    rows = data.get("boards", {}).get("data", [])
    boards = [dict(zip(cols, row)) for row in rows]
    tradeable = [
        b for b in boards
        if b.get("is_traded") == 1 and b.get("market") == "shares"
    ]
    tradeable.sort(key=lambda b: 0 if b.get("is_primary") == 1 else 1)
    return [b["boardid"] for b in tradeable]


def moex_fetch_bond(ticker: str, secid: str, board: str, group: str) -> dict | None:
    """
    Bonds are quoted as a % of face value, not an absolute price, so the
    actual RUB value per unit is FACEVALUE * price_pct / 100 (+ accrued
    interest, NKD, which is excluded here -- this is a market-value
    snapshot of the bond itself, matching how `cash_flows` already tracks
    coupon/redemption payments separately).
    """
    market = "bonds"
    url = (
        f"{MOEX_ISS_BASE}/engines/stock/markets/{market}/boards/{board}/securities/{secid}.json"
        f"?iss.meta=off&iss.only=securities,marketdata"
    )
    data = fetch_json(url)
    price_pct = None
    facevalue = None
    currency = "RUB"
    as_of = None

    if data:
        sec_cols = data.get("securities", {}).get("columns", [])
        sec_rows = data.get("securities", {}).get("data", [])
        md_cols = data.get("marketdata", {}).get("columns", [])
        md_rows = data.get("marketdata", {}).get("data", [])
        if sec_rows:
            sec = dict(zip(sec_cols, sec_rows[0]))
            facevalue = sec.get("FACEVALUE")
            currency = sec.get("FACEUNIT") or sec.get("CURRENCYID") or "RUB"
            as_of = sec.get("PREVDATE")
            price_pct = sec.get("PREVPRICE")
        if md_rows:
            md = dict(zip(md_cols, md_rows[0]))
            if md.get("LAST") is not None:
                price_pct = md["LAST"]

    if price_pct is None or facevalue is None:
        # Not currently traded (matured/delisted/illiquid) -- fall back to
        # the most recent historical session on this board.
        hist_url = (
            f"{MOEX_ISS_BASE}/history/engines/stock/markets/{market}/boards/{board}"
            f"/securities/{secid}.json?iss.meta=off&sort_order=desc&limit=1"
        )
        hist = fetch_json(hist_url)
        if not hist:
            return None
        cols = hist.get("history", {}).get("columns", [])
        rows = hist.get("history", {}).get("data", [])
        if not rows:
            return None
        row = dict(zip(cols, rows[0]))
        facevalue = facevalue or row.get("FACEVALUE")
        currency = row.get("FACEUNIT") or currency
        as_of = row.get("TRADEDATE")
        price_pct = row.get("LEGALCLOSEPRICE") or row.get("CLOSE") or row.get("MARKETPRICE2") or row.get("MARKETPRICE3")

    if price_pct is None or facevalue is None:
        return None

    price_native = float(facevalue) * float(price_pct) / 100.0
    return {"price_rub": price_native, "currency": currency, "as_of": as_of}


def fetch_moex_prices(tickers: list[str]) -> dict[str, dict]:
    """
    Resolves a mixed list of MOEX candidate tickers (shares, ETFs, corp
    bonds, OFZ) to {price_rub/native, currency, as_of, secid}. Tries the
    cheap batched shares/ETF lookup first, then falls back to the generic
    securities search (which reveals the correct engine/market/board) for
    anything left over, including all bonds.
    """
    results: dict[str, dict] = {}
    remaining = list(tickers)

    log(f"MOEX: batch share/ETF lookup for {len(remaining)} candidates...")
    share_hits = moex_fetch_shares_batch(remaining)
    for t, info in share_hits.items():
        results[t] = {**info, "secid": t, "asset_class": "moex_share_or_etf"}
    remaining = [t for t in remaining if t not in results]

    log(f"MOEX: resolving {len(remaining)} remaining candidates via securities search...")
    for ticker in remaining:
        info = moex_resolve_via_search(ticker)
        if info is None:
            log(f"  {ticker}: not found on MOEX")
            continue
        secid = info["secid"]
        board = info.get("marketprice_boardid") or info.get("primary_boardid")
        group = info.get("group", "")
        if group == "stock_bonds":
            bond = moex_fetch_bond(ticker, secid, board, group)
            if bond is None:
                log(f"  {ticker}: MOEX bond found ({secid}/{board}) but no price data")
                continue
            asset_class = "moex_ofz" if info.get("type") == "ofz_bond" else "moex_bond"
            results[ticker] = {**bond, "secid": secid, "asset_class": asset_class}
        elif group in ("stock_shares", "stock_ppif", "stock_index"):
            # The board reported by the search endpoint isn't always where
            # the instrument actually has live/last-close data (e.g. a
            # CNY-denominated BPIF whose real liquidity is on TQTY, not the
            # nominal primary board TQBR) -- try every currently-tradeable
            # shares-market board for this secid until one returns a price.
            boards_to_try = [b for b in [board] if b] + [
                b for b in moex_list_traded_boards(secid) if b != board
            ]
            hit = None
            for candidate_board in boards_to_try:
                hit = moex_fetch_shares_batch_on_board([secid], candidate_board)
                if hit:
                    break
                time.sleep(0.1)
            if not hit:
                log(f"  {ticker}: MOEX security found ({secid}) but no market data on any board")
                continue
            results[ticker] = {**hit[secid], "secid": secid, "asset_class": "moex_share_or_etf"}
        else:
            log(f"  {ticker}: MOEX group '{group}' not handled, skipping")
        time.sleep(0.15)

    return results


def moex_fetch_shares_batch_on_board(tickers: list[str], board: str) -> dict[str, dict]:
    if not tickers:
        return {}
    out: dict[str, dict] = {}
    joined = ",".join(tickers)
    url = (
        f"{MOEX_ISS_BASE}/engines/stock/markets/shares/boards/{board}/securities.json"
        f"?securities={joined}&iss.meta=off&iss.only=securities,marketdata"
    )
    data = fetch_json(url)
    if not data:
        return out
    sec_cols = data.get("securities", {}).get("columns", [])
    sec_rows = data.get("securities", {}).get("data", [])
    secs = {row[sec_cols.index("SECID")]: dict(zip(sec_cols, row)) for row in sec_rows}
    md_cols = data.get("marketdata", {}).get("columns", [])
    md_rows = data.get("marketdata", {}).get("data", [])
    mds = {row[md_cols.index("SECID")]: dict(zip(md_cols, row)) for row in md_rows}
    for secid, sec in secs.items():
        md = mds.get(secid, {})
        price = md.get("LAST") or sec.get("PREVLEGALCLOSEPRICE") or sec.get("PREVPRICE")
        if price is None:
            continue
        out[secid] = {
            "price_rub": float(price),
            "currency": sec.get("CURRENCYID") or "RUB",
            "as_of": sec.get("PREVDATE"),
        }
    return out


# ---------------------------------------------------------------------------
# Yahoo Finance fetching (US stocks, crypto/metals, Western ETFs)
# ---------------------------------------------------------------------------

def yahoo_fetch_symbol(symbol: str) -> dict | None:
    """Fetches meta (currency, regularMarketPrice, regularMarketTime) for a
    single Yahoo chart symbol. Mirrors erp_valuation/us_zscore.py's
    fetch_daily_prices approach/style, but only needs the latest quote
    (meta block), not the full daily series."""
    url = f"{YAHOO_CHART_BASE}/{symbol}?range=5d&interval=1d"
    data = fetch_json(url)
    if not data:
        return None
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        return None
    meta = result.get("meta", {})
    price = meta.get("regularMarketPrice")
    if price is None:
        return None
    ts = meta.get("regularMarketTime")
    as_of = time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else None
    return {"price": float(price), "currency": meta.get("currency"), "as_of": as_of, "symbol": meta.get("symbol")}


def fetch_us_stock_price(ticker: str) -> dict | None:
    return yahoo_fetch_symbol(ticker)


def fetch_crypto_price(ticker: str) -> dict | None:
    symbol = CRYPTO_YAHOO_OVERRIDES.get(ticker.upper(), f"{ticker.upper()}-USD")
    return yahoo_fetch_symbol(symbol)


def fetch_western_etf_price(ticker: str) -> dict | None:
    """Best-effort: try common UCITS-ETF exchange suffixes in turn, use
    whichever first returns a valid quote. Documented as best-effort since
    the correct listing/suffix is not knowable in general without a
    proper symbol-lookup API."""
    for suffix in WESTERN_ETF_SUFFIXES:
        hit = yahoo_fetch_symbol(f"{ticker}{suffix}")
        if hit is not None:
            hit["suffix_used"] = suffix
            return hit
        time.sleep(0.1)
    return None


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

_FX_CACHE: dict[str, float | None] = {}


def normalize_currency(currency: str | None) -> str | None:
    """MOEX's CURRENCYID/FACEUNIT uses 'SUR' as its internal code for
    Russian rubles (a holdover from the pre-1998 ruble); normalize it to
    the standard ISO code 'RUB' before storing/displaying it."""
    if currency and currency.upper() == "SUR":
        return "RUB"
    return currency


def fx_rate_to_usd(currency: str, usd_rub_rate: float | None) -> float | None:
    """
    Returns how many USD one unit of `currency` is worth, i.e. the
    multiplier to convert a native price into USD. RUB uses the repo's
    existing data/usd_rub_history.csv (usd_rub_tracker's own data source,
    reused as-is rather than re-fetched). Any other currency (EUR, CNY,
    GBP, ...) is resolved generically via Yahoo's <CCY>USD=X pair and
    cached for the rest of this run, so MOEX bonds denominated in
    currencies other than RUB (e.g. CNY-denominated corporate bonds, seen
    in real data) convert correctly instead of being silently dropped.
    """
    c = currency.upper()
    if c == "USD":
        return 1.0
    if c in ("RUB", "SUR"):
        return (1.0 / usd_rub_rate) if usd_rub_rate else None
    if c in _FX_CACHE:
        return _FX_CACHE[c]
    hit = yahoo_fetch_symbol(f"{c}USD=X")
    rate = hit["price"] if hit else None
    _FX_CACHE[c] = rate
    if rate is None:
        log(f"  no FX rate found for {c} -> USD")
    return rate


# Yahoo quotes some exchanges in a minor unit rather than the major
# currency unit, and marks that with a lowercase second letter in the
# currency code (its normal codes are all-uppercase ISO-4217, e.g. "USD",
# "EUR"). Confirmed via a real fetch: XSX6 on the LSE (XSX6.L) comes back
# as currency "GBp" (pence, 1/100 GBP) with a price in the thousands,
# NOT "GBP" -- treating that as whole pounds would inflate the USD value
# ~100x. Divide by 100 and use the major-unit ISO code for the FX lookup.
MINOR_UNIT_CURRENCIES = {"GBp": "GBP", "ZAc": "ZAR", "ILa": "ILS"}


def to_usd(price: float, currency: str | None, usd_rub_rate: float | None) -> float | None:
    if currency is None:
        return None
    if currency in MINOR_UNIT_CURRENCIES:
        price = price / 100.0
        currency = MINOR_UNIT_CURRENCIES[currency]
    rate = fx_rate_to_usd(currency, usd_rub_rate)
    return price * rate if rate is not None else None


def main() -> int:
    config = supabase_config()

    tickers: list[str] | None = None
    if config:
        base_url, service_key = config
        log(f"Fetching distinct tickers from Supabase trades ({base_url})...")
        tickers = fetch_distinct_tickers(base_url, service_key)

    if not tickers:
        log("Using SEED_TICKERS fallback list (Supabase query unavailable or empty).")
        tickers = list(SEED_TICKERS)
    else:
        log(f"Found {len(tickers)} distinct tickers across all users' trades.")

    usd_rub_rate = latest_usd_rub_rate()
    log(f"Latest USD/RUB rate: {usd_rub_rate}")

    # --- classify ---
    moex_candidates: list[str] = []
    crypto_candidates: list[str] = []
    for t in tickers:
        cls = classify_ticker(t)
        if cls in ("moex_ofz", "moex_bond", "moex_share_or_etf_or_other"):
            moex_candidates.append(t)
        if cls == "crypto":
            crypto_candidates.append(t)

    rows_out: list[dict] = []
    resolved: set[str] = set()

    # --- MOEX (shares, ETFs, corp bonds, OFZ) ---
    moex_hits = fetch_moex_prices(moex_candidates)
    for ticker, info in moex_hits.items():
        price_native = info["price_rub"]
        currency = normalize_currency(info.get("currency")) or "RUB"
        price_usd = to_usd(price_native, currency, usd_rub_rate)
        if price_usd is None:
            log(f"  {ticker}: MOEX price found but could not convert {currency} -> USD, skipping")
            continue
        rows_out.append({
            "ticker": ticker,
            "price_usd": round(price_usd, 6),
            "native_price": price_native,
            "currency": currency,
            "asset_class": info["asset_class"],
            "source": "moex_iss",
            "as_of": info.get("as_of"),
        })
        resolved.add(ticker)

    # --- crypto / metals ---
    for ticker in crypto_candidates:
        hit = fetch_crypto_price(ticker)
        if hit is None:
            log(f"  {ticker}: no Yahoo crypto/metal quote found")
            continue
        price_usd = to_usd(hit["price"], hit.get("currency") or "USD", usd_rub_rate)
        if price_usd is None:
            continue
        rows_out.append({
            "ticker": ticker,
            "price_usd": round(price_usd, 6),
            "native_price": hit["price"],
            "currency": hit.get("currency"),
            "asset_class": "crypto",
            "source": "yahoo_finance",
            "as_of": hit.get("as_of"),
        })
        resolved.add(ticker)
        time.sleep(0.15)

    # --- everything left over: try as a plain US stock, then as a
    #     Western-exchange ETF with common suffixes ---
    leftover = [t for t in tickers if t not in resolved and classify_ticker(t) == "moex_share_or_etf_or_other" and t not in moex_hits]
    for ticker in leftover:
        hit = fetch_us_stock_price(ticker)
        asset_class = "us_stock"
        source_symbol = ticker
        if hit is None:
            hit = fetch_western_etf_price(ticker)
            asset_class = "western_etf"
            if hit is not None:
                source_symbol = hit.get("symbol", ticker)
        if hit is None:
            log(f"  {ticker}: no price found on MOEX or Yahoo (US/Western-ETF) -- skipping")
            time.sleep(0.15)
            continue
        price_usd = to_usd(hit["price"], hit.get("currency") or "USD", usd_rub_rate)
        if price_usd is None:
            log(f"  {ticker}: found {source_symbol} but could not convert {hit.get('currency')} -> USD")
            time.sleep(0.15)
            continue
        rows_out.append({
            "ticker": ticker,
            "price_usd": round(price_usd, 6),
            "native_price": hit["price"],
            "currency": hit.get("currency"),
            "asset_class": asset_class,
            "source": "yahoo_finance",
            "as_of": hit.get("as_of"),
        })
        resolved.add(ticker)
        time.sleep(0.15)

    unresolved = [t for t in tickers if t not in resolved]
    log(f"\nResolved {len(resolved)}/{len(tickers)} tickers.")
    if unresolved:
        log(f"Unresolved ({len(unresolved)}): {', '.join(sorted(unresolved))}")

    if not config:
        log("\nSUPABASE_URL/SUPABASE_PROJECT_REF and/or SUPABASE_SERVICE_ROLE_KEY not set -- "
            "printing results instead of upserting (local/dry-run mode).")
        log(json.dumps(rows_out, indent=2, default=str))
        return 0

    base_url, service_key = config
    log(f"\nUpserting {len(rows_out)} rows into {base_url}/rest/v1/market_prices ...")
    upsert_market_prices(base_url, service_key, rows_out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
