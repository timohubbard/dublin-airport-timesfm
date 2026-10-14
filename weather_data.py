"""Real weather at Dublin Airport: what happened, and what was forecast.

Observed (labels, and the disruptions the synthetic history now follows):

  Met Éireann, Dublin Airport station 532, hourly (CC BY 4.0)
      rain, temperature, humidity, mean wind, visibility, cloud height
      https://clidata.met.ie/cli/climate_data/webdata/hly532.csv
  METAR for EIDW from the Iowa Environmental Mesonet archive
      gusts, visibility, ceiling, present weather (fog, snow, freezing, thunder)
      https://mesonet.agron.iastate.edu/request/download.phtml?network=IE__ASOS

Forecast, as issued (the covariates; no hindsight):

  ECMWF IFS 0.25° (physics) and ECMWF AIFS (machine learning), both CC BY 4.0,
  through the Open-Meteo Previous Runs API: for every hour, the value each
  model forecast 1 ... 7 days earlier. https://open-meteo.com/en/docs/previous-runs-api
  Open-Meteo's free API is for non-commercial use.

Neither model's archive carries gusts or visibility, so wind and fog come from
what is there: mean wind, pressure, and the dew-point depression (fog forms
when air is near saturation and the wind is light).

The cached, derived tables live in reference_data/weather/ and are committed:

    python weather_data.py           # refresh from the sources
    python weather_data.py --show    # summarise what is cached
"""

from __future__ import annotations

import argparse
import io
import json
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
WX = ROOT / "reference_data" / "weather"
START, END = date(2023, 1, 1), date(2026, 3, 31)
LAT, LON = 53.4213, -6.2701
LEADS = range(1, 8)
MODELS = {
    # name in this project -> Open-Meteo model ids, newest first (AIFS changed id in 2025)
    "ifs": ["ecmwf_ifs025"],
    "aifs": ["ecmwf_aifs025_single", "ecmwf_aifs025"],
}
MODEL_LABELS = {"ifs": "ECMWF IFS (physics)", "aifs": "ECMWF AIFS (AI)"}
FC_HOURLY = ("temperature_2m", "dew_point_2m", "precipitation", "wind_speed_10m", "wind_direction_10m", "pressure_msl", "cloud_cover")
# Daily forecast features used as covariates, in this order.
FC_FEATURES = ("wind_max", "precip", "fog_hours", "tmin", "pmin")
FC_LABELS = {
    "wind_max": "Max mean wind (kt)", "precip": "Rain (mm)", "fog_hours": "Fog-risk hours",
    "tmin": "Min temperature (°C)", "pmin": "Min pressure (hPa)",
}
KMH_TO_KT = 1 / 1.852
# Low-visibility procedures: visibility under 550 m or a ceiling under 200 ft.
LVP_VIS_M, LVP_CEIL_FT = 550, 200


def _get(url: str, timeout: int = 300) -> bytes:
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(5 * (attempt + 1))
    return b""


# --- observations -------------------------------------------------------------

def fetch_met_eireann() -> pd.DataFrame:
    raw = _get("https://clidata.met.ie/cli/climate_data/webdata/hly532.csv").decode("latin-1").splitlines()
    head = next(i for i, line in enumerate(raw) if line.startswith("date,"))
    df = pd.read_csv(io.StringIO("\n".join(raw[head:])), low_memory=False)
    df["time"] = pd.to_datetime(df["date"], format="%d-%b-%Y %H:%M")
    df = df[(df["time"] >= pd.Timestamp(START)) & (df["time"] < pd.Timestamp(END) + pd.Timedelta(days=1))]
    keep = {"rain": "rain_mm", "temp": "temp_c", "dewpt": "dewpt_c", "rhum": "rh", "wdsp": "wind_kt", "wddir": "wind_dir", "vis": "vis_m", "clht": "ceiling_100ft", "ww": "ww"}
    out = df[["time", *keep]].rename(columns=keep)
    for c in keep.values():
        out[c] = pd.to_numeric(out[c], errors="coerce")
    return out.reset_index(drop=True)


def fetch_metar() -> pd.DataFrame:
    end = END + timedelta(days=1)
    url = (
        "https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?station=EIDW"
        "&data=tmpc&data=sknt&data=gust&data=drct&data=vsby&data=skyc1&data=skyl1&data=skyc2&data=skyl2&data=wxcodes"
        f"&year1={START.year}&month1={START.month}&day1={START.day}&year2={end.year}&month2={end.month}&day2={end.day}"
        "&tz=Etc%2FUTC&format=onlycomma&latlon=no&missing=M&trace=T&direct=no&report_type=3&report_type=4"
    )
    df = pd.read_csv(io.BytesIO(_get(url)), na_values=["M"])
    df["time"] = pd.to_datetime(df["valid"])
    df["vis_m"] = df["vsby"] * 1609.34
    ceil = []
    for c1, l1, c2, l2 in df[["skyc1", "skyl1", "skyc2", "skyl2"]].itertuples(index=False):
        low = [l for c, l in ((c1, l1), (c2, l2)) if c in ("BKN", "OVC", "VV") and pd.notna(l)]
        ceil.append(min(low) if low else np.nan)
    df["ceiling_ft"] = ceil
    wx = df["wxcodes"].fillna("")
    df["fog"] = wx.str.contains("FG")
    df["snow"] = wx.str.contains("SN|SG|PL|GS")
    df["freezing"] = wx.str.contains("FZ")
    df["thunder"] = wx.str.contains("TS")
    # Quality control: drop gusts that are implausible for the reported mean
    # wind (single-report spikes, e.g. 100 kt with a 12 kt mean).
    bad = df["gust"] > np.maximum(2.2 * df["sknt"].fillna(0) + 12, 0)
    df.loc[bad, "gust"] = np.nan
    df["hour"] = df["time"].dt.floor("h")
    hourly = df.groupby("hour").agg(
        gust_kt=("gust", "max"), wind_kt=("sknt", "max"), wind_dir=("drct", "median"), vis_m=("vis_m", "min"),
        ceiling_ft=("ceiling_ft", "min"), temp_c=("tmpc", "mean"), fog=("fog", "max"), snow=("snow", "max"),
        freezing=("freezing", "max"), thunder=("thunder", "max"),
    ).reset_index().rename(columns={"hour": "time"})
    return hourly


def daily_observed() -> pd.DataFrame:
    """One row per day: what the weather did at the airport."""
    me = pd.read_csv(WX / "met_eireann_hourly.csv", parse_dates=["time"])
    mt = pd.read_csv(WX / "eidw_metar_hourly.csv", parse_dates=["time"])
    h = me.merge(mt, on="time", how="outer", suffixes=("", "_metar")).sort_values("time")
    vis = h["vis_m_metar"].fillna(h["vis_m"])
    ceiling = h["ceiling_ft"].fillna(h["ceiling_100ft"].where(h["ceiling_100ft"] < 999) * 100)
    h["lvp"] = (vis < LVP_VIS_M) | (ceiling < LVP_CEIL_FT)
    h["lowvis"] = vis < 1500
    h["day"] = h["time"].dt.floor("D")
    d = h.groupby("day").agg(
        lvp_hours=("lvp", "sum"), lowvis_hours=("lowvis", "sum"),
        gust_max_kt=("gust_kt", "max"), wind_max_kt=("wind_kt", "max"),
        rain_mm=("rain_mm", "sum"), tmin=("temp_c", "min"), tmax=("temp_c", "max"),
        snow=("snow", "max"), freezing=("freezing", "max"), thunder=("thunder", "max"),
    )
    d["gust_max_kt"] = d["gust_max_kt"].fillna(d["wind_max_kt"] * 1.45)
    d["wind_max_kt"] = d["wind_max_kt"].fillna(0)
    for c in ("snow", "freezing", "thunder"):
        d[c] = d[c].fillna(False).astype(bool)
    d.index = d.index.date
    d.index.name = "date"
    return d.loc[START:END]


def disruption(days) -> pd.DataFrame:
    """Operational effect of each day's observed weather (illustrative rules).

    Storm-force gusts (Storm Éowyn, 24 Jan 2025, gusted to 56 kt here and the
    airport cancelled about a third of its flights) cancel most; strong winds,
    snow, freezing precipitation and low visibility cancel some and delay
    more; frost adds de-icing time.
    """
    obs = daily_observed()
    rows = []
    for d in days:
        o = obs.loc[d] if d in obs.index else None
        if o is None:
            rows.append({"date": d, "cancel": 0.0, "delay_extra": 0.0, "name": "", "severity": 0.0})
            continue
        g, lvp, rain = float(o["gust_max_kt"] or 0), float(o["lvp_hours"]), float(o["rain_mm"] or 0)
        snow, ice, frost = bool(o["snow"]), bool(o["freezing"]), float(o["tmin"]) <= 0.0
        cancel, delay, names = 0.0, 0.0, []
        if g >= 55:
            cancel += 0.30; delay += 60; names.append("Storm-force winds")
        elif g >= 45:
            cancel += 0.04 + 0.012 * (g - 45); delay += 25; names.append("Strong winds")
        elif g >= 38 and rain >= 12:
            cancel += 0.015; delay += 15; names.append("Wind and heavy rain")
        delay += 1.0 * max(0.0, g - 30)
        if ice:
            cancel += 0.08; delay += 30; names.append("Freezing precipitation")
        elif snow:
            cancel += 0.03; delay += 15; names.append("Snow showers")
        if lvp >= 2:
            cancel += 0.01 * lvp; delay += 9 * lvp; names.append("Fog / low visibility")
        if frost:
            delay += 6
        rows.append({"date": d, "cancel": min(cancel, 0.4), "delay_extra": delay, "name": " & ".join(names),
                     "severity": cancel * 100 + delay / 10,
                     "gust_kt": g, "lvp_hours": lvp, "rain_mm": rain, "snow_ice": snow or ice, "frost": frost})
    return pd.DataFrame(rows).set_index("date")


# --- forecasts as issued ------------------------------------------------------

def _fetch_model(model_id: str, start: date, end: date) -> pd.DataFrame:
    hourly = ",".join(f"{v}_previous_day{k}" for v in FC_HOURLY for k in LEADS)
    url = (f"https://previous-runs-api.open-meteo.com/v1/forecast?latitude={LAT}&longitude={LON}&timezone=UTC"
           f"&hourly={hourly}&models={model_id}&start_date={start}&end_date={end}")
    H = json.loads(_get(url))["hourly"]
    return pd.DataFrame(H).assign(time=lambda x: pd.to_datetime(x["time"]))


def fetch_forecasts(model: str) -> pd.DataFrame:
    """Hourly as-issued forecasts for every lead, merged across the model's ids."""
    parts = []
    cursor = START
    while cursor <= END:
        stop = min(END, (pd.Timestamp(cursor) + pd.offsets.QuarterEnd(0)).date())
        frames = [_fetch_model(mid, cursor, stop) for mid in MODELS[model]]
        merged = frames[0]
        for f in frames[1:]:
            merged = merged.combine_first(f) if len(f) else merged
        parts.append(merged)
        cursor = stop + timedelta(days=1)
    return pd.concat(parts, ignore_index=True)


def daily_forecast_features(hourly: pd.DataFrame) -> pd.DataFrame:
    """Daily covariate features per lead from hourly as-issued forecasts."""
    rows = []
    hourly = hourly.set_index("time")
    days = hourly.index.floor("D")
    for k in LEADS:
        sfx = f"_previous_day{k}"
        t = hourly["temperature_2m" + sfx]
        dpd = t - hourly["dew_point_2m" + sfx]
        wind = hourly["wind_speed_10m" + sfx]
        fog = ((dpd <= 1.0) & (wind <= 12)).where(t.notna())
        g = pd.DataFrame({
            "wind_max": wind * KMH_TO_KT, "precip": hourly["precipitation" + sfx], "fog": fog,
            "tmin": t, "pmin": hourly["pressure_msl" + sfx], "valid": t.notna(),
        }).groupby(days)
        agg = g.agg(wind_max=("wind_max", "max"), precip=("precip", "sum"), fog_hours=("fog", "sum"),
                    tmin=("tmin", "min"), pmin=("pmin", "min"), n=("valid", "sum"))
        agg = agg[agg["n"] >= 20].drop(columns="n")
        agg["lead"] = k
        rows.append(agg)
    out = pd.concat(rows).reset_index().rename(columns={"time": "date"})
    out["date"] = out["date"].dt.date
    return out


def load_forecast_features() -> pd.DataFrame:
    return pd.read_csv(WX / "ecmwf_daily_by_lead.csv", parse_dates=["date"]).assign(date=lambda x: x["date"].dt.date)


def forecast_asof(origin: date, horizon: int, model: str, fc: pd.DataFrame | None = None,
                  clim: pd.DataFrame | None = None) -> np.ndarray:
    """(features, horizon) forecast for days origin ... origin+horizon-1 as known
    before `origin`: day j uses the lead j+1 forecast while j+1 <= 7, then
    climatology. Missing archive values fall back to climatology as well."""
    fc = load_forecast_features() if fc is None else fc
    clim = climatology() if clim is None else clim
    sub = fc[fc["model"] == model].set_index(["date", "lead"])
    out = np.zeros((len(FC_FEATURES), horizon))
    for j in range(horizon):
        day = origin + timedelta(days=j)
        lead = j + 1
        if lead <= max(LEADS) and (day, lead) in sub.index:
            out[:, j] = sub.loc[(day, lead), list(FC_FEATURES)].to_numpy(float)
        else:
            out[:, j] = clim.loc[day.timetuple().tm_yday, list(FC_FEATURES)].to_numpy(float)
    return out


def climatology() -> pd.DataFrame:
    """Day-of-year means of the lead-1 forecast features (both models), smoothed
    with a 31-day window, so 'no forecast yet' is a seasonal expectation."""
    fc = load_forecast_features()
    f1 = fc[fc["lead"] == 1].copy()
    f1["doy"] = pd.to_datetime(f1["date"]).dt.dayofyear
    by = f1.groupby("doy")[list(FC_FEATURES)].mean().reindex(range(1, 367)).interpolate(limit_direction="both")
    padded = pd.concat([by.iloc[-15:], by, by.iloc[:15]])
    return padded.rolling(31, center=True, min_periods=1).mean().iloc[15:-15]


def lead1_series(dates, model: str, fc: pd.DataFrame | None = None, clim: pd.DataFrame | None = None) -> np.ndarray:
    """The day-ahead forecast for every date (context rows of the covariate):
    climatology where the archive has no value."""
    fc = load_forecast_features() if fc is None else fc
    clim = climatology() if clim is None else clim
    sub = fc[(fc["model"] == model) & (fc["lead"] == 1)].set_index("date")[list(FC_FEATURES)]
    out = np.zeros((len(FC_FEATURES), len(dates)))
    for i, d in enumerate(dates):
        if d in sub.index:
            out[:, i] = sub.loc[d].to_numpy(float)
        else:
            out[:, i] = clim.loc[d.timetuple().tm_yday].to_numpy(float)
    return out


def refresh() -> None:
    WX.mkdir(parents=True, exist_ok=True)
    print("Met Éireann station 532 ...", flush=True)
    me = fetch_met_eireann()
    me.to_csv(WX / "met_eireann_hourly.csv", index=False, float_format="%.1f")
    print(f"  {len(me):,} hours")
    print("METAR EIDW ...", flush=True)
    mt = fetch_metar()
    mt.to_csv(WX / "eidw_metar_hourly.csv", index=False, float_format="%.1f")
    print(f"  {len(mt):,} hours")
    feats, march = [], []
    for model in MODELS:
        print(f"ECMWF {model} as issued, leads 1-7 ...", flush=True)
        hourly = fetch_forecasts(model)
        f = daily_forecast_features(hourly).assign(model=model)
        print(f"  {f['date'].nunique()} days with a forecast, {f['date'].min()} to {f['date'].max()}")
        feats.append(f)
        # Hourly day-ahead forecast for the March 2026 horizon, for the twin.
        m = hourly[(hourly["time"] >= "2026-03-01") & (hourly["time"] < "2026-04-01")]
        march.append(pd.DataFrame({
            "time": m["time"], "model": model,
            "temp_c": m["temperature_2m_previous_day1"], "dewpt_c": m["dew_point_2m_previous_day1"],
            "precip_mm": m["precipitation_previous_day1"], "wind_kt": m["wind_speed_10m_previous_day1"] * KMH_TO_KT,
            "wind_dir": m["wind_direction_10m_previous_day1"], "cloud": m["cloud_cover_previous_day1"],
        }))
    pd.concat(feats).to_csv(WX / "ecmwf_daily_by_lead.csv", index=False, float_format="%.2f")
    pd.concat(march).to_csv(WX / "ecmwf_hourly_dayahead_2026_03.csv", index=False, float_format="%.2f")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    (WX / "SOURCES.md").write_text(
        "# Weather data\n\n"
        f"Retrieved {stamp}. Derived tables only; see `weather_data.py` for how each is built.\n\n"
        "- `met_eireann_hourly.csv`: Met Éireann, Dublin Airport (station 532), hourly observations, "
        "https://clidata.met.ie/cli/climate_data/webdata/hly532.csv, licence CC BY 4.0. Source: Met Éireann.\n"
        "- `eidw_metar_hourly.csv`: METAR reports for EIDW, hourly aggregates, from the Iowa Environmental Mesonet "
        "ASOS/METAR archive, https://mesonet.agron.iastate.edu/.\n"
        "- `ecmwf_daily_by_lead.csv`, `ecmwf_hourly_dayahead_2026_03.csv`: ECMWF IFS 0.25° and ECMWF AIFS forecasts "
        "as issued, 1-7 days ahead, through the Open-Meteo Previous Runs API (https://open-meteo.com/). "
        "ECMWF open data, CC BY 4.0. Open-Meteo data CC BY 4.0; the free API is for non-commercial use.\n\n"
        "Met Éireann's archived warnings end in August 2023, before the backtest period, so warnings are not used "
        "as an as-issued input; storms are identified from observed gusts.\n"
    )
    print(f"Wrote {WX.relative_to(ROOT)}/")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--show", action="store_true")
    args = parser.parse_args()
    if not args.show:
        refresh()
    d = daily_observed()
    print(d.describe().T[["mean", "max"]].round(1))
    worst = d.sort_values("gust_max_kt", ascending=False).head(5)
    print("Windiest days:\n", worst[["gust_max_kt", "wind_max_kt", "rain_mm"]])
    print("Most low-visibility hours:\n", d.sort_values("lvp_hours", ascending=False).head(5)[["lvp_hours", "lowvis_hours"]])
    print("Snow/ice days:", int((d["snow"] | d["freezing"]).sum()))


if __name__ == "__main__":
    main()
