'use strict';
/* ====================================================================
   Forecast Studio (key F): the forecasting story in one place.

   Fan chart     recent actuals, the week-ahead track record, and the
                 28-day horizon with calibrated P5-P95 / P10-P90 bands;
                 actuals are revealed up to the selected day
   Why           Shapley split of the selected day's forecast
   Track record  a forecast made a week ahead against the actual, for
                 every day of the backtest year
   Leaderboard   TimesFM against four classical baselines on 26 unseen
                 weekly origins, with bootstrap intervals
   Calibration   do the bands hold what they claim?
   Provenance    CSO monthly totals the synthetic history is pinned to
   ==================================================================== */
const STUDIO_SERIES = [
  { id: 't1', name: 'Terminal 1', key: 'terminals:t1', fam: 'terminals', node: d => d.t1 },
  { id: 't2', name: 'Terminal 2', key: 'terminals:t2', fam: 'terminals', node: d => d.t2 },
  { id: 'euc', name: 'T1 Europe city', key: 'markets_t1:t1/eu_city', fam: 'markets_t1', node: d => d.markets.t1.eu_city },
  { id: 'na', name: 'T2 North America', key: 'markets_t2:t2/na', fam: 'markets_t2', node: d => d.markets.t2.na },
  { id: 'tx1', name: 'Taxis T1', key: 'landside:taxi_pickups_t1', fam: 'landside', node: d => d.landside.taxi.t1 },
  { id: 'tx2', name: 'Taxis T2', key: 'landside:taxi_pickups_t2', fam: 'landside', node: d => d.landside.taxi.t2 },
  { id: 'hb', name: 'Holiday Blue cars', key: 'landside:hb_occ_start', fam: 'landside', node: d => d.landside.hbOcc },
];
const MODEL_ORDER = ['covariates', 'joint', 'univariate', 'schedule', 'holt_winters', 'snaive7', 'snaive364'];
const MODEL_COLOR = { covariates: '#2dd4bf', joint: '#94a3b8', univariate: '#fb923c', schedule: '#a78bfa', holt_winters: '#facc15', snaive7: '#64748b', snaive364: '#475569' };
const SLICE_NAMES = { all: 'All days', event: 'Event days', ordinary: 'Ordinary days', disruption: 'Disruption days', week1: '1–7 days ahead', week4: '22–28 days ahead' };
const studio = { series: 't1', slice: 'all', reveal: false };
const studioOpen = () => $('studio').classList.contains('show');

function toggleStudio() {
  const el = $('studio');
  if (studioOpen()) { el.classList.remove('show'); return; }
  el.classList.add('show');
  renderStudio();
}
function closeOverlays() {
  let closed = false;
  if (studioOpen()) { $('studio').classList.remove('show'); closed = true; }
  if ($('help').classList.contains('show')) { $('help').classList.remove('show'); closed = true; }
  if ($('brief').classList.contains('show')) { $('brief').classList.remove('show'); closed = true; }
  return closed;
}

function renderStudio() {
  if (!DATA.meta) { $('studio').innerHTML = '<div class="stempty">The Forecast Studio needs the v2 export: run python run_all.py.</div>'; return; }
  const M = DATA.meta, bt = M.backtest;
  const S = STUDIO_SERIES.find(s => s.id === studio.series);
  $('studio').innerHTML = `
    <div class="sthead">
      <div class="stt"><b>Forecast Studio</b><span>TimesFM 3 zero-shot · three horizons: ${M.horizon} days from ${fmtDate(M.origin, { day: 'numeric', month: 'short' })}, refreshed each evening, and hour by hour today · scored on ${bt.origins} weekly backtest origins</span></div>
      <div class="seg" id="stSeries">${STUDIO_SERIES.map(s => `<button data-v="${s.id}" class="${s.id === studio.series ? 'on' : ''}">${s.name}</button>`).join('')}</div>
      <button class="stclose" id="stClose" aria-label="Close the Forecast Studio">×</button>
    </div>
    <div class="stgrid">
      <section class="stc span2">
        <div class="sth"><h4>${S.name}: the next ${M.horizon} days</h4>
          <label class="chk"><input type="checkbox" id="stReveal" ${studio.reveal ? 'checked' : ''}> show all actuals</label></div>
        <div class="stread" id="stRead"></div>
        <canvas id="stFan" class="tall" aria-label="Fan chart of the forecast"></canvas>
        <div class="stkey"><span><i class="ln" style="background:#cbd5e1"></i>Actual</span><span><i class="ln" style="background:#2dd4bf"></i>TimesFM + schedule & events (median)</span><span><i class="bx" style="background:rgba(45,212,191,.35)"></i>80% band</span><span><i class="bx" style="background:rgba(45,212,191,.14)"></i>90% band</span><span><i class="ln dash" style="background:#fb923c"></i>History only</span><span><i class="ln dash" style="background:#5eead4"></i>Week-ahead forecast (backtest)</span><span><i class="bx" style="background:rgba(251,191,36,.25)"></i>Event</span></div>
      </section>
      <section class="stc"><h4>How good is it?</h4><div id="stKpi" class="kpis"></div></section>
      <section class="stc"><div class="sth"><h4>Week ahead <small>the plan against the evening-before refresh</small></h4></div>
        <canvas id="stWeek" aria-label="The next seven days: the monthly plan against the day-before refresh"></canvas><div class="sub2" id="stWeekNote"></div></section>
      <section class="stc span2"><div class="sth"><h4>Today, hour by hour <small>live nowcast</small></h4>
        <div class="seg" id="stHz">${Object.entries(HZ_SERIES).map(([k, v]) => `<button data-v="${k}" class="${k === hzState.series ? 'on' : ''}">${v.short}</button>`).join('')}</div></div>
        <div class="stread" id="stTodayRead"></div>
        <canvas id="stToday" class="tall" aria-label="Hourly forecast for the selected day with the live nowcast"></canvas>
        <div class="sub2" id="stTodayNote"></div></section>
      <section class="stc"><h4>Why ${fmtDate(DATA.days[state.di].date, { weekday: 'short', day: 'numeric', month: 'short' })} looks like this</h4><div id="stWhy"></div></section>
      <section class="stc span2"><div class="sth"><h4>Track record: forecast a week ahead vs what happened</h4><span class="sub2" id="stTrackSub"></span></div>
        <canvas id="stTrack" aria-label="Week-ahead forecast against actuals over the backtest year"></canvas></section>
      <section class="stc"><div class="sth"><h4>Leaderboard <small>WAPE, unseen origins</small></h4>
        <select id="stSlice" aria-label="Slice">${Object.entries(SLICE_NAMES).map(([k, n]) => `<option value="${k}" ${k === studio.slice ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <table class="mtab lb" id="stLb"></table><div class="sub2" id="stLbNote"></div></section>
      <section class="stc"><h4>Are the bands honest?</h4><canvas id="stRel" class="sq" aria-label="Reliability diagram"></canvas>
        <div class="sub2">Share of actuals at or below each forecast quantile, on origins the calibration never saw. On the diagonal = honest.</div></section>
      <section class="stc span2"><div class="sth"><h4>Weather: ECMWF physics (IFS) vs AI (AIFS)</h4><span class="sub2">${(DATA.weather && DATA.weather.sources) || ''}</span></div>
        <div class="wxgrid"><div><div class="stread" id="stWxDay"></div><canvas id="stWxLead" aria-label="Disruption risk as the day approached"></canvas>
          <div class="sub2">Disruption probability from the forecast issued 7 days, 6 days … 1 day before the selected day. Dashed: the usual rate.</div></div>
          <div><canvas id="stWxSkill" aria-label="Wind forecast error by lead time, IFS against AIFS"></canvas>
          <div class="sub2" id="stWxSkillNote"></div><table class="mtab lb" id="stWxValue"></table></div></div></section>
      <section class="stc"><h4>Grounded in real data</h4><canvas id="stCso" aria-label="CSO monthly passengers at Dublin Airport"></canvas><div class="sub2" id="stCsoNote"></div></section>
      <section class="stc"><h4>Method</h4><ul class="method">
        <li><b>Zero-shot TimesFM 3</b> (${M.checkpoint}), no fine-tuning, on Apple-silicon MLX.</li>
        <li><b>Covariates known in advance</b>: the published schedule, the event calendar, school holidays, event direction. Delays and cancellations are past-only.</li>
        <li><b>Rolling-origin backtest</b>: ${bt.origins} weekly origins, ${fmtDate(bt.first, { day: 'numeric', month: 'short', year: 'numeric' })} to ${fmtDate(bt.last, { day: 'numeric', month: 'short', year: 'numeric' })}, 1–28 days ahead; the first ${bt.calibration} calibrate, the last ${bt.test} are scored unseen.</li>
        <li><b>Calibrated bands</b>: split-conformal (normalised CQR, event days separately) on the backtest errors, P5 to P95.</li>
        <li><b>Coherent</b>: MinT reconciliation so arrivals + departures = market and markets = terminal.</li>
        <li><b>Explained</b>: exact Shapley values of the covariate groups from 8 TimesFM runs per family.</li>
      </ul></section>
    </div>`;
  $('stClose').onclick = toggleStudio;
  $('stSeries').querySelectorAll('button').forEach(b => b.onclick = () => { studio.series = b.dataset.v; renderStudio(); });
  $('stReveal').onchange = e => { studio.reveal = e.target.checked; drawFan(S); drawWeek(S); drawToday(); };
  $('stSlice').onchange = e => { studio.slice = e.target.value; renderLeaderboard(S); };
  $('stHz').querySelectorAll('button').forEach(b => b.onclick = () => { hzState.series = b.dataset.v; $('stHz').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); drawToday(); hzNotes(); });
  requestAnimationFrame(() => { drawWeek(S); drawToday(); hzNotes(); drawFan(S); drawTrack(S); renderKpis(S); renderStudioWhy(S); renderLeaderboard(S); drawReliability(); drawCso(); renderStudioWeather(S); });
}

function stCanvas(cv, m = { l: 46, r: 12, t: 10, b: 22 }) {
  const r = cv.getBoundingClientRect(); if (!r.width || !r.height) return null;
  const dpr = Math.min(2, devicePixelRatio || 1);
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = '500 10px Inter, sans-serif';
  return { g, w: r.width, h: r.height, ml: m.l, mt: m.t, W: r.width - m.l - m.r, H: r.height - m.t - m.b };
}
const addDays = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayDiff = (a, b) => Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);

function seriesBundle(S) {
  const ctx = DATA.context.series[S.key] || [], hist = DATA.history[S.key];
  const days = DATA.days.map(d => S.node(d));
  return { ctx, ctxStart: DATA.context.start, hist, days };
}
function yTicks(c, Y, lo, hi, fmt = fmtK) {
  const { g, ml, W } = c;
  const step = niceStep((hi - lo) / 4);
  g.strokeStyle = 'rgba(148,163,184,0.08)'; g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) { g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(ml + W, Y(v)); g.stroke(); g.fillText(fmt(v), ml - 6, Y(v)); }
}
function niceStep(x) { const p = Math.pow(10, Math.floor(Math.log10(x))); const f = x / p; return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p; }

function drawFan(S) {
  const cv = $('stFan'), c = stCanvas(cv); if (!c) return;
  const { g, ml, mt, W, H } = c, B = seriesBundle(S), origin = DATA.meta.origin;
  const showCtx = 63, ctx = B.ctx.slice(-showCtx), n0 = -ctx.length, n1 = DATA.days.length;
  const X = i => ml + (i - n0 + 0.5) / (n1 - n0) * W;
  const vals = [...ctx, ...B.days.flatMap(n => [n.q ? n.q[0] : n.q10, n.q ? n.q[10] : n.q90, n.actual, n.univariate])];
  let lo = Math.min(...vals), hi = Math.max(...vals); const pad = (hi - lo) * 0.08; lo -= pad; hi += pad;
  const Y = v => mt + H - (v - lo) / (hi - lo) * H;
  yTicks(c, Y, lo, hi);
  // Events and the fog day across context and horizon.
  for (let i = 0; i < n1; i++) {
    const d = DATA.days[i];
    if (d.event) { g.fillStyle = 'rgba(251,191,36,0.13)'; g.fillRect(X(i - 0.5), mt, X(i + 0.5) - X(i - 0.5), H); }
    else if (d.disruption) { g.fillStyle = 'rgba(148,163,184,0.12)'; g.fillRect(X(i - 0.5), mt, X(i + 0.5) - X(i - 0.5), H); }
  }
  // Forecast origin.
  g.strokeStyle = 'rgba(148,163,184,0.35)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(X(-0.5), mt); g.lineTo(X(-0.5), mt + H); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#8b9bb6'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillText('forecast made', X(-0.5) + 4, mt + 2);
  // Bands.
  const band = (a, b, col) => {
    g.fillStyle = col; g.beginPath();
    B.days.forEach((n, i) => { const v = n.q ? n.q[a] : (a < 5 ? n.q10 : n.q90); i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); });
    for (let i = B.days.length - 1; i >= 0; i--) { const n = B.days[i]; g.lineTo(X(i), Y(n.q ? n.q[b] : n.q90)); }
    g.closePath(); g.fill();
  };
  band(0, 10, 'rgba(45,212,191,0.12)'); band(1, 9, 'rgba(45,212,191,0.24)');
  const line = (arr, from, col, w = 1.6, dash) => {
    g.strokeStyle = col; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath();
    arr.forEach((v, i) => { if (v == null) return; const x = X(from + i), y = Y(v); i && arr[i - 1] != null ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.stroke(); g.setLineDash([]);
  };
  // Week-ahead backtest forecasts that fall inside the context window.
  if (B.hist) {
    const off = dayDiff(origin, B.hist.start);
    const arr = new Array(ctx.length).fill(null);
    B.hist.cov.forEach((v, j) => { const i = off + j - n0; if (i >= 0 && i < ctx.length) arr[i] = v; });
    line(arr, n0, 'rgba(94,234,212,0.55)', 1.2, [3, 3]);
  }
  line(ctx, n0, '#cbd5e1', 1.4);
  line(B.days.map(n => n.univariate), 0, '#fb923c', 1.4, [4, 3]);
  line(B.days.map(n => n.joint_with_covariates), 0, '#2dd4bf', 2);
  // Scenario re-forecast on the selected day.
  if (scnTold() && B.days[state.di].scen) {
    const n = B.days[state.di], v = n.joint_with_covariates * n.scen[SCN.kind];
    g.fillStyle = '#f472b6'; g.beginPath(); g.moveTo(X(state.di), Y(v) - 5); g.lineTo(X(state.di) + 5, Y(v)); g.lineTo(X(state.di), Y(v) + 5); g.lineTo(X(state.di) - 5, Y(v)); g.closePath(); g.fill();
  }
  // Actuals: revealed up to the selected day unless "show all".
  const upto = studio.reveal ? n1 - 1 : state.di;
  B.days.forEach((n, i) => {
    if (i > upto) return;
    const inside = n.q ? n.actual >= n.q[1] && n.actual <= n.q[9] : true;
    g.fillStyle = inside ? '#e2e8f0' : '#fb7185';
    g.beginPath(); g.arc(X(i), Y(n.actual), 2.6, 0, Math.PI * 2); g.fill();
  });
  // Selected day.
  g.strokeStyle = 'rgba(255,255,255,0.6)'; g.beginPath(); g.moveTo(X(state.di), mt); g.lineTo(X(state.di), mt + H); g.stroke();
  // Date axis: Mondays.
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = n0; i < n1; i++) {
    const iso = addDays(origin, i), dt = new Date(iso + 'T12:00:00Z');
    if (dt.getUTCDay() === 1) g.fillText(fmtDate(iso, { day: 'numeric', month: 'short' }), X(i), mt + H + 5);
  }
  // Read-out for the selected day, and click to choose a day.
  const n = B.days[state.di];
  $('stRead').innerHTML = `<b>${fmtDate(DATA.days[state.di].date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>${DATA.days[state.di].event ? ` · <span class="ev">${DATA.days[state.di].event}</span>` : ''}${DATA.days[state.di].disruption ? ` · <span class="fg">${DATA.days[state.di].disruption}</span>` : ''}
    <span>TimesFM <b class="c">${fmtInt(n.joint_with_covariates)}</b> (80%: ${fmtK(n.q ? n.q[1] : n.q10)}–${fmtK(n.q ? n.q[9] : n.q90)})</span>
    <span>history only <b class="u">${fmtInt(n.univariate)}</b></span><span>actual <b>${fmtInt(n.actual)}</b> ${errTxt(n.joint_with_covariates, n.actual)}</span>`;
  cv.onclick = e => {
    const r = cv.getBoundingClientRect(), i = Math.round((e.clientX - r.left - ml) / W * (n1 - n0) + n0 - 0.5);
    if (i >= 0 && i < n1 && i !== state.di) loadDay(i);
  };
}

function drawTrack(S) {
  const cv = $('stTrack'), c = stCanvas(cv); if (!c) return;
  const B = seriesBundle(S), h = B.hist;
  if (!h) { c.g.fillStyle = '#5a6a86'; c.g.fillText('No week-ahead backtest kept for this series.', c.ml, c.mt + 10); $('stTrackSub').textContent = ''; return; }
  const { g, ml, mt, W, H } = c, n = h.actual.length;
  const X = i => ml + (i + 0.5) / n * W;
  const vals = [...h.actual, ...h.lo, ...h.hi]; let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.05; lo -= pad; hi += pad;
  const Y = v => mt + H - (v - lo) / (hi - lo) * H;
  yTicks(c, Y, lo, hi);
  g.fillStyle = 'rgba(45,212,191,0.18)'; g.beginPath();
  h.lo.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  for (let i = n - 1; i >= 0; i--) g.lineTo(X(i), Y(h.hi[i]));
  g.closePath(); g.fill();
  const line = (arr, col, w) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); arr.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke(); };
  line(h.uni, 'rgba(251,146,60,0.45)', 1);
  line(h.actual, '#e2e8f0', 1.1);
  line(h.cov, '#2dd4bf', 1.3);
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i < n; i++) { const iso = addDays(h.start, i); if (iso.endsWith('-01')) g.fillText(fmtDate(iso, { month: 'short' }), X(i), mt + H + 5); }
  $('stTrackSub').innerHTML = `WAPE <b style="color:#2dd4bf">${(h.wape.cov * 100).toFixed(1)}%</b> TimesFM + covariates · <b style="color:#a78bfa">${(h.wape.sched * 100).toFixed(1)}%</b> planner's method · <b style="color:#fb923c">${(h.wape.uni * 100).toFixed(1)}%</b> history only · 80% band held ${(h.cov80 * 100).toFixed(0)}% of days`;
}

function lbRows(fam, slice) { return (DATA.accuracy.leaderboard || []).filter(r => r.family === fam && r.slice === slice); }
function renderKpis(S) {
  const all = lbRows(S.fam, 'all'), ev = lbRows(S.fam, 'event');
  const get = (rows, m) => rows.find(r => r.model === m) || {};
  const cov = get(all, 'covariates'), base = all.filter(r => !['covariates', 'joint', 'univariate'].includes(r.model)).sort((a, b) => a.wape - b.wape)[0] || {};
  const uni = get(all, 'univariate'), evc = get(ev, 'covariates'), evu = get(ev, 'univariate');
  const B = seriesBundle(S); let se = 0, sa = 0, inb = 0;
  B.days.forEach(n => { se += Math.abs(n.joint_with_covariates - n.actual); sa += n.actual; inb += n.q && n.actual >= n.q[1] && n.actual <= n.q[9]; });
  const famName = (DATA.meta.families || {})[S.fam] || S.fam;
  const tile = (v, l, s) => `<div class="kpi"><b>${v}</b><span>${l}</span><em>${s}</em></div>`;
  $('stKpi').innerHTML =
    tile(`${(cov.wape * 100).toFixed(1)}%`, 'error, 1–28 days ahead', `vs ${(base.wape * 100).toFixed(1)}% for the best classical method (${(DATA.meta.models[base.model] || base.model || '').toLowerCase()}) and ${(uni.wape * 100).toFixed(1)}% history only`) +
    tile(`${(evc.wape * 100).toFixed(1)}%`, 'error on event days', `history only: ${(evu.wape * 100).toFixed(1)}%. The event calendar is what closes the gap`) +
    tile(`${Math.round(cov.cov80 * 100)}%`, 'of days inside the 80% band', `${Math.round(cov.cov90 * 100)}% inside the 90% band; raw TimesFM bands held ${Math.round(cov.cov80_raw * 100)}%`) +
    tile(`${(se / sa * 100).toFixed(1)}%`, 'error this March', `${S.name}, ${Math.round(inb / B.days.length * 100)}% of days in the band, a hard month: summit, fog, St Patrick's`) +
    `<div class="sub2">${famName}, ${DATA.meta.backtest.test} unseen weekly origins (${fmtInt(cov.n_days || 0)} forecast days).</div>`;
}
function renderStudioWhy(S) {
  const n = S.node(DATA.days[state.di]), w = n.why;
  if (!w) { $('stWhy').innerHTML = ''; return; }
  const parts = [['Baseline', w.base, '#475569'], ['Published schedule', w.schedule, GROUP_COLORS.schedule], ['Event calendar', w.events, GROUP_COLORS.events], ['Holidays & direction', w.calendar, GROUP_COLORS.calendar]];
  if (w.weather != null) parts.push(['Weather forecast', w.weather, GROUP_COLORS.weather]);
  const fc = parts.reduce((x, p) => x + p[1], 0);
  const vmax = Math.max(fc, w.base, n.actual) * 1.03, vmin = Math.min(fc, w.base, n.actual) * 0.92;
  const X = v => ((v - vmin) / (vmax - vmin) * 100).toFixed(2);
  let cum = 0;
  let html = parts.map(([name, v, col], i) => {
    const from = i ? cum : vmin, to = i ? cum + v : v; cum = to;
    return `<div class="wf"><span class="wn">${name}</span><span class="wb"><i style="left:${X(Math.min(from, to))}%;width:${Math.abs(X(to) - X(from))}%;background:${col}"></i></span><b>${i ? (v >= 0 ? '+' : '−') + fmtInt(Math.abs(v)) : fmtK(v)}</b></div>`;
  }).join('');
  html += `<div class="wf tot"><span class="wn">Forecast</span><span class="wb"><i style="left:${X(fc)}%;width:2px;background:var(--accent)"></i><i class="act" style="left:${X(n.actual)}%"></i></span><b>${fmtK(fc)}</b></div>`;
  const s = n.scen;
  if (s) html += `<div class="scenrow"><span>TimesFM re-forecast if…</span>${Object.entries(DATA.meta.scenarios).map(([k]) => `<em>${SCENARIO_DEFS[k].name.toLowerCase()} <b>${s[k] >= 1 ? '+' : ''}${((s[k] - 1) * 100).toFixed(1)}%</b></em>`).join('')}</div>`;
  $('stWhy').innerHTML = html + `<div class="sub2">Baseline: the same model with the horizon's covariates neutralised (the schedule of the same weekday in the four weeks before the forecast, no event, no holiday), so the schedule bar includes the seasonal ramp-up airlines have published. White tick: actual.</div>`;
}
function renderLeaderboard(S) {
  const rows = lbRows(S.fam, studio.slice).filter(r => MODEL_ORDER.includes(r.model)).sort((a, b) => a.wape - b.wape);
  const comp = (DATA.accuracy.comparisons || []).filter(r => r.family === S.fam && r.slice === studio.slice);
  const label = m => (DATA.meta.models || {})[m] || m;
  $('stLb').innerHTML = `<tr><th>Model</th><th>WAPE</th><th>MASE</th><th title="Covariate model minus this model, WAPE points, 95% bootstrap interval over origins">TimesFM+ vs it</th></tr>` + rows.map(r => {
    const c = comp.find(x => x.vs === r.model);
    const d = c ? `${(c.diff * 100).toFixed(1)} <span class="sub2">[${(c.lo * 100).toFixed(1)}, ${(c.hi * 100).toFixed(1)}]</span>` : r.model === 'covariates' ? '—' : '';
    return `<tr class="${r.model === 'covariates' ? 'me' : ''}"><td class="l"><i style="background:${MODEL_COLOR[r.model]}"></i>${label(r.model)}</td><td>${(r.wape * 100).toFixed(2)}%</td><td>${r.mase.toFixed(2)}</td><td>${d}</td></tr>`;
  }).join('');
  const n = rows[0] ? rows[0].n_days : 0;
  $('stLbNote').textContent = comp.length ? `Negative = TimesFM with covariates is better; an interval that excludes zero is a real difference. ${fmtInt(n)} forecast days.` : `${fmtInt(n)} forecast days.`;
}
function drawReliability() {
  const cv = $('stRel'), c = stCanvas(cv, { l: 34, r: 10, t: 8, b: 24 }); if (!c) return;
  const { g, ml, mt, W, H } = c, R0 = DATA.accuracy.reliability;
  const X = v => ml + v * W, Y = v => mt + H - v * H;
  g.strokeStyle = 'rgba(148,163,184,0.12)'; g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of [0, 0.5, 1]) { g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(ml + W, Y(v)); g.stroke(); g.fillText(v * 100 + '%', ml - 4, Y(v)); }
  g.textAlign = 'center'; g.textBaseline = 'top'; for (const v of [0.1, 0.5, 0.9]) g.fillText('P' + v * 100, X(v), mt + H + 5);
  g.strokeStyle = 'rgba(203,213,225,0.35)'; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke(); g.setLineDash([]);
  const pts = (lv, vs, col) => { g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.6; g.beginPath(); lv.forEach((l, i) => (i ? g.lineTo(X(l), Y(vs[i])) : g.moveTo(X(l), Y(vs[i])))); g.stroke(); lv.forEach((l, i) => { g.beginPath(); g.arc(X(l), Y(vs[i]), 2.6, 0, 7); g.fill(); }); };
  pts(R0.levels_raw, R0.raw, '#fb923c'); pts(R0.levels_cal, R0.cal, '#2dd4bf');
  g.textAlign = 'left'; g.textBaseline = 'top'; g.font = '600 10px Inter, sans-serif';
  g.fillStyle = '#fb923c'; g.fillText('TimesFM as returned', ml + 6, mt + 2);
  g.fillStyle = '#2dd4bf'; g.fillText('after conformal calibration', ml + 6, mt + 15);
}
function drawCso() {
  const cv = $('stCso'), c = stCanvas(cv, { l: 34, r: 34, t: 10, b: 22 }); if (!c) return;
  const cso = DATA.meta.cso, { g, ml, mt, W, H } = c, n = cso.passengers.length;
  const X = i => ml + (i + 0.5) / n * W, Yb = v => mt + H - v / 4.2e6 * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const v of [0, 2e6, 4e6]) g.fillText(v / 1e6 + 'm', ml - 4, Yb(v));
  cso.passengers.forEach((v, i) => { g.fillStyle = cso.months[i] >= '2026-03' ? 'rgba(45,212,191,0.75)' : 'rgba(96,165,250,0.55)'; const y = Yb(v); g.fillRect(X(i) - W / n * 0.38, y, W / n * 0.76, mt + H - y); });
  // Rolling 12 months against the planning cap, right axis.
  const r12 = cso.passengers.map((_, i) => (i >= 11 ? cso.passengers.slice(i - 11, i + 1).reduce((a, b) => a + b, 0) : null));
  const Yr = v => mt + H - (v - 28e6) / (40e6 - 28e6) * H;
  g.strokeStyle = '#fbbf24'; g.lineWidth = 1.6; g.beginPath(); let started = false;
  r12.forEach((v, i) => { if (v == null) return; started ? g.lineTo(X(i), Yr(v)) : g.moveTo(X(i), Yr(v)); started = true; }); g.stroke();
  g.setLineDash([4, 3]); g.strokeStyle = 'rgba(244,63,94,0.7)'; g.beginPath(); g.moveTo(ml, Yr(cso.cap)); g.lineTo(ml + W, Yr(cso.cap)); g.stroke(); g.setLineDash([]);
  g.textAlign = 'left'; g.fillStyle = '#fbbf24'; for (const v of [30e6, 35e6, 40e6]) g.fillText(v / 1e6 + 'm', ml + W + 4, Yr(v));
  g.fillStyle = 'rgba(244,63,94,0.85)'; g.fillText('32m cap', ml + 4, Yr(cso.cap) - 7);
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
  cso.months.forEach((m, i) => { if (m.endsWith('-01')) g.fillText(m.slice(0, 4), X(i), mt + H + 5); });
  $('stCsoNote').innerHTML = `Bars: CSO monthly passengers at Dublin (TAM08); the synthetic daily history is calibrated to match every month exactly. Gold: rolling 12 months, ${(cso.rolling12 / 1e6).toFixed(1)}m to ${cso.rolling12Month}. Dashed: the 32m planning cap (reference only). Source: ${cso.source}.`;
}

/* ---- weather card ---- */
function renderStudioWeather(S) {
  const day = DATA.days[state.di], w = day.weather;
  if (!w || !DATA.weather) return;
  const o = w.obs, fa = w.hourly.dayAhead;
  const mx = arr => Math.max(...arr.filter(v => v != null));
  const sum = arr => arr.reduce((a, v) => a + (v || 0), 0);
  const fogH = m => fa[m].dpd.filter((v, i) => v != null && v <= 1 && (fa[m].wind[i] || 0) < 6.5).length;
  const row = (name, obs, ifs, aifs) => `<span>${name}: observed <b>${obs}</b> · IFS <b class="c">${ifs}</b> · AIFS <b class="ai">${aifs}</b></span>`;
  $('stWxDay').innerHTML = `<b>${fmtDate(day.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>${day.disruption ? ` · <span class="ev">${day.disruption}</span>` : ' · no weather disruption'}
    ${row('max wind', `${Math.round(o.windMax)} kt`, `${Math.round(mx(fa.ifs.wind))} kt`, `${Math.round(mx(fa.aifs.wind))} kt`)}
    ${row('rain', `${o.rain} mm`, `${sum(fa.ifs.rain).toFixed(1)} mm`, `${sum(fa.aifs.rain).toFixed(1)} mm`)}
    ${row('low temp', `${Math.round(o.tmin)}°`, `${Math.round(Math.min(...fa.ifs.temp))}°`, `${Math.round(Math.min(...fa.aifs.temp))}°`)}
    ${row('fog hours', o.lvpHours, fogH('ifs'), fogH('aifs'))}
    <span class="sub2">Day-ahead forecasts as issued. Gusts observed: ${Math.round(o.gust)} kt.</span>`;
  drawWxLead(w);
  drawWxSkill();
  const lb = (DATA.accuracy.leaderboard || []).filter(r => r.family === S.fam);
  const get = (sl, m) => (lb.find(r => r.slice === sl && r.model === m) || {}).wape;
  const comp = (DATA.accuracy.comparisons || []).filter(r => r.family === S.fam && r.vs === 'covariates');
  const ci = (ref, sl) => { const c = comp.find(r => r.ref === ref && r.slice === sl); return c ? ` <span class="sub2">${(c.diff * 100).toFixed(2)} [${(c.lo * 100).toFixed(2)}, ${(c.hi * 100).toFixed(2)}]</span>` : ''; };
  const models = [['covariates', 'No weather'], ['cov_ifs', '+ IFS weather'], ['cov_aifs', '+ AIFS weather'], ['gate_aifs', 'AIFS, only when flagged']];
  const n = (lb.find(r => r.slice === 'disruption_wk1') || {}).n_days || 0;
  $('stWxValue').innerHTML = `<tr><th>TimesFM ${S.name.includes('Terminal') ? 'terminals' : ''}</th><th>All days</th><th title="Weather-disrupted days 1–7 days ahead, where the weather forecast exists">Disrupted, wk 1</th></tr>` +
    models.map(([m, name]) => `<tr class="${m === (DATA.meta.production || {}).model ? 'me' : ''}"><td class="l">${name}</td><td>${get('all', m) != null ? (get('all', m) * 100).toFixed(2) + '%' : '—'}${m !== 'covariates' ? ci(m, 'all') : ''}</td><td>${get('disruption_wk1', m) != null ? (get('disruption_wk1', m) * 100).toFixed(2) + '%' : '—'}${m !== 'covariates' ? ci(m, 'disruption_wk1') : ''}</td></tr>`).join('') +
    `<tr class="tot"><td colspan="3">WAPE on unseen origins; brackets: difference from no weather with 95% interval. Only ${n} disrupted days fall in week 1 of the scored half, so treat the gain as promising, not proven. Highlighted: the production model.</td></tr>`;
}
function drawWxLead(w) {
  const cv = $('stWxLead'), c = stCanvas(cv, { l: 34, r: 10, t: 10, b: 22 }); if (!c) return;
  const { g, ml, mt, W, H } = c, L = w.riskByLead, base = (DATA.weather.climateRisk || {}).any || 0.05;
  const all = [...L.ifs, ...L.aifs].filter(v => v != null), top = Math.max(0.3, ...all) * 1.1;
  const X = i => ml + (i + 0.5) / 7 * W, Y = v => mt + H - v / top * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = 0; v <= top; v += top > 0.6 ? 0.2 : 0.1) { g.strokeStyle = 'rgba(148,163,184,0.08)'; g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(ml + W, Y(v)); g.stroke(); g.fillText(Math.round(v * 100) + '%', ml - 4, Y(v)); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let i = 0; i < 7; i++) g.fillText(`${7 - i}d`, X(i), mt + H + 5);
  g.setLineDash([4, 3]); g.strokeStyle = 'rgba(203,213,225,0.45)'; g.beginPath(); g.moveTo(ml, Y(base)); g.lineTo(ml + W, Y(base)); g.stroke(); g.setLineDash([]);
  for (const [m, col] of [['ifs', '#2dd4bf'], ['aifs', '#c084fc']]) {
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.beginPath(); let on = false;
    L[m].forEach((v, i) => { if (v == null) { on = false; return; } on ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)); on = true; }); g.stroke();
    L[m].forEach((v, i) => { if (v != null) { g.beginPath(); g.arc(X(i), Y(v), 2.6, 0, 7); g.fill(); } });
  }
  g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillStyle = '#2dd4bf'; g.fillText('IFS', ml + 6, mt + 2); g.fillStyle = '#c084fc'; g.fillText('AIFS', ml + 36, mt + 2);
  g.fillStyle = w.disruption.name ? '#fbbf24' : '#8b9bb6'; g.textAlign = 'right';
  g.fillText(w.disruption.name ? `happened: ${w.disruption.name.toLowerCase()}` : 'happened: no disruption', ml + W, mt + 2);
}
function drawWxSkill() {
  const cv = $('stWxSkill'), c = stCanvas(cv, { l: 34, r: 10, t: 10, b: 22 }); if (!c) return;
  const { g, ml, mt, W, H } = c, sk = DATA.weather.skill || [];
  const by = m => sk.filter(r => r.model === m).sort((a, b) => a.lead - b.lead);
  const vals = sk.map(r => r.wind_mae_kt), top = Math.max(...vals) * 1.15;
  const X = l => ml + (l - 0.5) / 7 * W, Y = v => mt + H - v / top * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = 0; v <= top; v += 1) { g.strokeStyle = 'rgba(148,163,184,0.08)'; g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(ml + W, Y(v)); g.stroke(); g.fillText(v + ' kt', ml - 4, Y(v)); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let l = 1; l <= 7; l++) g.fillText(`${l}d`, X(l), mt + H + 5);
  const bw = W / 7 * 0.32;
  for (const [m, col, off] of [['ifs', '#2dd4bf', -0.5], ['aifs', '#c084fc', 0.5]]) {
    g.fillStyle = col;
    for (const r of by(m)) { const y = Y(r.wind_mae_kt); g.fillRect(X(r.lead) + off * bw - bw / 2, y, bw, mt + H - y); }
  }
  g.font = '600 10px Inter, sans-serif'; g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#8b9bb6';
  g.fillText('Daily max wind error at Dublin, by lead time', ml + 4, mt);
  const risk = (DATA.weather.riskScores || []).filter(r => r.target === 'any' && r.leads === '1-3');
  const bss = m => (risk.find(r => r.model === m) || {}).brier_skill;
  const i1 = by('ifs')[0], a1 = by('aifs')[0];
  $('stWxSkillNote').innerHTML = `Day-ahead wind error: IFS <b style="color:#2dd4bf">${i1 ? i1.wind_mae_kt.toFixed(1) : '—'} kt</b>, AIFS <b style="color:#c084fc">${a1 ? a1.wind_mae_kt.toFixed(1) : '—'} kt</b>. Disruption-risk skill 1–3 days ahead (Brier skill vs climatology): IFS ${bss('ifs') != null ? bss('ifs').toFixed(2) : '—'}, AIFS ${bss('aifs') != null ? bss('aifs').toFixed(2) : '—'}. Scored Aug 2025 – Mar 2026.`;
}
