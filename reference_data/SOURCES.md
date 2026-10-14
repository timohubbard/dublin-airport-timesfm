# Reference data

`cso_dublin_monthly.csv` was retrieved on 2026-10-13 from the Central Statistics Office (CSO) PxStat API and is used under the CSO's open-data licence (CC BY 4.0).

- TAM08 *Passengers handled by main airports*: https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM08/JSON-stat/2.0/en
- TAM07 *Passengers, Freight and Commercial Flights* (by country and direction): https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM07/JSON-stat/2.0/en
- Release page: https://www.cso.ie/en/statistics/transport/aviationstatistics/

Columns: `passengers` is TAM08 commercial passengers at Dublin (arrivals plus departures; transit passengers count twice). `commercial_flights` is TAM07 commercial flights, all directions. `share_<market>` is each demo market's share of TAM07 passengers and `dep_share_<market>` its departing share; see `real_data.py` for the country mapping.

Figures are subject to CSO revision.

## Airport layout

`osm/eidw_osm.json` was retrieved on 2026-10-14 from OpenStreetMap through the Overpass API and is used under the Open Database Licence (ODbL 1.0), © OpenStreetMap contributors (https://www.openstreetmap.org/copyright). It is a trimmed extract around Dublin Airport: terminals, aprons, taxiways, runways, aircraft stands, gates (with their refs), car parks, named buildings and the main roads. `airport_geometry.py` turns it into `flow_demo/js/airport_geo.js` (`python airport_geometry.py --fetch` refreshes it). The pier centrelines, security exits and pier-to-terminal assignment are traced by hand from the OSM outlines and daa's public terminal map; OSM positions marked "fixme" (gates 335A-F, 336-337) are approximate.
