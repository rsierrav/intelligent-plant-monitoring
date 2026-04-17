from analysis.preprocessing import load_and_prepare_data
from analysis.smoothing import apply_rolling_average
from analysis.rate_analysis import compute_rate_of_change
from analysis.classification import classify_series


def run_reasoning_engine():
    # Load data
    df = load_and_prepare_data()

    # Smooth data
    smoothed = apply_rolling_average(df)

    # Rate of change
    rate = compute_rate_of_change(df)

    # Classification (used smoothed data for classification)
    states = classify_series(smoothed, rate)

    return df, smoothed, rate, states


def get_latest_decision(states):
    latest = states.iloc[-1]

    return {
        "Plant_A": latest["Plant_A_state"],
        "Plant_B": latest["Plant_B_state"]
    }


def explain(state):
    explanations = {
        "Recently Watered": "Moisture increased sharply -> watering detected",
        "Needs Water": "Moisture below threshold -> plant is dry",
        "Drying": "Moisture decreasing over time",
        "Stable": "No significant change"
    }

    return explanations[state]
