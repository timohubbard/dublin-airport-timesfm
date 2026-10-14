import math

import pytest

import airport_geometry as ag


@pytest.fixture(scope="module")
def geo():
    g, _ = ag.build()
    return g


def test_simplifier_keeps_closed_rings():
    square = [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
    assert len(ag.rdp(square, 1.0)) == 5
    assert ag.rdp([(0, 0), (5, 0.1), (10, 0)], 1.0) == [(0, 0), (10, 0)]


def test_every_pier_has_its_real_gates(geo):
    piers = {p["id"]: p for p in geo["piers"]}
    assert set(piers) == {"P1", "P2", "P3", "P335", "P4"}
    ids = {p: {g["id"] for g in piers[p]["gates"]} for p in piers}
    assert {"102", "119"} <= ids["P1"] and {"201", "220"} <= ids["P2"] and {"301", "307"} <= ids["P3"] and {"401", "426"} <= ids["P4"]
    assert all(g.get("bus") for g in piers["P335"]["gates"])
    # Contact gates (not bus gates) are matched to a real stand next to them.
    for p in ("P1", "P3", "P4"):
        for g in piers[p]["gates"]:
            assert "stand" in g, g["id"]
            assert math.dist(g["stand"]["door"], (g["x"], g["y"])) < 75


def test_walks_grow_along_pier_1_and_match_known_ranges(geo):
    p1 = next(p for p in geo["piers"] if p["id"] == "P1")
    walk = {g["id"]: g["walkM"] for g in p1["gates"]}
    assert walk["102"] < walk["110"] < walk["119"]
    # Pier 1's far end is the longest walk at Dublin: well over half a kilometre from T1 security.
    assert 500 < walk["102"] < 700 and 800 < walk["119"] < 1000
    p3 = next(p for p in geo["piers"] if p["id"] == "P3")
    assert max(g["walkM"] for g in p3["gates"]) < 300


def test_remote_stands_and_halls(geo):
    assert len(geo["remote"]) == 20
    assert all(r["busMin"] > 1 for r in geo["remote"])
    assert {r["gate"] for r in geo["remote"] if r["area"] == "south"} == set("ABCDEF")
    for k in ("t1", "t2"):
        a, b, c = geo["halls"][k]
        assert math.dist(a, b) > 80 and math.dist(a, c) > 80


def test_twin_turn_keeps_distances(geo):
    tw = geo["twin"]["t1"]
    turn = lambda p: (-p[1] + tw["dx"], p[0] + tw["dy"])
    p, q = (100.0, -400.0), (250.0, -200.0)
    assert math.dist(turn(p), turn(q)) == pytest.approx(math.dist(p, q))
