'use strict';
/* ====================================================================
   Interaction, main loop and start-up.
   ==================================================================== */
let drag = null;
mapCv.addEventListener('pointerdown', e => { view.anim = null; drag = { x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy, moved: false }; mapCv.setPointerCapture(e.pointerId); });
mapCv.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; mapCv.classList.add('dragging'); }
  if (drag.moved) { view.ox = drag.ox + dx; view.oy = drag.oy + dy; view.fit = false; }
});
mapCv.addEventListener('pointerup', e => {
  mapCv.classList.remove('dragging');
  if (drag && !drag.moved) pick(e);
  drag = null;
});
mapCv.addEventListener('wheel', e => {
  e.preventDefault(); view.anim = null;
  const r = mapCv.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
mapCv.addEventListener('dblclick', () => flyTo(WORLD));
function zoomAt(mx, my, f) {
  const fitS = Math.min(view.cw / WORLD.w, view.ch / WORLD.h);
  const ns = clamp(view.s * f, fitS * 0.8, fitS * 14);
  const wx = (mx - view.ox) / view.s, wy = (my - view.oy) / view.s;
  view.s = ns; view.ox = mx - wx * ns; view.oy = my - wy * ns; view.fit = false;
}
$('zin').onclick = () => zoomAt(view.cw / 2, view.ch / 2, 1.4);
$('zout').onclick = () => zoomAt(view.cw / 2, view.ch / 2, 1 / 1.4);
$('zfit').onclick = () => flyTo(WORLD);
function pick(e) {
  const r = mapCv.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
  let best = null, bd = 12 * 12;
  for (const a of sim.alive) {
    if (a.hidden) continue;
    const sx = a.x * view.s + view.ox - mx, sy = a.y * view.s + view.oy - my, d = sx * sx + sy * sy;
    if (d < bd) { bd = d; best = a; }
  }
  state.selected = best; updateFollow();
}
for (const k of TERMS) {
  const cv = tlCanvases[k];
  let down = false;
  const go = e => { const m = cv._map; if (!m) return; const r = cv.getBoundingClientRect(); const f = clamp((e.clientX - r.left - m.ml) / m.W, 0, 1); seek(m.x0 + f * (m.x1 - m.x0)); };
  cv.addEventListener('pointerdown', e => { down = true; cv.setPointerCapture(e.pointerId); go(e); });
  cv.addEventListener('pointermove', e => { if (down) go(e); });
  cv.addEventListener('pointerup', () => { down = false; });
}
$('playBtn').onclick = () => { state.playing = !state.playing; if (sim.t >= SIM_END - 1) seek(DAY_START + 3600); renderPlay(); };
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input,textarea,summary')) return;
  const k = e.key;
  if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
  else if (k === 'ArrowRight') seek(sim.t + 15 * 60);
  else if (k === 'ArrowLeft') seek(sim.t - 15 * 60);
  else if (k === '1' || k === '2' || k === '3') setPlan(PLANS[+k - 1].key);
  else if (k === 'Escape') { state.selected = null; updateFollow(); }
  else if (k === 'c') { const m = COLOR_MODES.map(x => x[0]); state.colorMode = m[(m.indexOf(state.colorMode) + 1) % m.length]; renderSegs(); renderLegend(); }
  else if (k === 'p' || k === 'P') $('perf').classList.toggle('show');
  else if (PRESETS[k.toUpperCase()] && !e.metaKey && !e.ctrlKey) goPreset(k.toUpperCase());
});
new ResizeObserver(() => { resizeMap(); bgKey = ''; }).observe($('mapwrap'));

/* ---- main loop with a small performance meter (key P) ---- */
const perf = { frames: [], step: 0, render: 0 };
let last = performance.now(), panelAt = 0;
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000); last = now;
  const s0 = performance.now();
  if (state.seekTarget != null) {
    while (sim.t < state.seekTarget - 1e-6 && performance.now() - s0 < 45) step(Math.min(10, state.seekTarget - sim.t));
    const span = Math.max(1, state.seekTarget - state.seekFrom);
    $('seeking').classList.toggle('show', state.seekTarget - state.seekFrom > 1800);
    $('seekTxt').textContent = `Fast-forwarding to ${fmtHM(state.seekTarget)}`;
    $('seekBar').style.width = `${clamp((sim.t - state.seekFrom) / span, 0, 1) * 100}%`;
    if (sim.t >= state.seekTarget - 1e-6) { state.seekTarget = null; $('seeking').classList.remove('show'); renderPlay(); }
  } else if (state.playing && sim.t < SIM_END) {
    let sdt = realDt * state.speed;
    while (sdt > 0) { const d = Math.min(sdt, 4); step(d); sdt -= d; }
    if (sim.t >= SIM_END) { state.playing = false; renderPlay(); }
  }
  const s1 = performance.now();
  const ck = fmtHM(sim.t); if ($('clock').textContent !== ck) $('clock').textContent = ck;
  renderMap(now);
  const s2 = performance.now();
  perf.step = perf.step * 0.9 + (s1 - s0) * 0.1; perf.render = perf.render * 0.9 + (s2 - s1) * 0.1;
  perf.frames.push(realDt * 1000); if (perf.frames.length > 120) perf.frames.shift();
  if (now - panelAt > 250) {
    panelAt = now; updatePanels(); renderTimelines(); renderPlay();
    if ($('perf').classList.contains('show')) {
      const f = [...perf.frames].sort((a, b) => a - b), p95 = f[Math.floor(f.length * 0.95)] || 0;
      $('perf').textContent = `frame p95 ${p95.toFixed(1)} ms · step ${perf.step.toFixed(1)} ms · render ${perf.render.toFixed(1)} ms · ${sim.alive.length} people · ${sim.vehicles.length} vehicles · ${sim.bags.moving.length + sim.bags.belt.length} bags`;
    }
  }
  requestAnimationFrame(frame);
}

function init() {
  if (!DATA || !DATA.days || !DATA.days.length) { $('empty').classList.add('show'); return; }
  buildCalendar(); buildSegs(); buildCards(); buildRightTabs(); renderPlans(); renderAdj(); renderSegs(); renderLegend();
  resizeMap();
  state.di = Math.max(0, DATA.days.findIndex(d => d.event));
  gen = genDay(state.di); rebuildPlans(); resetSim(); renderDayPanel(); renderOutlook();
  seek(6 * 3600);
  renderPlay();
  requestAnimationFrame(frame);
  setTimeout(() => computeRisk(0), 1500);
}
init();
