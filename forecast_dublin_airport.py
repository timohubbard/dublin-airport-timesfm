"""Zero-shot TimesFM 3 forecast for a synthetic Dublin Airport.

The series is invented. It is shaped like Dublin Airport (two terminals, a
summer peak, a weekly wave) so the forecast has something recognizable to
look at. Nothing here is an official Dublin Airport passenger or movement
figure.

TimesFM 3 reads three kinds of input, matching the roles in
https://research.google/blog/timesfm-3-a-zero-shot-foundation-model-for-multivariate-forecasting/

  targets          Terminal 1 and Terminal 2 daily passengers, jointly.
                   Only the history is passed in. Both are forecast together.
  past-only        Average departure delay. Known after the day, so the
                   horizon is withheld. A fog day in the forecast window is
                   the test of that: the truth dips, and the model cannot
                   see the delay that caused it.
  past-and-future  Published schedule (movements by terminal) and a 0/1
                   event flag. Both are known for the history and for the
                   next 28 days. Irregular event days in the horizon are not
                   a repeat of the same calendar date in earlier years, so a
                   history-only forecast has no seasonal cue for them.

The script fits nothing. It loads the public TimesFM 3 checkpoint and calls
it three ways on the same holdout: each terminal alone, both terminals
jointly, and both terminals jointly with the covariates above.
"""

from __future__ import annotations

import argparse
import inspect
import os
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))

import matplotlib

matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch
import numpy as np
import pandas as pd

CHECKPOINT = "google/timesfm-3.0-pytorch"
HISTORY_START = date(2023, 1, 1)
CONTEXT_END = date(2026, 2, 28)
HORIZON_DAYS = 28
SEED = 7
QUANTILE_LEVELS = (0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9)

# Reserved month-days are placed only in the March 2026 horizon, so a
# univariate model cannot copy them from the same date in 2023-2025.
HORIZON_IRREGULAR = (
    (date(2026, 3, 4), date(2026, 3, 5), "Atlantic Aviation Summit"),
    (date(2026, 3, 24), date(2026, 3, 25), "European route launch"),
)
FOG_DAY = date(2026, 3, 11)
RESERVED_MONTH_DAYS = {(3, 4), (3, 5), (3, 11), (3, 24), (3, 25)}

T1_BASE_MOVEMENTS = 345.0
T2_BASE_MOVEMENTS = 255.0
T1_SEATS = 158.0
T2_SEATS = 198.0
T1_LOAD_FACTOR = 0.845
T2_LOAD_FACTOR = 0.830
# Monday=0 ... Sunday=6. Each row averages to 1.
T1_WEEKLY = np.array([0.96, 0.90, 0.92, 1.00, 1.14, 0.88, 1.20])
T2_WEEKLY = np.array([1.06, 0.94, 0.90, 1.12, 1.08, 0.84, 1.06])

TARGETS = ("terminal_1_passengers", "terminal_2_passengers")
TARGET_LABELS = {
    "terminal_1_passengers": "Terminal 1 passengers",
    "terminal_2_passengers": "Terminal 2 passengers",
}


def easter_sunday(year: int) -> date:
    """Gregorian Easter Sunday, Anonymous algorithm."""
    a = year % 19
    b = year // 100
    c = year % 100
    d = b // 4
    e = b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i = c // 4
    k = c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month = (h + l - 7 * m + 114) // 31
    day = ((h + l - 7 * m + 114) % 31) + 1
    return date(year, month, day)


def nth_weekday(year: int, month: int, weekday: int, n: int) -> date:
    first = date(year, month, 1)
    shift = (weekday - first.weekday()) % 7
    return first + timedelta(days=shift + 7 * (n - 1))


def last_weekday(year: int, month: int, weekday: int) -> date:
    if month == 12:
        cursor = date(year + 1, 1, 1) - timedelta(days=1)
    else:
        cursor = date(year, month + 1, 1) - timedelta(days=1)
    return cursor - timedelta(days=(cursor.weekday() - weekday) % 7)


def seasonal_events(year: int) -> list[tuple[date, str]]:
    """Dates whose passenger bump repeats every year."""
    easter = easter_sunday(year)
    marked = [
        (date(year, 3, 17), "St Patrick's Day"),
        (easter, "Easter Sunday"),
        (easter + timedelta(days=1), "Easter Monday"),
        (nth_weekday(year, 5, 0, 1), "May bank holiday"),
        (nth_weekday(year, 6, 0, 1), "June bank holiday"),
        (nth_weekday(year, 8, 0, 1), "August bank holiday"),
        (last_weekday(year, 10, 0), "October bank holiday"),
    ]
    for day in range(20, 24):
        marked.append((date(year, 12, day), "Christmas getaway"))
    return marked


def build_dataset(seed: int = SEED) -> pd.DataFrame:
    """Daily synthetic operations from HISTORY_START through the horizon."""
    assert easter_sunday(2023) == date(2023, 4, 9)
    assert easter_sunday(2024) == date(2024, 3, 31)
    assert easter_sunday(2025) == date(2025, 4, 20)
    assert easter_sunday(2026) == date(2026, 4, 5)

    horizon_end = CONTEXT_END + timedelta(days=HORIZON_DAYS)
    dates = pd.date_range(HISTORY_START, horizon_end, freq="D")
    date_objs = [d.date() for d in dates.to_pydatetime()]
    index = {d: i for i, d in enumerate(date_objs)}
    n = len(dates)
    rng = np.random.default_rng(seed)

    event_intensity = np.zeros(n, dtype=np.float64)
    event_name = np.array([""] * n, dtype=object)
    event_kind = np.array([""] * n, dtype=object)

    def mark(day: date, name: str, kind: str) -> None:
        position = index.get(day)
        if position is None or event_intensity[position] == 1.0:
            return
        event_intensity[position] = 1.0
        event_name[position] = name
        event_kind[position] = kind

    for year in range(HISTORY_START.year, horizon_end.year + 1):
        for day, name in seasonal_events(year):
            mark(day, name, "seasonal")

    irregular_names = (
        "Conference wave",
        "Cruise turnaround",
        "Match-day charter",
        "Tour-group arrival",
    )
    name_cursor = 0
    for year, quota in ((2023, 8), (2024, 8), (2025, 8), (2026, 3)):
        candidates = []
        for day in date_objs:
            if day.year != year or day.weekday() not in (1, 2):
                continue
            if year == 2026 and day >= date(2026, 3, 1):
                continue
            nxt = day + timedelta(days=1)
            if nxt not in index:
                continue
            if (day.month, day.day) in RESERVED_MONTH_DAYS:
                continue
            if (nxt.month, nxt.day) in RESERVED_MONTH_DAYS:
                continue
            if event_intensity[index[day]] or event_intensity[index[nxt]]:
                continue
            candidates.append(day)
        rng.shuffle(candidates)
        picked: list[date] = []
        for start in candidates:
            if any(abs((start - previous).days) < 14 for previous in picked):
                continue
            label = irregular_names[name_cursor % len(irregular_names)]
            name_cursor += 1
            mark(start, label, "irregular")
            mark(start + timedelta(days=1), label, "irregular")
            picked.append(start)
            if len(picked) == quota:
                break

    for start, end, label in HORIZON_IRREGULAR:
        day = start
        while day <= end:
            # These are the horizon spikes the history-only forecast should miss.
            position = index[day]
            event_intensity[position] = 1.0
            event_name[position] = label
            event_kind[position] = "irregular"
            day += timedelta(days=1)

    delay = rng.gamma(2.5, 5.0, size=n)
    quiet = np.flatnonzero(event_intensity == 0.0)
    n_disruptions = int(round(0.035 * n))
    disrupted = rng.choice(quiet, size=n_disruptions, replace=False)
    delay[disrupted] = rng.uniform(70.0, 110.0, size=n_disruptions)
    delay[index[FOG_DAY]] = 100.0
    disruption_name = np.array([""] * n, dtype=object)
    disruption_name[delay >= 70.0] = "Weather disruption"
    disruption_name[index[FOG_DAY]] = "Fog and flow restrictions"

    dow = dates.dayofweek.to_numpy()
    annual = 1.0 + 0.22 * np.sin(2 * np.pi * (dates.dayofyear.to_numpy() - 110) / 365.25)
    movement_multiplier = 1.0 + 0.18 * event_intensity
    t1_movements = T1_BASE_MOVEMENTS * T1_WEEKLY[dow] * annual * movement_multiplier
    t2_movements = T2_BASE_MOVEMENTS * T2_WEEKLY[dow] * annual * movement_multiplier
    delay_factor = 1.0 - np.clip((delay - 35.0) / 325.0, 0.0, 0.22)

    innovation = rng.normal(0.0, 0.012, size=n)
    shared = np.zeros(n)
    for i in range(1, n):
        shared[i] = 0.5 * shared[i - 1] + innovation[i]
    idiosyncratic = rng.normal(0.0, 0.008, size=(2, n))

    def passengers(movements: np.ndarray, seats: float, load_factor: float, shock: np.ndarray) -> np.ndarray:
        load = np.clip(load_factor + 0.10 * event_intensity + 0.03 * (annual - 1.0), 0.72, 0.97)
        volume = movements * seats * load * delay_factor * np.exp(shock)
        return np.rint(volume).astype(np.int64)

    frame = pd.DataFrame(
        {
            "date": dates,
            "terminal_1_passengers": passengers(
                t1_movements, T1_SEATS, T1_LOAD_FACTOR, shared + idiosyncratic[0]
            ),
            "terminal_2_passengers": passengers(
                t2_movements, T2_SEATS, T2_LOAD_FACTOR, shared + idiosyncratic[1]
            ),
            "terminal_1_scheduled_movements": np.rint(t1_movements).astype(np.int64),
            "terminal_2_scheduled_movements": np.rint(t2_movements).astype(np.int64),
            "event_intensity": event_intensity.astype(np.float32),
            "event_name": event_name,
            "event_kind": event_kind,
            "avg_departure_delay_min": np.round(delay, 1),
            "disruption_name": disruption_name,
        }
    )
    return frame


def print_data_summary(frame: pd.DataFrame) -> None:
    context = frame.iloc[:-HORIZON_DAYS]
    horizon = frame.iloc[-HORIZON_DAYS:]
    ordinary = context["event_kind"].eq("") & context["disruption_name"].eq("")
    print(
        f"Synthetic daily series, {frame['date'].iloc[0]:%d %b %Y} to "
        f"{frame['date'].iloc[-1]:%d %b %Y} ({len(frame)} days)"
    )
    print(
        f"Context through {CONTEXT_END:%d %b %Y} ({len(context)} days); "
        f"horizon {HORIZON_DAYS} days."
    )
    for column, label in TARGET_LABELS.items():
        print(f"  {label}: context mean {context[column].mean():,.0f} passengers/day")
        lifts = []
        for dow in range(7):
            baseline = context.loc[ordinary & context["date"].dt.dayofweek.eq(dow), column]
            irregular = context.loc[
                context["event_kind"].eq("irregular") & context["date"].dt.dayofweek.eq(dow),
                column,
            ]
            if len(baseline) and len(irregular):
                lifts.append(irregular.mean() / baseline.mean() - 1.0)
        print(f"    irregular event days vs same weekday: {np.mean(lifts):+.0%}")
    print("Horizon days the chart is built around:")
    interesting = horizon[horizon["event_name"].ne("") | horizon["disruption_name"].ne("")]
    for row in interesting.itertuples(index=False):
        note = row.event_name or row.disruption_name
        kind = row.event_kind or "past-only"
        total = row.terminal_1_passengers + row.terminal_2_passengers
        print(f"  {row.date:%d %b %Y}  {note} ({kind})  {total:,.0f} passengers")


def load_forecaster():
    """MLX on Apple silicon, PyTorch otherwise. Same checkpoint either way."""
    try:
        from timesfm3.mlx import TimesFM3Forecaster
    except ImportError:
        TimesFM3Forecaster = None
    if TimesFM3Forecaster is not None:
        print(f"Loading {CHECKPOINT} with the MLX backend...")
        return TimesFM3Forecaster.from_pretrained(CHECKPOINT), "mlx"

    import torch
    from timesfm3 import ModelConfig, TimesFM3Evaluator

    if torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    print(f"Loading {CHECKPOINT} with the PyTorch backend on {device}...")
    config = ModelConfig(
        checkpoint_path=CHECKPOINT,
        per_core_batch_size=4,
        device=device,
    )
    return TimesFM3Evaluator(config), "torch"


def _accepted(method, kwargs: dict) -> dict:
    parameters = inspect.signature(method).parameters
    if any(item.kind == inspect.Parameter.VAR_KEYWORD for item in parameters.values()):
        return kwargs
    return {key: value for key, value in kwargs.items() if key in parameters}


def _call(method, kwargs: dict):
    return method(**_accepted(method, kwargs))


def _point_and_quantiles(output, horizon: int, n_series: int) -> tuple[np.ndarray, np.ndarray]:
    point = np.asarray(output.forecast, dtype=np.float64)
    quantiles = np.asarray(output.quantiles, dtype=np.float64)
    if n_series == 1:
        point = np.reshape(point, (-1,))[:horizon]
        quantiles = np.reshape(quantiles, (-1, quantiles.shape[-1]))[:horizon]
        return point, quantiles
    if point.ndim == 1:
        raise RuntimeError(f"Expected a forecast per series, got shape {point.shape}")
    return point[:, :horizon], quantiles[:, :horizon, :]


def forecast_univariate(forecaster, series: np.ndarray, horizon: int):
    """One series, its own history only. This is the red line in the blog post."""
    kwargs = {
        "contexts": [np.asarray(series, dtype=np.float32)],
        "horizon": horizon,
        "return_quantiles": True,
        "use_symmetric_averaging": False,
        "make_positive": True,
    }
    outputs = list(_call(forecaster.predict_batch, kwargs))
    return _point_and_quantiles(outputs[0], horizon, n_series=1)


def forecast_multivariate(
    forecaster,
    targets: np.ndarray,
    horizon: int,
    past_only: np.ndarray | None = None,
    past_future: np.ndarray | None = None,
):
    """Joint forecast. targets is (series, context). Covariates are optional.

    predict() takes one multivariate array. predict_batch() takes a list of
    those arrays, so a single airport is a batch of length 1 — not two
    univariate series.
    """
    targets = np.asarray(targets, dtype=np.float32)
    kwargs = {
        "horizon": horizon,
        "return_quantiles": True,
        "use_symmetric_averaging": False,
        "make_positive": True,
    }
    if past_only is not None:
        kwargs["past_only_covariates"] = np.asarray(past_only, dtype=np.float32)
    if past_future is not None:
        kwargs["past_future_covariates"] = np.asarray(past_future, dtype=np.float32)

    if hasattr(forecaster, "predict"):
        output = forecaster.predict(targets, **_accepted(forecaster.predict, kwargs))
        return _point_and_quantiles(output, horizon, n_series=targets.shape[0])

    batch_kwargs = {"contexts": [targets], **kwargs}
    if past_only is not None:
        batch_kwargs["past_only_covariates"] = [kwargs["past_only_covariates"]]
    if past_future is not None:
        batch_kwargs["past_future_covariates"] = [kwargs["past_future_covariates"]]
    outputs = list(_call(forecaster.predict_batch, batch_kwargs))
    return _point_and_quantiles(outputs[0], horizon, n_series=targets.shape[0])


def run_forecasts(frame: pd.DataFrame, forecaster) -> pd.DataFrame:
    context_len = len(frame) - HORIZON_DAYS
    horizon_frame = frame.iloc[context_len:].reset_index(drop=True)
    t1 = frame["terminal_1_passengers"].to_numpy(np.float32)
    t2 = frame["terminal_2_passengers"].to_numpy(np.float32)
    targets = np.stack([t1[:context_len], t2[:context_len]])
    past_only = frame["avg_departure_delay_min"].to_numpy(np.float32)[:context_len][None, :]
    past_future = np.stack(
        [
            frame["terminal_1_scheduled_movements"].to_numpy(np.float32),
            frame["terminal_2_scheduled_movements"].to_numpy(np.float32),
            frame["event_intensity"].to_numpy(np.float32),
        ]
    )
    if past_future.shape[1] != context_len + HORIZON_DAYS:
        raise RuntimeError("Past-and-future covariates must cover context and horizon.")
    if targets.shape != (2, context_len) or past_only.shape != (1, context_len):
        raise RuntimeError("Target or past-only covariate shape is wrong.")

    print(
        f"TimesFM inputs: targets {tuple(targets.shape)}, "
        f"past-only delay {tuple(past_only.shape)}, "
        f"past-future schedule and events {tuple(past_future.shape)}"
    )

    univariate = [
        forecast_univariate(forecaster, series[:context_len], HORIZON_DAYS)
        for series in (t1, t2)
    ]
    joint = forecast_multivariate(forecaster, targets, HORIZON_DAYS)
    full = forecast_multivariate(
        forecaster,
        targets,
        HORIZON_DAYS,
        past_only=past_only,
        past_future=past_future,
    )

    rows = []
    for series_index, column in enumerate(TARGETS):
        point_u, _ = univariate[series_index]
        point_j = joint[0][series_index]
        point_f = full[0][series_index]
        quantiles = full[1][series_index]
        for step in range(HORIZON_DAYS):
            actual_row = horizon_frame.iloc[step]
            rows.append(
                {
                    "date": actual_row["date"],
                    "series": column,
                    "actual": float(actual_row[column]),
                    "univariate": float(point_u[step]),
                    "joint": float(point_j[step]),
                    "joint_with_covariates": float(point_f[step]),
                    "q10": float(quantiles[step, 0]),
                    "q50": float(quantiles[step, 4]),
                    "q90": float(quantiles[step, 8]),
                    "event_name": actual_row["event_name"],
                    "event_kind": actual_row["event_kind"],
                    "disruption_name": actual_row["disruption_name"],
                }
            )
    return pd.DataFrame(rows)


def score_forecasts(forecast: pd.DataFrame) -> pd.DataFrame:
    models = ("univariate", "joint", "joint_with_covariates")
    slices = {
        "all_days": pd.Series(True, index=forecast.index),
        "irregular_events": forecast["event_kind"].eq("irregular"),
        "seasonal_events": forecast["event_kind"].eq("seasonal"),
        "fog_day": forecast["disruption_name"].eq("Fog and flow restrictions"),
    }
    records = []
    for series, group in forecast.groupby("series", sort=False):
        for slice_name, mask in slices.items():
            part = group.loc[mask.loc[group.index]]
            if part.empty:
                continue
            actual = part["actual"].to_numpy()
            for model in models:
                error = part[model].to_numpy() - actual
                records.append(
                    {
                        "series": series,
                        "slice": slice_name,
                        "model": model,
                        "mae": float(np.mean(np.abs(error))),
                        "rmse": float(np.sqrt(np.mean(error**2))),
                        "mape_pct": float(np.mean(np.abs(error) / actual) * 100.0),
                        "n": int(len(part)),
                    }
                )
    return pd.DataFrame(records)


def print_scores(scores: pd.DataFrame) -> None:
    printable = scores.copy()
    printable["series"] = printable["series"].map(TARGET_LABELS)
    print()
    print(printable.to_string(index=False, formatters={
        "mae": "{:,.0f}".format,
        "rmse": "{:,.0f}".format,
        "mape_pct": "{:.1f}".format,
    }))
    irregular = scores[scores["slice"].eq("irregular_events")]
    for series in TARGETS:
        part = irregular[irregular["series"].eq(series)].set_index("model")
        if {"univariate", "joint_with_covariates"} <= set(part.index):
            uni = part.loc["univariate", "mae"]
            cov = part.loc["joint_with_covariates", "mae"]
            print(
                f"{TARGET_LABELS[series]} irregular-event MAE: "
                f"univariate {uni:,.0f}, joint with covariates {cov:,.0f}."
            )


def plot_forecast(frame: pd.DataFrame, forecast: pd.DataFrame, path: Path) -> None:
    """Classroom figure: what was shown, what was masked, and the error that follows."""
    frame = frame.copy()
    forecast = forecast.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    forecast["date"] = pd.to_datetime(forecast["date"])
    for column in ("event_name", "event_kind", "disruption_name"):
        if column in forecast.columns:
            forecast[column] = forecast[column].fillna("")
        if column in frame.columns:
            frame[column] = frame[column].fillna("")

    shown = frame[(frame["date"] >= "2026-02-08") & (frame["date"] <= "2026-03-28")].copy()
    origin = pd.Timestamp(CONTEXT_END) + pd.Timedelta(days=1)
    fog = pd.Timestamp(FOG_DAY)
    colors = {
        "univariate": "#C2410C",
        "joint": "#64748B",
        "joint_with_covariates": "#1D4ED8",
    }

    fig = plt.figure(figsize=(13.6, 11.2), facecolor="white")
    grid = fig.add_gridspec(
        4,
        1,
        height_ratios=[0.72, 1.35, 1.15, 1.05],
        hspace=0.38,
        left=0.07,
        right=0.98,
        top=0.90,
        bottom=0.05,
    )
    ax_key = fig.add_subplot(grid[0])
    ax_t1 = fig.add_subplot(grid[1])
    ax_t2 = fig.add_subplot(grid[2], sharex=ax_t1)
    ax_err = fig.add_subplot(grid[3])

    _draw_input_key(ax_key)
    _draw_terminal(ax_t1, shown, forecast, "terminal_1_passengers", origin, fog, colors, annotate=True)
    _draw_terminal(ax_t2, shown, forecast, "terminal_2_passengers", origin, fog, colors, annotate=False)
    _draw_error_bars(ax_err, forecast, colors)
    ax_t1.legend(
        loc="upper left",
        bbox_to_anchor=(0.22, 0.98),
        frameon=False,
        fontsize=8,
        ncols=2,
    )

    ax_t1.tick_params(labelbottom=False)
    fig.suptitle(
        "TimesFM 3 forecasts the spike it is allowed to see",
        fontsize=16,
        x=0.07,
        ha="left",
        color="#0F172A",
    )
    fig.text(
        0.07,
        0.935,
        "Synthetic Dublin Airport, February–March 2026. Zero-shot: the checkpoint is not fine-tuned on this series.",
        fontsize=10,
        color="#475569",
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=160)
    fig.savefig(path.with_suffix(".pdf"))
    plt.close(fig)


def _draw_input_key(ax) -> None:
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.axis("off")
    ax.set_title("What the model was allowed to see", loc="left", fontsize=13, color="#0F172A", pad=2)
    rows = (
        ("Passenger counts", "Shown", "Masked"),
        ("Event calendar", "Shown", "Shown"),
        ("Flight schedule", "Shown", "Shown"),
        ("Departure delay", "Shown", "Masked"),
    )
    headers = ((0.46, "History, through 28 Feb"), (0.74, "Horizon, 1–28 Mar"))
    for x, label in headers:
        ax.text(x, 0.86, label, ha="center", va="center", fontsize=9, color="#334155")
    for i, (name, history, horizon) in enumerate(rows):
        y = 0.64 - i * 0.20
        ax.text(0.02, y, name, ha="left", va="center", fontsize=10, color="#0F172A")
        _key_cell(ax, 0.46, y, history)
        _key_cell(ax, 0.74, y, horizon)


def _key_cell(ax, x: float, y: float, state: str) -> None:
    shown = state == "Shown"
    patch = FancyBboxPatch(
        (x - 0.09, y - 0.07),
        0.18,
        0.14,
        boxstyle="round,pad=0.012,rounding_size=0.02",
        facecolor="#DBEAFE" if shown else "#F1F5F9",
        edgecolor="#93C5FD" if shown else "#CBD5E1",
        linewidth=0.8,
        mutation_aspect=0.3,
        transform=ax.transData,
        clip_on=False,
    )
    ax.add_patch(patch)
    ax.text(
        x,
        y,
        state,
        ha="center",
        va="center",
        fontsize=9,
        color="#1E3A8A" if shown else "#64748B",
    )


def _draw_terminal(ax, shown, forecast, column, origin, fog, colors, annotate: bool) -> None:
    history = shown[shown["date"] < origin]
    future = forecast[forecast["series"].eq(column)]
    ax.axvspan(origin, shown["date"].max() + pd.Timedelta(hours=12), color="#F8FAFC", zorder=0)
    for _, row in shown.iterrows():
        if row["event_intensity"] == 1.0:
            ax.axvspan(
                row["date"] - pd.Timedelta(hours=12),
                row["date"] + pd.Timedelta(hours=12),
                color="#F6D58A",
                alpha=0.55,
                lw=0,
                zorder=1,
            )
    ax.axvline(origin, color="#94A3B8", lw=1, zorder=2)
    ax.plot(history["date"], history[column], color="#111827", lw=1.8, label="Actual", zorder=3)
    ax.plot(future["date"], future["actual"], color="#111827", lw=1.8, zorder=3)
    ax.fill_between(
        future["date"],
        future["q10"],
        future["q90"],
        color=colors["joint_with_covariates"],
        alpha=0.16,
        label="10–90% interval",
        zorder=2,
    )
    ax.plot(
        future["date"],
        future["univariate"],
        color=colors["univariate"],
        lw=1.8,
        label="History only",
        zorder=4,
    )
    ax.plot(
        future["date"],
        future["joint_with_covariates"],
        color=colors["joint_with_covariates"],
        lw=2.0,
        label="Schedule and events shown",
        zorder=4,
    )
    values = np.concatenate(
        [
            history[column].to_numpy(),
            future[["actual", "univariate", "joint_with_covariates", "q10", "q90"]].to_numpy().ravel(),
        ]
    )
    lo, hi = float(values.min()), float(values.max())
    span = hi - lo
    ax.set_ylim(lo - span * 0.08, hi + (span * 0.48 if annotate else span * 0.16))
    ax.set_ylabel("Passengers")
    ax.set_title(TARGET_LABELS[column], loc="left", fontsize=13, color="#0F172A")
    ax.yaxis.set_major_formatter(lambda value, _pos: f"{value:,.0f}")
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%-d %b"))
    if annotate:
        ymin, _ymax = ax.get_ylim()
        ax.text(
            origin + pd.Timedelta(hours=8),
            ymin + span * 0.03,
            "forecast starts",
            ha="left",
            va="bottom",
            fontsize=8,
            color="#64748B",
        )
        ceiling = hi + span * 0.34
        _callout(
            ax,
            "Past event\nalready in the history",
            pd.Timestamp("2026-02-11"),
            float(history.loc[history["date"].eq("2026-02-11"), column].iloc[0]),
            ceiling,
            ha="left",
        )
        _callout(
            ax,
            "Masked\nfog delay not passed in",
            fog,
            float(future.loc[future["date"].eq(fog), "actual"].iloc[0]),
            ceiling,
            color="#0F766E",
        )
        _callout(
            ax,
            "Shown ahead\nschedule and event flag",
            pd.Timestamp("2026-03-24"),
            float(future.loc[future["date"].eq("2026-03-24"), "joint_with_covariates"].iloc[0]),
            ceiling,
            ha="right",
        )


def _callout(ax, text, xy_date, xy_value, text_value, color="#1E3A8A", ha="center") -> None:
    ax.annotate(
        text,
        xy=(xy_date, xy_value),
        xytext=(xy_date, text_value),
        fontsize=8,
        color=color,
        ha=ha,
        va="bottom",
        arrowprops={"arrowstyle": "->", "color": color, "lw": 0.9},
        bbox={"boxstyle": "round,pad=0.28", "fc": "white", "ec": "#E2E8F0", "lw": 0.6},
        zorder=5,
    )


def _draw_error_bars(ax, forecast: pd.DataFrame, colors: dict) -> None:
    event = forecast["event_kind"].isin(["irregular", "seasonal"])
    fog = forecast["disruption_name"].eq("Fog and flow restrictions")
    slices = (
        ("Ordinary days", ~event & ~fog),
        ("Event days", event),
        ("Fog day, 11 Mar", fog),
    )
    models = (
        ("univariate", "History only", colors["univariate"]),
        ("joint", "Both terminals, no covariates", colors["joint"]),
        ("joint_with_covariates", "Schedule and events shown", colors["joint_with_covariates"]),
    )
    x = np.arange(len(slices))
    width = 0.22
    for i, (model, label, color) in enumerate(models):
        heights = []
        for _, mask in slices:
            part = forecast.loc[mask]
            heights.append(float(np.mean(np.abs(part[model].to_numpy() - part["actual"].to_numpy()))))
        offset = (i - 1) * 0.26
        bars = ax.bar(x + offset, heights, width, label=label, color=color, zorder=3)
        for rect, height in zip(bars, heights):
            inside = height >= 2500
            ax.text(
                rect.get_x() + rect.get_width() / 2,
                height * 0.97 if inside else height,
                f"{height / 1000:.1f}k",
                ha="center",
                va="top" if inside else "bottom",
                fontsize=8,
                color="white" if inside else "#334155",
            )
    counts = [int(forecast.loc[mask, "date"].nunique()) for _, mask in slices]
    ax.set_xticks(x, [f"{name}\n{count} days" for (name, _), count in zip(slices, counts)])
    ax.set_ylabel("Mean absolute error")
    ax.set_title(
        "Error on the horizon, both terminals combined",
        loc="left",
        fontsize=13,
        color="#0F172A",
    )
    ax.yaxis.set_major_formatter(lambda value, _pos: f"{value:,.0f}")
    ax.legend(loc="upper left", frameon=False, fontsize=9, ncols=3)
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.set_axisbelow(True)
    ax.yaxis.grid(True, color="#E2E8F0", lw=0.8)
    ymax = ax.get_ylim()[1]
    ax.set_ylim(0, ymax * 1.18)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-only",
        action="store_true",
        help="Write the synthetic CSV and stop before loading TimesFM.",
    )
    parser.add_argument(
        "--data-path",
        type=Path,
        default=ROOT / "data" / "dublin_airport_daily.csv",
    )
    parser.add_argument("--output-dir", type=Path, default=ROOT / "outputs")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    frame = build_dataset()
    args.data_path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_csv(args.data_path, index=False)
    print_data_summary(frame)
    print(f"Wrote {args.data_path}")
    if args.data_only:
        return

    forecaster, backend = load_forecaster()
    print(f"Backend: {backend}")
    forecast = run_forecasts(frame, forecaster)
    scores = score_forecasts(forecast)
    print_scores(scores)

    args.output_dir.mkdir(parents=True, exist_ok=True)
    forecast_path = args.output_dir / "forecast.csv"
    scores_path = args.output_dir / "metrics.csv"
    figure_path = args.output_dir / "dublin_airport_forecast.png"
    forecast.to_csv(forecast_path, index=False)
    scores.to_csv(scores_path, index=False)
    plot_forecast(frame, forecast, figure_path)
    print(f"Wrote {forecast_path}")
    print(f"Wrote {scores_path}")
    print(f"Wrote {figure_path}")


if __name__ == "__main__":
    main()
