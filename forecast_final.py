"""The production forecast for the March 2026 holdout, with everything the
operations twin needs to explain and stress it.

  1. TimesFM 3 for every family: history only, jointly, and with covariates.
  2. Calibrated bands: the split-conformal shifts are refitted on all 52
     backtest origins and applied, giving P5 ... P95 per day.
  3. Coherent numbers: MinT with the backtest error covariance makes
     arrivals + departures = market and markets = terminal for the median;
     each node's calibrated band moves with its reconciled median.
  4. Why each day differs: exact Shapley values of the covariate groups
     (schedule, events, calendar and, if the production model uses it, the
     weather forecast) from 8 or 16 TimesFM runs per family.
  5. Scenarios TimesFM can answer: for every day, announce an event, cancel
     10% of the schedule, or add a route (6 movements), and re-forecast.
  6. Track record: the week-ahead forecast and band against the actual for
     every day of the backtest year.
  7. Weather: the production model is chosen among no weather, ECMWF IFS
     and ECMWF AIFS on the calibration origins only; the day's observed
     weather, the as-issued forecasts and the disruption probabilities go
     to the twin.

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
import weather_data as wxd
from forecast_eval import FAMILY_LABELS, MODEL_LABELS, QCOLS, RISK_FLAG, TFM_MODELS, WX_VARIANTS, node_matrix, series_name
from pipeline import GROUP_LABELS, GROUPS, WX_GROUP, Engine, Weather, build_data, families, pf_for, run_models, shapley
from weather_risk import TARGETS, RiskModel, model_skill
from reconcile import hierarchy, mint_projection, shrunk_covariance

OUT = ROOT / "outputs"
SCENARIOS = {
    "event": "An event is announced for the day (airlines add 5% seats)",
    "cancel": "10% of the day's schedule is cancelled in advance",
    "extra": "A new route adds 6 movements (T1, Europe city)",
}


def scenario_pf(fam, origin: int, day: int, kind: str, wx=None, wx_model=None) -> np.ndarray:
    pf = pf_for(fam, origin, HORIZON_DAYS, wx, wx_model).copy()
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
    bt = pd.read_csv(OUT / "backtest.csv.gz", parse_dates=["date"])
    origins = sorted(bt["origin"].unique())
    calib_origins = set(origins[: len(origins) // 2])
    print(f"Calibrating on {len(origins)} backtest origins")

    # Production model: the weather variant with the lowest error on the
    # calibration origins (the scored half is never used to choose).
    sel = bt[bt["origin"].isin(calib_origins) & bt["model"].isin(WX_VARIANTS)]
    choice = {m: mx.wape(g["actual"], g["point"]) for m, g in sel.groupby("model")}
    # Tie-break (fixed in advance): among variants within 0.005 WAPE points of
    # the best, prefer the gated weather models (they only differ from the
    # no-weather model on days their own risk forecast flags), then no
    # weather, then always-on weather.
    dis = sel[sel["disruption"] & (sel["h"] < 7)]
    dis_wape = {m: mx.wape(g["actual"], g["point"]) for m, g in dis.groupby("model")}
    best = min(choice.values())
    near = [m for m, v in choice.items() if v <= best + 0.00005]
    preference = ("gate_aifs", "gate_ifs", "covariates", "cov_aifs", "cov_ifs")
    prod = min(near, key=lambda m: (preference.index(m), dis_wape.get(m, 1.0)))
    prod_wx = prod.split("_", 1)[1] if prod != "covariates" else None
    print("Production model by calibration-half WAPE: " + ", ".join(f"{m} {v * 100:.2f}%" for m, v in choice.items()) + f" -> {prod}")

    wx = Weather(fams[0].dates)
    rm = RiskModel().fit(final=True)
    horizon_dates = [fams[0].dates[origin + j] for j in range(h)]
    asof = {m: wxd.forecast_asof(horizon_dates[0], h, m) for m in ("ifs", "aifs")}
    risk = {m: [rm.prob(m, j + 1, asof[m][:, j], horizon_dates[j]) for j in range(h)] for m in asof}
    flags = {m: np.array([risk[m][j]["any"] >= RISK_FLAG and j < 7 for j in range(h)]) for m in risk}
    wx_flag = flags["ifs"] | flags["aifs"]
    print("Weather risk flagged days: " + ", ".join(f"{m}: {[str(horizon_dates[j]) for j in np.flatnonzero(f)]}" for m, f in flags.items()))

    # 1-2. Forecasts and calibrated bands.
    horizon_event = data.frame["event_intensity"].to_numpy()[origin:origin + h] > 0
    group = cal.day_group(horizon_event, wx_flag)
    series = {}
    for fam in fams:
        runs = run_models(engine, fam, origin, wx=wx)
        for m in ("ifs", "aifs"):  # gated: weather-aware only on flagged days
            use = flags[m][None, :]
            runs[f"gate_{m}"] = (np.where(use, runs[f"cov_{m}"][0], runs["covariates"][0]),
                                 np.where(use[..., None], runs[f"cov_{m}"][1], runs["covariates"][1]))
        for i, key in enumerate(fam.keys):
            name = series_name(key)
            entry = {"family": fam.name, "label": fam.labels[i], "actual": fam.y[i, origin:origin + h].astype(float)}
            for model in TFM_MODELS:
                g = bt[(bt["family"] == fam.name) & (bt["series"] == name) & (bt["model"] == model)]
                shifts = cal.fit(g["actual"], g[QCOLS].to_numpy(), g["h"], cal.day_group(g["event"], g["wxrisk"]))
                q = runs[model][1][i]
                entry[model] = {"point": runs[model][0][i], "q": cal.apply(q, np.arange(h), shifts, group), "raw": q}
            entry["no_weather"] = entry["covariates"]
            entry["covariates"] = entry[prod]
            series[(fam.name, name)] = entry
    print(f"Forecasts: {engine.report()}")

    # 3. MinT on terminals / markets / directions.
    nodes, _, s = hierarchy()
    fam_for = lambda n: "terminals" if len(n) == 1 else (f"markets_{n[0]}" if len(n) == 2 else f"directions_{n[0]}")
    node_ids = [(fam_for(n), "/".join(n)) for n in nodes]
    projections = {}
    for model in ("covariates", "univariate"):
        src = prod if model == "covariates" else model
        yhat, _ = node_matrix(bt, src)
        y, _ = node_matrix(bt, src, "actual")
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
    groups = GROUPS + ((WX_GROUP,) if prod_wx else ())
    use_wx = flags[prod_wx] if prod.startswith("gate_") else np.full(h, prod_wx is not None)
    for fam in fams:
        base, phi = shapley(engine, fam, origin, wx, prod_wx)
        if prod_wx and not use_wx.all():
            # Gated model: days without a weather flag use the no-weather decomposition.
            base0, phi0 = shapley(engine, fam, origin)
            base = np.where(use_wx[None, :], base, base0)
            phi = {g: np.where(use_wx[None, :], phi[g], phi0.get(g, 0.0)) for g in groups}
        for i, key in enumerate(fam.keys):
            why[(fam.name, series_name(key))] = {"base": base[i], **{g: phi[g][i] for g in groups}}
            total = base[i] + sum(phi[g][i] for g in groups)
            assert np.allclose(total, series[(fam.name, series_name(key))]["covariates"]["point"], rtol=1e-4, atol=1.0)
    print(f"Shapley: {engine.report()}")

    # 5. Scenarios, as multipliers on the covariate forecast for that day.
    scen = {k: {kind: np.ones(h) for kind in SCENARIOS} for k in series}
    for fam in fams:
        for kind in SCENARIOS:
            for day in range(h):
                wx_model = prod_wx if use_wx[day] else None
                point = engine.joint(fam.y, origin, scenario_pf(fam, origin, day, kind, wx, wx_model), fam.po)[0]
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

    # 6b. Day-ahead refresh: for each March day, re-forecast the evening
    # before with everything known by then (latest passengers, the latest
    # weather forecast). Same production rule, so weather counts only when
    # its own risk model flags the day.
    dayahead = {k: {"point": np.zeros(h), "q": np.zeros((h, len(cal.LEVELS)))} for k in series}
    da_flags = {}
    da_engine = Engine(horizon=1)
    da_engine._model = engine.model
    for j in range(h):
        o = origin + j
        d0 = fams[0].dates[o]
        f_m = {m: wxd.forecast_asof(d0, 1, m)[:, 0] for m in ("ifs", "aifs")}
        p_any = {m: rm.prob(m, 1, f_m[m], d0)["any"] for m in f_m}
        da_flags[str(d0)] = {m: round(p, 3) for m, p in p_any.items()}
        use_m = prod_wx if (prod_wx and (not prod.startswith("gate_") or p_any[prod_wx] >= RISK_FLAG)) else None
        g0 = cal.day_group(horizon_event[j:j + 1], np.array([max(p_any.values()) >= RISK_FLAG]))
        for fam in fams:
            runs = run_models(da_engine, fam, o, joint_plain=False, wx=wx)
            pt, q = runs[f"cov_{use_m}"] if use_m else runs["covariates"]
            for i, key in enumerate(fam.keys):
                k = (fam.name, series_name(key))
                gb = bt[(bt["family"] == fam.name) & (bt["series"] == k[1]) & (bt["model"] == prod)]
                sh = cal.fit(gb["actual"], gb[QCOLS].to_numpy(), gb["h"], cal.day_group(gb["event"], gb["wxrisk"]))
                dayahead[k]["point"][j] = pt[i, 0]
                dayahead[k]["q"][j] = cal.apply(q[i, :1], np.array([0]), sh, g0)[0]
    p_cov = projections["covariates"][0]
    for j in range(h):
        vec = np.array([dayahead[k]["point"][j] for k in node_ids])
        rec = p_cov @ vec
        for jj, k in enumerate(node_ids):
            dayahead[k]["q"][j] = np.maximum(dayahead[k]["q"][j] + rec[jj] - vec[jj], 0)
            dayahead[k]["point"][j] = rec[jj]
    print(f"Day-ahead refresh: {engine.report()}")

    # 6. Week-ahead track record over the backtest year.
    history = {}
    wk = bt[(bt["h"] < 7) & bt["model"].isin([prod, "univariate", "schedule"])]
    shifts_all = {}
    for (fam_name, name), g in bt[bt["model"] == prod].groupby(["family", "series"]):
        shifts_all[(fam_name, name)] = cal.fit(g["actual"], g[QCOLS].to_numpy(), g["h"], cal.day_group(g["event"], g["wxrisk"]))
    for fam_name, name in [("terminals", "t1"), ("terminals", "t2"), ("landside", "taxi_pickups_t1"),
                           ("landside", "taxi_pickups_t2"), ("markets_t2", "t2/na"), ("markets_t1", "t1/eu_city")]:
        g = wk[(wk["family"] == fam_name) & (wk["series"] == name)]
        cov = g[g["model"] == prod].sort_values("t")
        uni = g[g["model"] == "univariate"].set_index("t").reindex(cov["t"])
        sch = g[g["model"] == "schedule"].set_index("t").reindex(cov["t"])
        band = cal.apply(cov[QCOLS].to_numpy(), cov["h"].to_numpy(), shifts_all[(fam_name, name)], cal.day_group(cov["event"], cov["wxrisk"]))
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
    test = bt[bt["origin"].isin(origins[len(origins) // 2:]) & (bt["model"] == prod)]
    rel_raw = mx.reliability(test["actual"], test[QCOLS].to_numpy())
    # reliability after calibration fitted on the first half only
    parts = []
    for (fam_name, name), g in bt[bt["model"] == prod].groupby(["family", "series"]):
        fit_rows = g[g["origin"].isin(calib_origins)]
        sh = cal.fit(fit_rows["actual"], fit_rows[QCOLS].to_numpy(), fit_rows["h"], cal.day_group(fit_rows["event"], fit_rows["wxrisk"]))
        tg = g[~g["origin"].isin(calib_origins)]
        parts.append((tg["actual"].to_numpy(), cal.apply(tg[QCOLS].to_numpy(), tg["h"].to_numpy(), sh, cal.day_group(tg["event"], tg["wxrisk"]))))
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
            "production": {"model": prod, "label": MODEL_LABELS[prod], "weather": prod_wx,
                           "calibrationWape": {m: round(v, 5) for m, v in choice.items()},
                           "calibrationDisruptionWk1Wape": {m: round(v, 5) for m, v in dis_wape.items()}},
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
        "weather": weather_block(fams[0].dates, origin, h, asof, risk, rm, da_flags),
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
        out["variants"] = {m: r(e[m]["point"]) for m in ("no_weather", "cov_ifs", "cov_aifs")}
        for model in ("univariate", "joint", "covariates"):
            m = e[model]
            out[model] = {"point": r(m["point"]), "q": [r(row) for row in m["q"]]}
            if "rec_point" in m:
                out[model]["rec"] = r(m["rec_point"])
                out[model]["recQ"] = [r(row) for row in m["rec_q"]]
        w = why[(fam_name, name)]
        out["why"] = {k: r(v) for k, v in w.items()}
        out["scen"] = {k: r(v, 4) for k, v in scen[(fam_name, name)].items()}
        out["dayahead"] = {"point": r(dayahead[(fam_name, name)]["point"]), "q": [r(row) for row in dayahead[(fam_name, name)]["q"]]}
        bundle["series"][f"{fam_name}:{name}"] = out
    (OUT / "forecast_bundle.json").write_text(json.dumps(bundle))
    print(f"Wrote outputs/forecast_bundle.json ({(OUT / 'forecast_bundle.json').stat().st_size / 1e6:.1f} MB) "
          f"in {time.perf_counter() - t_start:.0f}s; {engine.report()}")


def risk_by_lead(d, rm: RiskModel) -> dict:
    """How the disruption warning built up: P(any) from the forecast issued
    7 ... 1 days before the day, per model (None where the archive is empty)."""
    fc = rm.fc
    out = {}
    for m in ("ifs", "aifs"):
        sub = fc[(fc["model"] == m) & (fc["date"] == d)].set_index("lead")
        out[m] = [round(rm.prob(m, k, sub.loc[k, list(wxd.FC_FEATURES)].to_numpy(float), d)["any"], 3)
                  if k in sub.index else None for k in range(7, 0, -1)]
    return out


def weather_block(dates, origin: int, h: int, asof: dict, risk: dict, rm: RiskModel, da_flags: dict) -> dict:
    """Observed and forecast weather for every horizon day, hourly and daily."""
    days = dates[origin:origin + h]
    obs = wxd.daily_observed()
    dis = wxd.disruption(days)
    me = pd.read_csv(wxd.WX / "met_eireann_hourly.csv", parse_dates=["time"])
    mt = pd.read_csv(wxd.WX / "eidw_metar_hourly.csv", parse_dates=["time"])
    hourly = me.merge(mt, on="time", how="left", suffixes=("", "_metar"))
    fch = pd.read_csv(wxd.WX / "ecmwf_hourly_dayahead_2026_03.csv", parse_dates=["time"])
    out_days = []
    for j, d in enumerate(days):
        o = obs.loc[d]
        hh = hourly[hourly["time"].dt.date == d].sort_values("time")
        vis = hh["vis_m_metar"].fillna(hh["vis_m"])
        ceil = hh["ceiling_ft"].fillna(hh["ceiling_100ft"].where(hh["ceiling_100ft"] < 999) * 100)
        f_by = {m: fch[(fch["model"] == m) & (fch["time"].dt.date == d)].sort_values("time") for m in ("ifs", "aifs")}
        out_days.append({
            "date": str(d),
            "obs": {"gust": float(o["gust_max_kt"]), "windMax": float(o["wind_max_kt"]), "rain": round(float(o["rain_mm"]), 1),
                    "tmin": float(o["tmin"]), "tmax": float(o["tmax"]), "lvpHours": int(o["lvp_hours"]),
                    "snow": bool(o["snow"]), "freezing": bool(o["freezing"]), "thunder": bool(o["thunder"])},
            "disruption": {"name": dis.loc[d, "name"], "cancelPct": round(100 * float(dis.loc[d, "cancel"]), 1),
                           "delayExtra": round(float(dis.loc[d, "delay_extra"]), 1)},
            "lead": j + 1 if j < 7 else None,
            "forecast": {m: dict(zip(wxd.FC_FEATURES, [round(float(v), 2) for v in asof[m][:, j]])) for m in asof},
            "risk": {m: {t: round(v, 3) for t, v in risk[m][j].items()} for m in risk},
            "riskDayAhead": da_flags[str(d)],
            "riskByLead": risk_by_lead(d, rm),
            "hourly": {
                "obs": {
                    "vis": [None if pd.isna(v) else int(v) for v in vis], "ceil": [None if pd.isna(v) else int(v) for v in ceil],
                    "gust": [None if pd.isna(v) else float(v) for v in hh["gust_kt"]],
                    "wind": [None if pd.isna(v) else float(v) for v in hh["wind_kt"]],
                    "dir": [None if pd.isna(v) else int(v) for v in hh["wind_dir"]],
                    "rain": [None if pd.isna(v) else float(v) for v in hh["rain_mm"]],
                    "temp": [None if pd.isna(v) else float(v) for v in hh["temp_c"]],
                },
                "dayAhead": {m: {"wind": r(f["wind_kt"], 1), "dir": r(f["wind_dir"]), "rain": r(f["precip_mm"], 2),
                                 "temp": r(f["temp_c"], 1), "dpd": r(f["temp_c"] - f["dewpt_c"], 1)} for m, f in f_by.items()},
            },
        })
    return {
        "days": out_days,
        "models": {m: wxd.MODEL_LABELS[m] for m in ("ifs", "aifs")},
        "features": wxd.FC_LABELS,
        "targets": TARGETS,
        "riskScores": pd.DataFrame(RiskModel().fit().scores).round(4).to_dict(orient="records"),
        "skill": model_skill().round(4).to_dict(orient="records"),
        "climateRisk": {t: round(v, 4) for t, v in rm.base.items()},
        "sources": "Met Éireann (Dublin Airport station 532, CC BY 4.0); METAR via Iowa Environmental Mesonet; "
                   "ECMWF IFS and AIFS forecasts as issued, via the Open-Meteo Previous Runs API (CC BY 4.0).",
    }


if __name__ == "__main__":
    main()
