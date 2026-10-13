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
- **Past-only covariates:** average departure delay, operated movements and the cancelled share.

## Intended use

- A demonstration of forecast-driven rostering for an airport operator: security lanes, passport booths, taxi call-ins and shuttle frequency.
- The point is the method: covariates, calibration, coherence, explanation and risk-based rostering.
- The numbers are not the point. **Not for operational decisions.** The data are synthetic.

## Data

- **Synthetic daily series**, 1 January 2023 to 28 March 2026.
- **Calibrated to real data:** monthly totals, market mix and direction match CSO tables TAM08 and TAM07 for Dublin Airport (CC BY 4.0, `reference_data/`).
- **Assumptions, not daa data:** the terminal split, daily shape, events and every operational quantity.
- **Built to avoid leakage:** the schedule covariate is the *published* schedule. Passengers depend on an unobserved load factor and on event sizes that no covariate reveals. Realised outcomes (operated flights, delays, cancellations) are past-only.

## Evaluation

**Design.**
- Rolling origin: 52 weekly origins, 9 February 2025 to 1 February 2026.
- Each origin forecasts 28 days ahead.
- The first 26 origins calibrate the bands and the MinT weights. The last 26 are scored as unseen.

| Family | WAPE | Best classical baseline | History-only TimesFM | 80% coverage | 90% coverage |
| --- | --- | --- | --- | --- | --- |
| Terminals | 2.7% | 4.2% (schedule × load) | 4.4% | 79.7% | 92.7% |
| Markets | 3.8–3.9% | 4.9–5.0% | 5.8–5.9% | 82.6–82.7% | 91.1–92.4% |
| Arrivals/departures | 4.8–4.9% | 6.0–6.3% | 6.6% | 82.7–83.3% | 91.4–92.6% |
| Landside | 3.9% | 6.1% (schedule × load) | 5.1% | 79.5% | 90.4% |

- **Event days** (terminals): 3.1% against 15.0% for history only and 8.1% for the best baseline.
- **Statistical support:** every difference against every baseline has a 95% bootstrap interval, resampling origins, that excludes zero.
- **Without calibration:** raw TimesFM 80% bands cover 82–87% of days (slightly too wide).
- **March 2026 holdout:** 2.9% (T1) and 2.8% (T2) error, against 6.4% and 6.1% from history only. 71% of days fell in the 80% band across all series. The month was event-heavy, with a fog day that no forecast can see.

## Limitations

- **Synthetic.** The forecast skill reflects how the synthetic world was built. Real airport data would have regime changes, schedule revisions, data errors and shocks this series lacks.
- **Zero-shot.** No hyperparameters were tuned on the test origins. The only fitted parts are the conformal scales and the MinT covariance, both on calibration origins.
- **Bands.**
  - Calibrated per series and horizon bucket, separately for known event days.
  - Not calibrated per day of week or season.
  - Under-cover in event-dense months.
  - Do not anticipate unflagged shocks (fog, strikes).
- **Reconciliation.** Only the median is reconciled. Each node keeps its own calibrated band, re-centred on the median, so the bands of the parts do not combine into the band of the total.
- **Intraday shape.** The intraday shape the rosters use comes from the generated flight schedule, not from an intraday forecast.
- **Rostering costs and service rules** are illustrative.
- **Licence.** TimesFM 3 weights are under the TimesFM Non-Commercial License v1.0.
