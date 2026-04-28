import os

from flask import Flask, jsonify
from flask_cors import CORS
from analysis.reasoning_engine import run_reasoning_engine, get_latest_decision
from analysis.preprocessing import get_latest_raw_moisture_by_plant
from prediction import predict_plant
import pandas as pd

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})


@app.route("/")
def home():
    return "API running"


DEMO_USER_ID = os.getenv("DEMO_USER_ID")
MIN_HISTORY_HOURS = 7 * 24
MIN_FORECAST_MINUTES = 7 * 24 * 60
HISTORY_HOURS = max(
    MIN_HISTORY_HOURS,
    int(os.getenv("DASHBOARD_HISTORY_HOURS", str(MIN_HISTORY_HOURS)))
)
FORECAST_HORIZON_MINUTES = max(
    MIN_FORECAST_MINUTES,
    int(os.getenv("DASHBOARD_FORECAST_MINUTES", str(MIN_FORECAST_MINUTES)))
)


def format_history(df_historical, plant_name, hours=48):
    """
    Extract and format historical data for a plant.
    Args:
        df_historical: DataFrame with timestamp index and plant columns
        plant_name: Column name (e.g., "Plant_A")
        hours: How many hours of history to return
    Returns:
        List of {t: ISO timestamp, value: moisture %}
    """
    if plant_name not in df_historical.columns:
        return []

    if df_historical.empty:
        return []

    # Anchor window to latest available sample instead of wall-clock now.
    latest_time = df_historical.index.max()
    cutoff_time = latest_time - pd.Timedelta(hours=hours)
    recent_data = df_historical.loc[df_historical.index >= cutoff_time].copy()

    # Extract values and format
    history = []
    for timestamp, row in recent_data.iterrows():
        value = row[plant_name]

        # Skip NaN values
        if pd.isna(value):
            continue

        history.append({
            "t": timestamp.isoformat(),
            "value": float(value)
        })

    return history


@app.route("/dashboard")
def dashboard():
    user_id = DEMO_USER_ID
    df, smoothed, rate, states = run_reasoning_engine(user_id)

    decision = get_latest_decision(states)
    latest = get_latest_raw_moisture_by_plant(user_id)

    pred_A = predict_plant(df["Plant_A"], FORECAST_HORIZON_MINUTES)
    pred_B = predict_plant(df["Plant_B"], FORECAST_HORIZON_MINUTES)

    # Extract historical data (default 30 days) for chart context.
    history_A = format_history(df, "Plant_A", hours=HISTORY_HOURS)
    history_B = format_history(df, "Plant_B", hours=HISTORY_HOURS)

    return jsonify({
        "latest": latest,
        "decision": decision,
        "history": {
            "Plant_A": history_A,
            "Plant_B": history_B
        },
        "prediction": {
            "Plant_A": pred_A,
            "Plant_B": pred_B
        }
    })


@app.route("/dashboard/latest")
def dashboard_latest():
    """Lightweight endpoint returning only the latest per-plant timestamp
    and moisture.

    The frontend uses this for low-cost polling when full auto-refresh
    is disabled.
    """
    user_id = DEMO_USER_ID
    latest = get_latest_raw_moisture_by_plant(user_id)
    return jsonify({"latest": latest})


if __name__ == "__main__":
    app.run(debug=True)
