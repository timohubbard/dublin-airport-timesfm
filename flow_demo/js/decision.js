'use strict';
/* ====================================================================
   Decisions: what a roster costs, how likely it is to fail, and what to
   change.

   Cost       staff-hours and illustrative € for security lanes and
              immigration booths; taxis called for the rank.
   Ex-ante    the roster is tested against the whole forecast
   risk       distribution, not just the actual day: the day's intraday
              shape (from the published schedule) is scaled to each
              calibrated quantile P5 ... P95 and queued through the same
              fluid model. Weighting those outcomes gives the expected
              share of passengers waiting past the service level and the
              chance the peak breaks the hard threshold, before the day
              happens.
   Pareto     cost against ex-ante risk for every risk-appetite level.
   Alerts     windows where the chosen roster breaks the service level if
              demand lands on its P90, with the extra servers that fix it.
   ==================================================================== */

// Probability weight of each calibrated quantile, from the midpoints between levels.
const LEVEL_W = LEVELS.map((l, i) => {
  const lo = i === 0 ? 0 : (LEVELS[i - 1] + l) / 2, hi = i === LEVELS.length - 1 ? 1 : (l + LEVELS[i + 1]) / 2;
  return hi - lo;
});

function planCost(resId, plan) {
  if (resId === 'sec') {
    let laneH = 0; for (let s = 0; s < plan.length; s++) laneH += plan[s] * SLOT / 3600;
    const staffH = laneH * COST.laneStaff;
    return { units: laneH, unitName: 'lane-h', staffH, eur: staffH * COST.screenerHour };
  }
  if (resId === 'imm') {
    let h = 0; for (let s = 0; s < plan.eu.length; s++) h += (plan.eu[s] + plan.non[s]) * SLOT / 3600;
    return { units: h, unitName: 'officer-h', staffH: h, eur: h * COST.officerHour };
  }
  let n = 0; for (let s = 0; s < plan.length; s++) n += plan[s];
  return { units: n, unitName: 'taxis called', staffH: 0, eur: 0 };
}

/* Forecast total departing (landside) passengers for a terminal at quantile index li. */
function secForecastAt(g, key, li) {
  let v = 0;
  for (const m of TERMINAL_MARKETS[key]) {
    const md = g.mk[key][m], q = nodeQ(md.dep);
    v += (q ? q[li] : planValue(md.dep, 'q' + li)) * (1 - md.ts);
  }
  return v;
}
function scaled(arr, f) { const out = new Float32Array(arr.length); for (let i = 0; i < arr.length; i++) out[i] = arr[i] * f; return out; }

/* Ex-ante risk of a security roster against the forecast distribution. */
function secRisk(g, key, plan) {
  const actualTot = g.total[key] || 1;
  let late = 0, breach = 0, peakSum = 0;
  const rows = [];
  for (let li = 0; li < LEVELS.length; li++) {
    const f = secForecastAt(g, key, li) / actualTot;
    const o = fluid(scaled(g.secArr[key], f), plan, maxLanesOf(key), LANE_RATE / g.svcMult[key]);
    const share = o.tot ? o.late / o.tot : 0;
    late += LEVEL_W[li] * share; breach += LEVEL_W[li] * (o.peak > RES.sec.threshold ? 1 : 0); peakSum += LEVEL_W[li] * o.peak;
    rows.push({ level: LEVELS[li], peak: o.peak, share });
  }
  return { late, breach, peak: peakSum, rows };
}

/* Cost and ex-ante risk for every risk-appetite level (and history only). */
function paretoSecurity(g) {
  const keys = ['hist', ...RISK_LEVELS.map(i => 'q' + i)];
  return keys.map(k => {
    let cost = 0, late = 0, breach = 0, tot = 0, actualLate = 0;
    for (const t of TERMS) {
      const plan = planLanes(g, t, k, state.offset.sec[t]);
      const c = planCost('sec', plan), r = secRisk(g, t, plan), w = g.total[t];
      const act = RES.sec.outlook(g, t, plan);
      cost += c.eur; late += r.late * w; breach = Math.max(breach, r.breach); tot += w; actualLate += act.tot ? act.late : 0;
    }
    return { key: k, cost, late: late / tot, breach, actual: actualLate / Math.max(1, tot) };
  });
}
function recommendLevel(pareto) {
  const ok = pareto.filter(p => p.key !== 'hist' && 1 - p.late >= COST.goal);
  return ok.length ? ok.reduce((a, b) => (b.cost < a.cost ? b : a)) : pareto[pareto.length - 1];
}

/* Alerts for the chosen roster: P90-demand windows past the service wait. */
function alertsFor(g) {
  const out = [], li = 9;
  for (const k of TERMS) {
    // Security.
    const plan = plans.sec[k], f = secForecastAt(g, k, li) / (g.total[k] || 1);
    const demand = scaled(g.secArr[k], f);
    const o = fluid(demand, plan, maxLanesOf(k), LANE_RATE / g.svcMult[k]);
    for (const w of windows(o.wait, COST.serviceWait.sec)) {
      let extra = 0;
      for (let d = 1; d <= 6; d++) {
        const p2 = planLanes(g, k, state.plan, state.offset.sec[k] + d);
        const o2 = fluid(demand, p2, maxLanesOf(k), LANE_RATE / g.svcMult[k]);
        if (o2.peak <= COST.serviceWait.sec) { extra = d; break; }
      }
      out.push({ res: 'sec', key: k, from: w.from, to: w.to, peak: w.peak, extra,
        text: `${GEO[k].short} security ${fmtHM(w.from)}–${fmtHM(w.to)}: up to ${Math.round(w.peak)} min if demand lands on P90` });
    }
    // Immigration: scale the actual arrivals by the forecast P90 / actual ratio.
    let arrQ = 0, arrA = 0;
    for (const m of TERMINAL_MARKETS[k]) { const md = g.mk[k][m], q = nodeQ(md.arr); arrQ += q ? q[li] : planValue(md.arr, 'p90'); arrA += md.arr.actual; }
    const fi = arrQ / Math.max(1, arrA);
    const ig = { ...g, immArr: { ...g.immArr, [k]: { eu: scaled(g.immArr[k].eu, fi), non: scaled(g.immArr[k].non, fi), egate: scaled(g.immArr[k].egate, fi) } } };
    const oi = fluidImm(ig, k, plans.imm[k]);
    for (const w of windows(oi.wait, COST.serviceWait.imm)) {
      let extra = 0;
      for (let d = 1; d <= 6; d++) {
        const o2 = fluidImm(ig, k, planImm(g, k, state.plan, state.offset.imm[k] + d));
        if (o2.peak <= COST.serviceWait.imm) { extra = d; break; }
      }
      out.push({ res: 'imm', key: k, from: w.from, to: w.to, peak: w.peak, extra,
        text: `${GEO[k].short} passport control ${fmtHM(w.from)}–${fmtHM(w.to)}: up to ${Math.round(w.peak)} min if arrivals land on P90` });
    }
  }
  out.sort((a, b) => b.peak - a.peak);
  return [...weatherAlerts(g), ...out].slice(0, 6);
}
/* Weather alerts: disruption risk from the day-before forecast, and the
   runway holding the forecast weather implies. */
function weatherAlerts(g) {
  const d = g.day, w = d.weather; if (!w) return [];
  const out = [], r = w.riskDayAhead || {}, p = Math.max(r.ifs || 0, r.aifs || 0);
  const base = (DATA.weather.climateRisk || {}).any || 0.05;
  if (p >= 0.15) out.push({ res: 'wx', key: 't1', peak: 99, extra: 0, weather: true,
    text: `Weather: disruption risk ${Math.round(p * 100)}% the day before (IFS ${Math.round((r.ifs || 0) * 100)}%, AIFS ${Math.round((r.aifs || 0) * 100)}%; usually ${Math.round(base * 100)}%). Plan for slower turnarounds and longer passport queues from late arrivals.` });
  for (const m of ['ifs', 'aifs']) {
    const win = forecastHolding(d, m);
    if (win && win.length) {
      const hrs = win.map(x => x.h), why = win[0].why;
      out.push({ res: 'wx', key: 't1', peak: 98, extra: 0, weather: true,
        text: `Runway: ${m.toUpperCase()} day-ahead forecast implies ${why} ${pad(hrs[0])}–${pad(hrs[hrs.length - 1] + 1)}h, rate down to ${Math.round(Math.min(...win.map(x => x.rate)))} movements/h: expect arrival holding.` });
      break;
    }
  }
  return out;
}
function windows(wait, limit) {
  const out = []; let cur = null;
  for (let m = 0; m < wait.length; m++) {
    if (wait[m] > limit) { if (!cur) cur = { from: DAY_START + m * 60, to: 0, peak: 0 }; cur.to = DAY_START + (m + 1) * 60; cur.peak = Math.max(cur.peak, wait[m]); }
    else if (cur && DAY_START + m * 60 - cur.to > 20 * 60) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out.filter(w => w.to - w.from >= 10 * 60);
}
