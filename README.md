# Dublin Airport, TimesFM 3

A zero-shot forecast on a **synthetic** daily Dublin Airport series, using [TimesFM 3](https://research.google/blog/timesfm-3-a-zero-shot-foundation-model-for-multivariate-forecasting/). The checkpoint is not fine-tuned. The script generates the data, calls the model three ways, and writes a chart.

The passengers, movements, and delays are invented. They follow a summer peak, a weekly wave, and a split between a short-haul Terminal 1 and a long-haul Terminal 2 so the picture is recognizable. They are not Dublin Airport Authority figures.

## What the three calls show

TimesFM 3 keeps the decoder-only setup of earlier TimesFM models and adds a native multivariate path. On this dataset that path is used as follows.

| Role | Series | What the model is given |
| --- | --- | --- |
| Targets | Terminal 1 and Terminal 2 passengers | History only. Forecast jointly. |
| Past-only covariate | Average departure delay (minutes) | History only. The 11 March 2026 fog day is in the truth, and its delay is withheld. |
| Past-and-future covariates | Scheduled movements by terminal, and a 0/1 event flag | History and the next 28 days. |

The event flag marks bank holidays, St Patrick's Day, the Christmas getaway, and irregular waves (conferences, charters, and two horizon-only spikes: an aviation summit on 4–5 March 2026 and a route launch on 24–25 March). Those March spikes do not fall on the same dates in earlier years, so a history-only forecast has no day-of-year cue for them. The schedule covariate jumps on the same days, because the synthetic airlines add flights.

The three forecasts on the 1–28 March 2026 holdout:

1. **Univariate.** Each terminal from its own history. On the chart this is the orange line.
2. **Joint, no covariates.** Both terminals in one forward pass, so cross-series attention can run, with no schedule, event, or delay inputs. On this series it tracks the univariate forecast, so it is left off the chart and kept in `outputs/metrics.csv`.
3. **Joint with covariates.** The same two targets, plus delay (past only) and schedule plus events (past and future). The chart's blue line and 10–90% band are this call. Amber bands are event days.

On this seed the covariate forecast follows the summit, St Patrick's Day, and the route launch. The history-only forecasts miss those spikes. All three miss 11 March: that dip comes from fog delay, and the delay is not passed in for the horizon.

`outputs/dublin_airport_forecast.png` (and the PDF beside it) is the classroom figure. The top row is the rule: passenger counts and delay are masked on the horizon, while the event calendar and the flight schedule are shown. The lines then show that rule at Terminal 1, with the same pass plotted for Terminal 2. The bars are the mean absolute error for ordinary days, event days, and the fog day.

## Run

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python forecast_dublin_airport.py
```

The first run downloads `google/timesfm-3.0-pytorch` (about 1.3 GB). Outputs:

- `data/dublin_airport_daily.csv` — full synthetic history and horizon truth
- `outputs/forecast.csv` — point forecasts and the 10/50/90% quantiles
- `outputs/metrics.csv` — MAE, RMSE, and MAPE on all days, event days, and the fog day
- `outputs/dublin_airport_forecast.png`

`python forecast_dublin_airport.py --data-only` writes the CSV and skips the model.

TimesFM 3 weights are under the [TimesFM Non-Commercial License v1.0](https://huggingface.co/google/timesfm-3.0-pytorch). This script is a local demonstration, not a production forecast. On Apple silicon the install uses the MLX backend (`timesfm[mlx]` from the upstream GitHub tree). The script falls back to PyTorch if MLX is not importable.

## Destination markets

`forecast_markets.py` splits each terminal into destination markets and forecasts them with the same checkpoint. Terminal 1 has the United Kingdom, Europe city & business, and Europe sun & leisure. Terminal 2 has the United Kingdom, Europe city & business, North America (US preclearance), and Middle East & long-haul. Market shares move with the season, the weekday, Irish school holidays and the event calendar, and the markets add up exactly to the terminal totals. Like the terminal series, the split is invented.

Each terminal's markets are forecast two ways: each market from its own history, and all markets jointly with the market flight schedules and the event flag (past and future) and departure delay (past only). On this seed, the city & business market misses event days by about a third with history only, and by 3–4% with covariates.

Each market also carries a passenger mix (business, leisure, family, group, reduced mobility). The mix is a calendar rule known in advance, not a forecast.

```bash
python forecast_markets.py   # writes data/dublin_airport_markets.csv, outputs/market_forecast.csv, outputs/market_metrics.csv
```

## Operations: direction, ground transport and car parks

`forecast_operations.py` adds the rest of the operating picture on the same synthetic series:

- **Direction.** Each market's passengers split into departures and arrivals. The departing share starts at one half and moves with Fridays and Sundays, the edges of school holidays, and events that pull one way (a summit brings people in on day one and takes them home on day two). An `event_direction` calendar covariate, known in advance, says which way an event pushes.
- **Landside.** Taxi pickups and drop-offs, bus and coach passengers, kerb drop-offs and car hire, from the passenger mix and each market's share of residents (visitors have no car at the airport).
- **Car parks.** Holiday Blue and the short-term car parks carry cars over from earlier days through trip-length distributions, so each day starts with the cars still parked from earlier trips.
- **Staff** per shift, scaled with the day's traffic.

TimesFM forecasts arrivals and departures by market (jointly per terminal, with market schedules, events, event direction and school holidays as covariates), plus taxi pickups, bus passengers, Holiday Blue entries and Holiday Blue occupancy. On event days, history-only forecasts miss city & business arrivals by about a third and taxi demand by 30%. With covariates the errors are 9% and 11–15%. Holiday Blue occupancy moves slowly, so both forecasts handle it well.

```bash
python forecast_operations.py   # writes data/dublin_airport_directions.csv, data/dublin_airport_landside.csv, outputs/ops_forecast.csv, outputs/ops_metrics.csv
```

## Operations twin (flow demo)

`flow_demo/index.html` simulates the whole airport for a chosen March 2026 day. Each dot is one person: filled dots depart, rings arrive. The map is one combined schematic, stacked by level from north to south: piers and gates, departures, upper road, arrivals, lower road, baggage hall, ring road and car parks.

- **Departures.** Passengers reach the airport by kerb drop-off, taxi, bus, short-term car park, Holiday Blue shuttle or car-hire shuttle. They check in, go through security (Fast Track included), walk through duty free, and visit restaurants, bars, shops and lounges before heading to the gate or a bus gate.
- **Arrivals.** Passengers walk the pier arrivals lane and a sterile corridor to passport control (EU/UK, non-EU and eGates). They wait at the right carousel for their bags, pass through customs, meet their greeter in the arrivals hall, and leave by taxi rank, bus, shuttle, car hire or car park.
- **Transfers** connect through Flight Connections Security. **Meeters and greeters** and **staff** (shift arrivals through staff search) are included too.
- **Aircraft** turn round on stand. Late arrivals are towed off to overnight parking, long transatlantic turnarounds are towed to remote stands, and overflow flights use remote stands boarded by bus.
- **Baggage.** Bags move from check-in belts through screening and the sorter to make-up laterals and tugs, and from aircraft to carousels, where owners collect them.
- **Roads.** Cars, taxis, buses and shuttles follow each other on one-way roads. When the kerb is full they queue or drive round again.

Outlet, lounge, carousel and car-park names come from daa's public terminal map (pcmap-dub). Their capacities, and every spend figure, are invented: spend is shown only as category totals labelled illustrative.

The roster selector (keys 1–3) applies the chosen forecast to security lanes, immigration officers, taxi call-ins and Holiday Blue shuttle frequency. People follow the day's actual demand. The left panel's outlook table and the calendar markers show where the history-only roster breaks. The timelines under the map switch between security, immigration, taxi rank, car parks and bag delivery.

On this seed:

| Day | Roster | Security peak | Immigration peak | Taxi rank peak | Missed flights |
| --- | --- | --- | --- | --- | --- |
| 4 Mar (summit, inbound) | Covariates | 5 min | 22–28 min | ~45 min | 0 |
| 4 Mar | History only | 12 min | 37–63 min | ~3 hours | 0 |
| 5 Mar (summit, outbound) | Covariates | 5 min | 15–36 min | 26 min | 17 |
| 5 Mar | History only | 52 min | 22–50 min | 44 min | ~300 |
| 17 Mar (St Patrick's Day) | Covariates | 7 min | 27–36 min | 13 min | 0 |
| 17 Mar | History only | 25 min | 40–44 min | 9 min | 3 |

Normal days stay inside target under both rosters.

```bash
python flow_demo/export_flow_data.py   # after the three forecast scripts; writes flow_demo/flow_data.js
python -m http.server 8765 --directory flow_demo
```

Then open http://localhost:8765, or open `flow_demo/index.html` straight from disk. The code is split into classic scripts under `flow_demo/js/` (no build step).

| Key or control | Action |
| --- | --- |
| Space | Play and pause |
| Arrow keys | Jump 15 minutes |
| 1–3 | Switch the roster |
| W, D, A, L, B | Camera presets (whole, departures, arrivals, landside, baggage) |
| C | Cycle the dot colouring (stage, flow, wait, traveller, market, terminal) |
| P | Performance meter |
| Click a dot | Follow that person |
| Departures-board row | Zoom to its gate |

In the browser console, `DUB.runHeadless({ di, plan })` runs a full day without drawing and checks the invariants:

- every departing passenger boards or misses
- arrivals leave by one mode
- car parks stay within capacity
- bag counts balance
- the live waits agree with the full-day queue model

**Assumptions (illustrative):**
- 150 passengers per security lane-hour for an average traveller, adjusted for the traveller mix; up to three surge lanes once the wait passes 20 minutes.
- Passport checks take 18 s (EU), 12 s (UK, Common Travel Area), 60 s (non-EU) and 22 s at eGates (15% rejected to a booth).
- First bag 10–14 minutes after on-block.
- Taxi rank loading 30–60 s.
- Bus and coach timetables are generic.

Security opens at 02:30 in T1 and 03:30 in T2, the hours published on dublinairport.com.
