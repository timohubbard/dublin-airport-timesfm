'use strict';
/* ====================================================================
   Guided tour (key T), help (key ?), and the daily ops briefing (key R).

   The tour drives the real app: it picks days, moves the camera, switches
   rosters and scenarios, opens the Forecast Studio and highlights the panel
   being talked about. It auto-advances; arrow keys step, T or Esc stops.
   ==================================================================== */
const dayIndex = iso => Math.max(0, DATA.days.findIndex(d => d.date === iso));
const sumNodes = (d, f) => TERMS.reduce((s, k) => s + f(d[k]), 0);
const STORY = [
  { title: 'One day at Dublin Airport', secs: 18,
    text: () => `Every dot is a person: departing (filled), arriving (rings), connecting, meeting someone, or at work. Cars, taxis, buses and bags move too. This is <b>${fmtDate(DATA.days[state.di].date, { weekday: 'long', day: 'numeric', month: 'long' })}</b>, the first day of the Atlantic Aviation Summit.`,
    go: () => { closeOverlays(); if (SCN.kind) setScenario(null); loadDay(dayIndex('2026-03-04'), 6.5 * 3600); setPlan('tfm'); goPreset('W'); state.speed = 120; renderSegs(); state.playing = true; renderPlay(); } },
  { title: 'The forecast behind it', secs: 24, spot: 'studio',
    text: () => { const r = (DATA.accuracy.leaderboard || []).filter(x => x.family === 'terminals' && x.slice === 'all'); const g = m => (r.find(x => x.model === m) || {}).wape * 100; return `TimesFM 3 forecasts every terminal, market and travel mode 28 days ahead, zero-shot. Scored on a year of weekly backtests it is off by <b>${g('covariates').toFixed(1)}%</b> a day, against ${g('schedule').toFixed(1)}% for the planner's schedule method and ${g('univariate').toFixed(1)}% from history alone. The bands are calibrated: 80% means 80%.`; },
    go: () => { studio.series = 't1'; studio.reveal = false; if (!studioOpen()) toggleStudio(); else renderStudio(); } },
  { title: 'Why today is busy', secs: 20, spot: 'why', tab: 'fc',
    text: () => { const w = whyParts(); return w ? `The forecast explains itself. Against February's schedule for a Wednesday, the published schedule adds <b>${fmtInt(w.schedule)}</b> passengers and the event calendar another <b>${fmtInt(w.events)}</b>: exact Shapley values from re-running TimesFM with each input switched off.` : ''; },
    go: () => { closeOverlays(); setLeftTab('fc'); } },
  { title: 'Rostering for risk, not for the average', secs: 24, spot: 'riskbox', tab: 'plan',
    text: () => `Instead of one number, planners choose how much risk to carry. Each point is a security roster built for a different forecast quantile: cost along the bottom, the share of passengers expected through in 15 minutes up the side, tested against the whole forecast distribution before the day. Here: <b>P80</b>.`,
    go: () => { setLeftTab('plan'); setPlan('q8'); } },
  { title: 'Security, as it happens', secs: 22, spot: 'cards',
    text: () => `Lanes open ahead of each departure wave because the roster came from the forecast; the people queue against the day's actual demand. The duty manager's surge rule adds lanes if a queue builds.`,
    go: () => { goPreset('D'); setTab('dep'); seek(Math.max(sim.t, 6.75 * 3600)); } },
  { title: 'Arrivals and passport control', secs: 20, spot: 'immCards',
    text: () => `The North American bank lands from 05:00. Passport booths are rostered from the arrivals forecast by market, with eGates for EU passports; bags reach the belts 12 to 20 minutes after on-block.`,
    go: () => { goPreset('A'); setTab('arr'); seek(Math.max(sim.t, 8 * 3600)); } },
  { title: 'The same day, rostered from history alone', secs: 22, spot: 'ctab', tab: 'plan',
    text: () => {
      const names = { sec: 'security', imm: 'passport control', taxi: 'the taxi rank' };
      const gaps = RESOURCES.flatMap(r => TERMS.map(k => ({ r: r.id, k, h: outlook.hist[r.id][k].peak, c: outlook.tfm[r.id][k].peak }))).sort((a, b) => (b.h - b.c) - (a.h - a.c)).slice(0, 2);
      return `A history-only forecast cannot see the summit, so its roster is short exactly when the delegates arrive. Worst hit: ${gaps.map(x => `${names[x.r]} at ${GEO[x.k].short}, peak <b>${Math.round(x.h)} min</b> against ${Math.round(x.c)} with the event calendar`).join('; ')}. The outlook table compares every roster on the day's actual demand.`;
    },
    go: () => { setLeftTab('plan'); setPlan('hist'); goPreset('W'); } },
  { title: 'What if an event is announced?', secs: 24, spot: 'scnInfo', tab: 'scn',
    text: () => { const d = DATA.days[state.di]; const f0 = sumNodes(d, n => n.joint_with_covariates), f1 = sumNodes(d, n => n.joint_with_covariates * (n.scen ? n.scen.event : 1)); return `Tell TimesFM about an event on an ordinary Tuesday and it re-forecasts: <b>+${fmtInt(f1 - f0)}</b> passengers, mostly Europe-city and UK. The rosters follow automatically. The history-only model cannot be told anything.`; },
    go: () => { setPlan('tfm'); loadDay(dayIndex('2026-03-10'), 7 * 3600); SCN.told = true; setScenario('event'); setLeftTab('scn'); } },
  { title: 'Fog: what no forecast can see', secs: 22, spot: 'why', tab: 'fc',
    text: () => `On 11 March fog cancels flights on the day. Delays are only known afterwards, so the forecast overshoots, and the backtest says to expect that on one day in twenty. The calibrated band and the surge rule are what absorb it.`,
    go: () => { setScenario(null); loadDay(dayIndex('2026-03-11'), 8 * 3600); setLeftTab('fc'); goPreset('W'); } },
  { title: 'Kerbs, taxis and car parks', secs: 18, spot: 'taxiCards',
    text: () => `Ground transport is forecast the same way: taxi pickups by terminal, buses, and the Holiday Blue car park, whose cars carry over from one day to the next.`,
    go: () => { loadDay(dayIndex('2026-03-17'), 17 * 3600); goPreset('L'); setTab('land'); } },
  { title: 'Tomorrow’s briefing, ready to send', secs: 16,
    text: () => `Everything rolls up into a one-page ops briefing: forecast with bands, the reasons, the roster and what it costs, and the alerts. Print it or export the roster as CSV. Press T to end the tour, or explore.`,
    go: () => { openBriefing(); } },
];
const story = { running: false, i: 0, t0: 0, timer: null, paused: false, left: 0 };
function storyStart() { story.running = true; story.i = 0; state.noHash = true; $('storybar').classList.add('show'); storyShow(); }
function storyStop() {
  story.running = false; clearTimeout(story.timer); $('storybar').classList.remove('show'); spot(null);
  state.noHash = false; closeOverlays(); writeHash();
}
function storyNext() { if (story.i < STORY.length - 1) { story.i++; storyShow(); } else storyStop(); }
function storyPrev() { if (story.i > 0) { story.i--; storyShow(); } }
function storyShow() {
  clearTimeout(story.timer);
  const s = STORY[story.i];
  try { s.go(); } catch (e) { console.warn('tour step', e); }
  if (s.tab) setLeftTab(s.tab);
  setTimeout(() => {
    $('storybar').innerHTML = `<div class="sbn">${story.i + 1} / ${STORY.length}</div><div class="sbt"><b>${s.title}</b><p>${s.text()}</p></div>
      <div class="sbc"><button id="sbPrev" aria-label="Previous">‹</button><button id="sbPause" aria-label="Pause">${story.paused ? '▶' : '❚❚'}</button><button id="sbNext" aria-label="Next">›</button><button id="sbEnd" aria-label="End tour">×</button></div>
      <div class="sbp"><i style="animation-duration:${s.secs}s;animation-play-state:${story.paused ? 'paused' : 'running'}"></i></div>`;
    $('sbPrev').onclick = storyPrev; $('sbNext').onclick = storyNext; $('sbEnd').onclick = storyStop;
    $('sbPause').onclick = () => { story.paused = !story.paused; storyShow(); };
    spot(s.spot);
  }, 0);
  if (!story.paused) story.timer = setTimeout(storyNext, s.secs * 1000);
}
function spot(id) {
  document.querySelectorAll('.spot').forEach(el => el.classList.remove('spot'));
  const el = id && $(id); if (!el) return;
  const target = id === 'cards' || id === 'immCards' || id === 'taxiCards' ? el.firstElementChild || el : el;
  target.classList.add('spot');
  target.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

/* ---- help ---- */
function toggleHelp() {
  const el = $('help');
  if (el.classList.contains('show')) { el.classList.remove('show'); return; }
  localStorageSet('dubtwin.seenHelp', '1');
  const hint = $('hint'); if (hint) hint.remove();
  const row = (k, t) => `<div class="hk"><kbd>${k}</kbd><span>${t}</span></div>`;
  el.innerHTML = `<div class="mbox glass"><div class="mh"><b>DUB Operations Twin</b><button aria-label="Close help" id="helpClose">×</button></div>
    <p>A whole-airport simulation rostered from TimesFM 3 forecasts. The people follow the day's <b>actual</b> (synthetic) demand; security lanes, passport booths, taxi call-ins and shuttles follow the <b>forecast</b> you choose. Monthly totals and market mix are calibrated to CSO statistics; everything operational is illustrative.</p>
    <div class="hgrid"><div>
      <h4>Watch</h4>${row('Space', 'Play / pause')}${row('← →', 'Back / forward 15 min')}${row('W D A L B', 'Whole · Departures · Arrivals · Landside · Baggage')}${row('C', 'Cycle dot colours')}${row('Click', 'Follow a person; Esc to stop')}${row('Scroll / drag', 'Zoom / pan; double-click to fit')}
      <h4>Present</h4>${row('T', 'Guided tour (about 4 minutes)')}${row('F', 'Forecast Studio')}${row('R', 'Daily ops briefing')}${row('P', 'Performance meter')}
    </div><div>
      <h4>Plan</h4>${row('1 2 3', 'Roster from history only · covariates P50 · P90')}${row('[ ]', 'Risk appetite down / up (P50 … P95)')}
      <h4>Colours</h4>
      <div class="hk"><span class="err g">+2%</span><span>forecast error under 5%</span></div>
      <div class="hk"><span class="err w">+8%</span><span>5 to 12%</span></div>
      <div class="hk"><span class="err b">−15%</span><span>over 12%</span></div>
      <div class="hk"><span class="chip g">6m</span><span>peak wait under a third of the target</span></div>
      <div class="hk"><span class="chip h">24m</span><span>approaching the target</span></div>
      <div class="hk"><span class="chip b">41m</span><span>over the target (30 min security / passport, 20 min taxis)</span></div>
      <div class="hk"><span class="tri"></span><span>calendar: the chosen roster breaks a target that day</span></div>
      <div class="hk"><span class="tl"></span><span>timelines: solid bars have happened, faint bars are still to come; dashed red is the target</span></div>
    </div></div></div>`;
  el.classList.add('show');
  $('helpClose').onclick = toggleHelp;
  el.onclick = e => { if (e.target === el) toggleHelp(); };
}
function showHint() {
  const d = document.createElement('div');
  d.id = 'hint'; d.className = 'hintbox glass';
  d.innerHTML = `<b>New here?</b> Press <kbd>T</kbd> for a guided tour, <kbd>F</kbd> for the Forecast Studio, <kbd>?</kbd> for shortcuts. <button aria-label="Dismiss">×</button>`;
  d.querySelector('button').onclick = () => { d.remove(); localStorageSet('dubtwin.seenHelp', '1'); };
  $('mapwrap').appendChild(d);
}

/* ---- daily ops briefing ---- */
function openBriefing() {
  const el = $('brief'), d = gen.day, M = DATA.meta || {};
  const pts = paretoSecurity(gen), sel = state.plan === 'tfm' ? 'q5' : state.plan === 'p90' ? 'q9' : state.plan, cur = pts.find(p => p.key === sel) || pts[0];
  const w = whyParts(d), al = alertsFor(gen);
  const fc = k => d[k].joint_with_covariates, band = k => `${fmtK(d[k].q[1])}–${fmtK(d[k].q[9])}`;
  const hours = Array.from({ length: 22 }, (_, i) => i + 3);
  const lanesAtH = (k, h) => plans.sec[k][slotOf(h * 3600)];
  const offAtH = (k, h) => plans.imm[k].eu[slotOf(h * 3600)] + plans.imm[k].non[slotOf(h * 3600)];
  const cost = TERMS.reduce((s, k) => s + planCost('sec', plans.sec[k]).eur + planCost('imm', plans.imm[k]).eur, 0);
  const mkRows = TERMS.flatMap(k => TERMINAL_MARKETS[k].map(m => { const md = d.markets[k][m]; return `<tr><td class="l">${GEO[k].short} · ${MARKETS[m].name}</td><td>${fmtInt(md.dep.joint_with_covariates)}</td><td>${fmtInt(md.arr.joint_with_covariates)}</td><td>${fmtK(md.q ? md.q[1] : md.q10)}–${fmtK(md.q ? md.q[9] : md.q90)}</td></tr>`; })).join('');
  el.innerHTML = `<div class="bpage">
    <div class="btools"><button id="bPrint">Print / save PDF</button><button id="bCsv">Download roster CSV</button><button id="bClose" aria-label="Close briefing">Close</button></div>
    <header><div><div class="bk">Daily operations briefing · Dublin Airport (synthetic demo)</div><h1>${fmtDate(d.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</h1>
      <div class="bsub">${d.event ? `<b>${d.event}</b> · ` : ''}${d.disruption ? `${d.disruption} · ` : ''}roster: ${planLabel(state.plan)}${SCN.kind ? ` · scenario: ${SCENARIO_DEFS[SCN.kind].name}${scnTold() ? ' (forecast told)' : ''}` : ''}</div></div>
      <div class="bbig"><b>${fmtInt(fc('t1') + fc('t2'))}</b><span>passengers forecast<br>80% band ${fmtK(d.t1.q[1] + d.t2.q[1])}–${fmtK(d.t1.q[9] + d.t2.q[9])}</span></div></header>
    <section class="bgrid">
      <div><h2>Forecast</h2><table><tr><th></th><th>Median</th><th>80% band</th><th>Flights</th></tr>${TERMS.map(k => `<tr><td class="l">${GEO[k].name}</td><td>${fmtInt(fc(k))}</td><td>${band(k)}</td><td>${d[k].movements}</td></tr>`).join('')}</table>
        <h2>Why</h2><p>${w ? `Against a baseline day (${fmtInt(w.base)}: the schedule of the same weekday in the four weeks before the forecast, no event), the published schedule ${w.schedule >= 0 ? 'adds' : 'removes'} ${fmtInt(Math.abs(w.schedule))}, the event calendar ${w.events >= 0 ? 'adds' : 'removes'} ${fmtInt(Math.abs(w.events))}, school holidays and travel direction ${w.calendar >= 0 ? 'add' : 'remove'} ${fmtInt(Math.abs(w.calendar))}.` : ''}</p>
        <h2>By market</h2><table><tr><th></th><th>Departing</th><th>Arriving</th><th>80% band (both)</th></tr>${mkRows}</table></div>
      <div><h2>Roster</h2><table class="hours"><tr><th>Hour</th>${hours.map(h => `<th>${pad(h % 24)}</th>`).join('')}</tr>
        ${TERMS.map(k => `<tr><td class="l">${GEO[k].short} lanes</td>${hours.map(h => `<td>${lanesAtH(k, h)}</td>`).join('')}</tr>`).join('')}
        ${TERMS.map(k => `<tr><td class="l">${GEO[k].short} booths</td>${hours.map(h => `<td>${offAtH(k, h)}</td>`).join('')}</tr>`).join('')}</table>
        <h2>Cost and risk</h2><table>
          <tr><td class="l">Screening and passport staff</td><td>€${fmtInt(cost)} <span class="bs">illustrative</span></td></tr>
          <tr><td class="l">Security: expected within ${COST.serviceWait.sec} min</td><td>${((1 - cur.late) * 100).toFixed(1)}%</td></tr>
          <tr><td class="l">Chance a security peak passes 30 min</td><td>${(cur.breach * 100).toFixed(0)}%</td></tr>
          <tr><td class="l">Cheapest roster meeting ${Math.round(COST.goal * 100)}% within ${COST.serviceWait.sec} min</td><td>${LEVEL_NAME(planLevelIndex(recommendLevel(pts).key))}</td></tr></table>
        <h2>Alerts <span class="bs">if demand lands on P90</span></h2>${al.length ? `<ul>${al.map(a => `<li>${a.text}${a.extra ? ` → open ${a.extra} more ${a.res === 'sec' ? 'lane' : 'booth'}${a.extra > 1 ? 's' : ''}` : ' (at capacity)'}</li>`).join('')}</ul>` : '<p>None.</p>'}
      </div>
    </section>
    <footer>Forecast: TimesFM 3 (${M.checkpoint || ''}), made ${M.origin || ''}, calibrated on ${M.backtest ? M.backtest.origins : ''} weekly backtest origins and reconciled across terminal, market and direction. Synthetic daily data calibrated to CSO monthly totals (TAM08/TAM07, CC BY 4.0). Every operational figure, cost and capacity is illustrative; this is not a daa document.</footer>
  </div>`;
  el.classList.add('show');
  $('bClose').onclick = () => el.classList.remove('show');
  $('bPrint').onclick = () => window.print();
  $('bCsv').onclick = () => downloadRoster();
}
function downloadRoster() {
  const rows = [['slot_start', 'terminal', 'security_lanes', 'eu_booths', 'non_eu_booths', 'egates', 'taxis_called', 'forecast_plan']];
  for (let s = 0; s < NSLOT; s++) for (const k of TERMS) {
    rows.push([fmtHM(DAY_START + s * SLOT), k, plans.sec[k][s], plans.imm[k].eu[s], plans.imm[k].non[s], plans.imm[k].egate[s], plans.taxi[k][s], state.plan]);
  }
  const blob = new Blob([rows.map(r => r.join(',')).join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `dub-roster-${gen.day.date}-${state.plan}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
