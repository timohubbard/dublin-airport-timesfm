'use strict';
/* ====================================================================
   Shops, food and lounges. Each outlet has a capacity (seats or browsing
   space), a short queue at the door, and a dwell time by category. Party
   leaders choose where to go from their time budget, their traveller type
   and the walking distance. The walk-through duty-free store sits right
   after security, with its own tills. Spend per transaction is invented
   and only ever shown as category totals, labelled illustrative.
   ==================================================================== */
function commerceReset() {
  sim.outlets = OUTLETS.map(o => ({ o, occ: 0, q: new Queue(), footfall: 0, tx: 0, spend: 0, dwellSum: 0, visits: 0, maxQ: 0, turned: 0 }));
  sim.spend = Object.fromEntries(Object.keys(CATS).map(c => [c, 0]));
  sim.tx = Object.fromEntries(Object.keys(CATS).map(c => [c, 0]));
  sim.df = {};
  for (const k of TERMS) {
    const r = WALK_DF[k].rect, n = DF_TILLS[k], tills = [];
    for (let i = 0; i < n; i++) tills.push({ x: r.x + 12 + i * (r.w - 24) / Math.max(1, n - 1), y: r.y + 3, busy: 0 });
    sim.df[k] = { q: new Queue(), tills, passed: 0, buyers: 0, snake: new Snake({ x0: r.x + r.w / 2 - 50, x1: r.x + r.w / 2 + 50, y0: r.y + 12, rows: 4, gap: 4, sp: 3.2, hx: r.x + r.w / 2 - 50 }) };
  }
}
const rtOutlet = o => sim.outlets[o.id];
function outletZonesFor(a, zone) {
  if (zone) return [zone];
  const k = a.term, list = [k + '.air'];
  for (const p of GEO[k].piers) list.push(p.id + '.hub');
  return list;
}
function chooseOutlet(a, t, zone, quick) {
  const rp = a.party, g = rp.g, persona = a.persona;
  const left = (a.callAt || (t + 40 * 60)) - t;
  if (left < 12 * 60) return null;
  let best = null;
  // Lounge access first for those who have it.
  if (g.lounge && !rp.lounged && !zone) {
    const lounges = outletZonesFor(a).flatMap(z => OUTLETS_BY_ZONE[z] || []).filter(o => o.cat === 'lounge');
    if (lounges.length) {
      const o = lounges[Math.floor(R() * Math.min(lounges.length, a.term === 't2' ? 2 : 1))];
      rp.lounged = true;
      return o;
    }
  }
  const zones = outletZonesFor(a, zone);
  let wsum = 1.2 + (a.visits || 0) * 1.4;
  const cands = [];
  for (const z of zones) for (const o of OUTLETS_BY_ZONE[z] || []) {
    if (o.walk || o.cat === 'service' || o.cat === 'lounge') continue;
    const cat = CATS[o.cat];
    let w = o.cat === 'seating' ? 0.25 : (cat.conv[persona] || 0) * CONV_SCALE;
    if (quick && o.cat !== 'cafe' && o.cat !== 'news') continue;
    const minDwell = (cat.dwell ? cat.dwell[0] : 5) * 60;
    if (left < minDwell + 10 * 60) continue;
    const d = Math.hypot(o.entry.x - a.x, o.entry.y - a.y);
    w *= Math.exp(-d / 350);
    if (rtOutlet(o).occ >= o.cap) w *= 0.3;
    if (w <= 0) continue;
    cands.push([o, w]); wsum += w;
  }
  let r = R() * wsum;
  for (const [o, w] of cands) { r -= w; if (r <= 0) { best = o; break; } }
  if (best) a.visits = (a.visits || 0) + 1;
  return best;
}
function admit(a, ro, t) {
  const o = ro.o, size = a.party.size, cat = CATS[o.cat] || CATS.seating;
  ro.occ += size; ro.footfall += size; ro.visits++;
  if (o.cat !== 'seating' && o.cat !== 'play' && !(o.cat === 'lounge' && a.persona === 'business')) {
    const spend = cat.spend * (1 + 0.5 * (size - 1));
    ro.tx++; ro.spend += spend; sim.spend[o.cat] += spend; sim.tx[o.cat]++;
  }
  const left = (a.callAt || (t + 3600)) - t - 300;
  let dwell = (cat.dwell ? U(cat.dwell[0], cat.dwell[1]) : 10) * 60;
  if (o.cat === 'lounge') dwell = Math.max(dwell, left);
  a.outletUntil = t + Math.max(120, Math.min(dwell, left));
  a.outletIn = t; a.outlet = o;
  setPath(a, [randIn(o.rect, 1.5)]);
}
function outletArrive(a, t, noQueue) {
  const o = a.outlet; if (!o) return false;
  const ro = rtOutlet(o), size = a.party.size;
  if (ro.occ + size <= o.cap) { admit(a, ro, t); return true; }
  if (!noQueue && ro.q.length < OUTLET_BALK) { a.balked = false; ro.q.push(a); a.qJoin = t; ro.maxQ = Math.max(ro.maxQ, ro.q.length); return 'q'; }
  ro.turned += size;
  return false;
}
function outletLeave(a, t) {
  const o = a.outlet; if (!o) return;
  const ro = rtOutlet(o);
  ro.occ = Math.max(0, ro.occ - a.party.size); ro.dwellSum += t - (a.outletIn || t);
}
function outletBalk(a) { a.balked = true; }

function dutyFreeDecide(a, t) {
  const df = sim.df[a.term];
  df.passed += a.party.size;
  WALK_DF[a.term] && (rtOutlet(WALK_DF[a.term]).footfall += a.party.size);
  if (R() >= (CATS.dutyfree.conv[a.persona] || 0.1) * CONV_SCALE) return false;
  df.buyers += a.party.size;
  df.q.push(a); a.qJoin = t; a.stage = ST.D_DF_Q;
  df.snake.slot(df.q.length - 1, tmp); a.tx = tmp.x; a.ty = tmp.y;
  return true;
}

function commerceUpdate(t0, t) {
  // Duty-free tills.
  for (const k of TERMS) {
    const df = sim.df[k];
    for (const till of df.tills) {
      while (df.q.length && till.busy <= t) {
        const a = df.q.shift();
        till.busy = Math.max(till.busy, t0, a.qJoin) + U(DF_SVC[0], DF_SVC[1]);
        a.tx = till.x; a.ty = till.y + 4;
        later(till.busy, () => {
          if (a.stage !== ST.D_DF_Q) return;
          const spend = CATS.dutyfree.spend * (1 + 0.5 * (a.party.size - 1));
          sim.spend.dutyfree += spend; sim.tx.dutyfree++;
          const ro = rtOutlet(WALK_DF[k]); ro.tx++; ro.spend += spend;
          toLounge(a);
        });
      }
    }
    let i = 0;
    for (const a of df.q) { if (a.stage === ST.D_DF_Q) { df.snake.slot(i, tmp); a.tx = tmp.x; a.ty = tmp.y; } i++; }
  }
  // Admit queued parties as seats free up.
  for (const ro of sim.outlets) {
    while (ro.q.length) {
      const a = ro.q.peek();
      if (a.balked || a.stage !== ST.D_OUTLET_Q) { ro.q.shift(); continue; }
      if (ro.occ + a.party.size > ro.o.cap) break;
      ro.q.shift(); admit(a, ro, t); a.stage = ST.D_OUTLET;
    }
  }
}
