'use strict';
/* ====================================================================
   Arriving passengers: aircraft → pier arrivals lane → sterile corridor
   → immigration → baggage reclaim → customs → arrivals hall → home by
   taxi, bus, Holiday Blue shuttle, car hire, own car or with a greeter.
   The party leader runs the stages; the rest of the party follows.
   ==================================================================== */
function startArrival(rp, t) {
  const g = rp.g;
  if (g.kind === KIND.TRF) { startTransfer(rp, t); return; }
  const G = GEO[g.term], gate = g.af.gate;
  const pts = arrivalPath(G, gate).map(p => ({ x: p.x + jit(1.5), y: p.y + jit(1.5) }));
  g.af.deplaned += g.size;
  sim.rpOf.set(g, rp);
  spawnMembers(rp, KIND.ARR, gate.door.x, gate.door.y, ST.A_DEPLANE, (a, k) => {
    a.af = g.af; a.ch = g.ch;
    if (k) a.stage = FOLLOW; else setPath(a, pts);
  });
}
function followStep(a, dt, t) {
  const L = a.leader;
  if (!L || L.stage === DONE) { a.stage = DONE; return; }
  if (L.hidden) { a.hidden = true; a.wakeAt = L.wakeAt; return; }
  a.hidden = false;
  follow(a, a.v * dt);
  // Close to the leader and the leader is standing still: rest a moment.
  if (Math.abs(a.x - L.x - a.ox) + Math.abs(a.y - L.y - a.oy) < 0.5 && (L.sleep > t || L.stage === ST.A_STOP || L.stage === ST.A_IMM_Q || L.stage === ST.A_TAXI_Q || L.stage === ST.A_RECLAIM)) a.sleep = t + 10;
}
function immChannel(a) { return sim.ts[a.term].imm[a.ch]; }
function toImm(a) {
  const ts = sim.ts[a.term], c = ts.imm[a.ch];
  ts.G.imm[a.ch].snake.slot(c.q.length, tmp);
  a.stage = ST.A_TO_IMM; setPath(a, [{ x: tmp.x, y: tmp.y }]);
}
defStage('A_DEPLANE', Z.CORR, 'Arrivals corridor', (a, dt, t) => {
  if (walkPath(a, a.v * dt)) toImm(a);
});
defStage('A_TO_IMM', Z.IMM, 'To passport control', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  immChannel(a).q.push(a); a.qJoin = t; a.stage = ST.A_IMM_Q;
  if (!a.immCounted) { a.immCounted = true; sim.obs.imm[a.term][hourOfT(t)] += a.party.size; }
});
defStage('A_IMM_Q', Z.IMM, 'Passport control queue', (a, dt) => {
  const c = immChannel(a);
  GEO[a.term].imm[a.ch].snake.slot(c.q.rank(a), tmp);
  approach(a, tmp.x, tmp.y, a.v * dt * 0.85);
});
defStage('A_IMM_SVC', Z.IMM, 'At passport control', (a, dt, t) => {
  const b = a.booth;
  const at = approach(a, b.x, b.y - 5, a.v * dt);
  if (!at || t < a.svcEnd) return;
  b.flash = t;
  if (a.ch === 'egate' && !a.rejected && R() < IMM.egateReject) { a.rejected = true; a.ch = 'eu'; toImm(a); return; }
  a.tImm = t;
  const g = a.party.g, G = GEO[a.term];
  if (g.bags > 0) {
    a.stage = ST.A_TO_RECLAIM;
    setPath(a, [{ x: a.x + jit(4), y: Y.reclaimTop + 2 }, reclaimWaitPoint(G, a)]);
  } else toCustoms(a);
});
function reclaimWaitPoint(G, a) {
  const c = a.af.carousel;
  if (!c) return { x: G.building.x + G.building.w / 2 + jit(60), y: 1024 + jit(5) };
  const p = c.loop.at(R() * c.loop.len, 0, tmp);
  const dx = p.x - c.x, dy = p.y - c.y, l = Math.hypot(dx, dy) || 1;
  return { x: p.x + dx / l * 4, y: p.y + dy / l * 4 };
}
defStage('A_TO_RECLAIM', Z.RECLAIM, 'To baggage reclaim', (a, dt, t) => {
  if (walkPath(a, a.v * dt)) { a.stage = ST.A_RECLAIM; a.atCar = a.af.carousel; a.bagSince = t; }
});
defStage('A_RECLAIM', Z.RECLAIM, 'Waiting for bags', (a, dt, t) => {
  const g = a.party.g;
  if (a.af.carousel && a.atCar !== a.af.carousel) {
    a.atCar = a.af.carousel;
    setPath(a, [reclaimWaitPoint(GEO[a.term], a)]);
  }
  if (!pathDone(a)) walkPath(a, a.v * dt);
  if (a.party.bagsGot >= g.bags) { a.bagWait = t - a.bagSince; toCustoms(a); }
});
function toCustoms(a) {
  const G = GEO[a.term], ch = a.ch === 'non' ? G.customs.green : G.customs.blue;
  a.stage = ST.A_TO_CUSTOMS;
  setPath(a, [{ x: ch.x + jit(6), y: ch.y - 4 }, { x: ch.x + jit(6), y: ch.y + 6 }]);
}
defStage('A_TO_CUSTOMS', Z.RECLAIM, 'Through customs', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  const g = a.party.g, G = GEO[a.term];
  if (g.customsStop && !a.stopped) {
    a.stopped = true; sim.ts[a.term].customsStops++;
    a.stage = ST.A_CUSTOMS_STOP; a.hold = t + U(CUSTOMS.stopMin[0], CUSTOMS.stopMin[1]) * 60;
    setPath(a, [{ x: G.customs.red.x + jit(5), y: G.customs.red.y + jit(2) }]);
    return;
  }
  toHall(a, t);
});
defStage('A_CUSTOMS_STOP', Z.RECLAIM, 'Customs check', (a, dt, t) => {
  if (!pathDone(a)) walkPath(a, a.v * dt);
  if (t >= a.hold) toHall(a, t);
});

/* ---- arrivals hall and the way home ---- */
function toHall(a, t) {
  const g = a.party.g, G = GEO[a.term];
  a.hallAt = t;
  a.stage = ST.A_HALL;
  setPath(a, [{ x: a.x + jit(10), y: Y.rail + 4 }]);
  if (g.mode === 'met' && a.party.greeter == null && !g.greeters) a.party.noGreeter = true;
}
defStage('A_HALL', Z.HALL, 'Arrivals hall', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  const rp = a.party, g = rp.g, G = GEO[a.term];
  switch (g.mode) {
    case 'met': {
      const gr = rp.greeterParty;
      if (gr && gr.leader && gr.leader.stage === ST.G_WAIT) {
        a.stage = ST.A_MEET; setPath(a, [{ x: gr.leader.x + 2, y: gr.leader.y + 2 }]);
      } else if (!g.greeters || (gr && gr.done)) {
        exitBy(a, 'taxi', t);
      } else { a.stage = ST.A_WAIT_GREETER; a.hold = t + 25 * 60; }
      return;
    }
    default: exitBy(a, g.mode, t);
  }
});
defStage('A_WAIT_GREETER', Z.HALL, 'Looking for whoever is meeting them', (a, dt, t) => {
  const gr = a.party.greeterParty;
  if (gr && gr.leader && gr.leader.stage === ST.G_WAIT) { a.stage = ST.A_MEET; setPath(a, [{ x: gr.leader.x + 2, y: gr.leader.y + 2 }]); return; }
  if (t > a.hold) exitBy(a, 'taxi', t);
});
defStage('A_MEET', Z.HALL, 'Meeting their greeter', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  const gr = a.party.greeterParty;
  a.party.met = true;
  for (const m of gr.members) { m.stage = FOLLOW; m.leader = a; m.ox = jit(5); m.oy = jit(4); m.sleep = 0; }
  gr.joined = true;
  exitBy(a, gr.g.byCar ? 'met_car' : 'bus', t);
});
function exitBy(a, mode, t) {
  const rp = a.party, G = GEO[a.term];
  rp.exitMode = mode;
  switch (mode) {
    case 'met_car': case 'short_term': {
      const cp = carparkFor(a.term, mode === 'met_car' ? 'st' : rp.g.mode === 'short_term' ? 'st' : 'st');
      rp.carpark = cp;
      a.stage = ST.A_TO_CAR;
      setPath(a, [{ x: a.x, y: 1110 }, { x: G.link.wall + (G.id === 't2' ? 4 : -4), y: 1110 }, { x: CARPARKS[cp].ped.arr.x, y: CARPARKS[cp].ped.arr.y + jit(6) }]);
      return;
    }
    case 'taxi': {
      const door = nearestArrDoor(G, a.x);
      a.stage = ST.A_TO_TAXI_Q;
      G.taxiQ.slot(sim.taxi.q[a.term].length, tmp);
      setPath(a, [{ x: door.x, y: door.y - 4 }, { x: door.x, y: Y.footArr }, { x: tmp.x, y: tmp.y }]);
      return;
    }
    case 'bus': {
      const door = nearestArrDoor(G, G.arr.bayBus[1]);
      a.stage = ST.A_TO_STOP; a.stopKind = 'bus';
      setPath(a, [{ x: door.x, y: door.y - 4 }, { x: door.x, y: Y.footArr }, { x: G.arr.bayBus[1] + jit(20), y: Y.footArr + jit(4) }]);
      return;
    }
    case 'holiday_blue': {
      const door = nearestArrDoor(G, G.arr.bayShuttle[0]);
      a.stage = ST.A_TO_STOP; a.stopKind = 'hb';
      setPath(a, [{ x: door.x, y: door.y - 4 }, { x: door.x, y: Y.footArr }, { x: G.arr.bayShuttle[0] + jit(8), y: Y.footArr + jit(4) }]);
      return;
    }
    case 'rental': {
      a.stage = ST.A_TO_RENTAL;
      const desks = G.rentalDesks;
      setPath(a, [{ x: (desks[0].x + desks[desks.length - 1].x) / 2 + jit(30), y: 1112 + jit(3) }]);
      return;
    }
  }
}
function nearestArrDoor(G, x) { let d = G.arrDoors[0]; for (const o of G.arrDoors) if (Math.abs(o.x - x) < Math.abs(d.x - x)) d = o; return d; }
function finishArr(a, t) {
  const rp = a.party;
  a.stage = DONE;
  if (!rp.done) {
    rp.done = true;
    sim.counts.arrDone += rp.size;
    const m = rp.exitMode || rp.g.mode;
    sim.counts.exitMode[m] = (sim.counts.exitMode[m] || 0) + rp.size;
    if (rp.greeterParty && rp.greeterParty.joined) { rp.greeterParty.done = true; sim.counts.grtDone += rp.greeterParty.size; }
  }
}
defStage('A_TO_CAR', Z.GROUND, 'Walking to the car park', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  const rp = a.party;
  carparkCarLeaves(rp.carpark, t + U(120, 240), a.term);
  finishArr(a, t);
});
defStage('A_TO_TAXI_Q', Z.GROUND, 'To the taxi rank', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  sim.taxi.q[a.term].push(a); a.qJoin = t; a.stage = ST.A_TAXI_Q;
});
defStage('A_TAXI_Q', Z.GROUND, 'Taxi rank queue', (a, dt) => {
  GEO[a.term].taxiQ.slot(sim.taxi.q[a.term].rank(a), tmp);
  approach(a, tmp.x, tmp.y, a.v * dt * 0.8);
});
defStage('A_TO_TAXI', Z.GROUND, 'Getting into a taxi', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  if (!a.boardedAt) a.boardedAt = t + U(TAXI.load[0], TAXI.load[1]);
  if (t >= a.boardedAt) { taxiDeparts(a.taxi, t); finishArr(a, t); }
});
defStage('A_TO_STOP', Z.GROUND, 'To the bus stop', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  a.stage = ST.A_STOP; a.qJoin = t;
  sim.stops[a.stopKind][a.term].push(a);
});
defStage('A_STOP', Z.GROUND, 'Waiting for a bus or shuttle', () => {});
defStage('A_TO_RENTAL', Z.HALL, 'To the car-hire desks', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  sim.ts[a.term].rental.q.push(a); a.qJoin = t; a.stage = ST.A_RENTAL_Q;
});
defStage('A_RENTAL_Q', Z.HALL, 'Car-hire queue', () => {});
defStage('A_RENTAL_SVC', Z.HALL, 'At a car-hire desk', (a, dt, t) => {
  approach(a, a.desk.x, a.desk.y - 5, a.v * dt);
  if (t < a.svcEnd) return;
  const G = GEO[a.term], door = nearestArrDoor(G, G.arr.bayShuttle[1]);
  a.stage = ST.A_TO_STOP; a.stopKind = 'rental';
  setPath(a, [{ x: door.x, y: door.y - 4 }, { x: door.x, y: Y.footArr }, { x: G.arr.bayShuttle[1] + jit(8), y: Y.footArr + jit(4) }]);
});
