'use strict';
/* ====================================================================
   Panels: scenario calendar, forecasts, rosters, outlook, right-panel
   tabs (departures, arrivals, landside, commercial, people), follow card.
   ==================================================================== */
const $ = id => document.getElementById(id);
const errChip = (f, a) => { if (!a) return ''; const e = (f - a) / a * 100; const c = Math.abs(e) < 5 ? 'g' : Math.abs(e) < 12 ? 'w' : 'b'; return `<span class="err ${c}">${e > 0 ? '+' : ''}${e.toFixed(0)}%</span>`; };
const chip = (m, thr = 30) => `<span class="chip ${m < thr / 3 ? 'g' : m < thr * 2 / 3 ? 'w' : m < thr ? 'h' : 'b'}">${Math.round(m)}m</span>`;
function hbar(label, value, frac, color, right) {
  return `<div class="hbar"><i style="width:${clamp(frac, 0, 1) * 100}%;background:${color}"></i><span>${label}</span><em>${right ?? value}</em></div>`;
}

function buildCalendar() {
  const cal = $('cal'); cal.innerHTML = '';
  for (const w of ['M', 'T', 'W', 'T', 'F', 'S', 'S']) { const d = document.createElement('div'); d.className = 'wd'; d.textContent = w; cal.appendChild(d); }
  const first = new Date(DATA.days[0].date + 'T12:00:00').getDay();
  for (let i = 0; i < (first + 6) % 7; i++) cal.appendChild(document.createElement('div'));
  DATA.days.forEach((d, i) => {
    const b = document.createElement('button');
    b.innerHTML = `${+d.date.slice(8)}${d.event ? '<span class="ev"></span>' : ''}${d.disruption ? `<span class="wxi" title="${d.disruption}">${wxIcon(d)}</span>` : ''}<span class="risk"></span>`;
    b.title = fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' }) + (d.event ? ` · ${d.event}` : '') + (d.disruption ? ` · ${d.disruption}` : '');
    b.onclick = () => loadDay(i);
    cal.appendChild(b);
  });
}
const calButtons = () => [...$('cal').querySelectorAll('button')];

function renderDayPanel() {
  const d = gen.day;
  calButtons().forEach((b, i) => b.classList.toggle('on', i === state.di));
  const dep = gen.kindCount[KIND.DEP], arr = gen.kindCount[KIND.ARR], trf = gen.kindCount[KIND.TRF];
  $('dayinfo').innerHTML = `<div class="dname">${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
    ${d.event ? `<span class="dtag">${d.event}</span>` : ''}${d.disruption ? `<span class="dtag fog">${d.disruption}</span>` : ''}
    <div class="dmeta">${fmtInt(dep)} departing · ${fmtInt(arr)} arriving · ${fmtInt(trf)} connecting<br>${gen.flights.length} departures and ${gen.arrFlights.length} arrivals · ${new Set(gen.flights.map(f => f.code)).size} airports · avg delay ${d.delayMin.toFixed(0)} min</div>
    ${wxLine(d)}`;
  $('clockDate').textContent = fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  renderForecastTab();
  renderMix();
}
const FTABS = [['term', 'Terminals'], ['dep', 'Departures'], ['arr', 'Arrivals'], ['land', 'Landside']];
const fmtK = v => (Math.abs(v) >= 10000 ? (v / 1000).toFixed(1) + 'k' : fmtInt(v));
const errTxt = (f, a) => { if (!a) return ''; const e = (f - a) / a * 100; const c = Math.abs(e) < 5 ? 'g' : Math.abs(e) < 12 ? 'w' : 'b'; return `<span class="err ${c}">${e > 0 ? '+' : ''}${e.toFixed(0)}%</span>`; };
/* Rows for the forecast table: name, actual, history-only, covariate median, and the calibrated 80% band. */
function forecastRows(tab, d = gen.day, mk = gen.mk) {
  const row = (name, n, color) => ({ name, color, a: n.actual, u: n.univariate, c: n.joint_with_covariates, lo: n.q ? n.q[1] : n.q10, hi: n.q ? n.q[9] : n.q90 });
  if (tab === 'term') return TERMS.map(k => row(GEO[k].short, d[k]));
  if (tab === 'dep' || tab === 'arr') {
    const agg = {};
    for (const k of TERMS) for (const m of TERMINAL_MARKETS[k]) {
      const v = mk[k][m][tab], o = agg[m] || (agg[m] = { actual: 0, univariate: 0, joint_with_covariates: 0, q: v.q ? v.q.map(() => 0) : null });
      o.actual += v.actual; o.univariate += v.univariate; o.joint_with_covariates += v.joint_with_covariates;
      if (o.q && v.q) v.q.forEach((x, i) => { o.q[i] += x; });
    }
    return Object.keys(MARKETS).filter(m => agg[m]).map(m => row(MARKETS[m].short, agg[m], MARKETS[m].color));
  }
  const ls = d.landside; if (!ls) return [];
  return [['Taxi pickups T1', ls.taxi.t1], ['Taxi pickups T2', ls.taxi.t2], ['Bus & coach T1', ls.bus.t1], ['Bus & coach T2', ls.bus.t2], ['Holiday Blue in', ls.hbEntries], ['Holiday Blue cars', ls.hbOcc]].map(([n, v]) => row(n, v));
}
function renderForecastTab() {
  const tab = state.ftab || 'term';
  $('ftabs').innerHTML = FTABS.map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  $('ftabs').querySelectorAll('button').forEach(b => b.onclick = () => { state.ftab = b.dataset.k; renderForecastTab(); });
  const rows = forecastRows(tab);
  const head = `<tr><th>${tab === 'term' ? '' : tab === 'land' ? 'Series' : 'Market'}</th><th>Actual</th><th title="TimesFM, history only">History</th><th title="TimesFM with schedule and events: median and calibrated 80% band">TimesFM</th></tr>`;
  const body = rows.map(r => {
    const inside = r.a >= r.lo && r.a <= r.hi;
    return `<tr><td>${r.color ? `<i style="background:${r.color}"></i>` : ''}${r.name}</td><td>${fmtK(r.a)}</td><td>${fmtK(r.u)}${errTxt(r.u, r.a)}</td><td>${fmtK(r.c)}${errTxt(r.c, r.a)}<span class="band ${inside ? 'in' : 'out'}" title="${inside ? 'Actual inside the band' : 'Actual outside the band'}">${fmtK(r.lo)}–${fmtK(r.hi)}</span></td></tr>`;
  }).join('');
  // 28-day WAPE for the same rows, every day of the holdout.
  let su = 0, sc = 0, sa = 0, inside = 0, n = 0;
  DATA.days.forEach((dd, i) => {
    const g = i === state.di ? gen : { day: dd, mk: Object.fromEntries(TERMS.map(k => [k, marketsFor(dd, k)])) };
    for (const r of forecastRows(tab, g.day, g.mk)) { su += Math.abs(r.u - r.a); sc += Math.abs(r.c - r.a); sa += r.a; inside += r.a >= r.lo && r.a <= r.hi; n++; }
  });
  const foot = sa ? `<tr class="tot"><td>28-day error</td><td></td><td>${(su / sa * 100).toFixed(1)}%</td><td>${(sc / sa * 100).toFixed(1)}% · ${Math.round(inside / n * 100)}% in band</td></tr>` : '';
  $('ftab').innerHTML = head + body + foot;
  $('fkey').innerHTML = `Error vs actual: <span class="err g">&lt;5%</span> <span class="err w">5–12%</span> <span class="err b">&gt;12%</span> · band <span class="bandk in">holds</span> <span class="bandk out">misses</span> the actual. Backtest: 80% bands held ${pctCov('terminals')} of days on 26 unseen origins.`;
  renderWhy();
}
function pctCov(fam) {
  const r = (DATA.accuracy?.leaderboard || []).find(x => x.family === fam && x.slice === 'all' && x.model === 'covariates');
  return r ? `${Math.round(r.cov80 * 100)}%` : '—';
}
/* Shapley split of the covariate forecast for both terminals: what each covariate group adds. */
const GROUP_COLORS = { schedule: '#38bdf8', events: '#fbbf24', calendar: '#a78bfa', weather: '#f472b6' };
function whyParts(d = gen.day) {
  const parts = { base: 0, schedule: 0, events: 0, calendar: 0, weather: 0 };
  for (const k of TERMS) { const w = d[k].why; if (!w) return null; for (const g in parts) parts[g] += w[g] || 0; }
  return parts;
}
function renderWhy() {
  const d = gen.day, w = whyParts(d);
  if (!w) { $('why').innerHTML = '<div class="sub2">Explanations need the v2 export.</div>'; $('whyTotal').textContent = ''; return; }
  const fc = w.base + w.schedule + w.events + w.calendar + w.weather, act = d.t1.actual + d.t2.actual;
  const lo = d.t1.q[1] + d.t2.q[1], hi = d.t1.q[9] + d.t2.q[9];
  $('whyTotal').textContent = `both terminals`;
  const steps = [['Baseline', w.base, '#475569', 'TimesFM with the horizon\u2019s covariates neutralised: the schedule of the same weekday over the four weeks before the forecast was made, no event, no holiday'],
    ['Published schedule', w.schedule, GROUP_COLORS.schedule, 'Flights planned for the day versus the same weekday in the four weeks before the forecast (includes the seasonal ramp-up airlines have published)'],
    ['Event calendar', w.events, GROUP_COLORS.events, d.event ? `Flagged: ${d.event}` : 'No event flagged'],
    ['Holidays & direction', w.calendar, GROUP_COLORS.calendar, 'School holidays and inbound/outbound event days'],
    ...(Math.abs(w.weather) >= 1 ? [['Weather forecast', w.weather, GROUP_COLORS.weather, 'ECMWF AIFS forecast, used when its own risk model flags the day']] : [])];
  const max = Math.max(fc, act, w.base) * 1.04, min = Math.min(w.base, fc, act) * 0.9;
  const X = v => ((v - min) / (max - min) * 100).toFixed(2);
  let cum = 0, html = '';
  steps.forEach(([name, v, col, tip], i) => {
    const from = i === 0 ? min : cum, to = i === 0 ? v : cum + v;
    const l = Math.min(from, to), r = Math.max(from, to);
    html += `<div class="wf" title="${tip}"><span class="wn">${name}</span><span class="wb"><i style="left:${X(l)}%;width:${(X(r) - X(l))}%;background:${col}"></i></span><b>${i === 0 ? fmtK(v) : (v >= 0 ? '+' : '−') + fmtInt(Math.abs(v))}</b></div>`;
    cum = to;
  });
  html += `<div class="wf tot"><span class="wn">Forecast</span><span class="wb"><i style="left:${X(lo)}%;width:${X(hi) - X(lo)}%;background:rgba(45,212,191,.25)"></i><i style="left:${X(fc)}%;width:2px;background:var(--accent)"></i><i class="act" style="left:${X(act)}%"></i></span><b>${fmtK(fc)}</b></div>`;
  const big = steps.slice(1).filter(s => Math.abs(s[1]) > 0.01 * fc).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const words = big.length ? big.map(([n, v]) => `${n.toLowerCase()} ${v >= 0 ? 'adds' : 'takes off'} ${fmtInt(Math.abs(v))}`).join(', ') : 'nothing in the calendar moves it much';
  html += `<div class="whytxt">TimesFM expects <b>${fmtInt(fc)}</b> passengers (80% band ${fmtK(lo)}–${fmtK(hi)}); ${words}. Actual: <b>${fmtInt(act)}</b> <span class="sub2">(white tick)</span>. Exact Shapley values from 8 TimesFM runs.</div>`;
  $('why').innerHTML = html;
}
function renderMix() {
  const tot = PERSONA_KEYS.reduce((s, p) => s + gen.persona[p], 0) || 1;
  $('mixTotal').textContent = `${fmtInt(tot)} passengers`;
  $('mixbar').innerHTML = PERSONA_KEYS.map(p => `<i style="width:${gen.persona[p] / tot * 100}%;background:${PERSONAS[p].color}" title="${PERSONAS[p].name}"></i>`).join('');
  $('mixk').innerHTML = PERSONA_KEYS.map(p => `<span><i style="background:${PERSONAS[p].color}"></i>${PERSONAS[p].name}<b>${(gen.persona[p] / tot * 100).toFixed(gen.persona[p] / tot < 0.05 ? 1 : 0)}%</b></span>`).join('');
}
const PRESET_KEYS = ['hist', 'tfm', 'p90'];
function renderPlans() {
  $('plans').innerHTML = PLANS.map((p, i) => `<button class="plan ${p.key === state.plan ? 'on' : ''}" data-k="${p.key}"><span class="radio"></span><span><b>${i + 1} · ${p.name}</b><span>${p.desc}</span></span></button>`).join('');
  $('plans').querySelectorAll('.plan').forEach(b => b.onclick = () => setPlan(b.dataset.k));
  const li = state.plan === 'hist' ? 5 : planLevelIndex(state.plan), idx = RISK_LEVELS.indexOf(li);
  const custom = !PRESET_KEYS.includes(state.plan);
  $('riskbox').innerHTML = `<div class="seg src" role="radiogroup" aria-label="Forecast used">
      <button class="${SRC.dayahead ? '' : 'on'}" data-v="0" role="radio" aria-checked="${!SRC.dayahead}">Plan made ${fmtDate(META.origin || DATA.days[0].date, { day: 'numeric', month: 'short' })}</button>
      <button class="${SRC.dayahead ? 'on' : ''}" data-v="1" role="radio" aria-checked="${SRC.dayahead}">Updated the day before</button></div>
    <div class="sub2" style="margin:4px 0 8px">${SRC.dayahead ? 'Re-forecast each evening with the latest passengers and the latest ECMWF weather forecast.' : 'The 28-day forecast, as made at the start of the month.'}</div>
    <div class="rh"><span>Risk appetite</span><b class="${custom ? 'on' : ''}">${state.plan === 'hist' ? 'History only' : 'Plan for ' + LEVEL_NAME(li)}</b></div>
    <input type="range" id="risk" min="0" max="${RISK_LEVELS.length - 1}" step="1" value="${Math.max(0, idx)}" aria-label="Forecast quantile to roster for">
    <div class="rt">${RISK_LEVELS.map(i => `<span>${LEVEL_NAME(i)}</span>`).join('')}</div>
    <div class="sub2">Rosters for the calibrated quantile you choose: P50 is the most likely demand, P95 covers 19 days in 20.</div>`;
  $('risk').oninput = e => setPlan('q' + RISK_LEVELS[+e.target.value]);
  $('riskbox').querySelectorAll('.src button').forEach(b => b.onclick = () => { SRC.dayahead = b.dataset.v === '1'; setPlan(state.plan); });
}
function renderAdj() {
  let html = `<span></span><span class="hdr">T1</span><span class="hdr">T2</span>`;
  for (const r of RESOURCES) {
    html += `<label>${r.name} <span class="sub2">${r.id === 'taxi' ? '×10 taxis' : r.unit}</span></label>`;
    for (const k of TERMS) html += `<span class="stepper"><button data-r="${r.id}" data-k="${k}" data-d="-1" aria-label="Fewer">−</button><span>${state.offset[r.id][k] > 0 ? '+' : ''}${state.offset[r.id][k]}</span><button data-r="${r.id}" data-k="${k}" data-d="1" aria-label="More">+</button></span>`;
  }
  $('adj').innerHTML = html;
  $('adj').querySelectorAll('button').forEach(b => b.onclick = () => adjust(b.dataset.r, b.dataset.k, +b.dataset.d));
}
function adjust(r, k, d) {
  const o = state.offset[r]; o[k] = clamp(o[k] + d, -6, 6);
  rebuildPlans(); renderAdj(); renderOutlook(); renderDecision(); scheduleRisk();
}
const outlookPlans = () => (PRESET_KEYS.includes(state.plan) ? PLANS.map(p => p.key) : [...PLANS.map(p => p.key), state.plan]);
function renderOutlook() {
  const keys = outlookPlans();
  let html = `<tr><th></th>${keys.map(k => `<th class="${k === state.plan ? 'selc' : ''}">${planShort(k)}</th>`).join('')}</tr>`;
  for (const r of RESOURCES) for (const k of TERMS) {
    html += `<tr><td>${r.name} ${GEO[k].short}</td>${keys.map(p => {
      const o = outlook[p][r.id][k], c = planCost(r.id, outlookPlan(p, r.id, k));
      const within = o.tot ? (1 - o.late / o.tot) * 100 : 100;
      return `<td class="${p === state.plan ? 'selc' : ''}">${chip(o.peak, r.threshold)}<span class="osub">${within.toFixed(within > 99 ? 1 : 0)}% ≤${COST.serviceWait[r.id]}m · ${r.id === 'taxi' ? fmtInt(c.units) + ' cabs' : fmtInt(c.staffH) + ' h'}</span></td>`;
    }).join('')}</tr>`;
  }
  const eur = keys.map(p => RESOURCES.filter(r => r.id !== 'taxi').reduce((s, r) => s + TERMS.reduce((x, k) => x + planCost(r.id, outlookPlan(p, r.id, k)).eur, 0), 0));
  html += `<tr class="tot"><td>Staff cost <span class="sub2">illustr.</span></td>${eur.map((v, i) => `<td class="${keys[i] === state.plan ? 'selc' : ''}">€${fmtK(v)}</td>`).join('')}</tr>`;
  $('ctab').innerHTML = html;
}
function outlookPlan(p, rid, k) { return p === state.plan ? plans[rid][k] : (outlookPlans.cache[p + rid + k] ||= RES[rid].plan(gen, k, p, state.offset[rid][k])); }
outlookPlans.cache = {};

/* ---- decision panel: Pareto, recommendation, alerts ---- */
let paretoCache = null;
function renderDecision() {
  if (!$('pareto')) return;
  const pts = paretoSecurity(gen);
  paretoCache = pts;
  drawPareto(pts);
  const rec = recommendLevel(pts), cur = pts.find(p => p.key === (state.plan === 'tfm' ? 'q5' : state.plan === 'p90' ? 'q9' : state.plan));
  const curTxt = cur ? `${planLabel(state.plan)}: €${fmtK(cur.cost)} of screening, ${((1 - cur.late) * 100).toFixed(1)}% of passengers expected within ${COST.serviceWait.sec} min.` : '';
  $('recommend').innerHTML = `<div class="rec"><b>Cheapest roster expected to keep ${Math.round(COST.goal * 100)}% within ${COST.serviceWait.sec} min: ${LEVEL_NAME(planLevelIndex(rec.key))}</b>
    <span>${curTxt}</span>${rec.key !== state.plan && !(rec.key === 'q5' && state.plan === 'tfm') && !(rec.key === 'q9' && state.plan === 'p90') ? `<button class="linkbtn" id="useRec">Use ${LEVEL_NAME(planLevelIndex(rec.key))}</button>` : ''}</div>`;
  if ($('useRec')) $('useRec').onclick = () => setPlan(rec.key);
  const al = alertsFor(gen);
  $('alerts').innerHTML = al.length ? al.map((a, i) => `<div class="alert ${a.weather ? 'wx' : ''}"><span>${a.text}</span>${a.weather ? '' : a.extra ? `<button class="linkbtn" data-i="${i}">+${a.extra} ${a.res === 'sec' ? 'lane' : 'officer'}${a.extra > 1 ? 's' : ''}</button>` : '<em>at capacity</em>'}</div>`).join('')
    : `<div class="ok">No window breaks the service wait even if demand lands on P90.</div>`;
  $('alerts').querySelectorAll('button').forEach(b => b.onclick = () => { const a = al[+b.dataset.i]; adjust(a.res, a.key, a.extra); });
}
function drawPareto(pts) {
  const cv = $('pareto'), r = cv.getBoundingClientRect(); if (!r.width) return;
  const dpr = Math.min(2, devicePixelRatio || 1); cv.width = r.width * dpr; cv.height = r.height * dpr;
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ml = 38, mr = 10, mt = 10, mb = 26, W = r.width - ml - mr, H = r.height - mt - mb;
  const xs = pts.map(p => p.cost), ys = pts.map(p => (1 - p.late) * 100);
  const x0 = Math.min(...xs) * 0.97, x1 = Math.max(...xs) * 1.03, y0 = Math.min(80, Math.floor(Math.min(...ys) / 5) * 5), y1 = 100;
  const X = v => ml + (v - x0) / (x1 - x0) * W, Y = v => mt + H - (v - y0) / (y1 - y0) * H;
  g.font = '500 9.5px Inter, sans-serif'; g.fillStyle = '#5a6a86'; g.strokeStyle = 'rgba(148,163,184,0.1)';
  g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let v = y0; v <= y1; v += (y1 - y0 > 10 ? 5 : 2)) { g.beginPath(); g.moveTo(ml, Y(v)); g.lineTo(ml + W, Y(v)); g.stroke(); g.fillText(v + '%', ml - 5, Y(v)); }
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(52,211,153,0.5)'; g.beginPath(); g.moveTo(ml, Y(COST.goal * 100)); g.lineTo(ml + W, Y(COST.goal * 100)); g.stroke(); g.setLineDash([]);
  g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillText(`€${fmtK(x0)}`, ml + 12, mt + H + 4); g.fillText(`€${fmtK(x1)}`, ml + W - 14, mt + H + 4); g.fillText('screening cost →', ml + W / 2, mt + H + 4);
  const line = pts.filter(p => p.key !== 'hist');
  g.strokeStyle = 'rgba(45,212,191,0.6)'; g.lineWidth = 1.5; g.beginPath();
  line.forEach((p, i) => { const x = X(p.cost), y = Y((1 - p.late) * 100); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
  const sel = state.plan === 'tfm' ? 'q5' : state.plan === 'p90' ? 'q9' : state.plan;
  for (const p of pts) {
    const x = X(p.cost), y = Y((1 - p.late) * 100), on = p.key === sel;
    g.fillStyle = p.key === 'hist' ? '#fb923c' : on ? '#fff' : '#2dd4bf';
    g.beginPath(); g.arc(x, y, on ? 4.5 : 3, 0, Math.PI * 2); g.fill();
    if (on) { g.strokeStyle = '#2dd4bf'; g.lineWidth = 2; g.stroke(); }
    // After the day: where the actual demand put the same roster.
    g.strokeStyle = p.key === 'hist' ? 'rgba(251,146,60,0.6)' : 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
    const ya = Y(Math.max(y0, (1 - p.actual) * 100)); g.beginPath(); g.moveTo(x - 3, ya); g.lineTo(x + 3, ya); g.stroke();
    g.fillStyle = '#8b9bb6'; g.textBaseline = 'bottom';
    g.fillText(p.key === 'hist' ? 'Hist.' : LEVEL_NAME(planLevelIndex(p.key)), x, y - 5);
  }
  g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#5a6a86';
  g.fillText('% within 15 min, expected · – after the day', ml + 4, mt);
}

/* ---- weather summaries ---- */
function wxIcon(d) {
  const w = d.weather, n = d.disruption || '';
  if (/Storm/.test(n)) return '🌪';
  if (/Snow|Freezing/.test(n)) return '🌨';
  if (/Fog|visibility/i.test(n)) return '🌫';
  if (/Wind/.test(n)) return '💨';
  return w && w.obs.rain >= 5 ? '🌧' : '⛅';
}
function wxLine(d) {
  const w = d.weather; if (!w) return '';
  const o = w.obs, r = w.riskDayAhead || {};
  const bits = [`${Math.round(o.tmin)}–${Math.round(o.tmax)}°C`, `gusts ${Math.round(o.gust)} kt`, `${o.rain.toFixed(1)} mm rain`];
  if (o.lvpHours) bits.push(`${o.lvpHours} h low visibility`);
  if (o.snow) bits.push('snow showers');
  if (o.tmin <= 1) bits.push('frost: de-icing');
  const held = gen && gen.wxMaxHold > 300 ? ` · runway holding up to ${Math.round(gen.wxMaxHold / 60)} min (${gen.wxHeld} movements over 5 min)` : '';
  return `<div class="dwx"><span class="wxi">${wxIcon(d)}</span><span>${bits.join(' · ')}${d.disruption ? ` · <b>${d.disruption}</b> (${w.disruption.cancelPct}% cancelled)` : ''}${held}</span>
    <span class="sub2">Disruption risk the day before: IFS ${Math.round((r.ifs || 0) * 100)}% · AIFS ${Math.round((r.aifs || 0) * 100)}% (usual ${Math.round(((DATA.weather.climateRisk || {}).any || 0.05) * 100)}%)</span></div>`;
}

/* ---- left tabs and the scenario panel ---- */
const LTABS = [['fc', 'Forecast'], ['plan', 'Roster & risk'], ['scn', 'What if']];
function buildLeftTabs() {
  $('ltabs').innerHTML = LTABS.map(([k, n]) => `<button data-k="${k}" role="tab">${n}</button>`).join('');
  $('ltabs').querySelectorAll('button').forEach(b => b.onclick = () => setLeftTab(b.dataset.k));
  setLeftTab(state.ltab || 'fc');
}
function setLeftTab(k) {
  state.ltab = k;
  $('ltabs').querySelectorAll('button').forEach(b => { b.classList.toggle('on', b.dataset.k === k); b.setAttribute('aria-selected', b.dataset.k === k); });
  for (const [id] of LTABS) $('lp-' + id).classList.toggle('on', id === k);
  if (k === 'plan' && gen) renderDecision();
}
function renderScenario() {
  $('scn').innerHTML = [['', 'As forecast'], ...Object.entries(SCENARIO_DEFS).map(([k, v]) => [k, v.name])].map(([k, n]) =>
    `<button class="${(SCN.kind || '') === k ? 'on' : ''}" data-k="${k}">${n}${k && SCENARIO_DEFS[k].demand ? '<small>demand</small>' : k ? '<small>capacity</small>' : ''}</button>`).join('');
  $('scn').querySelectorAll('button').forEach(b => b.onclick = () => setScenario(b.dataset.k || null));
  $('told').checked = SCN.told;
  $('told').onchange = e => { SCN.told = e.target.checked; applyScenario(); };
  const def = SCN.kind && SCENARIO_DEFS[SCN.kind];
  $('toldWrap').style.display = def && def.demand ? '' : 'none';
  if (!def) { $('scnInfo').innerHTML = `<div class="sub2">Pick a what-if to change the selected day. Demand scenarios were re-forecast by TimesFM with the changed schedule or event calendar; capacity scenarios change what the airport can process.</div>`; return; }
  const d = gen.day, base = DATA.days[state.di];
  let html = `<div class="scninfo"><b>${def.name}</b><p>${def.desc}</p>`;
  if (def.demand) {
    const before = base.t1.actual + base.t2.actual, after = d.t1.actual + d.t2.actual;
    const fc0 = base.t1.joint_with_covariates + base.t2.joint_with_covariates;
    const fc1 = TERMS.reduce((s, k) => s + base[k].joint_with_covariates * (base[k].scen ? base[k].scen[SCN.kind] : 1), 0);
    html += `<div class="stat"><span>Demand in the simulation</span><b>${fmtInt(after)} <small>(${after >= before ? '+' : ''}${fmtInt(after - before)})</small></b></div>
      <div class="stat"><span>TimesFM, told</span><b>${fmtInt(fc1)} <small>(${fc1 >= fc0 ? '+' : ''}${fmtInt(fc1 - fc0)})</small></b></div>
      <div class="stat"><span>History only</span><b>${fmtInt(base.t1.univariate + base.t2.univariate)} <small>(cannot be told)</small></b></div>`;
  }
  const p = (paretoCache || []).find(x => x.key === (state.plan === 'tfm' ? 'q5' : state.plan === 'p90' ? 'q9' : state.plan));
  if (p) html += `<div class="stat"><span>Security within ${COST.serviceWait.sec} min, this roster</span><b>${((1 - p.actual) * 100).toFixed(1)}%</b></div>`;
  html += `<div class="stat"><span>Peak security wait</span><b>${TERMS.map(k => Math.round(outlook[state.plan].sec[k].peak) + 'm').join(' · ')}</b></div>
    <div class="stat"><span>Peak passport wait</span><b>${TERMS.map(k => Math.round(outlook[state.plan].imm[k].peak) + 'm').join(' · ')}</b></div>
    <div class="stat"><span>Peak taxi-rank wait</span><b>${TERMS.map(k => Math.round(outlook[state.plan].taxi[k].peak) + 'm').join(' · ')}</b></div></div>`;
  $('scnInfo').innerHTML = html;
}
function setScenario(k) { SCN.kind = k; applyScenario(); }
function applyScenario() {
  genCache.clear();
  loadDay(state.di);
  renderScenario();
  writeHash();
}
/* ---- right panel ---- */
const RTABS = [['dep', 'Departures'], ['arr', 'Arrivals'], ['land', 'Landside'], ['com', 'Commercial'], ['ppl', 'People']];
function buildRightTabs() {
  $('rtabs').innerHTML = RTABS.map(([k, n]) => `<button data-k="${k}">${n}</button>`).join('');
  $('rtabs').querySelectorAll('button').forEach(b => b.onclick = () => setTab(b.dataset.k));
  setTab(state.tab);
}
function setTab(k) {
  state.tab = k;
  $('rtabs').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  for (const [id] of RTABS) $('tab-' + id).classList.toggle('on', id === k);
  if (sim) updatePanels();
}
function buildCards() {
  $('cards').innerHTML = TERMS.map(k => `
    <div class="tcard" id="card-${k}">
      <div class="tch"><span class="nm"><i style="background:${TERM_COLORS[GEO[k].idx]};box-shadow:0 0 8px ${TERM_COLORS[GEO[k].idx]}"></i>${GEO[k].name}</span><span class="ln" data-k="lanes"></span></div>
      <div class="tcm"><div class="big num" data-k="wait"></div><div class="bigl">estimated wait<br>at security now</div></div>
      <div class="gauge"><i data-k="gauge"></i><b style="left:66.6%"></b></div>
      <div class="kg">
        <div><b data-k="queue"></b><span>in queue</span></div>
        <div><b data-k="thru"></b><span>screened / hr</span></div>
        <div><b data-k="ftq"></b><span>Fast Track queue</span></div>
        <div><b data-k="peak"></b><span>peak wait</span></div>
        <div><b data-k="within"></b><span>within 30 min</span></div>
        <div><b data-k="missed"></b><span>missed flights</span></div>
      </div>
    </div>`).join('');
  $('immCards').innerHTML = TERMS.map(k => `
    <div class="tcard" id="imm-${k}">
      <div class="tch"><span class="nm"><i style="background:${TERM_COLORS[GEO[k].idx]}"></i>${GEO[k].name}</span><span class="ln" data-k="officers"></span></div>
      <div class="tcm"><div class="big num" data-k="wait"></div><div class="bigl">estimated wait<br>at passport control</div></div>
      <div class="gauge"><i data-k="gauge"></i><b style="left:66.6%"></b></div>
      <div class="kg">
        <div><b data-k="eu"></b><span>EU/UK queue</span></div>
        <div><b data-k="non"></b><span>non-EU queue</span></div>
        <div><b data-k="eg"></b><span>eGate queue</span></div>
        <div><b data-k="peak"></b><span>peak wait</span></div>
        <div><b data-k="within"></b><span>within 30 min</span></div>
        <div><b data-k="customs"></b><span>customs stops</span></div>
      </div>
    </div>`).join('');
  $('taxiCards').innerHTML = TERMS.map(k => `
    <div class="tcard" id="taxi-${k}">
      <div class="tch"><span class="nm"><i style="background:#facc15"></i>Taxi rank ${GEO[k].short}</span><span class="ln" data-k="called"></span></div>
      <div class="kg">
        <div><b data-k="q"></b><span>parties queuing</span></div>
        <div><b data-k="taxis"></b><span>taxis at rank</span></div>
        <div><b data-k="wait"></b><span>longest wait now</span></div>
      </div>
    </div>`).join('');
}
function setK(root, k, html) { const el = root.querySelector(`[data-k="${k}"]`); if (el && el.innerHTML !== html) el.innerHTML = html; }
function updatePanels() {
  const cnt = liveCounts(), t = sim.t;
  const veh = sim.vehicles.filter(v => v.state !== 'wait').length;
  $('paxPill').textContent = `${fmtInt(cnt.total)} people · ${fmtInt(veh)} vehicles`;
  if (state.tab === 'dep') updateDepTab();
  else if (state.tab === 'arr') updateArrTab(t);
  else if (state.tab === 'land') updateLandTab(t);
  else if (state.tab === 'com') updateComTab();
  else updatePeopleTab(cnt);
  updateFollow();
  renderWeatherBadge();
}
function updateDepTab() {
  for (const k of TERMS) {
    const ts = sim.ts[k], root = $('card-' + k), cap = ts.openN * LANE_RATE / 60;
    const q = ts.secQ.length, wmin = cap > 0 ? q / cap : 0;
    setK(root, 'lanes', ts.surge ? `${ts.planned} <span style="color:var(--warn)">+${ts.openN - ts.planned} surge</span> / ${GEO[k].maxLanes} lanes` : `${ts.openN} / ${GEO[k].maxLanes} lanes`);
    setK(root, 'wait', cap > 0 || q === 0 ? `${Math.round(wmin)}<small>min</small>` : `—<small>closed</small>`);
    root.querySelector('[data-k="wait"]').style.color = waitColor(wmin);
    const gi = root.querySelector('[data-k="gauge"]'); gi.style.width = `${clamp(wmin / 45, 0, 1) * 100}%`; gi.style.background = waitColor(wmin);
    setK(root, 'queue', fmtInt(q)); setK(root, 'thru', fmtInt(ts.screened.length - ts.sh)); setK(root, 'ftq', fmtInt(ts.ftQ.length));
    setK(root, 'peak', `${Math.round(ts.peak / 60)}m`); setK(root, 'within', ts.served ? `${(ts.within / ts.served * 100).toFixed(1)}%` : '—');
    setK(root, 'missed', fmtInt(ts.missed)); root.querySelector('[data-k="missed"]').style.color = ts.missed ? '#fb7185' : '';
  }
  renderWalks();
  renderBoard();
}
/* Walking time from security to each pier's gates, today's departures per
   pier, and missed flights so far. Distances follow the real piers. */
const WALK_V = { avg: 1.25, prm: PERSONAS.prm.speed };
function renderWalks() {
  const el = $('walks'); if (!el) return;
  const rows = [];
  for (const k of TERMS) for (const p of GEO[k].piers) {
    if (!p.gates.length) continue;
    const m = p.gates.map(gateWalkM), lo = Math.min(...m), hi = Math.max(...m);
    const deps = gen.flights.filter(f => f.gate && f.gate.pier === p.id && !f.gate.remote).length;
    rows.push({ name: `${GEO[k].short} ${p.name}`, ids: `${p.gates[0].id}–${p.gates[p.gates.length - 1].id}`, lo, hi, deps, missed: sim.missedPier[p.id] || 0 });
  }
  const rem = gen.flights.filter(f => f.gate && f.gate.remote);
  if (rem.length) {
    const b = rem.map(f => f.gate.busMin);
    rows.push({ name: 'Remote, by bus', ids: `${Math.min(...b).toFixed(0)}–${Math.max(...b).toFixed(0)} min bus`, bus: true, deps: rem.length, missed: sim.missedPier.remote || 0 });
  }
  const mins = (mm, v) => Math.round(mm / v / 60);
  const html = `<tr><th>Pier</th><th>Metres</th><th title="1.25 m/s">Walk</th><th title="Reduced mobility, ${WALK_V.prm} m/s">PRM</th><th>Flights</th><th>Missed</th></tr>` +
    rows.map(r => `<tr><td class="l">${r.name}<span class="sub2"> ${r.ids}</span></td>${r.bus ? '<td colspan="3" class="sub2">bus from gate 335 / 221 / Pier 4</td>' : `<td>${fmtInt(r.lo)}–${fmtInt(r.hi)}</td><td>${mins(r.lo, WALK_V.avg)}–${mins(r.hi, WALK_V.avg)}′</td><td>${mins(r.lo, WALK_V.prm)}–${mins(r.hi, WALK_V.prm)}′</td>`}<td>${r.deps}</td><td style="${r.missed ? 'color:#fb7185' : ''}">${r.missed}</td></tr>`).join('');
  if (el.innerHTML !== html) el.innerHTML = html;
}
function updateArrTab(t) {
  for (const k of TERMS) {
    const ts = sim.ts[k], root = $('imm-' + k), w = immWaitNow(ts);
    setK(root, 'officers', `${ts.imm.eu.open + ts.imm.non.open}${ts.immSurge ? ' <span style="color:var(--warn)">surge</span>' : ''} officers · ${ts.imm.egate.open} eGates`);
    setK(root, 'wait', `${Math.round(w)}<small>min</small>`); root.querySelector('[data-k="wait"]').style.color = waitColor(w);
    const gi = root.querySelector('[data-k="gauge"]'); gi.style.width = `${clamp(w / 45, 0, 1) * 100}%`; gi.style.background = waitColor(w);
    setK(root, 'eu', fmtInt(sizeOfQueue(ts.imm.eu.q))); setK(root, 'non', fmtInt(sizeOfQueue(ts.imm.non.q))); setK(root, 'eg', fmtInt(sizeOfQueue(ts.imm.egate.q)));
    setK(root, 'peak', `${Math.round(ts.immPeak / 60)}m`); setK(root, 'within', ts.immServed ? `${(ts.immWithin / ts.immServed * 100).toFixed(1)}%` : '—');
    setK(root, 'customs', fmtInt(ts.customsStops));
  }
  const active = [];
  for (const k of TERMS) for (const c of GEO[k].carousels) for (const a of c.flights) active.push([k, c, a]);
  $('belts').innerHTML = `<tr><th>Belt</th><th>Flight</th><th>On belt</th><th>First bag</th></tr>` + (active.length ? active.map(([k, c, a]) =>
    `<tr><td class="l">${GEO[k].short} · ${c.id}</td><td class="l">${a.code} ${a.origin}</td><td>${fmtInt(a.bagsOnBelt - a.bagsClaimed)}/${fmtInt(a.bags)}</td><td>${a.firstBag ? Math.round((a.firstBag - a.onBlock) / 60) + 'm' : '—'}</td></tr>`).join('')
    : `<tr><td colspan="4" class="l sub2">No bags being delivered</td></tr>`);
  const rows = gen.arrFlights.filter(a => a.onBlock > t - 50 * 60).slice(0, 9);
  $('arrBoard').innerHTML = rows.map(a => {
    let st, cls;
    if (t < a.onBlock - 15 * 60) { st = a.delay >= 900 ? `Delayed ${fmtHM(a.onBlock)}` : 'Expected'; cls = a.delay >= 900 ? 'dl' : 'ok'; }
    else if (t < a.onBlock) { st = 'Landed'; cls = 'go'; }
    else if (!a.firstBag) { st = 'On stand'; cls = 'go'; }
    else if (a.bagsOnBelt < a.bags) { st = `Bags · belt ${a.carousel ? a.carousel.id : ''}`; cls = 'bd'; }
    else { st = 'Bags complete'; cls = 'dp'; }
    return `<div class="dep"><span class="tm">${fmtHM(a.sta)}</span><span class="ds">${a.origin}<small>${a.code} · ${a.no} · ${GEO[a.term].short} · ${a.ac}</small></span><span class="gt">${a.gate ? a.gate.id : '—'}</span><span class="st ${cls}">${st}</span></div>`;
  }).join('');
}
function updateLandTab(t) {
  for (const k of TERMS) {
    const root = $('taxi-' + k), q = sim.taxi.q[k];
    setK(root, 'called', `${plans.taxi[k][slotOf(t)]} called / 30 min · ${sim.taxi.holding} holding`);
    setK(root, 'q', fmtInt(q.length));
    setK(root, 'taxis', fmtInt(GEO[k].bays.rank.filter(b => b.veh && b.veh.state === 'bay').length));
    const w = q.length ? (t - q.peek().qJoin) / 60 : 0;
    setK(root, 'wait', `${Math.round(w)}m`); root.querySelector('[data-k="wait"]').style.color = waitColor(w * 1.5);
  }
  $('carparks').innerHTML = Object.values(sim.carparks).map(c => {
    const f = c.occ / c.cap, col = f > 0.95 ? '#f43f5e' : f > 0.85 ? '#f59e0b' : '#3b82f6';
    return hbar(`${c.name}${c.turned ? ` · ${c.turned} turned away` : ''}`, '', f, col + '99', `${fmtInt(c.occ)} / ${fmtInt(c.cap)}`);
  }).join('');
  const kerb = k => { const b = GEO[k].bays.kerb; return [b.filter(x => x.veh).length, b.length]; };
  const L = sim.lsStats;
  $('kerbs').innerHTML = TERMS.map(k => { const [n, tot] = kerb(k); return hbar(`${GEO[k].short} departures kerb`, '', n / tot, n / tot > 0.85 ? '#f59e0b99' : '#64748b99', `${n} / ${tot} bays`); }).join('') +
    `<div class="stat"><span>Holiday Blue shuttles this hour</span><b>${plans.shuttle[slotOf(t)]}/h</b></div>` +
    `<div class="stat"><span>Bus & coach runs today</span><b>${fmtInt(L.busRuns)}</b></div>` +
    `<div class="stat"><span>Bus passengers left behind</span><b>${fmtInt(L.busLeftBehind)}</b></div>` +
    `<div class="stat"><span>Kerb drop-offs today</span><b>${fmtInt(L.kerbDrops)}</b></div>` +
    `<div class="stat"><span>Cars turned away (full)</span><b>${fmtInt(L.turnedAway)}</b></div>`;
}
function updateComTab() {
  const cats = Object.keys(CATS).filter(c => sim.spend[c] > 0).sort((a, b) => sim.spend[b] - sim.spend[a]);
  const total = cats.reduce((s, c) => s + sim.spend[c], 0), max = Math.max(1, ...cats.map(c => sim.spend[c]));
  const boarded = Math.max(1, sim.counts.boarded);
  $('spend').innerHTML = cats.map(c => hbar(`${CATS[c].name} · ${fmtInt(sim.tx[c])} tx`, '', sim.spend[c] / max, CATS[c].color + 'aa', `€${fmtInt(sim.spend[c])}`)).join('') +
    `<div class="stat"><span>Total (illustrative)</span><b>€${fmtInt(total)}</b></div>` +
    `<div class="stat"><span>Per departing passenger boarded</span><b>€${(total / boarded).toFixed(2)}</b></div>` +
    TERMS.map(k => { const df = sim.df[k]; return `<div class="stat"><span>${GEO[k].short} duty-free conversion</span><b>${df.passed ? (df.buyers / df.passed * 100).toFixed(1) : '0.0'}%</b></div>`; }).join('');
  const top = sim.outlets.filter(r => r.o.cat !== 'lounge' && r.o.cat !== 'seating' && r.footfall > 0).sort((a, b) => b.footfall - a.footfall).slice(0, 10);
  $('outlets').innerHTML = `<tr><th>Outlet</th><th>Visits</th><th>Now</th><th>Queue</th></tr>` + top.map(r =>
    `<tr><td class="l"><i style="background:${CATS[r.o.cat].color}"></i>${r.o.name} <span class="sub2">${r.o.term.toUpperCase()}</span></td><td>${fmtInt(r.footfall)}</td><td>${r.occ}/${r.o.cap}</td><td>${r.q.length}</td></tr>`).join('');
  $('lounges').innerHTML = sim.outlets.filter(r => r.o.cat === 'lounge').map(r => hbar(`${r.o.name}${r.turned ? ` · ${r.turned} turned away` : ''}`, '', r.occ / r.o.cap, '#38bdf899', `${r.occ} / ${r.o.cap}`)).join('');
}
function updatePeopleTab(cnt) {
  const max = Math.max(1, ...TERMS.flatMap(k => cnt[k].zone));
  $('where').innerHTML = `<tr><th>Zone</th><th>T1</th><th>T2</th></tr>` + ZONES.map((z, i) => `<tr><td><i style="background:${z.color};box-shadow:0 0 6px ${z.color}"></i>${z.name}</td>${TERMS.map(k => `<td class="v">${fmtInt(cnt[k].zone[i])}<span class="bar" style="width:${cnt[k].zone[i] / max * 100}%;background:${z.color}"></span></td>`).join('')}</tr>`).join('') +
    KINDS.map((k, i) => `<tr><td><i style="background:${k.color}"></i>${k.name}</td><td class="v" colspan="2">${fmtInt(cnt.kind[i])}</td></tr>`).join('');
  const c = sim.counts, B = sim.bags.stats, ts = sim.ts;
  const modes = Object.entries(c.exitMode).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${(MODE_NAMES[m] || (m === 'met_car' ? 'Met by car' : m))} ${fmtInt(n)}`).join(' · ');
  const stat = (n, v) => `<div class="stat"><span>${n}</span><b>${v}</b></div>`;
  $('tally').innerHTML = stat('Boarded', fmtInt(c.boarded)) + stat('Missed flights', fmtInt(c.missed)) +
    stat('Arrived and left the airport', fmtInt(c.arrDone)) + `<div class="sub2" style="margin:2px 0 6px">${modes}</div>` +
    stat('Connections made / missed', `${fmtInt(c.trfDone)} / ${fmtInt(ts.t1.missedConnections + ts.t2.missedConnections)}`) +
    stat('Staff on duty', fmtInt(sim.staff.onDuty)) + stat('Staff search peak wait', `${Math.round(sim.staff.peak / 60)}m`) +
    stat('Bags checked / screened', `${fmtInt(B.checked)} / ${fmtInt(B.screened)}`) +
    stat('Bags loaded / short-shipped', `${fmtInt(B.loaded)} / ${fmtInt(B.short)}`) +
    stat('Arriving bags on belts / claimed', `${fmtInt(B.arrived)} / ${fmtInt(B.claimed)}`);
}
function flightStatus(f, t) {
  if (t > f.dep + 60) return ['Departed', 'dp'];
  if (t > f.dep - 8 * 60) return ['Gate closed', 'cl'];
  if (t > f.dep - 28 * 60) return ['Boarding', 'bd'];
  if (t > f.dep - 50 * 60) return ['Go to gate', 'go'];
  if (f.delay >= 15 * 60) return [`Delayed ${fmtHM(f.dep)}`, 'dl'];
  return ['On time', 'ok'];
}
function renderBoard() {
  const t = sim.t, rows = [];
  for (const f of gen.flights) { if (f.dep + 180 > t) rows.push(f); if (rows.length >= 9) break; }
  $('board').innerHTML = rows.map(f => {
    const [st, cls] = flightStatus(f, t);
    const prog = cls === 'bd' || cls === 'cl' ? `<i class="pb" style="width:${clamp(f.boarded / Math.max(1, f.pax), 0, 1) * 100}%"></i>` : '';
    return `<div class="dep" data-i="${f.id}"><span class="tm">${fmtHM(f.std)}</span><span class="ds">${f.dest}<small>${f.code} · ${f.no} · ${GEO[f.term].short} · ${f.ac}${f.us ? ' · US preclearance' : ''}</small></span><span class="gt">${f.gate.id}</span><span class="st ${cls}">${st}</span>${prog}</div>`;
  }).join('');
  $('board').querySelectorAll('.dep').forEach(el => el.onclick = () => {
    const f = gen.flights.find(x => x.id === +el.dataset.i), g = f.gate.spine;
    flyTo({ x: g.x - 120, y: g.y - 90, w: 240, h: 180 });
    const p = sim.alive.find(a => a.f === f && a.kind === KIND.DEP); if (p) { state.selected = p; updateFollow(); }
  });
}

/* ---- follow card ---- */
function updateFollow() {
  const a = state.selected, el = $('follow');
  if (!a) { el.classList.remove('show'); return; }
  el.classList.add('show');
  const L = a.stage === FOLLOW && a.leader ? a.leader : a;
  const z = a.stage === DONE ? 0 : agentZone(a);
  const st = a.stage === DONE ? (a.kind === KIND.DEP || a.kind === KIND.TRF ? (a.missed ? 'Missed flight' : 'Boarded') : 'Left the airport') : STAGE_TEXT[L.stage];
  const col = a.missed ? '#f43f5e' : ZONES[z].color;
  const rows = [];
  const kindName = KINDS[a.kind].name;
  if (a.kind === KIND.STF) {
    const s = a.party.g;
    rows.push(['Shift', `${s.shift} · ${s.airside ? 'airside' : 'landside'}`], ['Terminal', GEO[s.term].short]);
    if (s.leave) rows.push(['Shift ends', fmtHM(s.leave)]);
  } else if (a.kind === KIND.GRT) {
    const p = a.party.g.party;
    rows.push(['Meeting', `${PERSONAS[p.persona].name.toLowerCase()} party of ${p.size}`], ['Flight from', `${p.af.origin} (${p.af.code})`], ['Lands', fmtHM(p.af.onBlock)], ['Came by', a.party.g.byCar ? 'Car, short-term car park' : 'Bus']);
  } else {
    const rp = a.party, g = rp.g;
    rows.push(['Traveller', `<span style="color:${a.pm.color}">${a.pm.name}</span>${g.size > 1 ? ` · party of ${g.size}` : ''}`]);
    if (g.af) rows.push(['Arrived from', `${g.af.origin} (${g.af.code}) · ${fmtHM(g.af.onBlock)}`]);
    if (g.f) {
      rows.push(['Destination', `${g.f.dest} (${g.f.code})`], ['Flight', `${g.f.no} · ${g.f.ac} · ${GEO[g.term].short}${g.f.us ? ' · US preclear' : ''}`]);
      rows.push(['Gate', `${g.f.gate.id} · ${g.f.gate.remote ? `remote stand, ${Math.round(g.f.gate.busMin)} min bus` : `${GEO[g.term].pierById[g.f.gate.pier].name}, ${fmtInt(gateWalkM(g.f.gate))} m (${Math.round(gateWalkM(g.f.gate) / a.v / 60)} min at their pace)`}`], ['Departs', `${fmtHM(g.f.std)}${g.f.delay ? ` <span style="color:var(--warn)">→ ${fmtHM(g.f.dep)}</span>` : ''}`]);
    }
    if (a.kind === KIND.DEP) {
      rows.push(['Came by', MODE_NAMES[g.mode] || g.mode], ['Bags', g.bags ? `${g.bags} checked` : 'Hand luggage only'], ['Security', `${g.ft ? 'Fast Track' : 'Standard'}${a.wait >= 0 ? ` · waited ${Math.round(a.wait / 60)} min` : ''}`]);
      if (a.outlet) rows.push(['Now at', a.outlet.name]);
    }
    if (a.kind === KIND.ARR) {
      rows.push(['Passport channel', { eu: 'EU / UK / EEA', non: 'Non-EU', egate: 'eGates' }[L.ch] || '—'], ['Bags', g.bags ? `${rp.bagsGot}/${g.bags} collected${L.af && L.af.carousel ? ` · belt ${L.af.carousel.id}` : ''}` : 'Hand luggage only']);
      if (L.immWait >= 0) rows.push(['Passport wait', `${Math.round(L.immWait / 60)} min`]);
      rows.push(['Going home by', MODE_NAMES[g.mode] || g.mode]);
    }
    if (a.kind === KIND.TRF) rows.push(['Connecting', `via flight connections security`]);
  }
  el.innerHTML = `<div class="fh"><b>${kindName} #${a.id}</b><button aria-label="Stop following" id="unfollow">×</button></div>
    <span class="fs" style="background:${col}22;color:${col}">${st}</span>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  $('unfollow').onclick = () => { state.selected = null; updateFollow(); };
}

/* ---- legend, segments, play ---- */
const COLOR_MODES = [['stage', 'Stage'], ['flow', 'Flow'], ['wait', 'Wait'], ['persona', 'Traveller'], ['market', 'Market'], ['term', 'Terminal']];
function renderLegend() {
  let items;
  switch (state.colorMode) {
    case 'stage': items = ZONES.map(z => [z.color, z.name]); break;
    case 'flow': items = KINDS.map(k => [k.color, k.name]); break;
    case 'wait': items = [[WAIT_COLORS[0], 'Not yet queued'], [WAIT_COLORS[1], 'Wait < 10 min'], [WAIT_COLORS[2], '10–20 min'], [WAIT_COLORS[3], '20–30 min'], [WAIT_COLORS[4], '> 30 min or missed flight']]; break;
    case 'persona': items = PERSONA_KEYS.map(p => [PERSONAS[p].color, PERSONAS[p].name]).concat([[KINDS[KIND.GRT].color, 'Greeter'], [KINDS[KIND.STF].color, 'Staff']]); break;
    case 'market': items = Object.values(MARKETS).map(m => [m.color, m.name]); break;
    default: items = [[TERM_COLORS[0], 'Terminal 1'], [TERM_COLORS[1], 'Terminal 2']];
  }
  const title = { stage: 'Where they are', flow: 'Who they are', wait: 'Security / passport wait', term: 'Terminal', persona: 'Traveller type', market: 'Destination market' }[state.colorMode];
  $('legend').innerHTML = `<div class="lt">${title}</div>` + items.map(([c, n]) => `<div><i style="background:${c};color:${c}"></i>${n}</div>`).join('');
}
const RES_TABS = [['sec', 'Security'], ['imm', 'Immigration'], ['taxi', 'Taxi rank'], ['car', 'Car parks'], ['bags', 'Bags']];
function buildSegs() {
  $('speedSeg').innerHTML = [30, 60, 120, 300, 600].map(v => `<button data-v="${v}">${v}×</button>`).join('');
  $('speedSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.speed = +b.dataset.v; renderSegs(); });
  $('colorSeg').innerHTML = COLOR_MODES.map(([k, n]) => `<button data-v="${k}">${n}</button>`).join('');
  $('colorSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.colorMode = b.dataset.v; renderSegs(); renderLegend(); });
  $('presetSeg').innerHTML = Object.entries(PRESETS).map(([k, p]) => `<button data-v="${k}" title="Key ${k}">${p.name.replace(' airport', '')}</button>`).join('');
  $('presetSeg').querySelectorAll('button').forEach(b => b.onclick = () => goPreset(b.dataset.v));
  $('resSeg').innerHTML = RES_TABS.map(([k, n]) => `<button data-v="${k}">${n}</button>`).join('');
  $('resSeg').querySelectorAll('button').forEach(b => b.onclick = () => { state.res = b.dataset.v; renderSegs(); renderTimelines(); });
}
function goPreset(k) {
  const site = !!PRESETS[k].site;
  if (site !== siteOn()) {
    // Switching between the twin and the real map: jump, the frames differ.
    state.site = site; bgKey = ''; view.anim = null; Object.assign(view, fitRect(PRESETS[k].rect)); view.fit = false;
    renderSegs();
  } else flyTo(PRESETS[k].rect);
  const tab = { D: 'dep', A: 'arr', L: 'land', B: 'arr' }[k];
  if (tab) setTab(tab);
  if (k === 'B') { state.res = 'bags'; renderSegs(); }
  if (k === 'L' && state.res !== 'car') { state.res = 'taxi'; renderSegs(); }
}
function renderSegs() {
  $('speedSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === state.speed));
  $('colorSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.colorMode));
  $('presetSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === 'S' ? siteOn() : false));
  $('resSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.res));
  const keys = {
    sec: '<span><i class="mk"></i>Arrivals by market /15 min</span><span><i style="background:var(--accent)"></i>Capacity</span><span><i style="background:var(--bad)"></i>Wait</span>',
    imm: '<span><i style="background:#f87171"></i>Passengers /15 min</span><span><i style="background:var(--accent)"></i>Booths + eGates</span><span><i style="background:var(--bad)"></i>Wait</span>',
    taxi: '<span><i style="background:#facc15"></i>Parties /15 min</span><span><i style="background:var(--accent)"></i>Taxis called</span><span><i style="background:var(--bad)"></i>Wait</span>',
    car: '<span>Occupancy through the day</span>',
    bags: '<span><i style="background:#34d399"></i>First bag</span><span><i style="background:#60a5fa"></i>Last bag</span><span>target bands shaded</span>',
  };
  $('tlKey').innerHTML = keys[state.res];
  const name = { sec: 'security', imm: 'passport control', taxi: 'taxi rank', car: 'car parks', bags: 'baggage delivery' }[state.res];
  $('tl1Title').textContent = `Terminal 1 ${name}`; $('tl2Title').textContent = `Terminal 2 ${name}`;
}
function renderTimelines() { renderTimeline('t1'); renderTimeline('t2'); }
const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 16 16"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>';
function renderPlay() {
  $('playBtn').innerHTML = state.playing ? ICON_PAUSE : ICON_PLAY;
  $('livePill').classList.toggle('paused', !state.playing);
  $('liveTxt').textContent = state.seekTarget != null ? 'Fast-forwarding' : state.playing ? `Simulating · ${state.speed}×` : 'Paused';
}

/* ---- actions ---- */
function loadDay(i, at) {
  const keepT = at ?? (sim ? sim.t : 5 * 3600);
  state.di = i;
  gen = genDay(i);
  outlookPlans.cache = {};
  rebuildPlans();
  resetSim();
  renderDayPanel(); renderOutlook(); renderDecision();
  if (typeof renderStudio === 'function' && studioOpen()) renderStudio();
  if ($('scnInfo') && SCN.kind) renderScenario();
  seek(keepT);
  writeHash();
}
function setPlan(k) {
  state.plan = k;
  outlookPlans.cache = {};
  rebuildPlans();
  renderPlans(); renderOutlook(); renderDayPanel(); renderDecision();
  if (SCN.kind) renderScenario();
  scheduleRisk();
  writeHash();
}
function seek(t) {
  t = clamp(t, DAY_START, SIM_END);
  if (t < sim.t) resetSim();
  state.seekTarget = t; state.seekFrom = sim.t;
  renderPlay();
}
/* Calendar markers: does the chosen roster break a resource's target on the day's actual demand? */
let riskToken = 0;
function scheduleRisk() { riskToken++; const tok = riskToken; calButtons().forEach(b => { b.querySelector('.risk').classList.remove('show'); b.title = b.dataset.title || b.title; }); setTimeout(() => computeRisk(0, tok), 400); }
function computeRisk(i, tok = riskToken) {
  if (tok !== riskToken || i >= DATA.days.length) return;
  const g = i === state.di ? gen : genDay(i), notes = [];
  for (const r of RESOURCES) for (const k of TERMS) {
    const pk = r.outlook(g, k, r.plan(g, k, state.plan, state.offset[r.id][k])).peak;
    if (pk > r.threshold) notes.push(`${r.name} ${GEO[k].short} ${Math.round(pk)} min`);
  }
  const btn = calButtons()[i];
  if (btn) {
    btn.dataset.title = btn.dataset.title || btn.title;
    btn.querySelector('.risk').classList.toggle('show', notes.length > 0);
    btn.title = btn.dataset.title + (notes.length ? ` · ${planLabel(state.plan)} roster: ${notes.join(', ')}` : '');
  }
  setTimeout(() => computeRisk(i + 1, tok), 40);
}

/* ---- shareable state in the URL hash: day, time, plan, scenario ---- */
function writeHash() {
  if (state.noHash) return;
  const h = new URLSearchParams({ d: DATA.days[state.di].date, p: state.plan, s: SCN.kind || '', t: fmtHM(sim ? sim.t : 6 * 3600) });
  history.replaceState(null, '', '#' + h.toString());
}
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1)), out = {};
  const di = DATA.days.findIndex(d => d.date === h.get('d'));
  if (di >= 0) out.di = di;
  const p = h.get('p'); if (p && (p === 'hist' || p === 'tfm' || p === 'p90' || /^q\d+$/.test(p))) out.plan = p;
  const s = h.get('s'); if (s && SCENARIO_DEFS[s]) out.scn = s;
  const t = h.get('t'); if (t && /^\d\d:\d\d$/.test(t)) out.t = +t.slice(0, 2) * 3600 + +t.slice(3) * 60;
  return out;
}
