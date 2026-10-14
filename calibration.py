"""Split-conformal calibration of TimesFM's uncertainty bands.

TimesFM returns nine deciles (0.1 ... 0.9). Whether its 80% band really
holds 80% of outcomes at this airport is an empirical question, and the
rosters lean on the upper quantiles. So each central band is widened or
narrowed by a factor learned on held-out backtest origins (conformalised
quantile regression with normalised scores):

    score = max((q50 - y) / (q50 - q_lo), (y - q50) / (q_hi - q50))
    s_c   = the c-quantile of the scores on the calibration origins
    band  = [q50 - s_c (q50 - q_lo), q50 + s_c (q_hi - q50)]

for c = 20, 40, 60, 80 and 90% (the 90% band is built from the model's
10-90% spread). The median is left as TimesFM returned it, so calibration
cannot import a bias from the calibration months. Factors are learned per
series, per horizon bucket (days 1-13, 14-28) and separately for days with a
known event and for days the weather forecast flags as high disruption risk
(Mondrian conformal): both are known in advance and their errors are
larger. The output has eleven levels, 0.05 ... 0.95, sorted to stay monotone.
"""

from __future__ import annotations

import numpy as np

MODEL_LEVELS = np.array([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])
LEVELS = np.array([0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95])
# Central bands: coverage, model lower index, model upper index, output lower/upper index.
BANDS = ((0.2, 3, 5, 4, 6), (0.4, 2, 6, 3, 7), (0.6, 1, 7, 2, 8), (0.8, 0, 8, 1, 9), (0.9, 0, 8, 0, 10))
BUCKETS = ((0, 14), (14, 10_000))
GROUPS = 3  # 0 ordinary, 1 known event, 2 weather forecast flags high disruption risk
MIN_SAMPLES = 40


def bucket_of(h, group=None) -> np.ndarray:
    """Horizon bucket, offset by len(BUCKETS) x the day's group."""
    h = np.asarray(h)
    out = np.zeros(len(h), dtype=int)
    for i, (lo, hi) in enumerate(BUCKETS):
        out[(h >= lo) & (h < hi)] = i
    if group is not None:
        out = out + len(BUCKETS) * np.asarray(group, int)
    return out


def _scores(actual, q, lo_i, hi_i) -> np.ndarray:
    med = q[:, 4]
    floor = 1e-6 * np.maximum(med, 1.0)
    down = np.maximum(med - q[:, lo_i], floor)
    up = np.maximum(q[:, hi_i] - med, floor)
    return np.maximum((med - actual) / down, (actual - med) / up)


def fit(actual, q, h, group=None) -> np.ndarray:
    """Scale factors s[cell, band]. q is (n, 9). A cell with too few samples
    falls back to its horizon bucket, then to all samples."""
    actual = np.asarray(actual, float)
    q = np.asarray(q, float)
    cells = bucket_of(h, group)
    hb = bucket_of(h)
    scales = np.ones((GROUPS * len(BUCKETS), len(BANDS)))
    for ci in range(GROUPS * len(BUCKETS)):
        mask = cells == ci
        if mask.sum() < MIN_SAMPLES:
            mask = hb == ci % len(BUCKETS)
        if mask.sum() < MIN_SAMPLES:
            mask = np.ones(len(actual), bool)
        for bi, (c, lo_i, hi_i, _, _) in enumerate(BANDS):
            s = _scores(actual[mask], q[mask], lo_i, hi_i)
            n = len(s)
            level = min(1.0, np.ceil((n + 1) * c) / n)  # finite-sample split-conformal
            scales[ci, bi] = max(float(np.quantile(s, level, method="higher")), 0.0)
    return scales


def apply(q, h, scales, group=None) -> np.ndarray:
    """Calibrated quantiles at LEVELS for model quantiles q (n, 9)."""
    q = np.asarray(q, float)
    cells = bucket_of(h, group)
    med = q[:, 4]
    out = np.zeros((len(q), len(LEVELS)))
    out[:, 5] = med
    for bi, (_, lo_i, hi_i, out_lo, out_hi) in enumerate(BANDS):
        s = scales[cells, bi]
        out[:, out_lo] = med - s * (med - q[:, lo_i])
        out[:, out_hi] = med + s * (q[:, hi_i] - med)
    return np.maximum(np.sort(out, axis=1), 0.0)


def day_group(event, wxrisk) -> np.ndarray:
    """0 ordinary, 1 known event, 2 high weather-disruption risk (not an event)."""
    event = np.asarray(event, bool)
    return np.where(event, 1, np.where(np.asarray(wxrisk, bool), 2, 0))


def raw_levels(q) -> np.ndarray:
    """Model quantiles placed on LEVELS with P5/P95 left at P10/P90 (what you
    get without calibration)."""
    q = np.asarray(q, float)
    return np.concatenate([q[:, :1], q, q[:, -1:]], axis=1)
