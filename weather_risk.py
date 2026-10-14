"""Disruption risk from weather forecasts: how likely is a bad-weather day?

For each day and each lead time (1-7 days), a small logistic model turns the
as-issued ECMWF forecast for that day into probabilities of:

  wind     gusts of 45 kt or more (strong winds and storms)
  snowice  snow or freezing precipitation
  lvp      two or more hours of low-visibility procedures (fog / low cloud)
  any      any weather disruption (weather_data.disruption names the day)

Labels come from what was observed (Met Éireann and METAR). Inputs are the
five daily forecast features plus the season. The models are fitted on the
earlier half of the forecast archive and scored on the later half with the
Brier skill score against climatology (the base rate in the training half):
above zero means the forecast adds information. IFS and AIFS are fitted and
scored separately, so their skill can be compared like for like.
"""

from __future__ import annotations

from datetime import date

import numpy as np
import pandas as pd

import weather_data as wx

TARGETS = {
    "any": "Any weather disruption",
    "wind": "Gusts ≥ 45 kt",
    "snowice": "Snow or ice",
    "lvp": "Low visibility ≥ 2 h",
}
LEAD_BUCKETS = ((1, 3), (4, 7))
SPLIT = date(2025, 8, 1)  # fit before, score from


def labels() -> pd.DataFrame:
    obs = wx.daily_observed()
    dis = wx.disruption(list(obs.index))
    return pd.DataFrame({
        "any": dis["name"].ne("").astype(int),
        "wind": (obs["gust_max_kt"] >= 45).astype(int),
        "snowice": (obs["snow"] | obs["freezing"]).astype(int),
        "lvp": (obs["lvp_hours"] >= 2).astype(int),
    }, index=obs.index)


def design(features: pd.DataFrame) -> np.ndarray:
    """Scaled forecast features, a few nonlinear terms, and the season."""
    f = features
    doy = pd.to_datetime(f["date"]).dt.dayofyear.to_numpy()
    cols = [
        f["wind_max"] / 20, np.maximum(f["wind_max"] - 25, 0) / 10, f["precip"] / 5, f["fog_hours"] / 6,
        f["tmin"] / 10, np.maximum(1 - f["tmin"], 0) / 3, (f["pmin"] - 1000) / 15,
        np.sin(2 * np.pi * doy / 365.25), np.cos(2 * np.pi * doy / 365.25),
    ]
    return np.column_stack([np.ones(len(f)), *[np.asarray(c, float) for c in cols]])


def fit_logistic(x: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 60) -> np.ndarray:
    """Newton-Raphson with an L2 penalty (intercept unpenalised)."""
    w = np.zeros(x.shape[1])
    pen = np.full(x.shape[1], l2); pen[0] = 0.0
    for _ in range(iters):
        p = 1 / (1 + np.exp(-np.clip(x @ w, -30, 30)))
        grad = x.T @ (p - y) + pen * w
        hess = (x * (p * (1 - p))[:, None]).T @ x + np.diag(pen) + 1e-9 * np.eye(len(w))
        step = np.linalg.solve(hess, grad)
        w -= step
        if np.abs(step).max() < 1e-8:
            break
    return w


def predict(w: np.ndarray, x: np.ndarray) -> np.ndarray:
    return 1 / (1 + np.exp(-np.clip(x @ w, -30, 30)))


def brier_skill(p: np.ndarray, y: np.ndarray, base: float) -> float:
    bs = np.mean((p - y) ** 2)
    ref = np.mean((base - y) ** 2)
    return float(1 - bs / ref) if ref > 0 else float("nan")


class RiskModel:
    """Fitted coefficients per (model, lead bucket, target)."""

    def __init__(self, fc: pd.DataFrame | None = None, split: date = SPLIT):
        self.fc = wx.load_forecast_features() if fc is None else fc
        self.lab = labels()
        self.split = split
        self.w: dict = {}
        self.base: dict = {}
        self.scores: list[dict] = []

    def _rows(self, model: str, lo: int, hi: int) -> pd.DataFrame:
        f = self.fc[(self.fc["model"] == model) & self.fc["lead"].between(lo, hi)].dropna()
        return f.merge(self.lab, left_on="date", right_index=True)

    def fit(self, final: bool = False) -> "RiskModel":
        for model in wx.MODELS:
            for lo, hi in LEAD_BUCKETS:
                rows = self._rows(model, lo, hi)
                train = rows if final else rows[rows["date"] < self.split]
                test = rows[rows["date"] >= self.split]
                xtr, xte = design(train), design(test)
                for t in TARGETS:
                    ytr = train[t].to_numpy(float)
                    base = float(ytr.mean())
                    w = fit_logistic(xtr, ytr, l2=2.0)
                    self.w[(model, lo, t)] = w
                    self.base[t] = base
                    if not final and len(test):
                        yte = test[t].to_numpy(float)
                        p = predict(w, xte)
                        self.scores.append({
                            "model": model, "leads": f"{lo}-{hi}", "target": t, "events_test": int(yte.sum()),
                            "n_test": len(yte), "brier_skill": brier_skill(p, yte, base),
                            "mean_p_event": float(p[yte == 1].mean()) if yte.sum() else float("nan"),
                            "mean_p_none": float(p[yte == 0].mean()),
                        })
        return self

    def prob(self, model: str, lead: int, feats: np.ndarray, day: date) -> dict:
        """Probabilities for one day from its forecast feature vector (FC_FEATURES order)."""
        bucket = next(lo for lo, hi in LEAD_BUCKETS if lo <= lead <= hi) if lead <= 7 else None
        if bucket is None:
            return {t: self.base[t] for t in TARGETS}
        frame = pd.DataFrame([dict(zip(wx.FC_FEATURES, feats), date=day)])
        x = design(frame)
        return {t: float(predict(self.w[(model, bucket, t)], x)[0]) for t in TARGETS}


def model_skill() -> pd.DataFrame:
    """Forecast skill of the raw weather variables by lead, IFS against AIFS,
    on the scoring half: wind MAE (mean wind, kt) and rain-day Brier score."""
    fc = wx.load_forecast_features()
    obs = wx.daily_observed()
    me = pd.read_csv(wx.WX / "met_eireann_hourly.csv", parse_dates=["time"])
    me["day"] = me["time"].dt.date
    wind_obs = me.groupby("day")["wind_kt"].max()
    rows = []
    for model in wx.MODELS:
        for lead in wx.LEADS:
            f = fc[(fc["model"] == model) & (fc["lead"] == lead) & (fc["date"] >= SPLIT)].set_index("date")
            days = [d for d in f.index if d in wind_obs.index and d in obs.index]
            f = f.loc[days]
            rain_obs = (obs.loc[days, "rain_mm"] >= 1).astype(float).to_numpy()
            rain_p = np.clip(f["precip"].to_numpy() / 2.0, 0, 1)  # simple rain-day probability proxy
            rows.append({
                "model": model, "lead": lead, "n": len(days),
                "wind_mae_kt": float(np.mean(np.abs(f["wind_max"].to_numpy() - wind_obs.loc[days].to_numpy()))),
                "rain_brier": float(np.mean((rain_p - rain_obs) ** 2)),
                "tmin_mae_c": float(np.mean(np.abs(f["tmin"].to_numpy() - obs.loc[days, "tmin"].to_numpy()))),
            })
    return pd.DataFrame(rows)


if __name__ == "__main__":
    rm = RiskModel().fit()
    pd.set_option("display.width", 160)
    print(pd.DataFrame(rm.scores).round(3).to_string(index=False))
    print(model_skill().round(3).to_string(index=False))
