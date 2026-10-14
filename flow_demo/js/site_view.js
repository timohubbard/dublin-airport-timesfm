'use strict';
/* ====================================================================
   Real map (key S): Dublin Airport as it is, north up, from OpenStreetMap
   (airport_geometry.py). Runways, taxiways, aprons, stands, terminals,
   piers, car parks and roads are drawn in true metres.

   Live on top, from the same simulation as the twin:
     aircraft    on their real stands (contact and remote)
     people      on piers and at gates, at their real positions (the twin's
                 piers are the real piers, turned); inside the terminals,
                 placed in the main hall's real footprint (both levels share
                 it, so the inside positions are approximate)
   ==================================================================== */
const SITE_RECT = { x: -1150, y: -1250, w: 2450, h: 2200 };
const SITE_FOCUS = { x: -200, y: -620, w: 1150, h: 1120 };
const siteOn = () => !!state.site;
const SITE = { hall: {} };
for (const k of TERMS) {
  const h = AG.halls && AG.halls[k]; if (!h) continue;
  // Corners: airside-south, airside-north, landside-south (the twin block's top-left, top-right, bottom-left).
  SITE.hall[k] = { o: { x: h[0][0], y: h[0][1] }, u: { x: h[1][0] - h[0][0], y: h[1][1] - h[0][1] }, v: { x: h[2][0] - h[0][0], y: h[2][1] - h[0][1] } };
}
// Real positions of stands for each twin gate, so aircraft sit where they really park.
for (const P of AG.piers) {
  const G = GEO[P.term];
  for (const g of P.gates) {
    const gt = G.gates.find(x => x.id === g.id && x.pier === P.id) || G.busGates.find(x => x.id === g.id);
    if (!gt) continue;
    gt.real = { x: g.x, y: g.y };
    gt.realPlane = g.stand ? { x: g.stand.plane[0], y: g.stand.plane[1], ang: g.stand.ang } : null;
  }
}
const twinToReal = (term, x, y) => ({ x: y - AG.twin[term].dy, y: AG.twin[term].dx - x });

/* Where a person in the twin is on the real map, or null if not shown. */
function siteXY(a, out) {
  const G = GEO[a.term] || GEO.t1, b = G.building, x = a.x, y = a.y;
  if (y < b.y - 2 && x > -10) {
    // Airside, above the terminal blocks: the twin's piers are the real ones, turned.
    if (y > 500 && x > 576 && x < 724) return null;
    const p = twinToReal(a.term, x, y); out.x = p.x; out.y = p.y; return out;
  }
  const H = SITE.hall[a.term]; if (!H) return null;
  let u, v;
  if (y >= b.y && y <= b.y + b.h && x >= b.x && x <= b.x + b.w) { u = (x - b.x) / b.w; v = (y - b.y) / b.h; }
  else { const ab = G.arrBuilding; if (y >= ab.y && y <= ab.y + ab.h && x >= ab.x && x <= ab.x + ab.w) { u = (x - ab.x) / ab.w; v = (y - ab.y) / ab.h; } else return null; }
  out.x = H.o.x + H.u.x * u + H.v.x * v; out.y = H.o.y + H.u.y * u + H.v.y * v;
  return out;
}

function sitePoly(g, pts, close) {
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  if (close) g.closePath();
}
function drawSiteStatic(g) {
  const L = AG.site, px = 1 / view.s;
  g.fillStyle = '#060c18'; g.fillRect(SITE_RECT.x - 2000, SITE_RECT.y - 2000, SITE_RECT.w + 4000, SITE_RECT.h + 4000);
  g.fillStyle = 'rgba(34,197,94,0.035)';
  for (const p of L.parking) { sitePoly(g, p.pts, true); g.fill(); }
  g.strokeStyle = 'rgba(148,163,184,0.16)'; g.lineWidth = 3; g.lineCap = 'round'; g.lineJoin = 'round';
  for (const r of L.road) { if (/motorway|trunk|primary/.test(r.kind)) { g.lineWidth = 6; } else g.lineWidth = 3; sitePoly(g, r.pts); g.stroke(); }
  g.fillStyle = '#0b1424';
  for (const a of L.apron) { sitePoly(g, a.pts, true); g.fill(); }
  g.strokeStyle = '#132038'; g.lineWidth = 18;
  for (const t of L.taxiway) { sitePoly(g, t.pts); g.stroke(); }
  g.strokeStyle = 'rgba(250,204,21,0.18)'; g.lineWidth = 0.8 * px;
  for (const t of L.taxiway) { sitePoly(g, t.pts); g.stroke(); }
  for (const r of L.runway) {
    g.strokeStyle = '#1a2436'; g.lineWidth = r.w || 45; g.lineCap = 'butt'; sitePoly(g, r.pts); g.stroke();
    g.strokeStyle = 'rgba(226,232,240,0.35)'; g.lineWidth = 1.2; g.setLineDash([30, 24]); sitePoly(g, r.pts); g.stroke(); g.setLineDash([]);
  }
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(250,204,21,0.22)'; g.lineWidth = 0.9;
  for (const s of L.stand) { sitePoly(g, s); g.stroke(); }
  g.fillStyle = 'rgba(100,116,139,0.10)'; g.strokeStyle = 'rgba(100,116,139,0.25)'; g.lineWidth = px;
  for (const b of [...L.building, ...L.hangar]) { sitePoly(g, b.pts, true); g.fill(); g.stroke(); }
  g.fillStyle = '#1a2a48'; g.strokeStyle = '#4a6aa3'; g.lineWidth = 1.3 * px;
  for (const t of L.terminal) { sitePoly(g, t.pts, true); g.fill(); g.stroke(); }
  // Pier centrelines (the walking routes) and gate positions.
  g.strokeStyle = 'rgba(244,114,182,0.30)'; g.lineWidth = 1.2 * px; g.setLineDash([4 * px, 4 * px]);
  for (const P of AG.piers) for (const b of P.branches) { sitePoly(g, b); g.stroke(); }
  g.setLineDash([]);
  for (const P of AG.piers) for (const gt of P.gates) {
    g.fillStyle = gt.bus ? 'rgba(74,222,128,0.8)' : gt.us ? 'rgba(52,211,153,0.9)' : 'rgba(244,114,182,0.8)';
    g.beginPath(); g.arc(gt.x, gt.y, 2.2, 0, 7); g.fill();
  }
  // Security exits, where the walk-time table starts.
  for (const k of TERMS) {
    const s = AG.security[k]; g.fillStyle = 'rgba(251,191,36,0.9)';
    g.beginPath(); g.arc(s[0], s[1], 4, 0, 7); g.fill();
  }
  g.lineCap = 'butt'; g.lineJoin = 'miter';
}

function drawSiteAircraft(g, t) {
  for (const [gt, list] of gen.gateStays) {
    for (const st of list) {
      if (t < st.from - 180 || t > st.to + 150) continue;
      const pl = gt.remote ? (REMOTE_STANDS.find(r => r.id === gt.stand) || {}).real : gt.realPlane || (() => { const p = twinToReal(gt.term, gt.plane.x, gt.plane.y); return { ...p, ang: gt.plane.ang - Math.PI / 2 }; })();
      if (!pl) break;
      const ac = st.dep || st.arr, sc = ac.wide ? 1.4 : ac.seats < 100 ? 0.7 : 0.95;
      const dep = st.dep && st.part !== 'in' ? st.dep.dep : null, onBlock = st.arr && st.part !== 'out' ? st.arr.onBlock : null;
      let alpha = 0.85;
      if (onBlock && t < onBlock) alpha *= 1 - clamp((onBlock - t) / 180, 0, 1) * 0.7;
      if (dep && t > dep) alpha *= 1 - clamp((t - dep) / 150, 0, 1);
      const boarding = dep && t > dep - 28 * 60 && t < dep;
      drawPlane(g, pl.x, pl.y, pl.ang, alpha, boarding, sc);
      break;
    }
  }
  for (const [stand, list] of gen.remoteStays) for (const st of list) {
    if (t < st.from || t > st.to) continue;
    const r = REMOTE_STANDS.find(x => x.id === stand.stand); if (!r) continue;
    drawPlane(g, r.real.x, r.real.y, r.real.ang, 0.6, false, st.dep.wide ? 1.4 : 0.95);
  }
}
const siteTmp = { x: 0, y: 0 };
function drawSitePeople(g, s) {
  const al = sim.alive, d = Math.max(1.4, 2.6 / s);
  const buckets = new Map();
  for (let i = 0; i < al.length; i++) {
    const a = al[i];
    a._sx = NaN;
    if (a.hidden) continue;
    if (!siteXY(a, siteTmp)) continue;
    a._sx = siteTmp.x; a._sy = siteTmp.y;
    const c = agentColor(a); let b = buckets.get(c); if (!b) buckets.set(c, b = []); b.push(a);
  }
  for (const [c, list] of buckets) {
    g.fillStyle = c; g.beginPath();
    for (const a of list) g.rect(a._sx - d / 2, a._sy - d / 2, d, d);
    g.fill();
  }
}
function drawSiteLabels(g) {
  const s = view.s;
  for (const t of AG.site.terminal) if (/^Terminal [12]$/.test(t.name || '')) {
    let cx = 0, cy = 0; for (const p of t.pts) { cx += p[0]; cy += p[1]; } cx /= t.pts.length; cy /= t.pts.length;
    label(g, t.name.toUpperCase(), cx, cy, { size: 10, align: 'center', weight: 700, color: 'rgba(191,219,254,0.85)', ls: '1.5px' });
  }
  const cnt = liveCounts();
  for (const P of AG.piers) {
    const b = P.branches[0], tip = b[b.length - 1], n = (cnt[P.term] && cnt[P.term].pier[P.id]) || 0;
    label(g, `${P.name.toUpperCase()} · ${fmtInt(n)}`, tip[0], tip[1] - 16, { size: 10, align: 'center', color: 'rgba(244,114,182,0.95)', ls: '1px' });
    if (s > 1.4) for (const gt of P.gates) label(g, gt.id, gt.x + 4, gt.y, { size: 8.5, color: 'rgba(230,237,247,0.6)', weight: 500 });
  }
  for (const r of AG.site.runway) if (r.ref) {
    const p = r.pts[0]; label(g, `RUNWAY ${r.ref}`, p[0], p[1] - 34, { size: 9, color: 'rgba(148,163,184,0.6)', ls: '1.5px' });
  }
  for (const k of TERMS) { const sx = AG.security[k]; label(g, `${GEO[k].short} SECURITY`, sx[0] + 8, sx[1], { size: 8.5, color: 'rgba(251,191,36,0.85)' }); }
  for (const r of REMOTE_STANDS) if (s > 0.9 && r.area !== 'south') label(g, r.id, r.real.x, r.real.y - 24, { size: 8, align: 'center', color: 'rgba(148,163,184,0.55)', weight: 500 });
  label(g, 'SOUTH GATES 335A–F · BUS FROM 335', 790, 455, { size: 8.5, align: 'center', color: 'rgba(74,222,128,0.7)' });
  // Scale bar and attribution.
  const sp = toScreen(SITE_RECT.x + 40, SITE_RECT.y + SITE_RECT.h - 40), len = 250 * s;
  g.strokeStyle = 'rgba(148,163,184,0.5)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(sp.x, sp.y); g.lineTo(sp.x + len, sp.y); g.stroke();
  const bl = toScreen(0, 0); void bl;
  g.font = '500 9.5px Inter, sans-serif'; g.fillStyle = 'rgba(148,163,184,0.7)'; g.textAlign = 'left'; g.textBaseline = 'bottom';
  g.fillText('250 m · N ↑ · real map: © OpenStreetMap contributors (ODbL) · people inside terminals placed approximately', sp.x, sp.y - 4);
}
