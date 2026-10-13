'use strict';
/* ====================================================================
   Outlets and lounges. Names, terminal and area (before security,
   after security, pier, arrivals, US preclearance) come from daa's public
   interactive map (pcmap-dub). Order within each zone follows their real
   relative positions. Categories marked "assumed" are our guess from the
   name. Sizes, capacities and every spend figure are invented.
   ==================================================================== */
const OUTLET_ZONES = {
  't1.air': { term: 't1', side: 'air', rows: 2 }, 't1.df': { term: 't1', side: 'air', rows: 1 },
  't1.food': { term: 't1', side: 'land', rows: 1 }, 't1.hall': { term: 't1', side: 'arr', rows: 1 },
  'P1.hub': { term: 't1', side: 'air', rows: 1 }, 'P2.hub': { term: 't1', side: 'air', rows: 1 }, 'P3.hub': { term: 't1', side: 'air', rows: 1, vertical: true },
  't2.air': { term: 't2', side: 'air', rows: 2 }, 't2.df': { term: 't2', side: 'air', rows: 1 },
  't2.food': { term: 't2', side: 'land', rows: 1 }, 't2.hall': { term: 't2', side: 'arr', rows: 1 },
  'P4.hub': { term: 't2', side: 'air', rows: 1 }, 'us': { term: 't2', side: 'us', rows: 3 },
};
const FACILITIES = [
  // Terminal 1, after security (central)
  ["Lilian's", 'bar', 't1.air'],                       // assumed bar
  ['The Gate Clock Bar', 'bar', 't1.air'],
  ['Marqette Café', 'restaurant', 't1.air'],
  ['Street Kitchen', 'restaurant', 't1.air'],
  ['Bluebird Coffee Roasters', 'cafe', 't1.air'],
  ['Butlers Chocolate Cafe', 'cafe', 't1.air'],
  ['Burger King', 'quick', 't1.air'],
  ['The Garden Terrace', 'restaurant', 't1.air'],
  ['Roasted Notes', 'cafe', 't1.air'],
  ['Seating', 'seating', 't1.air'],
  ['Chanel', 'luxury', 't1.air'],
  ['Jo Malone', 'luxury', 't1.air'],
  ['Candy Cloud', 'gifts', 't1.air'],                  // assumed gifts
  ['WHSmith', 'news', 't1.air'],
  ['Dublin Airport Duty Free', 'dutyfree', 't1.air'],
  ['Children Play Area', 'play', 't1.air'],
  ['Seating', 'seating', 't1.air'],
  ['The Phoenix Lounge', 'lounge', 't1.air', { cap: 150 }],
  ['Dublin Airport Duty Free', 'dutyfree', 't1.df', { walk: true, cap: 400 }],
  // Terminal 1 piers
  ['Nineteen 40', 'bar', 'P1.hub'],                    // assumed bar
  ['Tap & Brew', 'cafe', 'P1.hub'],
  ['Jump Juice Bar', 'cafe', 'P1.hub'],
  ['Dublin Airport Duty Free', 'dutyfree', 'P1.hub'],
  ['WHSmith', 'news', 'P1.hub'],
  ['Leopold Pier 2', 'bar', 'P2.hub'],                 // assumed bar
  ['WHSmith', 'news', 'P2.hub'],
  ['Seating', 'seating', 'P3.hub'],
  // Terminal 1, before security
  ['Food Village', 'restaurant', 't1.food'],
  ['McDonalds', 'quick', 't1.food'],
  ['The Clipper', 'bar', 't1.food'],                   // assumed bar
  ['Upper Crust', 'quick', 't1.food'],
  ['Cloud Picker', 'cafe', 't1.food'],
  // Terminal 1, arrivals
  ['Insomnia', 'cafe', 't1.hall'],
  ['WHSmith', 'news', 't1.hall'],
  ['Shop & Drop - Dublin Duty Free', 'dutyfree', 't1.hall'],
  ['Bus & Travel Information', 'service', 't1.hall'],
  // Terminal 2, after security
  ['Guinness Export House', 'gifts', 't2.air'],
  ['Jameson Taste House', 'gifts', 't2.air'],
  ['Design Ireland', 'gifts', 't2.air'],
  ['We Love Ireland', 'gifts', 't2.air'],
  ['The Irish Market Store', 'gifts', 't2.air'],
  ['Dixons', 'tech', 't2.air'],
  ['Fruitality', 'gifts', 't2.air'],                   // assumed gifts
  ['WHSmith', 'news', 't2.air'],
  ['Butlers Chocolate Cafe', 'cafe', 't2.air'],
  ['Market 53', 'restaurant', 't2.air'],
  ['Harvest Market Deli', 'restaurant', 't2.air'],
  ['Burger King', 'quick', 't2.air'],
  ['The Coffee Cart', 'cafe', 't2.air'],
  ["Children's Play Area", 'play', 't2.air'],
  ['Seating', 'seating', 't2.air'],
  ['Aer Lingus Lounge', 'lounge', 't2.air', { cap: 400 }],
  ['Aer Lingus Revival Lounge', 'lounge', 't2.air', { cap: 150 }],
  ['The Liffey Lounge', 'lounge', 't2.air', { cap: 120 }],
  ['The Martello Lounge', 'lounge', 't2.air', { cap: 100 }],
  ['Dublin Airport Duty Free', 'dutyfree', 't2.df', { walk: true, cap: 350 }],
  ['Dublin Airport Duty Free', 'dutyfree', 'P4.hub'],
  ['WHSmith', 'news', 'P4.hub'],
  // Terminal 2, US preclearance (after US Customs and Border Protection)
  ['Whiskey Bread', 'restaurant', 'us'],               // assumed restaurant
  ['Dubh', 'cafe', 'us'],
  ['Phoenix Lane', 'cafe', 'us'],
  ['51st&Green Lounge', 'lounge', 'us', { cap: 120 }],
  // Terminal 2, before security
  ["Bewley's", 'cafe', 't2.food'],
  ['Fitzgerald’s', 'bar', 't2.food'],                  // assumed bar
  ['Diep Noodle Bar', 'restaurant', 't2.food'],
  ['Gourmet Burger Kitchen', 'restaurant', 't2.food'],
  ["O'Briens Sandwich Bar", 'quick', 't2.food'],
  ['Supermac’s / Papa John’s / SuperSubs / Moo Parlour', 'quick', 't2.food'],
  // Terminal 2, arrivals
  ['Spar', 'news', 't2.hall'],
  ['Shop & Drop - Dublin Duty Free', 'dutyfree', 't2.hall'],
];

function zoneRect(zone) {
  const [a, b] = zone.split('.');
  if (zone === 'us') return GEO.t2.preclear.lounge;
  if (b === 'hub') { for (const k of TERMS) { const p = GEO[k].pierById[a]; if (p) return p.hub; } }
  const G = GEO[a];
  if (b === 'air') return G.air;
  if (b === 'df') return G.df;
  if (b === 'food') return G.food;
  if (b === 'hall') return { x: G.arrHall.x, y: 1112, w: G.arrHall.w * (G.id === 't1' ? 0.6 : 0.62), h: 20 };
  throw new Error('Unknown zone ' + zone);
}

/* Lay outlets out left to right, row by row, sized by a category weight. */
const CAT_WEIGHT = { lounge: 2.2, restaurant: 1.5, bar: 1.4, seating: 1.6, dutyfree: 1.2, quick: 1.2, play: 1, cafe: 0.9, news: 0.8, gifts: 0.9, luxury: 0.7, tech: 0.8, service: 0.8 };
function buildOutlets() {
  const byZone = {};
  FACILITIES.forEach(([name, cat, zone, opt]) => (byZone[zone] = byZone[zone] || []).push({ name, cat, zone, opt: opt || {} }));
  const out = [];
  for (const [zone, list] of Object.entries(byZone)) {
    const z = OUTLET_ZONES[zone], r = zoneRect(zone), rows = z.rows, gap = 2;
    const total = list.reduce((s, o) => s + CAT_WEIGHT[o.cat], 0), perRow = total / rows;
    let row = 0, acc = 0;
    const rowsOf = [[]];
    for (const o of list) {
      if (acc + CAT_WEIGHT[o.cat] / 2 > perRow * (row + 1) && row < rows - 1) { row++; rowsOf.push([]); }
      rowsOf[row].push(o); acc += CAT_WEIGHT[o.cat];
    }
    rowsOf.forEach((items, ri) => {
      const w = items.reduce((s, o) => s + CAT_WEIGHT[o.cat], 0);
      let cur = 0;
      for (const o of items) {
        const f0 = cur / w, f1 = (cur + CAT_WEIGHT[o.cat]) / w; cur += CAT_WEIGHT[o.cat];
        let rect;
        if (z.vertical) rect = { x: r.x, y: r.y + r.h * f0 + gap / 2, w: r.w, h: r.h * (f1 - f0) - gap };
        else rect = { x: r.x + r.w * f0 + gap / 2, y: r.y + ri * (r.h / rows) + gap / 2, w: r.w * (f1 - f0) - gap, h: r.h / rows - gap };
        const cat = CATS[o.cat] || { cap: 20 };
        out.push({
          id: out.length, name: o.name, cat: o.cat, zone, term: z.term, side: z.side, rect,
          cap: o.opt.cap || cat.cap || 20, walk: !!o.opt.walk, tills: o.opt.walk ? DF_TILLS[z.term] : 2,
          entry: { x: rect.x + rect.w / 2, y: z.side === 'air' || z.side === 'us' ? rect.y + rect.h : rect.y + rect.h },
        });
      }
    });
  }
  return out;
}
const OUTLETS = buildOutlets();
const OUTLETS_BY_ZONE = {};
for (const o of OUTLETS) (OUTLETS_BY_ZONE[o.zone] = OUTLETS_BY_ZONE[o.zone] || []).push(o);
const WALK_DF = { t1: OUTLETS.find(o => o.walk && o.term === 't1'), t2: OUTLETS.find(o => o.walk && o.term === 't2') };
