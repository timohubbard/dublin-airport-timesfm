"""One place that builds the data, defines what is forecast, and runs TimesFM.

A *family* is one TimesFM call: a set of target series forecast jointly, the
covariates that go with them, and which covariate rows belong to which
group (for the explanations and the scenarios):

  terminals     T1 and T2 passengers
  markets_t1/2  passengers per destination market
  directions_t1/2  arrivals and departures per market
  landside      taxi pickups, bus passengers, Holiday Blue entries/occupancy

Covariates are split the way TimesFM 3 reads them:

  past-and-future  published schedule (movements), the event flag, school
                   holidays and event direction: all known in advance
  past-only        departure delay, operated movements and the cancelled
                   share: only known after the day

Every forecast is cached on disk by a hash of its inputs, so re-running the
evaluation, the explanations or the export does not recompute anything that
has not changed.
"""

from __future__ import annotations

import hashlib
import inspect
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

from forecast_dublin_airport import CONTEXT_END, HORIZON_DAYS, ROOT, SEED, build_dataset, load_forecaster
from forecast_markets import TERMINAL_MARKETS, build_market_dataset
from forecast_operations import (
    build_direction_dataset,
    build_landside_dataset,
    event_direction_series,
    landside_targets,
)

CACHE = ROOT / "outputs" / "cache"
GROUPS = ("schedule", "events", "calendar")
GROUP_LABELS = {
    "schedule": "Published schedule",
    "events": "Event calendar",
    "calendar": "School holidays & travel direction",
}


@dataclass
class Data:
    frame: pd.DataFrame
    markets: pd.DataFrame
    directions: pd.DataFrame
    landside: pd.DataFrame

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.frame["date"])

    @property
    def final_origin(self) -> int:
        return len(self.frame) - HORIZON_DAYS


def build_data(seed: int = SEED, write: bool = True) -> Data:
    frame = build_dataset(seed)
    markets = build_market_dataset(frame, seed)
    directions = build_direction_dataset(frame, markets, seed)
    landside = build_landside_dataset(frame, markets, directions, seed)
    if write:
        data_dir = ROOT / "data"
        data_dir.mkdir(exist_ok=True)
        frame.to_csv(data_dir / "dublin_airport_daily.csv", index=False)
        markets.to_csv(data_dir / "dublin_airport_markets.csv", index=False)
        directions.to_csv(data_dir / "dublin_airport_directions.csv", index=False)
        landside.to_csv(data_dir / "dublin_airport_landside.csv", index=False)
    return Data(frame, markets, directions, landside)


@dataclass
class Family:
    name: str
    keys: list[tuple]                 # one tuple per target row
    y: np.ndarray                     # (k, n) targets, full period
    pf: np.ndarray                    # (w, n) past-and-future covariates
    po: np.ndarray                    # (v, n) past-only covariates
    groups: dict[str, list[int]]      # covariate group -> pf rows
    primary: np.ndarray               # (k, n) schedule-like covariate per target, for the planner baseline
    extra_row: int | None = None      # pf row that the "+1 route" scenario adds to
    labels: list[str] = field(default_factory=list)


def _f32(*rows) -> np.ndarray:
    return np.stack([np.asarray(r, dtype=np.float32) for r in rows])


def families(data: Data) -> list[Family]:
    f = data.frame
    events = f["event_intensity"].to_numpy(np.float32)
    holiday = f["school_holiday"].to_numpy(np.float32)
    direction = event_direction_series(f).astype(np.float32)
    s1 = f["terminal_1_scheduled_movements"].to_numpy(np.float32)
    s2 = f["terminal_2_scheduled_movements"].to_numpy(np.float32)
    po_terminal = _f32(
        f["avg_departure_delay_min"],
        f["terminal_1_operated_movements"],
        f["terminal_2_operated_movements"],
        f["cancelled_pct"],
    )
    delay = _f32(f["avg_departure_delay_min"], f["cancelled_pct"])
    out = [
        Family(
            "terminals",
            [("t1",), ("t2",)],
            _f32(f["terminal_1_passengers"], f["terminal_2_passengers"]),
            _f32(s1, s2, events, holiday, direction),
            po_terminal,
            {"schedule": [0, 1], "events": [2], "calendar": [3, 4]},
            _f32(s1, s2),
            extra_row=0,
            labels=["Terminal 1", "Terminal 2"],
        )
    ]
    for terminal, names in TERMINAL_MARKETS.items():
        sub = data.markets[data.markets["terminal"] == terminal]
        pax = [sub.loc[sub["market"] == m, "passengers"].to_numpy(np.float32) for m in names]
        mov = [sub.loc[sub["market"] == m, "scheduled_movements"].to_numpy(np.float32) for m in names]
        k = len(names)
        out.append(
            Family(
                f"markets_{terminal}",
                [(terminal, m) for m in names],
                _f32(*pax),
                _f32(*mov, events, holiday, direction),
                delay,
                {"schedule": list(range(k)), "events": [k], "calendar": [k + 1, k + 2]},
                _f32(*mov),
                extra_row=names.index("eu_city"),
                labels=[f"{terminal.upper()} {m}" for m in names],
            )
        )
    for terminal, names in TERMINAL_MARKETS.items():
        sub = data.directions[data.directions["terminal"] == terminal]
        get = lambda m, col: sub.loc[sub["market"] == m, col].to_numpy(np.float32)
        keys, ys, prim = [], [], []
        for m in names:
            for d in ("arr", "dep"):
                keys.append((terminal, m, d))
                ys.append(get(m, f"{d}_pax"))
                prim.append(get(m, f"{d}_movements"))
        mov = [get(m, "dep_movements") + get(m, "arr_movements") for m in names]
        k = len(names)
        out.append(
            Family(
                f"directions_{terminal}",
                keys,
                _f32(*ys),
                _f32(*mov, events, holiday, direction),
                delay,
                {"schedule": list(range(k)), "events": [k], "calendar": [k + 1, k + 2]},
                _f32(*prim),
                extra_row=names.index("eu_city"),
                labels=[f"{t.upper()} {m} {d}" for t, m, d in keys],
            )
        )
    tgt = landside_targets(data.landside)
    lkeys = list(tgt)
    sched_total = s1 + s2
    primary = {"taxi_pickups_t1": s1, "taxi_pickups_t2": s2, "bus_pax_t1": s1, "bus_pax_t2": s2}
    out.append(
        Family(
            "landside",
            [(k,) for k in lkeys],
            _f32(*[tgt[k] for k in lkeys]),
            _f32(s1, s2, events, holiday, direction),
            delay,
            {"schedule": [0, 1], "events": [2], "calendar": [3, 4]},
            _f32(*[primary.get(k, sched_total) for k in lkeys]),
            extra_row=0,
            labels=lkeys,
        )
    )
    return out


# --- TimesFM with a disk cache -------------------------------------------------

def _require(method, names: set[str]) -> None:
    """Fail loudly if this TimesFM build does not accept an argument we pass.

    (The old helper dropped unknown keywords silently, so a renamed covariate
    argument would have produced a covariate-free forecast without warning.)
    """
    params = inspect.signature(method).parameters
    if any(p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()):
        return
    missing = names - set(params)
    if missing:
        raise TypeError(f"{method.__qualname__} does not accept {sorted(missing)}; check the TimesFM version.")


class Engine:
    """TimesFM, loaded once, plus a content-addressed cache of forecasts."""

    def __init__(self, cache: Path = CACHE, horizon: int = HORIZON_DAYS):
        self.cache = cache
        self.cache.mkdir(parents=True, exist_ok=True)
        self.horizon = horizon
        self._model = None
        self.calls = 0
        self.hits = 0
        self.seconds = 0.0

    @property
    def model(self):
        if self._model is None:
            self._model, backend = load_forecaster()
            if backend != "mlx" and backend != "torch":
                raise RuntimeError(backend)
            _require(self._model.predict_batch, {"contexts", "horizon", "past_only_covariates",
                                                 "past_future_covariates", "return_quantiles", "make_positive"})
        return self._model

    def _key(self, *parts) -> str:
        h = hashlib.sha1()
        for p in parts:
            if isinstance(p, np.ndarray):
                h.update(np.ascontiguousarray(p, dtype=np.float32).tobytes())
                h.update(str(p.shape).encode())
            else:
                h.update(repr(p).encode())
        return h.hexdigest()[:20]

    def _cached(self, key: str, compute):
        path = self.cache / f"{key}.npz"
        if path.exists():
            self.hits += 1
            z = np.load(path)
            return z["point"], z["q"]
        t0 = time.perf_counter()
        point, q = compute()
        self.seconds += time.perf_counter() - t0
        self.calls += 1
        np.savez_compressed(path, point=point, q=q)
        return point, q

    def univariate(self, y: np.ndarray, origin: int) -> tuple[np.ndarray, np.ndarray]:
        """Each row alone, from its own history. Returns (k, h), (k, h, 9)."""
        ctx = np.asarray(y[:, :origin], np.float32)
        h = self.horizon

        def compute():
            outs = list(self.model.predict_batch(contexts=[r for r in ctx], horizon=h,
                                                 return_quantiles=True, make_positive=True))
            point = np.stack([np.reshape(o.forecast, -1)[:h] for o in outs])
            q = np.stack([np.reshape(o.quantiles, (-1, 9))[:h] for o in outs])
            return point, q

        return self._cached(self._key("uni", ctx, h), compute)

    def joint(self, y: np.ndarray, origin: int, pf: np.ndarray | None = None, po: np.ndarray | None = None):
        """All rows together; with covariates when given. pf must cover the
        context and the horizon, po the context only."""
        h = self.horizon
        ctx = np.asarray(y[:, :origin], np.float32)
        pf_w = None if pf is None else np.asarray(pf[:, :origin + h], np.float32)
        po_w = None if po is None else np.asarray(po[:, :origin], np.float32)

        def compute():
            outs = list(self.model.predict_batch(
                contexts=[ctx], horizon=h,
                past_only_covariates=[po_w], past_future_covariates=[pf_w],
                return_quantiles=True, make_positive=True,
            ))
            point = np.asarray(outs[0].forecast, np.float64).reshape(len(ctx), -1)[:, :h]
            q = np.asarray(outs[0].quantiles, np.float64).reshape(len(ctx), -1, 9)[:, :h]
            return point, q

        return self._cached(self._key("joint", ctx, pf_w, po_w, h), compute)

    def report(self) -> str:
        return f"TimesFM: {self.calls} calls in {self.seconds:.1f}s, {self.hits} cache hits"


def neutral_pf(fam: Family, origin: int, horizon: int, drop: tuple[str, ...]) -> np.ndarray:
    """Covariates with some groups replaced, over the horizon, by what a
    planner would assume without that information: the schedule by the same
    weekday's average over the last four weeks, events and calendar by zero."""
    pf = fam.pf.copy()
    for group in drop:
        for r in fam.groups[group]:
            if group == "schedule":
                for t in range(origin, origin + horizon):
                    lags = [t - 7 * k for k in range(1, 30) if t - 7 * k < origin][:4]
                    pf[r, t] = pf[r, lags].mean()
            else:
                pf[r, origin:origin + horizon] = 0.0
    return pf


def run_models(engine: Engine, fam: Family, origin: int, joint_plain: bool = True) -> dict:
    """The three TimesFM variants for one family and origin."""
    out = {
        "univariate": engine.univariate(fam.y, origin),
        "covariates": engine.joint(fam.y, origin, fam.pf, fam.po),
    }
    if joint_plain:
        out["joint"] = engine.joint(fam.y, origin)
    return out


def shapley(engine: Engine, fam: Family, origin: int) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Exact Shapley values of the three covariate groups for the point forecast.

    Runs the covariate model on all 2^3 combinations of known/neutralised
    groups. The base is the model with every group neutralised; base plus the
    three contributions equals the full forecast exactly.
    """
    from itertools import combinations
    from math import factorial

    h = engine.horizon
    value = {}
    for r in range(len(GROUPS) + 1):
        for known in combinations(GROUPS, r):
            drop = tuple(g for g in GROUPS if g not in known)
            pf = neutral_pf(fam, origin, h, drop)
            value[frozenset(known)] = engine.joint(fam.y, origin, pf, fam.po)[0]
    n = len(GROUPS)
    phi = {}
    for g in GROUPS:
        total = np.zeros_like(value[frozenset()])
        others = [x for x in GROUPS if x != g]
        for r in range(n):
            for subset in combinations(others, r):
                w = factorial(r) * factorial(n - r - 1) / factorial(n)
                total += w * (value[frozenset(subset) | {g}] - value[frozenset(subset)])
        phi[g] = total
    return value[frozenset()], phi


def backtest_origins(data: Data, weeks: int = 52, horizon: int = HORIZON_DAYS) -> list[int]:
    """Weekly origins whose whole horizon lies before the final holdout."""
    last = data.final_origin - horizon
    return sorted(last - 7 * k for k in range(weeks))
