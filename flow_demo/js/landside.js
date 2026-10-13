'use strict';
/* ====================================================================
   Landside: roads with simple car-following, kerb drop-off, car parks
   that carry cars over from earlier days, the taxi rank fed from a
   holding area, public buses on timetables, and the Holiday Blue and
   car-hire shuttles. Vehicles queue when the kerb or a bay is full.
   ==================================================================== */
const VEH = {
  car: { len: 4.5, color: '#94a3b8' }, greeter: { len: 4.5, color: '#cbd5e1' }, staff: { len: 4.5, color: '#64748b' },
  taxi: { len: 4.5, color: '#facc15' }, bus: { len: 12, color: '#22c55e' }, hb: { len: 10, color: '#3b82f6' }, rental: { len: 10, color: '#a855f7' },
};
const LEG = (link, s0, s1) => ({ link, s0, s1: s1 ?? ROADS[link].len });
const fromEnd = west => west ? [LEG('ringE', 0, J.ringE_wr1)] : [LEG('ringW', 0, J.ringW_wr1)];
const toEnd = west => west ? [LEG('ringW', J.er2_ringW)] : [LEG('ringE', J.er2_ringE)];
const UPPER = () => [LEG('wr1', 0), LEG('wr2', 0), LEG('up', 0), LEG('er1', 0), LEG('er2', 0)];
const ROAD_ORDER = ['t2', 't1'];   // T2 comes first along both roads
const LOWER = () => [LEG('wr1', 0), LEG('low', 0), LEG('er2', 0)];

function landsideReset() {
  sim.links = Object.fromEntries(Object.keys(ROADS).map(k => [k, { poly: ROADS[k], veh: [] }]));
  sim.vehicles = []; sim.vehDone = 0;
  for (const k of TERMS) for (const list of Object.values(GEO[k].bays)) for (const b of list) b.veh = null;
  const cps = gen.day.landside ? gen.day.landside.carparks : null;
  sim.carparks = {};
  for (const [id, cp] of Object.entries(CARPARKS)) {
    if (id === 'rental') continue;
    const cap = CARPARK_CAP[id] || 1000;
    const occ0 = cps && cps[id] ? cps[id].occ0 : Math.round(cap * ({ cpa_t1: 0.55, surf_t2: 0.5, dropgo: 0.05, staff: 0.18, hb: 0.75, st_t1: 0.35, st_t2: 0.3 }[id] || 0.3));
    sim.carparks[id] = { id, name: cp.name, cap, occ: occ0, occ0, in: 0, out: 0, turned: 0 };
  }
  sim.taxi = { holding: 60, q: { t1: new Queue(), t2: new Queue() }, supplied: 0, rejoined: 0, out: 0, waitSum: 0, waits: 0, peakWait: 0, idleSum: 0 };
  sim.stops = { bus: { t1: [], t2: [] }, hb: { t1: [], t2: [] }, rental: { t1: [], t2: [] } };
  sim.busPending = { t1: [], t2: [] };
  sim.hbWaiting = []; sim.rentalWaiting = [];
  sim.lsStats = { kerbDrops: 0, busLeftBehind: 0, busRuns: 0, shuttleRuns: 0, turnedAway: 0 };
  sim.nextBus = BUSES.map(b => b.from * 3600 + R() * b.headway * 60);
  sim.nextHb = DAY_START + 120; sim.nextRental = DAY_START + 300; sim.nextTaxiSupply = DAY_START;
}

/* ---- vehicles ---- */
let vehSeq = 0;
function addVehicle(type, legs, props = {}) {
  const v = { id: ++vehSeq, type, len: VEH[type].len, color: VEH[type].color, legs, li: 0, s: legs[0].s0, state: 'wait', bay: null,
    stops: [], x: 0, y: 0, ang: 0, onEnd: null, pax: 0, cap: 0, parties: [], born: sim.t, ...props };
  sim.vehicles.push(v);
  tryEnter(v);
  return v;
}
function linkOf(v) { return sim.links[v.legs[v.li].link]; }
function insertSorted(list, v) {
  let i = 0; while (i < list.length && list[i].s > v.s) i++;
  list.splice(i, 0, v);
}
function gapFree(list, s, len) {
  // list is sorted by position, front first: skip those well ahead, stop once well behind.
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.s - o.len >= s + 3) continue;
    if (o.s <= s - len - 3) return true;
    return false;
  }
  return true;
}
function tryEnter(v) {
  const leg = v.legs[v.li], lk = sim.links[leg.link];
  if (leg.s0 === 0 && (leg.link === 'ringE' || leg.link === 'ringW')) {
    // Arriving from the city: queue off the edge of the map rather than blocking.
    const tail = lk.veh[lk.veh.length - 1];
    v.s = tail ? Math.min(0, tail.s - tail.len - 3) : 0;
    lk.veh.push(v); v.state = 'drive'; lk.poly.at(Math.max(0, v.s), 0, v);
    return true;
  }
  if (!gapFree(lk.veh, leg.s0, v.len)) { v.state = 'wait'; return false; }
  v.s = leg.s0; insertSorted(lk.veh, v); v.state = 'drive';
  lk.poly.at(v.s, 0, v);
  return true;
}
function forceEnter(v) {
  const leg = v.legs[v.li], lk = sim.links[leg.link];
  v.s = leg.s0; insertSorted(lk.veh, v); v.state = 'drive'; v.mergeWait = 0; lk.poly.at(v.s, 0, v);
}
function removeFrom(lk, v) { const i = lk.veh.indexOf(v); if (i >= 0) lk.veh.splice(i, 1); }

/* Stops: kerb slots, bus bays, taxi rank bays. A vehicle reserves a free
   bay ahead of it as it nears the zone; with none free it waits at the
   start of the zone and blocks the traffic behind. */
function stopTarget(v, reach) {
  const st = v.stops[0];
  if (!st || st.link !== v.legs[v.li].link || v.circleLi === v.li) return Infinity;
  if (v.bay) return v.bay.s;
  const last = st.bays[st.bays.length - 1].s;
  if (v.s >= st.s - 80) {
    // Only bays this vehicle can actually reach (not past a stopped vehicle ahead).
    let best = null, bestK = Infinity;
    for (const b of st.bays) {
      if (b.veh || b.s < v.s + 1 || b.s > reach) continue;
      const key = st.prefer ? Math.abs(b.x - st.prefer) : b.s;
      if (key < bestK) { bestK = key; best = b; }
    }
    if (best) { v.bay = best; best.veh = v; return best.s; }
    // Keep moving along the kerb looking for a space; at the end, buses skip and everyone else goes round again.
    if (v.s < last - 1) return Infinity;
    if (st.optional) { v.stops.shift(); return Infinity; }
    circle(v, st.link);
    return Infinity;
  }
  return Infinity;
}
/* No space at the kerb or bay: drive round the loop and try again. */
function circle(v, link) {
  const loop = link === 'up'
    ? [LEG('er1', 0), LEG('er2', 0), LEG('ringW', J.er2_ringW, J.ringW_wr1), LEG('wr1', 0), LEG('wr2', 0), LEG('up', 0)]
    : [LEG('er2', 0), LEG('ringW', J.er2_ringW, J.ringW_wr1), LEG('wr1', 0), LEG('low', 0)];
  // Finish this road, go round the loop, then carry on with the original route.
  v.legs = [...v.legs.slice(0, v.li + 1), ...loop, ...v.legs.slice(v.li + 1)];
  v.circleLi = v.li;
  sim.lsStats.circled = (sim.lsStats.circled || 0) + 1;
}
function landsideUpdate(t0, t, dt) {
  spawnLandsideTraffic(t);
  // Roads run in short substeps so merges and kerb pull-ins keep a realistic throughput.
  const n = Math.max(1, Math.ceil(dt / 1.5));
  for (let i = 1; i <= n; i++) roadStep(t0 + (t - t0) * i / n, dt / n);
  taxiDispatch(t);
  // Departing bus riders whose bus never came (at night) walk in from the stop.
  for (const k of TERMS) {
    const P = sim.busPending[k];
    while (P.length && P[0].g.spawn < t - 1200) { const rp = P.shift(); const b = GEO[k].bays.depBus[0]; depArrive(rp, b.x, Y.footDep, t); }
  }
}
function roadStep(t, dt) {
  // Drive every link, leader first.
  for (const lk of Object.values(sim.links)) {
    let leadS = Infinity, leadLen = 0;
    for (let i = 0; i < lk.veh.length; i++) {
      const v = lk.veh[i], leg = v.legs[v.li];
      const reach = leadS - leadLen - 2.5;
      const target = Math.min(leg.s1, stopTarget(v, reach), reach);
      v.s = Math.max(v.s, Math.min(v.s + ROAD_VMAX * dt, target));
      leadS = v.s; leadLen = v.len;
      lk.poly.at(Math.max(0, v.s), 0, v);
    }
  }
  // Arrivals at bays and leg ends.
  for (const v of sim.vehicles) {
    if (v.state === 'drive') {
      const leg = v.legs[v.li], lk = sim.links[leg.link];
      if (v.bay && v.stops[0] && v.stops[0].link === leg.link && v.s >= v.bay.s - 0.3) {
        removeFrom(lk, v); v.state = 'bay'; v.x = v.bay.x; v.y = v.bay.y; v.ang = 0;
        v.dwellUntil = Infinity; v.ready = false;
        v.stops[0].onArrive(v, v.bay, t);
        continue;
      }
      if (v.s >= leg.s1 - 0.05) {
        if (v.li === v.legs.length - 1) { removeFrom(lk, v); v.state = 'done'; sim.vehDone++; if (v.onEnd) v.onEnd(v, t); continue; }
        // Merge onto the next link only when there is a gap; otherwise hold at the end of this one.
        // Zipper merge: take a gap if there is one, and force in after a short wait.
        const nleg = v.legs[v.li + 1], nl = sim.links[nleg.link];
        v.mergeWait = (v.mergeWait || 0) + dt;
        if (gapFree(nl.veh, nleg.s0, v.len) || v.mergeWait > 0.8) {
          v.mergeWait = 0;
          removeFrom(lk, v); v.li++; v.s = nleg.s0; insertSorted(nl.veh, v); nl.poly.at(v.s, 0, v);
        }
      }
    } else if (v.state === 'bay') {
      if (!v.ready || t < v.dwellUntil) continue;
      const lk = linkOf(v);
      v.mergeWait = (v.mergeWait || 0) + dt;
      if (gapFree(lk.veh, v.bay.s, v.len + 6) || v.mergeWait > 6) {
        v.mergeWait = 0;
        v.s = v.bay.s; insertSorted(lk.veh, v); v.state = 'drive';
        if (v.bay.veh === v) v.bay.veh = null;
        v.bay = null; v.stops.shift();
      }
    } else if (v.state === 'wait') { v.mergeWait = (v.mergeWait || 0) + dt; if (v.mergeWait > 1.5) forceEnter(v); else tryEnter(v); }
  }
  if (sim.vehDone) { sim.vehicles = sim.vehicles.filter(v => v.state !== 'done'); sim.vehDone = 0; }
}

/* ---- departures: how each party reaches the terminal ---- */
function startDeparture(rp, t) {
  const g = rp.g, G = GEO[g.term], west = R() < 0.5;
  let via = g.via;
  if (via === 'dropgo' && g.term !== 't1') via = 'kerb';
  switch (via) {
    case 'kerb': case 'taxi': {
      const type = via === 'taxi' ? 'taxi' : 'car';
      const legs = [...fromEnd(west), ...UPPER(), ...(type === 'taxi' && R() < TAXI.rejoin ? [LEG('ringW', J.er2_ringW, ringS.W(TAXI_HOLDING.drive))] : toEnd(R() < 0.5))];
      const toHolding = legs[legs.length - 1].link === 'ringW' && legs[legs.length - 1].s1 === ringS.W(TAXI_HOLDING.drive);
      const v = addVehicle(type, legs, { onEnd: toHolding ? () => { sim.taxi.holding = Math.min(TAXI.holdingCap, sim.taxi.holding + 1); sim.taxi.rejoined++; } : null });
      const doorX = g.door.x;
      v.stops.push({ link: 'up', s: G.bays.kerb[0].s, bays: G.bays.kerb, prefer: doorX, onArrive: (veh, bay, tt) => {
        depArrive(rp, bay.x, Y.footDep + 2, tt); sim.lsStats.kerbDrops++;
        sim.lsStats.kerbLate = (sim.lsStats.kerbLate || 0) + Math.max(0, tt - g.spawn);
        veh.dwellUntil = tt + (type === 'taxi' ? U(KERB_DWELL.taxi[0], KERB_DWELL.taxi[1]) : U(KERB_DWELL.met[0], KERB_DWELL.met[1]) + KERB_DWELL.perBag * g.bags);
        veh.ready = true;
      } });
      return;
    }
    case 'dropgo': case 'st': {
      const id = via === 'dropgo' ? 'dropgo' : carparkFor(g.term, 'st');
      const cp = CARPARKS[id];
      carparkCarArrives(id, t, g.term, tt => {
        const p = cp.ped.dep;
        const pts = id === 'dropgo'
          ? [{ x: p.x + jit(8), y: p.y }, { x: 1240, y: 1110 }, { x: 1228, y: 820 }, { x: G.link.wall - 6, y: 820 }, { x: G.doors[2].x, y: 800 }]
          : [{ x: p.x + jit(4), y: p.y + jit(6) }, { x: G.link.wall + (G.id === 't2' ? 6 : -6), y: 820 + jit(4) }, { x: G.doors[G.id === 't2' ? 0 : 2].x + jit(10), y: 800 }];
        later(tt + 60, t2 => depArriveVia(rp, pts, t2));
        if (id === 'dropgo') carparkCarLeaves('dropgo', tt + U(300, 600), null);
      });
      return;
    }
    case 'hb': case 'rental': {
      const id = via, cp = CARPARKS[id];
      const arrive = tt => {
        const p = cp.ped.dep;
        spawnMembers(rp, KIND.DEP, p.x + jit(20), p.y + jit(4), ST.D_WAIT_SHUTTLE, a => setupDepMember(a, g));
        (id === 'hb' ? sim.hbWaiting : sim.rentalWaiting).push(rp);
        rp.waitSince = tt;
      };
      if (id === 'hb') carparkCarArrives('hb', t, g.term, arrive);
      else carTrip(cp.drive, t, arrive, 'car');
      return;
    }
    case 'bus': sim.busPending[g.term].push(rp); return;
  }
}
defStage('D_WAIT_SHUTTLE', Z.GROUND, 'Waiting for the shuttle', (a, dt, t) => { checkMissed(a, t); });

/* ---- car parks ---- */
function carparkFor(term, kind) {
  if (kind === 'st') {
    const main = term === 't1' ? 'st_t1' : 'st_t2', over = term === 't1' ? 'cpa_t1' : 'surf_t2';
    if (sim.carparks[main].occ < sim.carparks[main].cap) return main;
    if (sim.carparks[over].occ < sim.carparks[over].cap) return over;
    sim.carparks[main].turned++; sim.lsStats.turnedAway++;
    return main;
  }
  return kind;
}
function carTrip(driveX, t, onArrive, type) {
  const west = R() < 0.5;
  const legs = west ? [LEG('ringE', 0, ringS.E(driveX))] : [LEG('ringW', 0, ringS.W(driveX))];
  addVehicle(type, legs, { onEnd: (v, tt) => onArrive(tt) });
}
function carparkCarArrives(id, t, term, onArrive) {
  const cp = CARPARKS[id], c = sim.carparks[id];
  if (id === 'staff') {
    // Staff use their own entrance from the south, off the passenger roads.
    later(t + 60, tt => { if (c.occ >= c.cap) c.turned++; else c.occ++; c.in++; if (onArrive) onArrive(tt); });
    return;
  }
  carTrip(cp.drive, t, tt => {
    if (c.occ >= c.cap) { c.turned++; if (id === 'hb') sim.lsStats.turnedAway++; }
    else c.occ++;
    c.in++;
    if (onArrive) onArrive(tt);
  }, id === 'staff' ? 'staff' : 'car');
}
function carparkCarLeaves(id, at, term) {
  later(at, t => {
    const cp = CARPARKS[id], c = sim.carparks[id];
    if (c) { c.occ = Math.max(0, c.occ - 1); c.out++; }
    if (id === 'staff') return;
    const west = R() < 0.5;
    const legs = west ? [LEG('ringW', ringS.W(cp.drive))] : [LEG('ringE', ringS.E(cp.drive))];
    addVehicle(id === 'staff' ? 'staff' : 'car', legs);
  });
}

/* ---- taxis ---- */
function taxiDispatch(t) {
  const T = sim.taxi;
  // New taxis called in to the holding area, at the rostered rate.
  if (T.nextSupply == null) T.nextSupply = t;
  while (T.nextSupply <= t) {
    let rate = 0;
    for (const k of TERMS) {
      // Dispatcher surge per rank, as in the outlook model.
      const ql = T.q[k].length;
      T.surge = T.surge || {};
      T.surge[k] = T.surge[k] ? ql > TAXI.surgeOff : ql > TAXI.surgeOn;
      rate += plans.taxi[k][slotOf(T.nextSupply)] * (T.surge[k] ? TAXI.surgeX : 1);
    }
    const perMin = rate * taxiSupplyFactor() / 30;
    // Only call taxis in while the holding area has room.
    if (perMin > 0 && T.holding + (T.inbound || 0) < TAXI.holdingCap) {
      const west = R() < 0.5;
      T.inbound = (T.inbound || 0) + 1;
      addVehicle('taxi', west ? [LEG('ringE', 0, ringS.E(TAXI_HOLDING.drive))] : [LEG('ringW', 0, ringS.W(TAXI_HOLDING.drive))],
        { onEnd: () => { T.inbound--; T.holding = Math.min(TAXI.holdingCap, T.holding + 1); T.supplied++; } });
    }
    T.nextSupply += perMin > 0 ? 60 / perMin * (0.5 + R()) : 600;
  }
  for (const k of TERMS) {
    const G = GEO[k], bays = G.bays.rank, q = T.q[k];
    const free = bays.filter(b => !b.veh);
    const idle = bays.filter(b => b.veh && !b.veh.claimed).length;
    // Taxis come up the feeder lane from the holding area; keep the rank stocked while people queue.
    const want = Math.min(free.length, Math.max(0, q.length - idle) + (idle < 3 ? 3 - idle : 0));
    for (let i = 0; i < want && T.holding > 0; i++) {
      const bay = free[i];
      T.holding--;
      const v = addVehicle('taxi', [LEG('low', Math.max(0, bays[0].s - 14)), LEG('er2', 0), ...toEnd(R() < 0.5)]);
      v.bay = bay; bay.veh = v; v.term = k;
      v.stops.push({ link: 'low', s: bay.s, bays: [bay], onArrive: (veh, b, tt) => { veh.atRank = tt; } });
    }
    // Board the head of the queue into a waiting taxi.
    while (q.length) {
      const taxi = bays.map(b => b.veh).find(v => v && v.state === 'bay' && !v.claimed);
      if (!taxi) break;
      const a = q.shift();
      taxi.claimed = true; a.taxi = taxi; a.stage = ST.A_TO_TAXI;
      setPath(a, [{ x: taxi.x, y: Y.footArr + 4 }, { x: taxi.x, y: taxi.y - 3 }]);
      const w = t - a.qJoin; T.waitSum += w; T.waits++; T.peakWait = Math.max(T.peakWait, w);
      T.idleSum += t - (taxi.atRank || t);
    }
  }
}
function taxiDeparts(v, t) { if (!v) return; v.ready = true; v.dwellUntil = t; sim.taxi.out++; }

/* ---- buses and shuttles ---- */
function spawnLandsideTraffic(t) {
  BUSES.forEach((b, i) => {
    while (sim.nextBus[i] <= t) {
      const at = sim.nextBus[i];
      sim.nextBus[i] += b.headway * 60 * (0.9 + R() * 0.2);
      if (at / 3600 < b.from || at / 3600 > b.to) { if (at / 3600 > b.to) sim.nextBus[i] = Infinity; continue; }
      launchBus(b, R() < 0.5);
    }
  });
  if (t >= sim.nextHb) {
    const perHour = plans.shuttle[slotOf(t)];
    sim.nextHb = t + 3600 / Math.max(1, perHour);
    launchShuttle('hb');
  }
  if (t >= sim.nextRental) { sim.nextRental = t + RENTAL.shuttleHeadway * 60; launchShuttle('rental'); }
}
function depBayStop(term, vehicle, onArrive, optional = true) {
  const G = GEO[term];
  return { link: 'up', s: G.bays.depBus[0].s, bays: G.bays.depBus, optional, onArrive };
}
function arrBayStop(term, kind, onArrive, optional = true) {
  const G = GEO[term], bays = kind === 'bus' ? G.bays.arrBus : G.bays.arrShuttle;
  return { link: 'low', s: bays[0].s, bays, optional, onArrive };
}
function launchBus(b, west) {
  sim.lsStats.busRuns++;
  const legs = [...fromEnd(west), ...UPPER(), LEG('ringW', J.er2_ringW, J.ringW_wr1), ...LOWER(), ...toEnd(R() < 0.5)];
  const v = addVehicle('bus', legs, { cap: b.cap, pax: Math.floor(R() * b.cap * 0.3), route: b });
  v.color = b.color;
  for (const k of ROAD_ORDER) v.stops.push(depBayStop(k, v, (veh, bay, tt) => {
    const P = sim.busPending[k];
    let n = 0;
    while (P.length && P[0].g.spawn <= tt + 900 && n < 70) { const rp = P.shift(); n += rp.size; depArrive(rp, bay.x, Y.footDep + 2, tt); }
    veh.pax = Math.max(0, veh.pax - Math.floor(veh.pax * 0.4));
    veh.dwellUntil = tt + 30 + 2 * n; veh.ready = true;
  }));
  for (const k of ROAD_ORDER) v.stops.push(arrBayStop(k, 'bus', (veh, bay, tt) => {
    const n = boardStop(sim.stops.bus[k], veh, tt, 'bus');
    veh.dwellUntil = tt + 30 + 2 * n; veh.ready = true;
  }));
}
function boardStop(list, veh, t, mode) {
  let n = 0;
  while (list.length && veh.pax + list[0].party.size <= veh.cap) {
    const a = list.shift(); n += a.party.size; veh.pax += a.party.size;
    a.party.exitMode = a.party.exitMode || mode;
    if (mode === 'holiday_blue') carparkCarLeaves('hb', t + 600 + R() * 300, null);
    if (mode === 'rental') carTripOut(CARPARKS.rental.drive, t + 600 + R() * 300);
    finishArr(a, t);
  }
  if (list.length && mode === 'bus') sim.lsStats.busLeftBehind += list.length;
  return n;
}
function carTripOut(driveX, at) {
  later(at, () => { const west = R() < 0.5; addVehicle('car', west ? [LEG('ringW', ringS.W(driveX))] : [LEG('ringE', ringS.E(driveX))]); });
}
function launchShuttle(kind) {
  sim.lsStats.shuttleRuns++;
  const cp = CARPARKS[kind], driveX = cp.drive;
  const legs = [LEG('ringW', ringS.W(driveX), J.ringW_wr1), ...UPPER(), LEG('ringW', J.er2_ringW, J.ringW_wr1), ...LOWER(), kind === 'hb' ? LEG('ringE', J.er2_ringE, ringS.E(driveX)) : LEG('ringW', J.er2_ringW, ringS.W(driveX))];
  const cap = kind === 'hb' ? HB_SHUTTLE.cap : RENTAL.shuttleCap;
  const v = addVehicle(kind, legs, { cap, pax: 0 });
  // Pick up departing passengers waiting at the car park stop.
  const waiting = kind === 'hb' ? sim.hbWaiting : sim.rentalWaiting;
  const riders = { t1: [], t2: [] };
  while (waiting.length && v.pax + waiting[0].size <= cap) {
    const rp = waiting.shift();
    for (const m of rp.members) m.stage = DONE;
    rp.members = []; riders[rp.term].push(rp); v.pax += rp.size;
  }
  for (const k of ROAD_ORDER) v.stops.push(depBayStop(k, v, (veh, bay, tt) => {
    for (const rp of riders[k]) { depArrive(rp, bay.x, Y.footDep + 2, tt); veh.pax -= rp.size; }
    riders[k] = [];
    veh.dwellUntil = tt + 25; veh.ready = true;
  }, riders[k].length === 0));
  for (const k of ROAD_ORDER) v.stops.push(arrBayStop(k, 'shuttle', (veh, bay, tt) => {
    const n = boardStop(sim.stops[kind][k], veh, tt, kind === 'hb' ? 'holiday_blue' : 'rental');
    veh.dwellUntil = tt + 25 + 2 * n; veh.ready = true;
  }, false));
}
