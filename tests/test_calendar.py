from datetime import date

import calendar_data as cal
import forecast_dublin_airport as fda


def test_irish_bank_holidays_are_real():
    names = {d: n for d, n in fda.seasonal_events(2026)}
    assert names[date(2026, 2, 2)] == "St Brigid's Day bank holiday"
    assert names[date(2026, 3, 17)] == "St Patrick's Day"
    assert names[date(2026, 4, 6)] == "Easter Monday"
    assert names[date(2026, 4, 5)] == "Easter Sunday"
    # St Brigid's Day falls on 1 February when that is a Friday, else the first Monday.
    assert dict(cal.ie_bank_holidays(2023))[date(2023, 2, 6)] == "St Brigid's Day bank holiday"
    for year in range(2023, 2027):
        assert len(cal.ie_bank_holidays(year)) == 7


def test_school_breaks_follow_the_standardised_calendar():
    assert fda.school_holiday(date(2026, 2, 16))       # February mid-term 2026
    assert not fda.school_holiday(date(2026, 2, 10))   # the week before: school
    assert fda.school_holiday(date(2026, 3, 27))       # last school day before Easter (travel that evening)
    assert not fda.school_holiday(date(2026, 3, 24))   # an ordinary school Tuesday
    assert fda.school_holiday(date(2025, 12, 24)) and fda.school_holiday(date(2026, 1, 4))
    assert not fda.school_holiday(date(2026, 1, 6))
    assert fda.school_holiday(date(2025, 7, 15))


def test_school_breaks_do_not_overlap_and_are_sourced():
    import pandas as pd
    df = pd.read_csv(cal.SCHOOL, comment="#").sort_values("start")
    assert (pd.to_datetime(df["start"]).iloc[1:].values > pd.to_datetime(df["end"]).iloc[:-1].values).all()
    assert df["source"].str.len().gt(10).all()
