'use strict';
/* ====================================================================
   Geometry: one combined plan, world units ≈ metres, north up, y down.
   Each terminal is drawn as a section stack: further south is a lower
   level (departures, upper road, arrivals, lower road, baggage
   basement, ring road). Car parks sit on the flanks and the south strip.
   A schematic of the public daa terminal map, not to scale.
   ==================================================================== */
const PIER_HW = 12, BRIDGE = 18;
const WORLD = { x: -270, y: -205, w: 1960, h: 1830 };
const Y = {
  lounge: 486, dfTop: 554, sec: 618, snake: 648, desk: 716, chkQ: 732, food: 776, door: 838,
  footDep: 849, kerbDep: 863, roadDep: 878,
  arrTop: 906, immBooth: 962, reclaimTop: 986, customs: 1073, rail: 1088, hallOutlets: 1114, arrDoor: 1140,
  footArr: 1150, bayArr: 1164, roadArr: 1186, base: 1236, ring: 1446,
};

function makeTerminal(c) {
  const b = c.building, bx1 = b.x + b.w;
  const lanes = [];
  for (let i = 0; i < c.nLanes; i++) lanes.push({ x: c.laneX0 + i * (c.laneX1 - c.laneX0) / (c.nLanes - 1), y: Y.sec });
  const cx = (c.laneX0 + c.laneX1) / 2;
  // Lanes 0 and 1 (west end) are Fast Track; the rest open from the centre outward.
  const order = lanes.map((_, i) => i).filter(i => i >= FT_LANES).sort((p, q) => Math.abs(lanes[p].x - cx) - Math.abs(lanes[q].x - cx));
  const s = c.snake, rows = 12, gap = 4.6, yLast = Y.snake + (rows - 1) * gap;
  // Overflow leaves the snake, winds through the landside food-court walkway, then out of the door.
  const door = c.doors[c.doors.length - 1];
  const ov = new Polyline([
    { x: s.x1, y: yLast }, { x: s.x1 + 8, y: yLast + 10 }, { x: s.x1 + 8, y: 806 }, { x: b.x + 12, y: 806 },
    { x: b.x + 12, y: 816 }, { x: bx1 - 12, y: 816 }, { x: bx1 - 12, y: 826 }, { x: b.x + 12, y: 826 },
    { x: b.x + 12, y: Y.footDep }, { x: bx1 - 12, y: Y.footDep },
  ]);
  const snake = new Snake({ x0: s.x0, x1: s.x1, y0: Y.snake, rows, gap, sp: 3.2, hx: cx, ov });
  for (const g of c.checkin) {
    g.deskPos = [];
    for (let i = 0; i < g.desks; i++) g.deskPos.push({ x: g.x0 + i * (g.x1 - g.x0) / (g.desks - 1), y: Y.desk });
    g.area = { x: g.x0, y: Y.chkQ, w: g.x1 - g.x0, h: 38 };
    g.perRow = Math.floor(g.area.w / 3.4);
  }
  const lounge = { x: b.x + 8, y: Y.lounge, w: b.w - 16, h: 102 };
  const air = { x: b.x + 8, y: 488, w: b.w - 16, h: 62 };
  const df = { x: c.laneX0, y: Y.dfTop, w: c.laneX1 - c.laneX0, h: 32 };
  const hall = { x: b.x + 6, y: 640, w: b.w - 12, h: 132 };
  const food = { x: b.x + 6, y: 778, w: b.w - 12, h: 20 };
  const secBand = { x: b.x + 6, y: 598, w: b.w - 12, h: 38 };
  // Flight Connections Security for transfers, at the east end of the security band.
  const fcs = { x: bx1 - 44, y: 600, w: 38, h: 34, lanes: [{ x: bx1 - 34, y: Y.sec }, { x: bx1 - 18, y: Y.sec }] };
  fcs.snake = new Snake({ x0: bx1 - 40, x1: bx1 - 10, y0: 628, rows: 4, gap: 3.4, sp: 3, down: true });

  // Arrivals level.
  const A = c.arr, ab = { x: b.x, y: Y.arrTop, w: b.w, h: 234 };
  const corrX = bx1 + 6, entry = { x: bx1 - 8, y: 910 };
  const imm = {};
  for (const ch of ['non', 'eu', 'egate']) {
    const [x0, x1] = A.imm[ch], n = IMM.booths[c.id][ch];
    const booths = [];
    for (let i = 0; i < n; i++) booths.push({ x: x0 + 4 + i * (x1 - x0 - 8) / Math.max(1, n - 1), y: Y.immBooth, busy: 0 });
    const ovPts = [{ x: x0, y: 924 }, { x: x0, y: 914 }, { x: entry.x, y: 914 }, { x: corrX, y: 902 }, { x: corrX, y: 700 }];
    imm[ch] = { x0, x1, booths, snake: new Snake({ x0, x1, y0: 952, rows: 7, gap: 4.4, sp: 3.2, hx: (x0 + x1) / 2, down: false, ov: new Polyline(ovPts) }) };
  }
  const carousels = A.carousels.map((cc, i) => {
    const { x, y, w, h } = cc, r = h / 2, pts = [];
    for (let k = 0; k <= 8; k++) { const a = -Math.PI / 2 - k * Math.PI / 8; pts.push({ x: x - w / 2 + r + Math.cos(a) * r, y: y + Math.sin(a) * r }); }
    for (let k = 0; k <= 8; k++) { const a = Math.PI / 2 - k * Math.PI / 8; pts.push({ x: x + w / 2 - r + Math.cos(a) * r, y: y + Math.sin(a) * r }); }
    pts.push({ ...pts[0] });
    return { id: i + 1, name: `Carousel ${i + 1}`, x, y, w, h, large: !!cc.large, loop: new Polyline(pts), feed: { x: x - w / 2, y }, flights: [] };
  });
  const customs = { y: Y.customs, blue: { x: A.customs[0], y: Y.customs }, green: { x: A.customs[1], y: Y.customs }, red: { x: A.customs[2], y: Y.customs } };
  const arrHall = { x: b.x + 6, y: 1082, w: b.w - 12, h: 54 };
  const greet = { x: b.x + 10, y: 1092, w: b.w - 20, h: 18 };
  const rentalDesks = [];
  for (let i = 0; i < RENTAL.desks; i++) rentalDesks.push({ x: A.rental[0] + i * (A.rental[1] - A.rental[0]) / (RENTAL.desks - 1), y: 1126, busy: 0 });
  const arrDoors = A.doors.map(x => ({ x, y: Y.arrDoor }));
  const taxiQ = new Snake({ x0: A.taxiQ[0], x1: A.taxiQ[1], y0: 1147, rows: 3, gap: 3.6, sp: 3.4, hx: (A.taxiQ[0] + A.taxiQ[1]) / 2,
    ov: new Polyline([{ x: A.taxiQ[0], y: 1154 }, { x: A.taxiQ[0], y: 1132 }, { x: b.x + 10, y: 1132 }]) });

  // Baggage basement.
  const base = { x: b.x, y: Y.base, w: b.w, h: 170 };
  const shaftX = b.x + 8, tunnelX = b.x + 22;
  const hbs = [0, 1, 2].map(i => ({ x: b.x + 44 + i * 30, y: 1262, busy: 0 }));
  const sorter = new Polyline([{ x: b.x + 140, y: 1268 }, { x: bx1 - 20, y: 1268 }, { x: bx1 - 20, y: 1304 }, { x: b.x + 140, y: 1304 }, { x: b.x + 140, y: 1268 }]);
  const nLat = BAGS.laterals[c.id], laterals = [];
  for (let i = 0; i < nLat; i++) laterals.push({ id: i, x: b.x + 120 + i * (b.w - 140) / nLat, y: 1350, w: (b.w - 140) / nLat - 6, h: 40, flights: [] });
  const ebs = { x: b.x + 14, y: 1336, w: 90, h: 56 };

  return {
    ...c, lanes, laneOrder: order, snake, lounge, air, df, hall, food, secBand, fcs, ftX: s.x0 - 14,
    snakeCenter: { x: cx, y: Y.snake + gap * rows / 2 },
    corrX, arrBuilding: ab, arrEntry: entry, imm, carousels, customs, arrHall, greet, rentalDesks, arrDoors, taxiQ,
    base, shaftX, tunnelX, hbs, sorter, laterals, ebs,
  };
}

const GEO = {
  t2: makeTerminal({
    id: 't2', idx: 1, name: 'Terminal 2', short: 'T2',
    building: { x: 200, y: 478, w: 380, h: 360 },
    nLanes: 18, laneX0: 288, laneX1: 532, maxLanes: 18,
    snake: { x0: 290, x1: 524 },
    doors: [{ x: 262, y: Y.door }, { x: 390, y: Y.door }, { x: 518, y: Y.door }],
    checkin: [
      { key: 'A', label: 'Aer Lingus check-in', x0: 222, x1: 386, desks: 28 },
      { key: 'O', label: 'Other airlines', x0: 418, x1: 558, desks: 18 },
    ],
    preclear: { x: 20, y: 492, w: 160, h: 104, door: { x: 200, y: 536 }, cbp: { x: 108, y: 500, w: 66, h: 88 }, lounge: { x: 26, y: 500, w: 76, h: 88 } },
    link: { dep: { x: 170, y: 820 }, arr: { x: 170, y: 1110 }, wall: 200 },
    arr: {
      imm: { non: [210, 330], eu: [340, 450], egate: [460, 570] },
      carousels: [
        { x: 265, y: 1002, w: 80, h: 16, large: 1 }, { x: 390, y: 1002, w: 80, h: 16, large: 1 }, { x: 515, y: 1002, w: 80, h: 16, large: 1 },
        { x: 265, y: 1046, w: 80, h: 16, large: 1 }, { x: 390, y: 1046, w: 80, h: 16, large: 1 }, { x: 515, y: 1046, w: 80, h: 16, large: 1 },
      ],
      customs: [330, 390, 450], rental: [446, 570], doors: [262, 390, 518], taxiQ: [398, 568],
      bayBus: [230, 250, 270], bayShuttle: [300, 320, 340], rank: Array.from({ length: 14 }, (_, i) => 404 + i * 11),
    },
    dep: { kerb: [214, 486], bayBus: [508, 526, 544, 562] },
  }),
  t1: makeTerminal({
    id: 't1', idx: 0, name: 'Terminal 1', short: 'T1',
    building: { x: 720, y: 478, w: 460, h: 360 },
    nLanes: 22, laneX0: 784, laneX1: 1116, maxLanes: 22,
    snake: { x0: 800, x1: 1100 },
    doors: [{ x: 800, y: Y.door }, { x: 950, y: Y.door }, { x: 1100, y: Y.door }],
    checkin: [
      { key: 'R', label: 'Ryanair check-in', x0: 742, x1: 930, desks: 18 },
      { key: 'O', label: 'Other airlines', x0: 970, x1: 1158, desks: 24 },
    ],
    link: { dep: { x: 1230, y: 820 }, arr: { x: 1230, y: 1110 }, wall: 1180 },
    arr: {
      imm: { non: [740, 880], eu: [900, 1040], egate: [1060, 1160] },
      carousels: [
        { x: 770, y: 1002, w: 60, h: 16 }, { x: 860, y: 1002, w: 60, h: 16 }, { x: 950, y: 1002, w: 60, h: 16 },
        { x: 1040, y: 1002, w: 60, h: 16, large: 1 }, { x: 1130, y: 1002, w: 60, h: 16, large: 1 },
        { x: 770, y: 1046, w: 60, h: 16 }, { x: 860, y: 1046, w: 60, h: 16 }, { x: 950, y: 1046, w: 60, h: 16 },
        { x: 1040, y: 1046, w: 60, h: 16, large: 1 }, { x: 1130, y: 1046, w: 60, h: 16, large: 1 },
      ],
      customs: [890, 950, 1010], rental: [1016, 1168], doors: [800, 950, 1100], taxiQ: [990, 1172],
      bayBus: [746, 766, 786], bayShuttle: [820, 840, 860], rank: Array.from({ length: 17 }, (_, i) => 994 + i * 11),
    },
    dep: { kerb: [734, 1086], bayBus: [1102, 1120, 1138, 1156] },
  }),
};
/* ---- Piers, gates and stands: real geometry from OpenStreetMap ----
   airport_geometry.py traces Dublin's piers and matches every OSM gate to
   its stand. Here each terminal's airside is placed at true scale, turned
   so real west is up (see AIRPORT_GEO.twin), above that terminal's section
   stack. Walking along a pier in the twin is as long as the real walk. */
const AG = window.AIRPORT_GEO || { piers: [], remote: [], twin: {} };
const twinPt = (term, x, y) => ({ x: -y + AG.twin[term].dx, y: x + AG.twin[term].dy });
const twinAng = a => a + Math.PI / 2;
// What the twin cannot draw where it really is. The 332-337 bus lounge is the
// real T1-T2 link, drawn along the twin's airside link; walking time is kept
// real through the k factor (real metres per drawn unit).
const PIER_TWIN = { P335: [{ x: 716, y: 533 }, { x: 584, y: 533 }] };
// Shop and seating areas by each pier root, and the doors from the departures lounge (schematic).
const PIER_HUB = {
  P1: { x: 1226, y: 380, w: 84, h: 22 }, P2: { x: 886, y: 318, w: 76, h: 20 }, P3: { x: 812, y: 384, w: 22, h: 60 },
  P4: { x: 492, y: 414, w: 76, h: 22 }, P335: { x: 612, y: 520, w: 72, h: 10 },
};
function projOn(pl, p) {
  let best = null;
  for (let i = 1; i < pl.pts.length; i++) {
    const a = pl.pts[i - 1], b = pl.pts[i], L = pl.cum[i] - pl.cum[i - 1] || 1e-9;
    const f = clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (L * L), 0, 1);
    const qx = a.x + f * (b.x - a.x), qy = a.y + f * (b.y - a.y), d = Math.hypot(p.x - qx, p.y - qy);
    if (!best || d < best.d) best = { s: pl.cum[i - 1] + f * L, d, side: Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) || 1 };
  }
  return best;
}
/* Points along a branch from its root to s, offset sideways by off. */
function alongPts(br, s, off, k) {
  const out = [];
  for (let i = 1; i < br.pts.length && br.cum[i] < s - 0.5; i++) { const p = br.at(br.cum[i], off, {}); out.push({ x: p.x, y: p.y }); }
  const e = br.at(s, off, {}); out.push({ x: e.x, y: e.y });
  if (k !== 1) for (const p of out) p.k = k;
  return out;
}
function realPier(P, G) {
  const T = P.term, ov = PIER_TWIN[P.id];
  const branches = P.branches.map(b => new Polyline(b.map(p => twinPt(T, p[0], p[1]))));
  let k = 1;
  if (ov) { const real = new Polyline(P.branches[0].map(p => ({ x: p[0], y: p[1] }))); branches[0] = new Polyline(ov); k = real.len / branches[0].len; }
  const root = branches[0].pts[0], b = G.building;
  const entry = ov ? { x: b.x + 8, y: root.y } : { x: clamp(root.x, b.x + 16, b.x + b.w - 16), y: b.y + 3 };
  // The section stack draws terminals larger than they are: scale the walk from the
  // lounge to the pier door so security → pier root takes the real distance.
  const sec = { x: (G.laneX0 + G.laneX1) / 2, y: Y.sec - 14 };
  const kEntry = clamp((P.securityToRootM - dist(entry, root) * k) / Math.max(1, dist(sec, entry)), 0.3, 1.5);
  const pier = { id: P.id, name: P.name, term: T, branches, root, entry, end: P.end || 0, k, kEntry, sec, hub: PIER_HUB[P.id], gates: [], busGates: [], securityToRootM: P.securityToRootM };
  for (const g of P.gates) {
    const br = branches[g.branch], gp = twinPt(T, g.x, g.y);
    let s, u;
    if (ov) { s = g.along / k; const n = br.at(s, 1, {}); const side = /[13579]$/.test(g.id) ? 1 : -1; u = { x: (n.x - br.at(s, 0, {}).x) * side, y: (n.y - br.at(s, 0, {}).y) * side }; }
    else {
      const pr = projOn(br, gp); s = pr.s;
      if (pier.end && s > br.len - pier.end * 0.6) {
        // Rotunda: gates sit around the end of the pier.
        s = br.len; const c = br.pts[br.pts.length - 1], d = Math.hypot(gp.x - c.x, gp.y - c.y) || 1;
        u = { x: (gp.x - c.x) / d, y: (gp.y - c.y) / d };
      } else { const c = br.at(s, 0, {}), n = br.at(s, 1, {}); u = { x: (n.x - c.x) * pr.side, y: (n.y - c.y) * pr.side }; }
    }
    const spine = br.at(s, 0, {}), R = pier.end && s >= br.len - 0.5 ? pier.end : PIER_HW;
    const at = r => ({ x: spine.x + u.x * r, y: spine.y + u.y * r });
    const hc = at(R - 6), edge = at(R);
    const gate = {
      id: g.id, pier: P.id, term: T, us: !!g.us, bus: !!g.bus, level: g.level, branch: g.branch, along: s, walkM: g.walkM,
      spine: { x: spine.x, y: spine.y }, hold: { x: hc.x - 6, y: hc.y - 6, w: 12, h: 12 }, bridgeA: edge,
      route: alongPts(br, s, 0, k), laneBack: alongPts(br, s, -4, k).reverse(),
      lbl: { ...at(R + 7), align: u.x < -0.3 ? 'right' : u.x > 0.3 ? 'left' : 'center' },
    };
    if (g.stand) {
      const d = twinPt(T, g.stand.door[0], g.stand.door[1]), c = twinPt(T, g.stand.plane[0], g.stand.plane[1]);
      gate.door = d; gate.plane = { x: c.x, y: c.y, ang: twinAng(g.stand.ang) }; gate.standRef = g.stand.ref;
    } else {
      const d = at(R + BRIDGE); gate.door = d; gate.plane = { x: d.x + u.x * 22, y: d.y + u.y * 22, ang: Math.atan2(-u.y, -u.x) };
    }
    (g.bus ? pier.busGates : pier.gates).push(gate);
  }
  return pier;
}
for (const k of TERMS) {
  const G = GEO[k];
  G.piers = AG.piers.filter(P => P.term === k).map(P => realPier(P, G));
  G.gates = G.piers.flatMap(p => p.gates);
  G.busGates = G.piers.flatMap(p => p.busGates);
  G.pierById = Object.fromEntries(G.piers.map(p => [p.id, p]));
}
const ALL_GATES = TERMS.flatMap(k => GEO[k].gates);
const ALL_BUS_GATES = TERMS.flatMap(k => GEO[k].busGates);

/* Remote stands, boarded by bus: the South Gates (from gate 335), the West
   Apron and the North Apron. They are drawn in a block at the west edge of
   the twin (not to scale); bus times come from the real distances. */
const REMOTE_SLOTS = [130, 210, 290, 370, 450].flatMap(y => [-215, -150, -85, -20].map(x => ({ x, y })));
const REMOTE_STANDS = AG.remote.slice(0, REMOTE_SLOTS.length).map((r, i) => ({
  id: r.id, area: r.area, areaName: r.areaName, busFrom: r.busFrom, busMin: r.busMin, busM: r.busM, realGate: r.gate,
  plane: { ...REMOTE_SLOTS[i], ang: 0 }, real: { x: r.plane[0], y: r.plane[1], ang: r.ang },
}));
for (const k of TERMS) {
  const G = GEO[k];
  // T1 buses leave from the named bus gate; T2's from the Pier 4 hub.
  const p4 = G.pierById.P4;
  const t2Bus = p4 && { pier: 'P4', spine: { ...p4.root }, hold: { x: p4.hub.x + 2, y: p4.hub.y + 4, w: 22, h: 14 }, bridgeA: { x: p4.hub.x, y: p4.hub.y + 11 }, route: [], laneBack: [] };
  G.remoteGates = REMOTE_STANDS.map(st => {
    const bg = k === 't1' ? G.busGates.find(b => b.id === st.busFrom) || G.busGates[0] : t2Bus;
    return {
      id: st.id, stand: st.id, area: st.area, remote: true, us: false, term: k, busMin: st.busMin, busGate: bg.id || 'P4',
      pier: bg.pier, spine: bg.spine, route: bg.route, laneBack: bg.laneBack, hold: bg.hold, bridgeA: bg.bridgeA, door: bg.bridgeA,
      plane: st.plane, lbl: { x: st.plane.x, y: st.plane.y - 26, align: 'center' },
    };
  });
}
/* Walking distance from security to a gate along the twin's route (metres). */
function gateWalkM(gate) {
  if (gate._walk != null) return gate._walk;
  const p = GEO[gate.term].pierById[gate.pier];
  let m = dist(p.sec, p.entry) * p.kEntry + dist(p.entry, p.root) * (p.k || 1) + polyLen([p.root, ...gate.route]);
  return (gate._walk = m);
}

// Staff search sits between the terminals; a footway runs south to the staff car park.
const STAFF_SEARCH = { x: 596, y: 592, w: 110, h: 52, lanes: [], footX: 650 };
for (let i = 0; i < STAFF.lanes; i++) STAFF_SEARCH.lanes.push({ x: 604 + i * 10.5, y: 604, busy: 0 });
STAFF_SEARCH.snake = new Snake({ x0: 600, x1: 702, y0: 630, rows: 3, gap: 4, sp: 3.2, down: true,
  ov: new Polyline([{ x: 650, y: 646 }, { x: 650, y: 1470 }]) });
const AIRSIDE_LINK = { x: 576, y: 522, w: 148, h: 22 };

/* Roads: one-way links as Polylines (lane centrelines). Vehicles enter from
   the ring road at either end. The upper road serves departures, the lower
   road arrivals; both run eastbound off the west ramp. */
const ROADS = {
  ringE: new Polyline([{ x: -270, y: 1446 }, { x: 1690, y: 1446 }]),
  ringW: new Polyline([{ x: 1690, y: 1456 }, { x: -270, y: 1456 }]),
  wr1: new Polyline([{ x: 185, y: 1446 }, { x: 185, y: 1186 }]),
  wr2: new Polyline([{ x: 185, y: 1186 }, { x: 185, y: 890 }, { x: 197, y: 878 }]),
  up: new Polyline([{ x: 197, y: 878 }, { x: 1193, y: 878 }]),
  er1: new Polyline([{ x: 1193, y: 878 }, { x: 1205, y: 890 }, { x: 1205, y: 1186 }]),
  low: new Polyline([{ x: 185, y: 1186 }, { x: 1205, y: 1186 }]),
  er2: new Polyline([{ x: 1205, y: 1186 }, { x: 1205, y: 1446 }]),
  hold: new Polyline([{ x: -20, y: 1300 }, { x: 185, y: 1300 }]),
};
const J = {   // junction positions (s along a link)
  ringE_wr1: 455, ringW_wr1: 1505, er2_ringE: 1475, er2_ringW: 485, hold_wr1: 146,
};
const ringS = { E: x => x + 270, W: x => 1690 - x };

const CARPARKS = {
  st_t2: { name: 'T2 Short Term', term: 't2', rect: { x: 0, y: 650, w: 170, h: 480 }, drive: 85, ped: { dep: { x: 170, y: 820 }, arr: { x: 170, y: 1110 } } },
  surf_t2: { name: 'T2 Surface Car Park', term: 't2', rect: { x: -250, y: 650, w: 230, h: 480 }, drive: -200, ped: { dep: { x: -20, y: 820 }, arr: { x: -20, y: 1110 } } },
  st_t1: { name: 'T1 Short Term', term: 't1', rect: { x: 1230, y: 660, w: 180, h: 470 }, drive: 1320, ped: { dep: { x: 1230, y: 820 }, arr: { x: 1230, y: 1110 } } },
  cpa_t1: { name: 'Terminal 1 Car Park A', term: 't1', rect: { x: 1430, y: 660, w: 250, h: 470 }, drive: 1555, ped: { dep: { x: 1430, y: 820 }, arr: { x: 1430, y: 1110 } } },
  dropgo: { name: 'Drop & Go Parking', term: 't1', rect: { x: 1230, y: 1236, w: 200, h: 120 }, drive: 1400, ped: { dep: { x: 1240, y: 1236 }, arr: { x: 1240, y: 1236 } } },
  staff: { name: 'Staff car park', rect: { x: 180, y: 1475, w: 460, h: 140 }, drive: 400, ped: { dep: { x: 650, y: 1475 }, arr: { x: 650, y: 1475 } } },
  rental: { name: 'Car hire lot', rect: { x: 720, y: 1475, w: 300, h: 140 }, drive: 870, ped: { dep: { x: 870, y: 1475 }, arr: { x: 870, y: 1475 } } },
  hb: { name: 'Holiday Blue', rect: { x: 1180, y: 1475, w: 500, h: 140 }, drive: 1250, ped: { dep: { x: 1300, y: 1480 }, arr: { x: 1300, y: 1480 } }, inset: true },
};
const TAXI_HOLDING = { name: 'Taxi holding', rect: { x: -250, y: 1236, w: 230, h: 170 }, drive: -60 };

/* Bays along the lay-bys. s is the position along the road link. */
function baysFor(G) {
  const kerb = [];
  for (let x = G.dep.kerb[0]; x <= G.dep.kerb[1]; x += 9) kerb.push({ x, y: Y.kerbDep, s: x - 197, veh: null, term: G.id });
  const mk = (xs, y, base, type) => xs.map(x => ({ x, y, s: x - base, veh: null, term: G.id, type }));
  return {
    kerb,
    depBus: mk(G.dep.bayBus, Y.kerbDep, 197, 'bus'),
    arrBus: mk(G.arr.bayBus, Y.bayArr, 185, 'bus'),
    arrShuttle: mk(G.arr.bayShuttle, Y.bayArr, 185, 'shuttle'),
    rank: mk(G.arr.rank, Y.bayArr, 185, 'taxi'),
  };
}
for (const k of TERMS) GEO[k].bays = baysFor(GEO[k]);

/* Arrival routes: aircraft door → bridge → pier arrivals lane → sterile corridor → arrivals level. */
function arrivalPath(G, gate) {
  const p = G.pierById[gate.pier];
  const pts = [{ x: gate.bridgeA.x, y: gate.bridgeA.y }, ...gate.laneBack, { x: p.root.x, y: p.root.y, k: p.k }];
  pts.push({ x: p.entry.x, y: 482 }, { x: G.corrX, y: 482, k: p.kEntry }, { x: G.corrX, y: 902 }, { x: G.arrEntry.x, y: G.arrEntry.y });
  return pts;
}

/* Camera presets. */
const PRESETS = {
  W: { name: 'Whole airport', rect: WORLD },
  D: { name: 'Departures', rect: { x: -240, y: -120, w: 1600, h: 1000 } },
  A: { name: 'Arrivals', rect: { x: 160, y: 430, w: 1060, h: 790 } },
  L: { name: 'Landside', rect: { x: -270, y: 640, w: 1960, h: 984 } },
  B: { name: 'Baggage', rect: { x: 160, y: 440, w: 1060, h: 990 } },
  S: { name: 'Real map', site: true, rect: { x: -200, y: -620, w: 1150, h: 1120 } },
};

function ftSlot(G, r, out) {
  const col = Math.floor(r / 16);
  out.x = G.ftX - Math.min(col, 6) * 3.6 + (col > 6 ? ((r * 7919) % 9) - 4 : 0);
  out.y = Y.snake + (r % 16) * 3.3;
  return out;
}
function chkSlot(g, r, out) {
  const row = Math.floor(r / g.perRow), col = r % g.perRow;
  out.x = g.area.x + 2 + col * 3.4;
  out.y = g.area.y + Math.min(row, 10) * 3.4 + (row > 10 ? (row - 10) * 0.6 : 0);
  return out;
}
