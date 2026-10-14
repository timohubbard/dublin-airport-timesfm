'use strict';
/* ====================================================================
   Three forecast horizons at once.

   Month   the 28-day TimesFM plan made on 1 March (daily, calibrated bands)
   Week    the next seven days: that plan against the refresh made each
           evening before (latest passengers and ECMWF weather)
   Today   hour by hour, for passengers reaching security or passport
           control, updated live as the day happens (a nowcast)

   The hourly forecast is the daily TimesFM forecast spread over the day by
   the published timetable: every flight's seats, times the show-up pattern
   of its travellers (business, leisure, families...) before departure, or
   its scheduled arrival plus taxi-in, deplaning and the walk to passport
   control. Nothing about the day's actual passengers is used.

   Hourly bands combine the daily band (TimesFM, conformal) with the error
   of the hourly shape, measured leave-one-out on the other 27 days of
   March, so the selected day never calibrates its own bands.

   The nowcast compares what has arrived so far with what the shape
   expected by now, and updates the day's total (a normal-normal update
   on the log scale): the more of the day that has happened, the more the
   observed count weighs. The rest of the day is that total times the
   remaining shape.
   ==================================================================== */
const NH = 26;                                         // clock hours 00 ... 25
const hourOfT = t => clamp(Math.floor(t / 3600), 0, NH - 1);
const HZ = { calib: null, busy: false, cuts: [8, 12, 16] };
const HZ_SERIES = {
  sec: { name: 'Departing passengers reaching security', short: 'Security', unit: 'passengers / hour' },
  imm: { name: 'Arriving passengers reaching passport control', short: 'Passport control', unit: 'passengers / hour' },
};
const Z10 = 1.2816;
function normCdf(z) { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
/* Spread a normal(mu, sd) time (s) over clock hours, adding w. */
function addNormalHours(p, mu, sd, w) {
  const h0 = Math.max(0, Math.floor((mu - 3.5 * sd) / 3600)), h1 = Math.min(NH - 1, Math.floor((mu + 3.5 * sd) / 3600));
  let prev = normCdf((h0 * 3600 - mu) / sd);
  for (let h = h0; h <= h1; h++) { const c = normCdf(((h + 1) * 3600 - mu) / sd); p[h] += w * (c - prev); prev = c; }
}

/* Expected shape of the day from the timetable, and the daily total's quantiles. */
function hzPrior(g, k, series) {
  const p = new Float64Array(NH), q = LEVELS.map(() => 0);
  let T = 0;
  for (const m of TERMINAL_MARKETS[k]) {
    const md = g.mk[k][m], node = series === 'sec' ? md.dep : md.arr, keep = 1 - md.ts;
    const qq = nodeQ(node) || LEVELS.map(() => planValue(node, 'tfm'));
    qq.forEach((v, i) => { q[i] += v * keep; });
    const F = planValue(node, 'tfm') * keep; T += F;
    const fl = series === 'sec' ? g.flights.filter(f => f.term === k && f.market === m) : g.arrFlights.filter(a => a.term === k && a.market === m);
    const seats = fl.reduce((s, f) => s + f.seats, 0) || 1;
    const mix = md.mix || DEFAULT_MIX, meta = MARKETS[m];
    for (const f of fl) {
      const w = f.seats / seats * F;
      if (series === 'sec') {
        // Show-up before the scheduled departure, by traveller type (persona lead times), less check-in.
        let ws = 0;
        for (const pk of PERSONA_KEYS) ws += mix[pk] || 0;
        for (const pk of PERSONA_KEYS) {
          const pm = PERSONAS[pk], share = (mix[pk] || 0) / (ws || 1); if (!share) continue;
          const chk = Math.min(0.95, pm.chk * (meta.long ? 1.8 : 1));
          const lead = pm.lead[0] + (meta.long ? pm.longExtra : 0) + chk * 10 - chk * (DESK_SVC * 1.3 + 120) / 60 - 3;
          addNormalHours(p, f.std - lead * 60, pm.lead[1] * 60 * 1.05, w * share);
        }
      } else {
        // Scheduled arrival + taxi-in, doors, deplaning and the walk, plus a typical delay.
        const walk = f.gate ? polyLen(arrivalPath(GEO[k], f.gate)) / 1.2 : 420;
        addNormalHours(p, f.sta + 9 * 60 + (f.wide ? 8 : 4) * 60 + walk, 9 * 60, w);
      }
    }
  }
  const s = p.reduce((a, b) => a + b, 0) || 1;
  for (let h = 0; h < NH; h++) p[h] /= s;
  return { p, T, q };
}
/* What actually reached the queue, by clock hour (from the day's generated passengers). */
function hzRealized(g, k, series) {
  const r = new Float64Array(NH), src = series === 'sec' ? [g.secArr[k]] : [g.immArr[k].eu, g.immArr[k].non, g.immArr[k].egate];
  for (const arr of src) for (let m = 0; m < arr.length; m++) if (arr[m]) r[hourOfT(DAY_START + m * 60)] += arr[m];
  return r;
}
const cumAt = (p, t) => { const h = Math.floor(t / 3600); let c = 0; for (let i = 0; i < Math.min(h, NH); i++) c += p[i]; if (h < NH) c += p[h] * (t / 3600 - h); return c; };

/* Leave-one-out calibration over the month: hourly shape errors and
   cumulative-share errors, and a backtest of the nowcast at 08, 12 and 16h. */
function hzCalibrate(done) {
  if (HZ.calib) { done && done(); return; }
  if (HZ.busy) return;
  HZ.busy = true;
  const rec = [];
  let di = 0;
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    if (di < DATA.days.length) {
      // Calibrate on the days as they happened, whatever what-if is showing.
      const keepScn = SCN.kind; SCN.kind = null;
      const had = genCache.has(genKey(di)), g = genDay(di);
      const r = { di };
      for (const s of ['sec', 'imm']) for (const k of TERMS) {
        const pr = hzPrior(g, k, s), real = hzRealized(g, k, s);
        r[s + k] = { p: pr.p, T: pr.T, q: pr.q, r: real, R: real.reduce((a, b) => a + b, 0) };
      }
      rec.push(r);
      if (!had && di !== state.di) genCache.delete(genKey(di));
      SCN.kind = keepScn;
      di++; ch.port2.postMessage(0); return;
    }
    HZ.calib = { rec };
    HZ.busy = false;
    done && done();
  };
  ch.port2.postMessage(0);
}
/* Shape error (log share) by hour and cumulative error by time, leaving out day `skip`. */
function hzErrors(series, skip) {
  const key = `${series}|${skip}`;
  HZ.errCache = HZ.errCache || {};
  if (HZ.errCache[key]) return HZ.errCache[key];
  const sh = new Float64Array(NH), shn = new Float64Array(NH), cu = new Float64Array(NH), cun = new Float64Array(NH);
  for (const r of HZ.calib.rec) {
    if (r.di === skip) continue;
    for (const k of TERMS) {
      const o = r[series + k]; if (!o.R) continue;
      let cr = 0, cp = 0;
      for (let h = 0; h < NH; h++) {
        if (o.p[h] > 0.004) { const e = Math.log(Math.max(1e-4, o.r[h] / o.R) / o.p[h]); sh[h] += e * e; shn[h]++; }
        cr += o.r[h] / o.R; cp += o.p[h];
        if (cp > 0.02 && cp < 0.995) { const e = Math.log(Math.max(1e-4, cr) / cp); cu[h] += e * e; cun[h]++; }
      }
    }
  }
  const sd = Array.from(sh, (v, h) => (shn[h] ? Math.sqrt(v / shn[h]) : 0.6));
  const sdS = sd.map((v, h) => Math.min(1.2, (v * 2 + (sd[h - 1] ?? v) + (sd[h + 1] ?? v)) / 4));   // light smoothing
  const cum = Array.from(cu, (v, h) => (cun[h] ? Math.sqrt(v / cun[h]) : 0.5));
  return (HZ.errCache[key] = { shape: sdS, cum });
}
const logSd = q => Math.max(0.005, (Math.log(Math.max(1, q[9])) - Math.log(Math.max(1, q[1]))) / (2 * Z10));

/* The hourly forecast for one day and terminal, with a nowcast at time t
   from the observed counts by hour (obs), or none. */
function hzForecast(g, k, series, t, obs) {
  const pr = hzPrior(g, k, series), E = HZ.calib ? hzErrors(series, g.di) : null;
  const sT = logSd(pr.q), mT = Math.log(Math.max(1, pr.q[5]));
  let mPost = mT, sPost = sT, O = 0, F = 0;
  if (obs && t != null) {
    for (let h = 0; h < NH; h++) O += h < Math.floor(t / 3600) ? obs[h] : h === Math.floor(t / 3600) ? obs[h] : 0;
    F = cumAt(pr.p, t);
    if (F > 0.03 && O > 0 && E) {
      const hc = Math.min(NH - 1, Math.max(0, Math.floor(t / 3600) - 1)), sF = Math.max(0.02, E.cum[hc]);
      const x = Math.log(O / F);                         // the day's total implied by what has arrived
      const wObs = sT * sT / (sT * sT + sF * sF);
      mPost = mT + wObs * (x - mT); sPost = Math.sqrt(sT * sT * sF * sF / (sT * sT + sF * sF));
    }
  }
  const hours = [];
  for (let h = 0; h < NH; h++) {
    const sh = E ? E.shape[h] : 0.25;
    const s0 = Math.sqrt(sT * sT + sh * sh), s1 = Math.sqrt(sPost * sPost + sh * sh);
    const base = pr.p[h];
    hours.push({
      h, p: base,
      prior: { p50: Math.exp(mT) * base, p10: Math.exp(mT - Z10 * s0) * base, p90: Math.exp(mT + Z10 * s0) * base },
      now: { p50: Math.exp(mPost) * base, p10: Math.exp(mPost - Z10 * s1) * base, p90: Math.exp(mPost + Z10 * s1) * base },
    });
  }
  return { hours, prior: pr, total: { prior: Math.exp(mT), now: Math.exp(mPost), sPrior: sT, sNow: sPost }, O, F };
}

/* Backtest over the month (leave-one-out): error on the rest of the day,
   prior against nowcast, at each cut; and how often hourly bands held. */
function hzBacktest(series) {
  if (!HZ.calib) return null;
  HZ.btCache = HZ.btCache || {};
  if (HZ.btCache[series]) return HZ.btCache[series];
  const cut = HZ.cuts.map(() => ({ ePrior: 0, eNow: 0, a: 0 }));
  let inside = 0, n = 0;
  for (const r of HZ.calib.rec) {
    const E = hzErrors(series, r.di);
    for (const k of TERMS) {
      const o = r[series + k]; if (!o.R) continue;
      const sT = logSd(o.q), mT = Math.log(Math.max(1, o.q[5]));
      for (let h = 0; h < NH; h++) {
        if (o.p[h] < 0.01) continue;
        const s0 = Math.sqrt(sT * sT + E.shape[h] * E.shape[h]);
        const lo = Math.exp(mT - Z10 * s0) * o.p[h], hi = Math.exp(mT + Z10 * s0) * o.p[h];
        inside += o.r[h] >= lo && o.r[h] <= hi; n++;
      }
      HZ.cuts.forEach((c, i) => {
        const t = c * 3600, F = cumAt(o.p, t);
        let O = 0; for (let h = 0; h < c; h++) O += o.r[h];
        const rest = o.R - O;
        const sF = Math.max(0.02, E.cum[c - 1]), w = sT * sT / (sT * sT + sF * sF);
        const mPost = F > 0.03 && O > 0 ? mT + w * (Math.log(O / F) - mT) : mT;
        cut[i].ePrior += Math.abs(Math.exp(mT) * (1 - F) - rest); cut[i].eNow += Math.abs(Math.exp(mPost) * (1 - F) - rest); cut[i].a += rest;
      });
    }
  }
  return (HZ.btCache[series] = { cuts: HZ.cuts.map((c, i) => ({ c, prior: cut[i].ePrior / cut[i].a, now: cut[i].eNow / cut[i].a })), cover80: inside / Math.max(1, n), n });
}
function hzResetCaches() { HZ.calib = null; HZ.errCache = {}; HZ.btCache = {}; }

/* ---------------- drawing: Forecast Studio and the timeline ---------------- */
const hzState = { series: 'sec' };
function hzTerms() { const id = studio.series; return id === 't1' || id === 't2' ? [id] : TERMS; }
/* Forecast for the selected day, both terminals summed if needed. */
function hzToday(series = hzState.series, terms = hzTerms()) {
  const parts = terms.map(k => hzForecast(gen, k, series, sim.t, sim.obs[series][k]));
  const real = terms.map(k => hzRealized(gen, k, series));
  const hours = parts[0].hours.map((_, h) => {
    const sum = f => ({ p50: parts.reduce((s, p) => s + p.hours[h][f].p50, 0), p10: parts.reduce((s, p) => s + p.hours[h][f].p10, 0), p90: parts.reduce((s, p) => s + p.hours[h][f].p90, 0) });
    return { h, prior: sum('prior'), now: sum('now'), obs: terms.reduce((s, k) => s + sim.obs[series][k][h], 0), real: real.reduce((s, r) => s + r[h], 0) };
  });
  const tot = f => parts.reduce((s, p) => s + p.total[f], 0);
  const band = (f, sf) => { let lo = 0, hi = 0; for (const p of parts) { lo += p.total[f] * Math.exp(-Z10 * p.total[sf]); hi += p.total[f] * Math.exp(Z10 * p.total[sf]); } return [lo, hi]; };
  return { hours, prior: tot('prior'), now: tot('now'), priorBand: band('prior', 'sPrior'), nowBand: band('now', 'sNow'), O: parts.reduce((s, p) => s + p.O, 0), F: parts.reduce((s, p) => s + p.F * p.total.prior, 0) / Math.max(1, tot('prior')) };
}
function drawToday() {
  const cv = $('stToday'); if (!cv) return;
  const c = stCanvas(cv, { l: 46, r: 12, t: 12, b: 22 }); if (!c) return;
  const { g, ml, mt, W, H } = c;
  if (!HZ.calib) { g.fillStyle = '#8b9bb6'; g.fillText('Calibrating the hourly bands on the other 27 days of March…', ml + 8, mt + 16); hzCalibrate(() => { drawToday(); hzNotes(); }); return; }
  const F = hzToday(), h0 = 3, h1 = 25, X = h => ml + (h - h0) / (h1 - h0) * W;
  const now = sim.t / 3600, reveal = studio.reveal;
  let top = 1; for (const r of F.hours) if (r.h >= h0 && r.h < h1) top = Math.max(top, r.prior.p90, r.now.p90, r.obs, reveal ? r.real : 0);
  top *= 1.08;
  const Y = v => mt + H - v / top * H;
  yTicks(c, Y, 0, top);
  const bw = W / (h1 - h0);
  for (const r of F.hours) {
    if (r.h < h0 || r.h >= h1) continue;
    const x = X(r.h), past = r.h + 1 <= now, cur = r.h < now && !past;
    // Prior band (made the evening before), then the nowcast band for hours still to come.
    g.fillStyle = 'rgba(148,163,184,0.16)'; g.fillRect(x + 1, Y(r.prior.p90), bw - 2, Y(r.prior.p10) - Y(r.prior.p90));
    if (!past) { g.fillStyle = 'rgba(45,212,191,0.32)'; g.fillRect(x + bw * 0.22, Y(r.now.p90), bw * 0.56, Y(r.now.p10) - Y(r.now.p90)); }
    g.strokeStyle = 'rgba(203,213,225,0.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 2, Y(r.prior.p50)); g.lineTo(x + bw - 2, Y(r.prior.p50)); g.stroke();
    if (!past) { g.strokeStyle = '#2dd4bf'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + bw * 0.22, Y(r.now.p50)); g.lineTo(x + bw * 0.78, Y(r.now.p50)); g.stroke(); }
    // Observed so far (bars), and the rest of the actual day if revealed.
    if (past || cur) {
      const inside = r.obs >= r.prior.p10 && r.obs <= r.prior.p90;
      g.fillStyle = cur ? 'rgba(226,232,240,0.45)' : inside ? 'rgba(226,232,240,0.8)' : 'rgba(251,113,133,0.85)';
      g.fillRect(x + bw * 0.34, Y(r.obs), bw * 0.32, mt + H - Y(r.obs));
    } else if (reveal) { g.fillStyle = 'rgba(226,232,240,0.9)'; g.beginPath(); g.arc(x + bw / 2, Y(r.real), 2.4, 0, 7); g.fill(); }
  }
  if (now > h0 && now < h1) { const px = ml + (now - h0) / (h1 - h0) * W; g.strokeStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.moveTo(px, mt); g.lineTo(px, mt + H); g.stroke(); g.fillStyle = '#e2e8f0'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('now ' + fmtHM(sim.t), px + 4, mt + 2); }
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
  for (let h = h0; h <= h1; h += 3) g.fillText(pad(h % 24) + ':00', X(h), mt + H + 5);
  const k = hzTerms().length > 1 ? 'both terminals' : GEO[hzTerms()[0]].name;
  const pct = F.F * 100;
  $('stTodayRead').innerHTML = `<b>${fmtDate(gen.day.date, { weekday: 'short', day: 'numeric', month: 'short' })}, ${k}</b>
    <span>made the evening before <b class="u">${fmtK(F.prior)}</b> (80%: ${fmtK(F.priorBand[0])}–${fmtK(F.priorBand[1])})</span>
    ${pct > 3 ? `<span>nowcast at ${fmtHM(sim.t)} <b class="c">${fmtK(F.now)}</b> (80%: ${fmtK(F.nowBand[0])}–${fmtK(F.nowBand[1])})</span><span>${fmtK(F.O)} arrived so far, ${pct.toFixed(0)}% of the expected day</span>` : '<span>the nowcast starts once the first wave arrives</span>'}`;
}
function hzNotes() {
  const bt = hzBacktest(hzState.series); if (!bt || !$('stTodayNote')) return;
  $('stTodayNote').innerHTML = `Bars: arrived so far (pink: outside the band made the evening before). Grey: hourly 80% band from the timetable and the TimesFM daily forecast; teal: the nowcast for the hours still to come. <b>Backtest over March</b>, each day calibrated on the other 27: hourly 80% bands held ${Math.round(bt.cover80 * 100)}% of ${fmtInt(bt.n)} terminal-hours. Error on the rest of the day, before → after the nowcast: ${bt.cuts.map(c => `${pad(c.c)}:00 ${(c.prior * 100).toFixed(1)}% → <b>${(c.now * 100).toFixed(1)}%</b>`).join(' · ')}.`;
}
function drawWeek(S) {
  const cv = $('stWeek'); if (!cv) return;
  const c = stCanvas(cv, { l: 46, r: 10, t: 12, b: 30 }); if (!c) return;
  const { g, ml, mt, W, H } = c, d0 = state.di, days = [];
  for (let i = d0; i < Math.min(DATA.days.length, d0 + 7); i++) days.push(i);
  const nodes = days.map(i => S.node(DATA.days[i]));
  const vals = nodes.flatMap(n => [n.q ? n.q[1] : n.q10, n.q ? n.q[9] : n.q90, n.actual, ...(n.da ? [n.da.q[1], n.da.q[9]] : [])]);
  let lo = Math.min(...vals), hi = Math.max(...vals); const padv = (hi - lo) * 0.15 || 1; lo -= padv; hi += padv;
  const Y = v => mt + H - (v - lo) / (hi - lo) * H, X = j => ml + (j + 0.5) / 7 * W;
  yTicks(c, Y, lo, hi);
  nodes.forEach((n, j) => {
    const x = X(j), q = n.q;
    if (q) { g.fillStyle = 'rgba(45,212,191,0.22)'; g.fillRect(x - 11, Y(q[9]), 9, Y(q[1]) - Y(q[9])); g.strokeStyle = '#2dd4bf'; g.lineWidth = 2; g.beginPath(); g.moveTo(x - 11, Y(q[5])); g.lineTo(x - 2, Y(q[5])); g.stroke(); }
    if (n.da) { const a = n.da.q; g.fillStyle = 'rgba(192,132,252,0.30)'; g.fillRect(x + 2, Y(a[9]), 9, Y(a[1]) - Y(a[9])); g.strokeStyle = '#c084fc'; g.lineWidth = 2; g.beginPath(); g.moveTo(x + 2, Y(a[5])); g.lineTo(x + 11, Y(a[5])); g.stroke(); }
    if (studio.reveal || days[j] <= state.di) { g.fillStyle = '#e2e8f0'; g.beginPath(); g.arc(x, Y(n.actual), 3, 0, 7); g.fill(); }
    g.fillStyle = days[j] === state.di ? '#e2e8f0' : '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
    const iso = DATA.days[days[j]].date;
    g.fillText(fmtDate(iso, { weekday: 'short', day: 'numeric' }), x, mt + H + 4);
    g.fillText(j ? `+${j}d` : 'today', x, mt + H + 16);
  });
  const w = (arr, f) => arr.reduce((s, n) => s + (f(n) ? f(n)[9] - f(n)[1] : 0), 0) / Math.max(1, arr.filter(f).length);
  const wPlan = w(nodes, n => n.q), wDa = w(nodes, n => n.da && n.da.q);
  $('stWeekNote').innerHTML = `<span style="color:#2dd4bf">■</span> plan made ${fmtDate(META.origin, { day: 'numeric', month: 'short' })} (made up to ${days[0] + 1}–${days[days.length - 1] + 1} days ahead) · <span style="color:#c084fc">■</span> refreshed the evening before each day · dot: actual. 80% bands: the refresh is ${wPlan && wDa ? Math.round((1 - wDa / wPlan) * 100) + '% narrower' : 'not available for this series'}.`;
}
/* Timeline overlay: the nowcast band per 15 minutes for the hours still to come. */
function hzTimelineBand(c, X, key, series, Yv) {
  if (!HZ.calib) return;
  const fc = hzForecast(gen, key, series, sim.t, sim.obs[series][key]), g = c.g, now = sim.t;
  for (const r of fc.hours) {
    const t0 = Math.max(r.h * 3600, now), t1 = (r.h + 1) * 3600;
    if (t1 <= now || t0 >= TL_X1 || r.h * 3600 < TL_X0) continue;
    const x0 = X(t0), x1 = X(Math.min(t1, TL_X1));
    g.fillStyle = 'rgba(226,232,240,0.10)'; g.fillRect(x0, Yv(r.now.p90 / 4), x1 - x0, Yv(r.now.p10 / 4) - Yv(r.now.p90 / 4));
    g.strokeStyle = 'rgba(226,232,240,0.6)'; g.lineWidth = 1; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(x0, Yv(r.now.p50 / 4)); g.lineTo(x1, Yv(r.now.p50 / 4)); g.stroke(); g.setLineDash([]);
  }
}
