"""Forecast accuracy metrics, numpy only.

Point:          WAPE, MASE, bias
Probabilistic:  pinball loss, weighted quantile loss (WQL, about CRPS), interval
                coverage and width
Uncertainty:    block bootstrap over forecast origins for metric differences

All functions take flat arrays; the evaluation script groups and slices.
"""

from __future__ import annotations

import numpy as np

QUANTILES = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])


def wape(actual, forecast) -> float:
    """Weighted absolute percentage error: sum |e| / sum |y|."""
    actual, forecast = np.asarray(actual, float), np.asarray(forecast, float)
    denom = np.abs(actual).sum()
    return float(np.abs(forecast - actual).sum() / denom) if denom else float("nan")


def bias(actual, forecast) -> float:
    """Signed: sum e / sum y. Positive means over-forecast."""
    actual, forecast = np.asarray(actual, float), np.asarray(forecast, float)
    denom = np.abs(actual).sum()
    return float((forecast - actual).sum() / denom) if denom else float("nan")


def mase(actual, forecast, scale) -> float:
    """Mean absolute error over a per-point scale (the in-sample MAE of a
    seasonal-naive forecast on each origin's own context)."""
    actual, forecast, scale = (np.asarray(x, float) for x in (actual, forecast, scale))
    return float(np.mean(np.abs(forecast - actual) / scale))


def snaive_scale(history, season: int = 7) -> float:
    history = np.asarray(history, float)
    return float(np.mean(np.abs(history[season:] - history[:-season])))


def pinball(actual, q, levels=QUANTILES) -> np.ndarray:
    """Mean pinball loss per quantile level. q has shape (n, len(levels))."""
    actual = np.asarray(actual, float)[:, None]
    q = np.asarray(q, float)
    levels = np.asarray(levels, float)[None, :]
    diff = actual - q
    return np.mean(np.maximum(levels * diff, (levels - 1) * diff), axis=0)


def wql(actual, q, levels=QUANTILES) -> float:
    """Weighted quantile loss: 2 * sum of pinball losses / sum |y|, averaged
    over levels. On the nine deciles this approximates scaled CRPS."""
    actual = np.asarray(actual, float)
    q = np.asarray(q, float)
    levels = np.asarray(levels, float)[None, :]
    diff = actual[:, None] - q
    loss = np.maximum(levels * diff, (levels - 1) * diff).sum(axis=0)
    return float(np.mean(2 * loss / np.abs(actual).sum()))


def coverage(actual, lo, hi) -> float:
    actual, lo, hi = (np.asarray(x, float) for x in (actual, lo, hi))
    return float(np.mean((actual >= lo) & (actual <= hi)))


def rel_width(actual, lo, hi) -> float:
    actual, lo, hi = (np.asarray(x, float) for x in (actual, lo, hi))
    return float(np.sum(hi - lo) / np.abs(actual).sum())


def bootstrap_diff(groups, a_err, b_err, actual, n_boot: int = 2000, seed: int = 0) -> tuple[float, float, float]:
    """WAPE(a) - WAPE(b) with a 95% interval from resampling whole groups
    (forecast origins), which keeps the dependence between days that share
    an origin. Negative means a is better."""
    groups = np.asarray(groups)
    a_err, b_err, actual = (np.abs(np.asarray(x, float)) for x in (a_err, b_err, actual))
    keys, inv = np.unique(groups, return_inverse=True)
    sa = np.bincount(inv, a_err, len(keys))
    sb = np.bincount(inv, b_err, len(keys))
    sy = np.bincount(inv, actual, len(keys))
    point = (sa.sum() - sb.sum()) / sy.sum()
    rng = np.random.default_rng(seed)
    pick = rng.integers(0, len(keys), size=(n_boot, len(keys)))
    diffs = (sa[pick].sum(1) - sb[pick].sum(1)) / sy[pick].sum(1)
    lo, hi = np.percentile(diffs, [2.5, 97.5])
    return float(point), float(lo), float(hi)


def reliability(actual, q, levels=QUANTILES) -> np.ndarray:
    """Observed fraction of actuals at or below each forecast quantile."""
    actual = np.asarray(actual, float)[:, None]
    return np.mean(actual <= np.asarray(q, float), axis=0)
