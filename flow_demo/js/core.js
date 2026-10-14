'use strict';
/* ====================================================================
   Helpers shared by every module. Classic scripts share one global
   scope, so later files use these names directly.
   ==================================================================== */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const fmtInt = n => Math.round(n).toLocaleString('en-IE');
const pad = n => String(n).padStart(2, '0');
function fmtHM(t) { const m = Math.floor(t / 60); return pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60); }
function fmtDate(iso, opts) { return new Date(iso + 'T12:00:00').toLocaleDateString('en-IE', opts); }
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hashStr(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function waitClass(min) { return min < 10 ? 'g' : min < 20 ? 'w' : min < 30 ? 'h' : 'b'; }
function waitColor(min) { return min < 10 ? '#34d399' : min < 20 ? '#fbbf24' : min < 30 ? '#fb923c' : '#f43f5e'; }

// Seeded random stream for the simulation, so a day replays identically.
// resetSim() reseeds it from the date and roster.
let R = mulberry32(1);
function seedSim(key) { R = mulberry32(hashStr(key)); }
const jit = n => (R() - 0.5) * 2 * n;
const U = (a, b) => a + R() * (b - a);
function gaussR() { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); }
function randIn(r, inset = 0) { return { x: r.x + inset + R() * (r.w - 2 * inset), y: r.y + inset + R() * (r.h - 2 * inset) }; }
function pickW(weights, r = R()) {
  let sum = 0; for (const k in weights) sum += weights[k];
  let x = r * sum; for (const k in weights) { x -= weights[k]; if (x <= 0) return k; }
  return Object.keys(weights).pop();
}
const center = r => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

class Queue {
  constructor() { this.a = []; this.h = 0; this.base = 0; }
  get length() { return this.a.length - this.h; }
  push(x) { x.qi = this.base + this.a.length; this.a.push(x); }
  shift() {
    const x = this.a[this.h++];
    if (this.h > 2048 && this.h * 2 > this.a.length) { this.a = this.a.slice(this.h); this.base += this.h; this.h = 0; }
    return x;
  }
  rank(x) { return x.qi - (this.base + this.h); }
  peek() { return this.a[this.h]; }
  *[Symbol.iterator]() { for (let i = this.h; i < this.a.length; i++) yield this.a[i]; }
}

class Polyline {
  constructor(pts) {
    this.pts = pts; this.cum = [0];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + dist(pts[i - 1], pts[i]));
    this.len = this.cum[this.cum.length - 1];
  }
  seg(d) { let i = 1; while (i < this.cum.length - 1 && this.cum[i] < d) i++; return i; }
  at(d, off, out) {
    d = clamp(d, 0, this.len);
    const i = this.seg(d);
    const a = this.pts[i - 1], b = this.pts[i], seg = this.cum[i] - this.cum[i - 1] || 1;
    const f = (d - this.cum[i - 1]) / seg, dx = (b.x - a.x) / seg, dy = (b.y - a.y) / seg;
    out.x = a.x + (b.x - a.x) * f - dy * off; out.y = a.y + (b.y - a.y) * f + dx * off;
    out.ang = Math.atan2(dy, dx);
    return out;
  }
  // Point on a closed loop: d wraps around.
  loop(d, out) { return this.at(((d % this.len) + this.len) % this.len, 0, out); }
}

/* A serpentine queue in a rectangle, head at the top-left (or at hx when
   given), with an optional overflow polyline once the rows are full. */
class Snake {
  constructor({ x0, x1, y0, rows, gap = 4.6, sp = 3.2, hx = null, ov = null, ovStep = 2.3, down = true }) {
    Object.assign(this, { x0, x1, y0, rows, gap, sp, ov, ovStep });
    this.dir = down ? 1 : -1;
    this.hx = hx ?? x0;
    this.cap0 = Math.floor((x1 - this.hx) / sp) + 1;
    this.rowCap = Math.floor((x1 - x0) / sp) + 1;
    this.capIn = this.cap0 + (rows - 1) * this.rowCap;
  }
  slot(r, out) {
    if (r < this.cap0) { out.x = this.hx + r * this.sp; out.y = this.y0; return out; }
    r -= this.cap0;
    const row = 1 + Math.floor(r / this.rowCap);
    if (row < this.rows) {
      const c = r % this.rowCap;
      out.x = row % 2 === 1 ? this.x1 - c * this.sp : this.x0 + c * this.sp;
      out.y = this.y0 + this.dir * row * this.gap; return out;
    }
    r -= (this.rows - 1) * this.rowCap;
    if (!this.ov) { out.x = this.x0 + ((r * 7919) % 23) * 0.6; out.y = this.y0 + this.dir * (this.rows - 1) * this.gap + this.dir * (2 + (r % 5)); return out; }
    const along = Math.floor(r / 3) * this.ovStep;
    this.ov.at(along, ((r % 3) - 1) * 3, out);
    if (along > this.ov.len) { out.x += ((r * 7919) % 23) - 11; out.y += ((r * 104729) % 9) - 4; }
    return out;
  }
}

/* Movement helpers. tmp is a shared scratch point. */
const tmp = { x: 0, y: 0, ang: 0 };
/* d is metres walked. A path point may carry k, the real metres per drawn
   unit of the leg that ends there (legs the twin draws shorter than they are). */
function walkPath(a, d) {
  const P = a.path;
  while (d > 0 && a.pi < P.length) {
    const p = P[a.pi], k = p.k || 1, dx = p.x - a.x, dy = p.y - a.y, l = Math.hypot(dx, dy) * k;
    if (l <= d) { a.x = p.x; a.y = p.y; d -= l; a.pi++; }
    else { const f = d / l; a.x += dx * f; a.y += dy * f; d = 0; }
  }
  return a.pi >= P.length;
}
function approach(a, tx, ty, d) {
  const dx = tx - a.x, dy = ty - a.y, l = Math.hypot(dx, dy);
  if (l <= d) { a.x = tx; a.y = ty; return true; }
  a.x += dx / l * d; a.y += dy / l * d; return false;
}
function setPath(a, pts) { a.path = pts; a.pi = 0; }
const pathDone = a => !a.path || a.pi >= a.path.length;

/* Stage registry: each flow file registers its stages with a zone (for
   colouring and counts), a label for the follow card, and an update fn. */
const ST = {}, STAGE_FN = [], STAGE_ZONE = [], STAGE_TEXT = [];
function defStage(name, zone, text, fn) {
  const id = STAGE_FN.length;
  ST[name] = id; STAGE_FN.push(fn); STAGE_ZONE.push(zone); STAGE_TEXT.push(text);
  return id;
}
const DONE = defStage('DONE', -1, 'Left the airport', () => {});
// Party members who move as one with their leader (arrivals, transfers, greeters).
const FOLLOW = defStage('FOLLOW', -2, 'With their party', (a, dt, t) => followStep(a, dt, t));
