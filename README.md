# Dublin Airport: forecasting and operations twin

A forecasting system for a **synthetic** Dublin Airport, built on [TimesFM 3](https://research.google/blog/timesfm-3-a-zero-shot-foundation-model-for-multivariate-forecasting/) (zero-shot, no fine-tuning), and a whole-airport simulation that is rostered from it.

- The daily history is invented, but **every month is calibrated to the Central Statistics Office's published Dublin Airport figures**: total passengers, the mix of destinations, and the arrival/departure split.
- Terminals, markets, landside flows and every operational number are illustrative, not daa data.

## What it does

| | |
| --- | --- |
| **Forecast** | 28 days ahead, for terminals, destination markets, arrivals and departures, taxis, buses and car parks. TimesFM 3 reads the history plus what is known in advance (published schedule, events, school holidays, event direction) and what is only known afterwards (delays, cancellations). |
| **Measure** | A rolling-origin backtest over 52 weekly origins against four classical baselines. Point error, interval coverage and quantile loss, with bootstrap intervals so small slices are not over-claimed. |
| **Calibrate** | Split-conformal bands (P5 to P95), fitted on half the origins and checked on the unseen half. |
| **Reconcile** | MinT so that arrivals + departures = market and markets = terminal. |
| **Explain** | Exact Shapley values of the covariate groups (schedule, events, calendar) from eight TimesFM runs per family. |
| **Ask what if** | TimesFM re-forecasts the day if an event is announced, 10% of flights are cancelled, or a route is added. |
| **Decide** | The twin rosters security, passport control, taxis and shuttles from any forecast quantile. It shows each roster's cost against its risk before the day, then what actually happened. |

## Results

Scored 1–28 days ahead, on the 26 weekly origins (August 2025 to January 2026) that the calibration never saw. WAPE is weighted absolute percentage error; lower is better.

| Series | TimesFM + schedule & events | TimesFM, history only | Planner's method¹ | Holt-Winters | Last week |
| --- | --- | --- | --- | --- | --- |
| Terminal passengers | **2.7%** | 4.4% | 4.2% | 7.2% | 8.6% |
| … on event days | **3.1%** | 15.0% | 8.1% | 11.6% | 12.6% |
| Passengers by market | **3.8–3.9%** | 5.8–5.9% | 4.9–5.0% | 8.8–9.4% | 10.6–11.0% |
| Arrivals/departures by market | **4.8–4.9%** | 6.6% | 6.0–6.3% | 9.6–10.1% | 11.5–11.8% |
| Taxis, buses, car park | **3.9%** | 5.1% | 6.1% | 6.9% | 7.9% |

¹ Next period's published schedule × the passengers per scheduled movement on the same weekday over the last four weeks. It is the honest competitor, because it uses the schedule too.

**Is the gain real?** The 95% bootstrap interval (over origins) for TimesFM-with-covariates minus each baseline excludes zero for every family on all days:

- versus the planner's method: −1.6 points [−2.1, −1.1]
- versus history-only TimesFM: −1.7 [−2.3, −1.1]
- on event days, versus history only: −11.9 [−13.7, −10.0]

**Are the bands honest?**

| | Share of actuals inside |
| --- | --- |
| Nominal 80% band, as TimesFM returns it | 82–87% |
| After calibration, 80% band | 80–83% |
| After calibration, 90% band | 90–93% |

The reliability diagram is in `outputs/calibration.png` and in the Forecast Studio.

**Reconciliation.** MinT makes the hierarchy add up exactly (the base forecasts disagree by about 110 passengers a day) and lowers error slightly at every level:

| Level | WAPE before | WAPE after |
| --- | --- | --- |
| Terminal | 2.70% | 2.55% |
| Market | 3.81% | 3.78% |
| Arrivals/departures | 4.83% | 4.75% |

**March 2026 holdout** (one month, the data the demo replays):

- Covariate forecast: 2.9% error on Terminal 1, 2.8% on Terminal 2. History only: 6.4% and 6.1%.
- The month is deliberately hard: a two-day summit, St Patrick's Day, a fog day (only known afterwards) and a route launch.
- Across all series, 71% of days fell inside the 80% band. One event-heavy month is a small sample; the 26-origin backtest is the number to trust.

### Why these numbers are believable

An earlier version of this project reported about 0.6% error on event days. That was leakage: the "schedule" covariate was the realised flight count, and passengers were the schedule times a constant. Now:

- **The schedule covariate is the published schedule.** On the day, weather cancels flights and ad-hoc flights are added. Those realised counts, delays and the cancelled share are past-only covariates.
- **Passengers = operated seats × load factor.** The load factor has its own persistent demand drift (AR(1), φ = 0.93), its own weekly pattern, school-holiday lift, and an event lift of random size that no covariate reveals. The event flag says "busier", not "how much".
- **Market schedules come from the expected market share**, not the realised one.
- **`tests/test_data.py`** checks that the fog day's operated flights fall well below the published schedule, and that passengers per scheduled movement still vary.

## Data provenance

`real_data.py` reads two tables from the [CSO PxStat API](https://www.cso.ie/en/statistics/transport/aviationstatistics/) (CC BY 4.0) into `reference_data/cso_dublin_monthly.csv`:

- **TAM08**: monthly passengers at Dublin.
- **TAM07**: passengers and commercial flights by country and direction.

The synthetic daily series are scaled with smooth monthly factors so that every month's total matches TAM08 exactly. Each market's monthly passengers match TAM07's country mix (mapping in `real_data.py`), and the departing share follows TAM07's direction split.

The split between terminals (Europe city and UK 55/45 across T1/T2; sun routes all T1; North America and long-haul all T2) is the demo's assumption, not daa's allocation.

The rolling 12-month total to June 2026 is 37.4 million passengers. It is shown against the 32 million passenger cap in the 2007 Terminal 2 planning permission, as a reference line only; that cap has been the subject of ongoing planning and legal proceedings.

## Run

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python run_all.py
```

`run_all.py` runs four stages:

1. **Data.** Synthetic series calibrated to CSO.
2. **Backtest.** `forecast_eval.py`: 52 origins, about 2 minutes on an M-series Mac.
3. **Final forecast.** `forecast_final.py`: March forecast, calibration, MinT, Shapley values and scenarios, about 2 minutes.
4. **Export.** Writes `flow_demo/flow_data.js` for the twin.

The first run downloads `google/timesfm-3.0-pytorch` (about 1.3 GB). Every TimesFM call is cached in `outputs/cache/`, keyed by a hash of its inputs, so re-runs take seconds.

Other commands:

- `python run_all.py --data-only`: write the CSVs only.
- `python real_data.py`: refresh the CSO figures.
- `pytest`: run the tests (metrics, conformal calibration, MinT, data invariants).

Outputs:

| Path | What it holds |
| --- | --- |
| `outputs/backtest.csv.gz` | Every forecast from every origin and model, with deciles and calibrated levels |
| `outputs/leaderboard.csv`, `outputs/comparisons.csv` | WAPE, MASE, bias, WQL and coverage by family and slice; differences with bootstrap intervals |
| `outputs/reconciliation.csv` | Error before and after MinT |
| `outputs/leaderboard.png`, `outputs/calibration.png` | The two summary charts |
| `outputs/forecast_bundle.json` | The production forecast with bands, explanations, scenarios and track record |

The original single-origin scripts (`forecast_dublin_airport.py`, `forecast_markets.py`, `forecast_operations.py`) still run on their own and draw the classroom figure. `run_all.py` is the main pipeline.

TimesFM 3 weights are under the [TimesFM Non-Commercial License v1.0](https://huggingface.co/google/timesfm-3.0-pytorch); this is a demonstration, not a production system. On Apple silicon it uses the MLX backend.

## Code map

| File | Role |
| --- | --- |
| `forecast_dublin_airport.py` | Terminal series (published schedule, operated flights, load factor), the TimesFM loader |
| `forecast_markets.py`, `forecast_operations.py` | Markets, direction, landside, car-park stocks |
| `real_data.py` | CSO data and monthly calibration |
| `pipeline.py` | Forecast families, covariate groups, cached TimesFM engine, Shapley values |
| `baselines.py`, `metrics.py` | Classical baselines, metrics and bootstrap (numpy only) |
| `calibration.py` | Split-conformal (normalised CQR, Mondrian by event day) |
| `reconcile.py` | MinT with Schäfer–Strimmer shrinkage |
| `forecast_eval.py`, `forecast_final.py`, `run_all.py` | Backtest, production forecast, orchestration |
| `flow_demo/` | The operations twin (below) |

## Operations twin (`flow_demo/`)

```bash
python -m http.server 8765 --directory flow_demo   # then open http://localhost:8765
```

You can also open `flow_demo/index.html` straight from disk; there is no build step.

Each dot is one person:

- filled dots depart and rings arrive
- connecting passengers, meeters and greeters, and staff are dots too
- cars, taxis, buses, shuttles, tugs and bags move on their own networks

The map is one schematic stacked by level: piers and gates, departures, roads, arrivals, the baggage hall and car parks. Outlet, lounge, carousel and car-park names come from daa's public terminal map; their capacities and all spend figures are illustrative.

**Forecast Studio** (key **F**):

- A fan chart with calibrated bands; actuals are revealed up to the selected day.
- The week-ahead track record over the backtest year.
- The leaderboard with bootstrap intervals and the reliability diagram.
- The Shapley "why" for the selected day, with the scenario re-forecasts.
- The CSO data behind the history.

**Roster & risk:**

- Presets **1 2 3**: history only, covariates P50, covariates P90. A **risk-appetite slider** (keys **[ ]**) rosters for any calibrated quantile from P50 to P95.
- **Cost against risk.** Each security roster is plotted by its cost in staff-hours and illustrative €, against the share of passengers expected through within 15 minutes. That share is measured before the day, by queueing the forecast's whole distribution (P5 to P95) through the same model, and set against what the actual day delivered.
- The app recommends the cheapest roster that keeps 95% of passengers within 15 minutes.
- **Alerts** list the windows that break the service level if demand lands on P90. One click adds the lanes or booths that fix them.
- The **outlook table** compares every roster on the actual day: peak wait, share within the service level, and staff-hours.

**What if** (applies to the selected day):

- **Demand scenarios:** announce an event, cancel 10% of flights, add a route. "Tell the forecast" scales the covariate rosters by TimesFM's own re-forecast; the history-only model cannot be told.
- **Capacity scenarios:** fog, three T1 lanes out, eGates down, taxi shortage.

**Present:**

- **T** runs a guided tour of about 4 minutes.
- **R** opens a printable daily ops briefing (forecast, reasons, roster by hour, cost, risk, alerts) with a roster CSV export.
- **?** shows help.
- The URL keeps the day, time, roster and scenario, so a view can be shared.

| Key | Action |
| --- | --- |
| Space, ← → | Play/pause; jump 15 minutes |
| 1 2 3, [ ] | Roster preset; risk appetite down or up |
| W D A L B | Camera: whole, departures, arrivals, landside, baggage |
| F, T, R, ? | Forecast Studio, tour, briefing, help |
| C, P | Dot colours, performance meter |
| Click | Follow a person (Esc to stop) |

**Verification** (browser console):

- `DUB.runHeadless({ di, plan })` simulates a full day without drawing. It checks departures balance (boarded + missed = generated), arrivals, car-park bounds, sterility (no arriving passenger in the departures lounge), finite positions and gate conflicts.
- `DUB.runAllAsync(); DUB.status()` runs every day under every roster in the background.

**Rostering assumptions (illustrative):**

- 165 passengers per security lane-hour for an average traveller, adjusted for the traveller mix. Lanes are rostered at 95% utilisation per 30-minute slot, and the duty manager adds up to three surge lanes once the wait passes 20 minutes.
- Passport checks take 18 s (EU), 12 s (UK and Common Travel Area), 60 s (non-EU) and 22 s at eGates (15% are rejected to a booth). Booths are rostered at 90% utilisation.
- The taxi dispatcher calls 25% more cabs while a rank queue is over 40 parties.
- Costs: five screeners per lane at €38 an hour, €54 per officer-hour.
- Security opens at 02:30 in T1 and 03:30 in T2, the hours published on dublinairport.com.
