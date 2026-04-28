import os
import time

from flask import Flask, jsonify, request
from flask_cors import CORS
from analysis.reasoning_engine import run_reasoning_engine, get_latest_decision
from analysis.preprocessing import get_latest_raw_moisture_by_plant
from analysis.preprocessing import supabase as supabase_client
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
CACHE_TTL_SECONDS = int(os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "10"))
dashboard_cache = {}


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


def resolve_user_id():
    """Resolve the active user id from the request, with demo fallback."""
    user_id = request.args.get("user_id")
    if user_id:
        return user_id

    if DEMO_USER_ID:
        return DEMO_USER_ID

    return None


def empty_latest_payload():
    return {
        "Plant_A": None,
        "Plant_B": None,
    }


def empty_dashboard_payload():
    return {
        "latest": empty_latest_payload(),
        "decision": {},
        "history": {
            "Plant_A": [],
            "Plant_B": [],
        },
        "prediction": {
            "Plant_A": {},
            "Plant_B": {},
        },
    }


def build_dashboard_payload(user_id):
    try:
        df, smoothed, rate, states = run_reasoning_engine(user_id)

        decision = get_latest_decision(states)
        latest = get_latest_raw_moisture_by_plant(user_id)

        pred_A = predict_plant(df["Plant_A"], FORECAST_HORIZON_MINUTES)
        pred_B = predict_plant(df["Plant_B"], FORECAST_HORIZON_MINUTES)

        # Extract historical data (default 30 days) for chart context.
        history_A = format_history(df, "Plant_A", hours=HISTORY_HOURS)
        history_B = format_history(df, "Plant_B", hours=HISTORY_HOURS)

        return {
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
        }
    except ValueError:
        return empty_dashboard_payload()


def get_cached_dashboard_payload(user_id):
    now = time.time()
    cached = dashboard_cache.get(user_id)
    if cached and (now - cached["time"]) < CACHE_TTL_SECONDS:
        return cached["data"]

    payload = build_dashboard_payload(user_id)
    dashboard_cache[user_id] = {
        "time": now,
        "data": payload,
    }
    return payload


@app.route("/dashboard")
def dashboard():
    user_id = resolve_user_id()
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400

    payload = get_cached_dashboard_payload(user_id)
    return jsonify(payload)


@app.route("/dashboard/latest")
def dashboard_latest():
    """Lightweight endpoint returning only the latest per-plant timestamp
    and moisture.

    The frontend uses this for low-cost polling when full auto-refresh
    is disabled.
    """
    user_id = resolve_user_id()
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400

    try:
        latest = get_latest_raw_moisture_by_plant(user_id)
    except ValueError:
        return jsonify({"latest": empty_latest_payload()})

    return jsonify({"latest": latest})


@app.route("/plants/create", methods=["POST"])
def create_plant():
    data = request.get_json(silent=True) or {}
    user_id = data.get("user_id")
    plant_name = data.get("plant_name")
    plant_type = data.get("plant_type")

    if not user_id or not plant_name:
        return jsonify({"error": "Missing fields"}), 400

    response = (
        supabase_client.table("plants")
        .insert({
            "plant_name": plant_name,
            "plant_type": plant_type,
            "user_id": user_id,
        })
        .execute()
    )

    # Ensure next dashboard request recomputes after ownership changes.
    dashboard_cache.pop(user_id, None)

    return jsonify({"success": True, "data": response.data})


@app.route("/plants/assign", methods=["POST"])
def assign_plant():
    data = request.get_json(silent=True) or {}
    plant_id = data.get("plant_id")
    user_id = data.get("user_id")

    if not plant_id or not user_id:
        return jsonify({"error": "Missing fields"}), 400

    response = (
        supabase_client.table("plants")
        .update({"user_id": user_id})
        .eq("id", plant_id)
        .execute()
    )

    # Reassignment can affect multiple users; clear cache conservatively.
    dashboard_cache.clear()

    return jsonify({"success": True, "data": response.data})


if __name__ == "__main__":
    app.run(debug=True)
