'use strict';
/* ====================================================================
   Meeters and greeters, and staff.
   ==================================================================== */
function startGreeter(rp, t) {
  const g = rp.g, G = GEO[g.term];
  rp.persona = 'leisure';
  // Link the greeter party to the arriving party when it spawns (see linkGreeters).
  sim.greeterWaiting.push(rp);
  if (g.byCar) {
    const cp = carparkFor(g.term, 'st');
    rp.carpark = cp;
    carparkCarArrives(cp, t, g.term);
    later(Math.max(t, g.spawn), tt => {
      const p = CARPARKS[cp].ped.arr;
      spawnMembers(rp, KIND.GRT, p.x, p.y + jit(6), ST.G_WALK, (a, k) => {
        if (k) a.stage = FOLLOW;
        else setPath(a, [{ x: G.link.wall + (G.id === 't2' ? 6 : -6), y: 1110 }, randIn(G.greet, 2)]);
      });
    });
  } else {
    later(Math.max(t, g.spawn), () => {
      const bx = G.arr.bayBus[1], door = nearestArrDoor(G, bx);
      spawnMembers(rp, KIND.GRT, bx + jit(10), Y.footArr, ST.G_WALK, (a, k) => {
        if (k) a.stage = FOLLOW;
        else setPath(a, [{ x: door.x, y: Y.footArr }, { x: door.x, y: door.y - 6 }, randIn(G.greet, 2)]);
      });
    });
  }
}
function linkGreeters() {
  // Greeter parties find the runtime party of the passengers they meet.
  const w = sim.greeterWaiting;
  for (let i = w.length - 1; i >= 0; i--) {
    const gr = w[i], arr = sim.rpOf.get(gr.g.party);
    if (arr) { arr.greeterParty = gr; gr.meets = arr; w.splice(i, 1); }
  }
}
defStage('G_WALK', Z.HALL, 'Coming to meet someone', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  const rp = a.party, G = GEO[a.term];
  const due = rp.g.party.leaveAt + 15 * 60;
  // Early greeters go for a coffee first.
  if (due - t > 25 * 60 && R() < 0.35) {
    const o = chooseOutlet(a, t, a.term + '.hall', true);
    if (o) { a.outlet = o; a.stage = ST.G_TO_CAFE; setPath(a, [{ x: o.entry.x, y: o.entry.y - 3 }]); return; }
  }
  a.stage = ST.G_WAIT; setPath(a, [randIn(G.greet, 2)]);
});
defStage('G_TO_CAFE', Z.HALL, 'Getting a coffee while they wait', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  if (outletArrive(a, t, true) === true) a.stage = ST.G_CAFE;
  else { a.outlet = null; a.stage = ST.G_WAIT; setPath(a, [randIn(GEO[a.term].greet, 2)]); }
});
defStage('G_CAFE', Z.HALL, 'In a café', (a, dt, t) => {
  if (!pathDone(a)) walkPath(a, a.v * dt * 0.5);
  const due = a.party.g.party.leaveAt + 10 * 60;
  if (t >= a.outletUntil || t >= due) {
    if (a.outlet) outletLeave(a, t);
    a.outlet = null;
    a.stage = ST.G_WAIT; setPath(a, [randIn(GEO[a.term].greet, 2)]);
  }
});
defStage('G_WAIT', Z.HALL, 'Waiting at the arrivals rail', (a, dt, t) => {
  if (!pathDone(a)) { if (walkPath(a, a.v * dt)) a.sleep = t + 600; return; }
  const rp = a.party;
  // If the party never shows (missed connection, very long delay), go home after two hours.
  if (!rp.joined && t > rp.g.spawn + 4 * 3600) {
    rp.done = true; a.stage = DONE; sim.counts.grtDone += rp.size;
    for (const m of rp.members) m.stage = DONE;
    if (rp.carpark) carparkCarLeaves(rp.carpark, t + 180, a.term);
  }
});

/* ---- staff ---- */
function staffWorkplace(s) {
  const G = GEO[s.term];
  if (!s.airside) {
    const r = R();
    if (r < 0.4) return randIn(G.hall, 6);
    if (r < 0.7) return randIn(G.arrHall, 4);
    return randIn(G.food, 2);
  }
  const r = R();
  if (r < 0.35) { const g = G.gates[Math.floor(R() * G.gates.length)]; return { x: g.plane.x + jit(10), y: g.plane.y + jit(10) }; }
  if (r < 0.65) { const o = OUTLETS.filter(x => x.term === s.term && x.side === 'air'); const pick = o[Math.floor(R() * o.length)]; return randIn(pick.rect, 1); }
  return randIn(G.air, 4);
}
function startStaff(s, t) {
  const rp = { g: s, kind: KIND.STF, persona: 'leisure', size: 1, term: s.term, members: [], leader: null };
  const cp = CARPARKS.staff;
  if (s.arrive == null) {
    // Night shift going home this morning.
    later(Math.max(t, s.leave), () => {
      const p = staffWorkplace(s);
      const a = spawnMembers(rp, KIND.STF, p.x, p.y, ST.S_HOME)[0];
      a.term = s.term; a.v = s.v;
      sim.staff.onDuty--;
      setStaffHome(a);
    });
    return;
  }
  carparkCarArrives('staff', t, null);
  later(Math.max(t, s.arrive), () => {
    const a = spawnMembers(rp, KIND.STF, cp.ped.arr.x + jit(40), cp.ped.arr.y + jit(4), ST.S_WALK)[0];
    a.term = s.term; a.v = s.v;
    if (s.airside) {
      STAFF_SEARCH.snake.slot(sim.staff.q.length, tmp);
      setPath(a, [{ x: STAFF_SEARCH.footX + jit(3), y: 1470 }, { x: STAFF_SEARCH.footX + jit(3), y: 660 }, { x: tmp.x, y: tmp.y }]);
    } else {
      const G = GEO[s.term], door = G.doors[1];
      setPath(a, [{ x: STAFF_SEARCH.footX + jit(3), y: 1470 }, { x: STAFF_SEARCH.footX + jit(3), y: Y.footDep }, { x: door.x, y: Y.footDep }, { x: door.x, y: door.y - 10 }, staffWorkplace(s)]);
      a.landside = true;
    }
  });
}
function setStaffHome(a) {
  const s = a.party.g, G = GEO[s.term];
  const pts = [];
  if (s.airside) pts.push({ x: G.air.x + G.air.w / 2, y: AIRSIDE_LINK.y + 10 }, { x: STAFF_SEARCH.footX, y: AIRSIDE_LINK.y + 10 }, { x: STAFF_SEARCH.footX, y: STAFF_SEARCH.y - 4 });
  else pts.push({ x: G.doors[1].x, y: G.doors[1].y - 6 }, { x: G.doors[1].x, y: Y.footDep });
  pts.push({ x: STAFF_SEARCH.footX + jit(3), y: STAFF_SEARCH.y + STAFF_SEARCH.h + 6 }, { x: STAFF_SEARCH.footX + jit(3), y: 1478 });
  setPath(a, pts);
  a.stage = ST.S_HOME;
}
defStage('S_WALK', Z.STAFF, 'Staff arriving for a shift', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  if (a.landside) { startWork(a, t); return; }
  sim.staff.q.push(a); a.qJoin = t; a.stage = ST.S_SEARCH_Q;
});
defStage('S_SEARCH_Q', Z.STAFF, 'Staff search queue', (a, dt) => {
  STAFF_SEARCH.snake.slot(sim.staff.q.rank(a), tmp);
  approach(a, tmp.x, tmp.y, a.v * dt * 0.85);
});
defStage('S_SEARCH_SVC', Z.STAFF, 'Staff search', (a, dt, t) => {
  const L = a.lane;
  const at = approach(a, L.x, L.y + 10, a.v * dt);
  if (!at || t < a.svcEnd) return;
  L.flash = t;
  const s = a.party.g, G = GEO[s.term];
  a.stage = ST.S_TO_WORK;
  setPath(a, [{ x: L.x, y: STAFF_SEARCH.y - 4 }, { x: STAFF_SEARCH.footX, y: AIRSIDE_LINK.y + 10 }, { x: G.air.x + G.air.w / 2 + jit(30), y: AIRSIDE_LINK.y + 10 }, staffWorkplace(s)]);
});
defStage('S_TO_WORK', Z.STAFF, 'Staff heading to work', (a, dt, t) => {
  if (walkPath(a, a.v * dt)) startWork(a, t);
});
function startWork(a, t) {
  a.stage = ST.S_WORK; a.hidden = true; a.wakeAt = a.party.g.leave; sim.staff.onDuty++;
}
defStage('S_WORK', Z.STAFF, 'At work', (a, dt, t) => {
  if (t < a.party.g.leave) return;
  a.hidden = false; sim.staff.onDuty--;
  setStaffHome(a);
});
defStage('S_HOME', Z.STAFF, 'Staff going home', (a, dt, t) => {
  if (!walkPath(a, a.v * dt)) return;
  a.stage = DONE; sim.counts.stfDone++;
  carparkCarLeaves('staff', t + 60, null);
});
