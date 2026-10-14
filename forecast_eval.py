"""Rolling-origin backtest: how good are these forecasts, really?

One forecast origin tells you very little: 28 days, a handful of events.
This script re-runs every forecast from 52 weekly origins (March 2025 to
January 2026), each seeing only the data before it and the covariates that
would genuinely have been known, and scores them 1-28 days ahead against:

  four classical baselines   seasonal naive (last week, last year),
                             Holt-Winters, the planner's schedule x load method
  TimesFM, three ways        history only, jointly, jointly with covariates

The origins are split in time. The first 26 calibrate the uncertainty bands
(split conformal, calibration.py) and the hierarchy weights (MinT,
reconcile.py); the last 26 are scored as unseen. Differences between models
carry 95% intervals from a bootstrap over origins, so a slice with few
events is visibly uncertain rather than quietly over-claimed.

    python forecast_eval.py            # full backtest (about 4 minutes, cached after)
    python forecast_eval.py --weeks 12 # quicker
"""

from __future__ import annotations

import argparse
import json
import time

import numpy as np
import pandas as pd

import baselines as bl
import calibration as cal
import metrics as mx
from forecast_dublin_airport import HORIZON_DAYS, ROOT
from pipeline import Data, Engine, Weather, backtest_origins, build_data, families, run_models
from weather_risk import RiskModel
from reconcile import hierarchy, mint_projection, reconcile, shrunk_covariance

OUT = ROOT / "outputs"
TFM_MODELS = ("univariate", "joint", "covariates", "cov_ifs", "cov_aifs", "gate_ifs", "gate_aifs")
WX_VARIANTS = ("covariates", "cov_ifs", "cov_aifs", "gate_ifs", "gate_aifs")
RISK_FLAG = 0.2  # forecast probability of a weather disruption that counts as "high risk"
MODEL_LABELS = {
    "cov_ifs": "TimesFM 3 + schedule, events & ECMWF IFS weather",
    "cov_aifs": "TimesFM 3 + schedule, events & ECMWF AIFS weather",
    "gate_ifs": "TimesFM 3, IFS weather when a disruption is forecast",
    "gate_aifs": "TimesFM 3, AIFS weather when a disruption is forecast",
    "covariates": "TimesFM 3 + schedule & events",
    "joint": "TimesFM 3, joint, no covariates",
    "univariate": "TimesFM 3, history only",
    **bl.BASELINE_LABELS,
}
FAMILY_LABELS = {
    "terminals": "Terminal passengers",
    "markets_t1": "T1 by market",
    "markets_t2": "T2 by market",
    "directions_t1": "T1 arrivals/departures",
    "directions_t2": "T2 arrivals/departures",
    "landside": "Taxis, buses, car park",
}


def series_name(key: tuple) -> str:
    return "/".join(key)


def run_backtest(data: Data, engine: Engine, origins: list[int]) -> pd.DataFrame:
    fams = families(data)
    wx = Weather(fams[0].dates)
    f = data.frame
    event = f["event_intensity"].to_numpy() > 0
    disruption = f["disruption_name"].fillna("").ne("").to_numpy()
    dates = f["date"].to_numpy()
    h = engine.horizon
    hw_params: dict[tuple, dict] = {}
    cols: dict[str, list] = {k: [] for k in ("origin", "t", "h", "family", "series", "model", "actual", "point", "scale")}
    qcols: list[np.ndarray] = []
    nan_q = np.full((h, 9), np.nan)
    t0 = time.perf_counter()
    for oi, origin in enumerate(origins):
        steps = np.arange(origin, origin + h)
        for fam in fams:
            tfm = run_models(engine, fam, origin, wx=wx)
            for i, key in enumerate(fam.keys):
                y = fam.y[i].astype(float)
                hist = y[:origin]
                scale = mx.snaive_scale(hist[-365:])
                name = series_name(key)
                preds = {m: (tfm[m][0][i], tfm[m][1][i]) for m in TFM_MODELS if m in tfm}
                pkey = (fam.name, name)
                if pkey not in hw_params or oi % 13 == 0:
                    hw_params[pkey] = bl.hw_fit(hist)
                preds["snaive7"] = (bl.snaive7(hist, h), nan_q)
                preds["snaive364"] = (bl.snaive364(hist, h), nan_q)
                preds["holt_winters"] = (bl.holt_winters(hist, h, hw_params[pkey]), nan_q)
                preds["schedule"] = (bl.schedule_ratio(hist, fam.primary[i][: origin + h], h), nan_q)
                for model, (point, q) in preds.items():
                    cols["origin"].extend([origin] * h)
                    cols["t"].extend(steps)
                    cols["h"].extend(range(h))
                    cols["family"].extend([fam.name] * h)
                    cols["series"].extend([name] * h)
                    cols["model"].extend([model] * h)
                    cols["actual"].extend(y[steps])
                    cols["point"].extend(np.asarray(point, float)[:h])
                    cols["scale"].extend([scale] * h)
                    qcols.append(np.asarray(q, float)[:h])
        if oi % 8 == 0 or oi == len(origins) - 1:
            print(f"  origin {oi + 1}/{len(origins)} ({pd.Timestamp(dates[origin]):%d %b %Y})  {engine.report()}  {time.perf_counter() - t0:.0f}s")
    out = pd.DataFrame(cols)
    q = np.concatenate(qcols)
    for j, level in enumerate(cal.MODEL_LEVELS):
        out[f"q{int(level * 100):02d}"] = q[:, j]
    out["date"] = pd.to_datetime(dates[out["t"].to_numpy()])
    out["event"] = event[out["t"].to_numpy()]
    out["disruption"] = disruption[out["t"].to_numpy()]
    for m in ("ifs", "aifs"):
        out[f"wxrisk_{m}"] = weather_risk_flags(out, m)
    out["wxrisk"] = out["wxrisk_ifs"] | out["wxrisk_aifs"]
    return add_gated(out)


def add_gated(bt: pd.DataFrame) -> pd.DataFrame:
    """Gated models: the no-weather covariate forecast, except on days in the
    first week that the weather model's own risk forecast flags, where the
    weather-aware forecast is used. Weather is noise on calm days and signal
    on stormy ones; the gate lets each model speak where it knows something."""
    key = ["origin", "t", "family", "series"]
    base = bt[bt["model"] == "covariates"].set_index(key)
    parts = [bt]
    for m in ("ifs", "aifs"):
        wxm = bt[bt["model"] == f"cov_{m}"].set_index(key).reindex(base.index)
        use = (base[f"wxrisk_{m}"] & (base["h"] < 7)).to_numpy()
        g = base.copy()
        cols = ["point", *QCOLS]
        g.loc[use, cols] = wxm.loc[use, cols].to_numpy()
        g["model"] = f"gate_{m}"
        parts.append(g.reset_index())
    return pd.concat(parts, ignore_index=True)


def weather_risk_flags(bt: pd.DataFrame, model: str = "ifs") -> np.ndarray:
    """True where the as-issued forecast (lead h+1 <= 7) gave a weather
    disruption probability of RISK_FLAG or more. Uses the risk model fitted
    on the period before weather_risk.SPLIT only."""
    import weather_data as wxd
    from weather_risk import design, predict, LEAD_BUCKETS

    rm = RiskModel().fit()
    fc = rm.fc[rm.fc["model"] == model]
    keys = bt[["date", "h"]].drop_duplicates().assign(lead=lambda x: x["h"] + 1)
    keys = keys[keys["lead"] <= 7].assign(day=lambda x: x["date"].dt.date)
    m = keys.merge(fc, left_on=["day", "lead"], right_on=["date", "lead"], suffixes=("", "_fc")).dropna(subset=list(wxd.FC_FEATURES))
    p = np.zeros(len(m))
    for lo, hi in LEAD_BUCKETS:
        sel = m["lead"].between(lo, hi).to_numpy()
        if sel.any():
            x = design(m.loc[sel, ["date_fc", *wxd.FC_FEATURES]].rename(columns={"date_fc": "date"}))
            p[sel] = predict(rm.w[(model, lo, "any")], x)
    flagged = set(map(tuple, m.loc[p >= RISK_FLAG, ["date", "h"]].itertuples(index=False, name=None)))
    return np.array([(d, h) in flagged for d, h in zip(bt["date"], bt["h"])])


QCOLS = [f"q{int(l * 100):02d}" for l in cal.MODEL_LEVELS]
CAL_COLS = [f"c{int(round(l * 100)):02d}" for l in cal.LEVELS]


def calibrate(bt: pd.DataFrame, calib_origins: set[int]) -> tuple[pd.DataFrame, dict]:
    """Conformal scales per (family, series, model), fitted the way they would
    be in production: each scored origin uses every forecast whose outcome
    was already known at that origin (online / rolling calibration), so the
    bands keep up with the seasons. Calibration-half origins use the
    calibration half. Returns the frame and the final (all-origin) scales."""
    shifts = {}
    parts = []
    first_test = min(set(bt["origin"]) - calib_origins) if set(bt["origin"]) - calib_origins else None
    for (fam, series, model), g in bt[bt["model"].isin(TFM_MODELS)].groupby(["family", "series", "model"], sort=False):
        grp = cal.day_group(g["event"], g["wxrisk"])
        fit = lambda rows: cal.fit(rows["actual"], rows[QCOLS].to_numpy(), rows["h"], cal.day_group(rows["event"], rows["wxrisk"]))
        cq = np.zeros((len(g), len(CAL_COLS)))
        early = g["origin"].isin(calib_origins).to_numpy()
        s_cal = fit(g[early])
        cq[early] = cal.apply(g.loc[early, QCOLS].to_numpy(), g.loc[early, "h"].to_numpy(), s_cal, grp[early])
        for o in sorted(set(g["origin"]) - calib_origins):
            known = g[g["t"] < o]
            sel = (g["origin"] == o).to_numpy()
            s_o = fit(known)
            cq[sel] = cal.apply(g.loc[sel, QCOLS].to_numpy(), g.loc[sel, "h"].to_numpy(), s_o, grp[sel])
        shifts[(fam, series, model)] = fit(g)
        parts.append(pd.DataFrame(cq, index=g.index, columns=CAL_COLS))
    calq = pd.concat(parts)
    return bt.join(calq), shifts


SLICES = {
    "all": lambda d: np.ones(len(d), bool),
    "ordinary": lambda d: ~(d["event"] | d["disruption"]).to_numpy(),
    "event": lambda d: d["event"].to_numpy(),
    "disruption": lambda d: d["disruption"].to_numpy(),
    "week1": lambda d: (d["h"] < 7).to_numpy(),
    "week4": lambda d: (d["h"] >= 21).to_numpy(),
    "disruption_wk1": lambda d: (d["disruption"] & (d["h"] < 7)).to_numpy(),
    "wx_risk": lambda d: d["wxrisk"].to_numpy(),
}


def leaderboard(test: pd.DataFrame) -> pd.DataFrame:
    rows = []
    for fam, gf in test.groupby("family", sort=False):
        for sl, fn in SLICES.items():
            part = gf[fn(gf)]
            if part.empty:
                continue
            for model, g in part.groupby("model", sort=False):
                row = {
                    "family": fam, "slice": sl, "model": model,
                    "wape": mx.wape(g["actual"], g["point"]),
                    "mase": mx.mase(g["actual"], g["point"], g["scale"]),
                    "bias": mx.bias(g["actual"], g["point"]),
                    "n_days": int(g["t"].nunique()), "n": len(g),
                }
                if model in TFM_MODELS:
                    q = g[QCOLS].to_numpy()
                    row["wql"] = mx.wql(g["actual"], q)
                    row["cov80_raw"] = mx.coverage(g["actual"], g["q10"], g["q90"])
                    row["cov80"] = mx.coverage(g["actual"], g["c10"], g["c90"])
                    row["cov90"] = mx.coverage(g["actual"], g["c05"], g["c95"])
                    row["width80"] = mx.rel_width(g["actual"], g["c10"], g["c90"])
                rows.append(row)
    return pd.DataFrame(rows)


def comparisons(test: pd.DataFrame, ref_model: str = "covariates", others=("univariate", "joint", *bl.BASELINES),
                slices=("all", "event", "ordinary")) -> pd.DataFrame:
    """WAPE(ref_model) - WAPE(other) with bootstrap intervals."""
    rows = []
    for fam, gf in test.groupby("family", sort=False):
        for sl in slices:
            part = gf[SLICES[sl](gf)]
            ref = part[part["model"] == ref_model].set_index(["origin", "t", "series"])
            if ref.empty:
                continue
            for other in others:
                o = part[part["model"] == other].set_index(["origin", "t", "series"]).reindex(ref.index)
                d, lo, hi = mx.bootstrap_diff(
                    ref.index.get_level_values("origin"),
                    ref["point"] - ref["actual"], o["point"] - o["actual"], ref["actual"],
                )
                rows.append({"family": fam, "slice": sl, "ref": ref_model, "vs": other, "diff": d, "lo": lo, "hi": hi,
                             "n_days": int(ref.index.get_level_values("t").nunique())})
    return pd.DataFrame(rows)


def node_matrix(bt: pd.DataFrame, model: str, value: str = "point") -> tuple[pd.DataFrame, list]:
    """Pivot terminal, market and direction forecasts into hierarchy order."""
    nodes, _, _ = hierarchy()
    fam_for = lambda n: "terminals" if len(n) == 1 else (f"markets_{n[0]}" if len(n) == 2 else f"directions_{n[0]}")
    names = [(fam_for(n), n[0] if len(n) == 1 else "/".join(n)) for n in nodes]
    sub = bt[bt["model"] == model]
    sub = sub[sub["family"].isin({a for a, _ in names})]
    wide = sub.pivot_table(index=["origin", "t", "h"], columns=["family", "series"], values=value)
    wide = wide[[pd.MultiIndex.from_tuples(names)[i] for i in range(len(names))]]
    return wide, nodes


def evaluate_reconciliation(bt: pd.DataFrame, calib: set[int]) -> tuple[pd.DataFrame, np.ndarray, float]:
    _, _, s = hierarchy()
    rows = []
    proj = lam = None
    for model in ("covariates", "univariate"):
        yhat, nodes = node_matrix(bt, model)
        y, _ = node_matrix(bt, model, "actual")
        is_cal = yhat.index.get_level_values("origin").isin(calib)
        w, lam_m = shrunk_covariance((y.values - yhat.values)[is_cal])
        p = mint_projection(s, w)
        if model == "covariates":
            proj, lam = p, lam_m
        rec = reconcile(yhat.values, p)
        test = ~is_cal
        levels = {"terminal": [i for i, n in enumerate(nodes) if len(n) == 1],
                  "market": [i for i, n in enumerate(nodes) if len(n) == 2],
                  "arr/dep": [i for i, n in enumerate(nodes) if len(n) == 3]}
        for level, idx in levels.items():
            a = y.values[test][:, idx].ravel()
            rows.append({"model": model, "level": level,
                         "wape_base": mx.wape(a, yhat.values[test][:, idx].ravel()),
                         "wape_mint": mx.wape(a, rec[test][:, idx].ravel())})
        incoherence = np.abs(yhat.values @ (np.eye(len(nodes)) - p).T)[test]
        rows.append({"model": model, "level": "incoherence_base_pax", "wape_base": float(incoherence.mean()), "wape_mint": 0.0})
    return pd.DataFrame(rows), proj, lam


def plot_leaderboard(board: pd.DataFrame, comp: pd.DataFrame, path) -> None:
    import os
    os.environ.setdefault("MPLCONFIGDIR", str(ROOT / ".mplconfig"))
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    order = ["cov_ifs", "cov_aifs", "covariates", "univariate", "schedule", "holt_winters", "snaive7"]
    colors = {"cov_ifs": "#1E3A8A", "cov_aifs": "#7C3AED", "covariates": "#3B82F6", "joint": "#64748B", "univariate": "#C2410C",
              "schedule": "#0F766E", "holt_winters": "#A16207", "snaive7": "#94A3B8", "snaive364": "#CBD5E1"}
    fams = list(FAMILY_LABELS)
    fig, axes = plt.subplots(1, 2, figsize=(14, 5.8), facecolor="white")
    for ax, sl, title in ((axes[0], "all", "All days"), (axes[1], "event", "Event days")):
        x = np.arange(len(fams))
        width = 0.11
        for j, model in enumerate(order):
            vals = [board.query("family == @f and slice == @sl and model == @model")["wape"].mean() * 100 for f in fams]
            ax.bar(x + (j - 3) * width, vals, width, color=colors[model], label=MODEL_LABELS[model])
        ax.set_xticks(x, [FAMILY_LABELS[f] for f in fams], rotation=20, ha="right", fontsize=9)
        ax.set_ylabel("WAPE, % (lower is better)")
        ax.set_title(f"{title}: 26 unseen weekly origins, 1–28 days ahead", loc="left", fontsize=11)
        ax.spines[["top", "right"]].set_visible(False)
        ax.yaxis.grid(True, color="#E2E8F0")
        ax.set_axisbelow(True)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.suptitle("Rolling-origin backtest: TimesFM 3 against classical baselines", x=0.06, ha="left", fontsize=14)
    fig.tight_layout(rect=(0, 0.08, 1, 1))
    fig.legend(handles, labels, frameon=False, fontsize=9, ncols=4, loc="lower center")
    fig.savefig(path, dpi=150)
    plt.close(fig)


def plot_calibration(test: pd.DataFrame, path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    g = test[test["model"] == "covariates"]
    raw = mx.reliability(g["actual"], g[QCOLS].to_numpy())
    calq = mx.reliability(g["actual"], g[CAL_COLS].to_numpy(), cal.LEVELS)
    fig, ax = plt.subplots(figsize=(5.6, 5.2), facecolor="white")
    ax.plot([0, 1], [0, 1], color="#CBD5E1", lw=1)
    ax.plot(cal.MODEL_LEVELS, raw, "o-", color="#C2410C", label="TimesFM quantiles as returned")
    ax.plot(cal.LEVELS, calq, "o-", color="#1D4ED8", label="After split-conformal calibration")
    ax.set_xlabel("Forecast quantile level")
    ax.set_ylabel("Share of actuals at or below it")
    ax.set_title("Are the bands honest? (unseen origins)", loc="left", fontsize=11)
    ax.legend(frameon=False, fontsize=8)
    ax.spines[["top", "right"]].set_visible(False)
    fig.tight_layout()
    fig.savefig(path, dpi=150)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weeks", type=int, default=52)
    args = parser.parse_args()
    data = build_data()
    engine = Engine()
    origins = backtest_origins(data, args.weeks)
    print(f"Backtest: {len(origins)} weekly origins, {pd.Timestamp(data.frame['date'].iloc[origins[0]]):%d %b %Y} "
          f"to {pd.Timestamp(data.frame['date'].iloc[origins[-1]]):%d %b %Y}, {HORIZON_DAYS} days ahead")
    bt = run_backtest(data, engine, origins)
    calib = set(origins[: len(origins) // 2])
    bt, _ = calibrate(bt, calib)
    test = bt[~bt["origin"].isin(calib)]
    board = leaderboard(test)
    comp = pd.concat([
        comparisons(test),
        comparisons(test, "cov_ifs", ("covariates", "cov_aifs"), ("all", "week1", "disruption", "disruption_wk1", "wx_risk")),
        comparisons(test, "cov_aifs", ("covariates",), ("all", "week1", "disruption", "disruption_wk1", "wx_risk")),
        comparisons(test, "gate_ifs", ("covariates", "gate_aifs"), ("all", "disruption", "disruption_wk1", "wx_risk")),
        comparisons(test, "gate_aifs", ("covariates",), ("all", "disruption", "disruption_wk1", "wx_risk")),
    ], ignore_index=True)
    recon, _, lam = evaluate_reconciliation(bt, calib)
    import weather_risk
    risk = pd.DataFrame(RiskModel().fit().scores)
    skill = weather_risk.model_skill()
    OUT.mkdir(exist_ok=True)
    bt.to_csv(OUT / "backtest.csv.gz", index=False)
    board.to_csv(OUT / "leaderboard.csv", index=False)
    comp.to_csv(OUT / "comparisons.csv", index=False)
    recon.to_csv(OUT / "reconciliation.csv", index=False)
    risk.to_csv(OUT / "weather_risk.csv", index=False)
    skill.to_csv(OUT / "weather_skill.csv", index=False)
    plot_leaderboard(board, comp, OUT / "leaderboard.png")
    plot_calibration(test, OUT / "calibration.png")
    docs = ROOT / "docs"
    docs.mkdir(exist_ok=True)
    for name in ("leaderboard.png", "calibration.png"):
        (docs / name).write_bytes((OUT / name).read_bytes())
    print(engine.report())
    print_summary(board, comp, recon, lam)
    print("\nWeather disruption risk, Brier skill vs climatology on the later half (above 0 = useful):")
    print(risk.pivot_table(index=["target", "leads"], columns="model", values="brier_skill").round(3).to_string())
    print("\nRaw weather forecast skill at Dublin, later half:")
    print(skill.pivot_table(index="lead", columns="model", values=["wind_mae_kt", "rain_brier"]).round(3).to_string())


def print_summary(board: pd.DataFrame, comp: pd.DataFrame, recon: pd.DataFrame, lam: float) -> None:
    pd.set_option("display.width", 160)
    wide = board[board["slice"].isin(["all", "event", "disruption", "disruption_wk1"])].pivot_table(index=["family", "slice"], columns="model", values="wape", sort=False) * 100
    print("\nWAPE % on unseen origins (lower is better):")
    print(wide.round(2).to_string())
    cov = board[(board["slice"] == "all") & board["model"].isin(["covariates", "gate_aifs"])][["family", "model", "cov80_raw", "cov80", "cov90", "width80", "wql"]]
    print("\nCovariate model bands (target 80% / 90%):")
    print(cov.round(3).to_string(index=False))
    print("\nCovariates minus other model, WAPE points, with 95% bootstrap interval (negative = covariates better):")
    c = comp[comp["slice"].isin(["all", "event"]) & comp["ref"].eq("covariates")].copy()
    c["txt"] = c.apply(lambda r: f"{r['diff'] * 100:+.2f} [{r['lo'] * 100:+.2f}, {r['hi'] * 100:+.2f}]", axis=1)
    print(c.pivot_table(index=["family", "slice"], columns="vs", values="txt", aggfunc="first", sort=False).to_string())
    print("\nWeather: with-weather model minus other, WAPE points [95% interval] (negative = weather helps):")
    w = comp[comp["ref"].isin(["cov_ifs", "cov_aifs", "gate_ifs", "gate_aifs"])].copy()
    w["txt"] = w.apply(lambda r: f"{r['diff'] * 100:+.2f} [{r['lo'] * 100:+.2f}, {r['hi'] * 100:+.2f}]", axis=1)
    print(w.pivot_table(index=["family", "slice"], columns=["ref", "vs"], values="txt", aggfunc="first", sort=False).to_string())
    print(f"\nReconciliation (MinT, shrinkage lambda {lam:.2f}):")
    print(recon.round(4).to_string(index=False))


if __name__ == "__main__":
    main()
