'use strict';
/* ====================================================================
   Timelines under the map, one per terminal, for the chosen resource:
   Security, Immigration and Taxi rank show demand against rostered
   capacity and the modelled wait; Car parks show live occupancy; Bags
   shows first and last bag per arriving flight against target bands.
   ==================================================================== */
const tlCanvases = { t1: document.getElementById('tl1'), t2: document.getElementById('tl2') };
const TL_X0 = DAY_START, TL_X1 = 25 * 3600;
function prepCanvas(cv) {
  const r = cv.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, r.width, r.height);
  const ml = 34, mr = 36, mt = 8, mb = 18;
  return { g, r, ml, mt, W: r.width - ml - mr, H: r.height - mt - mb };
}
function timeAxis(c, X) {
  const { g, mt, H } = c;
  g.strokeStyle = 'rgba(148,163,184,0.08)'; g.lineWidth = 1; g.font = '500 9.5px Inter, sans-serif'; g.fillStyle = '#5a6a86';
  g.textBaseline = 'top'; g.textAlign = 'center';
  for (let h = 3; h <= 24; h += 3) { const x = X(h * 3600); g.beginPath(); g.moveTo(x, mt); g.lineTo(x, mt + H); g.stroke(); g.fillText(pad(h % 24) + ':00', x, mt + H + 4); }
}
function playhead(c, X) {
  const { g, mt, H } = c, px = X(clamp(sim.t, TL_X0, TL_X1));
  g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1; g.beginPath(); g.moveTo(px, mt - 2); g.lineTo(px, mt + H); g.stroke();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(px - 4, mt - 4); g.lineTo(px + 4, mt - 4); g.lineTo(px, mt + 2); g.closePath(); g.fill();
}
function renderTimeline(key) {
  const cv = tlCanvases[key], c = prepCanvas(cv); if (!c) return;
  const X = t => c.ml + (t - TL_X0) / (TL_X1 - TL_X0) * c.W;
  cv._map = { ml: c.ml, W: c.W, x0: TL_X0, x1: TL_X1 };
  timeAxis(c, X);
  if (state.res === 'car') chartCarparks(c, X, key);
  else if (state.res === 'bags') chartBags(c, X, key);
  else chartResource(c, X, key, RES[state.res]);
  playhead(c, X);
}
function chartResource(c, X, key, res) {
  const { g, ml, mt, W, H } = c;
  const demand = res.demand(gen, key), plan = plans[res.id][key], out = outlook[state.plan][res.id][key];
  const bins = Math.ceil((TL_X1 - TL_X0) / 900), bv = new Float32Array(bins);
  for (let m = 0; m < demand.length; m++) { const b = Math.floor(m / 15); if (b < bins) bv[b] += demand[m]; }
  let ymax = 1;
  for (let b = 0; b < bins; b++) ymax = Math.max(ymax, bv[b]);
  for (let s = 0; s < NSLOT; s++) ymax = Math.max(ymax, res.capacity(gen, key, plan, s));
  ymax *= 1.08;
  const Yv = v => mt + H - v / ymax * H;
  const wmax = Math.max(45, Math.ceil(out.peak / 15) * 15 + 5), YW = v => mt + H - v / wmax * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (let i = 0; i <= 2; i++) { const v = ymax / 1.08 * i / 2; g.fillText(fmtInt(v), ml - 5, Yv(v)); }
  g.textAlign = 'left';
  for (let v = 0; v <= wmax; v += wmax > 60 ? 30 : 15) g.fillText(v + 'm', ml + W + 5, YW(v));
  const bw = W / bins;
  for (let b = 0; b < bins; b++) {
    const past = TL_X0 + b * 900 < sim.t;
    g.globalAlpha = past ? 0.75 : 0.28;
    if (res.id === 'sec') {
      let base = 0;
      for (const m of TERMINAL_MARKETS[key]) {
        const am = gen.secArrM[key][m]; let v = 0;
        for (let i = b * 15; i < b * 15 + 15 && i < am.length; i++) v += am[i];
        if (!v) continue;
        g.fillStyle = MARKETS[m].color;
        const yt = Yv(base + v), yb = Yv(base); g.fillRect(ml + b * bw + 0.5, yt, Math.max(1, bw - 1), yb - yt); base += v;
      }
    } else {
      g.fillStyle = res.id === 'imm' ? '#f87171' : '#facc15';
      const y = Yv(bv[b]); g.fillRect(ml + b * bw + 0.5, y, Math.max(1, bw - 1), mt + H - y);
    }
  }
  g.globalAlpha = 1;
  if (res.id === 'sec' || res.id === 'imm') hzTimelineBand(c, X, key, res.id, Yv);
  g.beginPath(); g.moveTo(X(TL_X0), YW(0));
  for (let m = 0; m < out.wait.length; m++) { const t = TL_X0 + m * 60; if (t > TL_X1) break; g.lineTo(X(t), YW(out.wait[m])); }
  g.lineTo(X(TL_X1), YW(0)); g.closePath();
  const grd = g.createLinearGradient(0, mt, 0, mt + H); grd.addColorStop(0, 'rgba(244,63,94,0.45)'); grd.addColorStop(1, 'rgba(244,63,94,0.03)');
  g.fillStyle = grd; g.fill();
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(244,63,94,0.45)'; g.beginPath(); g.moveTo(ml, YW(res.threshold)); g.lineTo(ml + W, YW(res.threshold)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = '#2dd4bf'; g.lineWidth = 1.6; g.beginPath();
  for (let s = 0; s < NSLOT; s++) {
    const ta = TL_X0 + s * SLOT, tb = Math.min(TL_X1, ta + SLOT); if (ta >= TL_X1) break;
    const y = Yv(res.capacity(gen, key, plan, s));
    s ? g.lineTo(X(ta), y) : g.moveTo(X(ta), y); g.lineTo(X(tb), y);
  }
  g.stroke();
}
function chartCarparks(c, X, key) {
  const { g, ml, mt, W, H } = c;
  const ids = key === 't1' ? ['st_t1', 'cpa_t1', 'hb'] : ['st_t2', 'surf_t2', 'staff'];
  const cols = ['#60a5fa', '#a78bfa', '#3b82f6'];
  const Yp = p => mt + H - p * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const p of [0, 0.5, 1]) g.fillText(Math.round(p * 100) + '%', ml - 5, Yp(p));
  g.setLineDash([3, 4]); g.strokeStyle = 'rgba(244,63,94,0.45)'; g.beginPath(); g.moveTo(ml, Yp(1)); g.lineTo(ml + W, Yp(1)); g.stroke(); g.setLineDash([]);
  const h = sim.hist;
  ids.forEach((id, i) => {
    const cap = sim.carparks[id].cap;
    g.strokeStyle = cols[i]; g.lineWidth = 1.6; g.beginPath();
    g.moveTo(X(DAY_START), Yp(sim.carparks[id].occ0 / cap));
    for (let j = 0; j < h.t.length; j++) g.lineTo(X(h.t[j]), Yp(h.carparks[j][id] / cap));
    g.lineTo(X(sim.t), Yp(sim.carparks[id].occ / cap));
    g.stroke();
  });
  g.font = '600 9.5px Inter, sans-serif';
  ids.forEach((id, i) => { g.fillStyle = cols[i]; g.textAlign = 'left'; g.fillText(`${CARPARKS[id].name} ${Math.round(sim.carparks[id].occ / sim.carparks[id].cap * 100)}%`, ml + 6, mt + 8 + i * 12); });
}
function chartBags(c, X, key) {
  const { g, ml, mt, W, H } = c;
  const ymax = 60, Ym = m => mt + H - m / ymax * H;
  g.fillStyle = '#5a6a86'; g.textAlign = 'right'; g.textBaseline = 'middle';
  for (const m of [0, 20, 40, 60]) g.fillText(m + 'm', ml - 5, Ym(m));
  // Target bands (narrowbody): first bag 12-18 min, last bag 25-35 min.
  g.fillStyle = 'rgba(52,211,153,0.08)'; g.fillRect(ml, Ym(18), W, Ym(12) - Ym(18));
  g.fillStyle = 'rgba(96,165,250,0.08)'; g.fillRect(ml, Ym(35), W, Ym(25) - Ym(35));
  for (const a of gen.arrFlights) {
    if (a.term !== key || !a.firstBag) continue;
    const x = X(a.onBlock), f = (a.firstBag - a.onBlock) / 60, l = (a.lastBag - a.onBlock) / 60;
    g.strokeStyle = 'rgba(203,213,225,0.25)'; g.lineWidth = 1; g.beginPath(); g.moveTo(x, Ym(f)); g.lineTo(x, Ym(Math.min(ymax, l))); g.stroke();
    g.fillStyle = f <= (a.wide ? 20 : 18) ? '#34d399' : '#fb923c'; g.fillRect(x - 1.5, Ym(f) - 1.5, 3, 3);
    g.fillStyle = l <= (a.wide ? 45 : 35) ? '#60a5fa' : '#f43f5e'; g.fillRect(x - 1.5, Ym(Math.min(ymax, l)) - 1.5, 3, 3);
  }
}
