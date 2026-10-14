from datetime import date

import real_flights as rf


def test_market_mapping():
    assert rf.market_of("EGLL") == "uk"
    assert rf.market_of("LEMG") == "eu_sun" and rf.market_of("LPFR") == "eu_sun" and rf.market_of("GCTS") == "eu_sun"
    assert rf.market_of("LEMD") == "eu_city" and rf.market_of("EHAM") == "eu_city" and rf.market_of("LFPG") == "eu_city"
    assert rf.market_of("LFMN") == "eu_sun"
    assert rf.market_of("KJFK") == "na" and rf.market_of("CYYZ") == "na"
    assert rf.market_of("OMDB") == "long" and rf.market_of("LTFM") == "long" and rf.market_of("HAAB") == "long"
    assert rf.market_of("EIKY") == "domestic" and rf.market_of(None) == "unknown"


def test_callsign_groups():
    assert rf.classify("RYR12AB ") == ("RYR", "ryanair")
    assert rf.classify("EIN104") == ("EIN", "aer_lingus")
    assert rf.classify("FDX5712") == ("FDX", "cargo")
    assert rf.classify("NJE822Q") == ("NJE", "business")
    assert rf.classify("BAW831") == ("BAW", "other_airline")
    assert rf.classify("EIDVM")[1] == "non_airline" and rf.classify(None)[1] == "non_airline"


def test_summarise_day_counts_markets_for_passenger_airlines_only():
    flights = [{"callsign": "RYR1", "estArrivalAirport": "LEMG"}, {"callsign": "EIN2", "estArrivalAirport": "KBOS"},
               {"callsign": "FDX3", "estArrivalAirport": "LFPG"}, {"callsign": "EIABC", "estArrivalAirport": None}]
    s = rf.summarise_day(flights, "departure")
    assert s["all"] == 4 and s["passenger_airline"] == 2 and s["commercial"] == 3
    assert s["eu_sun"] == 1 and s["na"] == 1 and s["eu_city"] == 0


def test_todo_is_newest_first_and_skips_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(rf, "RAW", tmp_path)
    (tmp_path / "departure").mkdir()
    (tmp_path / "departure" / "2026-03-31.json.gz").write_bytes(b"")
    jobs = rf.todo(date(2026, 3, 30), date(2026, 3, 31))
    assert jobs == [("arrival", date(2026, 3, 31)), ("departure", date(2026, 3, 30)), ("arrival", date(2026, 3, 30))]
