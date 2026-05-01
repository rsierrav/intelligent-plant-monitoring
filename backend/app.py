import os
import time

from flask import Flask, jsonify, request
from flask_cors import CORS
from analysis.reasoning_engine import run_reasoning_engine, get_latest_decision
from analysis.preprocessing import get_latest_raw_moisture_by_plant
from analysis.preprocessing import supabase as supabase_client
from analysis.preprocessing import _build_plant_alias_map
from analysis.preprocessing import get_latest_environment_reading
from prediction import predict_plant
import pandas as pd

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})


@app.route("/")
def home():
    return "API running"


DEMO_USER_ID = os.getenv("DEMO_USER_ID")
MIN_HISTORY_HOURS = 7 * 24  # 168 hours = 7 days
MIN_FORECAST_MINUTES = 7 * 24 * 60
HISTORY_HOURS = max(
    MIN_HISTORY_HOURS,
    int(os.getenv("DASHBOARD_HISTORY_HOURS", "168"))  # 7 days, can be overridden to 336 (14 days)
)
FORECAST_HORIZON_MINUTES = max(
    MIN_FORECAST_MINUTES,
    int(os.getenv("DASHBOARD_FORECAST_MINUTES", str(MIN_FORECAST_MINUTES)))
)
CACHE_TTL_SECONDS = int(os.getenv("DASHBOARD_CACHE_TTL_SECONDS", "60"))
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
        return user_id.strip()

    if DEMO_USER_ID:
        return DEMO_USER_ID.strip()

    return None


def empty_latest_payload():
    # Deprecated: callers should use empty_dashboard_payload which returns
    # fully empty structures. Keep for compatibility.
    return {}


def empty_dashboard_payload():
    return {
        "plants": [],
        "latest": {},
        "decision": {},
        "history": {},
        "prediction": {},
    }


def get_user_plants(user_id):
    """Return list of plant records for a given user."""
    try:
        response = (
            supabase_client.table("plants")
            .select("id, plant_name, plant_type, user_id")
            .eq("user_id", user_id)
            .order("plant_name", desc=False)
            .execute()
        )
        return response.data or []
    except Exception:
        return []


def build_dashboard_payload(user_id):
    # Ensure we return plant entities only for plants that belong to the user
    plants = get_user_plants(user_id)
    if not plants:
        return empty_dashboard_payload()

    # Use preprocessing's alias map so keys in latest/history/prediction match
    from analysis.preprocessing import _build_plant_alias_map

    alias_map = _build_plant_alias_map(user_id) or {}

    base_latest = {}
    base_history = {}
    base_prediction = {}
    base_decision = {}
    plants_meta = []

    # Respect the order of plants returned from the DB and include only those
    for idx, plant in enumerate(plants):
        plant_id = plant.get("id")
        alias = alias_map.get(plant_id) or f"Plant_{idx+1}"
        base_latest[alias] = None
        base_history[alias] = []
        base_prediction[alias] = {}
        base_decision[alias] = "No data yet"
        plants_meta.append({
            "alias": alias,
            "id": plant_id,
            "plant_name": plant.get("plant_name"),
            "plant_type": plant.get("plant_type"),
        })

    # Try to compute actual analytics; if it fails, return the base payload
    try:
        df, smoothed, rate, states = run_reasoning_engine(user_id)

        decision = get_latest_decision(states)
        latest = get_latest_raw_moisture_by_plant(user_id)

        # Build payload keyed by actual aliases we discovered from DB
        payload_latest = {}
        payload_history = {}
        payload_prediction = {}

        for alias in base_latest.keys():
            if isinstance(latest, dict):
                payload_latest[alias] = latest.get(alias)
            else:
                payload_latest[alias] = None

            if alias in df.columns:
                payload_history[alias] = format_history(
                    df,
                    alias,
                    hours=HISTORY_HOURS,
                )
                payload_prediction[alias] = predict_plant(
                    df.get(alias),
                    FORECAST_HORIZON_MINUTES,
                )
            else:
                payload_history[alias] = []
                payload_prediction[alias] = {}

        # Merge decision values, falling back to base_decision
        merged_decision = {}
        for k in base_decision.keys():
            if isinstance(decision, dict):
                merged_decision[k] = decision.get(k)
            else:
                merged_decision[k] = base_decision.get(k)

        payload = {
            "plants": plants_meta,
            "latest": payload_latest,
            "decision": merged_decision,
            "history": payload_history,
            "prediction": payload_prediction,
        }

        return payload
    except ValueError:
        try:
            base_latest.update(get_latest_raw_moisture_by_plant(user_id))
        except Exception:
            pass

        base = {
            "plants": plants_meta,
            "latest": base_latest,
            "decision": base_decision,
            "history": base_history,
            "prediction": base_prediction,
        }
        return base


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

    try:
        payload = get_cached_dashboard_payload(user_id)
        return jsonify(payload)
    except Exception as exc:
        app.logger.exception("Dashboard request failed for user_id=%s", user_id)
        return jsonify({
            "error": "dashboard request failed",
            "detail": str(exc),
        }), 500


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


@app.route("/dashboard/env")
def dashboard_env():
    """Return latest environment reading (temperature, humidity, light)
    """
    user_id = resolve_user_id()
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400

    try:
        env = get_latest_environment_reading(user_id)
    except ValueError:
        return jsonify({"env": {}})
    except Exception:
        return jsonify({"env": {}}), 500

    return jsonify({"env": env})


@app.route("/dashboard/plants")
def dashboard_plants():
    """Return lightweight list of plant metadata for a user with alias keys.
    This avoids triggering heavy analytics and is used to build the UI shell.
    """
    user_id = resolve_user_id()
    if not user_id:
        return jsonify({"error": "user_id is required"}), 400

    try:
        plants = get_user_plants(user_id)
    except Exception:
        plants = []

    # Build alias map so frontend can map plant ids to aliases
    alias_map = _build_plant_alias_map(user_id) or {}

    plants_meta = []
    for idx, p in enumerate(plants):
        pid = p.get("id")
        alias = alias_map.get(pid) or f"Plant_{idx+1}"
        plants_meta.append({
            "id": pid,
            "plant_name": p.get("plant_name"),
            "plant_type": p.get("plant_type"),
            "alias": alias,
        })

    return jsonify({"plants": plants_meta})


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


@app.route("/plants/delete", methods=["POST"])
def delete_plant():
    """Delete a plant by ID (blocked if plant is protected)."""
    data = request.get_json(silent=True) or {}
    plant_id = data.get("plant_id")

    if not plant_id:
        return jsonify({"error": "plant_id is required"}), 400

    try:
        # Check if plant is protected
        plant_response = (
            supabase_client.table("plants")
            .select("is_protected")
            .eq("id", plant_id)
            .execute()
        )
        
        if plant_response.data and len(plant_response.data) > 0:
            if plant_response.data[0].get("is_protected", False):
                return jsonify({"error": "Cannot delete protected plant"}), 403
        
        # Plant is not protected, proceed with deletion
        response = (
            supabase_client.table("plants")
            .delete()
            .eq("id", plant_id)
            .execute()
        )
        
        # Clear cache since plant was deleted
        dashboard_cache.clear()
        
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True)
