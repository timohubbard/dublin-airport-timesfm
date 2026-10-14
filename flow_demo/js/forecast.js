'use strict';
/* ====================================================================
   Forecast access, risk appetite and scenarios.

   Every roster reads its forecast through planValue(node, planKey):
     'hist'      TimesFM from history only (reconciled)
     'tfm'       TimesFM with schedule and events, median (= 'q5')
     'p90'       the same model's calibrated P90 (= 'q9')
     'qN'        calibrated quantile LEVELS[N], P5 ... P95
   The quantiles are split-conformal calibrated on 52 backtest origins and
   reconciled across terminal / market / direction (see the Python side).

   Scenarios change the day's actual demand or capacity. For the three
   demand scenarios TimesFM was re-run with the changed covariates, so
   "tell the forecast" scales the covariate plans by TimesFM's own answer;
   the history-only model cannot be told anything.
   ==================================================================== */
const META = DATA.meta || {};
const LEVELS = META.levels || [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const LEVEL_NAME = i => `P${Math.round(LEVELS[i] * 100)}`;
const RISK_LEVELS = [5, 6, 7, 8, 9, 10];   // P50 ... P95, the risk-appetite slider
function planLevelIndex(planKey) {
  if (planKey === 'tfm') return 5;
  if (planKey === 'p90') return 9;
  if (planKey && planKey[0] === 'q') return +planKey.slice(1);
  return 5;
}
const planLabel = k => k === 'hist' ? 'History only' : k === 'tfm' ? 'Covariates P50' : k === 'p90' ? 'Covariates P90' : `Covariates ${LEVEL_NAME(planLevelIndex(k))}`;
const planShort = k => k === 'hist' ? 'Hist.' : LEVEL_NAME(planLevelIndex(k));

/* ---- scenarios ---- */
const SCN = { kind: null, told: true };
const SCENARIO_DEFS = {
  event: { name: 'Event announced', demand: true, desc: 'A conference-sized event is announced for the day. Airlines add 5% seats; demand rises most on Europe city and UK routes.' },
  cancel: { name: '10% of flights cancelled', demand: true, desc: 'An airline cancels 10% of the day’s schedule in advance (strike, aircraft shortage). Some passengers rebook onto other flights.' },
  extra: { name: 'New route, +6 movements', demand: true, desc: 'A new European city route adds six movements at Terminal 1.' },
  fog: { name: 'Low visibility 06–11h', demand: false, desc: 'Fog through the morning bank: low-visibility procedures close one runway, so the runway rate halves (illustrative 30 movements/h) and arrivals hold.' },
  storm: { name: 'Storm (red warning)', demand: false, desc: 'An Éowyn-style storm: storm-force gusts 07–11h, near-suspension of the runway, 30% of flights cancelled in advance and passengers stay away.' },
  lanes: { name: 'Security lanes out of service', demand: false, desc: 'Three T1 security lanes are out of service all day (equipment fault).' },
  egate: { name: 'eGates down', demand: false, desc: 'The eGates are down in both terminals; every passenger who would use them goes to a booth.' },
  taxi: { name: 'Taxi shortage', demand: false, desc: 'Only three in four of the taxis called in to the holding area turn up (a driver protest or a big event in town).' },
};
// The "truth" in each demand scenario, for the simulated people (illustrative).
const EVENT_LIFT_SCN = { eu_city: 0.14, uk: 0.10, eu_sun: 0.04, na: 0.06, long: 0.03 };
const scenarioActive = k => SCN.kind === k;
const scnTold = () => SCN.kind && SCENARIO_DEFS[SCN.kind].demand && SCN.told;
/* Lanes available: t omitted gives what the roster can plan with; with t,
   what is physically open (a custom scenario's failures). */
const maxLanesOf = (key, t) => Math.max(0, GEO[key].maxLanes - (SCN.kind === 'lanes' && key === 't1' ? 3 : 0) - (typeof lanesLost === 'function' ? lanesLost(key, t) : 0));
const taxiSupplyFactor = (t, key) => (SCN.kind === 'taxi' ? 0.75 : 1) * (t != null && typeof shockMag === 'function' ? 1 - clamp(shockMag('taxi_shortage', key, t) + Math.min(0.4, roadDelayAt(key, t) / 150), 0, 0.95) : 1);

/* Which forecast the covariate rosters use: the 28-day plan made on 1 March,
   or the refresh made the evening before each day (latest passengers and the
   latest weather forecast). */
const SRC = { dayahead: false };
const useDayAhead = node => SRC.dayahead && node && node.da;
function planValue(node, planKey) {
  if (!node) return 0;
  if (planKey === 'hist') return node.univariate ?? (node.plan ? node.plan.hist : 0);
  const li = planLevelIndex(planKey);
  if (useDayAhead(node)) return node.da.q[li] * scnFactor(node);
  let v = node.q ? node.q[li] : li === 9 ? (node.plan ? node.plan.p90 : node.q90) : (node.plan ? node.plan.tfm : node.joint_with_covariates);
  return v * scnFactor(node);
}
/* Forecast quantile row for a node: model 'cov' or 'uni', scenario-aware. */
function nodeQ(node, model = 'cov') {
  const q = model === 'uni' ? node.uq : useDayAhead(node) ? node.da.q : node.q;
  if (!q) return null;
  const f = model === 'cov' ? scnFactor(node) : 1;
  return q.map(v => v * f);
}

/* The day the simulation runs: the exported day, changed by the scenario. */
function scenarioDay(di) {
  const base = DATA.days[di];
  if (!SCN.kind) return base;
  const d = JSON.parse(JSON.stringify(base));
  if (SCN.kind === 'custom') { if (SCN.custom) customDay(d); d._scenario = 'custom'; return d; }
  const scaleNode = (n, f) => { if (!n) return; n.actual = Math.round(n.actual * f); };
  const ratio = { t1: 1, t2: 1 };
  if (SCN.kind === 'event' || SCN.kind === 'cancel' || SCN.kind === 'fog' || SCN.kind === 'storm') {
    for (const k of TERMS) {
      const before = d[k].actual;
      let after = 0;
      for (const m of TERMINAL_MARKETS[k]) {
        const md = d.markets[k][m];
        const f = SCN.kind === 'event' ? 1 + EVENT_LIFT_SCN[m] : SCN.kind === 'cancel' ? 0.93 : SCN.kind === 'storm' ? 0.72 : 0.99;
        for (const dir of ['dep', 'arr']) scaleNode(md[dir], f);
        md.actual = md.dep.actual + md.arr.actual;
        if (SCN.kind === 'event') md.movements = Math.round(md.movements * 1.05);
        if (SCN.kind === 'cancel') md.movements = Math.round(md.movements * 0.9);
        after += md.actual;
      }
      d[k].actual = after; ratio[k] = after / Math.max(1, before);
      if (SCN.kind === 'event') d[k].movements = Math.round(d[k].movements * 1.05);
      if (SCN.kind === 'cancel') d[k].movements = Math.round(d[k].movements * 0.9);
    }
  }
  if (SCN.kind === 'extra') {
    const md = d.markets.t1.eu_city, extra = Math.round(3 * 186 * 0.85);
    md.movements += 6; md.dep.actual += extra; md.arr.actual += extra; md.actual += 2 * extra;
    ratio.t1 = (d.t1.actual + 2 * extra) / d.t1.actual; d.t1.actual += 2 * extra; d.t1.movements += 6;
  }
  if (SCN.kind === 'fog') { d.cancelledPct = Math.max(d.cancelledPct || 0, 2); d.disruption = 'Low visibility 06–11h (scenario)'; }
  if (SCN.kind === 'storm') { d.cancelledPct = 30; d.disruption = 'Storm-force winds (scenario)'; }
  if (d.landside) for (const k of TERMS) { scaleNode(d.landside.taxi[k], ratio[k]); scaleNode(d.landside.bus[k], ratio[k]); }
  if (d.landside) { const r = (ratio.t1 + ratio.t2) / 2; scaleNode(d.landside.hbEntries, r); }
  d._scenario = SCN.kind;
  return d;
}

/* ---- costs (illustrative) ---- */
const COST = {
  laneStaff: 5,          // screeners per open lane
  screenerHour: 38,      // € per screener-hour
  officerHour: 54,       // € per immigration officer-hour
  serviceWait: { sec: 15, imm: 20, taxi: 10 },   // the service-level wait used for "% within"
  goal: 0.95,            // share of passengers within that wait the recommendation aims for
};
