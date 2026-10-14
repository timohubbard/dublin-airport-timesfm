# Overnight notes, 13–14 October 2026

What changed overnight, what the numbers say, and what to look at first.

## Try it first (5 minutes)

```bash
python -m http.server 8765 --directory flow_demo
```

Open http://localhost:8765 and press **T** for the guided tour (11 steps, about 4 minutes). Then:

- **F**: the Forecast Studio.
- **Roster & risk** tab: drag the risk slider.
- **What if** tab: try "Event announced" with "Tell the forecast" on and off.
- **R**: the printable briefing.

## 1. The forecasting is now defensible

- **Leakage removed.** The old "0.6% error on event days" came from the schedule covariate being the realised flights, with passengers being the schedule times a constant.
  - The covariate is now the **published** schedule.
  - Passengers depend on an unobserved load factor (persistent demand drift, event sizes no covariate reveals).
  - Operated flights, cancellations and delays are past-only.
- **Real data.** Monthly totals, destination mix and direction are calibrated to CSO tables TAM08 and TAM07 for Dublin Airport (`real_data.py`, `reference_data/`). The rolling 12 months to June 2026 is 37.4m passengers.
- **Rolling backtest.** 52 weekly origins; the first 26 calibrate and the last 26 are scored unseen. Compared against four baselines, including the planner's own "schedule × recent load" method.
  - Terminals: **2.7%** WAPE against 4.2% (planner's method) and 4.4% (history only).
  - Event days: **3.1%** against 15.0% history only.
  - Every difference has a bootstrap interval that excludes zero.
- **Calibrated bands.** Split-conformal (normalised CQR, with event days calibrated separately), P5 to P95.
  - 80% bands cover 80–83% of unseen days; 90% bands cover 90–93%.
  - A first attempt that shifted the quantiles imported a bias from the calibration months, so I switched to scale-only CQR.
- **MinT reconciliation.** The hierarchy now adds up exactly, and error falls slightly at every level.
  - Reconciling every quantile level narrowed the market bands to 39% coverage in March. So only the median is reconciled, and each node's own band is re-centred on it.
- **Explanations.** Exact Shapley values for the schedule, event and calendar groups (8 TimesFM runs per family).
- **Scenarios.** TimesFM re-forecasts each March day for: event announced, 10% of flights cancelled, and a new route.
- **Speed.** TimesFM on MLX takes about 0.15 s per joint call. The whole pipeline (`python run_all.py`) takes about 4 minutes, and seconds on re-runs (disk cache).
- **Tests.** `pytest` has 15 tests: metrics against hand-computed values, conformal coverage, MinT coherence, data invariants and the leakage guard.

## 2. Decision tools in the twin

- **Risk appetite.** Any calibrated quantile, P50 to P95, can drive the rosters (slider, or keys `[` `]`).
- **Cost against risk.**
  - For each security roster: staff cost against the share of passengers expected within 15 minutes.
  - That share is measured **before the day**, by queueing the forecast's whole distribution through the same queue model, and set against what the actual day delivered.
  - The app recommends the cheapest roster that keeps 95% of passengers within 15 minutes.
- **Alerts.** Windows that break the service level if demand lands on P90, with one-click "+N lanes/booths".
- **What-if scenarios.**
  - Demand: event, cancellations, new route; TimesFM is re-run when "tell the forecast" is on.
  - Capacity: fog, three lanes out, eGates down, taxi shortage.
- **Outlook table.** Peak wait, % within the service level and staff-hours for every roster, plus total illustrative €.

## 3. Presentation

- Guided tour (T), Forecast Studio (F), daily ops briefing with print/PDF and roster CSV (R), help and shortcuts (?), a first-visit hint.
- The URL keeps the day, time, roster and scenario, so a link reopens the same view.
- Focus styles, reduced-motion support, and larger minimum text.

## Changes to the simulation you should know about

- **Demand is about 20% higher than before** in March (CSO level: about 93.5k a day), which exposed bottlenecks:
  - **First departure wave flattened** (06:00 weights down, 07:00–10:00 up). The T1 peak was about 5,900 passengers an hour at 04:30 on 27 March.
  - **Security** at 165 passengers per lane-hour (was 150), rostered slot by slot at 95% utilisation (was 90% plus one-slot look-ahead). This makes the cost-versus-risk trade-off visible: history-only rosters let 4.9% of passengers wait over 15 minutes across the month, P50 1.1% and P90 1.0%.
  - **Taxi ranks** have 17 bays at T1 and 14 at T2 (were 12 and 10), with faster loading. The live rank was throughput-bound at about 400 parties an hour.
  - **Taxi dispatcher surge** (+25% while a queue is over 40 parties), matching the surge rules at security and passport control.
- **27 March** (the Friday the Easter school holidays start) is now a genuine stress day. T1 security is capacity-bound and about 200 passengers miss flights under every roster. This is a good "capacity, not forecasting" talking point. If you'd rather not show it, the depW tables in `flow_demo/js/params.js` set the morning peak.

## Verification

- `pytest`: 15 passed.
- `python run_all.py`: complete; results above and in `outputs/`.
- Browser: no console errors. Tour, Studio, scenarios, briefing and alerts were exercised programmatically.
- `DUB.runAllAsync()` over 28 days × 3 rosters: **84/84 pass**.
  - Every departing passenger boards or is counted as missed.
  - No invariant problems (car parks, sterility, NaN positions).
  - Gate conflicts ≤ 2, except 5 on the fog day, where delays hold stands. The check allows that on disruption days.
  - The first full run flagged US-preclearance gate clashes on three days. Fixed by spreading the North American bank slightly and boarding US flights from 75 minutes out (was 90).
- **Performance**, St Patrick's Day at 07:15 (11,400 people, 280 vehicles): frame p95 8.4 ms, sim step 1.1 ms, render 2.0 ms.

**The month in the twin** (all 28 March days, actual demand):

| Roster | Missed flights | Mean daily security peak | Days with a security or passport peak over 30 min | Worst taxi-rank wait |
| --- | --- | --- | --- | --- |
| History only | 694 | 14.5 min | 8 | 117 min (summit) |
| Covariates P50 | 249 | 5.1 min | 7 | 81 min (summit) |
| Covariates P90 | 236 | 4.7 min | 3 | 19 min |

About 235 of the missed flights under the P50 and P90 rosters are on 27 March (Easter getaway), when T1 security is capacity-bound under every roster.

On the summit day the live taxi rank does worse than the outlook model expects (81 against 26 min at P50): once the holding area runs dry, the rank needs time to recover. A good talking point for P90 taxis; the queue models could be tuned further.

## Questions for the morning

1. **The 32m cap line** in the Studio's CSO chart is labelled as a reference only, with a note that its status is contested. Keep it or remove it for the DAA audience?
2. **The terminal split of UK and Europe city traffic** (55/45 across T1/T2) is my assumption. If DAA can share the real allocation, it slots straight into `real_data.T1_PART`.
3. **Costs** (€38 an hour per screener, 5 per lane; €54 per officer-hour) and **the service goal** (95% within 15 minutes) are placeholders in `flow_demo/js/forecast.js` (`COST`).
4. **TimesFM 3 weights are non-commercial.** Worth flagging before anything beyond a demo.

---

# Weather update, 14 October 2026

The weather plan was approved: real Dublin weather, with ECMWF IFS (physics) set against AIFS (AI).

## What changed

**Data.** `weather_data.py` caches four sources in `reference_data/weather/`:
- Met Éireann station 532, hourly
- METAR for EIDW (IEM)
- ECMWF IFS and AIFS forecasts **as issued**, 1–7 days ahead (Open-Meteo Previous Runs; IFS from Feb 2024, AIFS from Mar 2024)

Met Éireann's warnings archive ends in August 2023, so warnings aren't used.

**History.** The synthetic history now follows real weather:
- Storm Darragh and Storm Éowyn cancel about 30% of flights.
- Freezing fog, snow, strong winds and frost add cancellations and delays.
- Rain lifts taxi demand.
- The scripted 11 March fog day is gone. Real March 2026 had a wet, windy 12th (gusts 42 kt, 21 mm), snow showers on the 13th and 15th, and frosty mornings.

**Forecasting:**
- Weather forecast covariates are built per origin, with no hindsight (tested).
- The disruption-risk model is scored against climatology.
- The backtest has five weather variants, online conformal calibration, and Mondrian cells for weather-risk days.
- The production model is **gated AIFS**: weather is used only when its own risk model flags the day.
- A **day-before refresh** runs for every March day.

**Twin:**
- **Runway:** a rate model (low visibility, crosswind, storm), with de-icing and rain-driven taxi demand.
- **Map:** a weather badge, fog haze and rain.
- **Plans:** a choice between the plan made on 1 March and the plan updated the day before.
- **Alerts and scenarios:** weather alerts, plus "Low visibility 06–11h" and "Storm" scenarios.
- **Studio and tour:** a Studio weather card (risk build-up by lead, IFS vs AIFS skill, value of weather) and a weather step in the tour.

## The honest headline

- Always-on weather adds noise on ordinary days.
- Gated AIFS is never worse and helps on disruption days in week 1: −0.53 points for terminals, but on only 9 days.
- Weather is a 1–7 day signal. The real win is the day-before refresh: error across all series drops from 5.4% to 3.4% in March.
- IFS forecasts wind more accurately; AIFS keeps more disruption-risk skill at 4–7 days.
- Online calibration gives 77–81% coverage for 80% bands. That is a little under target in winter, because real weather makes winter errors larger.
- MinT now costs about 0.1 point of accuracy for exact coherence. It used to improve accuracy slightly.

## Verification (weather update)

- `pytest`: 19 passed (including the as-issued leak guard and the Storm Éowyn check).
- `DUB.runAllAsync()`: **84/84 pass** with weather on.
- **March missed flights:** history only 445, P50 250, P90 192. Under P50 and P90 they all fall on 27 March, which is capacity-bound.
- **Security peaks:** mean daily 12.9 / 5.0 / 4.4 min.
- **Worst taxi wait:** 108 / 58 / 11 min.
- **Runway holding:** calm days hold 8–57 movements for more than 5 minutes (up to about 10 min); windy 12 and 24 March about 75 (up to 16 min). The fog and storm scenarios hold for 2–3 hours.
- **Performance, 12 March 09:15, weather on:** frame p95 8.4 ms, step 2.0 ms, render 2.4 ms.
