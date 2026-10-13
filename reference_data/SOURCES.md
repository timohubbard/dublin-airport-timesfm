# Reference data

`cso_dublin_monthly.csv` was retrieved on 2026-10-13 from the Central Statistics Office (CSO) PxStat API and is used under the CSO's open-data licence (CC BY 4.0).

- TAM08 *Passengers handled by main airports*: https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM08/JSON-stat/2.0/en
- TAM07 *Passengers, Freight and Commercial Flights* (by country and direction): https://ws.cso.ie/public/api.restful/PxStat.Data.Cube_API.ReadDataset/TAM07/JSON-stat/2.0/en
- Release page: https://www.cso.ie/en/statistics/transport/aviationstatistics/

Columns: `passengers` is TAM08 commercial passengers at Dublin (arrivals plus departures; transit passengers count twice). `commercial_flights` is TAM07 commercial flights, all directions. `share_<market>` is each demo market's share of TAM07 passengers and `dep_share_<market>` its departing share; see `real_data.py` for the country mapping.

Figures are subject to CSO revision.
