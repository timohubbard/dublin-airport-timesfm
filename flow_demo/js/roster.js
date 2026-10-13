'use strict';
/* ====================================================================
   Rostering from forecasts, and fluid queue models for the full-day
   outlook. Every forecast-driven resource follows the same pattern:
   the chosen forecast (history only, covariates P50 or P90) sets the
   servers per 30-min slot, shaped by the published schedule; the day's
   actual demand then queues against that roster.
   ==================================================================== */
const NSLOT = Math.ceil((SIM_END - DAY_START) / SLOT);
const slotOf = t => clamp(Math.floor((t - DAY_START) / SLOT), 0, NSLOT - 1);

/* ---- Security lanes (includes the two Fast Track lanes) ---- */
function planLanes(gen, key, planKey, offset) {
  const G = GEO[key], rate = new Float64Array(NSLOT);
  for (const m of TERMINAL_MARKETS[key]) {
    const arr = gen.secArrM[key][m], tot = gen.totalM[key][m] || 1, md = gen.mk[key][m];
    const fc = planValue(md.dep, planKey) * (1 - md.ts);
    for (let i = 0; i < arr.length; i++) rate[Math.floor(i * 60 / SLOT)] += arr[i] / tot * fc;
  }
  // Screening is slower when the expected mix has more families and reduced-mobility passengers.
  const need = Array.from(rate, n => Math.ceil(n * (3600 / SLOT) * gen.svcMult[key] / (LANE_RATE * SEC_UTIL)));
  const lanes = new Int16Array(NSLOT);
  for (let s = 0; s < NSLOT; s++) {
    const t = DAY_START + s * SLOT;
    if (t + SLOT <= OPEN[key]) { lanes[s] = 0; continue; }
    lanes[s] = clamp(need[s] + offset, FT_LANES + 1, maxLanesOf(key));
  }
  return lanes;
}

/* FIFO waits from cumulative arrivals and departures. */
function fifoWaits(arr, cumA, cumD, threshold, service = threshold) {
  const n = arr.length, wait = new Float32Array(n);
  let k = 0, peak = 0, over = 0, tot = 0, late = 0, paxMin = 0;
  for (let m = 0; m < n; m++) {
    if (k < m) k = m;
    while (k < n && cumD[k] < cumA[m] - 1e-6) k++;
    wait[m] = k - m;
    if (arr[m] > 0) {
      peak = Math.max(peak, wait[m]); tot += arr[m]; paxMin += arr[m] * wait[m];
      if (wait[m] > threshold) over += arr[m];
      if (wait[m] > service) late += arr[m];
    }
  }
  // over: passengers past the hard threshold; late: past the service-level wait.
  return { wait, peak, over, late, tot, mean: tot ? paxMin / tot : 0 };
}
function fluid(arr, servers, maxServers, ratePerServerHour, surgeCfg = { n: SURGE, on: SURGE_ON, off: SURGE_OFF }, threshold = 30, service = COST.serviceWait.sec) {
  const n = arr.length, cumA = new Float64Array(n), cumD = new Float64Array(n);
  let q = 0, A = 0, D = 0, surge = false;
  for (let m = 0; m < n; m++) {
    const planned = servers[Math.min(servers.length - 1, Math.floor(m * 60 / SLOT))];
    const w = planned ? q / (planned * ratePerServerHour / 60) : 0;
    surge = planned > 0 && (surge ? w > surgeCfg.off : w > surgeCfg.on);
    const cap = Math.min(maxServers, planned + (surge ? surgeCfg.n : 0)) * ratePerServerHour / 60;
    A += arr[m]; q += arr[m];
    const s = Math.min(q, cap); q -= s; D += s;
    cumA[m] = A; cumD[m] = D;
  }
  return fifoWaits(arr, cumA, cumD, threshold, service);
}

/* ---- Immigration officers (booths), split between EU/CTA and non-EU ---- */
function immSvc(gen, key) {
  // Average seconds per passenger in each channel, from the day's parties (parties are served together).
  const s = { eu: [0, 0], non: [0, 0], egate: [0, 0] };
  for (const p of gen.arrParties) {
    if (p.term !== key || p.kind !== KIND.ARR) continue;
    const base = p.ch === 'eu' && p.cta ? IMM.svc.cta : IMM.svc[p.ch];
    s[p.ch][0] += base * PERSONAS[p.persona].imm * (1 + 0.6 * (p.size - 1)); s[p.ch][1] += p.size;
  }
  const out = {};
  for (const ch in s) out[ch] = s[ch][1] ? s[ch][0] / s[ch][1] : IMM.svc[ch];
  return out;
}
function planImm(gen, key, planKey, offset) {
  const svc = gen.immSvcCache?.[key] || (gen.immSvcCache = gen.immSvcCache || {}, gen.immSvcCache[key] = immSvc(gen, key));
  const rate = { eu: new Float64Array(NSLOT), non: new Float64Array(NSLOT) };
  for (const m of TERMINAL_MARKETS[key]) {
    const md = gen.mk[key][m], tot = gen.immTotM[key][m] || 1;
    // Forecast arrivals for the market, less the share that transfers airside.
    const fc = planValue(md.arr, planKey) * (gen.immTotM[key][m] / Math.max(1, md.arr.actual));
    for (const ch of ['eu', 'non']) {
      const h = gen.immArrM[key][m][ch];
      for (let i = 0; i < h.length; i++) rate[ch][Math.floor(i * 60 / SLOT)] += h[i] / tot * fc;
    }
    // eGate rejects (15%) come back to the EU booths.
    const he = gen.immArrM[key][m].egate;
    for (let i = 0; i < he.length; i++) rate.eu[Math.floor(i * 60 / SLOT)] += he[i] / tot * fc * IMM.egateReject;
  }
  const cap = IMM.booths[key], out = { eu: new Int16Array(NSLOT), non: new Int16Array(NSLOT), egate: new Int16Array(NSLOT), svc };
  for (let s = 0; s < NSLOT; s++) {
    const t = DAY_START + s * SLOT;
    const need = ch => Math.ceil(Math.max(rate[ch][s], rate[ch][s + 1] || 0) * (3600 / SLOT) * svc[ch] / 3600 / UTIL);
    const open = t + SLOT > IMM.open;
    out.eu[s] = open ? clamp(need('eu') + offset, 1, cap.eu) : 0;
    out.non[s] = open ? clamp(need('non') + offset, 1, cap.non) : 0;
    out.egate[s] = !scenarioActive('egate') && t >= IMM.egateHours[0] - SLOT && t < IMM.egateHours[1] ? cap.egate : 0;
  }
  return out;
}
function fluidImm(gen, key, plan) {
  const svc = plan.svc, res = {};
  const surge = { n: IMM.surge, on: IMM.surgeOn, off: IMM.surgeOff };
  const sw = COST.serviceWait.imm;
  res.eu = fluid(gen.immArr[key].eu, plan.eu, IMM.booths[key].eu, 3600 / svc.eu, surge, 30, sw);
  res.non = fluid(gen.immArr[key].non, plan.non, IMM.booths[key].non, 3600 / svc.non, surge, 30, sw);
  res.egate = fluid(gen.immArr[key].egate, plan.egate, IMM.booths[key].egate, 3600 / svc.egate, { n: 0, on: 1e9, off: 0 }, 30, sw);
  const n = gen.immArr[key].eu.length, wait = new Float32Array(n), demand = new Float32Array(n);
  for (let m = 0; m < n; m++) {
    wait[m] = Math.max(res.eu.wait[m], res.non.wait[m], res.egate.wait[m]);
    demand[m] = gen.immArr[key].eu[m] + gen.immArr[key].non[m] + gen.immArr[key].egate[m];
  }
  const tot = res.eu.tot + res.non.tot + res.egate.tot;
  return { wait, peak: Math.max(res.eu.peak, res.non.peak, res.egate.peak), over: res.eu.over + res.non.over + res.egate.over,
    late: res.eu.late + res.non.late + res.egate.late, tot,
    mean: tot ? (res.eu.mean * res.eu.tot + res.non.mean * res.non.tot + res.egate.mean * res.egate.tot) / tot : 0, channels: res };
}

/* ---- Taxi supply called into the holding area ---- */
function taxiForecast(gen, key, planKey) {
  const ls = gen.day.landside;
  const actual = gen.taxiArr[key].reduce((s, x) => s + x, 0);
  if (!ls) return actual;
  const t = ls.taxi[key];
  return planValue(t, planKey) * actual / Math.max(1, t.actual);
}
function planTaxi(gen, key, planKey, offset) {
  const h = gen.taxiArr[key], tot = h.reduce((s, x) => s + x, 0) || 1, fc = taxiForecast(gen, key, planKey);
  const out = new Int16Array(NSLOT);
  const perSlot = new Float64Array(NSLOT);
  for (let i = 0; i < h.length; i++) perSlot[Math.floor(i * 60 / SLOT)] += h[i] / tot * fc;
  for (let s = 0; s < NSLOT; s++) out[s] = Math.max(0, Math.round(Math.max(perSlot[s], perSlot[s + 1] || 0) * 1.02 + offset * 10));
  return out;
}
function fluidTaxi(gen, key, supply) {
  const arr = gen.taxiArr[key], drop = gen.taxiDrop[key], n = arr.length;
  const cumA = new Float64Array(n), cumD = new Float64Array(n);
  let q = 0, stock = TAXI.bays[key], A = 0, D = 0, surge = false;
  for (let m = 0; m < n; m++) {
    surge = surge ? q > TAXI.surgeOff : q > TAXI.surgeOn;
    stock = Math.min(TAXI.holdingCap, stock + supply[Math.floor(m * 60 / SLOT)] * taxiSupplyFactor() * (surge ? TAXI.surgeX : 1) / 30 + drop[m] * TAXI.rejoin);
    A += arr[m]; q += arr[m];
    const s = Math.min(q, stock, TAXI.bays[key] * 0.8); q -= s; stock -= s; D += s;
    cumA[m] = A; cumD[m] = D;
  }
  return fifoWaits(arr, cumA, cumD, 20, COST.serviceWait.taxi);
}

/* ---- Holiday Blue shuttle frequency (buses per hour) ---- */
function planShuttle(gen, planKey) {
  const ls = gen.day.landside, h = gen.hbArr;
  const scale = ls ? planValue(ls.hbEntries, planKey) / Math.max(1, ls.hbEntries.actual) : 1;
  const out = new Int16Array(NSLOT), perSlot = new Float64Array(NSLOT);
  for (let i = 0; i < h.length; i++) perSlot[Math.floor(i * 60 / SLOT)] += h[i] * scale;
  for (let s = 0; s < NSLOT; s++) {
    const pph = Math.max(perSlot[s], perSlot[s + 1] || 0) * 2;
    out[s] = clamp(Math.ceil(pph / (HB_SHUTTLE.cap * 0.8)), HB_SHUTTLE.minPerHour, HB_SHUTTLE.maxPerHour);
  }
  return out;
}

/* ---- Resource registry used by the outlook table, timelines and risk markers ---- */
const RESOURCES = [
  { id: 'sec', name: 'Security', unit: 'lanes', threshold: 30,
    plan: (g, k, p, o) => planLanes(g, k, p, o),
    outlook: (g, k, plan, demand) => fluid(demand || g.secArr[k], plan, maxLanesOf(k), LANE_RATE / g.svcMult[k]),
    demand: (g, k) => g.secArr[k], capacity: (g, k, plan, s) => plan[s] * LANE_RATE / g.svcMult[k] / 4 },
  { id: 'imm', name: 'Immigration', unit: 'officers', threshold: 30,
    plan: (g, k, p, o) => planImm(g, k, p, o),
    outlook: (g, k, plan) => fluidImm(g, k, plan),
    demand: (g, k) => { const a = g.immArr[k], out = new Float32Array(a.eu.length); for (let i = 0; i < out.length; i++) out[i] = a.eu[i] + a.non[i] + a.egate[i]; return out; },
    capacity: (g, k, plan, s) => (plan.eu[s] * 3600 / plan.svc.eu + plan.non[s] * 3600 / plan.svc.non + plan.egate[s] * 3600 / plan.svc.egate) / 4 },
  { id: 'taxi', name: 'Taxi rank', unit: 'taxis/30 min', threshold: 20,
    plan: (g, k, p, o) => planTaxi(g, k, p, o),
    outlook: (g, k, plan) => fluidTaxi(g, k, plan),
    demand: (g, k) => g.taxiArr[k], capacity: (g, k, plan, s) => plan[s] / 2 },
];
const RES = Object.fromEntries(RESOURCES.map(r => [r.id, r]));
