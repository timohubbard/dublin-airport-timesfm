'use strict';
/* ====================================================================
   Day generation: flights and aircraft rotations, gates, every party of
   departing, arriving and transfer passengers, meeters and greeters, and
   staff. Volumes follow the day's actual (synthetic) demand; rosters are
   built from forecasts in roster.js. Generation uses its own seeded RNG,
   so a day always has the same flights and passengers.
   ==================================================================== */
const genCache = new Map();
const NMIN = Math.ceil((SIM_END - DAY_START) / 60);
const minuteOf = t => Math.floor((t - DAY_START) / 60);

function marketsFor(day, key) {
  const d = day[key], out = {};
  for (const m of TERMINAL_MARKETS[key]) {
    const src = day.markets && day.markets[key] && day.markets[key][m];
    const sh = BASE_SHARE[key][m];
    const total = src ? src : {
      actual: Math.round(d.actual * sh), univariate: Math.round(d.univariate * sh), joint_with_covariates: Math.round(d.joint_with_covariates * sh),
      q10: Math.round(d.q10 * sh), q90: Math.round(d.q90 * sh), movements: Math.max(1, Math.round(d.movements * sh)), mix: DEFAULT_MIX,
      plan: { hist: d.univariate * sh, tfm: d.joint_with_covariates * sh, p90: d.q90 * sh },
    };
    const half = (v, f) => ({ actual: Math.round(v.actual * f), univariate: Math.round(v.univariate * f), joint_with_covariates: Math.round(v.joint_with_covariates * f),
      plan: { hist: v.plan.hist * f, tfm: v.plan.tfm * f, p90: v.plan.p90 * f } });
    out[m] = {
      ...total, mix: total.mix || DEFAULT_MIX,
      dep: (src && src.dep) || half(total, DEP_SHARE),
      arr: (src && src.arr) || half(total, 1 - DEP_SHARE),
      ts: src && src.transferShare != null ? src.transferShare : TRANSFER_SHARE[key][m],
      rs: src && src.residentShare != null ? src.residentShare : RESIDENT_SHARE[m],
    };
  }
  return out;
}

function genDay(di) {
  if (genCache.has(di)) return genCache.get(di);
  const day = DATA.days[di];
  const rnd = mulberry32(hashStr(day.date));
  const gauss = () => { let u = 0; while (!u) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const pick = list => list[Math.floor(rnd() * list.length)];
  const pickWr = w => pickW(w, rnd());
  const delayOf = () => day.delayMin > 0 ? Math.min(240, Math.round(-Math.log(1 - rnd() * 0.999) * day.delayMin)) * 60 : 0;
  const hist = () => new Float32Array(NMIN);
  const out = {
    di, day, flights: [], arrFlights: [], depParties: [], arrParties: [], greeters: [], staff: [],
    mk: {}, secArr: {}, secArrM: {}, totalM: {}, immArr: {}, immArrM: {}, immTotM: {}, taxiArr: {}, taxiDrop: {}, hbArr: hist(),
    gateStays: new Map(), remoteStays: new Map(), gateConflicts: 0, persona: Object.fromEntries(PERSONA_KEYS.map(p => [p, 0])),
    svcMult: { t1: 0, t2: 0 }, kindCount: [0, 0, 0, 0, 0], modeCount: { dep: {}, arr: {} },
  };
  let fid = 0;

  for (const key of TERMS) {
    const G = GEO[key], mk = marketsFor(day, key);
    out.mk[key] = mk; out.secArr[key] = hist(); out.secArrM[key] = {}; out.totalM[key] = {};
    out.immArr[key] = { eu: hist(), non: hist(), egate: hist() }; out.immArrM[key] = {}; out.immTotM[key] = {};
    out.taxiArr[key] = hist(); out.taxiDrop[key] = hist();

    /* ---- departures and their inbound rotations ---- */
    const deps = [];
    for (const m of TERMINAL_MARKETS[key]) {
      const md = mk[m], meta = MARKETS[m], wsum = meta.depW.reduce((x, y) => x + y, 0);
      const nF = Math.max(1, Math.round(md.movements / 2));
      for (let i = 0; i < nF; i++) {
        let r = rnd() * wsum, h = 0; while (r > meta.depW[h]) { r -= meta.depW[h]; h++; }
        const std = h * 3600 + Math.floor(rnd() * 12) * 300;
        const dest = pick(meta.dests), ac = pick(meta.aircraft);
        const airline = key === 't1' ? (rnd() < (m === 'eu_sun' ? .75 : .6) ? 'R' : 'O') : (m === 'long' ? 'O' : rnd() < .7 ? 'A' : 'O');
        deps.push({ id: fid++, kind: 'dep', term: key, market: m, dest: dest[0], code: dest[1], us: !!dest[2], ac: ac[0], seats: ac[1], wide: !!ac[2],
          std, delay: 0, dep: std, airline, boarded: 0, pax: 0, landside: 0, transfers: 0, bags: 0, bagsLoaded: 0, shortShipped: 0, load: ac[1] * (0.72 + rnd() * 0.25) });
      }
    }
    deps.sort((a, b) => a.std - b.std);
    // The transatlantic inbound bank lands between 04:45 and 09:45, spread rather than clumped.
    const naDeps = deps.filter(f => f.market === 'na');
    naDeps.forEach((f, i) => { f._naSta = (4.75 + 5 * (i + 0.15 + rnd() * 0.7) / naDeps.length) * 3600; });
    const arrs = [];
    for (const f of deps) {
      const meta = MARKETS[f.market];
      const firstWave = f.std < 8.5 * 3600 && f.market !== 'na' && f.market !== 'long';
      let sta = null;
      if (!firstWave) {
        if (f.market === 'na') sta = Math.min(f._naSta, f.std - 100 * 60);
        else if (meta.long) sta = f.std - (100 + rnd() * 40) * 60;
        else if (f.airline === 'R' || f.seats < 100) sta = f.std - (25 + rnd() * 15) * 60;
        else sta = f.std - (40 + rnd() * 20) * 60;
        sta = Math.max(DAY_START + 1800, Math.round(sta / 300) * 300);
      }
      const ownDelay = delayOf();
      if (sta != null) {
        const aDelay = delayOf(), onBlock = sta + aDelay;
        const minTurn = (meta.long ? 75 : f.airline === 'R' ? 25 : 35) * 60;
        f.dep = Math.max(f.std + ownDelay, onBlock + minTurn);
        f.delay = f.dep - f.std;
        const a = { id: fid++, kind: 'arr', term: key, market: f.market, origin: f.dest, code: f.code, ac: f.ac, seats: f.seats, wide: f.wide, us: f.us,
          sta, delay: aDelay, onBlock, airline: f.airline, pax: 0, transfers: 0, out: f, deplaned: 0, bags: 0, bagsClaimed: 0, firstBag: 0, lastBag: 0 };
        f.inbound = a;
        arrs.push(a);
      } else {
        f.dep = f.std + ownDelay; f.delay = ownDelay; f.inbound = null;
        // The aircraft night-stopped: tonight's inbound for tomorrow's first wave.
        const nsta = Math.round((21 + rnd() * 3.5) * 3600 / 300) * 300, aDelay = delayOf();
        const nmeta = MARKETS[f.market];
        const origin = pick(nmeta.dests);
        arrs.push({ id: fid++, kind: 'arr', term: key, market: f.market, origin: origin[0], code: origin[1], ac: f.ac, seats: f.seats, wide: f.wide, us: false,
          sta: nsta, delay: aDelay, onBlock: nsta + aDelay, airline: f.airline, pax: 0, transfers: 0, out: null, nightStop: true, deplaned: 0, bags: 0, bagsClaimed: 0, firstBag: 0, lastBag: 0 });
      }
    }
    arrs.sort((a, b) => a.onBlock - b.onBlock);
    deps.forEach((f, i) => { f.no = (key === 't1' ? 1000 : 2000) + ((i * 37) % 900) + 11; });
    arrs.forEach((a, i) => { a.no = (key === 't1' ? 1000 : 2000) + ((i * 53 + 7) % 900) + 11; });
    assignGates(G, deps, arrs, rnd, out);

    /* ---- passengers per flight ---- */
    const alloc = (flights, total) => {
      const lsum = flights.reduce((x, f) => x + f.seats * (0.72 + 0.25 * ((f.id * 9301 % 97) / 97)), 0);
      let assigned = 0;
      for (const f of flights) { f._w = f.seats * (0.72 + 0.25 * ((f.id * 9301 % 97) / 97)) / lsum; f._n = Math.floor(total * f._w); assigned += f._n; }
      for (let i = 0; assigned < total && flights.length; i = (i + 1) % flights.length) { flights[i]._n++; assigned++; }
    };
    for (const m of TERMINAL_MARKETS[key]) {
      const md = mk[m];
      const mdeps = deps.filter(f => f.market === m), marrs = arrs.filter(a => a.market === m);
      alloc(mdeps, Math.round(md.dep.actual * (1 - md.ts)));
      for (const f of mdeps) f.landside = f._n;
      alloc(marrs, md.arr.actual);
      for (const a of marrs) { a.pax = a._n; a.transfers = Math.round(a.pax * md.ts * (0.7 + rnd() * 0.6)); }
      out.totalM[key][m] = mdeps.reduce((x, f) => x + f.landside, 0);
      out.secArrM[key][m] = hist();
      out.immArrM[key][m] = { eu: hist(), non: hist(), egate: hist() };
      out.immTotM[key][m] = 0;
    }

    /* ---- departing parties ---- */
    for (const f of deps) {
      const meta = MARKETS[f.market], md = mk[f.market], mix = md.mix || DEFAULT_MIX;
      const hr = Math.floor(f.std / 3600);
      const tilt = { business: (hr <= 8 || (hr >= 17 && hr <= 19)) ? 1.4 : 0.75, family: (hr >= 8 && hr <= 14) ? 1.2 : 0.9 };
      const w = PERSONA_KEYS.map(p => (mix[p] || 0) * (tilt[p] || 1) / ((PERSONAS[p].size[0] + PERSONAS[p].size[1]) / 2));
      const wsum = w.reduce((x, y) => x + y, 0);
      const grp = G.checkin.find(c => c.key === f.airline) || G.checkin[1];
      let left = f.landside;
      while (left > 0) {
        let r = rnd() * wsum, pi = 0; while (r > w[pi] && pi < w.length - 1) { r -= w[pi]; pi++; }
        const pk = PERSONA_KEYS[pi], pm = PERSONAS[pk];
        let size = partySize(pk, rnd);
        size = Math.min(size, left); left -= size;
        const chk = rnd() < Math.min(0.95, pm.chk * (meta.long ? 1.8 : 1)) ? grp : null;
        const ft = rnd() < pm.ft;
        let lead = pm.lead[0] + (meta.long ? pm.longExtra : 0) + pm.lead[1] * gauss() + (chk ? 10 : 0);
        lead = clamp(lead, 40, 290);
        let spawn = f.std - lead * 60;
        if (spawn < OPEN[key] - 600) spawn = OPEN[key] - 600 + rnd() * 1500;
        const mode = pickWr(modeSplit(pk, md.rs));
        const via = mode === 'met' ? (rnd() < 0.1 ? 'dropgo' : 'kerb') : mode === 'taxi' ? 'taxi' : mode === 'bus' ? 'bus' : mode === 'short_term' ? 'st' : mode === 'holiday_blue' ? 'hb' : 'rental';
        const bags = chk ? bagCount(pk, size, meta.long, rnd) : 0;
        const v = pm.speed * (0.9 + rnd() * 0.2);
        const call = f.dep - clamp(pm.call[0] + pm.call[1] * gauss(), 20, 80) * 60;
        const door = G.doors[Math.floor(rnd() * G.doors.length)];
        let est = spawn + (chk ? (DESK_SVC * (1 + 0.35 * (size - 1)) + 120 + dist(door, { x: (chk.x0 + chk.x1) / 2, y: 750 }) / v) : 0) + dist(door, G.snakeCenter) / v;
        const party = { kind: KIND.DEP, term: key, persona: pk, size, f, market: f.market, chk, ft, bags, spawn, est, call, mode, via, v, door,
          lounge: rnd() < pm.lounge[key === 't2' ? 0 : 1], svcMult: pm.svc * (0.85 + rnd() * 0.3), members: null, seed: rnd() };
        out.depParties.push(party);
        out.persona[pk] += size; out.kindCount[KIND.DEP] += size;
        out.modeCount.dep[mode] = (out.modeCount.dep[mode] || 0) + size;
        out.svcMult[key] += party.svcMult * size;
        f.pax += size; f.bags += bags;
        const mi = minuteOf(est);
        if (mi >= 0 && mi < NMIN) { out.secArr[key][mi] += size; out.secArrM[key][f.market][mi] += size; }
        if (via === 'taxi') { const di2 = minuteOf(spawn); if (di2 >= 0 && di2 < NMIN) out.taxiDrop[key][di2] += 1; }
        if (via === 'hb') { const hi = minuteOf(spawn - 600); if (hi >= 0 && hi < NMIN) out.hbArr[hi] += size; }
      }
    }

    /* ---- arriving parties, transfers and greeters ---- */
    for (const a of arrs) {
      const meta = MARKETS[a.market], md = mk[a.market], mix = md.mix || DEFAULT_MIX;
      const w = PERSONA_KEYS.map(p => (mix[p] || 0) / ((PERSONAS[p].size[0] + PERSONAS[p].size[1]) / 2));
      const wsum = w.reduce((x, y) => x + y, 0);
      const doors = (a.wide ? 5 : 3) * 60, rate = a.wide ? 30 : 18;
      const pathLen = a.gate ? polyLen(arrivalPath(G, a.gate)) : 600;
      let left = a.pax, trfLeft = a.transfers, order = 0;
      while (left > 0) {
        let r = rnd() * wsum, pi = 0; while (r > w[pi] && pi < w.length - 1) { r -= w[pi]; pi++; }
        const pk = PERSONA_KEYS[pi], pm = PERSONAS[pk];
        let size = Math.min(partySize(pk, rnd), left); left -= size;
        const leaveAt = a.onBlock + doors + (pk === 'prm' ? 10 * 60 : (order / rate) * 60);
        order += size;
        const v = pm.speed * (0.9 + rnd() * 0.2);
        // Transfers: connect to an onward flight 60-240 min later, through Flight Connections Security.
        if (trfLeft > 0 && pk !== 'prm') {
          const onwardM = pickWr(TRANSFER_ONWARD[a.market] || { uk: 1 });
          const cands = deps.filter(f => f.market === onwardM && f.dep > a.onBlock + 60 * 60 && f.dep < a.onBlock + 240 * 60);
          if (cands.length) {
            const f = cands[Math.floor(rnd() * cands.length)];
            trfLeft -= size;
            const call = f.dep - clamp(pm.call[0] + pm.call[1] * gauss(), 20, 80) * 60;
            out.arrParties.push({ kind: KIND.TRF, term: key, persona: pk, size, af: a, f, market: a.market, leaveAt, v, call, ft: false, chk: null, bags: 0,
              svcMult: pm.svc * (0.85 + rnd() * 0.3), lounge: rnd() < pm.lounge[key === 't2' ? 0 : 1], members: null, seed: rnd() });
            f.pax += size; f.transfers += size; out.persona[pk] += size; out.kindCount[KIND.TRF] += size;
            continue;
          }
        }
        const ch = rnd() < meta.nonEU ? 'non' : (pk !== 'family' && pk !== 'prm' && rnd() < meta.egate) ? 'egate' : 'eu';
        const mode = pickWr(modeSplit(pk, md.rs));
        const met = mode === 'met';
        const bags = bagCount(pk, size, meta.long, rnd, true);
        const immAt = leaveAt + pathLen / v;
        const party = { kind: KIND.ARR, term: key, persona: pk, size, af: a, market: a.market, leaveAt, v, ch, mode, bags, immAt, members: null,
          greeters: null, seed: rnd(), cta: !!meta.cta, customsStop: rnd() < (ch === 'non' ? CUSTOMS.stopNon : CUSTOMS.stopEU) };
        out.arrParties.push(party);
        out.persona[pk] += size; out.kindCount[KIND.ARR] += size;
        out.modeCount.arr[mode] = (out.modeCount.arr[mode] || 0) + size;
        a.bags += bags;
        const mi = minuteOf(immAt);
        if (mi >= 0 && mi < NMIN) { out.immArr[key][ch][mi] += size; out.immArrM[key][a.market][ch][mi] += size; }
        out.immTotM[key][a.market] += size;
        if (mode === 'taxi') { const ti = minuteOf(immAt + (bags ? 25 * 60 : 6 * 60)); if (ti >= 0 && ti < NMIN) out.taxiArr[key][ti] += 1; }
        if (mode === 'holiday_blue') { const hi = minuteOf(immAt + (bags ? 25 * 60 : 6 * 60)); if (hi >= 0 && hi < NMIN) out.hbArr[hi] += size; }
        if (met) {
          const n = pk === 'group' ? 1 : 1 + (rnd() < 0.4 ? 1 : 0);
          // Greeters watch the arrivals screen, so they time themselves on the delayed landing.
          const at = a.onBlock - Math.max(2, 15 + 8 * gauss()) * 60;
          const g = { kind: KIND.GRT, term: key, persona: 'leisure', size: n, party, spawn: at, byCar: rnd() < 0.8, members: null, seed: rnd(), v: 1.2 + rnd() * 0.2 };
          party.greeters = g;
          out.greeters.push(g); out.kindCount[KIND.GRT] += n;
        }
      }
    }
    out.flights.push(...deps); out.arrFlights.push(...arrs);
  }

  /* ---- staff ---- */
  const staffCounts = day.staff || { early: 1700, mid: 1300, late: 1450, night: 280 };
  for (const [shift, n] of Object.entries(staffCounts)) {
    const sh = SHIFTS[shift], count = Math.round(n * STAFF.sample);
    for (let i = 0; i < count; i++) {
      const arrive = sh.start - clamp(sh.window[0] + sh.window[1] * gauss(), 15, 110) * 60;
      const airside = rnd() < STAFF.airside;
      out.staff.push({ kind: KIND.STF, size: 1, shift, arrive, leave: sh.end + rnd() * 900, airside, term: rnd() < 0.55 ? 't1' : 't2', seed: rnd(), members: null, v: 1.3 + rnd() * 0.2 });
      out.kindCount[KIND.STF]++;
    }
    // Last night's night shift heads home in the early morning.
    if (shift === 'night') for (let i = 0; i < count; i++) {
      out.staff.push({ kind: KIND.STF, size: 1, shift: 'night-home', arrive: null, leave: 6 * 3600 + rnd() * 1800, airside: rnd() < STAFF.airside, term: rnd() < 0.55 ? 't1' : 't2', seed: rnd(), members: null, v: 1.3 + rnd() * 0.2 });
    }
  }

  out.flights.sort((a, b) => a.std - b.std);
  out.arrFlights.sort((a, b) => a.onBlock - b.onBlock);
  out.depParties.sort((a, b) => a.spawn - b.spawn);
  out.arrParties.sort((a, b) => a.leaveAt - b.leaveAt);
  out.greeters.sort((a, b) => a.spawn - b.spawn);
  out.staff.sort((a, b) => (a.arrive ?? a.leave) - (b.arrive ?? b.leave));
  for (const k of TERMS) {
    const n = out.depParties.filter(p => p.term === k).reduce((x, p) => x + p.size, 0);
    out.svcMult[k] /= Math.max(1, n);
  }
  out.total = { t1: 0, t2: 0 };
  for (const p of out.depParties) out.total[p.term] += p.size;
  genCache.set(di, out);
  if (genCache.size > 2) for (const k of genCache.keys()) { if (k !== di && k !== state.di) { genCache.delete(k); break; } }
  return out;
}

function partySize(pk, rnd) {
  const pm = PERSONAS[pk];
  if (pk === 'leisure') return rnd() < 0.35 ? 2 : 1;
  if (pk === 'prm') return rnd() < 0.6 ? 2 : 1;
  return pm.size[0] + Math.floor(rnd() * (pm.size[1] - pm.size[0] + 1));
}
function bagCount(pk, size, long, rnd, arriving) {
  const rate = Math.min(1.6, PERSONAS[pk].bags * (long ? 1.5 : 1)) * (arriving ? 1 : 1.25);
  return Math.floor(size * rate + rnd());
}
function polyLen(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }

/* Gates are assigned per aircraft stay: from on-block (or the start of the
   day for night-stopped aircraft) to pushback. North American aircraft
   with more than three hours on the ground are towed to a remote stand. */
function assignGates(G, deps, arrs, rnd, out) {
  const remotes = G.remoteGates;
  // Contact gates belong to one terminal; remote stands are shared, so their bookings live on the day.
  const busy = new Map(G.gates.map(g => [g, []]));
  out.remoteBusy = out.remoteBusy || new Map(REMOTE_STANDS.map(r => [r.id, []]));
  const book = g => (g.remote ? out.remoteBusy.get(g.stand) : busy.get(g));
  const free = (g, a, b) => book(g).every(([x, y]) => b <= x || a >= y);
  const stays = [];
  for (const f of deps) {
    const a = f.inbound;
    // Aircraft that night-stopped are towed onto the stand 75 min before departure.
    const from = a ? a.onBlock - 300 : f.std - 75 * 60, to = f.dep + 300;
    if (a && f.std - a.onBlock > 3 * 3600) {
      stays.push({ dep: f, arr: a, from, to: a.onBlock + 45 * 60, part: 'in' });
      stays.push({ dep: f, arr: a, from: f.std - 90 * 60, to, part: 'out' });
    } else stays.push({ dep: f, arr: a, from, to, part: 'all' });
  }
  // Late arrivals that stay overnight are towed off to remote parking after deplaning.
  for (const a of arrs) if (a.nightStop) stays.push({ dep: null, arr: a, from: a.onBlock - 300, to: a.onBlock + 50 * 60, part: 'night' });
  stays.sort((x, y) => x.from - y.from);
  const prevGate = new Map(), tows = [];
  const put = (g, s) => {
    book(g).push([s.from, s.to]);
    if (!out.gateStays.has(g)) out.gateStays.set(g, []);
    out.gateStays.get(g).push(s);
  };
  for (const s of stays) {
    const f = s.dep, a = s.arr;
    // Only departures to the US need a preclearance gate; arriving aircraft can use any stand.
    const us = !!(f && f.us && s.part !== 'in');
    let pool;
    if (G.id === 't2') pool = G.gates.filter(g => (us ? g.us : !g.us));
    else {
      const w = PIER_PREF[(f || a).airline]; let r = rnd(), pid = 'P1';
      for (const [p, wt] of Object.entries(w)) { if (r < wt) { pid = p; break; } r -= wt; }
      pool = G.pierById[pid].gates;
    }
    const keep = prevGate.get(f || a);
    let gate = keep && free(keep, s.from, s.to) ? keep : null;
    if (!gate) { const c = pool.filter(g => free(g, s.from, s.to)); if (c.length) gate = c[Math.floor(rnd() * c.length)]; }
    if (!gate) { const c = G.gates.filter(g => free(g, s.from, s.to) && (!g.us || us || s.part === 'in' || s.part === 'night')); if (c.length) gate = c[Math.floor(rnd() * c.length)]; }
    // No contact gate: a remote stand, boarded by bus from the pier hub (not for US preclearance flights).
    if (!gate && !us) { const c = remotes.filter(g => free(g, s.from, s.to)); if (c.length) gate = c[0]; }
    if (!gate) { const c = G.gates.filter(g => free(g, s.from, s.to)); if (c.length) gate = c[0]; }
    if (!gate) { out.gateConflicts++; gate = pool[Math.floor(rnd() * pool.length)]; }
    put(gate, s);
    if (f) { f.gate = gate; prevGate.set(f, gate); }
    if (a && s.part !== 'out') a.gate = gate;
    if (s.part === 'in') tows.push({ dep: f, arr: a, from: a.onBlock + 45 * 60, to: f.std - 90 * 60 });
  }
  // Long transatlantic turnarounds are towed away between flights: to a free remote stand
  // if one is left over once every flight has a stand, otherwise to parking off the plan.
  for (const tw of tows) {
    const stand = remotes.find(g => free(g, tw.from, tw.to));
    if (!stand) continue;
    book(stand).push([tw.from, tw.to]);
    if (!out.remoteStays.has(stand)) out.remoteStays.set(stand, []);
    out.remoteStays.get(stand).push(tw);
  }
  for (const list of out.gateStays.values()) list.sort((x, y) => x.from - y.from);
}
