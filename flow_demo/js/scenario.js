'use strict';
/* ====================================================================
   Scenario simulator: describe what happened, see it ripple.

   1. Interpret   free text becomes a list of shocks, each with a type, a
                  terminal, a time window and a size. Claude does this when
                  scenario_server.py is running (structured output against
                  the same schema); otherwise a built-in parser does it.
                  Either way the shocks are shown and can be edited.
   2. Simulate    the shocks are wired into the twin itself: security lanes,
                  screeners, check-in, baggage screening, passport control,
                  eGates, the runway, flight delays and cancellations,
                  demand, roads, buses, taxis, car parks, piers and walkways.
                  Nothing is scripted downstream: a lane failure becomes a
                  queue, missed flights, less shopping; a runway restriction
                  becomes holding, late arrivals, a later passport peak and
                  a later taxi rush, because the twin's people and vehicles
                  do what they would do.
   3. Measure     the day runs twice, without and with the shocks, under the
                  same roster. Every quarter hour each part of the airport
                  is measured; the difference shows where the effect appears
                  first and how it travels.
   4. Forecast    demand shocks change the daily TimesFM forecast (scaled
                  from TimesFM's own re-forecasts for cancellations and added
                  movements, or the stated change in demand), and the hourly
                  forecast follows the changed timetable.
   ==================================================================== */
const SHOCK_TYPES = {
  security_lanes: { label: 'Security lanes out of service', node: 'sec', unit: 'lanes', def: 3, window: true },
  security_staff: { label: 'Screener shortage', node: 'sec', unit: 'share of lanes unstaffed', def: 0.2, window: true },
  power_outage: { label: 'Power cut / evacuation (security and check-in stop)', node: 'sec', unit: '', def: 1, window: true },
  checkin_outage: { label: 'Check-in system outage (manual check-in)', node: 'chk', unit: '× desk time', def: 3, window: true },
  baggage_failure: { label: 'Baggage screening system failure', node: 'bag', unit: 'share of capacity lost', def: 0.7, window: true },
  imm_staff: { label: 'Passport officer shortage', node: 'imm', unit: 'share of booths unstaffed', def: 0.3, window: true },
  egates_down: { label: 'eGates down', node: 'imm', unit: '', def: 1, window: true },
  runway: { label: 'Runway capacity reduced', node: 'rwy', unit: 'share of normal rate', def: 0.5, window: true },
  weather: { label: 'Weather', node: 'rwy', unit: '', def: 1, window: true, targets: ['fog', 'storm', 'snow'] },
  delay: { label: 'Flight delays', node: 'rwy', unit: 'minutes', def: 45, window: true },
  cancel: { label: 'Flights cancelled', node: 'dem', unit: 'share of flights', def: 0.1, window: true },
  demand: { label: 'Passenger demand changes', node: 'dem', unit: '× passengers', def: 1.08, window: false },
  extra_flights: { label: 'Extra flights', node: 'dem', unit: 'movements', def: 6, window: false },
  road_delay: { label: 'Road congestion to the airport', node: 'land', unit: 'minutes late', def: 30, window: true },
  bus_strike: { label: 'Bus and coach disruption', node: 'land', unit: 'share of service lost', def: 1, window: true },
  taxi_shortage: { label: 'Taxi shortage', node: 'taxi', unit: 'share of cabs missing', def: 0.3, window: true },
  carpark_closed: { label: 'Car park closed', node: 'car', unit: 'share of spaces lost', def: 1, window: false },
  pier_closed: { label: 'Pier closed', node: 'gate', unit: '', def: 1, window: true },
  walkway_slow: { label: 'Travelators out (slower walking)', node: 'gate', unit: '× walking time', def: 1.3, window: true },
};
const CANCEL_PAX_LOSS = 0.7;                           // passengers lost per flight share cancelled (illustrative, as the preset)
SCENARIO_DEFS.custom = { name: 'Your scenario', demand: true, desc: '' };

/* ---------------- what is active ---------------- */
const customOn = () => SCN.kind === 'custom' && SCN.custom && SCN.custom.shocks.length;
function shocks(type, term, t) {
  if (!customOn()) return [];
  return SCN.custom.shocks.filter(s => s.type === type && (!term || s.term === 'both' || s.term === term) &&
    (t == null || !SHOCK_TYPES[type].window || (t >= s.from * 3600 && t < s.to * 3600)));
}
const shockMag = (type, term, t, f = (a, s) => Math.max(a, s.magnitude), init = 0) => shocks(type, term, t).reduce(f, init);
function scnKey() {
  if (SCN.kind !== 'custom') return SCN.kind || '';
  return 'custom:' + hashStr(JSON.stringify(SCN.custom ? SCN.custom.shocks : []));
}
/* Lanes physically available at time t (t omitted: what the roster can plan with). */
function lanesLost(key, t) {
  if (t == null) return 0;
  if (shocks('power_outage', key, t).length) return 99;
  return shockMag('security_lanes', key, t, (a, s) => a + s.magnitude);
}
const staffShort = (key, t) => clamp(shockMag('security_staff', key, t), 0, 1);
const chkFactor = (key, t) => (shocks('power_outage', key, t).length ? Infinity : shockMag('checkin_outage', key, t, (a, s) => a * Math.max(1, s.magnitude), 1));
const hbsFactor = (key, t) => clamp(1 - shockMag('baggage_failure', key, t), 0, 1);
const immShort = (key, t) => clamp(shockMag('imm_staff', key, t), 0, 1);
const egatesDown = (key, t) => shocks('egates_down', key, t).length > 0;
const walkFactor = (pier, t) => shocks('walkway_slow', null, t).filter(s => !s.target || s.target === pier).reduce((a, s) => Math.max(a, s.magnitude), 1);
function pierClosed(gate, from, to) {
  if (!customOn() || !gate || gate.remote) return false;
  return SCN.custom.shocks.some(s => s.type === 'pier_closed' && s.target === gate.pier && from < s.to * 3600 && to > s.from * 3600);
}
function roadDelayAt(term, t) { return shockMag('road_delay', term, t) * 60; }
function busLostAt(term, t) { return clamp(shockMag('bus_strike', term, t), 0, 1); }
/* Mode shares when buses are disrupted: bus riders switch to taxis and lifts. */
function strikeSplit(split, term, t) {
  const lost = busLostAt(term, t); if (!lost || !split.bus) return split;
  const s = { ...split }, moved = s.bus * lost;
  s.bus -= moved; s.taxi = (s.taxi || 0) + moved * 0.55; s.met = (s.met || 0) + moved * 0.45;
  return s;
}
/* Hourly weather overrides from the shocks (runway factor, fog, storm, snow). */
function shockWeather(H) {
  if (!customOn()) return;
  for (const s of SCN.custom.shocks) {
    if (s.type !== 'runway' && s.type !== 'weather') continue;
    for (let h = Math.floor(s.from); h < Math.min(H.length, Math.ceil(s.to)); h++) {
      const o = H[h];
      if (s.type === 'runway') o.rateF = Math.min(o.rateF ?? 1, Math.max(0.03, s.magnitude));
      else if (s.target === 'fog') Object.assign(o, { vis: 300, lvp: true });
      // A storm peaks in the middle of its window (storm-force gusts), with strong crosswinds either side.
      else if (s.target === 'storm') { const f = (h + 0.5 - s.from) / Math.max(0.5, s.to - s.from); Object.assign(o, { gust: Math.max(o.gust, f > 0.25 && f < 0.75 ? 62 : 48), wind: 34, rain: 3 }); }
      else if (s.target === 'snow') Object.assign(o, { temp: Math.min(o.temp, -1), rateF: Math.min(o.rateF ?? 1, 0.6), snow: true });
    }
  }
}

/* ---------------- demand: the day the simulation runs ---------------- */
function inScope(s, k, m, airline) {
  if (s.term !== 'both' && s.term !== k) return false;
  if (s.market && s.market !== m) return false;
  if (s.airline === 'R' && k !== 't1') return false;
  if (s.airline === 'A' && (k !== 't2' || m === 'long')) return false;
  return true;
}
const AIRLINE_SHARE = { R: { eu_sun: 0.75, uk: 0.6, eu_city: 0.6 }, A: { uk: 0.7, eu_city: 0.7, na: 0.7 } };
/* Share of a market's departures inside a time window (from its departure banks). */
function windowShare(m, from, to) {
  const w = MARKETS[m].depW, tot = w.reduce((a, b) => a + b, 0) || 1;
  let s = 0; for (let h = 0; h < 24; h++) s += w[h] * clamp(Math.min(h + 1, to) - Math.max(h, from), 0, 1);
  return s / tot;
}
/* Factor on a market direction's passengers for a custom scenario. */
function customPaxFactor(k, m, dir) {
  if (!customOn()) return 1;
  let f = 1;
  for (const s of SCN.custom.shocks) {
    if (!inScope(s, k, m)) continue;
    const air = s.airline ? (AIRLINE_SHARE[s.airline] || {})[m] || 0 : 1;
    // As in the preset: 10% of flights cancelled loses about 7% of passengers (the rest rebook onto fuller flights).
    if (s.type === 'cancel') f *= 1 - s.magnitude * air * windowShare(m, s.from, s.to) * CANCEL_PAX_LOSS;
    if (s.type === 'demand' && (!s.dir || s.dir === 'both' || s.dir === dir)) f *= s.magnitude;
  }
  return f;
}
function customExtraMoves(k, m) {
  if (!customOn()) return 0;
  return SCN.custom.shocks.filter(s => s.type === 'extra_flights' && (s.term === 'both' ? k === 't1' : s.term === k) && (s.market || 'eu_city') === m)
    .reduce((a, s) => a + Math.round(s.magnitude), 0);
}
function customDay(d) {
  for (const k of TERMS) {
    let tot = 0;
    for (const m of TERMINAL_MARKETS[k]) {
      const md = d.markets[k][m];
      for (const dir of ['dep', 'arr']) md[dir].actual = Math.round(md[dir].actual * customPaxFactor(k, m, dir));
      const extra = customExtraMoves(k, m);
      if (extra) { md.movements += extra; const p = Math.round(extra / 2 * 186 * 0.85); md.dep.actual += p; md.arr.actual += p; }
      md.actual = md.dep.actual + md.arr.actual; tot += md.actual;
    }
    const r = tot / Math.max(1, d[k].actual);
    d[k].actual = tot;
    if (d.landside) for (const n of [d.landside.taxi[k], d.landside.bus[k]]) if (n) n.actual = Math.round(n.actual * r);
  }
  d.disruption = SCN.custom.title || 'Your scenario';
}
/* Remove cancelled flights from the generated timetable (their passengers rebook or stay home). */
function customCancelFlights(key, deps, rnd) {
  if (!customOn()) return deps;
  const cs = SCN.custom.shocks.filter(s => s.type === 'cancel' && (s.term === 'both' || s.term === key));
  if (!cs.length) return deps;
  // Which flights go is hashed from the flight, not drawn, so the rest of the day's draws are unchanged.
  return deps.filter(f => !cs.some(s => (!s.market || s.market === f.market) && (!s.airline || s.airline === f.airline) &&
    f.std >= s.from * 3600 && f.std < s.to * 3600 && hashStr(`${key}|${f.id}|${s.type}`) / 4294967296 < s.magnitude));
}
function customDelays(key, deps, arrs) {
  if (!customOn()) return;
  for (const s of SCN.custom.shocks) {
    if (s.type !== 'delay' || (s.term !== 'both' && s.term !== key)) continue;
    const d = s.magnitude * 60, inW = t => t >= s.from * 3600 && t < s.to * 3600, mk = f => (!s.market || s.market === f.market) && (!s.airline || s.airline === f.airline);
    if (s.dir !== 'arr') for (const f of deps) if (mk(f) && inW(f.std)) { f.dep += d; f.delay += d; }
    if (s.dir !== 'dep') for (const a of arrs) if (mk(a) && inW(a.sta)) { a.onBlock += d; a.delay += d; }
  }
}

/* ---------------- the forecast, when told ---------------- */
/* Every forecast node carries _k = {k, m, dir} (set below), so a scenario
   copy of the day keeps it. */
for (const d of DATA.days) for (const k of TERMS) {
  if (d[k]) d[k]._k = { k };
  for (const m of TERMINAL_MARKETS[k]) {
    const md = d.markets && d.markets[k] && d.markets[k][m]; if (!md) continue;
    md._k = { k, m }; if (md.dep) md.dep._k = { k, m, dir: 'dep' }; if (md.arr) md.arr._k = { k, m, dir: 'arr' };
  }
  if (d.landside) { if (d.landside.taxi[k]) d.landside.taxi[k]._k = { k }; if (d.landside.bus[k]) d.landside.bus[k]._k = { k }; }
}
/* Told factor for a custom scenario: cancellations and added movements are
   scaled from TimesFM's own re-forecasts (10% cancelled; +6 movements),
   demand changes are the stated change. */
function customTold(node) {
  if (!node || !node._k) return 1;
  const { k, m, dir } = node._k;
  const ms = m ? [m] : TERMINAL_MARKETS[k];
  let f = 0, w = 0;
  for (const mm of ms) {
    let x = 1;
    for (const s of SCN.custom.shocks) {
      if (!inScope(s, k, mm)) continue;
      const scen = node.scen || {};
      if (s.type === 'cancel') { const air = s.airline ? (AIRLINE_SHARE[s.airline] || {})[mm] || 0 : 1; x *= 1 + ((scen.cancel ?? 0.95) - 1) * s.magnitude * air * windowShare(mm, s.from, s.to) / 0.1; }
      if (s.type === 'demand' && (!dir || !s.dir || s.dir === 'both' || s.dir === dir)) x *= s.magnitude;
    }
    const extra = customExtraMoves(k, mm);
    if (extra) x *= 1 + ((node.scen && node.scen.extra) ? (node.scen.extra - 1) * extra / 6 : extra * 0.012);
    const wt = m ? 1 : (BASE_SHARE[k][mm] || 0.25);
    f += x * wt; w += wt;
  }
  return w ? f / w : 1;
}
function scnFactor(node) {
  if (!scnTold() || !node) return 1;
  if (SCN.kind === 'custom') return customTold(node);
  return node.scen && node.scen[SCN.kind] != null ? node.scen[SCN.kind] : 1;
}

/* ---------------- the built-in interpreter ---------------- */
const NUMW = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, half: 0.5, third: 0.333, quarter: 0.25 };
const NUM_RE = `(\\d+(?:\\.\\d+)?|${Object.keys(NUMW).join('|')})`;
const numOf = s => (s == null ? null : /^\d/.test(s) ? parseFloat(s) : NUMW[s.toLowerCase()] ?? null);
function hourOfText(h, m, ap) {
  let x = +h + (m ? +m / 60 : 0);
  if (ap) { ap = ap.toLowerCase(); if (ap.startsWith('p') && x < 12) x += 12; if (ap.startsWith('a') && x === 12) x = 0; }
  return x;
}
const TIME_RE = '(\\d{1,2})(?:[:.h](\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';
function parseWindow(c, def) {
  let m;
  const range = new RegExp(`(?:from|between)?\\s*${TIME_RE}\\s*(?:-|–|to|until|till|and)\\s*${TIME_RE}`, 'i');
  if ((m = c.match(range)) && (m[3] || m[6] || m[2] || m[5] || /from|between/i.test(m[0]))) {
    let a = hourOfText(m[1], m[2], m[3] || (m[6] && +m[1] <= +m[4] ? m[6] : null)), b = hourOfText(m[4], m[5], m[6]);
    if (b <= a) b += 12;
    return { from: a, to: b };
  }
  const dur = c.match(new RegExp(`for\\s+(?:about\\s+|an?\\s+)?${NUM_RE}?\\s*(hours?|hrs?|minutes?|mins?)`, 'i'));
  const durH = dur ? (numOf(dur[1]) ?? 1) / (/^m/i.test(dur[2]) ? 60 : 1) : null;
  if ((m = c.match(new RegExp(`(?:at|from|since|around|after)\\s+${TIME_RE}`, 'i'))) && (m[3] || m[2] || /at|from|since/i.test(m[0]))) {
    const a = hourOfText(m[1], m[2], m[3]);
    return { from: a, to: durH ? a + durH : /\bfrom|since|after\b/i.test(m[0]) ? 26 : a + 2 };
  }
  if ((m = c.match(new RegExp(`(?:until|till|up to)\\s+${TIME_RE}`, 'i')))) return { from: 0, to: hourOfText(m[1], m[2], m[3]) };
  const parts = [[/early morning|first wave|dawn/i, 3, 8], [/morning rush|morning peak|rush hour|peak/i, 4, 9], [/\bmorning\b/i, 4, 12], [/midday|lunch/i, 11, 14],
    [/afternoon/i, 12, 18], [/evening/i, 17, 22], [/tonight|overnight|night/i, 19, 26], [/all day|whole day|all-day|today|day long/i, 0, 26]];
  for (const [re, a, b] of parts) if (re.test(c)) return durH ? { from: a, to: a + durH } : { from: a, to: b };
  if (durH) return { from: def.from, to: def.from + durH };
  return def;
}
function parseTerm(c) {
  const t1 = /\b(t1|terminal 1|terminal one|pier [123]|ryanair)\b/i.test(c), t2 = /\b(t2|terminal 2|terminal two|pier 4|aer lingus|transatlantic|us preclear)/i.test(c);
  return t1 && !t2 ? 't1' : t2 && !t1 ? 't2' : 'both';
}
function parseMarket(c) {
  if (/\b(us|usa|america|american|transatlantic|new york|boston|chicago|jfk|canada|toronto)\b/i.test(c)) return 'na';
  if (/\b(dubai|doha|middle east|long-?haul|asia|abu dhabi|istanbul)\b/i.test(c)) return 'long';
  if (/\b(uk|britain|british|london|heathrow|gatwick|manchester|edinburgh|glasgow|birmingham)\b/i.test(c)) return 'uk';
  if (/\b(spain|spanish|portugal|canar|sun|malaga|faro|alicante|tenerife|lanzarote|palma|ibiza)\b/i.test(c)) return 'eu_sun';
  if (/\b(paris|amsterdam|frankfurt|germany|german|brussels|munich|rome|milan|city routes?)\b/i.test(c)) return 'eu_city';
  return null;
}
const pct = c => { const m = c.match(/(\d+(?:\.\d+)?)\s*(?:%|per ?cent)/i); return m ? +m[1] / 100 : null; };
const HM = h => `${pad(Math.floor(h) % 24)}:${pad(Math.round((h % 1) * 60))}`;
/* Text → shocks. Each sentence or "and"-joined phrase is read on its own. */
function parseScenarioText(text) {
  const out = [], notes = [];
  const clauses = text.split(/(?<=[.;!?])\s+|\s+(?:and|plus|while|also|then)\s+(?=[a-z0-9])/i).map(s => s.trim()).filter(Boolean);
  for (const c of clauses) {
    const term = parseTerm(c), market = parseMarket(c), p = pct(c);
    const airline = /ryanair/i.test(c) ? 'R' : /aer lingus/i.test(c) ? 'A' : null;
    const W = d => parseWindow(c, d);
    const add = (type, extra) => out.push({ type, term, from: 0, to: 26, magnitude: SHOCK_TYPES[type].def, target: null, ...extra, src: c });
    let m;
    if (/power (cut|outage|failure)|blackout|electric|fire alarm|evacuat|bomb scare|security alert|suspicious (package|bag)/i.test(c)) add('power_outage', { ...W({ from: 8, to: 9 }), magnitude: 1 });
    else if (/(screeners?|security staff|security officers?)\b.*\b(sick|short|strike|absent|missing|off)|(short|shortage) of (screeners|security)/i.test(c)) add('security_staff', { ...W({ from: 0, to: 26 }), magnitude: p ?? (/strike/i.test(c) ? 0.5 : 0.2) });
    else if (/(security|screening|scanner|x-?ray|lanes?)\b.*\b(fail|down|out|broken|closed|fault|offline)|(fail|close|lose)\w*\b.*\blanes?/i.test(c)) {
      m = c.match(/(\d+|\w+)\s+(?:security\s+|screening\s+)?(?:lanes?|scanners?)/i);
      add('security_lanes', { ...W({ from: 7, to: 9 }), magnitude: Math.round(numOf(m && m[1]) || (/all/i.test(c) ? 99 : 3)) });
    }
    else if (/(passport|immigration|border|officers?)\b.*\b(sick|short|strike|absent|missing|work to rule)/i.test(c)) add('imm_staff', { ...W({ from: 0, to: 26 }), magnitude: p ?? 0.3 });
    else if (/e-?gates?/i.test(c)) add('egates_down', W({ from: 0, to: 26 }));
    else if (/(check-?in|bag drop|departure control|dcs|it system|booking system|airline system)\b.*\b(outage|down|fail|crash|offline)|(outage|crash)\b.*\bcheck-?in/i.test(c)) add('checkin_outage', { ...W({ from: 6, to: 8 }), magnitude: 3 });
    else if (/(baggage|bag(gage)? system|sorter|hbs|hold baggage)\b.*\b(fail|down|outage|broken|fault|stop)/i.test(c)) add('baggage_failure', { ...W({ from: 14, to: 15.5 }), magnitude: p ?? (/partial|slow/i.test(c) ? 0.5 : 0.85) });
    else if (/fog|low visibility|lvp|mist/i.test(c)) add('weather', { ...W({ from: 5, to: 10 }), target: 'fog', term: 'both' });
    else if (/storm|gale|red warning|orange warning|hurricane|high winds?/i.test(c)) { add('weather', { ...W({ from: 6, to: 14 }), target: 'storm', term: 'both' }); add('cancel', { from: 6, to: 16, magnitude: /orange/i.test(c) ? 0.1 : 0.25, term: 'both' }); }
    else if (/snow|ice|icy|freezing|blizzard/i.test(c)) { add('weather', { ...W({ from: 4, to: 11 }), target: 'snow', term: 'both' }); add('cancel', { from: 4, to: 12, magnitude: 0.08, term: 'both' }); }
    else if (/runway/i.test(c)) {
      const closed = /clos|shut|block|incident|crash|disabled/i.test(c);
      add('runway', { ...W({ from: 7, to: 8 }), term: 'both', magnitude: closed && !/one runway|single|reduced/i.test(c) ? 0.05 : /single|one runway/i.test(c) ? 0.55 : p != null ? 1 - p : 0.5 });
    }
    else if (/cancel/i.test(c)) {
      m = c.match(/(\d+|\w+)\s+(?:\w+\s+)?flights?/i);
      const n = numOf(m && m[1]);
      let share = p ?? null;
      if (share == null && n != null && n >= 1) share = clamp(n / (gen ? gen.flights.length * (airline ? 0.5 : 1) : 300), 0.01, 1);
      add('cancel', { ...W({ from: 0, to: 26 }), magnitude: share ?? 0.1, market, airline, term: airline === 'R' ? 't1' : airline === 'A' ? 't2' : term });
    }
    else if (!/air traffic|\batc\b/i.test(c) && /\b(m1|m50|n2|road|roads|traffic|motorway|port tunnel|congestion|gridlock|roadworks)\b/i.test(c)) {
      m = c.match(new RegExp(`\\b${NUM_RE}[\\s-]*(minutes?|mins?|hours?|hrs?)`, 'i'));
      add('road_delay', { ...W({ from: 6, to: 9 }), magnitude: m ? numOf(m[1]) * (/^h/i.test(m[2]) ? 60 : 1) : /gridlock|closed|closure/i.test(c) ? 50 : 30 });
    }
    else if (/(atc|air traffic|flow control|slot restriction)|delay/i.test(c)) {
      m = c.match(new RegExp(`\\b${NUM_RE}[\\s-]*(hours?|hrs?|minutes?|mins?)\\b`, 'i'));
      let mins = m ? numOf(m[1]) * (/^h/i.test(m[2]) ? 60 : 1) : null;
      if (/for\s/i.test(m ? c.slice(Math.max(0, m.index - 4), m.index) : '')) mins = null;
      const fr = /france|french/i.test(c);
      const dir = /arriv|inbound|landing/i.test(c) ? 'arr' : /depart|outbound/i.test(c) ? 'dep' : 'both';
      if (fr && !market) { for (const mk of ['eu_sun', 'eu_city']) add('delay', { ...W({ from: 6, to: 20 }), magnitude: mins ?? 60, market: mk, dir }); }
      else add('delay', { ...W({ from: 6, to: 12 }), magnitude: mins ?? 45, market, dir, airline });
    }
    else if (/(extra|new|additional|more)\s+(?:\w+\s+)?(flights?|routes?|services|movements|rotations)/i.test(c)) {
      m = c.match(/(\d+|\w+)\s+(?:extra|new|additional|more)?\s*(?:\w+\s+)?(?:flights?|movements|services)/i);
      add('extra_flights', { magnitude: numOf(m && m[1]) || 6, market: market || 'eu_city', term: term === 'both' ? 't1' : term });
    }
    else if (/concert|match|festival|conference|summit|rugby|football|final|six nations|event|visit|parade|marathon/i.test(c)) {
      const f = p != null ? 1 + p : /huge|massive|major|sold.?out|stadium/i.test(c) ? 1.12 : 1.07;
      const dir = /leav|after|depart|going home|outbound/i.test(c) ? 'dep' : /tonight|arriv|coming|fans|visitors|inbound/i.test(c) ? 'arr' : 'both';
      for (const mk of market ? [market] : ['uk', 'eu_city']) add('demand', { magnitude: f, market: mk, dir });
    }
    else if (/(bus|coach|dublin bus|aircoach|dublin express|shuttle)\b.*\b(strike|cancel|disrupt|not running|withdrawn|suspend)/i.test(c)) add('bus_strike', { ...W({ from: 0, to: 26 }), magnitude: p ?? (/strike|not running|suspend/i.test(c) ? 1 : 0.5) });
    else if (/taxi|cab/i.test(c)) add('taxi_shortage', { ...W({ from: 0, to: 26 }), magnitude: p ?? (/strike|protest/i.test(c) ? 0.6 : 0.3) });
    else if (/car ?park|parking/i.test(c)) {
      const id = /holiday blue/i.test(c) ? 'hb' : /car park a\b/i.test(c) ? 'cpa_t1' : term === 't2' ? 'st_t2' : 'st_t1';
      add('carpark_closed', { magnitude: p ?? 1, target: id, term: CARPARKS[id].term || 'both' });
    }
    else if (/pier\s*([1-4])|south gates/i.test(c) && /clos|shut|maintenance|out of use|evacuat/i.test(c)) {
      m = c.match(/pier\s*([1-4])/i);
      const pid = m ? 'P' + m[1] : null;
      if (pid) add('pier_closed', { ...W({ from: 0, to: 26 }), target: pid, term: pid === 'P4' ? 't2' : 't1' });
      else notes.push(`"${c}": the South Gates are remote stands; try "Pier 3 closed" or a bus shortage`);
    }
    else if (/travelator|walkway|escalator|moving walk/i.test(c)) {
      m = c.match(/pier\s*([1-4])/i);
      add('walkway_slow', { ...W({ from: 0, to: 26 }), target: m ? 'P' + m[1] : null, magnitude: 1.3 });
    }
    else if (/busier|more passengers|surge|demand|bank holiday|half.?term|holiday rush|quieter|fewer passengers/i.test(c)) {
      const down = /quieter|fewer|drop|fall/i.test(c);
      add('demand', { magnitude: p != null ? (down ? 1 - p : 1 + p) : down ? 0.93 : 1.08, market });
    }
    else notes.push(`Not understood: "${c}"`);
  }
  for (const s of out) {
    s.from = clamp(s.from, 0, 26); s.to = clamp(Math.max(s.to, s.from + 0.25), 0, 26);
    // Weather passes: an open-ended "from 6am" storm, fog or snow lasts at most eight hours.
    if (s.type === 'weather' && s.to - s.from > 8 && !/all day|whole day/i.test(s.src)) s.to = s.from + 8;
  }
  return { shocks: out, notes, title: text.length > 64 ? text.slice(0, 61) + '…' : text, source: 'built-in parser' };
}
function describeShock(s) {
  const T = SHOCK_TYPES[s.type];
  const where = s.term === 'both' ? '' : ` · ${GEO[s.term].short}`;
  const when = T.window ? (s.from <= 0 && s.to >= 26 ? ' · all day' : ` · ${HM(s.from)}–${HM(s.to)}`) : '';
  const mag = s.type === 'security_lanes' ? `${s.magnitude >= 99 ? 'all' : s.magnitude} lanes` : s.type === 'weather' ? s.target
    : s.type === 'delay' || s.type === 'road_delay' ? `${Math.round(s.magnitude)} min` : s.type === 'demand' ? `${s.magnitude >= 1 ? '+' : ''}${Math.round((s.magnitude - 1) * 100)}%`
    : s.type === 'extra_flights' ? `+${s.magnitude}` : s.type === 'checkin_outage' || s.type === 'walkway_slow' ? `×${s.magnitude}` : s.type === 'runway' ? `${Math.round(s.magnitude * 100)}% of normal`
    : ['egates_down', 'power_outage', 'pier_closed'].includes(s.type) ? '' : `${Math.round(s.magnitude * 100)}%`;
  const scope = [s.market && MARKETS[s.market].short, s.airline && { R: 'Ryanair', A: 'Aer Lingus' }[s.airline], s.target && s.type !== 'weather' && (CARPARKS[s.target] ? CARPARKS[s.target].name : s.target), s.dir && s.dir !== 'both' && (s.dir === 'arr' ? 'arrivals' : 'departures')].filter(Boolean).join(', ');
  return `${T.label}${mag ? ' · ' + mag : ''}${scope ? ' · ' + scope : ''}${where}${when}`;
}
