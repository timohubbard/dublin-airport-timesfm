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
    b.innerHTML = `${+d.date.slice(8)}${d.event ? '<span class="ev"></span>' : d.disruption ? '<span class="fog"></span>' : ''}<span class="risk"></span>`;
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
    <div class="dmeta">${fmtInt(dep)} departing · ${fmtInt(arr)} arriving · ${fmtInt(trf)} connecting<br>${gen.flights.length} departures and ${gen.arrFlights.length} arrivals · ${new Set(gen.flights.map(f => f.code)).size} airports · avg delay ${d.delayMin.toFixed(0)} min</div>`;
  $('clockDate').textContent = fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  renderForecastTab();
  renderMix();
}
const FTABS = [['term', 'Terminals'], ['dep', 'Departures'], ['arr', 'Arrivals'], ['land', 'Landside']];
function renderForecastTab() {
  const d = gen.day, tab = state.ftab || 'term';
  $('ftabs').innerHTML = FTABS.map(([k, n]) => `<button data-k="${k}" class="${k === tab ? 'on' : ''}">${n}</button>`).join('');
  $('ftabs').querySelectorAll('button').forEach(b => b.onclick = () => { state.ftab = b.dataset.k; renderForecastTab(); });
  const head = `<tr><th>${tab === 'term' ? '' : tab === 'land' ? 'Series' : 'Market'}</th><th>Actual</th><th>History</th><th>Covariates</th></tr>`;
  let rows = '';
  if (tab === 'term') {
    for (const k of TERMS) rows += `<tr><td>${GEO[k].name}</td><td>${fmtInt(d[k].actual)}</td><td>${errChip(d[k].univariate, d[k].actual)}</td><td>${errChip(d[k].joint_with_covariates, d[k].actual)}</td></tr>`;
  } else if (tab === 'dep' || tab === 'arr') {
    const agg = {};
    for (const k of TERMS) for (const m of TERMINAL_MARKETS[k]) {
      const v = gen.mk[k][m][tab], o = agg[m] || (agg[m] = { a: 0, u: 0, c: 0 });
      o.a += v.actual; o.u += v.univariate; o.c += v.joint_with_covariates;
    }
    rows = Object.keys(MARKETS).map(m => { const o = agg[m]; return `<tr><td><i style="background:${MARKETS[m].color}"></i>${MARKETS[m].short}</td><td>${fmtInt(o.a)}</td><td>${errChip(o.u, o.a)}</td><td>${errChip(o.c, o.a)}</td></tr>`; }).join('');
  } else {
    const ls = d.landside;
    if (!ls) rows = `<tr><td colspan="4" style="color:var(--warn)">Run forecast_operations.py</td></tr>`;
    else {
      const r = (n, v) => `<tr><td>${n}</td><td>${fmtInt(v.actual)}</td><td>${errChip(v.univariate, v.actual)}</td><td>${errChip(v.joint_with_covariates, v.actual)}</td></tr>`;
      rows = r('Taxi pickups T1', ls.taxi.t1) + r('Taxi pickups T2', ls.taxi.t2) + r('Bus & coach T1', ls.bus.t1) + r('Bus & coach T2', ls.bus.t2) + r('Holiday Blue in', ls.hbEntries) + r('Holiday Blue cars', ls.hbOcc);
    }
  }
  $('ftab').innerHTML = head + rows;
}
function renderMix() {
  const tot = PERSONA_KEYS.reduce((s, p) => s + gen.persona[p], 0) || 1;
  $('mixTotal').textContent = `${fmtInt(tot)} passengers`;
  $('mixbar').innerHTML = PERSONA_KEYS.map(p => `<i style="width:${gen.persona[p] / tot * 100}%;background:${PERSONAS[p].color}" title="${PERSONAS[p].name}"></i>`).join('');
  $('mixk').innerHTML = PERSONA_KEYS.map(p => `<span><i style="background:${PERSONAS[p].color}"></i>${PERSONAS[p].name}<b>${(gen.persona[p] / tot * 100).toFixed(gen.persona[p] / tot < 0.05 ? 1 : 0)}%</b></span>`).join('');
}
function renderPlans() {
  $('plans').innerHTML = PLANS.map((p, i) => `<button class="plan ${p.key === state.plan ? 'on' : ''}" data-k="${p.key}"><span class="radio"></span><span><b>${i + 1} · ${p.name}</b><span>${p.desc}</span></span></button>`).join('');
  $('plans').querySelectorAll('.plan').forEach(b => b.onclick = () => setPlan(b.dataset.k));
}
function renderAdj() {
  let html = `<span></span><span class="hdr">T1</span><span class="hdr">T2</span>`;
  for (const r of RESOURCES) {
    html += `<label>${r.name} <span class="sub2">${r.id === 'taxi' ? '×10 taxis' : r.unit}</span></label>`;
    for (const k of TERMS) html += `<span class="stepper"><button data-r="${r.id}" data-k="${k}" data-d="-1" aria-label="Fewer">−</button><span>${state.offset[r.id][k] > 0 ? '+' : ''}${state.offset[r.id][k]}</span><button data-r="${r.id}" data-k="${k}" data-d="1" aria-label="More">+</button></span>`;
  }
  $('adj').innerHTML = html;
  $('adj').querySelectorAll('button').forEach(b => b.onclick = () => {
    const o = state.offset[b.dataset.r]; o[b.dataset.k] = clamp(o[b.dataset.k] + +b.dataset.d, -6, 6);
    rebuildPlans(); renderAdj(); renderOutlook();
  });
}
function renderOutlook() {
  let html = `<tr><th></th>${PLANS.map(p => `<th>${p.short.replace('Covariates ', 'Cov. ')}</th>`).join('')}</tr>`;
  for (const r of RESOURCES) for (const k of TERMS) {
    html += `<tr><td>${r.name} ${GEO[k].short}</td>${PLANS.map(p => `<td class="${p.key === state.plan ? 'selc' : ''}">${chip(outlook[p.key][r.id][k].peak, r.threshold)}</td>`).join('')}</tr>`;
  }
  $('ctab').innerHTML = html;
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
  renderBoard();
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
      rows.push(['Gate', `${g.f.gate.id} · ${GEO[g.term].pierById[g.f.gate.pier].name}`], ['Departs', `${fmtHM(g.f.std)}${g.f.delay ? ` <span style="color:var(--warn)">→ ${fmtHM(g.f.dep)}</span>` : ''}`]);
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
  flyTo(PRESETS[k].rect);
  const tab = { D: 'dep', A: 'arr', L: 'land', B: 'arr' }[k];
  if (tab) setTab(tab);
  if (k === 'B') { state.res = 'bags'; renderSegs(); }
  if (k === 'L' && state.res !== 'car') { state.res = 'taxi'; renderSegs(); }
}
function renderSegs() {
  $('speedSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', +b.dataset.v === state.speed));
  $('colorSeg').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === state.colorMode));
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
  rebuildPlans();
  resetSim();
  renderDayPanel(); renderOutlook();
  seek(keepT);
}
function setPlan(k) {
  state.plan = k;
  rebuildPlans();
  renderPlans(); renderOutlook(); renderDayPanel();
}
function seek(t) {
  t = clamp(t, DAY_START, SIM_END);
  if (t < sim.t) resetSim();
  state.seekTarget = t; state.seekFrom = sim.t;
  renderPlay();
}
/* Calendar markers: does the history-only roster break a resource's target? */
function computeRisk(i) {
  if (i >= DATA.days.length) return;
  const g = i === state.di ? gen : genDay(i), notes = [];
  for (const r of RESOURCES) for (const k of TERMS) {
    const pk = r.outlook(g, k, r.plan(g, k, 'hist', 0)).peak;
    if (pk > r.threshold) notes.push(`${r.name} ${GEO[k].short} ${Math.round(pk)} min`);
  }
  const btn = calButtons()[i];
  if (btn && notes.length) { btn.querySelector('.risk').classList.add('show'); btn.title += ` · history-only roster: ${notes.join(', ')}`; }
  setTimeout(() => computeRisk(i + 1), 60);
}
