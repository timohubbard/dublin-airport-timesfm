"""Destination-market forecast for the synthetic Dublin Airport series.

forecast_dublin_airport.py forecasts passengers per terminal. This script
splits each terminal into destination markets and forecasts the markets with
TimesFM 3, so the passenger-flow demo can build flights with destinations,
aircraft and passenger types.

  Terminal 1   United Kingdom, Europe city & business, Europe sun & leisure
  Terminal 2   United Kingdom, Europe city & business, North America
               (US preclearance), Middle East & long-haul

The split is invented, like the terminal series it divides. Market shares
move with the season, the weekday, school holidays and the event calendar,
and the market totals add up exactly to the terminal totals. Each market also
gets a passenger mix (business, leisure, family, group, reduced mobility).
The mix is a calendar rule known in advance, not a forecast.

TimesFM is called twice per terminal on the March 2026 holdout:

  univariate             each market from its own history
  joint with covariates  all markets of the terminal together, with the
                         market flight schedules and the event flag as
                         past-and-future covariates and departure delay as a
                         past-only covariate

Run forecast_dublin_airport.py first if you want the terminal forecast too;
this script rebuilds the same terminal series from the same seed.

    python forecast_markets.py              # data and forecast
    python forecast_markets.py --data-only  # data only, no model
"""

from __future__ import annotations

import argparse
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

from forecast_dublin_airport import (
    HORIZON_DAYS,
    ROOT,
    SEED,
    build_dataset,
    easter_sunday,
    forecast_multivariate,
    forecast_univariate,
    load_forecaster,
)

MARKETS = {
    "uk": "United Kingdom",
    "eu_city": "Europe – city & business",
    "eu_sun": "Europe – sun & leisure",
    "na": "North America",
    "long": "Middle East & long-haul",
}
TERMINAL_MARKETS = {
    "t1": ("uk", "eu_city", "eu_sun"),
    "t2": ("uk", "eu_city", "na", "long"),
}
TERMINAL_COLUMNS = {
    "t1": ("terminal_1_passengers", "terminal_1_scheduled_movements"),
    "t2": ("terminal_2_passengers", "terminal_2_scheduled_movements"),
}
BASE_SHARE = {
    "t1": {"uk": 0.30, "eu_city": 0.34, "eu_sun": 0.36},
    "t2": {"uk": 0.22, "eu_city": 0.30, "na": 0.36, "long": 0.12},
}
# Seats per movement relative to a single-aisle jet. Long-haul markets carry
# more passengers per flight, so they take a smaller share of movements.
SEAT_FACTOR = {"uk": 1.0, "eu_city": 1.0, "eu_sun": 1.05, "na": 1.55, "long": 1.75}
# Annual swing in log-share, peaking in mid July.
SEASONAL_AMPLITUDE = {"uk": -0.06, "eu_city": -0.04, "eu_sun": 0.30, "na": 0.35, "long": 0.05}
# Event names from forecast_dublin_airport.py and the market each one lifts.
EVENT_LIFT = {
    "Atlantic Aviation Summit": {"eu_city": 0.35, "uk": 0.20, "na": 0.15},
    "European route launch": {"eu_city": 0.45},
    "Conference wave": {"eu_city": 0.30, "uk": 0.15},
    "Cruise turnaround": {"eu_sun": 0.25, "na": 0.15},
    "Match-day charter": {"uk": 0.35},
    "Tour-group arrival": {"na": 0.25, "long": 0.10},
    "St Patrick's Day": {"uk": 0.15, "na": 0.12},
    "Christmas getaway": {"uk": 0.25, "long": 0.30, "eu_sun": 0.10},
    "Easter Sunday": {"eu_sun": 0.25},
    "Easter Monday": {"eu_sun": 0.15},
}

PERSONAS = ("business", "leisure", "family", "group", "prm")
BASE_MIX = {
    "uk": {"business": 0.22, "family": 0.11, "group": 0.08},
    "eu_city": {"business": 0.24, "family": 0.10, "group": 0.07},
    "eu_sun": {"business": 0.05, "family": 0.34, "group": 0.12},
    "na": {"business": 0.13, "family": 0.22, "group": 0.05},
    "long": {"business": 0.12, "family": 0.20, "group": 0.03},
}
PRM_SHARE = 0.012


def school_holiday(day: date) -> bool:
    """Irish school breaks, approximately: Easter fortnight, summer, mid-terms, Christmas."""
    easter = easter_sunday(day.year)
    if easter - timedelta(days=9) <= day <= easter + timedelta(days=7):
        return True
    if date(day.year, 6, 28) <= day <= date(day.year, 8, 31):
        return True
    if day.month == 10 and day.day >= 26 or day.month == 11 and day.day <= 2:
        return True
    if day.month == 2 and 12 <= day.day <= 18:
        return True
    return (day.month == 12 and day.day >= 21) or (day.month == 1 and day.day <= 5)


def build_market_dataset(frame: pd.DataFrame, seed: int = SEED) -> pd.DataFrame:
    """Long table: one row per date, terminal and market."""
    rng = np.random.default_rng(seed + 101)
    dates = frame["date"].dt.date.to_numpy()
    n = len(frame)
    doy = frame["date"].dt.dayofyear.to_numpy()
    dow = frame["date"].dt.dayofweek.to_numpy()
    season = np.sin(2 * np.pi * (doy - 105) / 365.25)
    holiday = np.array([school_holiday(d) for d in dates])
    weekend = np.isin(dow, (4, 5, 6))
    weekday = np.isin(dow, (0, 1, 2, 3))
    events = frame["event_name"].fillna("").to_numpy()

    rows = []
    for terminal, markets in TERMINAL_MARKETS.items():
        pax_col, mov_col = TERMINAL_COLUMNS[terminal]
        total_pax = frame[pax_col].to_numpy()
        total_mov = frame[mov_col].to_numpy()
        log_w = np.zeros((len(markets), n))
        for i, market in enumerate(markets):
            noise = np.zeros(n)
            shocks = rng.normal(0.0, 0.025, size=n)
            for t in range(1, n):
                noise[t] = 0.7 * noise[t - 1] + shocks[t]
            log_w[i] = np.log(BASE_SHARE[terminal][market]) + SEASONAL_AMPLITUDE[market] * season + noise
            if market == "eu_sun":
                log_w[i] += 0.12 * weekend + 0.15 * holiday
            if market in ("uk", "eu_city"):
                log_w[i] += 0.09 * weekday
            if market in ("na", "long"):
                log_w[i] += 0.06 * holiday
            for t, name in enumerate(events):
                log_w[i, t] += EVENT_LIFT.get(name, {}).get(market, 0.0)
        share = np.exp(log_w)
        share /= share.sum(axis=0, keepdims=True)

        pax = np.floor(share * total_pax).astype(np.int64)
        pax[-1] += total_pax - pax.sum(axis=0)
        seats = np.array([SEAT_FACTOR[m] for m in markets])[:, None]
        mov_share = (share / seats) / (share / seats).sum(axis=0, keepdims=True)
        movements = np.maximum(1, np.rint(mov_share * total_mov)).astype(np.int64)

        for i, market in enumerate(markets):
            mix = persona_mix(market, weekend, holiday, events)
            for t in range(n):
                rows.append(
                    {
                        "date": frame["date"].iloc[t],
                        "terminal": terminal,
                        "market": market,
                        "passengers": int(pax[i, t]),
                        "scheduled_movements": int(movements[i, t]),
                        **{f"mix_{p}": round(float(mix[p][t]), 4) for p in PERSONAS},
                    }
                )
    return pd.DataFrame(rows)


def persona_mix(market: str, weekend: np.ndarray, holiday: np.ndarray, events: np.ndarray) -> dict:
    base = BASE_MIX[market]
    business = np.full(len(weekend), base["business"])
    family = np.full(len(weekend), base["family"])
    group = np.full(len(weekend), base["group"])
    business = business * np.where(weekend, 0.55, 1.0) * np.where(holiday, 0.7, 1.0)
    family = family * np.where(weekend, 1.25, 1.0) * np.where(holiday, 1.5, 1.0)
    for t, name in enumerate(events):
        if name in ("Atlantic Aviation Summit", "Conference wave"):
            business[t] *= 1.5
        elif name in ("St Patrick's Day", "Match-day charter"):
            group[t] *= 2.2
        elif name == "Tour-group arrival":
            group[t] *= 1.8
        elif name == "Christmas getaway":
            family[t] *= 1.4
            business[t] *= 0.5
    prm = np.full(len(weekend), PRM_SHARE)
    leisure = np.clip(1.0 - business - family - group - prm, 0.08, None)
    total = business + family + group + prm + leisure
    return {
        "business": business / total,
        "leisure": leisure / total,
        "family": family / total,
        "group": group / total,
        "prm": prm / total,
    }


def run_market_forecasts(frame: pd.DataFrame, markets: pd.DataFrame, forecaster) -> pd.DataFrame:
    context_len = len(frame) - HORIZON_DAYS
    horizon_dates = frame["date"].iloc[context_len:].reset_index(drop=True)
    delay = frame["avg_departure_delay_min"].to_numpy(np.float32)[:context_len][None, :]
    events = frame["event_intensity"].to_numpy(np.float32)
    rows = []
    for terminal, names in TERMINAL_MARKETS.items():
        sub = markets[markets["terminal"] == terminal]
        pax = np.stack([sub.loc[sub["market"] == m, "passengers"].to_numpy(np.float32) for m in names])
        mov = np.stack([sub.loc[sub["market"] == m, "scheduled_movements"].to_numpy(np.float32) for m in names])
        past_future = np.vstack([mov, events[None, :]])
        print(
            f"{terminal.upper()} markets: targets {pax[:, :context_len].shape}, "
            f"past-only delay {delay.shape}, past-future schedules and events {past_future.shape}"
        )
        univariate = [forecast_univariate(forecaster, series[:context_len], HORIZON_DAYS)[0] for series in pax]
        point, quantiles = forecast_multivariate(
            forecaster, pax[:, :context_len], HORIZON_DAYS, past_only=delay, past_future=past_future
        )
        for i, market in enumerate(names):
            for step in range(HORIZON_DAYS):
                rows.append(
                    {
                        "date": horizon_dates.iloc[step],
                        "terminal": terminal,
                        "market": market,
                        "actual": float(pax[i, context_len + step]),
                        "univariate": float(univariate[i][step]),
                        "joint_with_covariates": float(point[i][step]),
                        "q10": float(quantiles[i][step, 0]),
                        "q90": float(quantiles[i][step, 8]),
                    }
                )
    return pd.DataFrame(rows)


def score_markets(forecast: pd.DataFrame, frame: pd.DataFrame) -> pd.DataFrame:
    kinds = frame.set_index(frame["date"])["event_kind"].fillna("")
    forecast = forecast.assign(event=forecast["date"].map(kinds).ne(""))
    rows = []
    for (terminal, market), group in forecast.groupby(["terminal", "market"], sort=False):
        for label, mask in (("all_days", slice(None)), ("event_days", group["event"])):
            part = group.loc[mask]
            for model in ("univariate", "joint_with_covariates"):
                ape = (part[model] - part["actual"]).abs() / part["actual"]
                rows.append(
                    {"terminal": terminal, "market": market, "slice": label, "model": model,
                     "mape_pct": float(ape.mean() * 100), "n": len(part)}
                )
    return pd.DataFrame(rows)


def print_market_scores(scores: pd.DataFrame) -> None:
    print("\nMarket MAPE on the March 2026 holdout (all days / event days):")
    wide = scores.pivot_table(index=["terminal", "market"], columns=["slice", "model"], values="mape_pct", sort=False)
    for (terminal, market), row in wide.iterrows():
        print(
            f"  {terminal.upper()} {MARKETS[market]:<26}"
            f"history only {row[('all_days', 'univariate')]:5.1f}% / {row[('event_days', 'univariate')]:5.1f}%   "
            f"with covariates {row[('all_days', 'joint_with_covariates')]:5.1f}% / "
            f"{row[('event_days', 'joint_with_covariates')]:5.1f}%"
        )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-only", action="store_true", help="Write the market CSV and stop before loading TimesFM.")
    parser.add_argument("--data-path", type=Path, default=ROOT / "data" / "dublin_airport_markets.csv")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = build_dataset()
    markets = build_market_dataset(frame)
    args.data_path.parent.mkdir(parents=True, exist_ok=True)
    markets.to_csv(args.data_path, index=False)
    print(f"Wrote {args.data_path} ({len(markets):,} rows)")
    if args.data_only:
        return

    forecaster, backend = load_forecaster()
    print(f"Backend: {backend}")
    forecast = run_market_forecasts(frame, markets, forecaster)
    scores = score_markets(forecast, frame)
    print_market_scores(scores)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    forecast.to_csv(args.output_dir / "market_forecast.csv", index=False)
    scores.to_csv(args.output_dir / "market_metrics.csv", index=False)
    print(f"Wrote {args.output_dir / 'market_forecast.csv'}")
    print(f"Wrote {args.output_dir / 'market_metrics.csv'}")


if __name__ == "__main__":
    main()
