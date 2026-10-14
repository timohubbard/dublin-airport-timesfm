# Weather data

Retrieved 2026-10-14. Derived tables only; see `weather_data.py` for how each is built.

- `met_eireann_hourly.csv`: Met Éireann, Dublin Airport (station 532), hourly observations, https://clidata.met.ie/cli/climate_data/webdata/hly532.csv, licence CC BY 4.0. Source: Met Éireann.
- `eidw_metar_hourly.csv`: METAR reports for EIDW, hourly aggregates, from the Iowa Environmental Mesonet ASOS/METAR archive, https://mesonet.agron.iastate.edu/.
- `ecmwf_daily_by_lead.csv`, `ecmwf_hourly_dayahead_2026_03.csv`: ECMWF IFS 0.25° and ECMWF AIFS forecasts as issued, 1-7 days ahead, through the Open-Meteo Previous Runs API (https://open-meteo.com/). ECMWF open data, CC BY 4.0. Open-Meteo data CC BY 4.0; the free API is for non-commercial use.

Met Éireann's archived warnings end in August 2023, before the backtest period, so warnings are not used as an as-issued input; storms are identified from observed gusts.
