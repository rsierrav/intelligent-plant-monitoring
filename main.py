import os
import sys

from dotenv import load_dotenv

from backend.analysis.reasoning_engine import (
    explain,
    get_latest_decision,
    run_reasoning_engine,
)
from analysis_plots.plots import (
    plot_rolling,
    plot_rolling_with_events,
)
from analysis_plots.baseline_analysis import plot_baseline
from analysis_plots.watering_experiment import plot_watering
from analysis_plots.drying_analysis import plot_time_to_dry


def main():
    load_dotenv()

    user_id = sys.argv[1] if len(sys.argv) > 1 else os.getenv("DEMO_USER_ID")
    if not user_id:
        raise SystemExit(
            "Provide a user id with `python main.py <user-id>` "
            "or set DEMO_USER_ID in .env."
        )

    df, smoothed, rate, states = run_reasoning_engine(user_id)

    plot_paths = [
        plot_baseline(df),
        plot_rolling(df, smoothed),
        plot_watering(df),
        plot_time_to_dry(df),
        plot_rolling_with_events(df, smoothed, rate),
    ]

    decision = get_latest_decision(states)

    print("\nFINAL DECISION:")
    print("Plant A:", decision["Plant_A"])
    print("Plant B:", decision["Plant_B"])

    print("\nEXPLANATIONS:")
    print("Plant A:", explain(decision["Plant_A"]))
    print("Plant B:", explain(decision["Plant_B"]))

    print("\nPLOTS SAVED:")
    for path in plot_paths:
        print(path)


if __name__ == "__main__":
    main()
