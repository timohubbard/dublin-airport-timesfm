"""Real monthly Dublin Airport figures from the Central Statistics Office.

The daily series in this project are synthetic, but their monthly levels are
calibrated to published CSO aviation statistics so the history looks like
Dublin's real traffic, not an invented airport:

  TAM08  Passengers handled by main airports, monthly
  TAM07  Passengers and commercial flights by country of origin/destination
         and direction, monthly (thousands)

Both come from the CSO PxStat open-data API (CC BY 4.0). The tidy result is
committed in reference_data/cso_dublin_monthly.csv, so nothing is fetched at
run time unless you ask for it:

    python real_data.py            # refresh reference_data/ from the CSO API
    python real_data.py --show     # print the committed table

Destination groups are mapped onto the five demo markets (the mapping is our
choice, not the CSO's):

  uk       United Kingdom
  na       America (United States, Canada, other America)
  long     Asia, Oceania, Africa except Egypt, Morocco and Tunisia
  eu_sun   Spain, Canary Islands, Portugal, Greece, Malta, Cyprus, Croatia,
           Bulgaria, Turkiye, Egypt, Morocco, Tunisia
  eu_city  the rest of Europe, plus domestic flights
"""

from __future__ import annotations

import argparse
import itertools
import json
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
REFERENCE = ROOT / "reference_data"
MONTHLY_CSV = REFERENCE / "cso_dublin_monthly.csv"
API = "https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/{table}/JSON-stat/2.0/en"
SOURCE_PAGE = "https://www.cso.ie/en/statistics/transport/aviationstatistics/"
MARKETS = ("uk", "eu_city", "eu_sun", "na", "long")
SUN = (
    "Spain", "Canary Islands", "Portugal", "Greece", "Malta", "Cyprus", "Croatia",
    "Bulgaria", "Turkiye", "Eygpt", "Morocco", "Tunisia",
)
NORTH_AFRICA = ("Eygpt", "Morocco", "Tunisia")  # CSO spells Egypt "Eygpt"
# The passenger cap in the 2007 planning permission for Terminal 2. Its status
# has been the subject of planning and legal proceedings; it is shown only as
# a reference line.
PLANNING_CAP = 32_000_000


def _fetch(table: str) -> dict:
    with urllib.request.urlopen(API.format(table=table), timeout=90) as response:
        return json.load(response)


def _cube(payload: dict) -> dict[tuple, float | None]:
    """JSON-stat 2.0 dataset to {(label, label, ...): value}."""
    labels = []
    for dim in payload["id"]:
        category = payload["dimension"][dim]["category"]
        index = category["index"]
        order = sorted(index, key=lambda k: index[k]) if isinstance(index, dict) else index
        labels.append([category["label"][key] for key in order])
    values = payload["value"]
    out = {}
    for i, combo in enumerate(itertools.product(*labels)):
        out[combo] = values[i] if isinstance(values, list) else values.get(str(i))
    return out


def _month(label: str) -> date:
    return datetime.strptime(label, "%Y %B").date()


def _groups(get, direction: str) -> dict[str, float]:
    """CSO country rows for one direction, summed into the five demo markets."""
    uk = get("United Kingdom (1)", direction)
    sun_europe = sum(get(c, direction) for c in SUN if c not in NORTH_AFRICA)
    north_africa = sum(get(c, direction) for c in NORTH_AFRICA)
    return {
        "uk": uk,
        "eu_city": get("Europe (48 Countries)", direction) - uk - sun_europe + get("Ireland (domestic)", direction),
        "eu_sun": sun_europe + north_africa,
        "na": get("America", direction),
        "long": get("Asia (8)", direction) + get("Oceania and Polar regions (1)", direction)
        + get("Africa (9)", direction) - north_africa,
    }


def build_monthly(tam08: dict, tam07: dict) -> pd.DataFrame:
    total = _cube(tam08)
    detail = _cube(tam07)
    months = sorted({k[1] for k in detail}, key=_month)
    rows = []
    for m in months:
        pax_total = total.get(("Passengers", m, "Dublin"))
        if pax_total is None:
            continue

        def get(country: str, direction: str = "All directions", stat: str = "Passengers") -> float:
            value = detail.get((stat, m, "Dublin", country, direction, "All flights"))
            return float(value or 0.0)

        both, dep = _groups(get, "All directions"), _groups(get, "Departure")
        share_sum = sum(both.values())
        row = {
            "month": _month(m).isoformat()[:7],
            "passengers": int(pax_total),
            "commercial_flights": int(round(get("All Countries", stat="Commercial Flights") * 1000)),
        }
        row.update({f"share_{k}": round(both[k] / share_sum, 5) for k in MARKETS})
        row.update({f"dep_share_{k}": round(dep[k] / both[k], 5) if both[k] else 0.5 for k in MARKETS})
        rows.append(row)
    return pd.DataFrame(rows)


def refresh() -> pd.DataFrame:
    tam08, tam07 = _fetch("TAM08"), _fetch("TAM07")
    frame = build_monthly(tam08, tam07)
    REFERENCE.mkdir(exist_ok=True)
    frame.to_csv(MONTHLY_CSV, index=False)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (REFERENCE / "SOURCES.md").write_text(
        "# Reference data\n\n"
        f"`cso_dublin_monthly.csv` was retrieved on {stamp} from the Central Statistics Office "
        "(CSO) PxStat API and is used under the CSO's open-data licence (CC BY 4.0).\n\n"
        f"- TAM08 *Passengers handled by main airports*: {API.format(table='TAM08')}\n"
        f"- TAM07 *Passengers, Freight and Commercial Flights* (by country and direction): "
        f"{API.format(table='TAM07')}\n"
        f"- Release page: {SOURCE_PAGE}\n\n"
        "Columns: `passengers` is TAM08 commercial passengers at Dublin (arrivals plus departures; "
        "transit passengers count twice). `commercial_flights` is TAM07 commercial flights, all "
        "directions. `share_<market>` is each demo market's share of TAM07 passengers and "
        "`dep_share_<market>` its departing share; see `real_data.py` for the country mapping.\n\n"
        "Figures are subject to CSO revision.\n"
    )
    print(f"Wrote {MONTHLY_CSV.relative_to(ROOT)} ({len(frame)} months, {frame['month'].iloc[0]} to {frame['month'].iloc[-1]})")
    return frame


def load_monthly() -> pd.DataFrame:
    """The committed CSO table, indexed by month (Period[M])."""
    if not MONTHLY_CSV.exists():
        raise SystemExit(f"{MONTHLY_CSV} is missing. Run python real_data.py to fetch it from the CSO.")
    frame = pd.read_csv(MONTHLY_CSV)
    frame["month"] = pd.PeriodIndex(frame["month"], freq="M")
    return frame.set_index("month")


# Markets flown from both terminals and the part of each that uses Terminal 1.
# Sun routes are all Terminal 1, North America and long-haul all Terminal 2
# (the demo's layout, not daa's published allocation).
T1_PART = {"uk": 0.55, "eu_city": 0.55, "eu_sun": 1.0, "na": 0.0, "long": 0.0}


def market_targets(monthly: pd.DataFrame | None = None) -> pd.DataFrame:
    """Monthly passengers per terminal and market implied by the CSO figures.

    Columns t1_<market>, t2_<market>, t1, t2 and the departing shares; index
    is the month.
    """
    monthly = load_monthly() if monthly is None else monthly
    out = pd.DataFrame(index=monthly.index)
    for m in MARKETS:
        market_pax = monthly["passengers"] * monthly[f"share_{m}"]
        out[f"t1_{m}"] = market_pax * T1_PART[m]
        out[f"t2_{m}"] = market_pax * (1.0 - T1_PART[m])
        out[f"dep_share_{m}"] = monthly[f"dep_share_{m}"]
    out["t1"] = out[[f"t1_{m}" for m in MARKETS]].sum(axis=1)
    out["t2"] = out[[f"t2_{m}" for m in MARKETS]].sum(axis=1)
    out["passengers"] = monthly["passengers"]
    out["commercial_flights"] = monthly["commercial_flights"]
    return out


def monthly_factor(dates: pd.DatetimeIndex, values, targets: pd.Series, iterations: int = 4):
    """Smooth daily multipliers so each month's mean matches target/days.

    The factor is interpolated between mid-month knots, so there are no steps
    at month ends, then nudged until every month hits its target exactly.
    Months without a target keep the nearest month's factor.
    """
    import numpy as np

    values = np.asarray(values, dtype=float)
    periods = dates.to_period("M")
    factor = np.ones(len(dates))
    for _ in range(iterations):
        current = pd.Series(values * factor, index=dates).groupby(periods).sum()
        days = pd.Series(1, index=dates).groupby(periods).sum()
        ratio = {}
        for month, total in current.items():
            if month in targets.index and total > 0:
                full_days = month.days_in_month
                ratio[month] = targets[month] * days[month] / full_days / total
        if not ratio:
            break
        knots = sorted(ratio)
        knot_x = np.array([pd.Timestamp(k.start_time) + pd.Timedelta(days=k.days_in_month / 2) for k in knots], dtype="datetime64[ns]").astype("int64")
        knot_y = np.array([ratio[k] for k in knots])
        smooth = np.interp(dates.asi8, knot_x, knot_y)
        factor = factor * smooth
    # Exact monthly match after smoothing (residual steps are well under 1%).
    current = pd.Series(values * factor, index=dates).groupby(periods).sum()
    days = pd.Series(1, index=dates).groupby(periods).sum()
    exact = np.ones(len(dates))
    for month, total in current.items():
        if month in targets.index and total > 0:
            exact[periods == month] = targets[month] * days[month] / month.days_in_month / total
    return factor * exact


def daily_interp(dates: pd.DatetimeIndex, monthly: pd.Series):
    """A monthly series as a smooth daily one (linear between mid-month knots)."""
    import numpy as np

    knots = monthly.dropna()
    x = np.array([pd.Timestamp(k.start_time) + pd.Timedelta(days=k.days_in_month / 2) for k in knots.index], dtype="datetime64[ns]").astype("int64")
    return np.interp(dates.asi8, x, knots.to_numpy(dtype=float))


def rolling_12m(monthly: pd.DataFrame) -> pd.Series:
    return monthly["passengers"].rolling(12).sum().dropna()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--show", action="store_true", help="Print the committed table instead of refreshing it.")
    args = parser.parse_args()
    frame = load_monthly() if args.show else refresh().set_index("month")
    with pd.option_context("display.width", 160, "display.max_columns", 30):
        print(frame.tail(15))
    if not args.show:
        frame = load_monthly()
    r12 = rolling_12m(frame)
    print(f"Rolling 12-month passengers to {r12.index[-1]}: {r12.iloc[-1]:,.0f} (planning cap reference {PLANNING_CAP:,})")


if __name__ == "__main__":
    main()
