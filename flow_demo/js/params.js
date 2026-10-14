'use strict';
/* ====================================================================
   Constants and assumptions. Every operational number in this file is
   invented for the demo (illustrative), not a daa figure.
   ==================================================================== */
const DATA = window.FLOW_DATA;
const DAY_START = 2.5 * 3600;           // 02:30, T1 security opens
const DAY_END = 24 * 3600;
const SIM_END = 25.5 * 3600;            // runs past midnight for late inbound flights
const SLOT = 1800;                       // roster granularity (s)
const LANE_RATE = 165;                   // pax per security lane-hour
const SEC_SVC = 3600 / LANE_RATE;        // s per pax per lane
const DESK_SVC = 90;                     // s per party at a check-in desk (longer for bigger parties)
const UTIL = 0.9;                        // target utilisation when rostering booths
const SEC_UTIL = 0.95;                   // security lanes are rostered leaner, slot by slot; the surge rule covers spikes
const SURGE = 3, SURGE_ON = 20, SURGE_OFF = 5;   // duty managers redeploy up to three lanes once the wait passes 20 min
const DEP_SHARE = 0.5;                   // fallback departing share when the export has no directions
const OPEN = { t1: 2.5 * 3600, t2: 3.5 * 3600 };   // published security opening times
const TERMS = ['t1', 't2'];
const PLANS = [
  { key: 'hist', name: 'History only', short: 'History only', desc: 'TimesFM univariate · no schedule or events', field: 'univariate' },
  { key: 'tfm', name: 'Schedule + events · P50', short: 'Covariates P50', desc: 'TimesFM with covariates · median', field: 'joint_with_covariates' },
  { key: 'p90', name: 'Schedule + events · P90', short: 'Covariates P90', desc: 'TimesFM with covariates · cautious', field: 'q90' },
];
const KIND = { DEP: 0, ARR: 1, TRF: 2, GRT: 3, STF: 4 };
const KINDS = [
  { key: 'dep', name: 'Departing', color: '#38bdf8' },
  { key: 'arr', name: 'Arriving', color: '#fb923c' },
  { key: 'trf', name: 'Transfer', color: '#c084fc' },
  { key: 'grt', name: 'Meeter / greeter', color: '#94a3b8' },
  { key: 'stf', name: 'Staff', color: '#facc15' },
];

// Destination markets: departure banks by hour, destinations, aircraft (name, seats, widebody).
const H = o => Array.from({ length: 24 }, (_, h) => o[h] || 0);
const MARKETS = {
  uk: { name: 'United Kingdom', short: 'UK', color: '#60a5fa', long: false, nonEU: 0.08, egate: 0, cta: true,
    depW: H({ 6: 9, 7: 9, 8: 8, 9: 6, 10: 5, 11: 5, 12: 5, 13: 5, 14: 5, 15: 5, 16: 6, 17: 8, 18: 8, 19: 6, 20: 5, 21: 4, 22: 1 }),
    dests: [['London Heathrow', 'LHR'], ['London Gatwick', 'LGW'], ['London Stansted', 'STN'], ['Manchester', 'MAN'], ['Birmingham', 'BHX'], ['Edinburgh', 'EDI'], ['Glasgow', 'GLA'], ['Bristol', 'BRS'], ['Newcastle', 'NCL'], ['Leeds Bradford', 'LBA']],
    aircraft: [['A320', 174], ['737-800', 189], ['A321neo', 212], ['ATR 72', 70]] },
  eu_city: { name: 'Europe · city & business', short: 'EU city', color: '#a78bfa', long: false, nonEU: 0.18, egate: 0.55,
    depW: H({ 6: 10, 7: 9, 8: 7, 9: 6, 10: 6, 11: 6, 12: 5, 13: 5, 14: 5, 15: 5, 16: 6, 17: 6, 18: 6, 19: 5, 20: 4, 21: 2 }),
    dests: [['Amsterdam', 'AMS'], ['Paris CDG', 'CDG'], ['Frankfurt', 'FRA'], ['Brussels', 'BRU'], ['Copenhagen', 'CPH'], ['Munich', 'MUC'], ['Zürich', 'ZRH'], ['Berlin', 'BER'], ['Rome', 'FCO'], ['Milan', 'MXP'], ['Lisbon', 'LIS'], ['Prague', 'PRG'], ['Vienna', 'VIE'], ['Kraków', 'KRK']],
    aircraft: [['A320', 174], ['737-800', 189], ['A321neo', 212]] },
  eu_sun: { name: 'Europe · sun & leisure', short: 'EU sun', color: '#fbbf24', long: false, nonEU: 0.06, egate: 0.6,
    depW: H({ 6: 11, 7: 10, 8: 9, 9: 8, 10: 7, 11: 6, 12: 6, 13: 5, 14: 5, 15: 5, 16: 5, 17: 4, 18: 4, 19: 3, 20: 2 }),
    dests: [['Málaga', 'AGP'], ['Alicante', 'ALC'], ['Faro', 'FAO'], ['Lanzarote', 'ACE'], ['Tenerife South', 'TFS'], ['Palma', 'PMI'], ['Barcelona', 'BCN'], ['Ibiza', 'IBZ'], ['Nice', 'NCE'], ['Fuerteventura', 'FUE']],
    aircraft: [['737-8200', 197], ['737-800', 189], ['A321neo', 212]] },
  na: { name: 'North America', short: 'N. America', color: '#34d399', long: true, nonEU: 0.55, egate: 0.5,
    depW: H({ 9: 4, 10: 9, 11: 12, 12: 12, 13: 11, 14: 10, 15: 10, 16: 9, 17: 6, 18: 4 }),
    dests: [['New York JFK', 'JFK', 1], ['Boston', 'BOS', 1], ['Chicago O’Hare', 'ORD', 1], ['Washington Dulles', 'IAD', 1], ['Orlando', 'MCO', 1], ['Philadelphia', 'PHL', 1], ['Toronto', 'YYZ', 0]],
    aircraft: [['A321XLR', 184], ['A330-300', 317, 1], ['787-9', 290, 1]] },
  long: { name: 'Middle East & long-haul', short: 'Long-haul', color: '#f472b6', long: true, nonEU: 0.62, egate: 0.45,
    depW: H({ 8: 4, 9: 10, 10: 6, 13: 6, 14: 10, 15: 8, 20: 4, 21: 6, 22: 4 }),
    dests: [['Dubai', 'DXB'], ['Doha', 'DOH'], ['Abu Dhabi', 'AUH'], ['Addis Ababa', 'ADD'], ['Istanbul', 'IST']],
    aircraft: [['777-300ER', 354, 1], ['787-9', 290, 1], ['A350-900', 325, 1]] },
};
const TERMINAL_MARKETS = { t1: ['uk', 'eu_city', 'eu_sun'], t2: ['uk', 'eu_city', 'na', 'long'] };
const BASE_SHARE = { t1: { uk: .30, eu_city: .34, eu_sun: .36 }, t2: { uk: .22, eu_city: .30, na: .36, long: .12 } };
const TRANSFER_SHARE = { t1: { uk: .01, eu_city: .02, eu_sun: .005 }, t2: { uk: .03, eu_city: .04, na: .14, long: .06 } };
const RESIDENT_SHARE = { uk: .55, eu_city: .50, eu_sun: .85, na: .35, long: .50 };
// Where a transferring passenger goes next.
const TRANSFER_ONWARD = { na: { eu_city: .6, uk: .4 }, long: { uk: .5, eu_city: .5 }, eu_city: { na: 1 }, uk: { na: 1 }, eu_sun: { uk: .5, eu_city: .5 } };

/* Passenger personas.
   lead   minutes before departure they reach the airport (mean, sd)
   call   minutes before departure they head for the gate
   svc    security screening time multiplier
   bags   checked bags per passenger (short-haul; long-haul x1.5)
   met    chance an arriving party is met in the arrivals hall
   lounge chance of lounge access (T2, T1) */
const PERSONAS = {
  business: { name: 'Business', color: '#38bdf8', lead: [70, 14], longExtra: 40, speed: 1.45, svc: 0.8, chk: 0.10, ft: 0.4, call: [30, 5], size: [1, 1], bags: 0.15, met: 0.12, lounge: [0.6, 0.25], imm: 1.0 },
  leisure: { name: 'Leisure', color: '#a3e635', lead: [110, 22], longExtra: 50, speed: 1.25, svc: 0.95, chk: 0.45, ft: 0.05, call: [45, 8], size: [1, 2], bags: 0.55, met: 0.28, lounge: [0.02, 0.02], imm: 1.0 },
  family: { name: 'Family', color: '#fb923c', lead: [135, 22], longExtra: 50, speed: 1.0, svc: 1.3, chk: 0.85, ft: 0.03, call: [55, 8], size: [3, 5], bags: 0.9, met: 0.42, lounge: [0, 0], imm: 1.2 },
  group: { name: 'Group / party', color: '#e879f9', lead: [105, 20], longExtra: 45, speed: 1.3, svc: 1.0, chk: 0.3, ft: 0.02, call: [40, 10], size: [4, 8], bags: 0.6, met: 0.6, lounge: [0, 0], imm: 1.0 },
  prm: { name: 'Reduced mobility', color: '#f8fafc', lead: [140, 20], longExtra: 40, speed: 0.6, svc: 2.0, chk: 0.8, ft: 0, call: [65, 5], size: [1, 2], bags: 0.8, met: 0.5, lounge: [0, 0], imm: 1.6 },
};
const PERSONA_KEYS = Object.keys(PERSONAS);
const DEFAULT_MIX = { business: .2, leisure: .52, family: .18, group: .088, prm: .012 };
const FT_LANES = 2, FT_MERGE = 300;
// T1 pier choice by airline group: Ryanair mostly Pier 1 and Pier 3, the others mostly Pier 2 (illustrative).
const PIER_PREF = { R: { P1: .55, P3: .3, P2: .15 }, O: { P2: .65, P1: .15, P3: .2 } };

/* Ground access, same tables as forecast_operations.py. "met" is drop-off on
   departure and met-by-car on arrival. Visitors have no car at the airport. */
const MODES = ['met', 'taxi', 'bus', 'short_term', 'holiday_blue', 'rental'];
const MODE_NAMES = { met: 'Dropped off / met', taxi: 'Taxi', bus: 'Bus & coach', short_term: 'Short-term car park', holiday_blue: 'Holiday Blue', rental: 'Car hire' };
const MODE_SHARE = {
  business: { met: .12, taxi: .45, bus: .12, short_term: .15, holiday_blue: .06, rental: .10 },
  leisure: { met: .28, taxi: .18, bus: .28, short_term: .04, holiday_blue: .12, rental: .10 },
  family: { met: .42, taxi: .12, bus: .08, short_term: .03, holiday_blue: .22, rental: .13 },
  group: { met: .10, taxi: .10, bus: .70, short_term: 0, holiday_blue: 0, rental: .10 },
  prm: { met: .50, taxi: .35, bus: .05, short_term: .05, holiday_blue: .05, rental: 0 },
};
function modeSplit(persona, resident) {
  const b = MODE_SHARE[persona], car = b.short_term + b.holiday_blue, out = {};
  for (const m of MODES) {
    let vis = b[m];
    if (m === 'short_term' || m === 'holiday_blue') vis = 0;
    if (m === 'rental') vis += 0.6 * car;
    if (m === 'taxi') vis += 0.4 * car;
    out[m] = resident * b[m] + (1 - resident) * vis;
  }
  return out;
}

/* Immigration (illustrative). Seconds per passenger; parties are served together. */
const IMM = {
  svc: { eu: 18, cta: 12, non: 60, egate: 22 },
  egateReject: 0.15,
  booths: { t1: { eu: 14, non: 12, egate: 10 }, t2: { eu: 16, non: 24, egate: 16 } },
  egateHours: [5 * 3600, 26 * 3600],
  open: 4.5 * 3600,
  surge: 4, surgeOn: 20, surgeOff: 8,
};
const CUSTOMS = { stopEU: 0.015, stopNon: 0.03, stopMin: [4, 10] };

/* Baggage (illustrative). */
const BAGS = {
  hbsPerTerm: 3, hbsRate: 1200, l2: 0.08, l2s: [30, 90], l3: 0.01, l3s: [300, 600],
  laterals: { t1: 12, t2: 8 }, lateralOpen: 150 * 60, lateralClose: 40 * 60, cartSize: 40, lastCart: 35 * 60, shortShip: 30 * 60,
  teams: { t1: 8, t2: 6 }, firstCart: [10, 14], cartGap: [3, 5], induct: 20 / 60, beltSpeed: 0.5, pickup: [30, 90],
  belt: 2, tunnel: 90,
};

/* Landside (illustrative). */
const ROAD_VMAX = 9;
const KERB_DWELL = { met: [60, 180], taxi: [45, 90], perBag: 20 };
const CARPARK_CAP = { st_t1: 3000, st_t2: 2600, cpa_t1: 1000, surf_t2: 800, hb: 12000, dropgo: 120, staff: 4500 };
const TAXI = { bays: { t1: 17, t2: 14 }, holdingCap: 300, rejoin: 0.3, load: [25, 45],
  // The rank dispatcher calls 25% more cabs once a rank queue passes 40 parties, until it falls below 10.
  surgeOn: 40, surgeOff: 10, surgeX: 1.25 };
const BUSES = [
  { id: 'city', name: 'City bus', headway: 8, from: 5, to: 23.5, cap: 90, color: '#22c55e' },
  { id: 'express', name: 'City express coach', headway: 6, from: 4.5, to: 24.5, cap: 55, color: '#16a34a' },
  { id: 'regional', name: 'Regional coach', headway: 20, from: 5, to: 23, cap: 55, color: '#15803d' },
  { id: 'hotel', name: 'Hotel shuttle', headway: 15, from: 4, to: 24, cap: 16, color: '#4ade80' },
];
const RENTAL = { desks: 13, svc: [150, 300], shuttleHeadway: 4, shuttleCap: 50 };
const HB_SHUTTLE = { cap: 60, minPerHour: 4, maxPerHour: 15, loopMin: 12 };

/* Staff (illustrative). */
const SHIFTS = {
  early: { start: 4 * 3600, end: 12.5 * 3600, window: [70, 15] },
  mid: { start: 9.5 * 3600, end: 18 * 3600, window: [45, 15] },
  late: { start: 14 * 3600, end: 22.5 * 3600, window: [45, 15] },
  night: { start: 21.5 * 3600, end: 30 * 3600, window: [40, 8] },
};
const STAFF = { lanes: 10, svc: 25, secondary: 0.1, secondarySvc: 90, airside: 0.7, sample: 1 };

/* Commerce (illustrative). conv = chance a party visits, by persona;
   spend = euro per transaction (shown only as category totals). */
const CATS = {
  dutyfree: { name: 'Duty free', color: '#f59e0b', conv: { leisure: .22, family: .16, business: .08, group: .25, prm: .10 }, spend: 38, dwell: [3, 8], cap: 60 },
  luxury: { name: 'Luxury', color: '#eab308', conv: { leisure: .02, family: .01, business: .04, group: .01, prm: .01 }, spend: 95, dwell: [6, 12], cap: 15 },
  gifts: { name: 'Irish gifts & whiskey', color: '#84cc16', conv: { leisure: .06, family: .05, business: .03, group: .06, prm: .04 }, spend: 32, dwell: [5, 10], cap: 30 },
  news: { name: 'News & convenience', color: '#06b6d4', conv: { leisure: .20, family: .25, business: .15, group: .15, prm: .20 }, spend: 9, dwell: [3, 6], cap: 40 },
  tech: { name: 'Tech', color: '#0ea5e9', conv: { leisure: .02, family: .01, business: .06, group: .02, prm: 0 }, spend: 45, dwell: [4, 8], cap: 15 },
  bar: { name: 'Bars', color: '#f97316', conv: { leisure: .18, family: .05, business: .12, group: .45, prm: .05 }, spend: 24, dwell: [25, 45], cap: 120 },
  restaurant: { name: 'Restaurants', color: '#ef4444', conv: { leisure: .15, family: .30, business: .08, group: .20, prm: .20 }, spend: 21, dwell: [25, 40], cap: 100 },
  cafe: { name: 'Cafés', color: '#d946ef', conv: { leisure: .25, family: .25, business: .35, group: .15, prm: .30 }, spend: 7, dwell: [6, 15], cap: 40 },
  quick: { name: 'Quick service', color: '#fb7185', conv: { leisure: .12, family: .30, business: .03, group: .20, prm: .10 }, spend: 11, dwell: [12, 20], cap: 80 },
  lounge: { name: 'Lounges', color: '#38bdf8', conv: {}, spend: 39, dwell: [40, 90], cap: 150 },
  play: { name: 'Play areas', color: '#a3e635', conv: { family: .3 }, spend: 0, dwell: [15, 30], cap: 30 },
  seating: { name: 'Seating', color: '#64748b', conv: {}, spend: 0, dwell: [10, 30], cap: 400 },
};
const DF_TILLS = { t1: 12, t2: 10 }, DF_SVC = [60, 90];
const CONV_SCALE = 0.65;   // overall propensity to stop at a shop or café (illustrative)
const OUTLET_BALK = 6;

/* Stage zones for colour, counts and the where-now table. */
const ZONES = [
  { name: 'Landside', color: '#7dd3fc' },
  { name: 'Check-in & bag drop', color: '#a78bfa' },
  { name: 'Security', color: '#fbbf24' },
  { name: 'Lounge & shops', color: '#34d399' },
  { name: 'Piers & gates', color: '#f472b6' },
  { name: 'Arrivals corridor', color: '#fdba74' },
  { name: 'Immigration', color: '#f87171' },
  { name: 'Baggage reclaim', color: '#facc15' },
  { name: 'Arrivals hall', color: '#fb923c' },
  { name: 'Ground transport', color: '#4ade80' },
  { name: 'Staff', color: '#eab308' },
];
const Z = { LAND: 0, CHK: 1, SEC: 2, LOUNGE: 3, GATE: 4, CORR: 5, IMM: 6, RECLAIM: 7, HALL: 8, GROUND: 9, STAFF: 10 };
const WAIT_COLORS = ['#64748b', '#34d399', '#fbbf24', '#fb923c', '#f43f5e'];
const TERM_COLORS = ['#38bdf8', '#f472b6'];
