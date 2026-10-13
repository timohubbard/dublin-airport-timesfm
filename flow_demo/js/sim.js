'use strict';
/* ====================================================================
   Simulation engine: state, spawning, timed events and the step loop.
   Flow files (flow_dep, flow_arr, flow_other) register agent stages;
   landside, baggage and commerce keep their own state under sim.
   ==================================================================== */
const state = {
  di: 3, plan: 'tfm', offset: { sec: { t1: 0, t2: 0 }, imm: { t1: 0, t2: 0 }, taxi: { t1: 0, t2: 0 } },
  speed: 60, playing: true, colorMode: 'stage', selected: null, seekTarget: null, seekFrom: 0, tab: 'dep', res: 'sec',
};
let gen = null, sim = null, plans = {}, outlook = {};

/* Min-heap of timed callbacks (car-park exits, delayed spawns). */
class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(t, fn) {
    const a = this.a; a.push({ t, fn }); let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].t <= a[i].t) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  peekT() { return this.a.length ? this.a[0].t : Infinity; }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].t < a[m].t) m = l; if (r < a.length && a[r].t < a[m].t) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; }
    }
    return top;
  }
}
const later = (t, fn) => sim.events.push(t, fn);

let agentSeq = 0;
function newAgent(kind, rp, term, x, y, v, stage) {
  const pm = PERSONAS[rp.persona] || PERSONAS.leisure;
  return {
    id: ++agentSeq, kind, party: rp, term, ti: term ? GEO[term].idx : 0, persona: rp.persona, pm, leader: null,
    ox: 0, oy: 0, x, y, v, stage, path: null, pi: 0, hidden: false, wakeAt: 0, spawned: sim.t,
    missed: false, wait: -1, qJoin: 0, lane: null, desk: null, pause: 0, hold: 0, pre: false, secDone: 0, gateAt: 0,
    tag: false, inFt: false, ft: false, chk: null, f: null, af: null, gate: null, callAt: 0, boardAt: 0, svcMult: 1,
    outlet: null, visits: 0, market: rp.market, tImm: 0, immWait: -1, bagWait: -1, sleep: 0,
  };
}
/* A runtime party wraps the generated party: members, vehicle, progress. */
function newParty(g) {
  return { g, kind: g.kind, persona: g.persona, size: g.size, term: g.term, market: g.market, members: [], leader: null,
    bagsGot: 0, greeter: null, met: false, outlet: null, done: false };
}
function spawnMembers(rp, kind, x, y, stage, setup) {
  const g = rp.g;
  for (let k = 0; k < g.size; k++) {
    const a = newAgent(kind, rp, g.term, x + (k ? jit(3) : 0), y + (k ? jit(3) : 0), g.v * (0.97 + 0.06 * R()), stage);
    if (k) { a.leader = rp.members[0]; a.ox = jit(5); a.oy = jit(4); }
    if (setup) setup(a, k);
    rp.members.push(a); sim.alive.push(a);
  }
  rp.leader = rp.members[0];
  return rp.members;
}

function termState(key) {
  const G = GEO[key];
  return {
    G, secQ: new Queue(), ftQ: new Queue(), ftServed: 0,
    lanes: G.lanes.map(l => ({ ...l, busy: 0, open: false, flash: -1e9 })),
    chk: G.checkin.map(g => ({ g, q: new Queue(), desks: g.deskPos.map(p => ({ ...p, busy: 0 })) })),
    served: 0, within: 0, peak: 0, missed: 0, screened: [], sh: 0, openN: 0, planned: 0, surge: false,
    imm: Object.fromEntries(['eu', 'non', 'egate'].map(ch => [ch, { q: new Queue(), booths: G.imm[ch].booths.map(b => ({ ...b, busy: 0, open: false, flash: -1e9 })), open: 0 }])),
    immSurge: false, immServed: 0, immPeak: 0, immWithin: 0, immWaitSum: 0,
    fcs: { q: new Queue(), lanes: G.fcs.lanes.map(l => ({ ...l, busy: 0, flash: -1e9 })), served: 0 },
    rental: { q: new Queue(), desks: G.rentalDesks.map(d => ({ ...d, busy: 0 })) },
    customsStops: 0, connections: 0, missedConnections: 0,
  };
}
function resetSim() {
  agentSeq = 0;
  seedSim(gen.day.date + '|' + state.plan + '|' + JSON.stringify(state.offset));
  sim = {
    t: DAY_START, alive: [], events: new Heap(), ptr: { dep: 0, arr: 0, grt: 0, stf: 0, fl: 0 },
    ts: { t1: termState('t1'), t2: termState('t2') },
    staff: { q: new Queue(), lanes: STAFF_SEARCH.lanes.map(l => ({ ...l, busy: 0, flash: -1e9 })), served: 0, peak: 0, onDuty: 0 },
    counts: { boarded: 0, missed: 0, arrDone: 0, exitMode: {}, trfDone: 0, grtDone: 0, stfDone: 0 },
    rpOf: new Map(), greeterWaiting: [],
    hist: { t: [], carparks: [], kerb: [], taxi: [], imm: [] },
  };
  for (const f of gen.flights) { f.boarded = 0; f.bagsLoaded = 0; f.shortShipped = 0; f.lateral = null; f.bagsIn = 0; }
  for (const a of gen.arrFlights) { a.deplaned = 0; a.bagsClaimed = 0; a.firstBag = 0; a.lastBag = 0; a.carousel = null; a.bagsOnBelt = 0; }
  landsideReset();
  baggageReset();
  commerceReset();
  state.selected = null;
}

/* Plans for the chosen roster, plus the outlook for every roster. */
function rebuildPlans() {
  plans = {};
  for (const r of RESOURCES) {
    plans[r.id] = {};
    for (const k of TERMS) plans[r.id][k] = r.plan(gen, k, state.plan, state.offset[r.id][k]);
  }
  plans.shuttle = planShuttle(gen, state.plan);
  outlook = {};
  for (const p of PLANS) {
    outlook[p.key] = {};
    for (const r of RESOURCES) {
      outlook[p.key][r.id] = {};
      for (const k of TERMS) outlook[p.key][r.id][k] = r.outlook(gen, k, p.key === state.plan ? plans[r.id][k] : r.plan(gen, k, p.key, state.offset[r.id][k]));
    }
  }
}
const lanesAt = (key, t) => plans.sec[key][slotOf(t)];

/* ---- main step ---- */
function step(dt) {
  const t0 = sim.t, t = t0 + dt; sim.t = t;
  spawnDue(t);
  if (sim.greeterWaiting.length) linkGreeters();
  while (sim.events.peekT() <= t) sim.events.pop().fn(t);
  for (const k of TERMS) {
    serveSecurity(sim.ts[k], t0, t);
    serveImmigration(sim.ts[k], t0, t);
    serveFcs(sim.ts[k], t0, t);
    serveRental(sim.ts[k], t0, t);
  }
  serveStaffSearch(t0, t);
  landsideUpdate(t0, t, dt);
  baggageUpdate(t0, t, dt);
  commerceUpdate(t0, t);
  const al = sim.alive; let w = 0;
  for (let i = 0; i < al.length; i++) {
    const a = al[i];
    if ((a.hidden && a.wakeAt > t) || a.sleep > t) { al[w++] = a; continue; }
    STAGE_FN[a.stage](a, dt, t);
    if (a.stage !== ST.DONE) al[w++] = a;
  }
  al.length = w;
  if (Math.floor(t0 / 300) !== Math.floor(t / 300)) recordHistory(t);
}

function spawnDue(t) {
  const P = sim.ptr;
  while (P.dep < gen.depParties.length && depAccessAt(gen.depParties[P.dep]) <= t) startDeparture(newParty(gen.depParties[P.dep++]), t);
  while (P.arr < gen.arrParties.length && gen.arrParties[P.arr].leaveAt <= t) {
    const g = gen.arrParties[P.arr++];
    if (!g.af.gate) continue;
    startArrival(newParty(g), t);
  }
  while (P.grt < gen.greeters.length && gen.greeters[P.grt].spawn - 240 <= t) startGreeter(newParty(gen.greeters[P.grt++]), t);
  while (P.stf < gen.staff.length && (gen.staff[P.stf].arrive ?? gen.staff[P.stf].leave) - 120 <= t) startStaff(gen.staff[P.stf++], t);
  while (P.fl < gen.arrFlights.length && gen.arrFlights[P.fl].onBlock <= t) baggageOnBlock(gen.arrFlights[P.fl++], t);
}

function recordHistory(t) {
  const h = sim.hist;
  h.t.push(t);
  h.carparks.push(Object.fromEntries(Object.entries(sim.carparks).map(([k, c]) => [k, c.occ])));
  h.kerb.push(TERMS.map(k => GEO[k].bays.kerb.filter(b => b.veh).length));
  h.taxi.push({ holding: sim.taxi.holding, q: TERMS.map(k => sim.taxi.q[k].length) });
  h.imm.push(TERMS.map(k => immWaitNow(sim.ts[k])));
}

/* ---- shared server loops ---- */
function takeInto(ts, a, L, t0, t, fromFt) {
  const start = Math.max(L.busy, t0, a.qJoin);
  a.stage = ST.D_SEC_SVC; a.lane = L; a.svcEnd = start + SEC_SVC * a.svcMult * (0.75 + 0.5 * R());
  L.busy = a.svcEnd;
  a.wait = start - a.qJoin;
  ts.served++; if (a.wait <= 1800) ts.within++;
  if (fromFt) ts.ftServed++;
  if (a.wait > ts.peak) ts.peak = a.wait;
}
function serveSecurity(ts, t0, t) {
  const k = ts.G.id;
  ts.planned = t >= OPEN[k] ? lanesAt(k, t) : 0;
  const w = ts.planned ? ts.secQ.length / (ts.planned * LANE_RATE / 60) : 0;
  ts.surge = ts.planned > 0 && (ts.surge ? w > SURGE_OFF : w > SURGE_ON);
  ts.openN = Math.min(ts.G.maxLanes, ts.planned + (ts.surge ? SURGE : 0));
  const n = ts.openN, order = ts.G.laneOrder;
  for (const L of ts.lanes) L.open = false;
  if (n > 0) {
    for (let i = 0; i < FT_LANES; i++) {
      const L = ts.lanes[i]; L.open = true;
      while (L.busy <= t && (ts.ftQ.length || ts.secQ.length)) {
        const fromFt = ts.ftQ.length > 0;
        takeInto(ts, (fromFt ? ts.ftQ : ts.secQ).shift(), L, t0, t, fromFt);
      }
    }
    for (let j = 0; j < n - FT_LANES && j < order.length; j++) {
      const L = ts.lanes[order[j]]; L.open = true;
      while (L.busy <= t && (ts.secQ.length || (ts.ftQ.length && t - ts.ftQ.peek().qJoin > FT_MERGE))) {
        const merge = ts.ftQ.length && t - ts.ftQ.peek().qJoin > FT_MERGE;
        takeInto(ts, (merge ? ts.ftQ : ts.secQ).shift(), L, t0, t, merge);
      }
    }
  }
  for (const c of ts.chk) {
    for (const d of c.desks) {
      while (c.q.length && d.busy <= t) {
        const a = c.q.shift();
        const start = Math.max(d.busy, t0, a.qJoin);
        a.stage = ST.D_CHK_SVC; a.desk = d; a.svcEnd = start + DESK_SVC * (1 + 0.35 * (a.party.size - 1)) * (0.6 + 0.8 * R());
        d.busy = a.svcEnd;
      }
    }
  }
  while (ts.sh < ts.screened.length && ts.screened[ts.sh] < t - 3600) ts.sh++;
  if (ts.sh > 4000) { ts.screened = ts.screened.slice(ts.sh); ts.sh = 0; }
}

function immOpen(ts, t) {
  const k = ts.G.id, s = slotOf(t), p = plans.imm[k];
  const qEU = ts.imm.eu.q.length, qNon = ts.imm.non.q.length;
  const wEU = p.eu[s] ? qEU / (p.eu[s] * 3600 / p.svc.eu / 60) : 0, wNon = p.non[s] ? qNon / (p.non[s] * 3600 / p.svc.non / 60) : 0;
  const w = Math.max(wEU, wNon);
  ts.immSurge = (p.eu[s] + p.non[s]) > 0 && (ts.immSurge ? w > IMM.surgeOff : w > IMM.surgeOn);
  const extra = ts.immSurge ? IMM.surge : 0;
  ts.imm.eu.open = Math.min(IMM.booths[k].eu, p.eu[s] + (wEU >= wNon ? extra : 0));
  ts.imm.non.open = Math.min(IMM.booths[k].non, p.non[s] + (wNon > wEU ? extra : 0));
  ts.imm.egate.open = p.egate[s];
}
function immWaitNow(ts) {
  const p = plans.imm[ts.G.id];
  let w = 0;
  for (const ch of ['eu', 'non', 'egate']) {
    const c = ts.imm[ch]; if (!c.q.length) continue;
    const rate = c.open * 60 / p.svc[ch];
    w = Math.max(w, rate ? sizeOfQueue(c.q) / rate : 99);
  }
  return w;
}
function sizeOfQueue(q) { let n = 0; for (const a of q) n += a.party.size; return n; }
function serveImmigration(ts, t0, t) {
  immOpen(ts, t);
  for (const ch of ['eu', 'non', 'egate']) {
    const c = ts.imm[ch];
    c.booths.forEach((b, i) => {
      b.open = i < c.open;
      if (!b.open) return;
      while (c.q.length && b.busy <= t) {
        const a = c.q.shift();
        const start = Math.max(b.busy, t0, a.qJoin);
        const g = a.party.g;
        const base = ch === 'eu' && g.cta ? IMM.svc.cta : IMM.svc[ch];
        a.svcEnd = start + base * a.pm.imm * (1 + 0.6 * (a.party.size - 1)) * (0.8 + 0.4 * R());
        a.booth = b; b.busy = a.svcEnd; a.stage = ST.A_IMM_SVC;
        a.immWait = start - a.qJoin;
        ts.immServed += a.party.size; ts.immWaitSum += a.immWait * a.party.size;
        if (a.immWait <= 1800) ts.immWithin += a.party.size;
        if (a.immWait > ts.immPeak) ts.immPeak = a.immWait;
      }
    });
  }
}
function serveFcs(ts, t0, t) {
  const c = ts.fcs;
  for (const L of c.lanes) {
    while (c.q.length && L.busy <= t) {
      const a = c.q.shift();
      const start = Math.max(L.busy, t0, a.qJoin);
      a.svcEnd = start + 30 * a.svcMult * (0.75 + 0.5 * R()); a.lane = L; L.busy = a.svcEnd; a.stage = ST.T_FCS_SVC;
      c.served++;
    }
  }
}
function serveRental(ts, t0, t) {
  const c = ts.rental;
  for (const d of c.desks) {
    while (c.q.length && d.busy <= t) {
      const a = c.q.shift();
      const start = Math.max(d.busy, t0, a.qJoin);
      a.svcEnd = start + U(RENTAL.svc[0], RENTAL.svc[1]); a.desk = d; d.busy = a.svcEnd; a.stage = ST.A_RENTAL_SVC;
    }
  }
}
function serveStaffSearch(t0, t) {
  const c = sim.staff;
  for (const L of c.lanes) {
    while (c.q.length && L.busy <= t) {
      const a = c.q.shift();
      const start = Math.max(L.busy, t0, a.qJoin);
      a.svcEnd = start + (R() < STAFF.secondary ? STAFF.secondarySvc : STAFF.svc) * (0.8 + 0.4 * R());
      a.lane = L; L.busy = a.svcEnd; a.stage = ST.S_SEARCH_SVC;
      a.wait = start - a.qJoin; c.served++; if (a.wait > c.peak) c.peak = a.wait;
    }
  }
}

/* Follower helper: party members move with their leader. */
function follow(a, d) {
  const L = a.leader;
  approach(a, L.x + a.ox, L.y + a.oy, d * 1.3);
}
