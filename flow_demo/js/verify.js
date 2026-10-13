'use strict';
/* ====================================================================
   Verification helpers for the browser console:
     DUB.runHeadless({ di: 16, plan: 'tfm' })   full day, invariant checks
     DUB.runAll()                               every day × every roster
     DUB.bench({ seconds: 5 })                  frame, step and render times
   ==================================================================== */
const DUB = {
  runHeadless({ di = state.di, plan = state.plan, until = SIM_END, dt = 8 } = {}) {
    const keep = { di: state.di, plan: state.plan, playing: state.playing };
    state.seekTarget = null; state.playing = false;
    state.di = di; state.plan = plan; gen = genDay(di); rebuildPlans(); resetSim();
    const t0 = performance.now(), problems = [];
    let maxAlive = 0, maxVeh = 0;
    while (sim.t < until) {
      step(dt);
      maxAlive = Math.max(maxAlive, sim.alive.length); maxVeh = Math.max(maxVeh, sim.vehicles.length);
      if (Math.floor(sim.t / 1800) !== Math.floor((sim.t - dt) / 1800)) {
        for (const [id, c] of Object.entries(sim.carparks)) if (c.occ < 0 || c.occ > c.cap) problems.push(`${id} occupancy ${c.occ} at ${fmtHM(sim.t)}`);
        for (const a of sim.alive) {
          if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) { problems.push(`NaN position ${STAGE_TEXT[a.stage]}`); break; }
          if (a.kind === KIND.ARR && a.stage !== FOLLOW) {
            const G = GEO[a.term];
            if (inRect(G.lounge, a.x, a.y) && a.stage !== ST.A_DEPLANE) { problems.push(`Arrival inside departures lounge (${STAGE_TEXT[a.stage]})`); break; }
          }
        }
      }
    }
    const ms = performance.now() - t0;
    const depGen = gen.depParties.reduce((s, p) => s + p.size, 0) + gen.arrParties.filter(p => p.kind === KIND.TRF).reduce((s, p) => s + p.size, 0);
    const c = sim.counts, ts = sim.ts, B = sim.bags.stats;
    const lateDeps = gen.flights.filter(f => f.dep > until - 1800).reduce((s, f) => s + f.pax, 0);
    const depAlive = sim.alive.filter(a => a.kind === KIND.DEP || a.kind === KIND.TRF).length;
    const arrGen = gen.arrParties.filter(p => p.kind === KIND.ARR).reduce((s, p) => s + p.size, 0);
    const arrLate = gen.arrParties.filter(p => p.kind === KIND.ARR && p.af.onBlock > until - 2.5 * 3600).reduce((s, p) => s + p.size, 0);
    const bagWait = gen.arrFlights.filter(a => a.firstBag);
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return s.length ? s[Math.floor(q * (s.length - 1))] : 0; };
    const firstBag = bagWait.map(a => (a.firstBag - a.onBlock) / 60), lastBag = bagWait.map(a => (a.lastBag - a.onBlock) / 60);
    const live = k => Math.round(ts[k].peak / 60), fl = (r, k) => Math.round(outlook[plan][r][k].peak);
    const report = {
      day: gen.day.date, plan, ms: Math.round(ms), maxAlive, maxVeh, gateConflicts: gen.gateConflicts,
      flights: { dep: gen.flights.length, arr: gen.arrFlights.length },
      departures: { generated: depGen, boarded: c.boarded, missed: c.missed, stillAirside: depAlive, lateFlightsPax: lateDeps, balance: depGen - c.boarded - c.missed - depAlive },
      arrivals: { generated: arrGen, exited: c.arrDone, stillInside: sim.alive.filter(a => a.kind === KIND.ARR).length, lateArrivals: arrLate, modes: c.exitMode },
      transfers: { connected: c.trfDone, missed: ts.t1.missedConnections + ts.t2.missedConnections },
      security: { live: [live('t1'), live('t2')], fluid: [fl('sec', 't1'), fl('sec', 't2')] },
      immigration: { live: [Math.round(ts.t1.immPeak / 60), Math.round(ts.t2.immPeak / 60)], fluid: [fl('imm', 't1'), fl('imm', 't2')] },
      taxi: { peakWait: Math.round(sim.taxi.peakWait / 60), fluid: [fl('taxi', 't1'), fl('taxi', 't2')], supplied: sim.taxi.supplied, out: sim.taxi.out, holding: sim.taxi.holding },
      bags: { ...B, firstBagP10P90: [pct(firstBag, 0.1), pct(firstBag, 0.9)].map(x => +x.toFixed(1)), lastBagP10P90: [pct(lastBag, 0.1), pct(lastBag, 0.9)].map(x => +x.toFixed(1)) },
      carparks: Object.fromEntries(Object.entries(sim.carparks).map(([k, v]) => [k, `${v.occ0}→${v.occ}/${v.cap} turned ${v.turned}`])),
      staff: { done: c.stfDone, onDuty: sim.staff.onDuty, searchPeak: Math.round(sim.staff.peak / 60) },
      spend: Math.round(Object.values(sim.spend).reduce((s, x) => s + x, 0)),
      problems: problems.slice(0, 10),
    };
    state.di = keep.di; state.plan = keep.plan; gen = genDay(keep.di); rebuildPlans(); resetSim(); state.playing = keep.playing;
    seek(6 * 3600);
    return report;
  },
  runAll(plansList = ['hist', 'tfm']) {
    const rows = [];
    for (let di = 0; di < DATA.days.length; di++) for (const plan of plansList) {
      const r = DUB.runHeadless({ di, plan });
      rows.push(`${r.day.slice(5)} ${plan.padEnd(4)} sec ${r.security.live.join('/')} imm ${r.immigration.live.join('/')} taxi ${r.taxi.peakWait} missed ${r.departures.missed} bal ${r.departures.balance} gate ${r.gateConflicts} ${r.problems.length ? 'PROBLEMS ' + r.problems[0] : ''}`);
    }
    return rows.join('\n');
  },
  bench({ seconds = 5 } = {}) {
    perf.frames = [];
    return new Promise(res => setTimeout(() => {
      const f = [...perf.frames].sort((a, b) => a - b);
      res({ p50: f[Math.floor(f.length / 2)], p95: f[Math.floor(f.length * 0.95)], step: perf.step, render: perf.render, alive: sim.alive.length, vehicles: sim.vehicles.length });
    }, seconds * 1000));
  },
};
window.DUB = DUB;
