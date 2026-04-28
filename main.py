from backend.analysis.reasoning_engine import (
    explain,
    get_latest_decision,
    run_reasoning_engine,
)
from visualization.plots import (
    plot_rolling,
    plot_rolling_with_events,
)
from experiments.baseline_analysis import plot_baseline
from experiments.watering_experiment import plot_watering
from experiments.drying_analysis import plot_time_to_dry


def main():
    df, smoothed, rate, states = run_reasoning_engine()

    plot_baseline(df)
    plot_rolling(df, smoothed)
    plot_watering(df)
    plot_time_to_dry(df)
    plot_rolling_with_events(df, smoothed, rate)

    decision = get_latest_decision(states)

    print("\nFINAL DECISION:")
    print("Plant A:", decision["Plant_A"])
    print("Plant B:", decision["Plant_B"])

    print("\nEXPLANATIONS:")
    print("Plant A:", explain(decision["Plant_A"]))
    print("Plant B:", explain(decision["Plant_B"]))


if __name__ == "__main__":
    main()
