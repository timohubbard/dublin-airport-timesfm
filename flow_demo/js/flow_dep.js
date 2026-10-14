'use strict';
/* ====================================================================
   Departing passengers (and transfers once they are airside):
   arrival by car, taxi, bus, shuttle or car park → check-in → security
   → walk-through duty free → shops, food and lounges → US preclearance
   → gate → aircraft.
   ==================================================================== */
function depAccessAt(g) {
  switch (g.via) {
    case 'kerb': case 'taxi': return g.spawn - 160;
    case 'dropgo': return g.spawn - 300;
    case 'st': return g.spawn - 200;
    case 'hb': case 'rental': return g.spawn - 1200;
    case 'bus': return g.spawn - 600;
  }
  return g.spawn;
}
function setupDepMember(a, g) {
  const f = g.f;
  a.f = f; a.gate = f.gate; a.chk = g.chk; a.ft = g.ft; a.callAt = g.call; a.svcMult = g.svcMult; a.market = f.market;
  // Remote stands board earlier by the bus ride.
  const bus = f.gate && f.gate.remote ? f.gate.busMin * 60 : 0;
  const board = (g.persona === 'prm' ? f.dep - 32 * 60 : g.persona === 'family' ? f.dep - (24 + R() * 4) * 60 : f.dep - (6 + R() * 20) * 60) - bus;
  a.boardAt = Math.max(a.callAt + 300, board);
  a.preAt = f.us ? f.dep - 110 * 60 : Infinity;
}
/* Members appear at a landside point and walk in through the nearest door. */
function depArrive(rp, x, y, t) {
  const g = rp.g, G = GEO[g.term];
  let door = G.doors[0];
  for (const d of G.doors) if (Math.abs(d.x - x) < Math.abs(door.x - x)) door = d;
  spawnMembers(rp, g.kind === KIND.TRF ? KIND.TRF : KIND.DEP, x, y, ST.D_WALK_IN, (a, k) => {
    setupDepMember(a, g, k);
    const pts = [];
    if (y > Y.door + 30 && Math.abs(x - door.x) > 40 && y < Y.footDep + 10) pts.push({ x: door.x + jit(6), y: Y.footDep });
    pts.push({ x: door.x + jit(7), y: door.y + 2 }, { x: door.x + jit(7), y: door.y - 12 });
    setPath(a, pts);
  });
  rp.arrivedAt = t;
}
/* Members appear at a car park or the terminal link door and walk in. */
function depArriveVia(rp, pts, t) {
  const g = rp.g, start = pts[0];
  spawnMembers(rp, KIND.DEP, start.x, start.y, ST.D_WALK_IN, (a, k) => {
    setupDepMember(a, g, k);
    setPath(a, pts.slice(1).map(p => ({ x: p.x + jit(4), y: p.y + jit(3) })));
  });
  rp.arrivedAt = t;
}

function goSec(a, ts, G) {
  if (a.ft) ftSlot(G, ts.ftQ.length, tmp); else G.snake.slot(ts.secQ.length, tmp);
  a.stage = ST.D_TO_SEC; setPath(a, [{ x: tmp.x, y: tmp.y }]);
}
function checkMissed(a, t) {
  if (!a.missed && t > a.f.dep - 300 - (a.gate.remote ? a.gate.busMin * 60 : 0)) {
    a.missed = true; sim.ts[a.term].missed++;
    const k = a.gate.remote ? 'remote' : a.gate.pier; sim.missedPier[k] = (sim.missedPier[k] || 0) + 1;
  }
}
function routeToGate(a, G) {
  const g = a.gate, p = G.pierById[g.pier];
  const pts = [];
  if (a.pre) pts.push({ x: G.preclear.door.x + 8, y: G.preclear.door.y + jit(6) });
  pts.push({ x: p.entry.x + jit(5), y: p.entry.y + jit(2), k: p.kEntry }, { x: p.root.x + jit(3), y: p.root.y + jit(3), k: p.k });
  const wf = walkFactor(g.pier, sim.t);
  for (const q of g.route) pts.push({ x: q.x + jit(2), y: q.y + jit(2), k: (q.k || 1) * wf });
  pts.push(randIn(g.hold, 1));
  return pts;
}
function loungeWander(G) { return randIn({ x: G.air.x + 4, y: G.air.y + G.air.h - 4, w: G.air.w - 8, h: Y.dfTop - G.air.y - G.air.h + 2 }, 1); }

defStage('D_WALK_IN', Z.LAND, 'Walking in', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  const ts = sim.ts[a.term], G = ts.G;
  if (a.chk) {
    const c = ts.chk[G.checkin.indexOf(a.chk)];
    chkSlot(a.chk, c.q.length, tmp);
    a.stage = ST.D_TO_CHK; setPath(a, [{ x: tmp.x + a.ox, y: tmp.y + a.oy }]);
  } else goSec(a, ts, G);
});
defStage('D_TO_CHK', Z.LAND, 'To check-in', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  const ts = sim.ts[a.term];
  a.stage = ST.D_CHK_Q;
  if (a.leader) a.tag = true;
  else { ts.chk[ts.G.checkin.indexOf(a.chk)].q.push(a); a.qJoin = t; }
});
defStage('D_CHK_Q', Z.CHK, 'Check-in queue', (a, dt, t) => {
  checkMissed(a, t);
  const ts = sim.ts[a.term], d = a.v * dt;
  if (a.tag) {
    const L = a.leader;
    approach(a, L.x + a.ox, L.y + 4 + Math.abs(a.oy), d * 0.8);
    if (L.stage >= ST.D_TO_SEC || L.stage === DONE) goSec(a, ts, ts.G);
    return;
  }
  const c = ts.chk[ts.G.checkin.indexOf(a.chk)];
  chkSlot(a.chk, c.q.rank(a), tmp); approach(a, tmp.x, tmp.y, d * 0.8);
});
defStage('D_CHK_SVC', Z.CHK, 'At the check-in desk', (a, dt, t) => {
  checkMissed(a, t);
  approach(a, a.desk.x + jit(0.4), a.desk.y + 8, a.v * dt);
  if (t >= a.svcEnd) {
    baggageCheckIn(a, t);
    goSec(a, sim.ts[a.term], GEO[a.term]);
  }
});
defStage('D_TO_SEC', Z.LAND, 'To security', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  const ts = sim.ts[a.term];
  a.inFt = a.ft; (a.ft ? ts.ftQ : ts.secQ).push(a); a.qJoin = t; a.stage = ST.D_SEC_Q;
  sim.obs.sec[a.term][hourOfT(t)]++;
  if (a.f.dep - t < 45 * 60) sim.lateAtSec = (sim.lateAtSec || 0) + 1;
});
defStage('D_SEC_Q', Z.SEC, 'Security queue', (a, dt, t) => {
  checkMissed(a, t);
  const ts = sim.ts[a.term], G = ts.G;
  if (a.inFt) ftSlot(G, ts.ftQ.rank(a), tmp); else G.snake.slot(ts.secQ.rank(a), tmp);
  approach(a, tmp.x, tmp.y, a.v * dt * 0.85);
});
defStage('D_SEC_SVC', Z.SEC, 'Being screened', (a, dt, t) => {
  checkMissed(a, t);
  const L = a.lane, ts = sim.ts[a.term];
  const at = approach(a, L.x, L.y + 13, a.v * dt * 1.1);
  if (at && t >= a.svcEnd) {
    L.flash = t; ts.screened.push(t); a.secDone = t;
    const df = WALK_DF[a.term].rect;
    a.stage = ST.D_DF;
    setPath(a, [{ x: L.x, y: L.y - 13 }, { x: clamp(L.x + jit(10), df.x + 2, df.x + df.w - 2), y: df.y + df.h * (0.2 + 0.6 * R()) }]);
  }
});
// Everyone walks through the duty-free store on the way to the gates.
defStage('D_DF', Z.LOUNGE, 'Walking through duty free', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt * 0.7)) return;
  if (!a.leader && dutyFreeDecide(a, t)) return;
  toLounge(a);
});
function toLounge(a) {
  const G = GEO[a.term];
  a.stage = ST.D_TO_LOUNGE;
  setPath(a, [{ x: a.x + jit(4), y: G.df.y - 2 }, loungeWander(G)]);
}
defStage('D_TO_LOUNGE', Z.LOUNGE, 'To the lounge', (a, dt, t) => {
  checkMissed(a, t);
  if (walkPath(a, a.v * dt)) { a.stage = ST.D_DWELL; a.pause = t + R() * 60; }
});
defStage('D_DWELL', Z.LOUNGE, 'In the departures lounge', (a, dt, t) => {
  checkMissed(a, t);
  const G = GEO[a.term], d = a.v * dt;
  if (a.f.us && !a.pre && t >= a.preAt) { goPreclear(a, G); return; }
  if (t >= a.callAt || a.missed) {
    if (a.f.us && !a.pre) { goPreclear(a, G); return; }
    a.stage = ST.D_TO_GATE; setPath(a, routeToGate(a, G)); return;
  }
  const L = a.leader;
  if (L && L.stage !== DONE && L.term === a.term && (L.stage === ST.D_DWELL || L.stage === ST.D_TO_OUTLET || L.stage === ST.D_OUTLET || L.stage === ST.D_OUTLET_Q)) {
    if (approach(a, L.x + a.ox, L.y + a.oy, d * 0.8)) a.sleep = Math.min(t + 20, a.callAt);
    return;
  }
  if (t < a.pause) { a.sleep = Math.min(a.pause, a.callAt, a.f.us && !a.pre ? a.preAt : Infinity); return; }
  if (!L) {
    const o = chooseOutlet(a, t);
    if (o) { a.outlet = o; a.stage = ST.D_TO_OUTLET; setPath(a, [{ x: o.entry.x + jit(3), y: o.entry.y + 3 }]); return; }
  }
  if (pathDone(a)) setPath(a, [loungeWander(G)]);
  if (walkPath(a, d * 0.45)) { a.pause = t + 60 + R() * 240; a.sleep = Math.min(a.pause, a.callAt, a.f.us && !a.pre ? a.preAt : Infinity); }
});
defStage('D_TO_OUTLET', Z.LOUNGE, 'Heading to a shop or café', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  const r = outletArrive(a, t);
  if (r === true) a.stage = ST.D_OUTLET;
  else if (r === 'q') a.stage = ST.D_OUTLET_Q;
  else { a.outlet = null; a.stage = a.pre ? ST.D_US : ST.D_DWELL; a.pause = t + 30; }
});
defStage('D_OUTLET_Q', Z.LOUNGE, 'Waiting for a table', (a, dt, t) => {
  checkMissed(a, t);
  if (t >= a.callAt - 120) { outletBalk(a, t); a.outlet = null; a.stage = a.pre ? ST.D_US : ST.D_DWELL; a.pause = t; }
});
defStage('D_OUTLET', Z.LOUNGE, 'In a shop, bar or lounge', (a, dt, t) => {
  checkMissed(a, t);
  if (!pathDone(a)) { if (walkPath(a, a.v * dt * 0.5)) a.sleep = Math.min(a.outletUntil, a.callAt - 120, a.f.us && !a.pre ? a.preAt : Infinity); }
  if (t >= a.outletUntil || t >= a.callAt - 120 || (a.f.us && !a.pre && t >= a.preAt)) {
    outletLeave(a, t);
    a.stage = a.pre ? ST.D_US : ST.D_DWELL; a.pause = t + 30 + R() * 120;
    setPath(a, [{ x: a.outlet ? a.outlet.entry.x : a.x, y: (a.outlet ? a.outlet.entry.y : a.y) + 4 }]);
    a.outlet = null;
  }
});
defStage('D_DF_Q', Z.LOUNGE, 'Paying in duty free', (a, dt, t) => {
  checkMissed(a, t);
  approach(a, a.tx ?? a.x, a.ty ?? a.y, a.v * dt * 0.6);
});
function goPreclear(a, G) {
  const pc = G.preclear;
  a.stage = ST.D_TO_PRE;
  setPath(a, [{ x: pc.door.x + 8, y: pc.door.y + jit(6) }, randIn(pc.cbp, 6)]);
}
defStage('D_TO_PRE', Z.LOUNGE, 'To US preclearance', (a, dt, t) => {
  checkMissed(a, t);
  if (walkPath(a, a.v * dt)) { a.stage = ST.D_PRE; a.hold = t + 240 + R() * 300; }
});
defStage('D_PRE', Z.SEC, 'US preclearance (CBP)', (a, dt, t) => {
  checkMissed(a, t);
  if (t < a.hold) return;
  a.pre = true; a.stage = ST.D_US; a.pause = t;
  setPath(a, [randIn(GEO.t2.preclear.lounge, 4)]);
});
defStage('D_US', Z.LOUNGE, 'US departures area', (a, dt, t) => {
  checkMissed(a, t);
  if (t >= a.callAt || a.missed) { a.stage = ST.D_TO_GATE; setPath(a, routeToGate(a, GEO[a.term])); return; }
  if (!a.leader && !a.usOutlet && t >= a.pause) {
    a.usOutlet = true;
    const o = chooseOutlet(a, t, 'us');
    if (o) { a.outlet = o; a.stage = ST.D_TO_OUTLET; setPath(a, [{ x: o.entry.x + jit(3), y: o.entry.y + 3 }]); return; }
  }
  if (pathDone(a)) setPath(a, [randIn(GEO.t2.preclear.lounge, 4)]);
  if (walkPath(a, a.v * dt * 0.3)) a.sleep = Math.min(t + 120 + R() * 200, a.callAt);
});
defStage('D_TO_GATE', Z.GATE, 'Walking to the gate', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  a.gateAt = t;
  if (a.missed) { finishDep(a, false); return; }
  a.stage = ST.D_GATE; a.sleep = a.boardAt;
});
defStage('D_GATE', Z.GATE, 'At the gate', (a, dt, t) => {
  if (t >= a.boardAt) { a.stage = ST.D_BOARD; setPath(a, [{ x: a.gate.bridgeA.x, y: a.gate.bridgeA.y }, { x: a.gate.door.x, y: a.gate.door.y }]); }
});
defStage('D_BOARD', Z.GATE, 'Boarding', (a, dt, t) => {
  if (walkPath(a, a.v * dt)) finishDep(a, true);
});
function finishDep(a, boarded) {
  a.stage = DONE;
  if (boarded) { a.f.boarded++; sim.counts.boarded++; if (a.kind === KIND.TRF) sim.counts.trfDone++; }
  else { sim.counts.missed++; if (a.kind === KIND.TRF) sim.ts[a.term].missedConnections++; }
}

/* ---- transfers: aircraft → pier arrivals lane → Flight Connections Security → lounge ---- */
function startTransfer(rp, t) {
  const g = rp.g, a0 = g.af, G = GEO[g.term], gate = a0.gate;
  const pier = arrivalPath(G, gate).slice(0, -2);
  const fcs = G.fcs;
  const pts = [...pier, { x: G.corrX, y: Y.sec + 2 }, { x: fcs.x + fcs.w - 4, y: fcs.y + fcs.h + 2 }];
  spawnMembers(rp, KIND.TRF, gate.door.x, gate.door.y, ST.T_WALK, (a, k) => {
    setupDepMember(a, { ...g, f: g.f }, k);
    a.af = a0; a.term = g.term;
    if (k) a.stage = FOLLOW;
    else setPath(a, pts.map(p => ({ x: p.x + jit(1.5), y: p.y + jit(1.5) })));
  });
  sim.rpOf.set(g, rp);
}
defStage('T_WALK', Z.CORR, 'Connecting: to flight connections', (a, dt, t) => {
  checkMissed(a, t);
  if (!walkPath(a, a.v * dt)) return;
  const ts = sim.ts[a.term];
  ts.fcs.q.push(a); a.qJoin = t; a.stage = ST.T_FCS_Q;
});
defStage('T_FCS_Q', Z.SEC, 'Flight connections security queue', (a, dt, t) => {
  checkMissed(a, t);
  const ts = sim.ts[a.term];
  ts.G.fcs.snake.slot(ts.fcs.q.rank(a), tmp);
  approach(a, tmp.x, tmp.y, a.v * dt * 0.85);
});
defStage('T_FCS_SVC', Z.SEC, 'Flight connections security', (a, dt, t) => {
  checkMissed(a, t);
  const L = a.lane, G = GEO[a.term];
  const at = approach(a, L.x, L.y + 10, a.v * dt);
  if (!at || t < a.svcEnd) return;
  L.flash = t; sim.ts[a.term].connections += a.party.size;
  a.stage = ST.D_TO_LOUNGE;
  setPath(a, [{ x: L.x, y: L.y - 12 }, { x: L.x - 20, y: G.lounge.y + G.lounge.h - 4 }, loungeWander(G)]);
  for (const m of a.party.members) if (m !== a && m.stage === FOLLOW) { m.stage = ST.D_TO_LOUNGE; setPath(m, [{ x: L.x - 18 + jit(4), y: G.lounge.y + G.lounge.h - 6 }, loungeWander(G)]); }
});
