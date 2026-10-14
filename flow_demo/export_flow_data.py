"""Export the March 2026 forecast to flow_data.js for the operations twin.

Reads outputs/forecast_bundle.json (forecast_final.py) and the synthetic
data CSVs, and writes one record per horizon day plus the evaluation,
explanation and provenance blocks the demo shows. The demo loads the file
with a plain <script> tag, so it works when the page is opened from disk.

Per terminal, market and arrivals/departures node the day record carries:

  actual                the synthetic outcome the dots follow
  univariate            TimesFM history only (reconciled): the "History only" plan
  joint_with_covariates TimesFM with schedule and events (reconciled median)
  q                     calibrated, reconciled quantiles P5 ... P95 (meta.levels)
  uq                    the same for the history-only model
  plan                  {hist, tfm, p90}: what each roster preset plans for
  why                   Shapley split of the covariate forecast (base + groups)
  variants              point forecasts without weather and with IFS / AIFS weather
  scen                  re-forecast multipliers for the three scenarios

Run python run_all.py (or forecast_eval.py then forecast_final.py) first.
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import date
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))

from forecast_operations import CAR_PARKS  # noqa: E402  single source of capacities

BUNDLE = ROOT / "outputs" / "forecast_bundle.json"
DAILY = ROOT / "data" / "dublin_airport_daily.csv"
MARKET_DATA = ROOT / "data" / "dublin_airport_markets.csv"
DIRECTIONS = ROOT / "data" / "dublin_airport_directions.csv"
LANDSIDE = ROOT / "data" / "dublin_airport_landside.csv"
PERSONAS = ("business", "leisure", "family", "group", "prm")
OUT = HERE / "flow_data.js"
LEVELS_INDEX = {"q10": 1, "q50": 5, "q90": 9}


def read_rows(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"{path} is missing. Run python run_all.py first.")
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def node(series: dict, day: int) -> dict:
    """One node's numbers for one horizon day."""
    cov, uni = series["covariates"], series["univariate"]
    point = cov.get("rec", cov["point"])[day]
    upoint = uni.get("rec", uni["point"])[day]
    q = (cov.get("recQ") or cov["q"])[day]
    uq = (uni.get("recQ") or uni["q"])[day]
    out = {
        "actual": series["actual"][day],
        "univariate": upoint,
        "joint_with_covariates": point,
        "raw": {"univariate": uni["point"][day], "covariates": cov["point"][day], "joint": series["joint"]["point"][day]},
        "q": q,
        "uq": uq,
        "plan": {"hist": upoint, "tfm": point, "p90": q[LEVELS_INDEX["q90"]]},
        "why": {k: v[day] for k, v in series["why"].items()},
        "scen": {k: v[day] for k, v in series["scen"].items()},
    }
    if "variants" in series:
        out["variants"] = {k: v[day] for k, v in series["variants"].items()}
    if "dayahead" in series:
        out["da"] = {"point": series["dayahead"]["point"][day], "q": series["dayahead"]["q"][day]}
    for name, i in LEVELS_INDEX.items():
        out[name] = q[i]
    return out


def main() -> None:
    if not BUNDLE.exists():
        raise SystemExit(f"{BUNDLE} is missing. Run python run_all.py first.")
    bundle = json.loads(BUNDLE.read_text())
    S = bundle["series"]
    origin = date.fromisoformat(bundle["meta"]["origin"])
    horizon = bundle["meta"]["horizon"]
    daily = {row["date"][:10]: row for row in read_rows(DAILY)}
    market_rows = {(r["date"][:10], r["terminal"], r["market"]): r for r in read_rows(MARKET_DATA)}
    direction_rows = {(r["date"][:10], r["terminal"], r["market"]): r for r in read_rows(DIRECTIONS)}
    landside_rows = {r["date"][:10]: r for r in read_rows(LANDSIDE)}

    days = []
    keys = sorted(daily)
    start = keys.index(origin.isoformat())
    for i in range(horizon):
        day = keys[start + i]
        src = daily[day]
        rec = {
            "date": day,
            "weekday": date.fromisoformat(day).strftime("%a"),
            "event": src["event_name"] or None,
            "eventKind": src["event_kind"] or None,
            "disruption": src["disruption_name"] or None,
            "delayMin": float(src["avg_departure_delay_min"]),
            "cancelledPct": float(src["cancelled_pct"]),
            "schoolHoliday": bool(int(src["school_holiday"])),
        }
        for t, col in (("t1", "terminal_1"), ("t2", "terminal_2")):
            rec[t] = node(S[f"terminals:{t}"], i)
            rec[t]["joint"] = S[f"terminals:{t}"]["joint"]["point"][i]
            rec[t]["movements"] = int(src[f"{col}_scheduled_movements"])
            rec[t]["operated"] = int(src[f"{col}_operated_movements"])
        rec["markets"] = {}
        for t in ("t1", "t2"):
            for key, s in S.items():
                fam, name = key.split(":")
                if fam != f"markets_{t}":
                    continue
                m = name.split("/")[1]
                mrow = market_rows[(day, t, m)]
                drow = direction_rows[(day, t, m)]
                entry = node(s, i)
                entry["movements"] = int(mrow["scheduled_movements"])
                entry["mix"] = {p: float(mrow[f"mix_{p}"]) for p in PERSONAS}
                for d in ("arr", "dep"):
                    entry[d] = node(S[f"directions_{t}:{t}/{m}/{d}"], i)
                entry["transferShare"] = float(drow["transfer_share"])
                entry["residentShare"] = float(drow["resident_share"])
                entry["eventDirection"] = int(drow["event_direction"])
                rec["markets"].setdefault(t, {})[m] = entry
        ls = landside_rows[day]
        num = lambda k: int(float(ls[k]))
        rec["landside"] = {
            "taxi": {t: node(S[f"landside:taxi_pickups_{t}"], i) for t in ("t1", "t2")},
            "bus": {t: node(S[f"landside:bus_pax_{t}"], i) for t in ("t1", "t2")},
            "hbEntries": node(S["landside:hb_entries"], i),
            "hbOcc": node(S["landside:hb_occ_start"], i),
            "taxiDropoffs": {t: num(f"taxi_dropoffs_{t}") for t in ("t1", "t2")},
            "dropoffCars": {t: num(f"dropoff_cars_{t}") for t in ("t1", "t2")},
            "rentalParties": {t: num(f"rental_parties_{t}") for t in ("t1", "t2")},
            "carparks": {
                key: {"cap": spec["cap"], "occ0": num(f"{key}_occ_start"), "entries": num(f"{key}_entries"),
                      "exits": num(f"{key}_exits"), "turnedAway": num(f"{key}_turned_away")}
                for key, spec in CAR_PARKS.items()
            },
        }
        rec["staff"] = {shift: num(f"staff_{shift}") for shift in ("early", "mid", "late", "night")}
        if "weather" in bundle:
            rec["weather"] = bundle["weather"]["days"][i]
        days.append(rec)

    # Recent actuals for the fan charts: terminals, markets, landside.
    context_dates_start = keys[start - 120]
    payload = {
        "generated": bundle["meta"]["generated"],
        "note": "Synthetic daily series calibrated to CSO monthly totals for Dublin Airport. "
                "Daily values, terminals, markets and everything operational are invented.",
        "meta": bundle["meta"],
        "accuracy": bundle["accuracy"],
        "history": bundle["history"],
        "context": {"start": context_dates_start, "series": bundle["context"]},
        "labels": {k: v["label"] for k, v in S.items()},
        "weather": {k: v for k, v in bundle.get("weather", {}).items() if k != "days"},
        "days": days,
    }
    OUT.write_text("window.FLOW_DATA = " + json.dumps(payload, separators=(",", ":")) + ";\n")
    print(f"Wrote {len(days)} days to {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e3:.0f} KB)")


if __name__ == "__main__":
    main()
