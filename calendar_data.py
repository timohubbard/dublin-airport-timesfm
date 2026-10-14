"""The real calendar: Irish and UK public holidays, and Irish school breaks.

Public holidays (Ireland, and the UK by nation) come from the Nager.Date
API, https://date.nager.at (MIT-licensed data), and are cached in
reference_data/calendar/public_holidays.csv.

Irish school breaks (reference_data/calendar/ie_school_holidays.csv) are
curated by hand: the Department of Education's standardised Christmas,
Easter and mid-term breaks (circulars 0005/2020 and 0072/2022) as published
by schools that follow them. gov.ie does not allow automated fetching, so
each row carries its source. Summer holidays are not standardised; the
summer rows are an approximation (primary schools close at the end of June).
A break runs from the last school day (families travel that evening) to the
Sunday before schools reopen.

    python calendar_data.py           # refresh public holidays from Nager.Date
    python calendar_data.py --show    # summarise what is cached
"""

from __future__ import annotations

import argparse
import json
import time
import urllib.request
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
CAL = ROOT / "reference_data" / "calendar"
PUBLIC = CAL / "public_holidays.csv"
SCHOOL = CAL / "ie_school_holidays.csv"
YEARS = range(2023, 2027)
COUNTRIES = ("IE", "GB")
NAGER = "https://date.nager.at/api/v3/PublicHolidays/{year}/{country}"

# Irish bank holidays by Nager.Date's English name -> the name the forecast uses.
# The event names matter: EVENT_LIFT and the travel-direction rules key on them.
IE_BANK_HOLIDAYS = {
    "Saint Brigid's Day": "St Brigid's Day bank holiday",
    "Saint Patrick's Day": "St Patrick's Day",
    "Easter Monday": "Easter Monday",
    "May Day": "May bank holiday",
    "June Holiday": "June bank holiday",
    "August Holiday": "August bank holiday",
    "October Holiday": "October bank holiday",
}


def _get(url: str, timeout: int = 60) -> bytes:
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "dublin-airport-timesfm (research demo)"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    return b""


def refresh() -> pd.DataFrame:
    rows = []
    for year in YEARS:
        for country in COUNTRIES:
            for h in json.loads(_get(NAGER.format(year=year, country=country))):
                rows.append({"date": h["date"], "country": country, "name": h["name"], "local_name": h["localName"],
                             "regions": ";".join(h["counties"]) if h.get("counties") else "all", "types": ";".join(h.get("types") or [])})
    df = pd.DataFrame(rows).sort_values(["date", "country"]).reset_index(drop=True)
    CAL.mkdir(parents=True, exist_ok=True)
    df.to_csv(PUBLIC, index=False)
    return df


@lru_cache(maxsize=1)
def public_holidays() -> pd.DataFrame:
    if not PUBLIC.exists():
        raise SystemExit(f"{PUBLIC.relative_to(ROOT)} is missing: run python calendar_data.py")
    df = pd.read_csv(PUBLIC)
    df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def ie_bank_holidays(year: int) -> list[tuple[date, str]]:
    """Irish public holidays that are travel bank holidays, with the forecast's event names."""
    df = public_holidays()
    out = [(d, IE_BANK_HOLIDAYS[n]) for d, n, c in zip(df["date"], df["name"], df["country"])
           if c == "IE" and d.year == year and n in IE_BANK_HOLIDAYS]
    missing = set(IE_BANK_HOLIDAYS.values()) - {n for _, n in out}
    if year >= 2023 and missing:
        raise ValueError(f"{year}: Irish bank holidays missing from the cache: {sorted(missing)}")
    return sorted(out)


@lru_cache(maxsize=1)
def _school_days() -> frozenset[date]:
    df = pd.read_csv(SCHOOL, comment="#")
    days: set[date] = set()
    for a, b in zip(pd.to_datetime(df["start"]).dt.date, pd.to_datetime(df["end"]).dt.date):
        assert a <= b, (a, b)
        d = a
        while d <= b:
            days.add(d)
            d += timedelta(days=1)
    return frozenset(days)


def ie_school_holiday(day: date) -> bool:
    if not (date(2023, 1, 1) <= day <= date(2026, 8, 31)):
        raise ValueError(f"no Irish school calendar for {day}; extend {SCHOOL.relative_to(ROOT)}")
    return day in _school_days()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--show", action="store_true", help="summarise the cached calendar")
    args = ap.parse_args()
    if not args.show:
        df = refresh()
        print(f"Cached {len(df)} public holidays ({', '.join(COUNTRIES)}, {YEARS.start}-{YEARS.stop - 1}) in {PUBLIC.relative_to(ROOT)}")
    for year in YEARS:
        print(year, "Irish bank holidays:", ", ".join(f"{d:%d %b} {n}" for d, n in ie_bank_holidays(year)))
    sch = pd.read_csv(SCHOOL, comment="#")
    print(f"Irish school breaks: {len(sch)} rows, {len(_school_days())} days")
    for _, r in sch.iterrows():
        print(f"  {r['start']} to {r['end']}  {r['break']:<18} {r['source']}")


if __name__ == "__main__":
    main()
