# Reference data

`cso_dublin_monthly.csv` was retrieved on 2026-10-13 from the Central Statistics Office (CSO) PxStat API and is used under the CSO's open-data licence (CC BY 4.0).

- TAM08 *Passengers handled by main airports*: https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM08/JSON-stat/2.0/en
- TAM07 *Passengers, Freight and Commercial Flights* (by country and direction): https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM07/JSON-stat/2.0/en
- Release page: https://www.cso.ie/en/statistics/transport/aviationstatistics/

Columns: `passengers` is TAM08 commercial passengers at Dublin (arrivals plus departures; transit passengers count twice). `commercial_flights` is TAM07 commercial flights, all directions. `share_<market>` is each demo market's share of TAM07 passengers and `dep_share_<market>` its departing share; see `real_data.py` for the country mapping.

Figures are subject to CSO revision.

## Airport layout

`osm/eidw_osm.json` was retrieved on 2026-10-14 from OpenStreetMap through the Overpass API and is used under the Open Database Licence (ODbL 1.0), © OpenStreetMap contributors (https://www.openstreetmap.org/copyright). It is a trimmed extract around Dublin Airport: terminals, aprons, taxiways, runways, aircraft stands, gates (with their refs), car parks, named buildings and the main roads. `airport_geometry.py` turns it into `flow_demo/js/airport_geo.js` (`python airport_geometry.py --fetch` refreshes it). The pier centrelines, security exits and pier-to-terminal assignment are traced by hand from the OSM outlines and daa's public terminal map; OSM positions marked "fixme" (gates 335A-F, 336-337) are approximate.

## Calendar

`calendar/public_holidays.csv` was retrieved on 2026-10-14 from the [Nager.Date](https://date.nager.at) public holiday API (Ireland and the UK by nation, 2023–2026) by `calendar_data.py`. The forecast's Irish bank holidays (St Brigid's Day, St Patrick's Day, Easter Monday, May, June, August and October) come from it.

`calendar/ie_school_holidays.csv` is curated by hand: the Department of Education's standardised Christmas, Easter and mid-term breaks (circulars 0005/2020 and 0072/2022), as published by schools that follow them; gov.ie does not allow automated fetching, so each row carries its source. Summer holidays are not standardised and are approximate (primary schools close at the end of June). A break runs from the last school day to the Sunday before schools reopen.

## Flights

`flights/eidw_daily.csv` aggregates flights at Dublin (EIDW) from the [OpenSky Network](https://opensky-network.org) REST API (`/flights/departure` and `/flights/arrival`), fetched by `real_flights.py` with a personal API client (research and non-commercial use). Each day gives departures and arrivals by airline group (Ryanair, Aer Lingus, other passenger airlines, cargo, business, non-airline, from the callsign's ICAO operator prefix) and, for passenger airlines, by the twin's markets (from the other airport's ICAO code). OpenSky reconstructs flights from ADS-B, so coverage is not complete: `outputs/flights_report.md` measures it against CSO's monthly commercial flights. Raw responses are cached in `data/flights_raw/` (not committed). Cite: Schäfer et al. (2014), "Bringing up OpenSky: A large-scale ADS-B sensor network for research", IPSN.
