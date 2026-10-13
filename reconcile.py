"""Coherent forecasts across the passenger hierarchy (MinT, Wickramasuriya,
Athanasopoulos and Hyndman 2019).

    airport
    ├── Terminal 1 ── UK, Europe city, Europe sun ── arrivals | departures
    └── Terminal 2 ── UK, Europe city, North America, long-haul ── arr | dep

Terminals, markets and arrivals/departures are forecast by separate TimesFM
calls, so they do not add up exactly. MinT finds the coherent set closest to
all of them at once, weighting each by how wrong that forecast tends to be
(the covariance of its backtest errors, shrunk towards the diagonal with the
Schäfer-Strimmer estimator). The bottom level is arrivals/departures per
market; everything above is a sum of it.

Only the median is reconciled. Each node keeps its own calibrated band,
re-centred on its reconciled median: projecting every quantile level through
the same matrix narrows the lower levels' bands and, on the backtest, made
them under-cover. Coherent medians with honest per-node bands is the
trade-off used here.
"""

from __future__ import annotations

import numpy as np

from forecast_markets import TERMINAL_MARKETS


def hierarchy() -> tuple[list[tuple], list[tuple], np.ndarray]:
    """(all node keys, bottom keys, summing matrix S)."""
    bottom = [(t, m, d) for t, names in TERMINAL_MARKETS.items() for m in names for d in ("arr", "dep")]
    nodes = [(t,) for t in TERMINAL_MARKETS] + [(t, m) for t, names in TERMINAL_MARKETS.items() for m in names] + bottom
    s = np.zeros((len(nodes), len(bottom)))
    for i, node in enumerate(nodes):
        for j, leaf in enumerate(bottom):
            if leaf[: len(node)] == node:
                s[i, j] = 1.0
    return nodes, bottom, s


def shrunk_covariance(residuals: np.ndarray) -> tuple[np.ndarray, float]:
    """Schäfer-Strimmer shrinkage of the residual covariance towards its
    diagonal. residuals is (samples, nodes)."""
    x = residuals - residuals.mean(axis=0)
    n = len(x)
    sd = x.std(axis=0, ddof=1)
    sd = np.where(sd > 0, sd, 1.0)
    z = x / sd
    r = (z.T @ z) / (n - 1)
    w = np.einsum("ki,kj->kij", z, z)
    var_r = n / (n - 1) ** 3 * ((w - w.mean(axis=0)) ** 2).sum(axis=0)
    off = ~np.eye(len(r), dtype=bool)
    lam = float(np.clip(var_r[off].sum() / (r[off] ** 2).sum(), 0.0, 1.0))
    r_shrunk = np.where(off, (1 - lam) * r, r)
    return r_shrunk * np.outer(sd, sd), lam


def mint_projection(s: np.ndarray, w: np.ndarray) -> np.ndarray:
    """P such that reconciled = P @ base (P = S (S' W^-1 S)^-1 S' W^-1)."""
    winv = np.linalg.inv(w)
    g = np.linalg.solve(s.T @ winv @ s, s.T @ winv)
    return s @ g


def reconcile(base: np.ndarray, p: np.ndarray) -> np.ndarray:
    """base is (..., nodes); returns the coherent version."""
    return base @ p.T
