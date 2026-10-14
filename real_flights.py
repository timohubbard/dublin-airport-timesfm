"""Real flights at Dublin Airport (EIDW) from the OpenSky Network.

OpenSky reconstructs flights from ADS-B: every aircraft seen leaving or
reaching Dublin, with its callsign and the other airport. That gives a
real daily count of departures and arrivals, by airline group and by the
twin's markets, to compare with CSO's monthly commercial flights and with
the synthetic schedule the forecast uses.

    python real_flights.py --dry-run          # one day, print what comes back
    python real_flights.py                    # backfill (resumable), newest first
    python real_flights.py --max-hours 10     # keep going across credit resets
    python real_flights.py --report           # aggregate and write the coverage report

Credentials: an OpenSky API client, reference_data/flights/credentials.json
({"clientId": ..., "clientSecret": ...}, gitignored), OAuth2 client
credentials. Each one-day query costs 30 credits; a standard account has
4,000 a day, so about 66 days of departures and arrivals per day of running.

Raw responses are cached per day in data/flights_raw/ (gitignored); the daily
aggregate reference_data/flights/eidw_daily.csv is committed. OpenSky data
are for research and non-commercial use; cite the OpenSky Network
(Schäfer et al., 2014, "Bringing up OpenSky", IPSN).
"""

from __future__ import annotations

import argparse
import calendar
import gzip
import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CREDS = ROOT / "reference_data" / "flights" / "credentials.json"
DAILY = ROOT / "reference_data" / "flights" / "eidw_daily.csv"
RAW = ROOT / "data" / "flights_raw"
REPORT = ROOT / "outputs" / "flights_report.md"
LOG = ROOT / "outputs" / "flights_backfill.log"
TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"
API = "https://opensky-network.org/api/flights/{direction}?airport=EIDW&begin={begin}&end={end}"
FIRST, LAST = date(2023, 1, 1), date(2026, 3, 31)
DIRECTIONS = ("departure", "arrival")
QUERY_COST = 30

# Airline groups by ICAO operator prefix.
RYANAIR = {"RYR", "RUK", "MAY", "LDM", "BUZ"}
AER_LINGUS = {"EIN", "EAI", "EFW"}
CARGO = {"FDX", "UPS", "BCS", "DHK", "DHX", "ABR", "BOX", "CLX", "GTI", "ABW", "NPT", "MPH", "TAY", "SWN"}
BUSINESS = {"NJE", "VJT", "DCS", "GAC", "JFA", "LXJ", "EJA", "TWY", "FYL", "AOJ", "GMA", "IFA", "SVW", "ADN", "LNX", "EDC", "JME", "MMD", "PAV", "HYP"}
CALLSIGN = re.compile(r"^([A-Z]{3})[0-9][0-9A-Z]{0,4}$")


def market_of(icao: str | None) -> str:
    """The twin's market for the other airport of a flight (ICAO code)."""
    if not icao:
        return "unknown"
    c = icao.upper()
    if c.startswith("EI"):
        return "domestic"
    if c.startswith("EG"):
        return "uk"
    if c == "LEMD":
        return "eu_city"
    if c.startswith(("LE", "LP", "GC", "LG", "LM", "LC", "GM", "DT", "HE", "LD")) or c in ("LFMN", "LTBS", "LTAI", "LTFE"):
        return "eu_sun"
    if c.startswith(("K", "C", "PA", "PH", "MM", "TJ")):
        return "na"
    if c.startswith(("O", "V", "W", "R", "Z", "Y", "F", "H")) or c in ("LTFM", "LTBA", "LTFJ"):
        return "long"
    if c.startswith(("E", "L", "B", "U")):
        return "eu_city"
    return "unknown"


def classify(callsign: str | None) -> tuple[str, str]:
    """(operator prefix, group): group is ryanair, aer_lingus, cargo, business, other_airline or non_airline."""
    cs = (callsign or "").strip().upper()
    m = CALLSIGN.match(cs)
    if not m:
        return "", "non_airline"
    op = m.group(1)
    if op in RYANAIR:
        return op, "ryanair"
    if op in AER_LINGUS:
        return op, "aer_lingus"
    if op in CARGO:
        return op, "cargo"
    if op in BUSINESS:
        return op, "business"
    return op, "other_airline"


# ---------------------------------------------------------------- API
class OpenSky:
    def __init__(self, creds: Path = CREDS):
        if not creds.exists():
            raise SystemExit(f"{creds.relative_to(ROOT)} is missing: create an API client on opensky-network.org")
        c = json.loads(creds.read_text())
        self.cid, self.secret = c["clientId"], c["clientSecret"]
        self.token, self.expires = None, 0.0
        self.remaining: int | None = None

    def _auth(self) -> str:
        if not self.token or time.time() > self.expires - 300:
            body = urllib.parse.urlencode({"grant_type": "client_credentials", "client_id": self.cid, "client_secret": self.secret}).encode()
            req = urllib.request.Request(TOKEN_URL, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"})
            t = json.loads(urllib.request.urlopen(req, timeout=60).read())
            self.token, self.expires = t["access_token"], time.time() + float(t.get("expires_in", 1800))
        return self.token

    def day(self, direction: str, d: date) -> tuple[str, list | float]:
        """('ok', flights) | ('wait', seconds) | ('error', seconds). 404 means no flights."""
        begin = calendar.timegm(d.timetuple())
        url = API.format(direction=direction, begin=begin, end=begin + 86399)
        req = urllib.request.Request(url, headers={"Authorization": "Bearer " + self._auth(), "User-Agent": "dublin-airport-timesfm (research)"})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                rem = r.headers.get("X-Rate-Limit-Remaining")
                self.remaining = int(rem) if rem is not None else self.remaining
                return "ok", json.loads(r.read() or b"[]")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return "ok", []
            if e.code == 429:
                return "wait", float(e.headers.get("X-Rate-Limit-Retry-After-Seconds") or 3600)
            if e.code == 401:
                self.token = None
            return "error", 60.0
        except Exception:
            return "error", 60.0


def raw_path(direction: str, d: date) -> Path:
    return RAW / direction / f"{d.isoformat()}.json.gz"


def todo(first: date = FIRST, last: date = LAST) -> list[tuple[str, date]]:
    """Days still to fetch, newest first; departures before arrivals for each day."""
    out, d = [], last
    while d >= first:
        for direction in DIRECTIONS:
            if not raw_path(direction, d).exists():
                out.append((direction, d))
        d -= timedelta(days=1)
    return out


def log(msg: str) -> None:
    line = f"{datetime.now(timezone.utc):%Y-%m-%d %H:%M:%S}Z {msg}"
    print(line, flush=True)
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(line + "\n")


def backfill(max_hours: float, first: date, last: date) -> None:
    api, deadline, got = OpenSky(), time.time() + max_hours * 3600, 0
    jobs = todo(first, last)
    log(f"backfill: {len(jobs)} day-queries to go ({first} .. {last}), up to {max_hours:g} h")
    errors = 0
    while jobs and time.time() < deadline:
        direction, d = jobs[0]
        status, val = api.day(direction, d)
        if status == "ok":
            p = raw_path(direction, d)
            p.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(p, "wt") as f:
                json.dump(val, f)
            jobs.pop(0); got += 1; errors = 0
            if got % 10 == 0:
                log(f"  {got} fetched, at {d} {direction}, {len(jobs)} to go, credits left {api.remaining}")
            continue
        if status == "wait":
            wait = min(val, max(0.0, deadline - time.time()))
            log(f"  credits used up after {got} queries; waiting {val / 3600:.1f} h for the reset")
            if wait < val:
                break
            time.sleep(val + 30)
            continue
        errors += 1
        log(f"  error on {d} {direction} ({errors}); retrying in {val:.0f} s")
        if errors >= 8:
            log("  too many errors, stopping")
            break
        time.sleep(val)
    log(f"backfill stopped: {got} fetched this run, {len(jobs)} still to go")
    aggregate()


# ---------------------------------------------------------------- aggregate and report
GROUPS = ("ryanair", "aer_lingus", "other_airline", "cargo", "business", "non_airline")
MARKETS = ("uk", "eu_city", "eu_sun", "na", "long", "domestic", "unknown")


def summarise_day(flights: list, direction: str) -> dict:
    other_key = "estArrivalAirport" if direction == "departure" else "estDepartureAirport"
    row = {"all": len(flights)} | {g: 0 for g in GROUPS} | {m: 0 for m in MARKETS}
    for f in flights:
        _, g = classify(f.get("callsign"))
        row[g] += 1
        if g in ("ryanair", "aer_lingus", "other_airline"):
            row[market_of(f.get(other_key))] += 1
    row["passenger_airline"] = row["ryanair"] + row["aer_lingus"] + row["other_airline"]
    row["commercial"] = row["passenger_airline"] + row["cargo"]
    return row


def aggregate():
    import pandas as pd
    rows = {}
    for direction in DIRECTIONS:
        for p in sorted((RAW / direction).glob("*.json.gz")):
            d = p.name[:10]
            with gzip.open(p, "rt") as f:
                s = summarise_day(json.load(f), direction)
            pre = "dep_" if direction == "departure" else "arr_"
            rows.setdefault(d, {"date": d}).update({pre + k: v for k, v in s.items()})
    if not rows:
        return None
    df = pd.DataFrame(sorted(rows.values(), key=lambda r: r["date"]))
    DAILY.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(DAILY, index=False)
    log(f"aggregated {len(df)} days into {DAILY.relative_to(ROOT)}")
    return df


def report() -> str:
    import numpy as np
    import pandas as pd
    df = aggregate()
    if df is None or df.empty:
        raise SystemExit("No flights cached yet: run python real_flights.py")
    df["date"] = pd.to_datetime(df["date"])
    both = df.dropna(subset=["dep_all", "arr_all"]).copy()
    lines = ["# Real flights at Dublin (OpenSky) — coverage report", "",
             f"Days cached: {len(df)} ({df['date'].min():%d %b %Y} to {df['date'].max():%d %b %Y}); "
             f"{len(both)} with both departures and arrivals.", ""]
    # Monthly coverage against CSO commercial flights.
    cso = pd.read_csv(ROOT / "reference_data" / "cso_dublin_monthly.csv")
    both["month"] = both["date"].dt.strftime("%Y-%m")
    m = both.groupby("month").agg(days=("date", "size"), commercial=("dep_commercial", "sum"), arr=("arr_commercial", "sum"),
                                  airline=("dep_passenger_airline", "sum"), airline_arr=("arr_passenger_airline", "sum"))
    m["opensky"] = m["commercial"] + m["arr"]
    m = m.join(cso.set_index("month")["commercial_flights"])
    m["days_in_month"] = [calendar.monthrange(int(s[:4]), int(s[5:]))[1] for s in m.index]
    full = m[m["days"] == m["days_in_month"]].copy()
    lines += ["## Monthly: OpenSky commercial movements against CSO", "",
              "| Month | Days | OpenSky (dep + arr) | CSO commercial flights | Coverage |", "| --- | --- | --- | --- | --- |"]
    for mon, r in m.iterrows():
        cov = r["opensky"] / r["commercial_flights"] * (r["days_in_month"] / r["days"]) if r["commercial_flights"] else np.nan
        lines.append(f"| {mon} | {int(r['days'])}/{int(r['days_in_month'])} | {int(r['opensky']):,} | {int(r['commercial_flights']):,} | "
                     f"{cov:.0%}{'' if r['days'] == r['days_in_month'] else ' (scaled from part month)'} |")
    lines += ["", "CSO TAM07 counts commercial flights in thousands, rounded to the nearest hundred.", ""]
    # Daily: airline mix, markets, weekday.
    lines += ["## Daily: who flies, and where", ""]
    tot = both[[c for c in both.columns if c.startswith("dep_")]].sum()
    pa = tot["dep_passenger_airline"] or 1
    lines.append("Departures by passenger airline group: " + ", ".join(f"{g.replace('_', ' ')} {tot['dep_' + g] / pa:.0%}" for g in ("ryanair", "aer_lingus", "other_airline")) + ".")
    known = sum(tot["dep_" + k] for k in ("uk", "eu_city", "eu_sun", "na", "long"))
    lines.append("Departures by market (where OpenSky found the destination, "
                 f"{known / pa:.0%} of passenger departures): " + ", ".join(f"{k} {tot['dep_' + k] / max(1, known):.0%}" for k in ("uk", "eu_city", "eu_sun", "na", "long")) + ".")
    wd = both.groupby(both["date"].dt.dayofweek)["dep_passenger_airline"].mean()
    lines.append("Average passenger-airline departures by weekday (Mon..Sun): " + ", ".join(f"{v:.0f}" for v in wd.values) + ".")
    # Against the synthetic schedule.
    syn_path = ROOT / "data" / "dublin_airport_daily.csv"
    if syn_path.exists():
        syn = pd.read_csv(syn_path, parse_dates=["date"])
        syn["syn"] = syn["terminal_1_scheduled_movements"] + syn["terminal_2_scheduled_movements"]
        j = both.merge(syn[["date", "syn"]], on="date")
        if len(j) > 5:
            j["real"] = j["dep_passenger_airline"] + j["arr_passenger_airline"]
            ratio = (j["real"] / j["syn"]).mean()
            corr = np.corrcoef(j["real"], j["syn"])[0, 1]
            rw = j.groupby(j["date"].dt.dayofweek)["real"].mean(); rw /= rw.mean()
            sw = j.groupby(j["date"].dt.dayofweek)["syn"].mean(); sw /= sw.mean()
            lines += ["", "## Against the synthetic schedule", "",
                      f"Over {len(j)} days, real passenger-airline movements average {ratio:.0%} of the synthetic scheduled movements; "
                      f"day-to-day correlation {corr:.2f}.", "",
                      "| | Mon | Tue | Wed | Thu | Fri | Sat | Sun |", "| --- | --- | --- | --- | --- | --- | --- | --- |",
                      "| Real weekday shape | " + " | ".join(f"{v:.2f}" for v in rw.values) + " |",
                      "| Synthetic weekday shape | " + " | ".join(f"{v:.2f}" for v in sw.values) + " |"]
    lines += ["", "Source: The OpenSky Network, https://opensky-network.org (research and non-commercial use)."]
    REPORT.parent.mkdir(exist_ok=True)
    REPORT.write_text("\n".join(lines) + "\n")
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--dry-run", action="store_true", help="fetch one day and print a summary")
    ap.add_argument("--report", action="store_true", help="aggregate the cache and write the coverage report")
    ap.add_argument("--max-hours", type=float, default=0.5, help="stop after this long (waits through credit resets)")
    ap.add_argument("--first", type=date.fromisoformat, default=FIRST)
    ap.add_argument("--last", type=date.fromisoformat, default=LAST)
    args = ap.parse_args()
    if args.report:
        print(report())
        return
    if args.dry_run:
        api = OpenSky()
        status, val = api.day("departure", date(2026, 3, 10))
        print(status, "credits left:", api.remaining)
        if status == "ok":
            s = summarise_day(val, "departure")
            print(json.dumps(s, indent=1))
        return
    backfill(args.max_hours, args.first, args.last)


if __name__ == "__main__":
    main()
