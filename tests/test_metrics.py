import numpy as np
import pytest

import baselines as bl
import calibration as cal
import metrics as mx
from reconcile import hierarchy, mint_projection, shrunk_covariance


def test_wape_and_bias_hand_computed():
    y = np.array([100.0, 200.0, 300.0])
    f = np.array([110.0, 190.0, 330.0])
    assert mx.wape(y, f) == pytest.approx(50 / 600)
    assert mx.bias(y, f) == pytest.approx(30 / 600)


def test_mase_uses_scale():
    assert mx.mase([10, 20], [12, 18], [2, 2]) == pytest.approx(1.0)
    hist = np.tile(np.arange(7.0), 4)
    assert mx.snaive_scale(hist) == 0.0


def test_pinball_and_wql():
    y = np.array([10.0])
    q = np.array([[8.0, 10.0, 12.0]])
    levels = np.array([0.1, 0.5, 0.9])
    # diff = y - q = [2, 0, -2]
    expected = np.array([0.1 * 2, 0.0, 0.1 * 2])
    assert np.allclose(mx.pinball(y, q, levels), expected)
    assert mx.wql(y, q, levels) == pytest.approx(np.mean(2 * expected / 10))


def test_coverage_and_reliability():
    y = np.arange(10.0)
    assert mx.coverage(y, np.full(10, 2.0), np.full(10, 6.0)) == pytest.approx(0.5)
    rel = mx.reliability(y, np.tile([[4.5]], (10, 1)), [0.5])
    assert rel[0] == pytest.approx(0.5)


def test_bootstrap_interval_contains_point():
    rng = np.random.default_rng(1)
    g = np.repeat(np.arange(20), 7)
    y = rng.uniform(90, 110, len(g))
    a = rng.normal(0, 2, len(g))
    b = rng.normal(0, 5, len(g))
    d, lo, hi = mx.bootstrap_diff(g, a, b, y)
    assert lo <= d <= hi and d < 0


def test_snaive_and_schedule_baselines():
    hist = np.tile([1.0, 2, 3, 4, 5, 6, 7], 60)
    assert np.allclose(bl.snaive7(hist, 14), np.tile([1.0, 2, 3, 4, 5, 6, 7], 2))
    assert np.allclose(bl.snaive364(hist, 7), [1, 2, 3, 4, 5, 6, 7])
    cov = np.ones(len(hist) + 7) * 10
    cov[-7:] = 20  # schedule doubles: forecast should double
    assert np.allclose(bl.schedule_ratio(hist, cov, 7), 2 * np.array([1.0, 2, 3, 4, 5, 6, 7]))


def test_holt_winters_tracks_pure_season():
    hist = np.tile([100.0, 120, 110, 130, 150, 90, 140], 70)
    f = bl.holt_winters(hist, 7)
    assert np.allclose(f, hist[:7], rtol=0.02)


def test_conformal_restores_coverage():
    rng = np.random.default_rng(0)
    n = 4000
    y = 1000 + rng.normal(0, 50, n)
    med = np.full(n, 1000.0)
    # Over-confident model: deciles from sd 20 instead of 50.
    z = np.array([-1.2816, -0.8416, -0.5244, -0.2533, 0, 0.2533, 0.5244, 0.8416, 1.2816])
    q = med[:, None] + 20 * z[None, :]
    h = rng.integers(0, 28, n)
    shifts = cal.fit(y[:2000], q[:2000], h[:2000])
    cq = cal.apply(q[2000:], h[2000:], shifts)
    assert mx.coverage(y[2000:], q[2000:, 0], q[2000:, 8]) < 0.5
    cov80 = mx.coverage(y[2000:], cq[:, 1], cq[:, 9])
    cov90 = mx.coverage(y[2000:], cq[:, 0], cq[:, 10])
    assert 0.76 < cov80 < 0.84
    assert 0.86 < cov90 < 0.94
    assert np.all(np.diff(cq, axis=1) >= 0)


def test_mint_is_coherent_and_keeps_coherent_forecasts():
    nodes, bottom, s = hierarchy()
    assert s.shape == (len(nodes), len(bottom)) == (23, 14)
    rng = np.random.default_rng(3)
    resid = rng.normal(0, 1, (500, len(nodes))) * np.linspace(1, 5, len(nodes))
    w, lam = shrunk_covariance(resid)
    assert 0 <= lam <= 1
    p = mint_projection(s, w)
    leaves = rng.uniform(100, 200, len(bottom))
    coherent = s @ leaves
    assert np.allclose(p @ coherent, coherent)
    noisy = coherent + rng.normal(0, 10, len(nodes))
    rec = p @ noisy
    assert np.allclose(s @ rec[-len(bottom):], rec)
