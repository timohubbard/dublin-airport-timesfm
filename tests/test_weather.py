from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

import weather_data as wx


@pytest.fixture(scope="module")
def obs():
    return wx.daily_observed()


def test_observations_cover_the_whole_period(obs):
    days = pd.date_range(wx.START, wx.END).date
    assert set(days) <= set(obs.index)
    assert obs["gust_max_kt"].notna().mean() > 0.99
    assert obs["gust_max_kt"].max() < 90  # QC removed single-report spikes


def test_storm_eowyn_is_a_major_disruption(obs):
    d = wx.disruption([date(2025, 1, 24), date(2025, 6, 15)])
    assert d.loc[date(2025, 1, 24), "cancel"] >= 0.25
    assert "Storm" in d.loc[date(2025, 1, 24), "name"]
    assert d.loc[date(2025, 6, 15), "cancel"] < 0.02


def test_forecast_archive_is_as_issued():
    fc = wx.load_forecast_features()
    assert set(fc["model"]) == {"ifs", "aifs"}
    assert set(fc["lead"]) == set(wx.LEADS)
    # Both models cover the whole backtest period at every lead.
    for model in ("ifs", "aifs"):
        sub = fc[(fc["model"] == model) & (fc["date"] >= date(2025, 1, 1)) & (fc["date"] <= date(2026, 3, 28))]
        assert sub.groupby("lead")["date"].nunique().min() >= 440


def test_forecast_asof_never_uses_hindsight():
    """Horizon day j must come from a run issued j+1 days earlier, i.e. before the origin."""
    fc = wx.load_forecast_features()
    clim = wx.climatology()
    origin = date(2025, 1, 20)
    got = wx.forecast_asof(origin, 10, "ifs", fc, clim)
    sub = fc[fc["model"] == "ifs"].set_index(["date", "lead"])
    for j in range(7):
        want = sub.loc[(origin + timedelta(days=j), j + 1), list(wx.FC_FEATURES)].to_numpy(float)
        assert np.allclose(got[:, j], want)
    # Beyond the archive's 7-day lead: climatology, not a forecast.
    doy = (origin + timedelta(days=8)).timetuple().tm_yday
    assert np.allclose(got[:, 8], clim.loc[doy, list(wx.FC_FEATURES)].to_numpy(float))
