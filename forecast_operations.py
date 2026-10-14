"""Operations forecast: travel direction, ground transport and car parks.

forecast_markets.py splits each terminal's daily passengers into destination
markets. This script adds the rest of the airport's operating picture for
the passenger-flow demo, all on the same synthetic series:

  Direction    each market's passengers split into departures and arrivals.
               The departing share starts at one half and moves with the
               weekday, school-holiday edges and events that are inbound or
               outbound (a summit brings people in on day one and takes them
               home on day two). A calendar covariate, event_direction, says
               which way an event pushes; it is known in advance.
  Landside     how people get to and from the airport: taxi pickups and
               drop-offs, bus and coach passengers, kerb drop-offs, car
               hire, and cars entering the short-term and long-term car parks.
               Shares depend on the passenger mix and on whether the market
               is mostly residents or visitors.
  Car parks    Holiday Blue (long stay) and the short-term car parks carry
               cars from one day to the next. Each day starts with the cars
               still parked from earlier trips, set by trip-length
               distributions (business trips are short, family holidays long).
  Staff        people starting each shift, scaled with the day's traffic.

Everything here is invented, like the series it builds on. TimesFM 3 is then
called on the March 2026 holdout, history only and jointly with covariates:

  directions   per terminal: arrivals and departures for every market
  landside     taxi pickups per terminal, bus passengers per terminal,
               Holiday Blue entries, Holiday Blue occupancy at the start of
               the day

    python forecast_operations.py              # data and forecast
    python forecast_operations.py --data-only  # data only, no model
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import pandas as pd

from forecast_dublin_airport import (
    HORIZON_DAYS,
    ROOT,
    SEED,
    build_dataset,
    forecast_multivariate,
    forecast_univariate,
    load_forecaster,
)
from forecast_markets import MARKETS, PERSONAS, TERMINAL_MARKETS, build_market_dataset, school_holiday
from real_data import daily_interp, market_targets

# --- Direction -------------------------------------------------------------
# Day one of these events is inbound (fewer departures), day two outbound.
TWO_WAY_EVENTS = {
    "Atlantic Aviation Summit": (-0.06, +0.06),
    "Conference wave": (-0.06, +0.06),
    "Match-day charter": (+0.08, -0.08),
}
INBOUND_EVENTS = {"Tour-group arrival": ("na", "long", -0.08)}
DEP_SHARE_BOUNDS = (0.42, 0.58)

# Share of arriving passengers who connect to another flight without leaving
# the airside, by terminal and arriving market.
TRANSFER_SHARE = {
    "t1": {"uk": 0.01, "eu_city": 0.02, "eu_sun": 0.005},
    "t2": {"uk": 0.03, "eu_city": 0.04, "na": 0.14, "long": 0.06},
}
RESIDENT_SHARE = {"uk": 0.55, "eu_city": 0.50, "eu_sun": 0.85, "na": 0.35, "long": 0.50}

# --- Ground access ---------------------------------------------------------
MODES = ("met", "taxi", "bus", "short_term", "holiday_blue", "rental")
# Probability of each mode for a resident party, by passenger type. "met"
# means met by car on arrival and dropped off on departure.
MODE_SHARE = {
    "business": {"met": 0.12, "taxi": 0.45, "bus": 0.12, "short_term": 0.15, "holiday_blue": 0.06, "rental": 0.10},
    "leisure": {"met": 0.28, "taxi": 0.18, "bus": 0.28, "short_term": 0.04, "holiday_blue": 0.12, "rental": 0.10},
    "family": {"met": 0.42, "taxi": 0.12, "bus": 0.08, "short_term": 0.03, "holiday_blue": 0.22, "rental": 0.13},
    "group": {"met": 0.10, "taxi": 0.10, "bus": 0.70, "short_term": 0.0, "holiday_blue": 0.0, "rental": 0.10},
    "prm": {"met": 0.50, "taxi": 0.35, "bus": 0.05, "short_term": 0.05, "holiday_blue": 0.05, "rental": 0.0},
}
PARTY_SIZE = {"business": 1.0, "leisure": 1.35, "family": 4.0, "group": 6.0, "prm": 1.6}
# Mean trip length in days for people who leave a car at the airport.
TRIP_DAYS = {"business": 2.5, "leisure": 7.0, "family": 9.0, "group": 4.0, "prm": 7.0}
CAR_PARKS = {
    "hb": {"name": "Holiday Blue", "cap": 12000},
    "st_t1": {"name": "T1 Short Term", "cap": 3000},
    "st_t2": {"name": "T2 Short Term", "cap": 2600},
}
STAFF_BASE = {"early": 1700, "mid": 1300, "late": 1450, "night": 280}


def mode_split(persona: str, resident: float) -> dict:
    """Mode shares for a party mixing residents and visitors.

    Visitors have no car at the airport, so their parking share moves to car
    hire (60%) and taxi (40%).
    """
    base = MODE_SHARE[persona]
    car = base["short_term"] + base["holiday_blue"]
    visitor = dict(base, short_term=0.0, holiday_blue=0.0)
    visitor["rental"] += 0.6 * car
    visitor["taxi"] += 0.4 * car
    return {m: resident * base[m] + (1 - resident) * visitor[m] for m in MODES}


def trip_pmf(mean_days: float, max_days: int = 40) -> np.ndarray:
    """Discrete lognormal trip length (whole days, at least one)."""
    sigma = 0.55
    mu = np.log(mean_days) - sigma**2 / 2
    days = np.arange(1, max_days + 1)
    edges = np.log(np.concatenate([[0.5], days + 0.5]))
    from math import erf, sqrt

    cdf = np.array([0.5 * (1 + erf((e - mu) / (sigma * sqrt(2)))) for e in edges])
    pmf = np.diff(cdf)
    return pmf / pmf.sum()


def ar_noise(rng: np.random.Generator, n: int, sd: float, phi: float = 0.6) -> np.ndarray:
    out = np.zeros(n)
    shocks = rng.normal(0.0, sd, size=n)
    for t in range(1, n):
        out[t] = phi * out[t - 1] + shocks[t]
    return out


def event_direction_series(frame: pd.DataFrame) -> np.ndarray:
    """-1 inbound, +1 outbound, 0 neither. Known in advance from the calendar."""
    names = frame["event_name"].fillna("").to_numpy()
    dates = frame["date"].dt.date.to_numpy()
    direction = np.zeros(len(frame))
    for t, name in enumerate(names):
        if name in TWO_WAY_EVENTS:
            first = t == 0 or names[t - 1] != name
            direction[t] = np.sign(TWO_WAY_EVENTS[name][0 if first else 1])
        elif name in INBOUND_EVENTS:
            direction[t] = -1
        elif name == "Christmas getaway":
            direction[t] = -1
    for t, day in enumerate(dates):
        if (day.month, day.day) in ((3, 15), (3, 16)):
            direction[t] = -1
        elif (day.month, day.day) == (3, 18):
            direction[t] = 1
    return direction


def build_direction_dataset(frame: pd.DataFrame, markets: pd.DataFrame, seed: int = SEED) -> pd.DataFrame:
    rng = np.random.default_rng(seed + 202)
    dates = frame["date"].dt.date.to_numpy()
    dow = frame["date"].dt.dayofweek.to_numpy()
    names = frame["event_name"].fillna("").to_numpy()
    holiday = np.array([school_holiday(d) for d in dates])
    # first and last three days of each school break
    first3 = np.zeros(len(dates), bool)
    last3 = np.zeros(len(dates), bool)
    for t in range(len(dates)):
        if holiday[t]:
            first3[t] = not all(holiday[max(0, t - 3):t]) if t >= 3 else True
            last3[t] = not all(holiday[t + 1:t + 4]) if t + 4 <= len(dates) else False
    direction = event_direction_series(frame)
    targets = market_targets()
    real_dep = {m: daily_interp(pd.DatetimeIndex(frame["date"]), targets[f"dep_share_{m}"]) for m in MARKETS}

    rows = []
    for terminal, names_m in TERMINAL_MARKETS.items():
        sub = markets[markets["terminal"] == terminal]
        for market in names_m:
            part = sub[sub["market"] == market].reset_index(drop=True)
            # Baseline from the CSO's monthly departing share for this market.
            share = real_dep[market] + ar_noise(rng, len(part), 0.01, 0.5)
            leisure_market = market in ("eu_sun", "uk")
            share += np.where((dow == 4) & leisure_market, 0.03, 0.0)
            share += np.where(dow == 6, -0.03, 0.0)
            share += np.where(first3, 0.04, 0.0) + np.where(last3, -0.04, 0.0)
            for t, name in enumerate(names):
                if name in TWO_WAY_EVENTS:
                    first = t == 0 or names[t - 1] != name
                    share[t] += TWO_WAY_EVENTS[name][0 if first else 1]
                elif name in INBOUND_EVENTS and market in INBOUND_EVENTS[name][:2]:
                    share[t] += INBOUND_EVENTS[name][2]
                elif name == "Christmas getaway":
                    share[t] += -0.06 if market in ("uk", "na", "long") else 0.04
                day = dates[t]
                if (day.month, day.day) in ((3, 15), (3, 16)) and market in ("uk", "na"):
                    share[t] -= 0.05
                elif (day.month, day.day) == (3, 18) and market in ("uk", "na"):
                    share[t] += 0.05
            share = np.clip(share, *DEP_SHARE_BOUNDS)
            pax = part["passengers"].to_numpy()
            dep = np.rint(pax * share).astype(np.int64)
            arr = pax - dep
            for t in range(len(part)):
                rows.append(
                    {
                        "date": part["date"].iloc[t],
                        "terminal": terminal,
                        "market": market,
                        "passengers": int(pax[t]),
                        "dep_pax": int(dep[t]),
                        "arr_pax": int(arr[t]),
                        "dep_share": round(float(dep[t] / max(1, pax[t])), 4),
                        "transfer_share": TRANSFER_SHARE[terminal][market],
                        "resident_share": RESIDENT_SHARE[market],
                        "event_direction": int(direction[t]),
                        "school_holiday": int(holiday[t]),
                        "dep_movements": int(np.ceil(part["scheduled_movements"].iloc[t] / 2)),
                        "arr_movements": int(part["scheduled_movements"].iloc[t] // 2),
                    }
                )
    out = pd.DataFrame(rows)
    assert (out["dep_pax"] + out["arr_pax"] == out["passengers"]).all()
    assert out["dep_share"].between(0.40, 0.60).all()
    return out


def build_landside_dataset(frame: pd.DataFrame, markets: pd.DataFrame, directions: pd.DataFrame, seed: int = SEED) -> pd.DataFrame:
    """Daily ground-access series and car-park stocks."""
    rng = np.random.default_rng(seed + 303)
    n = len(frame)
    merged = directions.merge(
        markets[["date", "terminal", "market"] + [f"mix_{p}" for p in PERSONAS]],
        on=["date", "terminal", "market"],
    )
    series = {k: np.zeros(n) for k in (
        "taxi_pickups_t1", "taxi_pickups_t2", "taxi_dropoffs_t1", "taxi_dropoffs_t2",
        "bus_pax_t1", "bus_pax_t2", "dropoff_cars_t1", "dropoff_cars_t2", "rental_parties_t1", "rental_parties_t2",
        "st_entries_t1", "st_entries_t2", "hb_entries",
    )}
    hb_by_persona = {p: np.zeros(n) for p in PERSONAS}
    st_by_persona = {t: {p: np.zeros(n) for p in PERSONAS} for t in ("t1", "t2")}
    date_index = {d: i for i, d in enumerate(frame["date"])}
    for row in merged.itertuples(index=False):
        t = date_index[row.date]
        term = row.terminal
        for persona in PERSONAS:
            share = getattr(row, f"mix_{persona}")
            split = mode_split(persona, row.resident_share)
            size = PARTY_SIZE[persona]
            # Transfers never touch the landside.
            arr = row.arr_pax * (1 - row.transfer_share) * share
            dep = row.dep_pax * (1 - row.transfer_share) * share
            series[f"taxi_pickups_{term}"][t] += arr * split["taxi"] / size
            series[f"taxi_dropoffs_{term}"][t] += dep * split["taxi"] / size
            series[f"bus_pax_{term}"][t] += (arr + dep) * split["bus"]
            series[f"dropoff_cars_{term}"][t] += dep * split["met"] / size
            series[f"rental_parties_{term}"][t] += arr * split["rental"] / size
            series[f"st_entries_{term}"][t] += dep * split["short_term"] / size
            st_by_persona[term][persona][t] += dep * split["short_term"] / size
            series["hb_entries"][t] += dep * split["holiday_blue"] / size
            hb_by_persona[persona][t] += dep * split["holiday_blue"] / size
    # Rain moves people from buses and walking to taxis (about +6% taxi trips
    # on wet days in the New York studies cited in the README).
    wet = (frame["rain_mm"].to_numpy() >= 5.0) if "rain_mm" in frame else np.zeros(n, bool)
    for key in series:
        series[key] = np.maximum(0, np.rint(series[key] * np.exp(ar_noise(rng, n, 0.03))))
        if key.startswith("taxi_pickups"):
            series[key] = np.rint(series[key] * np.where(wet, 1.06, 1.0))
        elif key.startswith("bus_pax"):
            series[key] = np.rint(series[key] * np.where(wet, 0.97, 1.0))

    def stock(entries_by_persona: dict, cap: int, trip_scale: float = 1.0) -> tuple[np.ndarray, ...]:
        pmfs = {p: trip_pmf(max(1.2, TRIP_DAYS[p] * trip_scale)) for p in PERSONAS}
        total = sum(entries_by_persona.values())
        weights = {p: np.where(total > 0, entries_by_persona[p] / np.maximum(total, 1e-9), 0) for p in PERSONAS}
        entries = np.rint(total * np.exp(ar_noise(rng, n, 0.03)))
        occ_start = np.zeros(n)
        exits = np.zeros(n)
        turned = np.zeros(n)
        effective = np.zeros(n)
        due = np.zeros(n + 60)  # cars due to leave on each future day
        occ = 0.0
        for t in range(n):
            occ_start[t] = occ
            exits[t] = due[t]
            room = cap - (occ - exits[t])
            effective[t] = min(entries[t], max(0.0, room))
            turned[t] = entries[t] - effective[t]
            for p in PERSONAS:
                pmf = pmfs[p]
                due[t + 1:t + 1 + len(pmf)] += effective[t] * weights[p][t] * pmf
            occ = occ - exits[t] + effective[t]
        return np.rint(occ_start), np.rint(effective), np.rint(exits), np.rint(turned)

    hb = stock(hb_by_persona, CAR_PARKS["hb"]["cap"])
    # Short-term parking costs more per day, so the trips parked there are shorter.
    st1 = stock(st_by_persona["t1"], CAR_PARKS["st_t1"]["cap"], trip_scale=0.4)
    st2 = stock(st_by_persona["t2"], CAR_PARKS["st_t2"]["cap"], trip_scale=0.4)

    total = frame["terminal_1_passengers"].to_numpy() + frame["terminal_2_passengers"].to_numpy()
    scale = total / total.mean()
    raw_entries = ("hb_entries", "st_entries_t1", "st_entries_t2")
    out = pd.DataFrame({"date": frame["date"], **{k: v.astype(np.int64) for k, v in series.items() if k not in raw_entries}})
    for key, (occ_start, entries, exits, turned) in (("hb", hb), ("st_t1", st1), ("st_t2", st2)):
        out[f"{key}_occ_start"] = occ_start.astype(np.int64)
        out[f"{key}_entries"] = entries.astype(np.int64)
        out[f"{key}_exits"] = exits.astype(np.int64)
        out[f"{key}_turned_away"] = turned.astype(np.int64)
    for shift, base in STAFF_BASE.items():
        out[f"staff_{shift}"] = np.rint(base * (0.6 + 0.4 * scale)).astype(np.int64)
    numeric = out.drop(columns=["date"])
    assert (numeric >= 0).all().all()
    for key, spec in CAR_PARKS.items():
        assert (out[f"{key}_occ_start"] <= spec["cap"]).all()
    return out


def landside_targets(landside: pd.DataFrame) -> dict[str, np.ndarray]:
    keys = ("taxi_pickups_t1", "taxi_pickups_t2", "bus_pax_t1", "bus_pax_t2", "hb_entries", "hb_occ_start")
    return {k: landside[k].to_numpy(np.float32) for k in keys}


def run_operations_forecasts(frame, directions, landside, forecaster) -> pd.DataFrame:
    context_len = len(frame) - HORIZON_DAYS
    horizon_dates = frame["date"].iloc[context_len:].reset_index(drop=True)
    delay = frame["avg_departure_delay_min"].to_numpy(np.float32)[:context_len][None, :]
    events = frame["event_intensity"].to_numpy(np.float32)
    rows = []

    def emit(group, key, terminal, market, series, univ, point, quant):
        for step in range(HORIZON_DAYS):
            rows.append(
                {
                    "date": horizon_dates.iloc[step], "group": group, "key": key,
                    "terminal": terminal, "market": market,
                    "actual": float(series[context_len + step]),
                    "univariate": float(univ[step]),
                    "joint_with_covariates": float(point[step]),
                    "q10": float(quant[step, 0]), "q90": float(quant[step, 8]),
                }
            )

    for terminal, names in TERMINAL_MARKETS.items():
        sub = directions[directions["terminal"] == terminal]
        get = lambda m, col: sub.loc[sub["market"] == m, col].to_numpy(np.float32)
        keys, targets = [], []
        for m in names:
            for direction in ("arr", "dep"):
                keys.append((m, direction))
                targets.append(get(m, f"{direction}_pax"))
        targets = np.stack(targets)
        direction_cov = get(names[0], "event_direction")
        holiday_cov = get(names[0], "school_holiday")
        movements = np.stack([get(m, "dep_movements") + get(m, "arr_movements") for m in names])
        past_future = np.vstack([movements, events[None, :], direction_cov[None, :], holiday_cov[None, :]])
        print(f"{terminal.upper()} directions: targets {targets[:, :context_len].shape}, past-future {past_future.shape}")
        univ = [forecast_univariate(forecaster, s[:context_len], HORIZON_DAYS)[0] for s in targets]
        point, quant = forecast_multivariate(forecaster, targets[:, :context_len], HORIZON_DAYS, past_only=delay, past_future=past_future)
        for i, (m, direction) in enumerate(keys):
            emit("direction", direction, terminal, m, targets[i], univ[i], point[i], quant[i])

    tgt = landside_targets(landside)
    keys = list(tgt)
    targets = np.stack([tgt[k] for k in keys])
    direction_cov = event_direction_series(frame).astype(np.float32)
    holiday_cov = np.array([school_holiday(d) for d in frame["date"].dt.date], dtype=np.float32)
    movements = np.stack([
        frame["terminal_1_scheduled_movements"].to_numpy(np.float32),
        frame["terminal_2_scheduled_movements"].to_numpy(np.float32),
    ])
    past_future = np.vstack([movements, events[None, :], direction_cov[None, :], holiday_cov[None, :]])
    print(f"Landside: targets {targets[:, :context_len].shape}, past-future {past_future.shape}")
    univ = [forecast_univariate(forecaster, s[:context_len], HORIZON_DAYS)[0] for s in targets]
    point, quant = forecast_multivariate(forecaster, targets[:, :context_len], HORIZON_DAYS, past_only=delay, past_future=past_future)
    for i, key in enumerate(keys):
        emit("landside", key, "", "", targets[i], univ[i], point[i], quant[i])
    return pd.DataFrame(rows)


def score_operations(forecast: pd.DataFrame, frame: pd.DataFrame) -> pd.DataFrame:
    kinds = frame.set_index(frame["date"])["event_kind"].fillna("")
    forecast = forecast.assign(event=forecast["date"].map(kinds).ne(""))
    rows = []
    for (group, key, terminal, market), part_all in forecast.groupby(["group", "key", "terminal", "market"], sort=False):
        for label, mask in (("all_days", slice(None)), ("event_days", part_all["event"])):
            part = part_all.loc[mask]
            for model in ("univariate", "joint_with_covariates"):
                ape = (part[model] - part["actual"]).abs() / part["actual"].clip(lower=1)
                rows.append({"group": group, "key": key, "terminal": terminal, "market": market, "slice": label,
                             "model": model, "mape_pct": float(ape.mean() * 100), "n": len(part)})
    return pd.DataFrame(rows)


def print_operation_scores(scores: pd.DataFrame) -> None:
    print("\nMAPE on the March 2026 holdout (all days / event days):")
    wide = scores.pivot_table(index=["group", "key", "terminal", "market"], columns=["slice", "model"], values="mape_pct", sort=False)
    for (group, key, terminal, market), row in wide.iterrows():
        label = f"{terminal.upper()} {market} {key}" if group == "direction" else key
        print(
            f"  {label:<24} history only {row[('all_days', 'univariate')]:5.1f}% / {row[('event_days', 'univariate')]:5.1f}%   "
            f"with covariates {row[('all_days', 'joint_with_covariates')]:5.1f}% / {row[('event_days', 'joint_with_covariates')]:5.1f}%"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-only", action="store_true", help="Write the CSVs and stop before loading TimesFM.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = build_dataset()
    markets = build_market_dataset(frame)
    directions = build_direction_dataset(frame, markets)
    landside = build_landside_dataset(frame, markets, directions)
    data_dir = ROOT / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    directions.to_csv(data_dir / "dublin_airport_directions.csv", index=False)
    landside.to_csv(data_dir / "dublin_airport_landside.csv", index=False)
    print(f"Wrote {data_dir / 'dublin_airport_directions.csv'} ({len(directions):,} rows)")
    print(f"Wrote {data_dir / 'dublin_airport_landside.csv'} ({len(landside):,} rows)")
    if args.data_only:
        return

    forecaster, backend = load_forecaster()
    print(f"Backend: {backend}")
    forecast = run_operations_forecasts(frame, directions, landside, forecaster)
    scores = score_operations(forecast, frame)
    print_operation_scores(scores)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    forecast.to_csv(args.output_dir / "ops_forecast.csv", index=False)
    scores.to_csv(args.output_dir / "ops_metrics.csv", index=False)
    print(f"Wrote {args.output_dir / 'ops_forecast.csv'}")
    print(f"Wrote {args.output_dir / 'ops_metrics.csv'}")


if __name__ == "__main__":
    main()
