'use strict';
/* ====================================================================
   Weather in the twin: Dublin Airport's real hourly weather for each
   March 2026 day (Met Éireann station 532 and METAR), the ECMWF IFS and
   AIFS day-ahead forecasts, and what weather does to the operation.

   Runway   an hourly arrival + departure rate: dual runways normally;
            one runway in low-visibility procedures (vis < 550 m or ceiling
            < 200 ft); a crosswind penalty in strong gusts; near-suspension
            in storm-force gusts. Flights queue for a slot, so delays build
            and clear like they do on the day (rates are illustrative).
   De-icing frost or snow adds minutes to departures.
   Rain     wet hours push arriving passengers towards taxis.
   ==================================================================== */
const RUNWAY = { normal: 64, lvp: 30, crosswindGust: 40, crosswindFactor: 0.75, stormGust: 55, storm: 12 };
const DEICE = { frostC: 1.0, min: [8, 18] };
const WX_DAY = di => (DATA.days[di] && DATA.days[di].weather) || null;

/* Hourly conditions (24+2 hours) for a day: observed, a model's day-ahead
   forecast, or a scenario override on top of either. */
function hourlyWx(day, source = 'obs') {
  const w = day.weather; if (!w) return null;
  const H = [];
  for (let h = 0; h < 26; h++) {
    const i = Math.min(h, 23);
    let o;
    if (source === 'obs') {
      const x = w.hourly.obs;
      const vis = x.vis[i] ?? 9999, ceil = x.ceil[i] ?? 9999;
      o = { vis, ceil, lvp: vis < 550 || ceil < 200, gust: x.gust[i] ?? (x.wind[i] || 0) * 1.4, wind: x.wind[i] || 0, dir: x.dir[i] ?? 270,
        rain: x.rain[i] || 0, temp: x.temp[i] ?? 8 };
    } else {
      const x = w.hourly.dayAhead[source];
      const wind = x.wind[i] ?? 0, dpd = x.dpd[i] ?? 5;
      // Fog risk from the forecast: near-saturated air and light wind.
      o = { vis: dpd <= 0.6 && wind < 6 ? 400 : dpd <= 1.2 && wind < 8 ? 2000 : 9999, ceil: 9999, lvp: dpd <= 0.6 && wind < 6,
        gust: wind * 1.55, wind, dir: x.dir[i] ?? 270, rain: x.rain[i] || 0, temp: x.temp[i] ?? 8 };
    }
    H.push(o);
  }
  // Scenario overrides.
  if (day._scenario === 'fog') for (let h = 6; h <= 11; h++) Object.assign(H[h], { vis: 300, lvp: true });
  if (day._scenario === 'storm') for (let h = 5; h <= 15; h++) Object.assign(H[h], { gust: h >= 7 && h <= 11 ? 62 : 48, wind: 34, rain: 3 });
  if (source === 'obs') shockWeather(H);
  return H;
}
function runwayRate(o) {
  if (o.gust >= RUNWAY.stormGust) return RUNWAY.storm * (o.rateF ?? 1);
  let r = o.lvp ? RUNWAY.lvp : RUNWAY.normal;
  if (o.gust >= RUNWAY.crosswindGust) r *= RUNWAY.crosswindFactor;
  return r * (o.rateF ?? 1);
}
function runwayConfig(o) {
  if (o.gust >= RUNWAY.stormGust) return 'Storm: one runway, heavy restrictions';
  if (o.gust >= RUNWAY.crosswindGust && ((o.dir > 120 && o.dir < 230) || o.dir > 300 || o.dir < 30)) return 'Runway 16/34 (crosswind)';
  const westerly = o.dir >= 190 || o.dir <= 10;
  return `${westerly ? '28L/28R' : '10L/10R'}${o.lvp ? ' · low-visibility procedures, single runway' : ''}`;
}

/* Runway queue: every arrival lands and every departure takes off in a
   slot; slots per minute follow the hourly rate. Returns extra delay (s)
   per movement, in the order given. */
function runwayQueue(moves, H, share = 1) {
  const order = moves.map((m, i) => i).sort((a, b) => moves[a].t - moves[b].t);
  const extra = new Float64Array(moves.length);
  let free = 0;
  for (const i of order) {
    const want = moves[i].t;
    const start = Math.max(want, free);
    const h = clamp(Math.floor(start / 3600), 0, H.length - 1);
    free = start + 3600 / (runwayRate(H[h]) * share);
    extra[i] = start - want;
  }
  return extra;
}

/* Apply the day's weather to generated flights before gates are assigned. */
function applyWeather(day, flights, arrs, rnd, share = 0.5) {
  const H = hourlyWx(day, 'obs');
  if (!H) return null;
  // De-icing on frosty or snowy hours.
  for (const f of flights) {
    const o = H[clamp(Math.floor(f.dep / 3600), 0, 25)];
    if (o.temp <= DEICE.frostC || ((day.weather.obs.snow || o.snow) && o.temp <= 2)) {
      const add = (DEICE.min[0] + rnd() * (DEICE.min[1] - DEICE.min[0])) * 60;
      f.dep += add; f.delay += add; f.deiced = true;
    }
  }
  // Runway slots for arrivals (touchdown ~5 min before on-block) and departures.
  const moves = [...arrs.map(a => ({ t: a.onBlock - 300, a })), ...flights.map(f => ({ t: f.dep, f }))];
  const extra = runwayQueue(moves, H, share);
  let held = 0, maxHold = 0;
  moves.forEach((m, i) => {
    const e = extra[i];
    if (e <= 0) return;
    if (m.a) { m.a.onBlock += e; m.a.delay += e; m.a.held = e; }
    else { m.f.dep += e; m.f.delay += e; m.f.held = e; }
    if (e > 300) held++;
    maxHold = Math.max(maxHold, e);
  });
  // A departure cannot leave before its inbound aircraft has turned round.
  for (const f of flights) if (f.inbound && f.dep < f.inbound.onBlock + 25 * 60) { const d = f.inbound.onBlock + 25 * 60 - f.dep; f.dep += d; f.delay += d; }
  return { held, maxHold, hourly: H };
}
function rainyAt(day, t) {
  const w = day.weather; if (!w) return false;
  const v = w.hourly.obs.rain[clamp(Math.floor(t / 3600), 0, 23)];
  return v != null && v >= 0.3;
}
/* Mode shares nudged by rain: taxis up, buses and walking-to-bus down. */
function wetModeSplit(split) {
  const s = { ...split };
  if (s.taxi != null) s.taxi *= 1.15;
  if (s.bus != null) s.bus *= 0.9;
  return s;
}

/* Expected runway holding if the forecast is right (for alerts and the Studio). */
function forecastHolding(day, model) {
  const H = hourlyWx(day, model);
  if (!H) return null;
  const windows = [];
  for (let h = 4; h < 24; h++) {
    const rate = runwayRate(H[h]);
    if (rate < RUNWAY.normal * 0.9) windows.push({ h, rate, why: H[h].gust >= RUNWAY.stormGust ? 'storm-force gusts' : H[h].lvp ? 'fog risk' : 'crosswind gusts' });
  }
  return windows;
}

/* ---- map overlay: haze, rain and the weather badge ---- */
const wxFx = { drops: null };
function weatherNow() {
  const H = gen && gen.wxHourly;
  if (!H) return null;
  const h = clamp(Math.floor(sim.t / 3600), 0, H.length - 1);
  return H[h];
}
function drawWeatherFx(g, now) {
  const o = weatherNow(); if (!o) return;
  const w = mapCv.width, h = mapCv.height;
  g.save(); g.setTransform(1, 0, 0, 1, 0, 0);
  // Fog: a cool haze that thickens as visibility drops.
  if (o.vis < 3000) {
    const a = clamp((3000 - o.vis) / 3000, 0, 1) * 0.32;
    g.fillStyle = `rgba(190,205,222,${a.toFixed(3)})`; g.fillRect(0, 0, w, h);
  }
  // Rain streaks, slanted with the wind.
  if (o.rain >= 0.2 && !reducedMotion()) {
    const n = Math.min(260, 40 + o.rain * 90);
    if (!wxFx.drops || wxFx.drops.length !== Math.round(n)) wxFx.drops = Array.from({ length: Math.round(n) }, () => [Math.random(), Math.random(), 0.6 + Math.random() * 0.8]);
    const slant = Math.sin(((o.dir || 270) - 180) * Math.PI / 180) * clamp(o.wind / 30, 0, 1) * 0.5;
    g.strokeStyle = 'rgba(170,200,235,0.28)'; g.lineWidth = 1 * view.dpr;
    g.beginPath();
    const tt = now / 1000;
    for (const d of wxFx.drops) {
      const y = ((d[1] + tt * 0.5 * d[2]) % 1) * h, x = ((d[0] + tt * 0.08 * slant) % 1 + 1) % 1 * w;
      const len = 14 * view.dpr * d[2];
      g.moveTo(x, y); g.lineTo(x + slant * len, y + len);
    }
    g.stroke();
  }
  g.restore();
}
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function renderWeatherBadge() {
  const el = $('wxBadge'); if (!el) return;
  const o = weatherNow(), day = gen && gen.day;
  if (!o || !day || !day.weather) { el.style.display = 'none'; return; }
  el.style.display = '';
  const icon = o.gust >= RUNWAY.stormGust ? '🌪' : o.lvp || o.vis < 1500 ? '🌫' : o.rain >= 0.3 ? (o.temp <= 1 ? '🌨' : '🌧') : o.gust >= 35 ? '💨' : '⛅';
  const vis = o.vis >= 9999 ? '10 km+' : o.vis >= 1000 ? (o.vis / 1000).toFixed(1) + ' km' : Math.round(o.vis) + ' m';
  const rate = Math.round(runwayRate(o));
  const html = `<div class="wxr"><span class="wxi" aria-hidden="true">${icon}</span><b>${Math.round(o.temp)}°</b>
    <span class="wsock" title="Wind from ${Math.round(o.dir)}°" style="transform:rotate(${Math.round(o.dir + 180)}deg)">↑</span><span>${Math.round(o.wind)} kt${o.gust > o.wind + 5 ? ` · G${Math.round(o.gust)}` : ''}</span>
    <span>vis ${vis}</span>${o.rain >= 0.1 ? `<span>${o.rain.toFixed(1)} mm/h</span>` : ''}</div>
    <div class="wxs ${rate < RUNWAY.normal ? 'warn' : ''}">${runwayConfig(o)} · ${rate} movements/h</div>`;
  if (el.innerHTML !== html) el.innerHTML = html;
}
