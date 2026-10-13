"""Run the whole forecasting pipeline end to end.

    python run_all.py              # data, backtest, final forecast, export
    python run_all.py --data-only  # write the synthetic CSVs and stop
    python run_all.py --weeks 12   # shorter backtest

Steps, each timed:

  1. data       synthetic daily series calibrated to CSO monthly totals
  2. backtest   52 weekly origins, TimesFM vs baselines (forecast_eval.py)
  3. final      March 2026 forecast, bands, MinT, Shapley, scenarios (forecast_final.py)
  4. export     flow_demo/flow_data.js for the operations twin

TimesFM results are cached in outputs/cache, so a second run takes seconds.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def step(name: str, fn) -> None:
    t0 = time.perf_counter()
    print(f"\n=== {name} ===", flush=True)
    fn()
    print(f"--- {name}: {time.perf_counter() - t0:.1f}s", flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-only", action="store_true")
    parser.add_argument("--weeks", type=int, default=52)
    args = parser.parse_args()

    from pipeline import build_data

    step("data", lambda: build_data(write=True))
    if args.data_only:
        return
    run = lambda *cmd: subprocess.run([sys.executable, *cmd], cwd=ROOT, check=True)
    step("backtest", lambda: run("forecast_eval.py", "--weeks", str(args.weeks)))
    step("final", lambda: run("forecast_final.py"))
    step("export", lambda: run("flow_demo/export_flow_data.py"))


if __name__ == "__main__":
    main()
