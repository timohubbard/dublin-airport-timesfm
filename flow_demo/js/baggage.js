'use strict';
/* ====================================================================
   Baggage. Departing bags: check-in desk → collector belt → shaft down
   to the basement → hold-baggage screening (levels 1-3) → sorter →
   make-up lateral for the flight (or the early-bag store) → carts → tug
   through the service tunnel to the aircraft. Arriving bags: handler team
   unloads → carts → tunnel → carousel, where owners collect them.
   All rates and times are illustrative.
   ==================================================================== */
const TUG_SPEED = 8;
function baggageReset() {
  sim.bags = { moving: [], belt: [], tugs: [], stats: { checked: 0, screened: 0, l2: 0, l3: 0, loaded: 0, short: 0, arrived: 0, claimed: 0 } };
  for (const k of TERMS) {
    const G = GEO[k];
    sim.bags[k] = {
      hbsQ: [], hbs: G.hbs.map(h => ({ ...h, busy: 0 })), ebs: new Map(), held: [],
      laterals: G.laterals.map(l => ({ ...l, flights: [] })), teamsFree: BAGS.teams[k], teamQ: [],
    };
  }
}
/* ---- departures ---- */
function baggageCheckIn(a, t) {
  const g = a.party.g; if (a.leader || !g.bags) return;
  const G = GEO[a.term], desk = a.desk;
  for (let i = 0; i < g.bags; i++) {
    const path = new Polyline([{ x: desk.x, y: Y.desk + 8 }, { x: G.shaftX, y: Y.desk + 8 }, { x: G.shaftX, y: Y.base + 14 }, { x: G.hbs[0].x - 14, y: Y.base + 14 }]);
    sim.bags.moving.push({ f: g.f, term: a.term, path, s: -i * 1.6, v: BAGS.belt, next: 'hbs', x: desk.x, y: Y.desk + 8, color: 0 });
    sim.bags.stats.checked++;
  }
}
function sorterPath(G, lat, fromX) {
  return new Polyline([{ x: fromX, y: Y.base + 26 }, { x: G.base.x + 140, y: 1268 }, { x: lat.x + lat.w / 2, y: 1268 }, { x: lat.x + lat.w / 2, y: lat.y + 6 }]);
}
function bagToLateral(b, t) {
  const f = b.f, bk = sim.bags[b.term];
  if (t > f.dep - BAGS.shortShip) { f.shortShipped++; sim.bags.stats.short++; return; }
  if (f.lateral) { f.bagsIn++; return; }
  bk.ebs.set(f, (bk.ebs.get(f) || 0) + 1);
}
function launchTug(term, from, to, n, color, onArrive) {
  const pts = [from, ...to];
  const path = new Polyline(pts);
  sim.bags.tugs.push({ term, path, s: 0, n, color, onArrive, x: from.x, y: from.y, ang: 0 });
}
function depTug(f, n) {
  const G = GEO[f.term], lat = f.lateral, gate = f.gate;
  launchTug(f.term, { x: lat.x + lat.w / 2, y: lat.y + lat.h }, [
    { x: G.tunnelX, y: lat.y + lat.h + 4 }, { x: G.tunnelX, y: 470 }, { x: gate.plane.x, y: 470 }, { x: gate.plane.x * 0.5 + gate.door.x * 0.5, y: gate.plane.y * 0.5 + gate.door.y * 0.5 },
  ], n, 0, () => { f.bagsLoaded += n; sim.bags.stats.loaded += n; });
}
/* ---- arrivals ---- */
function baggageOnBlock(af, t) {
  if (!af.bags || !af.gate) return;
  const bk = sim.bags[af.term];
  if (bk.teamsFree > 0) { bk.teamsFree--; startUnload(af, t); }
  else bk.teamQ.push(af);
}
function startUnload(af, t) {
  const owners = [];
  for (const g of gen.arrParties) if (g.af === af && g.kind === KIND.ARR) for (let i = 0; i < g.bags; i++) owners.push(g);
  for (let i = owners.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [owners[i], owners[j]] = [owners[j], owners[i]]; }
  const G = GEO[af.term], bk = sim.bags[af.term];
  // Carousel: large belts for widebodies; at most two flights per belt.
  const pool = G.carousels.filter(c => !af.wide || c.large);
  const load = c => sim.bags.belt.filter(b => b.c === c && !b.claimed).length + c.flights.length * 40;
  const car = pool.reduce((best, c) => (c.flights.length < 2 && (!best || load(c) < load(best)) ? c : best), null) || pool[0];
  car.flights.push(af); af.carousel = car;
  let at = Math.max(t, af.onBlock) + U(BAGS.firstCart[0], BAGS.firstCart[1]) * 60 + (af.wide ? 180 : 0);
  const nCarts = Math.ceil(owners.length / BAGS.cartSize);
  for (let c = 0; c < nCarts; c++) {
    const batch = owners.slice(c * BAGS.cartSize, (c + 1) * BAGS.cartSize);
    const arriveAt = at, gate = af.gate;
    const from = { x: gate.plane.x * 0.5 + gate.door.x * 0.5, y: gate.plane.y * 0.5 + gate.door.y * 0.5 };
    const to = [{ x: gate.plane.x, y: 470 }, { x: G.tunnelX, y: 470 }, { x: G.tunnelX, y: car.y }, { x: car.feed.x, y: car.y }];
    const travel = polyLen([from, ...to]) / TUG_SPEED;
    later(arriveAt - travel, () => launchTug(af.term, from, to, batch.length, 1, () => {}));
    batch.forEach((owner, j) => later(arriveAt + j * 3, tt => {
      sim.bags.belt.push({ c: car, owner, af, s: 0, onAt: tt, pickAt: 0, claimed: false });
      af.bagsOnBelt++; sim.bags.stats.arrived++;
      if (!af.firstBag) af.firstBag = tt;
      af.lastBag = tt;
    }));
    at += U(BAGS.cartGap[0], BAGS.cartGap[1]) * 60;
  }
  later(at + 300, tt => {
    car.flights = car.flights.filter(x => x !== af);
    bk.teamsFree++;
    const next = bk.teamQ.shift();
    if (next) { bk.teamsFree--; startUnload(next, tt); }
  });
}

function baggageUpdate(t0, t, dt) {
  const B = sim.bags;
  // Bags moving on belts.
  let w = 0;
  for (let i = 0; i < B.moving.length; i++) {
    const b = B.moving[i];
    b.s += b.v * dt;
    if (b.s < 0) { B.moving[w++] = b; continue; }
    if (b.s >= b.path.len) {
      if (b.next === 'hbs') { sim.bags[b.term].hbsQ.push(b); continue; }
      if (b.next === 'lateral') { bagToLateral(b, t); continue; }
    }
    b.path.at(b.s, 0, b); B.moving[w++] = b;
  }
  B.moving.length = w;
  for (const k of TERMS) {
    const bk = sim.bags[k], G = GEO[k];
    // Hold-baggage screening.
    for (const m of bk.hbs) {
      while (bk.hbsQ.length && m.busy <= t) {
        const b = bk.hbsQ.shift();
        m.busy = Math.max(m.busy, t0) + 3600 / BAGS.hbsRate;
        B.stats.screened++;
        const r = R();
        let release = m.busy;
        if (r < BAGS.l3) { release += U(BAGS.l3s[0], BAGS.l3s[1]); B.stats.l3++; b.color = 2; }
        else if (r < BAGS.l3 + BAGS.l2) { release += U(BAGS.l2s[0], BAGS.l2s[1]); B.stats.l2++; b.color = 1; }
        bk.held.push({ b, at: release, mx: m.x });
      }
    }
    for (let i = bk.held.length - 1; i >= 0; i--) {
      const h = bk.held[i];
      if (h.at > t) continue;
      bk.held.splice(i, 1);
      const b = h.b, f = b.f;
      const lat = f.lateral || bk.laterals[f.id % bk.laterals.length];
      b.path = sorterPath(G, lat, h.mx); b.s = 0; b.v = BAGS.belt; b.next = 'lateral'; b.color = Math.min(b.color, 1);
      B.moving.push(b);
    }
  }
  // Laterals open 150 min before departure; carts leave when full and 35 min before.
  for (const f of gen.flights) {
    if (f.dep - BAGS.lateralOpen > t || f.dep + 600 < t0 || !f.bags) continue;
    const bk = sim.bags[f.term];
    if (!f.lateral && t < f.dep) {
      const lat = bk.laterals.reduce((best, l) => (!best || l.flights.length < best.flights.length ? l : best), null);
      f.lateral = lat; lat.flights.push(f);
      const early = bk.ebs.get(f) || 0;
      if (early) { f.bagsIn += early; bk.ebs.delete(f); }
    }
    if (!f.lateral) continue;
    while (f.bagsIn >= BAGS.cartSize) { f.bagsIn -= BAGS.cartSize; depTug(f, BAGS.cartSize); }
    if (t >= f.dep - BAGS.lastCart && !f.lastCartGone) {
      f.lastCartGone = true;
      if (f.bagsIn > 0) { depTug(f, f.bagsIn); f.bagsIn = 0; }
    }
    if (t >= f.dep && f.lateral) { f.lateral.flights = f.lateral.flights.filter(x => x !== f); f.lateral = null; }
  }
  // Tugs.
  w = 0;
  for (let i = 0; i < B.tugs.length; i++) {
    const g = B.tugs[i];
    g.s += TUG_SPEED * dt;
    if (g.s >= g.path.len) { g.onArrive(); continue; }
    g.path.at(g.s, 0, g); B.tugs[w++] = g;
  }
  B.tugs.length = w;
  // Carousels: bags go round until their owner picks them up.
  w = 0;
  for (let i = 0; i < B.belt.length; i++) {
    const b = B.belt[i];
    b.s += BAGS.beltSpeed * dt;
    const rp = sim.rpOf.get(b.owner), L = rp && rp.leader;
    if (L && L.stage === ST.A_RECLAIM && L.atCar === b.c && pathDone(L)) {
      if (!b.pickAt) b.pickAt = Math.max(t, b.onAt) + U(BAGS.pickup[0], BAGS.pickup[1]);
      if (t >= b.pickAt) { rp.bagsGot++; b.af.bagsClaimed++; B.stats.claimed++; continue; }
    }
    B.belt[w++] = b;
  }
  B.belt.length = w;
}
