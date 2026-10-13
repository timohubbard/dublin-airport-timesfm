"""The production forecast for the March 2026 holdout, with everything the
operations twin needs to explain and stress it.

  1. TimesFM 3 for every family: history only, jointly, and with covariates.
  2. Calibrated bands: the split-conformal shifts are refitted on all 52
     backtest origins and applied, giving P5 ... P95 per day.
  3. Coherent numbers: MinT with the backtest error covariance makes
     arrivals + departures = market and markets = terminal for the median;
     each node's calibrated band moves with its reconciled median.
  4. Why each day differs: exact Shapley values of the three covariate
     groups (schedule, events, calendar) from 8 TimesFM runs per family.
  5. Scenarios TimesFM can answer: for every day, announce an event, cancel
     10% of the schedule, or add a route (6 movements), and re-forecast.
  6. Track record: the week-ahead forecast and band against the actual for
     every day of the backtest year.

Writes outputs/forecast_bundle.json for flow_demo/export_flow_data.py.

    python forecast_final.py      # needs outputs/backtest.csv.gz (forecast_eval.py)
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import calibration as cal
import metrics as mx
import real_data
from forecast_dublin_airport import CHECKPOINT, HORIZON_DAYS, ROOT
from forecast_eval import CAL_COLS, FAMILY_LABELS, MODEL_LABELS, QCOLS, TFM_MODELS, node_matrix, series_name
from pipeline import GROUP_LABELS, GROUPS, Engine, build_data, families, run_models, shapley
from reconcile import hierarchy, mint_projection, shrunk_covariance

OUT = ROOT / "outputs"
SCENARIOS = {
    "event": "An event is announced for the day (airlines add 5% seats)",
    "cancel": "10% of the day's schedule is cancelled in advance",
    "extra": "A new route adds 6 movements (T1, Europe city)",
}


def scenario_pf(fam, origin: int, day: int, kind: str) -> np.ndarray:
    pf = fam.pf.copy()
    t = origin + day
    sched = fam.groups["schedule"]
    if kind == "event":
        pf[fam.groups["events"], t] = 1.0
        pf[sched, t] *= 1.05
    elif kind == "cancel":
        pf[sched, t] *= 0.90
    elif kind == "extra":
        pf[fam.extra_row, t] += 6.0
    return pf


def r(x, nd: int = 0):
    a = np.round(np.asarray(x, float), nd)
    return a.astype(int).tolist() if nd == 0 else a.tolist()


def main() -> None:
    t_start = time.perf_counter()
    data = build_data()
    engine = Engine()
    fams = families(data)
    origin = data.final_origin
    h = HORIZON_DAYS
    bt = pd.read_csv(OUT / "backtest.csv.gz")
    origins = sorted(bt["origin"].unique())
    print(f"Calibrating on {len(origins)} backtest origins")

    # 1-2. Forecasts and calibrated bands.
    horizon_event = data.frame["event_intensity"].to_numpy()[origin:origin + h] > 0
    series = {}
    for fam in fams:
        runs = run_models(engine, fam, origin)
        for i, key in enumerate(fam.keys):
            name = series_name(key)
            entry = {"family": fam.name, "label": fam.labels[i], "actual": fam.y[i, origin:origin + h].astype(float)}
            for model in TFM_MODELS:
                g = bt[(bt["family"] == fam.name) & (bt["series"] == name) & (bt["model"] == model)]
                shifts = cal.fit(g["actual"], g[QCOLS].to_numpy(), g["h"], g["event"])
                q = runs[model][1][i]
                entry[model] = {"point": runs[model][0][i], "q": cal.apply(q, np.arange(h), shifts, horizon_event), "raw": q}
            series[(fam.name, name)] = entry
    print(f"Forecasts: {engine.report()}")

    # 3. MinT on terminals / markets / directions.
    nodes, _, s = hierarchy()
    fam_for = lambda n: "terminals" if len(n) == 1 else (f"markets_{n[0]}" if len(n) == 2 else f"directions_{n[0]}")
    node_ids = [(fam_for(n), "/".join(n)) for n in nodes]
    projections = {}
    for model in ("covariates", "univariate"):
        yhat, _ = node_matrix(bt, model)
        y, _ = node_matrix(bt, model, "actual")
        w, lam = shrunk_covariance(y.values - yhat.values)
        p = mint_projection(s, w)
        projections[model] = (p, lam)
        point = np.stack([series[k][model]["point"] for k in node_ids], axis=1)  # (h, nodes)
        rec_point = point @ p.T
        # Bands: each node keeps its own calibrated spread, re-centred on the
        # reconciled median. (Projecting every quantile level through MinT
        # narrows the bands of the lower levels; tested, it under-covers.)
        qs = np.stack([series[k][model]["q"] for k in node_ids], axis=1)  # (h, nodes, 11)
        rec_q = np.maximum(qs + (rec_point - point)[:, :, None], 0.0)
        for j, k in enumerate(node_ids):
            series[k][model]["rec_point"] = rec_point[:, j]
            series[k][model]["rec_q"] = rec_q[:, j, :]
        gap = np.abs(point @ (np.eye(len(nodes)) - p).T).max()
        print(f"MinT {model}: shrinkage {lam:.2f}, largest base incoherence {gap:,.0f} pax, reconciled exactly")

    # 4. Shapley explanations.
    why = {}
    for fam in fams:
        base, phi = shapley(engine, fam, origin)
        for i, key in enumerate(fam.keys):
            why[(fam.name, series_name(key))] = {"base": base[i], **{g: phi[g][i] for g in GROUPS}}
            total = base[i] + sum(phi[g][i] for g in GROUPS)
            assert np.allclose(total, series[(fam.name, series_name(key))]["covariates"]["point"], rtol=1e-4, atol=1.0)
    print(f"Shapley: {engine.report()}")

    # 5. Scenarios, as multipliers on the covariate forecast for that day.
    scen = {k: {kind: np.ones(h) for kind in SCENARIOS} for k in series}
    for fam in fams:
        for kind in SCENARIOS:
            for day in range(h):
                point = engine.joint(fam.y, origin, scenario_pf(fam, origin, day, kind), fam.po)[0]
                for i, key in enumerate(fam.keys):
                    base_pt = series[(fam.name, series_name(key))]["covariates"]["point"][day]
                    scen[(fam.name, series_name(key))][kind][day] = point[i, day] / max(1.0, base_pt)
    # Make hierarchy scenarios coherent too: reconcile the scenario node vectors.
    p_cov = projections["covariates"][0]
    for kind in SCENARIOS:
        for day in range(h):
            vec = np.array([series[k]["covariates"]["point"][day] * scen[k][kind][day] for k in node_ids])
            rec = p_cov @ vec
            for j, k in enumerate(node_ids):
                scen[k][kind][day] = rec[j] / max(1.0, series[k]["covariates"]["rec_point"][day])
    print(f"Scenarios: {engine.report()}")

    # 6. Week-ahead track record over the backtest year.
    history = {}
    wk = bt[(bt["h"] < 7) & bt["model"].isin(["covariates", "univariate", "schedule"])]
    shifts_all = {}
    for (fam_name, name), g in bt[bt["model"] == "covariates"].groupby(["family", "series"]):
        shifts_all[(fam_name, name)] = cal.fit(g["actual"], g[QCOLS].to_numpy(), g["h"], g["event"])
    for fam_name, name in [("terminals", "t1"), ("terminals", "t2"), ("landside", "taxi_pickups_t1"),
                           ("landside", "taxi_pickups_t2"), ("markets_t2", "t2/na"), ("markets_t1", "t1/eu_city")]:
        g = wk[(wk["family"] == fam_name) & (wk["series"] == name)]
        cov = g[g["model"] == "covariates"].sort_values("t")
        uni = g[g["model"] == "univariate"].set_index("t").reindex(cov["t"])
        sch = g[g["model"] == "schedule"].set_index("t").reindex(cov["t"])
        band = cal.apply(cov[QCOLS].to_numpy(), cov["h"].to_numpy(), shifts_all[(fam_name, name)], cov["event"].to_numpy())
        history[f"{fam_name}:{name}"] = {
            "start": str(pd.Timestamp(cov["date"].iloc[0]).date()),
            "actual": r(cov["actual"]), "cov": r(cov["point"]), "uni": r(uni["point"]), "sched": r(sch["point"]),
            "lo": r(band[:, 1]), "hi": r(band[:, 9]),
            "wape": {"cov": mx.wape(cov["actual"], cov["point"]), "uni": mx.wape(cov["actual"], uni["point"]),
                     "sched": mx.wape(cov["actual"], sch["point"])},
            "cov80": mx.coverage(cov["actual"], band[:, 1], band[:, 9]),
        }
    # Context window for fan charts: last 120 days of actuals for every series.
    context = {f"{fam.name}:{series_name(key)}": r(fam.y[i, origin - 120:origin]) for fam in fams for i, key in enumerate(fam.keys)}

    # Accuracy tables from the evaluation.
    board = pd.read_csv(OUT / "leaderboard.csv")
    comp = pd.read_csv(OUT / "comparisons.csv")
    recon = pd.read_csv(OUT / "reconciliation.csv")
    test = bt[bt["origin"].isin(origins[len(origins) // 2:]) & (bt["model"] == "covariates")]
    calib_origins = set(origins[: len(origins) // 2])
    rel_raw = mx.reliability(test["actual"], test[QCOLS].to_numpy())
    # reliability after calibration fitted on the first half only
    parts = []
    for (fam_name, name), g in bt[bt["model"] == "covariates"].groupby(["family", "series"]):
        fit_rows = g[g["origin"].isin(calib_origins)]
        sh = cal.fit(fit_rows["actual"], fit_rows[QCOLS].to_numpy(), fit_rows["h"], fit_rows["event"])
        tg = g[~g["origin"].isin(calib_origins)]
        parts.append((tg["actual"].to_numpy(), cal.apply(tg[QCOLS].to_numpy(), tg["h"].to_numpy(), sh, tg["event"].to_numpy())))
    rel_cal = mx.reliability(np.concatenate([a for a, _ in parts]), np.concatenate([q for _, q in parts]), cal.LEVELS)

    monthly = real_data.load_monthly()
    r12 = real_data.rolling_12m(monthly)
    f = data.frame
    bundle = {
        "meta": {
            "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "origin": str(pd.Timestamp(f["date"].iloc[origin]).date()),
            "horizon": h,
            "checkpoint": CHECKPOINT,
            "backtest": {"origins": len(origins), "first": str(pd.Timestamp(f["date"].iloc[origins[0]]).date()),
                         "last": str(pd.Timestamp(f["date"].iloc[origins[-1]]).date()),
                         "calibration": len(calib_origins), "test": len(origins) - len(calib_origins)},
            "levels": cal.LEVELS.tolist(),
            "mint": {m: round(lam, 3) for m, (_, lam) in projections.items()},
            "groups": GROUP_LABELS,
            "scenarios": SCENARIOS,
            "models": MODEL_LABELS,
            "families": FAMILY_LABELS,
            "cso": {
                "source": "CSO PxStat TAM08 / TAM07 (CC BY 4.0)",
                "months": [str(m) for m in monthly.index[-27:]],
                "passengers": monthly["passengers"].iloc[-27:].astype(int).tolist(),
                "rolling12": int(r12.iloc[-1]), "rolling12Month": str(r12.index[-1]),
                "cap": real_data.PLANNING_CAP,
                "lastMonth": str(monthly.index[-1]),
            },
        },
        "series": {},
        "history": history,
        "context": context,
        "accuracy": {
            "leaderboard": board.round(5).to_dict(orient="records"),
            "comparisons": comp.round(5).to_dict(orient="records"),
            "reconciliation": recon.round(5).to_dict(orient="records"),
            "reliability": {"levels_raw": cal.MODEL_LEVELS.tolist(), "raw": np.round(rel_raw, 4).tolist(),
                            "levels_cal": cal.LEVELS.tolist(), "cal": np.round(rel_cal, 4).tolist()},
        },
    }
    for (fam_name, name), e in series.items():
        out = {"family": fam_name, "label": e["label"], "actual": r(e["actual"])}
        for model in TFM_MODELS:
            m = e[model]
            out[model] = {"point": r(m["point"]), "q": [r(row) for row in m["q"]]}
            if "rec_point" in m:
                out[model]["rec"] = r(m["rec_point"])
                out[model]["recQ"] = [r(row) for row in m["rec_q"]]
        w = why[(fam_name, name)]
        out["why"] = {k: r(v) for k, v in w.items()}
        out["scen"] = {k: r(v, 4) for k, v in scen[(fam_name, name)].items()}
        bundle["series"][f"{fam_name}:{name}"] = out
    (OUT / "forecast_bundle.json").write_text(json.dumps(bundle))
    print(f"Wrote outputs/forecast_bundle.json ({(OUT / 'forecast_bundle.json').stat().st_size / 1e6:.1f} MB) "
          f"in {time.perf_counter() - t_start:.0f}s; {engine.report()}")


if __name__ == "__main__":
    main()
