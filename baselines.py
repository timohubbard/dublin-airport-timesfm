"""Classical baselines every forecast here is compared against, numpy only.

  snaive7       last week, repeated
  snaive364     the same weekday 52 weeks earlier
  holt_winters  additive Holt-Winters with a damped trend and weekly season,
                parameters chosen by one-step-ahead error on the context
  schedule      the planner's spreadsheet method: next period's published
                schedule times the passengers per scheduled movement seen on
                the same weekday over the last four weeks

Each takes the history up to the origin (and, for schedule, the covariate
over history and horizon) and returns the horizon forecast.
"""

from __future__ import annotations

from itertools import product

import numpy as np

HW_GRID = {
    "alpha": (0.05, 0.15, 0.3, 0.5),
    "beta": (0.0, 0.02, 0.08),
    "gamma": (0.05, 0.15, 0.3),
    "phi": (0.9, 0.98),
}
HW_FIT_WINDOW = 400


def snaive7(history: np.ndarray, horizon: int) -> np.ndarray:
    history = np.asarray(history, float)
    last = history[-7:]
    return np.array([last[h % 7] for h in range(horizon)])


def snaive364(history: np.ndarray, horizon: int) -> np.ndarray:
    history = np.asarray(history, float)
    n = len(history)
    return np.array([history[n - 364 + h] for h in range(horizon)])


def _hw_filter(y: np.ndarray, alpha: float, beta: float, gamma: float, phi: float, m: int = 7):
    """Run the recursions; return (sse of one-step errors, final state)."""
    level = y[:m].mean()
    trend = (y[m:2 * m].mean() - y[:m].mean()) / m
    season = list(y[:m] - level)
    sse = 0.0
    for t in range(m, len(y)):
        s = season[t - m]
        pred = level + phi * trend + s
        err = y[t] - pred
        sse += err * err
        new_level = level + phi * trend + alpha * err
        trend = phi * trend + beta * (new_level - level - phi * trend)
        season.append(s + gamma * (1 - alpha) * err)
        level = new_level
    return sse, (level, trend, season[-m:])


def hw_fit(history: np.ndarray) -> dict:
    y = np.asarray(history, float)[-HW_FIT_WINDOW:]
    best = None
    for alpha, beta, gamma, phi in product(*HW_GRID.values()):
        sse, _ = _hw_filter(y, alpha, beta, gamma, phi)
        if best is None or sse < best[0]:
            best = (sse, dict(alpha=alpha, beta=beta, gamma=gamma, phi=phi))
    return best[1]


def holt_winters(history: np.ndarray, horizon: int, params: dict | None = None) -> np.ndarray:
    y = np.asarray(history, float)[-HW_FIT_WINDOW:]
    params = params or hw_fit(y)
    _, (level, trend, season) = _hw_filter(y, **params)
    phi = params["phi"]
    out = []
    damp = 0.0
    for h in range(1, horizon + 1):
        damp += phi**h
        out.append(level + damp * trend + season[(h - 1) % 7])
    return np.maximum(np.array(out), 0.0)


def schedule_ratio(history: np.ndarray, covariate: np.ndarray, horizon: int, weeks: int = 4) -> np.ndarray:
    """covariate covers history and horizon. Ratio per weekday over `weeks`."""
    y = np.asarray(history, float)
    x = np.asarray(covariate, float)
    n = len(y)
    out = np.zeros(horizon)
    for h in range(horizon):
        lags = [n + h - 7 * k for k in range(1, 30) if n + h - 7 * k < n][:weeks]
        ratio = np.sum(y[lags]) / max(1e-9, np.sum(x[lags]))
        out[h] = ratio * x[n + h]
    return out


BASELINES = ("snaive7", "snaive364", "holt_winters", "schedule")
BASELINE_LABELS = {
    "snaive7": "Seasonal naive (last week)",
    "snaive364": "Seasonal naive (last year)",
    "holt_winters": "Holt-Winters (damped, weekly)",
    "schedule": "Schedule × recent load (planner's method)",
}
