"""
Daily prices (in USD) of the securities inside the funds held, for the
portfolio map's expanded funds (js/lookthrough_treemap.js): without a price
history of its own a fund's constituent has no colour.

Which: the constituents of portfolio_look_through_totals making up the first
TOP_SHARE of its value (95%: ~1 240 of ~4 000), less those already priced
(price_history), the Russian ones (MOEX, priced by the page's own sync) and
the fund's "OTHER" line. From the first buy of a fund held (or --from) to today.

Where: Yahoo Finance (yfinance), run from GitHub Actions (Yahoo answers the
runners; Supabase's servers it often doesn't). A security's Yahoo symbol from
its ticker and currency / country (securities): 2330 + TWD -> 2330.TW, RR/ +
GBP -> RR.L, NOVOB + DKK -> NOVO-B.CO, 700 + HKD -> 0700.HK; the candidates
are tried in turn. Pence, cents and agorot (London, Johannesburg, Tel Aviv)
to the unit; each day's close to USD at that day's Yahoo rate.

Written: price_history (ticker = the constituent's market ticker, as the map
names it; source 'yahoo_constituent'), only days that have no price yet.

Run: python erp_valuation/load_constituent_prices.py  (DATABASE_URL set)
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date

import pandas as pd
import psycopg
import yfinance as yf

TOP_SHARE = 0.95
SOURCE = "yahoo_constituent"

# currency -> Yahoo suffix (the euro by the country)
SUFFIX = {"USD": "", "GBP": ".L", "JPY": ".T", "CHF": ".SW", "TWD": ".TW", "CAD": ".TO", "KRW": ".KS",
          "SEK": ".ST", "HKD": ".HK", "AUD": ".AX", "DKK": ".CO", "INR": ".NS", "ILS": ".TA", "NOK": ".OL",
          "SGD": ".SI", "PLN": ".WA", "ZAR": ".JO", "BRL": ".SA", "MXN": ".MX", "CNY": ".SS", "NZD": ".NZ"}
EUR_SUFFIX = {"FR": ".PA", "DE": ".DE", "NL": ".AS", "ES": ".MC", "IT": ".MI", "FI": ".HE", "BE": ".BR",
              "IE": ".IR", "PT": ".LS", "AT": ".VI", "LU": ".AS"}
# quoted in a fraction of the currency: pence, cents, agorot; Kuwait's fils
MINOR = {".L": 0.01, ".JO": 0.01, ".TA": 0.01, ".KW": 0.001}
# The funds' lists name some securities by their Bloomberg code, not the
# exchange's (Vanguard: HDFCB for HDFC Bank, DBS, OCBC...), or on exchanges
# the currency table doesn't know (Riyadh, Abu Dhabi, Doha, Kuwait, Kuala
# Lumpur, Bangkok, Jakarta, Athens, Budapest, Manila): their Yahoo symbols.
OVERRIDE = {
    # India (NSE)
    "HDFCB": "HDFCBANK.NS", "ICICIBC": "ICICIBANK.NS", "BHARTI": "BHARTIARTL.NS", "INFO": "INFY.NS",
    "MM": "M&M.NS", "BAF": "BAJFINANCE.NS", "AXSB": "AXISBANK.NS", "SUNP": "SUNPHARMA.NS", "TTAN": "TITAN.NS",
    "MSIL": "MARUTI.NS", "HUVR": "HINDUNILVR.NS", "SHFL": "SHRIRAMFIN.NS", "BHE": "BEL.NS", "UTCEM": "ULTRACEMCO.NS",
    "HNDL": "HINDALCO.NS", "TATA": "TATASTEEL.NS", "PWGR": "POWERGRID.NS",
    # Singapore
    "DBS": "D05.SI", "OCBC": "O39.SI", "UOB": "U11.SI", "ST": "Z74.SI", "SGX": "S68.SI", "KEP": "BN4.SI",
    # Saudi Arabia, the Emirates, Qatar, Kuwait
    "RJHI": "1120.SR", "ARAMCO": "2222.SR", "SNB": "1180.SR", "MAADEN": "1211.SR", "STC": "7010.SR",
    "FAB": "FAB.AD", "EAND": "EAND.AD", "EMAAR": "EMAAR.AE", "EMIRATES": "EMIRATESNBD.AE",
    "QNBK": "QNBK.QA", "QIBK": "QIBK.QA", "KFH": "KFH.KW", "NBK": "NBK.KW",
    # Malaysia, Thailand, Indonesia, the Philippines
    "MAY": "1155.KL", "TNB": "5347.KL", "PBK": "1295.KL", "CIMB": "1023.KL",
    "DELTA/F": "DELTA.BK", "PTT/F": "PTT.BK", "BBCA": "BBCA.JK", "ICT": "ICT.PS",
    # Greece, Hungary
    "ETE": "ETE.AT", "EUROB": "EUROB.AT", "TPEIR": "TPEIR.AT", "ALPHA": "ALPHA.AT", "PPC": "PPC.AT", "OTP": "OTP.BD",
    # Europe: another exchange than the country's, or another symbol
    "NDA": "NDA-FI.HE", "NOKIA": "NOKIA.HE", "ARGX": "ARGX.BR", "ENX": "ENX.PA", "STLAM": "STLAM.MI",
    "STMMI": "STMMI.MI", "KYGA": "KRZ.IR", "AIBG": "A5G.IR", "KSP": "KRX.IR", "DSFIR": "DSFIR.AS", "PRX": "PRX.AS",
    "CPG": "CPG.L", "ERF": "ERF.PA", "TEN": "TEN.MI", "QIA": "QIA.DE",
    # the US: a class after a space
    "BRK B": "BRK-B",
    # France: shares listed by their ISIN, the registered "loyalty" ones among them ("L'OREAL SA - PF - 2028":
    # prime de fidelite, not traded on their own) -- the ordinary share's price
    "FR0014013RC7": "OR.PA", "FR0011149590": "OR.PA", "FR001400UH43": "OR.PA",
    "FR0014010OO5": "AI.PA", "FR001400T5U9": "AI.PA",
    "FR001400U6U4": "ENGI.PA", "FR0014012X74": "ENGI.PA", "FR0013215407": "ENGI.PA",
    "FR0011532431": "SW.PA", "FR001400C460": "SW.PA", "FR0014004UW8": "SW.PA", "FR001400K6E0": "SW.PA", "FR001400S2Z6": "SW.PA",
}
# fallbacks when the first symbol has no data
ALT_SUFFIX = {".TW": [".TWO"], ".KS": [".KQ"], ".SS": [".SZ"], ".NS": [".BO"]}


def candidates(ticker: str, ccy: str | None, country: str | None) -> list[str]:
    t = (ticker or "").strip().upper()
    if t in OVERRIDE:
        return [OVERRIDE[t]]
    if not t or t == "OTHER" or re.match(r"^[A-Z]{2}[A-Z0-9]{9}\d$", t):   # no ticker, or an ISIN
        return []
    ccy = (ccy or "").upper()
    suf = EUR_SUFFIX.get(country or "", ".DE") if ccy == "EUR" else SUFFIX.get(ccy)
    if suf is None:
        return []
    base = t.rstrip("/")
    forms = [base.replace("/", "-"), base.replace("/", ".")]
    if suf in (".HK",) and base.isdigit():
        forms = [base.zfill(4)]
    if suf in (".ST", ".CO", ".OL", ".HE") and re.match(r"^[A-Z0-9]+[ABC]$", base) and "-" not in base:
        forms = [f"{base[:-1]}-{base[-1]}", base]   # INVEB -> INVE-B, NOVOB -> NOVO-B (NOKIA: OVERRIDE)
    out = []
    for s in [suf, *ALT_SUFFIX.get(suf, [])]:
        for f in forms:
            sym = f + s
            if sym not in out:
                out.append(sym)
    return out


def download(symbols: list[str], start: str) -> dict[str, pd.Series]:
    """symbol -> daily close (its own currency), the symbols that have any."""
    got: dict[str, pd.Series] = {}
    for i in range(0, len(symbols), 100):
        batch = symbols[i:i + 100]
        df = yf.download(batch, start=start, interval="1d", auto_adjust=False, actions=False,
                         group_by="ticker", progress=False, threads=True)
        for s in batch:
            try:
                col = df[s]["Close"]
            except (KeyError, TypeError):
                try:   # a single symbol's frame without the ticker level
                    col = df["Close"]
                    if isinstance(col, pd.DataFrame):
                        col = col[s] if s in col else col.iloc[:, 0]
                except (KeyError, TypeError):
                    continue
            col = col.dropna()
            if len(col):
                got[s] = col
    return got


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default=None)
    ap.add_argument("--top", type=float, default=TOP_SHARE)
    ap.add_argument("--dry-run", action="store_true")
    # given tickers instead (the funds held, whose history starts only when bought): "VWRA=VWRA.L:USD,VWCE=VWCE.DE:EUR"
    ap.add_argument("--symbols", default="")
    args = ap.parse_args()

    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True, prepare_threshold=None) as db:
        start = args.start or db.execute(
            "select min(trade_date) - 7 from trades where side = 'buy' and ticker in (select distinct fund from fund_holdings)"
            " and ticker not in (select ticker from price_freezes)").fetchone()[0].isoformat()
        if args.symbols:
            todo = []
            for item in filter(None, (x.strip() for x in args.symbols.split(","))):
                ticker, rest = item.split("=", 1)
                sym, _, ccy = rest.partition(":")
                todo.append((ticker.strip(), (ccy or "USD").strip().upper(), None, 0.0, [sym.strip()]))
            start = args.start or "2019-01-01"
            print(f"{len(todo)} given tickers from {start}")
            return load(db, todo, start, args.dry_run)
        rows = db.execute("""
            with t as (select ticker, value_usd, sum(value_usd) over (order by value_usd desc) cum,
                              sum(value_usd) over () tot from portfolio_look_through_totals)
            select t.ticker, s.currency, s.country_code, t.value_usd
            from t left join lateral (select currency, country_code from securities s
                                      where coalesce(s.market_ticker, s.ticker) = t.ticker limit 1) s on true
            where t.cum - t.value_usd < %s * t.tot
              and not exists (select 1 from price_history p where p.ticker = t.ticker)
              and coalesce(s.country_code, '') <> 'RU'
            order by t.value_usd desc""", (args.top,)).fetchall()
        # one ticker named in two countries (SU: Schneider and Suncor): the bigger one's
        seen, todo = set(), []
        for ticker, ccy, country, usd in rows:
            if ticker in seen:
                continue
            seen.add(ticker)
            todo.append((ticker, ccy, country, float(usd), candidates(ticker, ccy, country)))
        print(f"{len(todo)} constituents to price from {start}; {sum(1 for x in todo if not x[4])} without a Yahoo symbol")
        return load(db, todo, start, args.dry_run)


def load(db, todo, start: str, dry_run: bool) -> int:
    if True:

        # the symbols, round by round: a constituent's next candidate only when the previous gave nothing
        found: dict[str, tuple[str, pd.Series]] = {}
        for rnd in range(4):
            # one symbol can stand for several tickers (L'Oreal's ordinary and loyalty shares: OR.PA)
            want: dict[str, list[str]] = {}
            for x in todo:
                if x[0] not in found and len(x[4]) > rnd:
                    want.setdefault(x[4][rnd], []).append(x[0])
            if not want:
                break
            got = download(list(want), start)
            for sym, series in got.items():
                for ticker in want[sym]:
                    found.setdefault(ticker, (sym, series))
            print(f"round {rnd + 1}: {len(want)} tried, {len(got)} found")

        # the rates: the currency's USD price per day ("JPYUSD=X")
        ccys = sorted({c for t, c, *_ in todo if t in found and c and c.upper() != "USD"})
        fx = {c: s for c, s in ((c, download([f"{c.upper()}USD=X"], start).get(f"{c.upper()}USD=X")) for c in ccys) if s is not None}
        print(f"rates: {', '.join(sorted(fx))}; missing: {', '.join(c for c in ccys if c not in fx) or 'none'}")

        out = []
        for ticker, ccy, country, usd, cands in todo:
            if ticker not in found:
                continue
            sym, series = found[ticker]
            k = next((f for m, f in MINOR.items() if sym.endswith(m)), 1.0)
            c = (ccy or "USD").upper()
            if c != "USD":
                if c not in fx:
                    continue
                rate = fx[c].reindex(series.index, method="ffill")
            else:
                rate = pd.Series(1.0, index=series.index)
            px = (series * k * rate).dropna()
            out += [(ticker, d.date().isoformat(), round(float(v), 6)) for d, v in px.items() if v > 0]
        missing = [t for t, *_ , c in todo if t not in found]
        print(f"priced {len({r[0] for r in out})} of {len(todo)} ({len(out)} rows); not found: {' '.join(missing[:80])}{' ...' if len(missing) > 80 else ''}")
        if dry_run:
            return 0
        with db.cursor() as cur:
            for i in range(0, len(out), 5000):
                cur.executemany("insert into price_history (ticker, day, price_usd, source) values (%s, %s, %s, %s)"
                                " on conflict (ticker, day) do nothing", [(*r, SOURCE) for r in out[i:i + 5000]])
        print(f"written up to {len(out)} rows (existing days kept)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
