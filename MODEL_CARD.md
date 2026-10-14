# Model card: Dublin Airport passenger forecast

## What it is

**Model.** TimesFM 3, from the public `google/timesfm-3.0-pytorch` checkpoint.
- Used zero-shot: no fine-tuning and no fitted parameters.
- Runs on Apple-silicon MLX.

**Wrapper.**
- `pipeline.py`: forecast families and covariates.
- `calibration.py`: calibrated bands.
- `reconcile.py`: coherent hierarchy.
- Explanations come from Shapley values computed with exact re-runs.

**Outputs.**
- 1–28 days ahead.
- Daily passengers per terminal, per destination market (5) and per direction.
- Taxi pickups and bus passengers per terminal; Holiday Blue entries and occupancy.
- A point forecast (median) and calibrated quantiles from P5 to P95.

**Inputs per family.**
- **Targets:** history only.
- **Past-and-future covariates** (known in advance): the published schedule (movements), the event flag, school holidays, and event direction (−1 inbound, +1 outbound).
- **Weather covariates** (past-and-future): the ECMWF forecast as issued for each day (max wind, rain, fog-risk hours, minimum temperature, minimum pressure). Horizon days 1–7 use the run from *j*+1 days before the origin; later days use climatology.
- **Past-only covariates:** average departure delay, operated movements, the cancelled share, and the observed weather (gusts, low-visibility hours, rain, snow/ice).
- **Production model.** Gated ECMWF AIFS weather: the weather-aware forecast is used only on days 1–7 that the AIFS disruption-risk model flags (probability ≥ 0.2). It was chosen on calibration origins only, with a tie-break fixed in advance.

## Intended use

- A demonstration of forecast-driven rostering for an airport operator: security lanes, passport booths, taxi call-ins and shuttle frequency.
- The point is the method: covariates, calibration, coherence, explanation and risk-based rostering.
- The numbers are not the point. **Not for operational decisions.** The data are synthetic.

## Data

- **Synthetic daily series**, 1 January 2023 to 28 March 2026.
- **Calibrated to real data:** monthly totals, market mix and direction match CSO tables TAM08 and TAM07 for Dublin Airport (CC BY 4.0, `reference_data/`).
- **Real weather:**
  - Each day's delays, cancellations and disruptions follow Dublin Airport's observed weather (Met Éireann station 532 and METAR).
  - The covariates are ECMWF IFS and AIFS forecasts exactly as issued (Open-Meteo Previous Runs).
- **Assumptions, not daa data:** the terminal split, daily shape, events and every operational quantity.
- **Built to avoid leakage:** the schedule covariate is the *published* schedule. Passengers depend on an unobserved load factor and on event sizes that no covariate reveals. Realised outcomes (operated flights, delays, cancellations) are past-only.

## Evaluation

**Design.**
- Rolling origin: 52 weekly origins, 9 February 2025 to 1 February 2026.
- Each origin forecasts 28 days ahead.
- The first 26 origins calibrate the bands and the MinT weights. The last 26 are scored as unseen.

| Family | WAPE | Best classical baseline | History-only TimesFM | 80% coverage | 90% coverage |
| --- | --- | --- | --- | --- | --- |
| Terminals | 2.7% | 3.9% (schedule × load) | 4.1% | 76.8% | 88.2% |
| Markets | 3.8% | 4.5–4.7% | 5.5–5.6% | 78.0–80.8% | 87.9–90.1% |
| Arrivals/departures | 4.6–4.8% | 5.8% | 6.2–6.4% | 78.8–80.8% | 89.1–90.5% |
| Landside | 4.0% | 6.1% (schedule × load) | 5.3% | 79.0% | 90.0% |

- **Event days** (terminals): 2.8% against 13.8% for history only and 6.9% for the best baseline.
- **Statistical support:** every difference against every baseline has a 95% bootstrap interval, resampling origins, that excludes zero.
- **Calibration** is online: each scored origin uses all outcomes known by then. Coverage is a little under target in winter.
- **March 2026 holdout:**
  - The plan made on 1 March scores 2.0% (T1) and 2.1% (T2), against 4.8% and 4.2% from history only.
  - Refreshed each evening, error across all series falls from 5.4% to 3.4%.
  - 77% of days fell in the 80% band.

## Weather results

- **Disruption-risk skill** (Brier skill against climatology, later half), 1–3 days ahead:

  | Target | IFS | AIFS |
  | --- | --- | --- |
  | Any disruption | 0.05 | 0.06 |
  | Gusts ≥ 45 kt | 0.21 | 0.23 |

  At 4–7 days AIFS keeps more skill (0.05 against 0.00 for any disruption).
- **Raw wind error:** IFS is lower at every lead (day-ahead 2.1 kt against 2.6 kt).
- **Always-on weather covariates** make TimesFM slightly worse on ordinary days: +0.07 to +0.15 WAPE points.
- **The gated AIFS model** is never worse, and helps on first-week disruption days: −0.53 points [−1.59, −0.01] for terminals. Only 9 such days are in the scored half.
- **Refreshing the forecast the evening before** each March day cuts error across all series from 5.4% to 3.4%.

## Limitations

- **Synthetic.** The forecast skill reflects how the synthetic world was built. Real airport data would have regime changes, schedule revisions, data errors and shocks this series lacks.
- **Zero-shot.** No hyperparameters were tuned on the test origins. The only fitted parts are the conformal scales and the MinT covariance, both on calibration origins.
- **Bands.**
  - Calibrated per series and horizon bucket, separately for known event days.
  - Not calibrated per day of week or season.
  - Under-cover in event-dense months.
  - Do not anticipate unflagged shocks (fog, strikes).
- **Reconciliation.**
  - Only the median is reconciled. Each node keeps its own calibrated band, re-centred on the median, so the bands of the parts do not combine into the band of the total.
  - With real weather in the history, MinT costs about 0.1 WAPE point in exchange for exact coherence.
- **Intraday shape.** The intraday shape the rosters use comes from the generated flight schedule, not from an intraday forecast.
- **Rostering costs and service rules** are illustrative.
- **Weather archive limits.**
  - The as-issued archive starts in 2024 and has no gusts or visibility, so those come from proxies.
  - Warnings are not available for the backtest period.
  - Disruption rules (cancellations, delays, runway rates) are illustrative.
- **Licences.**
  - TimesFM 3 weights are under the TimesFM Non-Commercial License v1.0.
  - Open-Meteo's free API is for non-commercial use.
