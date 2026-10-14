import numpy as np
import pandas as pd
import pytest

import real_data
from forecast_operations import CAR_PARKS
from pipeline import build_data, families, neutral_pf


@pytest.fixture(scope="module")
def data():
    return build_data(write=False)


def test_daily_frame_is_complete(data):
    f = data.frame
    assert f["date"].is_monotonic_increasing
    assert (f["date"].diff().dropna() == pd.Timedelta(days=1)).all()
    assert not f.drop(columns=["event_name", "event_kind", "disruption_name"]).isna().any().any()
    assert (f[["terminal_1_passengers", "terminal_2_passengers"]] > 0).all().all()


def test_monthly_totals_match_cso(data):
    f = data.frame
    total = (f["terminal_1_passengers"] + f["terminal_2_passengers"]).to_numpy()
    idx = pd.DatetimeIndex(f["date"])
    syn = pd.Series(total, index=idx).groupby(idx.to_period("M")).agg(["sum", "count"])
    cso = real_data.load_monthly()["passengers"]
    both = syn.join(cso, how="inner")
    full = both[both["count"] == both.index.days_in_month]
    assert len(full) >= 36
    assert np.allclose(full["sum"], full["passengers"], rtol=1e-4)
    # The partial last month matches per day.
    last = both.iloc[-1]
    assert last["sum"] / last["count"] == pytest.approx(last["passengers"] / both.index[-1].days_in_month, rel=1e-3)


def test_markets_add_up_and_match_cso_mix(data):
    m = data.markets
    f = data.frame.set_index("date")
    for t, col in (("t1", "terminal_1_passengers"), ("t2", "terminal_2_passengers")):
        sums = m[m["terminal"] == t].groupby("date")["passengers"].sum()
        assert (sums.to_numpy() == f[col].to_numpy()).all()
    targets = real_data.market_targets()
    m = m.assign(month=pd.DatetimeIndex(m["date"]).to_period("M"))
    monthly = m.groupby(["month", "terminal", "market"])["passengers"].sum()
    errors = [v / targets.loc[mo, f"{t}_{mk}"] - 1 for (mo, t, mk), v in monthly.items() if mo != monthly.index[-1][0]]
    assert np.max(np.abs(errors)) < 0.01


def test_directions_and_landside_invariants(data):
    d = data.directions
    assert (d["dep_pax"] + d["arr_pax"] == d["passengers"]).all()
    assert d["dep_share"].between(0.40, 0.60).all()
    ls = data.landside
    assert (ls.drop(columns=["date"]) >= 0).all().all()
    for key, spec in CAR_PARKS.items():
        assert (ls[f"{key}_occ_start"] <= spec["cap"]).all()


def test_schedule_is_published_not_realised(data):
    """The schedule covariate must not reveal on-the-day outcomes."""
    f = data.frame.set_index("date")
    eowyn = pd.Timestamp("2025-01-24")
    assert f.loc[eowyn, "terminal_1_operated_movements"] < 0.8 * f.loc[eowyn, "terminal_1_scheduled_movements"]
    # Correlation of schedule with passengers is high but far from exact.
    ratio = f["terminal_1_passengers"] / f["terminal_1_scheduled_movements"]
    assert ratio.std() / ratio.mean() > 0.03


def test_families_shapes_and_neutralising(data):
    n = len(data.frame)
    fams = families(data)
    assert {fam.name for fam in fams} == {"terminals", "markets_t1", "markets_t2", "directions_t1", "directions_t2", "landside"}
    for fam in fams:
        assert fam.y.shape[1] == fam.pf.shape[1] == fam.po.shape[1] == n
        assert len(fam.keys) == len(fam.y) == len(fam.labels)
        rows = sorted(r for g in fam.groups.values() for r in g)
        assert rows == list(range(len(fam.pf)))
        o = data.final_origin
        pf = neutral_pf(fam, o, 28, ("events", "calendar"))
        for r in fam.groups["events"] + fam.groups["calendar"]:
            assert (pf[r, o:o + 28] == 0).all()
        assert np.array_equal(pf[:, :o], fam.pf[:, :o])
