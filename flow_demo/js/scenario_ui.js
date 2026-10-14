'use strict';
/* ====================================================================
   Scenario simulator UI: the text box in "What if", the editable shock
   list, and the impact view (key I) — where the effect appears first,
   how it travels through the airport, the day's KPIs with and without
   it, and what it does to the forecast.
   ==================================================================== */
const IMPACT = { busy: false, res: null, baseCache: {}, server: null, scrub: 7 * 3600, playing: false };
const SCN_EXAMPLES = [
  'Three security lanes fail in T1 at 7am for two hours',
  'Fog from 5 to 10am',
  'A crash on the M1 delays traffic by 40 minutes from 6 to 9am',
  '20% of screeners call in sick',
  'Ryanair cancels 15% of flights and the bus drivers strike',
  'Baggage system fails in Terminal 2 at 2pm for 90 minutes',
  'French air traffic control strike: 90 minute delays',
  'Sold-out concert tonight brings fans from the UK',
  'Pier 1 closed for maintenance all day',
  'eGates down in T2 and passport officers short',
];
/* Each part of the airport, with what is measured every quarter hour. */
const IMPACT_NODES = [
  { id: 'land', name: 'Roads & kerb', x: 70, y: 64, unit: 'late at security', scale: 60, desc: 'departing passengers reaching security under 45 min before departure, per 15 min' },
  { id: 'chk', name: 'Check-in', x: 225, y: 64, unit: 'queuing', scale: 120, desc: 'people in check-in queues' },
  { id: 'sec', name: 'Security', x: 380, y: 64, unit: 'queuing', scale: 300, desc: 'people in the security queues' },
  { id: 'shop', name: 'Shops & lounges', x: 535, y: 64, unit: '€ / 15 min', scale: 6000, invert: true, desc: 'spend per 15 min (illustrative €); less time airside means less spend' },
  { id: 'gate', name: 'Gates & boarding', x: 690, y: 64, unit: 'missed', scale: 15, desc: 'passengers missing their flight, per 15 min' },
  { id: 'rwy', name: 'Runway & flights', x: 860, y: 145, unit: 'min delay', scale: 20, desc: 'average delay of the flights moving in the quarter hour' },
  { id: 'stand', name: 'Stands', x: 690, y: 226, unit: 'on remote', scale: 4, desc: 'aircraft parked on remote stands (bus boarding)' },
  { id: 'trf', name: 'Connections', x: 612, y: 145, unit: 'missed', scale: 4, desc: 'missed connections, per 15 min' },
  { id: 'imm', name: 'Passport control', x: 535, y: 226, unit: 'min wait', scale: 12, desc: 'longest passport-control wait' },
  { id: 'bag', name: 'Baggage reclaim', x: 380, y: 226, unit: 'waiting', scale: 250, desc: 'people waiting for bags' },
  { id: 'taxi', name: 'Taxis & buses', x: 225, y: 226, unit: 'parties queuing', scale: 50, desc: 'parties in the taxi-rank queues' },
  { id: 'car', name: 'Car parks', x: 70, y: 226, unit: 'turned away', scale: 10, desc: 'cars turned away from full car parks, per 15 min' },
];
const IMPACT_EDGES = [['land', 'chk'], ['chk', 'sec'], ['sec', 'shop'], ['shop', 'gate'], ['gate', 'rwy'], ['rwy', 'stand'], ['stand', 'imm'], ['imm', 'bag'], ['bag', 'taxi'], ['taxi', 'car'], ['car', 'land'], ['imm', 'trf'], ['trf', 'gate'], ['rwy', 'trf']];

/* ---------------- interpreter: Claude via scenario_server.py, else built in ---------------- */
async function checkServer() {
  if (IMPACT.server != null) return IMPACT.server;
  try { const r = await fetch('/api/health', { cache: 'no-store' }); IMPACT.server = r.ok ? await r.json() : false; } catch (e) { IMPACT.server = false; }
  return IMPACT.server;
}
async function interpret(text) {
  const srv = await checkServer();
  if (srv && srv.claude) {
    try {
      const d = gen.day;
      const r = await fetch('/api/interpret', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, context: {
        date: d.date, weekday: fmtDate(d.date, { weekday: 'long' }), event: d.event || null, disruption: DATA.days[state.di].disruption || null,
        piers: TERMS.flatMap(k => GEO[k].piers.map(p => `${p.id} (${p.name}, ${GEO[k].short})`)), carparks: Object.keys(CARPARK_CAP), markets: Object.keys(MARKETS),
        shockTypes: Object.fromEntries(Object.entries(SHOCK_TYPES).map(([k, v]) => [k, `${v.label}; magnitude: ${v.unit || 'n/a'}; default ${v.def}`])),
      } }) });
      if (r.ok) {
        const j = await r.json();
        const shocks = (j.shocks || []).filter(s => SHOCK_TYPES[s.type]).map(s => ({ ...s, from: clamp(+s.from || 0, 0, 26), to: clamp(+s.to || 26, 0, 26), magnitude: +s.magnitude, src: text }));
        return { shocks, notes: j.notes || [], title: j.title || text.slice(0, 64), narrative: j.reasoning || '', source: `Claude (${j.model})` };
      }
    } catch (e) { /* fall back */ }
  }
  return parseScenarioText(text);
}

/* ---------------- running the day twice ---------------- */
const tick = () => new Promise(res => { const ch = new MessageChannel(); ch.port1.onmessage = () => res(); ch.port2.postMessage(0); });
/* Queues are averaged minute by minute over each quarter hour (snapshots are spiky). */
function sampleMinute(m) {
  let chk = 0, sec = 0, taxi = 0, imm = 0, bag = 0;
  for (const k of TERMS) {
    const ts = sim.ts[k];
    sec += ts.secQ.length + ts.ftQ.length; for (const c of ts.chk) chk += c.q.length;
    imm = Math.max(imm, immWaitNow(ts)); taxi += sim.taxi.q[k].length;
  }
  for (const a of sim.alive) if (!a.hidden && STAGE_ZONE[a.stage] === Z.RECLAIM) bag++;
  m.n++; m.chk += chk; m.sec += sec; m.imm += imm; m.taxi += taxi; m.bag += bag;
}
const newMinutes = () => ({ n: 0, chk: 0, sec: 0, imm: 0, taxi: 0, bag: 0 });
function sampleNow(acc, m) {
  const o = { t: sim.t }, n = Math.max(1, m.n);
  Object.assign(o, {
    chk: m.chk / n, sec: m.sec / n, imm: m.imm / n, taxi: m.taxi / n, bag: m.bag / n,
    late: sim.lateAtSec || 0, missed: sim.counts.missed, trf: sim.ts.t1.missedConnections + sim.ts.t2.missedConnections,
    spend: Object.values(sim.spend).reduce((a, b) => a + b, 0), car: Object.values(sim.carparks).reduce((a, c) => a + c.turned, 0),
  });
  acc.push(o);
}
function flightSeries(g) {
  const n = Math.ceil((SIM_END - DAY_START) / 900), del = new Float64Array(n), cnt = new Float64Array(n), remote = new Float64Array(n);
  const bin = t => clamp(Math.floor((t - DAY_START) / 900), 0, n - 1);
  for (const f of g.flights) { const b = bin(f.dep); del[b] += Math.max(0, f.dep - f.std) / 60; cnt[b]++; }
  for (const a of g.arrFlights) { const b = bin(a.onBlock); del[b] += Math.max(0, a.onBlock - a.sta) / 60; cnt[b]++; }
  for (const [gt, list] of g.gateStays) if (gt.remote) for (const st of list) for (let b = bin(st.from); b <= bin(st.to); b++) remote[b]++;
  return { rwy: Array.from(del, (v, i) => (cnt[i] ? v / cnt[i] : 0)), stand: Array.from(remote) };
}
async function runDay(which, onProgress) {
  gen = genDay(state.di); rebuildPlans(); resetSim();
  const samples = [];
  let mins = newMinutes(), nextMin = sim.t + 60, next = sim.t + 900;
  sampleMinute(mins); sampleNow(samples, mins); mins = newMinutes();
  while (sim.t < SIM_END) {
    const until = Math.min(SIM_END, sim.t + 1800);
    while (sim.t < until) {
      step(8);
      if (sim.t >= nextMin) { sampleMinute(mins); nextMin += 60; }
      if (sim.t >= next) { sampleNow(samples, mins); mins = newMinutes(); next += 900; }
    }
    onProgress && onProgress(which, (sim.t - DAY_START) / (SIM_END - DAY_START));
    await tick();
  }
  const ts = sim.ts, c = sim.counts;
  const kpi = {
    missed: c.missed, trfMissed: ts.t1.missedConnections + ts.t2.missedConnections,
    secPeak: TERMS.map(k => Math.round(ts[k].peak / 60)), immPeak: TERMS.map(k => Math.round(ts[k].immPeak / 60)),
    taxiPeak: Math.round(sim.taxi.peakWait / 60), spend: Math.round(Object.values(sim.spend).reduce((a, b) => a + b, 0)),
    short: sim.bags.stats.short, turned: Object.values(sim.carparks).reduce((a, x) => a + x.turned, 0),
    flights: gen.flights.length, arrivals: gen.arrFlights.length,
    delayed15: gen.flights.filter(f => f.dep - f.std > 900).length + gen.arrFlights.filter(a => a.onBlock - a.sta > 900).length,
    avgDelay: (gen.flights.reduce((s, f) => s + (f.dep - f.std), 0) + gen.arrFlights.reduce((s, a) => s + (a.onBlock - a.sta), 0)) / Math.max(1, gen.flights.length + gen.arrFlights.length) / 60,
    remote: gen.flights.filter(f => f.gate && f.gate.remote).length,
    pax: gen.kindCount[KIND.DEP] + gen.kindCount[KIND.ARR] + gen.kindCount[KIND.TRF],
    secWithin: TERMS.reduce((s, k) => s + ts[k].within, 0) / Math.max(1, TERMS.reduce((s, k) => s + ts[k].served, 0)),
  };
  const fl = flightSeries(gen);
  const hourly = { sec: TERMS.map(k => hzPrior(gen, k, 'sec')), told: TERMS.map(k => hzPrior(gen, k, 'sec').T) };
  return { samples, kpi, fl, hourly, missedPier: { ...sim.missedPier } };
}
/* Quarter-hour series for each node (per-15-min flows from cumulative counters). */
function nodeSeries(run) {
  const S = run.samples, n = S.length, d = key => S.map((s, i) => (i ? s[key] - S[i - 1][key] : 0));
  return {
    land: d('late'), chk: S.map(s => s.chk), sec: S.map(s => s.sec), shop: d('spend'), gate: d('missed'),
    rwy: run.fl.rwy.slice(0, n), stand: run.fl.stand.slice(0, n), trf: d('trf'), imm: S.map(s => s.imm), bag: S.map(s => s.bag), taxi: S.map(s => s.taxi), car: d('car'),
  };
}
async function runImpact() {
  if (IMPACT.busy) return;
  IMPACT.busy = true; state.analyzing = true;
  const keepT = sim.t, keepPlaying = state.playing; state.playing = false;
  const bar = p => { $('impProg').style.width = (p * 100).toFixed(1) + '%'; };
  showImpact(true);
  $('impBody').innerHTML = `<div class="imprun"><b>Running ${fmtDate(gen.day.date, { weekday: 'long', day: 'numeric', month: 'long' })} twice</b><span id="impStage">as it happened…</span><div class="bar"><i id="impProg"></i></div><div class="sub2">Same roster (${planLabel(state.plan)}), same passengers, same seed: the only difference is the scenario.</div></div>`;
  try {
    const bk = `${state.di}|${state.plan}|${SRC.dayahead}|${JSON.stringify(state.offset)}`;
    const keep = { kind: SCN.kind, custom: SCN.custom };
    let base = IMPACT.baseCache[bk];
    if (!base) {
      SCN.kind = null;
      base = await runDay('base', (w, p) => bar(p * 0.5));
      SCN.kind = keep.kind; SCN.custom = keep.custom;
      IMPACT.baseCache = { [bk]: base };
    }
    $('impStage').textContent = 'with the scenario…';
    const scn = await runDay('scn', (w, p) => bar(0.5 + p * 0.5));
    IMPACT.res = { base, scn, title: SCN.custom.title, shocks: SCN.custom.shocks, source: SCN.custom.source, narrative: SCN.custom.narrative, di: state.di };
  } finally {
    gen = genDay(state.di); rebuildPlans(); resetSim(); state.analyzing = false; IMPACT.busy = false;
    seek(keepT); state.playing = keepPlaying; renderPlay();
  }
  analyseImpact(IMPACT.res);
  renderImpact();
  requestBrief(IMPACT.res);
}
/* Where and when each part of the airport feels it. */
function analyseImpact(R) {
  const b = nodeSeries(R.base), s = nodeSeries(R.scn), n = Math.min(R.base.samples.length, R.scn.samples.length);
  R.t = R.base.samples.slice(0, n).map(x => x.t);
  R.nodes = IMPACT_NODES.map(N => {
    const delta = [], sev = [];
    for (let i = 0; i < n; i++) { const dlt = (s[N.id][i] || 0) - (b[N.id][i] || 0); delta.push(dlt); sev.push(clamp((N.invert ? -dlt : dlt) / N.scale, -1, 1)); }
    // First felt: a fifth of the scale, held for half an hour (one-off noise is ignored).
    let first = -1; for (let i = 0; i + 1 < n; i++) if (Math.abs(sev[i]) >= 0.2 && Math.abs(sev[i + 1]) >= 0.2 && Math.sign(sev[i]) === Math.sign(sev[i + 1])) { first = i; break; }
    let pk = 0; for (let i = 1; i < n; i++) if (Math.abs(sev[i]) > Math.abs(sev[pk])) pk = i;
    const total = delta.reduce((a, v) => a + v, 0);
    return { ...N, delta, sev, first, peak: pk, peakSev: sev[pk], total, base: b[N.id], scn: s[N.id] };
  });
  const firsts = R.nodes.filter(x => x.first >= 0).sort((p, q) => p.first - q.first);
  R.order = firsts.map(x => x.id);
  R.scrub0 = firsts.length ? R.t[firsts[0].first] : 7 * 3600;
  IMPACT.scrub = R.scrub0;
}
const KPI_ROWS = [
  ['Passengers missing their flight', r => r.missed, 0, true], ['Missed connections', r => r.trfMissed, 0, true],
  ['Security peak wait T1 / T2 (min)', r => r.secPeak, 0, true], ['Within 30 min at security', r => r.secWithin * 100, 1, false, '%'],
  ['Passport peak wait T1 / T2 (min)', r => r.immPeak, 0, true], ['Taxi-rank peak wait (min)', r => r.taxiPeak, 0, true],
  ['Flights operated (dep + arr)', r => r.flights + r.arrivals, 0, false], ['Flights over 15 min late', r => r.delayed15, 0, true],
  ['Average flight delay (min)', r => r.avgDelay, 1, true], ['Departures from remote stands', r => r.remote, 0, true],
  ['Bags left behind', r => r.short, 0, true], ['Cars turned away', r => r.turned, 0, true],
  ['Passengers through the airport', r => r.pax, 0, false], ['Spend airside (illustrative €)', r => r.spend, 0, false, '€'],
];
function kpiTable(R) {
  const f = (v, d, u) => Array.isArray(v) ? v.join(' / ') : (u === '€' ? '€' : '') + (d ? v.toFixed(d) : fmtInt(v)) + (u === '%' ? '%' : '');
  return `<table class="mtab kpis2"><tr><th></th><th>As it happened</th><th>With the scenario</th><th>Change</th></tr>` + KPI_ROWS.map(([name, get, d, worseUp, u]) => {
    const a = get(R.base.kpi), b = get(R.scn.kpi);
    let ch;
    if (Array.isArray(a)) ch = a.map((x, i) => { const z = b[i] - x; return `<span class="${z === 0 ? '' : (z > 0) === worseUp ? 'bad' : 'good'}">${z > 0 ? '+' : ''}${z}</span>`; }).join(' / ');
    else { const z = b - a; ch = Math.abs(z) < (d ? 0.05 : 0.5) ? '<span class="sub2">—</span>' : `<span class="${(z > 0) === worseUp ? 'bad' : 'good'}">${z > 0 ? '+' : '−'}${u === '€' ? '€' : ''}${d ? Math.abs(z).toFixed(d) : fmtInt(Math.abs(z))}</span>`; }
    return `<tr><td class="l">${name}</td><td>${f(a, d, u)}</td><td>${f(b, d, u)}</td><td>${ch}</td></tr>`;
  }).join('') + '</table>';
}
/* A plain-language account from the measured differences (Claude's, if the server is running, replaces it). */
function templateBrief(R) {
  const bits = [];
  const fmtT = i => fmtHM(R.t[i]);
  for (const id of R.order.slice(0, 6)) {
    const N = R.nodes.find(x => x.id === id), v = N.delta[N.peak];
    const val = N.id === 'shop' ? `€${fmtInt(Math.abs(v))} ${v < 0 ? 'less' : 'more'} spend per quarter hour` : `${v > 0 ? '+' : '−'}${N.id === 'rwy' || N.id === 'imm' ? Math.abs(v).toFixed(0) : fmtInt(Math.abs(v))} ${N.unit}`;
    bits.push(`<b>${N.name}</b> from ${fmtT(N.first)} (worst at ${fmtT(N.peak)}: ${val})`);
  }
  const k0 = R.base.kpi, k1 = R.scn.kpi;
  const miss = k1.missed - k0.missed, mp = Object.entries(R.scn.missedPier).map(([p, v]) => [p, v - (R.base.missedPier[p] || 0)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
  let s = bits.length ? `The effect reaches, in order: ${bits.join('; ')}.` : 'No part of the airport moves by more than a sixth of a typical busy-hour swing.';
  if (miss > 5) s += ` <b>${fmtInt(miss)} more passengers miss flights</b>${mp.length ? `, most at ${mp.slice(0, 2).map(([p, v]) => `${p === 'remote' ? 'remote stands' : GEO.t1.pierById[p] ? GEO.t1.pierById[p].name : GEO.t2.pierById[p] ? GEO.t2.pierById[p].name : p} (${v})`).join(' and ')}, where the walk is longest` : ''}.`;
  if (Math.abs(k1.spend - k0.spend) > 2000) s += ` Airside spend ${k1.spend < k0.spend ? 'falls' : 'rises'} by €${fmtK(Math.abs(k1.spend - k0.spend))} (illustrative).`;
  return s;
}
async function requestBrief(R) {
  const srv = await checkServer();
  if (!srv || !srv.claude) return;
  try {
    const nodes = R.nodes.filter(n => n.first >= 0).map(n => ({ part: n.name, measure: n.desc, first: fmtHM(R.t[n.first]), worst: fmtHM(R.t[n.peak]), changeAtWorst: +n.delta[n.peak].toFixed(1) }));
    const kpis = Object.fromEntries(KPI_ROWS.map(([name, get]) => [name, { before: get(R.base.kpi), after: get(R.scn.kpi) }]));
    const r = await fetch('/api/brief', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenario: R.title, date: DATA.days[R.di].date, shocks: R.shocks.map(describeShock), ripple: nodes, kpis, roster: planLabel(state.plan) }) });
    if (!r.ok) return;
    const j = await r.json();
    if (IMPACT.res === R && j.brief) { R.brief = j.brief; R.briefModel = j.model; const el = $('impBrief'); if (el) el.innerHTML = briefHtml(R); }
  } catch (e) { /* keep the template */ }
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function briefHtml(R) {
  if (R.brief) return `<div class="brieftxt">${esc(R.brief).replace(/\n+/g, '</p><p>').replace(/^/, '<p>')}</p></div><div class="sub2">Written by ${esc(R.briefModel)} from the measured differences above.</div>`;
  return `<p>${templateBrief(R)}</p><div class="sub2">Summarised from the measured differences.${IMPACT.server && IMPACT.server.claude ? ' Asking Claude for a briefing…' : ' Run <code>python scenario_server.py</code> for a Claude-written briefing.'}</div>`;
}

/* ---------------- the impact view ---------------- */
const impactOpen = () => $('impact').classList.contains('show');
function showImpact(on) { $('impact').classList.toggle('show', on); if (!on) IMPACT.playing = false; }
function toggleImpact() { if (impactOpen()) showImpact(false); else if (IMPACT.res) { showImpact(true); renderImpact(); } }
function renderImpact() {
  const R = IMPACT.res; if (!R || !R.nodes) return;
  const d = DATA.days[R.di];
  $('impBody').innerHTML = `
    <div class="sthead"><div class="stt"><b>${esc(R.title)}</b><span>${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long' })} · roster ${planLabel(state.plan)} · interpreted by ${esc(R.source)}</span></div>
      <button class="pill btn" id="impWatch">Watch it in the twin ↗</button><button class="stclose" id="impClose" aria-label="Close">×</button></div>
    <div class="impshocks">${R.shocks.map(s => `<span class="shock n-${SHOCK_TYPES[s.type].node}">${esc(describeShock(s))}</span>`).join('')}</div>
    ${R.narrative ? `<div class="sub2 impwhy">${esc(R.narrative)}</div>` : ''}
    <div class="stgrid">
      <section class="stc span2"><div class="sth"><h4>How it ripples through the airport</h4><span class="sub2" id="impTime"></span></div>
        <svg id="impGraph" viewBox="0 0 940 290" role="img" aria-label="Airport subsystems coloured by how much the scenario changes them"></svg>
        <div class="impscrub"><button class="iconbtn sm" id="impPlay" aria-label="Play the ripple">▶</button><input type="range" id="impT" min="${R.t[0]}" max="${R.t[R.t.length - 1]}" step="900" value="${IMPACT.scrub}" aria-label="Time of day"></div>
        <canvas id="impHeat" aria-label="Change in each part of the airport, quarter hour by quarter hour"></canvas>
        <div class="stkey"><span><i class="bx" style="background:#f43f5e"></i>worse than the day as it happened</span><span><i class="bx" style="background:#2dd4bf"></i>better</span><span>rows: parts of the airport, in the order the effect reached them</span></div></section>
      <section class="stc"><h4>What it means</h4><div id="impBrief">${briefHtml(R)}</div></section>
      <section class="stc span2"><h4>The day, with and without it</h4>${kpiTable(R)}</section>
      <section class="stc"><h4>What the forecast does</h4><canvas id="impFc" aria-label="Hourly security demand forecast with and without the scenario"></canvas><div class="sub2" id="impFcNote"></div></section>
    </div>`;
  $('impClose').onclick = () => showImpact(false);
  $('impWatch').onclick = () => { showImpact(false); closeOverlays(); seek(Math.max(DAY_START, R.scrub0 - 900)); state.playing = true; renderPlay(); };
  $('impT').oninput = e => { IMPACT.scrub = +e.target.value; IMPACT.playing = false; drawImpactGraph(); drawHeat(); };
  $('impPlay').onclick = () => { IMPACT.playing = !IMPACT.playing; if (IMPACT.playing && IMPACT.scrub >= R.t[R.t.length - 1] - 900) IMPACT.scrub = R.t[0]; playRipple(); };
  requestAnimationFrame(() => { drawImpactGraph(); drawHeat(); drawImpactForecast(R); });
}
function playRipple() {
  const R = IMPACT.res; if (!IMPACT.playing || !R || !impactOpen()) { if ($('impPlay')) $('impPlay').textContent = '▶'; return; }
  $('impPlay').textContent = '❚❚';
  IMPACT.scrub += 900;
  if (IMPACT.scrub > R.t[R.t.length - 1]) { IMPACT.playing = false; IMPACT.scrub = R.t[R.t.length - 1]; }
  $('impT').value = IMPACT.scrub; drawImpactGraph(); drawHeat();
  setTimeout(playRipple, 140);
}
const sevColor = (v, a = 1) => v >= 0 ? `rgba(244,63,94,${(0.12 + 0.88 * Math.min(1, v)) * a})` : `rgba(45,212,191,${(0.12 + 0.88 * Math.min(1, -v)) * a})`;
function drawImpactGraph() {
  const R = IMPACT.res, svg = $('impGraph'); if (!svg) return;
  const i = clamp(Math.round((IMPACT.scrub - R.t[0]) / 900), 0, R.t.length - 1);
  const pos = Object.fromEntries(R.nodes.map(n => [n.id, n]));
  let h = '<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#475569"/></marker></defs>';
  for (const [a, b] of IMPACT_EDGES) {
    const p = pos[a], q = pos[b], live = Math.abs(p.sev[i]) > 0.15 && Math.abs(q.sev[i]) > 0.15;
    const dx = q.x - p.x, dy = q.y - p.y, L = Math.hypot(dx, dy) || 1, r = 34;
    h += `<line x1="${p.x + dx / L * r}" y1="${p.y + dy / L * r}" x2="${q.x - dx / L * (r + 4)}" y2="${q.y - dy / L * (r + 4)}" stroke="${live ? 'rgba(244,63,94,0.7)' : '#334155'}" stroke-width="${live ? 2.2 : 1.2}" marker-end="url(#ar)"${a === 'car' ? ' stroke-dasharray="4 4"' : ''}/>`;
  }
  for (const n of R.nodes) {
    const v = n.sev[i], hit = n.first >= 0 && i >= n.first;
    const val = n.delta[i], txt = Math.abs(val) < 0.05 ? '—' : `${val > 0 ? '+' : '−'}${n.id === 'shop' ? '€' + fmtK(Math.abs(val)) : n.id === 'rwy' || n.id === 'imm' ? Math.abs(val).toFixed(0) : fmtInt(Math.abs(val))}`;
    h += `<g><title>${esc(n.name)}: ${esc(n.desc)}</title><circle cx="${n.x}" cy="${n.y}" r="32" fill="${sevColor(n.invert ? v : v)}" stroke="${hit ? '#fda4af' : '#334155'}" stroke-width="${hit ? 2 : 1}"/>`;
    h += `<text x="${n.x}" y="${n.y - 3}" text-anchor="middle" class="gv">${txt}</text><text x="${n.x}" y="${n.y + 11}" text-anchor="middle" class="gu">${esc(n.unit)}</text>`;
    h += `<text x="${n.x}" y="${n.y + 48}" text-anchor="middle" class="gn">${esc(n.name)}</text>`;
    if (n.first >= 0) h += `<text x="${n.x}" y="${n.y - 40}" text-anchor="middle" class="gf">${R.order.indexOf(n.id) + 1} · from ${fmtHM(R.t[n.first])}</text>`;
    h += '</g>';
  }
  svg.innerHTML = h;
  $('impTime').innerHTML = `at <b>${fmtHM(R.t[i])}</b> · change against the day as it happened`;
}
function drawHeat() {
  const R = IMPACT.res, cv = $('impHeat'); if (!cv) return;
  const c = stCanvas(cv, { l: 118, r: 8, t: 4, b: 18 }); if (!c) return;
  const { g, ml, mt, W, H } = c;
  const rows = [...R.order.map(id => R.nodes.find(n => n.id === id)), ...R.nodes.filter(n => n.first < 0)];
  const rh = H / rows.length, n = R.t.length, cw = W / n;
  rows.forEach((N, r) => {
    g.fillStyle = N.first >= 0 ? '#cbd5e1' : '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(N.name, ml - 6, mt + r * rh + rh / 2);
    for (let i = 0; i < n; i++) { const v = N.sev[i]; if (Math.abs(v) < 0.02) continue; g.fillStyle = sevColor(v); g.fillRect(ml + i * cw, mt + r * rh + 1, Math.ceil(cw), rh - 2); }
  });
  const i = clamp(Math.round((IMPACT.scrub - R.t[0]) / 900), 0, n - 1);
  g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(ml + (i + 0.5) * cw, mt); g.lineTo(ml + (i + 0.5) * cw, mt + H); g.stroke();
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top';
  for (let k = 0; k < n; k++) { const t = R.t[k]; if (t % (3 * 3600) === 0) g.fillText(fmtHM(t), ml + (k + 0.5) * cw, mt + H + 4); }
}
function drawImpactForecast(R) {
  const cv = $('impFc'); if (!cv) return;
  const c = stCanvas(cv, { l: 42, r: 8, t: 10, b: 20 }); if (!c) return;
  const { g, ml, mt, W, H } = c, h0 = 3, h1 = 25;
  const series = run => { const out = new Float64Array(NH); run.hourly.sec.forEach(pr => { for (let h = 0; h < NH; h++) out[h] += pr.p[h] * pr.T; }); return out; };
  const a = series(R.base), b = series(R.scn);
  let top = 1; for (let h = h0; h < h1; h++) top = Math.max(top, a[h], b[h]); top *= 1.1;
  const X = h => ml + (h - h0) / (h1 - h0) * W, Y = v => mt + H - v / top * H;
  yTicks(c, Y, 0, top);
  const line = (arr, col, dash) => { g.strokeStyle = col; g.lineWidth = 2; g.setLineDash(dash || []); g.beginPath(); for (let h = h0; h < h1; h++) { const x = X(h + 0.5); h === h0 ? g.moveTo(x, Y(arr[h])) : g.lineTo(x, Y(arr[h])); } g.stroke(); g.setLineDash([]); };
  line(a, '#94a3b8', [4, 3]); line(b, '#f472b6');
  g.fillStyle = '#5a6a86'; g.textAlign = 'center'; g.textBaseline = 'top'; for (let h = h0; h <= h1; h += 6) g.fillText(pad(h % 24) + ':00', X(h), mt + H + 4);
  const T0 = R.base.hourly.told.reduce((s, v) => s + v, 0), T1 = R.scn.hourly.told.reduce((s, v) => s + v, 0);
  $('impFcNote').innerHTML = `Departing passengers reaching security per hour, forecast from the timetable: <span style="color:#94a3b8">dashed, as planned</span>; <span style="color:#f472b6">pink, with the scenario</span>. Daily total ${fmtK(T0)} → <b>${fmtK(T1)}</b> (${T1 >= T0 ? '+' : ''}${((T1 / T0 - 1) * 100).toFixed(1)}%)${SCN.told ? ', the TimesFM forecast told about the cancellations, added flights and demand change' : ', forecast not told (tick "Tell the forecast")'}. Rosters built from the forecast follow it.`;
}

/* ---------------- the "What if" panel ---------------- */
function renderScenarioBox() {
  const el = $('scnText'); if (!el) return;
  $('scnEx').innerHTML = SCN_EXAMPLES.map(x => `<button class="exb">${esc(x)}</button>`).join('');
  $('scnEx').querySelectorAll('button').forEach(b => b.onclick = () => { el.value = b.textContent; });
  $('scnGo').onclick = () => simulateText(el.value);
  el.onkeydown = e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) simulateText(el.value); };
  checkServer().then(s => {
    $('scnSrc').innerHTML = s && s.claude ? `Interpreted by <b>Claude</b> (${esc(s.model)}) via scenario_server.py`
      : s ? `Built-in parser: scenario_server.py is running but Claude is not available <span class="sub2">(${esc((s.error || '').slice(0, 120))})</span>`
      : `Interpreted by the built-in parser. <span class="sub2">Run <code>python scenario_server.py</code> with an Anthropic API key for Claude.</span>`;
  });
  renderShockList();
}
function renderShockList() {
  const el = $('scnShocks'); if (!el) return;
  if (SCN.kind !== 'custom' || !SCN.custom) { el.innerHTML = ''; return; }
  const C = SCN.custom;
  el.innerHTML = `<div class="shl">${C.shocks.map((s, i) => `<div class="shrow"><span class="shock n-${SHOCK_TYPES[s.type].node}">${esc(describeShock(s))}</span>
      <span class="shed">${SHOCK_TYPES[s.type].window ? `<input type="number" step="0.25" min="0" max="26" value="${s.from}" data-i="${i}" data-f="from" aria-label="From (hour)">–<input type="number" step="0.25" min="0" max="26" value="${s.to}" data-i="${i}" data-f="to" aria-label="To (hour)">h` : ''}
      ${['egates_down', 'power_outage', 'pier_closed', 'weather'].includes(s.type) ? '' : `<input type="number" step="any" value="${s.magnitude}" data-i="${i}" data-f="magnitude" aria-label="Size" title="${esc(SHOCK_TYPES[s.type].unit)}">`}
      <button class="linkbtn" data-del="${i}" aria-label="Remove">✕</button></span></div>`).join('')}</div>
    ${C.notes && C.notes.length ? `<div class="sub2 warn">${C.notes.map(esc).join('<br>')}</div>` : ''}
    <div class="shbtns"><button class="pill btn" id="scnRerun">Re-run impact</button>${IMPACT.res ? '<button class="pill btn" id="scnOpen">Impact view (I)</button>' : ''}</div>`;
  el.querySelectorAll('input').forEach(inp => inp.onchange = () => { const s = C.shocks[+inp.dataset.i]; s[inp.dataset.f] = +inp.value; applyCustom(false); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { C.shocks.splice(+b.dataset.del, 1); applyCustom(false); });
  $('scnRerun').onclick = () => runImpact();
  if ($('scnOpen')) $('scnOpen').onclick = toggleImpact;
}
function applyCustom(run = true) {
  genCache.clear();
  loadDay(state.di);
  renderScenario(); renderShockList(); writeHash();
  if (run) runImpact();
}
async function simulateText(text) {
  text = (text || '').trim(); if (!text) return;
  $('scnGo').disabled = true; $('scnGo').textContent = 'Interpreting…';
  try {
    const r = await interpret(text);
    if (!r.shocks.length) { $('scnShocks').innerHTML = `<div class="sub2 warn">${(r.notes || ['Nothing recognised.']).map(esc).join('<br>')} Try one of the examples.</div>`; return; }
    SCN.kind = 'custom'; SCN.custom = { text, ...r };
    applyCustom(true);
  } finally { $('scnGo').disabled = false; $('scnGo').textContent = 'Simulate'; }
}
