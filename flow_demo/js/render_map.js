'use strict';
/* ====================================================================
   Map rendering: a cached static layer (buildings, roads, car parks,
   outlets), then live aircraft, servers, bags, vehicles and people, then
   screen-space labels with simple decluttering.
   ==================================================================== */
const mapCv = document.getElementById('map'), mctx = mapCv.getContext('2d');
const view = { s: 1, ox: 0, oy: 0, fit: true, cw: 0, ch: 0, dpr: 1, anim: null };
let bgCache = null, bgKey = '';

// Leave room for the overlays: preset bar and note at the top, legend at the bottom.
function fitRect(r, pad = 18) {
  const top = 64, bottom = 64, s = Math.min((view.cw - pad * 2) / r.w, (view.ch - top - bottom) / r.h);
  return { s, ox: (view.cw - r.w * s) / 2 - r.x * s, oy: top + (view.ch - top - bottom - r.h * s) / 2 - r.y * s };
}
function fitView() { Object.assign(view, fitRect(WORLD)); view.fit = true; }
function flyTo(rect) {
  const to = fitRect(rect), from = { s: view.s, ox: view.ox, oy: view.oy };
  view.anim = { from, to, t0: performance.now(), dur: 450 }; view.fit = rect === WORLD;
}
function stepCamera(now) {
  const A = view.anim; if (!A) return;
  const p = clamp((now - A.t0) / A.dur, 0, 1), e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  // Interpolate in a way that keeps the zoom smooth.
  const s = Math.exp(Math.log(A.from.s) + (Math.log(A.to.s) - Math.log(A.from.s)) * e);
  const cx0 = (view.cw / 2 - A.from.ox) / A.from.s, cy0 = (view.ch / 2 - A.from.oy) / A.from.s;
  const cx1 = (view.cw / 2 - A.to.ox) / A.to.s, cy1 = (view.ch / 2 - A.to.oy) / A.to.s;
  const cx = cx0 + (cx1 - cx0) * e, cy = cy0 + (cy1 - cy0) * e;
  view.s = s; view.ox = view.cw / 2 - cx * s; view.oy = view.ch / 2 - cy * s;
  if (p >= 1) view.anim = null;
}
function resizeMap() {
  const r = mapCv.getBoundingClientRect();
  view.dpr = Math.min(2, window.devicePixelRatio || 1);
  view.cw = r.width; view.ch = r.height;
  mapCv.width = Math.round(r.width * view.dpr); mapCv.height = Math.round(r.height * view.dpr);
  if (view.fit) fitView();
}
const toScreen = (x, y) => ({ x: x * view.s + view.ox, y: y * view.s + view.oy });
function rr(g, x, y, w, h, r) { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); }
function polyStroke(g, pts) { g.beginPath(); g.moveTo(pts[0].x, pts[0].y); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y); g.stroke(); }

/* ---------------- static layer ---------------- */
function drawStatic(g) {
  const s = view.s, px = 1 / s;
  g.fillStyle = '#060c18'; g.fillRect(WORLD.x - 600, WORLD.y - 600, WORLD.w + 1200, WORLD.h + 1200);
  g.strokeStyle = 'rgba(148,163,184,0.03)'; g.lineWidth = px;
  g.beginPath();
  for (let x = -300; x <= 1700; x += 50) { g.moveTo(x, -220); g.lineTo(x, 1640); }
  for (let y = -200; y <= 1640; y += 50) { g.moveTo(-300, y); g.lineTo(1700, y); }
  g.stroke();
  // Apron, runway and taxiway (schematic), then the real piers, gates and stands.
  g.fillStyle = '#0b1424';
  rr(g, -250, -130, 1866, 606, 18); g.fill();
  g.fillStyle = '#0f192b'; rr(g, -240, -192, 1830, 34, 3); g.fill();
  g.strokeStyle = 'rgba(203,213,225,0.22)'; g.lineWidth = 1.2; g.setLineDash([16, 14]);
  g.beginPath(); g.moveTo(-200, -175); g.lineTo(1550, -175); g.stroke(); g.setLineDash([]);
  g.fillStyle = 'rgba(203,213,225,0.18)';
  for (let i = 0; i < 6; i++) { g.fillRect(-232, -188 + i * 4.6, 18, 2.2); g.fillRect(1562, -188 + i * 4.6, 18, 2.2); }
  g.strokeStyle = '#121d31'; g.lineWidth = 11; g.beginPath(); g.moveTo(-240, -138); g.lineTo(1600, -138); g.stroke();
  g.strokeStyle = 'rgba(250,204,21,0.16)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(-240, -138); g.lineTo(1600, -138); g.stroke();
  // Stand lead-in lines.
  g.strokeStyle = 'rgba(250,204,21,0.14)'; g.lineWidth = 0.8;
  g.beginPath();
  for (const gt of ALL_GATES) { const c = Math.cos(gt.plane.ang), sn = Math.sin(gt.plane.ang); g.moveTo(gt.door.x, gt.door.y); g.lineTo(gt.plane.x - c * 30, gt.plane.y - sn * 30); }
  for (const r of REMOTE_STANDS) { g.moveTo(r.plane.x - 30, r.plane.y); g.lineTo(r.plane.x + 34, r.plane.y); }
  g.stroke();
  // Apron service road (tugs) and the baggage tunnels down to the basement.
  g.strokeStyle = 'rgba(148,163,184,0.10)'; g.lineWidth = 6; g.beginPath(); g.moveTo(-250, 470); g.lineTo(1610, 470); g.stroke();
  g.strokeStyle = 'rgba(148,163,184,0.18)'; g.lineWidth = 0.6; g.setLineDash([5, 5]);
  g.beginPath(); g.moveTo(-250, 470); g.lineTo(1610, 470); g.stroke();
  for (const k of TERMS) { const G = GEO[k]; g.beginPath(); g.moveTo(G.tunnelX, 470); g.lineTo(G.tunnelX, Y.base + 6); g.stroke(); }
  g.setLineDash([]);
  // Piers: real centrelines at true width, rotundas, the corridor down to the terminal, hubs.
  g.lineJoin = 'round'; g.lineCap = 'round';
  for (const k of TERMS) for (const p of GEO[k].piers) {
    const strokePier = (w, col) => {
      g.strokeStyle = col; g.lineWidth = w;
      for (const br of p.branches) polyStroke(g, br.pts);
      if (p.id !== 'P335') polyStroke(g, [p.root, p.entry]);
    };
    strokePier(PIER_HW * 2 + 2.2 * px, '#2a3a5a');
    strokePier(PIER_HW * 2, '#121d33');
    if (p.end) {
      const e = p.branches[0].pts[p.branches[0].pts.length - 1];
      g.fillStyle = '#121d33'; g.strokeStyle = '#2a3a5a'; g.lineWidth = 1.1 * px;
      g.beginPath(); g.arc(e.x, e.y, p.end, 0, 7); g.fill(); g.stroke();
    }
    g.fillStyle = '#121d33'; g.strokeStyle = '#2a3a5a'; g.lineWidth = 1.1 * px;
    rr(g, p.hub.x, p.hub.y, p.hub.w, p.hub.h, 5); g.fill(); g.stroke();
    g.fillStyle = 'rgba(244,114,182,0.08)';
    for (const gt of [...p.gates, ...p.busGates]) { rr(g, gt.hold.x, gt.hold.y, gt.hold.w, gt.hold.h, 3); g.fill(); }
    g.strokeStyle = 'rgba(148,163,184,0.28)'; g.lineWidth = 2.2;
    g.beginPath(); for (const gt of p.gates) { g.moveTo(gt.bridgeA.x, gt.bridgeA.y); g.lineTo(gt.door.x, gt.door.y); } g.stroke();
    // Arrivals lane on the lower level of the pier.
    g.strokeStyle = 'rgba(251,146,60,0.22)'; g.lineWidth = 0.8; g.setLineDash([3, 3]);
    for (const br of p.branches) { const lane = []; for (let i = 0; i < br.pts.length; i++) lane.push(br.at(br.cum[i], -4, {})); polyStroke(g, lane); }
    g.setLineDash([]);
  }
  g.lineJoin = 'miter'; g.lineCap = 'butt';
  // Airside link, staff search, US preclearance annex.
  g.fillStyle = '#121d33'; g.strokeStyle = '#2a3a5a'; g.lineWidth = 1.1 * px;
  rr(g, AIRSIDE_LINK.x, AIRSIDE_LINK.y, AIRSIDE_LINK.w, AIRSIDE_LINK.h, 4); g.fill(); g.stroke();
  rr(g, STAFF_SEARCH.x, STAFF_SEARCH.y, STAFF_SEARCH.w, STAFF_SEARCH.h, 4); g.fill(); g.stroke();
  g.fillStyle = 'rgba(234,179,8,0.06)'; rr(g, STAFF_SEARCH.x + 2, STAFF_SEARCH.y + 2, STAFF_SEARCH.w - 4, STAFF_SEARCH.h - 4, 3); g.fill();
  g.strokeStyle = 'rgba(234,179,8,0.25)'; g.lineWidth = 0.8; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(STAFF_SEARCH.footX, STAFF_SEARCH.y + STAFF_SEARCH.h); g.lineTo(STAFF_SEARCH.footX, 1475); g.stroke(); g.setLineDash([]);
  const pc = GEO.t2.preclear;
  g.fillStyle = '#121d33'; g.strokeStyle = '#2a3a5a';
  rr(g, pc.x, pc.y, pc.w + 20, pc.h, 6); g.fill(); g.stroke();
  g.fillStyle = 'rgba(52,211,153,0.06)'; rr(g, pc.lounge.x, pc.lounge.y, pc.lounge.w, pc.lounge.h, 4); g.fill();
  g.fillStyle = 'rgba(251,191,36,0.06)'; rr(g, pc.cbp.x, pc.cbp.y, pc.cbp.w, pc.cbp.h, 4); g.fill();

  for (const k of TERMS) drawTerminalStatic(g, GEO[k], px);
  drawRoadsStatic(g, px);
  drawCarparksStatic(g, px);
  drawOutletsStatic(g, px);
}

function drawTerminalStatic(g, G, px) {
  const b = G.building;
  // Departures level.
  g.fillStyle = '#101a2e'; g.strokeStyle = '#31446a'; g.lineWidth = 1.3 * px;
  rr(g, b.x, b.y, b.w, b.h, 10); g.fill(); g.stroke();
  g.fillStyle = 'rgba(52,211,153,0.04)'; rr(g, G.lounge.x, G.lounge.y, G.lounge.w, G.lounge.h, 6); g.fill();
  g.fillStyle = 'rgba(245,158,11,0.07)'; g.strokeStyle = 'rgba(245,158,11,0.25)'; g.lineWidth = px;
  rr(g, G.df.x, G.df.y, G.df.w, G.df.h, 4); g.fill(); g.stroke();
  g.fillStyle = 'rgba(192,132,252,0.08)'; rr(g, G.ftX - 8, Y.snake - 3, 14, 58, 3); g.fill();
  g.fillStyle = 'rgba(251,191,36,0.06)'; rr(g, G.secBand.x, G.secBand.y, G.secBand.w, G.secBand.h, 4); g.fill();
  g.fillStyle = 'rgba(192,132,252,0.10)'; rr(g, G.fcs.x, G.fcs.y, G.fcs.w, G.fcs.h + 30, 3); g.fill();
  g.fillStyle = 'rgba(125,211,252,0.035)'; rr(g, G.hall.x, G.hall.y, G.hall.w, G.hall.h, 6); g.fill();
  g.fillStyle = 'rgba(125,211,252,0.05)'; rr(g, G.food.x, G.food.y, G.food.w, 58, 4); g.fill();
  const sn = G.snake;
  g.strokeStyle = 'rgba(148,163,184,0.13)'; g.lineWidth = 0.5;
  g.beginPath();
  for (let r = 0; r < sn.rows - 1; r++) {
    const y = sn.y0 + r * sn.gap + sn.gap / 2, gapRight = r % 2 === 0;
    const xa = r === 0 ? sn.hx - 6 : sn.x0 - 2, xb = sn.x1 + 2;
    if (gapRight) { g.moveTo(xa, y); g.lineTo(xb - 10, y); } else { g.moveTo(xa + 10, y); g.lineTo(xb, y); }
  }
  g.stroke();
  for (const c of G.checkin) {
    g.fillStyle = 'rgba(167,139,250,0.10)'; rr(g, c.x0 - 6, 711, c.x1 - c.x0 + 12, 10, 3); g.fill();
    g.fillStyle = 'rgba(167,139,250,0.35)';
    for (const p of c.deskPos) g.fillRect(p.x - 1.2, 713.5, 2.4, 5);
  }
  // Bag collector belt and shaft (below the floor).
  g.strokeStyle = 'rgba(167,139,250,0.22)'; g.lineWidth = 0.8; g.setLineDash([2, 3]);
  polyStroke(g, [{ x: G.checkin[1].x1, y: Y.desk + 8 }, { x: G.shaftX, y: Y.desk + 8 }, { x: G.shaftX, y: Y.base + 14 }]);
  g.setLineDash([]);
  g.strokeStyle = 'rgba(125,211,252,0.7)'; g.lineWidth = 2.2;
  g.beginPath(); for (const d of G.doors) { g.moveTo(d.x - 11, d.y); g.lineTo(d.x + 11, d.y); } g.stroke();
  // Sterile arrivals corridor (lower level).
  g.strokeStyle = 'rgba(251,146,60,0.35)'; g.lineWidth = 1; g.setLineDash([4, 3]);
  polyStroke(g, [{ x: b.x + 10, y: 482 }, { x: G.corrX, y: 482 }, { x: G.corrX, y: Y.arrTop }]);
  g.setLineDash([]);
  // Arrivals level.
  const ab = G.arrBuilding;
  g.fillStyle = '#101a2e'; g.strokeStyle = '#3b3a5c'; g.lineWidth = 1.3 * px;
  rr(g, ab.x, ab.y, ab.w, ab.h, 10); g.fill(); g.stroke();
  g.fillStyle = 'rgba(248,113,113,0.05)'; rr(g, ab.x + 6, 914, ab.w - 12, 70, 4); g.fill();
  g.fillStyle = 'rgba(250,204,21,0.04)'; rr(g, ab.x + 6, Y.reclaimTop, ab.w - 12, 78, 4); g.fill();
  g.fillStyle = 'rgba(251,146,60,0.05)'; rr(g, G.arrHall.x, G.arrHall.y, G.arrHall.w, G.arrHall.h, 4); g.fill();
  for (const ch of ['non', 'eu', 'egate']) {
    const c = G.imm[ch];
    g.strokeStyle = 'rgba(248,113,113,0.18)'; g.lineWidth = 0.5;
    g.beginPath();
    for (let r = 0; r < c.snake.rows - 1; r++) { const y = c.snake.y0 - r * c.snake.gap - c.snake.gap / 2; g.moveTo(c.x0, y); g.lineTo(c.x1, y); }
    g.stroke();
    g.strokeStyle = 'rgba(248,113,113,0.28)'; g.lineWidth = 0.8; g.beginPath(); g.moveTo(c.x0, Y.immBooth + 4); g.lineTo(c.x1, Y.immBooth + 4); g.stroke();
  }
  for (const c of G.carousels) {
    g.strokeStyle = c.large ? 'rgba(250,204,21,0.45)' : 'rgba(250,204,21,0.30)'; g.lineWidth = 2.4;
    polyStroke(g, c.loop.pts);
    g.fillStyle = 'rgba(250,204,21,0.05)'; rr(g, c.x - c.w / 2 + 3, c.y - c.h / 2 + 3, c.w - 6, c.h - 6, 5); g.fill();
  }
  g.strokeStyle = 'rgba(148,163,184,0.25)'; g.lineWidth = 0.8;
  g.beginPath(); g.moveTo(ab.x + 6, Y.customs - 6); g.lineTo(ab.x + ab.w - 6, Y.customs - 6); g.moveTo(ab.x + 6, Y.customs + 7); g.lineTo(ab.x + ab.w - 6, Y.customs + 7); g.stroke();
  const chCol = { blue: '#60a5fa', green: '#4ade80', red: '#f87171' };
  for (const [n, c] of Object.entries(chCol)) { const p = G.customs[n]; g.fillStyle = c; g.globalAlpha = 0.6; g.fillRect(p.x - 12, p.y - 6, 24, 2); g.globalAlpha = 1; }
  g.strokeStyle = 'rgba(251,146,60,0.45)'; g.lineWidth = 1; g.beginPath(); g.moveTo(ab.x + 10, Y.rail); g.lineTo(ab.x + ab.w - 10, Y.rail); g.stroke();
  g.fillStyle = 'rgba(148,163,184,0.35)';
  for (const d of G.rentalDesks) g.fillRect(d.x - 2.5, d.y, 5, 3);
  g.strokeStyle = 'rgba(251,146,60,0.7)'; g.lineWidth = 2.2;
  g.beginPath(); for (const d of G.arrDoors) { g.moveTo(d.x - 10, d.y); g.lineTo(d.x + 10, d.y); } g.stroke();
  // Baggage basement.
  const bs = G.base;
  g.fillStyle = '#0d1526'; g.strokeStyle = '#2a3654'; g.lineWidth = 1.1 * px;
  rr(g, bs.x, bs.y, bs.w, bs.h, 8); g.fill(); g.stroke();
  g.strokeStyle = 'rgba(167,139,250,0.35)'; g.lineWidth = 1.6; polyStroke(g, G.sorter.pts);
  g.fillStyle = 'rgba(167,139,250,0.25)';
  for (const h of G.hbs) rr(g, h.x - 8, h.y - 6, 16, 12, 2), g.fill();
  for (const l of G.laterals) { g.fillStyle = 'rgba(148,163,184,0.10)'; rr(g, l.x, l.y, l.w, l.h, 3); g.fill(); }
  g.fillStyle = 'rgba(148,163,184,0.07)'; rr(g, G.ebs.x, G.ebs.y, G.ebs.w, G.ebs.h, 3); g.fill();
}

function drawRoadsStatic(g, px) {
  // Footways and lay-bys.
  g.fillStyle = 'rgba(148,163,184,0.06)';
  rr(g, 190, 842, 1010, 14, 3); g.fill(); rr(g, 190, 1144, 1010, 14, 3); g.fill();
  g.fillStyle = 'rgba(148,163,184,0.045)';
  rr(g, 197, 858, 996, 11, 2); g.fill(); rr(g, 185, 1159, 1020, 11, 2); g.fill();
  // Road surfaces.
  g.strokeStyle = '#111b2e'; g.lineWidth = 12; g.lineCap = 'round';
  for (const p of Object.values(ROADS)) polyStroke(g, p.pts);
  g.lineCap = 'butt';
  g.strokeStyle = 'rgba(148,163,184,0.14)'; g.lineWidth = 0.6; g.setLineDash([6, 6]);
  for (const p of Object.values(ROADS)) polyStroke(g, p.pts);
  g.setLineDash([]);
  // Kerb slot ticks, bus bays and taxi rank bays.
  g.strokeStyle = 'rgba(148,163,184,0.18)'; g.lineWidth = 0.5;
  g.beginPath();
  for (const k of TERMS) for (const b of GEO[k].bays.kerb) { g.moveTo(b.x - 4.5, 858); g.lineTo(b.x - 4.5, 869); }
  g.stroke();
  for (const k of TERMS) {
    const B = GEO[k].bays;
    g.fillStyle = 'rgba(34,197,94,0.18)';
    for (const b of [...B.depBus, ...B.arrBus]) g.fillRect(b.x - 7, b.y - 4, 14, 8);
    g.fillStyle = 'rgba(59,130,246,0.18)';
    for (const b of B.arrShuttle) g.fillRect(b.x - 6, b.y - 4, 12, 8);
    g.fillStyle = 'rgba(250,204,21,0.16)';
    for (const b of B.rank) g.fillRect(b.x - 4, b.y - 4, 8, 8);
    // Zebra crossings in front of the doors.
    g.fillStyle = 'rgba(226,232,240,0.10)';
    for (const d of GEO[k].doors) for (let i = 0; i < 5; i++) g.fillRect(d.x - 9, 870 + i * 4.6, 18, 2.4);
    for (const d of GEO[k].arrDoors) for (let i = 0; i < 5; i++) g.fillRect(d.x - 9, 1176 + i * 4.6, 18, 2.4);
  }
  void px;
}
function drawCarparksStatic(g, px) {
  const all = [...Object.values(CARPARKS), TAXI_HOLDING];
  for (const cp of all) {
    const r = cp.rect;
    g.fillStyle = '#0a1322'; g.strokeStyle = cp.inset ? 'rgba(59,130,246,0.45)' : '#1d2a44'; g.lineWidth = 1.1 * px;
    if (cp.inset) g.setLineDash([6, 4]);
    rr(g, r.x, r.y, r.w, r.h, 6); g.fill(); g.stroke(); g.setLineDash([]);
    g.strokeStyle = 'rgba(148,163,184,0.08)'; g.lineWidth = px;
    g.beginPath();
    const step = r.h > 200 ? 18 : 12;
    for (let y = r.y + 10; y < r.y + r.h - 6; y += step) { g.moveTo(r.x + 6, y); g.lineTo(r.x + r.w - 6, y); }
    g.stroke();
    // Driveway to the ring road.
    g.strokeStyle = '#111b2e'; g.lineWidth = 6;
    const ry = r.y > 1400 ? 1460 : 1440, ey = r.y > 1400 ? r.y : r.y + r.h;
    g.beginPath(); g.moveTo(cp.drive, ey); g.lineTo(cp.drive, ry); g.stroke();
  }
  // Pedestrian links from the flank car parks into the terminals.
  g.strokeStyle = 'rgba(125,211,252,0.25)'; g.lineWidth = 1.2; g.setLineDash([3, 3]);
  for (const k of TERMS) {
    const G = GEO[k], l = G.link;
    g.beginPath(); g.moveTo(l.dep.x, l.dep.y); g.lineTo(l.wall, l.dep.y); g.moveTo(l.arr.x, l.arr.y); g.lineTo(l.wall, l.arr.y); g.stroke();
  }
  g.setLineDash([]);
}
function drawOutletsStatic(g, px) {
  for (const o of OUTLETS) {
    if (o.walk) continue;
    const c = CATS[o.cat] ? CATS[o.cat].color : '#64748b';
    g.fillStyle = c + '14'; g.strokeStyle = c + '55'; g.lineWidth = 0.8 * px;
    rr(g, o.rect.x, o.rect.y, o.rect.w, o.rect.h, 2); g.fill(); g.stroke();
  }
}

/* ---------------- dynamic layer ---------------- */
function drawPlane(g, x, y, ang, alpha, hot, scale = 1, tint) {
  g.save(); g.translate(x, y); g.rotate(ang); g.scale(scale, scale); g.globalAlpha = alpha;
  g.fillStyle = tint || (hot ? '#e2e8f0' : '#9fb0c9');
  g.beginPath();
  g.moveTo(20, 0); g.quadraticCurveTo(19.5, -2.4, 15, -2.7); g.lineTo(-14, -2.4); g.lineTo(-19, -1.2); g.lineTo(-20.5, 0); g.lineTo(-19, 1.2); g.lineTo(-14, 2.4); g.lineTo(15, 2.7); g.quadraticCurveTo(19.5, 2.4, 20, 0); g.closePath();
  g.moveTo(6, -2.4); g.lineTo(-5.5, -18); g.lineTo(-9.5, -18); g.lineTo(-3.5, -2.4); g.closePath();
  g.moveTo(6, 2.4); g.lineTo(-5.5, 18); g.lineTo(-9.5, 18); g.lineTo(-3.5, 2.4); g.closePath();
  g.moveTo(-14, -2); g.lineTo(-18.5, -7.5); g.lineTo(-20.5, -7.5); g.lineTo(-18.5, -1.5); g.closePath();
  g.moveTo(-14, 2); g.lineTo(-18.5, 7.5); g.lineTo(-20.5, 7.5); g.lineTo(-18.5, 1.5); g.closePath();
  g.fill();
  g.restore();
}
function drawAircraft(g, t) {
  for (const [gt, list] of gen.gateStays) {
    for (const st of list) {
      if (t < st.from - 180 || t > st.to + 150) continue;
      const ac = st.dep || st.arr, sc = ac.wide ? 1.22 : ac.seats < 100 ? 0.7 : 1;
      let alpha = 0.75, x = gt.plane.x, y = gt.plane.y;
      const c = Math.cos(gt.plane.ang), sn = Math.sin(gt.plane.ang);
      x -= c * (sc - 1) * 20; y -= sn * (sc - 1) * 20;
      // Taxiing in on arrival, pushing back on departure.
      const onBlock = st.arr && st.part !== 'out' ? st.arr.onBlock : null;
      if (onBlock && t < onBlock) { const p = clamp((onBlock - t) / 180, 0, 1); x -= c * p * 70; y -= sn * p * 70; alpha *= 1 - p * 0.6; }
      else if (!onBlock && t < st.from) continue;
      else if (!onBlock && t < st.from + 180) alpha *= clamp((t - st.from) / 180, 0, 1);
      if (st.part === 'night' && t > st.to - 180) alpha *= clamp((st.to - t) / 180, 0, 1);
      const dep = st.dep && st.part !== 'in' ? st.dep.dep : null;
      if (dep && t > dep) { const p = clamp((t - dep) / 150, 0, 1); alpha *= 1 - p; x -= c * p * 30; y -= sn * p * 30; }
      if (st.part === 'in' && t > st.to) { const p = clamp((t - st.to) / 150, 0, 1); alpha *= 1 - p; }
      const boarding = dep && t > dep - 28 * 60 && t < dep;
      const deplaning = onBlock && t > onBlock && t < onBlock + 15 * 60;
      drawPlane(g, x, y, gt.plane.ang, alpha, boarding, sc);
      if (boarding || deplaning) {
        g.fillStyle = boarding ? 'rgba(244,114,182,0.55)' : 'rgba(251,146,60,0.6)';
        g.beginPath(); g.arc(gt.door.x, gt.door.y, 2.2 + Math.sin(t / 8) * 0.6, 0, 7); g.fill();
      }
      break;
    }
  }
  for (const [stand, list] of gen.remoteStays) for (const st of list) {
    if (t < st.from || t > st.to) continue;
    drawPlane(g, stand.plane.x, stand.plane.y, 0, 0.6, false, st.dep.wide ? 1.22 : 1);
  }
}
function drawServers(g, t) {
  const lit = (x, y, w, h, rgb, on, flash) => {
    if (!on) { g.fillStyle = 'rgba(100,116,139,0.22)'; g.fillRect(x - w / 2, y - h / 2, w, h); return; }
    const hot = clamp(1 - (t - flash) / 20, 0, 1);
    g.fillStyle = `rgba(${rgb},${0.45 + hot * 0.5})`; g.fillRect(x - w / 2, y - h / 2, w, h);
  };
  for (const k of TERMS) {
    const ts = sim.ts[k], G = GEO[k];
    ts.lanes.forEach((L, li) => lit(L.x, L.y, 4.4, 20, li < FT_LANES ? '192,132,252' : '45,212,191', L.open, L.flash));
    for (const L of ts.fcs.lanes) lit(L.x, L.y, 4, 16, '192,132,252', true, L.flash);
    for (const c of ts.chk) for (const d of c.desks) if (d.busy > t) { g.fillStyle = 'rgba(196,181,253,0.85)'; g.fillRect(d.x - 1.2, 713.5, 2.4, 5); }
    for (const ch of ['non', 'eu', 'egate']) for (const b of ts.imm[ch].booths) lit(b.x, b.y + 1, ch === 'egate' ? 2.6 : 3.6, 6, ch === 'egate' ? '96,165,250' : '248,113,113', b.open, b.flash);
    for (const d of ts.rental.desks) if (d.busy > t) { g.fillStyle = 'rgba(203,213,225,0.8)'; g.fillRect(d.x - 2.5, d.y, 5, 3); }
    for (const till of sim.df[k].tills) if (till.busy > t) { g.fillStyle = 'rgba(245,158,11,0.8)'; g.fillRect(till.x - 1.5, till.y - 1.5, 3, 3); }
    // Laterals: bag stacks by flight; early-bag store.
    const bk = sim.bags[k];
    for (const l of bk.laterals) {
      let n = 0; for (const f of l.flights) n += f.bagsIn;
      if (!n) continue;
      const h = Math.min(l.h - 4, n * 0.9);
      g.fillStyle = 'rgba(167,139,250,0.65)'; g.fillRect(l.x + 2, l.y + l.h - 2 - h, l.w - 4, h);
    }
    let ebs = 0; for (const v of bk.ebs.values()) ebs += v;
    if (ebs) { g.fillStyle = 'rgba(148,163,184,0.5)'; const h = Math.min(G.ebs.h - 4, ebs * 0.25); g.fillRect(G.ebs.x + 4, G.ebs.y + G.ebs.h - 2 - h, G.ebs.w - 8, h); }
    for (const h of G.hbs) { g.fillStyle = bk.hbsQ.length ? 'rgba(167,139,250,0.9)' : 'rgba(167,139,250,0.35)'; g.fillRect(h.x - 3, h.y - 3, 6, 6); }
  }
  for (const L of sim.staff.lanes) lit(L.x, L.y, 3.6, 12, '234,179,8', true, L.flash);
}
function drawCarparkFill(g) {
  for (const [id, c] of Object.entries(sim.carparks)) {
    const r = CARPARKS[id].rect, f = clamp(c.occ / c.cap, 0, 1);
    const h = (r.h - 8) * f;
    g.fillStyle = f > 0.95 ? 'rgba(244,63,94,0.20)' : f > 0.85 ? 'rgba(251,191,36,0.16)' : 'rgba(96,165,250,0.12)';
    g.fillRect(r.x + 4, r.y + r.h - 4 - h, r.w - 8, h);
  }
  const hr = TAXI_HOLDING.rect, hf = clamp(sim.taxi.holding / TAXI.holdingCap, 0, 1);
  g.fillStyle = 'rgba(250,204,21,0.18)'; g.fillRect(hr.x + 4, hr.y + hr.h - 4 - (hr.h - 8) * hf, hr.w - 8, (hr.h - 8) * hf);
}
function drawVehicles(g, s) {
  for (const v of sim.vehicles) {
    if (v.state === 'wait' || v.state === 'done' || v.s < 0) continue;
    g.save(); g.translate(v.x, v.y); g.rotate(v.state === 'bay' ? 0 : v.ang || 0);
    g.fillStyle = v.color;
    const w = v.len, h = v.type === 'bus' || v.type === 'hb' || v.type === 'rental' ? 2.6 : 1.9;
    rr(g, -w / 2, -h / 2, w, h, Math.min(0.9, h / 2)); g.fill();
    g.restore();
  }
  for (const tg of sim.bags.tugs) {
    g.fillStyle = tg.color ? '#fb923c' : '#a78bfa';
    g.save(); g.translate(tg.x, tg.y); g.rotate(tg.ang || 0); g.fillRect(-1.8, -1, 3.6, 2); g.fillStyle = 'rgba(203,213,225,0.7)'; g.fillRect(-7, -1, 4.2, 2); g.restore();
  }
  void s;
}
function drawBags(g, s) {
  if (s < 0.9) return;
  const sz = clamp(1.6, 1.2, 2);
  for (const b of sim.bags.moving) {
    if (b.s < 0) continue;
    g.fillStyle = b.color === 2 ? '#f43f5e' : b.color === 1 ? '#fbbf24' : '#c4b5fd';
    g.fillRect(b.x - sz / 2, b.y - sz / 2, sz, sz);
  }
  g.fillStyle = '#fbbf24';
  for (const b of sim.bags.belt) { b.c.loop.loop(b.s, tmp); g.fillRect(tmp.x - sz / 2, tmp.y - sz / 2, sz, sz); }
}

/* ---------------- people ---------------- */
const sprites = {};
function sprite(hex, ring) {
  const key = hex + (ring ? 'r' : '');
  if (sprites[key]) return sprites[key];
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d'), r = parseInt(hex.slice(1, 3), 16), gg = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
  if (ring) {
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, `rgba(${r},${gg},${b},0.05)`); grd.addColorStop(0.22, `rgba(${r},${gg},${b},0.15)`);
    grd.addColorStop(0.3, `rgba(${r},${gg},${b},1)`); grd.addColorStop(0.4, `rgba(${r},${gg},${b},0.9)`);
    grd.addColorStop(0.5, `rgba(${r},${gg},${b},0.2)`); grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  } else {
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, `rgba(${Math.min(255, r + 60)},${Math.min(255, gg + 60)},${Math.min(255, b + 60)},1)`);
    grd.addColorStop(0.3, `rgba(${r},${gg},${b},0.95)`);
    grd.addColorStop(0.42, `rgba(${r},${gg},${b},0.22)`);
    grd.addColorStop(1, `rgba(${r},${gg},${b},0)`);
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
  }
  return (sprites[key] = c);
}
function agentZone(a) {
  if (a.stage === FOLLOW && a.leader) return STAGE_ZONE[a.leader.stage] >= 0 ? STAGE_ZONE[a.leader.stage] : 0;
  const z = STAGE_ZONE[a.stage]; return z >= 0 ? z : 0;
}
function agentColor(a) {
  switch (state.colorMode) {
    case 'term': return TERM_COLORS[a.ti];
    case 'persona': return a.kind === KIND.STF ? KINDS[KIND.STF].color : a.kind === KIND.GRT ? KINDS[KIND.GRT].color : a.pm.color;
    case 'market': return a.market ? MARKETS[a.market].color : '#64748b';
    case 'flow': return KINDS[a.kind].color;
    case 'wait': {
      if (a.missed) return WAIT_COLORS[4];
      let w = a.kind === KIND.ARR ? (a.leader ? a.leader.immWait : a.immWait) : a.wait;
      if (a.stage === ST.D_SEC_Q || a.stage === ST.A_IMM_Q) w = sim.t - a.qJoin;
      if (w == null || w < 0) return WAIT_COLORS[0];
      return w < 600 ? WAIT_COLORS[1] : w < 1200 ? WAIT_COLORS[2] : w < 1800 ? WAIT_COLORS[3] : WAIT_COLORS[4];
    }
  }
  return ZONES[agentZone(a)].color;
}
function drawPeople(g, s) {
  const al = sim.alive, px = 8.5 * Math.sqrt(s);
  const vx0 = -view.ox / s - 10, vy0 = -view.oy / s - 10, vx1 = (view.cw - view.ox) / s + 10, vy1 = (view.ch - view.oy) / s + 10;
  if (px < 5.5) {
    // Zoomed out: batch tiny squares by colour.
    const buckets = new Map(), d = Math.max(1.6, 2.4 / s * 0.9) ;
    for (let i = 0; i < al.length; i++) {
      const a = al[i]; if (a.hidden || a.x < vx0 || a.x > vx1 || a.y < vy0 || a.y > vy1) continue;
      const c = agentColor(a); let b = buckets.get(c); if (!b) buckets.set(c, b = []); b.push(a);
    }
    for (const [c, list] of buckets) {
      g.fillStyle = c; g.beginPath();
      for (const a of list) { if (a.kind === KIND.ARR || a.kind === KIND.GRT) { g.moveTo(a.x + d * 0.55, a.y); g.arc(a.x, a.y, d * 0.55, 0, 6.3); } else g.rect(a.x - d / 2, a.y - d / 2, d, d); }
      g.fill();
    }
    return;
  }
  const size = clamp(px, 6, 20) / s, half = size / 2;
  for (let i = 0; i < al.length; i++) {
    const a = al[i]; if (a.hidden || a.x < vx0 || a.x > vx1 || a.y < vy0 || a.y > vy1) continue;
    g.drawImage(sprite(agentColor(a), a.kind === KIND.ARR || a.kind === KIND.GRT), a.x - half, a.y - half, size, size);
  }
}

function renderMap(now) {
  const g = mctx, dpr = view.dpr;
  if (!mapCv.width || !mapCv.height) return;
  stepCamera(now || performance.now());
  const s = view.s;
  const key = `${siteOn() ? 'site' : 'twin'}:${mapCv.width}x${mapCv.height}:${s.toFixed(4)}:${view.ox.toFixed(1)}:${view.oy.toFixed(1)}`;
  if (key !== bgKey) {
    bgKey = key;
    if (!bgCache) bgCache = document.createElement('canvas');
    bgCache.width = mapCv.width; bgCache.height = mapCv.height;
    const bg = bgCache.getContext('2d');
    bg.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.ox, dpr * view.oy);
    siteOn() ? drawSiteStatic(bg) : drawStatic(bg);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(bgCache, 0, 0);
  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * view.ox, dpr * view.oy);
  const t = sim.t;
  if (siteOn()) {
    drawSiteAircraft(g, t);
    drawSitePeople(g, s);
    const sel = state.selected;
    if (sel && sel.stage !== DONE && Number.isFinite(sel._sx)) {
      g.strokeStyle = '#fff'; g.lineWidth = 1.6 / s;
      g.beginPath(); g.arc(sel._sx, sel._sy, (7 + Math.sin(performance.now() / 180) * 1.5) / s, 0, 7); g.stroke();
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); labelBoxes = [];
    drawSiteLabels(g);
    drawWeatherFx(g, now || performance.now());
    return;
  }
  drawCarparkFill(g);
  drawAircraft(g, t);
  drawServers(g, t);
  drawVehicles(g, s);
  drawBags(g, s);
  drawPeople(g, s);
  const sel = state.selected;
  if (sel && sel.stage !== DONE) {
    g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1 / s; g.setLineDash([4 / s, 4 / s]);
    g.beginPath(); g.moveTo(sel.x, sel.y);
    if (sel.path) for (let i = sel.pi; i < sel.path.length; i++) g.lineTo(sel.path[i].x, sel.path[i].y);
    g.stroke(); g.setLineDash([]);
    const pulse = 7 + Math.sin(performance.now() / 180) * 1.5;
    g.strokeStyle = '#fff'; g.lineWidth = 1.6 / s;
    g.beginPath(); g.arc(sel.x, sel.y, pulse / s, 0, 7); g.stroke();
  }
  drawLabels(g);
  drawWeatherFx(g, now || performance.now());
}

/* ---------------- labels ---------------- */
let labelBoxes = [];
function canPlace(x, y, w, h) {
  for (const b of labelBoxes) if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
  labelBoxes.push([x, y, w, h]); return true;
}
function label(g, text, x, y, opt = {}) {
  const p = toScreen(x, y);
  if (p.x < -200 || p.y < -40 || p.x > view.cw + 200 || p.y > view.ch + 40) return;
  const size = opt.size || 10;
  g.font = `${opt.weight || 600} ${size}px Inter, sans-serif`;
  if (opt.ls) g.letterSpacing = opt.ls;
  const w = g.measureText(text).width;
  const ax = opt.align === 'center' ? p.x - w / 2 : opt.align === 'right' ? p.x - w : p.x;
  if (!opt.force && !canPlace(ax - 2, p.y - size / 2 - 1, w + 4, size + 2)) { if (opt.ls) g.letterSpacing = '0px'; return; }
  g.textAlign = opt.align || 'left'; g.textBaseline = 'middle';
  g.fillStyle = opt.color || 'rgba(148,163,184,0.75)';
  g.fillText(text, p.x, p.y);
  if (opt.ls) g.letterSpacing = '0px';
}
function badge(g, x, y, lines, color, align) {
  const p = toScreen(x, y);
  if (p.x < -200 || p.y < -40 || p.x > view.cw + 200 || p.y > view.ch + 40) return;
  g.font = '600 11px "JetBrains Mono", monospace';
  const w1 = g.measureText(lines[0]).width;
  g.font = '500 9.5px Inter, sans-serif';
  const w2 = lines[1] ? g.measureText(lines[1]).width : 0;
  const w = Math.max(w1, w2) + 16, h = lines[1] ? 34 : 22;
  const bx = align === 'right' ? p.x - w : align === 'center' ? p.x - w / 2 : p.x, by = p.y - h / 2;
  if (!canPlace(bx, by, w, h)) return;
  g.fillStyle = 'rgba(8,14,27,0.88)'; g.strokeStyle = color; g.lineWidth = 1;
  g.beginPath(); g.roundRect ? g.roundRect(bx, by, w, h, 7) : g.rect(bx, by, w, h); g.fill(); g.stroke();
  g.fillStyle = color; g.beginPath(); g.arc(bx + 8, by + 11, 2.6, 0, 7); g.fill();
  g.textAlign = 'left'; g.textBaseline = 'middle';
  g.font = '600 11px "JetBrains Mono", monospace'; g.fillStyle = '#e6edf7'; g.fillText(lines[0], bx + 14, by + 11);
  if (lines[1]) { g.font = '500 9.5px Inter, sans-serif'; g.fillStyle = '#8b9bb6'; g.fillText(lines[1], bx + 8, by + 25); }
}
function drawLabels(g) {
  const dpr = view.dpr, s = view.s, t = sim.t;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  labelBoxes = [];
  const cnt = liveCounts();
  // Live badges first (they win the space).
  for (const k of TERMS) {
    const G = GEO[k], ts = sim.ts[k];
    const q = ts.secQ.length, cap = ts.openN * LANE_RATE / 60, wmin = cap > 0 ? q / cap : (q ? 99 : 0);
    badge(g, G.laneX1 + 12, Y.sec, [cap > 0 ? `~${Math.round(wmin)} min` : 'closed', `${fmtInt(q)} queuing`], waitColor(wmin), 'left');
    const iw = immWaitNow(ts), iq = sizeOfQueue(ts.imm.eu.q) + sizeOfQueue(ts.imm.non.q) + sizeOfQueue(ts.imm.egate.q);
    badge(g, G.arrBuilding.x + G.arrBuilding.w - 6, 936, [`~${Math.round(iw)} min`, `${fmtInt(iq)} at passports`], waitColor(iw), 'right');
    const tq = sim.taxi.q[k].length, tw = tq ? (t - sim.taxi.q[k].peek().qJoin) / 60 : 0;
    badge(g, G.arr.rank[0] - 8, 1214, [`${tq} parties · ${G.bays.rank.filter(b => b.veh && b.veh.state === 'bay').length} taxis`, 'taxi rank'], waitColor(tw), 'left');
  }
  label(g, `TAXI HOLDING · ${sim.taxi.holding}`, TAXI_HOLDING.rect.x + TAXI_HOLDING.rect.w / 2, TAXI_HOLDING.rect.y - 8, { size: 9, align: 'center', color: 'rgba(250,204,21,0.85)', ls: '1px' });
  for (const [id, c] of Object.entries(sim.carparks)) {
    const cp = CARPARKS[id], r = cp.rect, f = c.occ / c.cap;
    label(g, `${cp.name.toUpperCase()}${cp.inset ? ' (REMOTE)' : ''}`, r.x + r.w / 2, r.y + 12, { size: 9, align: 'center', color: 'rgba(203,213,225,0.75)', ls: '1px' });
    label(g, `${fmtInt(c.occ)} / ${fmtInt(c.cap)} · ${Math.round(f * 100)}%`, r.x + r.w / 2, r.y + 26, { size: 9, weight: 500, align: 'center', color: f > 0.95 ? '#fb7185' : f > 0.85 ? '#fbbf24' : 'rgba(148,163,184,0.85)' });
  }
  for (const k of TERMS) {
    const G = GEO[k], c = cnt[k];
    label(g, `${G.name.toUpperCase()} · DEPARTURES`, G.building.x + 10, G.building.y + G.building.h - 9, { size: 11, weight: 700, color: 'rgba(230,237,247,0.85)', ls: '2px' });
    label(g, `${G.short} ARRIVALS`, G.arrBuilding.x + 10, G.arrBuilding.y + G.arrBuilding.h - 8, { size: 11, weight: 700, color: 'rgba(253,186,116,0.85)', ls: '2px' });
    label(g, `${G.short} BAGGAGE HALL`, G.base.x + 10, G.base.y + 10, { size: 9.5, weight: 700, color: 'rgba(196,181,253,0.8)', ls: '1.5px' });
    label(g, `DEPARTURES LOUNGE · ${fmtInt(c.zone[Z.LOUNGE])}`, G.lounge.x + 4, G.lounge.y - 5, { size: 9, color: 'rgba(52,211,153,0.85)', ls: '1px' });
    label(g, 'DUTY FREE', G.df.x + G.df.w / 2, G.df.y + G.df.h - 6, { size: 8.5, align: 'center', color: 'rgba(245,158,11,0.8)', ls: '1px' });
    label(g, 'SECURITY', G.secBand.x + 4, G.secBand.y + 6, { size: 8.5, color: 'rgba(251,191,36,0.85)', ls: '1.5px' });
    label(g, 'PASSPORT CONTROL', G.arrBuilding.x + 8, 918, { size: 8.5, color: 'rgba(248,113,113,0.85)', ls: '1px' });
    label(g, `BAGGAGE RECLAIM · ${fmtInt(c.zone[Z.RECLAIM])}`, G.arrBuilding.x + 8, Y.reclaimTop + 4, { size: 8.5, color: 'rgba(250,204,21,0.85)', ls: '1px' });
    label(g, `ARRIVALS HALL · ${fmtInt(c.zone[Z.HALL])}`, G.arrBuilding.x + 8, 1084 + 3, { size: 8.5, color: 'rgba(251,146,60,0.85)', ls: '1px' });
      for (const p of G.piers) {
      const n = c.pier[p.id] || 0, br = p.branches[0], tip = br.pts[br.pts.length - 1], up = tip.y <= p.root.y - 20;
      label(g, `${p.name.toUpperCase()} · ${fmtInt(n)}`, tip.x + (up ? 0 : -14), up ? tip.y - (p.end || PIER_HW) - 9 : tip.y + 16, { size: 10, align: up ? 'center' : 'right', color: 'rgba(244,114,182,0.95)', ls: '1px' });
    }
    if (G.preclear) label(g, `US PRECLEARANCE · ${c.pre}`, G.preclear.x + G.preclear.w / 2 + 10, G.preclear.y - 8, { size: 8.5, align: 'center', color: 'rgba(52,211,153,0.85)', ls: '0.8px' });
    if (s > 0.75) {
      for (const car of G.carousels) {
        const fl = car.flights[0];
        label(g, fl ? `${car.id} · ${fl.code}` : String(car.id), car.x, car.y, { size: 8.5, weight: fl ? 700 : 500, align: 'center', color: fl ? '#fde68a' : 'rgba(250,204,21,0.45)' });
      }
      for (const ch of ['non', 'eu', 'egate']) label(g, { non: 'NON-EU', eu: 'EU / UK / EEA', egate: 'eGATES' }[ch], (G.imm[ch].x0 + G.imm[ch].x1) / 2, 970, { size: 8, align: 'center', color: 'rgba(248,113,113,0.7)', ls: '0.6px' });
      label(g, 'FLIGHT CONNECTIONS', G.fcs.x + G.fcs.w / 2, G.fcs.y - 4, { size: 7.5, align: 'center', color: 'rgba(192,132,252,0.85)' });
    }
    if (s > 0.55) for (const ch of G.checkin) label(g, ch.label.toUpperCase(), ch.x0 - 4, 704, { size: 8.5, color: 'rgba(167,139,250,0.85)', ls: '0.8px' });
    if (s > 1.15) for (const gt of [...G.gates, ...G.busGates]) label(g, gt.id, gt.lbl.x, gt.lbl.y, { size: 9, align: gt.lbl.align, color: gt.bus ? 'rgba(74,222,128,0.6)' : 'rgba(230,237,247,0.6)', weight: 500 });
  }
  if (s > 0.9) for (const o of OUTLETS) {
    if (o.walk) continue;
    const ro = sim.outlets[o.id], full = ro.occ >= o.cap;
    const txt = s > 1.6 ? `${o.name} · ${ro.occ}` : o.name;
    label(g, txt, o.rect.x + o.rect.w / 2, o.rect.y + o.rect.h / 2, { size: s > 1.6 ? 8.5 : 7.5, weight: 600, align: 'center', color: full ? '#fda4af' : 'rgba(226,232,240,0.78)' });
  }
  label(g, `STAFF SEARCH · ${sim.staff.q.length}`, STAFF_SEARCH.x + STAFF_SEARCH.w / 2, STAFF_SEARCH.y - 6, { size: 8.5, align: 'center', color: 'rgba(234,179,8,0.85)', ls: '0.8px' });
  label(g, 'UPPER ROAD · DEPARTURES', 700, Y.roadDep + 10, { size: 8.5, align: 'center', color: 'rgba(148,163,184,0.5)', ls: '1.5px' });
  label(g, 'LOWER ROAD · ARRIVALS', 700, Y.roadArr + 10, { size: 8.5, align: 'center', color: 'rgba(148,163,184,0.5)', ls: '1.5px' });
  label(g, 'RING ROAD', 700, 1470, { size: 8.5, align: 'center', color: 'rgba(148,163,184,0.45)', ls: '2px' });
  label(g, 'REMOTE STANDS · BY BUS · NOT TO SCALE', -118, 96, { size: 8.5, align: 'center', color: 'rgba(148,163,184,0.5)', ls: '1.2px' });
  if (s > 1.1) for (const r of REMOTE_STANDS) label(g, `${r.realGate ? r.realGate + ' · ' : ''}${r.id} · ${Math.round(r.busMin)}′ bus`, r.plane.x, r.plane.y - 24, { size: 8, align: 'center', color: 'rgba(148,163,184,0.6)', weight: 500 });
  label(g, 'RUNWAYS 10R/28L · 16/34 (SCHEMATIC)', -150, -175, { size: 9, color: 'rgba(148,163,184,0.4)', ls: '2px' });
  const sp = toScreen(WORLD.x + 14, WORLD.y + WORLD.h - 14), len = 100 * s;
  g.strokeStyle = 'rgba(148,163,184,0.5)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(sp.x, sp.y); g.lineTo(sp.x + len, sp.y); g.moveTo(sp.x, sp.y - 3); g.lineTo(sp.x, sp.y + 3); g.moveTo(sp.x + len, sp.y - 3); g.lineTo(sp.x + len, sp.y + 3); g.stroke();
  g.font = '500 9.5px Inter, sans-serif'; g.fillStyle = 'rgba(148,163,184,0.6)'; g.textAlign = 'left'; g.textBaseline = 'bottom';
  g.fillText('100 m · airside to scale, turned: real west ↑ · terminals schematic', sp.x, sp.y - 4);
}

let countsCache = null, countsAt = -1;
function liveCounts() {
  if (countsAt === sim.t && countsCache) return countsCache;
  const c = {};
  for (const k of TERMS) c[k] = { zone: new Array(ZONES.length).fill(0), kind: [0, 0, 0, 0, 0], pier: {}, pre: 0, total: 0 };
  c.kind = [0, 0, 0, 0, 0]; c.total = 0; c.staff = 0;
  for (const a of sim.alive) {
    if (a.hidden) continue;
    const o = c[a.term] || c.t1, z = agentZone(a);
    o.zone[z]++; o.total++; o.kind[a.kind]++; c.kind[a.kind]++; c.total++;
    if (z === Z.GATE && a.gate) o.pier[a.gate.pier] = (o.pier[a.gate.pier] || 0) + 1;
    if (a.stage === ST.D_PRE || a.stage === ST.D_TO_PRE || a.stage === ST.D_US) o.pre++;
  }
  countsAt = sim.t; countsCache = c;
  return c;
}
