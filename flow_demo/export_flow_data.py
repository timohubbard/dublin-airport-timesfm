"""Export the March 2026 holdout to flow_data.js for the passenger-flow demo.

Reads the outputs of forecast_dublin_airport.py and forecast_markets.py and
writes one record per horizon day: actual passengers, each forecast, the
10/50/90% quantiles, scheduled movements, the event flag and the average
departure delay, per terminal and per destination market. The demo
(index.html) loads the file with a plain <script> tag, so it works when the
page is opened straight from disk.

Market forecasts are reconciled to the terminal forecast before they are
used for the security roster: each market keeps its forecast share, scaled
to the terminal total of the same model. The raw market forecasts are kept
alongside for the accuracy table.

Arrivals and departures by market, ground transport, car parks and staff
come from forecast_operations.py. Each block is skipped when its inputs are
missing, and the demo falls back to fixed shares.

Run forecast_dublin_airport.py, forecast_markets.py and
forecast_operations.py first, then:

    python flow_demo/export_flow_data.py
"""

from __future__ import annotations

import csv
import json
from datetime import date, datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
DAILY = ROOT / "data" / "dublin_airport_daily.csv"
FORECAST = ROOT / "outputs" / "forecast.csv"
MARKET_DATA = ROOT / "data" / "dublin_airport_markets.csv"
MARKET_FORECAST = ROOT / "outputs" / "market_forecast.csv"
DIRECTIONS = ROOT / "data" / "dublin_airport_directions.csv"
LANDSIDE = ROOT / "data" / "dublin_airport_landside.csv"
OPS_FORECAST = ROOT / "outputs" / "ops_forecast.csv"
CAR_PARK_CAPACITY = {"hb": 12000, "st_t1": 3000, "st_t2": 2600}
PERSONAS = ("business", "leisure", "family", "group", "prm")
OUT = HERE / "flow_data.js"

TERMINALS = {"terminal_1_passengers": "t1", "terminal_2_passengers": "t2"}
MOVEMENTS = {"t1": "terminal_1_scheduled_movements", "t2": "terminal_2_scheduled_movements"}
FORECAST_FIELDS = ("actual", "univariate", "joint", "joint_with_covariates", "q10", "q50", "q90")


def read_rows(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"{path} is missing. Run forecast_dublin_airport.py first.")
    with path.open(newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    daily = {row["date"]: row for row in read_rows(DAILY)}
    days: dict[str, dict] = {}
    for row in read_rows(FORECAST):
        terminal = TERMINALS.get(row["series"])
        if terminal is None:
            continue
        day = row["date"]
        source = daily[day]
        record = days.setdefault(
            day,
            {
                "date": day,
                "weekday": date.fromisoformat(day).strftime("%a"),
                "event": source["event_name"] or None,
                "eventKind": source["event_kind"] or None,
                "disruption": source["disruption_name"] or None,
                "delayMin": float(source["avg_departure_delay_min"]),
            },
        )
        values = {field: round(float(row[field])) for field in FORECAST_FIELDS}
        values["movements"] = int(source[MOVEMENTS[terminal]])
        record[terminal] = values

    add_markets(days)
    add_operations(days)
    payload = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": "Synthetic series from forecast_dublin_airport.py, forecast_markets.py and forecast_operations.py. Not Dublin Airport figures.",
        "days": [days[key] for key in sorted(days)],
    }
    OUT.write_text("window.FLOW_DATA = " + json.dumps(payload, indent=1) + ";\n")
    print(f"Wrote {len(payload['days'])} days to {OUT.relative_to(ROOT)}")


def add_markets(days: dict[str, dict]) -> None:
    """Attach per-market actuals, forecasts, schedules and passenger mix."""
    if not (MARKET_DATA.exists() and MARKET_FORECAST.exists()):
        print("Market files are missing; run forecast_markets.py for destinations. Exporting terminals only.")
        return
    mix = {}
    for row in read_rows(MARKET_DATA):
        day = row["date"][:10]
        if day in days:
            mix[(day, row["terminal"], row["market"])] = row
    by_terminal: dict[tuple[str, str], list[dict]] = {}
    for row in read_rows(MARKET_FORECAST):
        by_terminal.setdefault((row["date"][:10], row["terminal"]), []).append(row)

    for (day, terminal), rows in by_terminal.items():
        totals = days[day][terminal]
        univ_sum = sum(float(r["univariate"]) for r in rows)
        cov_sum = sum(float(r["joint_with_covariates"]) for r in rows)
        markets = {}
        for r in rows:
            source = mix[(day, terminal, r["market"])]
            univ, cov = float(r["univariate"]), float(r["joint_with_covariates"])
            markets[r["market"]] = {
                "actual": round(float(r["actual"])),
                "univariate": round(univ),
                "joint_with_covariates": round(cov),
                "q10": round(float(r["q10"])),
                "q90": round(float(r["q90"])),
                "movements": int(source["scheduled_movements"]),
                "mix": {p: float(source[f"mix_{p}"]) for p in PERSONAS},
                "plan": {
                    "hist": round(totals["univariate"] * univ / univ_sum),
                    "tfm": round(totals["joint_with_covariates"] * cov / cov_sum),
                    "p90": round(totals["q90"] * cov / cov_sum),
                },
            }
        days[day].setdefault("markets", {})[terminal] = markets


def forecast_values(row: dict) -> dict:
    return {
        "actual": round(float(row["actual"])),
        "univariate": round(float(row["univariate"])),
        "joint_with_covariates": round(float(row["joint_with_covariates"])),
        "q10": round(float(row["q10"])),
        "q90": round(float(row["q90"])),
    }


def add_operations(days: dict[str, dict]) -> None:
    """Attach arrivals/departures by market, ground transport, car parks and staff."""
    if not (DIRECTIONS.exists() and LANDSIDE.exists() and OPS_FORECAST.exists()):
        print("Operations files are missing; run forecast_operations.py for arrivals and landside. Skipping them.")
        return
    shares = {}
    for row in read_rows(DIRECTIONS):
        day = row["date"][:10]
        if day in days:
            shares[(day, row["terminal"], row["market"])] = row
    direction_rows: dict[tuple[str, str], list[dict]] = {}
    landside_fc: dict[str, dict[str, dict]] = {}
    for row in read_rows(OPS_FORECAST):
        day = row["date"][:10]
        if row["group"] == "direction":
            direction_rows.setdefault((day, row["terminal"]), []).append(row)
        else:
            landside_fc.setdefault(day, {})[row["key"]] = row

    # Arrivals and departures per market, reconciled so that both directions of
    # every market add up to the terminal forecast of the same model.
    for (day, terminal), rows in direction_rows.items():
        totals = days[day][terminal]
        univ_sum = sum(float(r["univariate"]) for r in rows)
        cov_sum = sum(float(r["joint_with_covariates"]) for r in rows)
        markets = days[day].setdefault("markets", {}).setdefault(terminal, {})
        for r in rows:
            values = forecast_values(r)
            univ, cov = float(r["univariate"]), float(r["joint_with_covariates"])
            values["plan"] = {
                "hist": round(totals["univariate"] * univ / univ_sum),
                "tfm": round(totals["joint_with_covariates"] * cov / cov_sum),
                "p90": round(totals["q90"] * cov / cov_sum),
            }
            entry = markets.setdefault(r["market"], {})
            entry[r["key"]] = values
            source = shares[(day, terminal, r["market"])]
            entry["transferShare"] = float(source["transfer_share"])
            entry["residentShare"] = float(source["resident_share"])
            entry["eventDirection"] = int(source["event_direction"])

    for row in read_rows(LANDSIDE):
        day = row["date"][:10]
        if day not in days:
            continue
        fc = landside_fc.get(day, {})

        def with_plan(key: str) -> dict:
            values = forecast_values(fc[key])
            values["plan"] = {"hist": values["univariate"], "tfm": values["joint_with_covariates"], "p90": values["q90"]}
            return values

        num = lambda key: int(float(row[key]))
        days[day]["landside"] = {
            "taxi": {t: with_plan(f"taxi_pickups_{t}") for t in ("t1", "t2")},
            "bus": {t: with_plan(f"bus_pax_{t}") for t in ("t1", "t2")},
            "hbEntries": with_plan("hb_entries"),
            "hbOcc": with_plan("hb_occ_start"),
            "taxiDropoffs": {t: num(f"taxi_dropoffs_{t}") for t in ("t1", "t2")},
            "dropoffCars": {t: num(f"dropoff_cars_{t}") for t in ("t1", "t2")},
            "rentalParties": {t: num(f"rental_parties_{t}") for t in ("t1", "t2")},
            "carparks": {
                key: {
                    "cap": cap,
                    "occ0": num(f"{key}_occ_start"),
                    "entries": num(f"{key}_entries"),
                    "exits": num(f"{key}_exits"),
                    "turnedAway": num(f"{key}_turned_away"),
                }
                for key, cap in CAR_PARK_CAPACITY.items()
            },
        }
        days[day]["staff"] = {shift: num(f"staff_{shift}") for shift in ("early", "mid", "late", "night")}


if __name__ == "__main__":
    main()
