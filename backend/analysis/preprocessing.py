import os
import re
from time import sleep
from supabase import create_client
import pandas as pd
from dotenv import load_dotenv

# Supabase config
load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise ValueError("Missing Supabase credentials in .env file")

supabase = create_client(SUPABASE_URL, SUPABASE_KEY)

DEFAULT_PLANT_ALIASES = ["Plant_A", "Plant_B"]
ANALYSIS_LOOKBACK_HOURS = int(os.getenv("ANALYSIS_LOOKBACK_HOURS", "336"))


def _safe_user_key(user_id):
    return re.sub(r"[^A-Za-z0-9_-]", "_", user_id)


def _cache_path(user_id):
    return f"data/raw/raw_supabase_data_{_safe_user_key(user_id)}.csv"


def _get_user_plants(user_id, max_retries=3):
    last_error = None

    for attempt in range(max_retries):
        try:
            response = supabase.table("plants") \
                .select("id, plant_name") \
                .eq("user_id", user_id) \
                .order("plant_name", desc=False) \
                .execute()
            plants = response.data or []
            if plants:
                return plants
            return []
        except Exception as exc:
            last_error = exc
            if attempt < max_retries - 1:
                sleep(1)

    raise last_error


def _build_plant_alias_map(user_id):
    try:
        plants = _get_user_plants(user_id)
    except Exception:
        cached_df = _load_cached_raw_data(user_id)
        if cached_df is None or "plant_id" not in cached_df.columns:
            raise

        plant_ids = list(dict.fromkeys(cached_df["plant_id"].dropna()))
        return {
            plant_id: DEFAULT_PLANT_ALIASES[idx]
            for idx, plant_id in enumerate(plant_ids[:len(DEFAULT_PLANT_ALIASES)])
        }

    if not plants:
        return {}

    alias_map = {}
    for idx, plant in enumerate(plants[:len(DEFAULT_PLANT_ALIASES)]):
        alias_map[plant["id"]] = DEFAULT_PLANT_ALIASES[idx]

    return alias_map


def _load_cached_raw_data(user_id):
    cache_path = _cache_path(user_id)
    if not os.path.exists(cache_path):
        return None

    df = pd.read_csv(cache_path)
    if df.empty:
        return None

    return df


def _fetch_batch(plant_ids, offset, batch_size, cutoff_timestamp=None, max_retries=3):
    last_error = None

    for attempt in range(max_retries):
        try:
            query = supabase.table("plant_readings") \
                .select("plant_id, timestamp, soil_moisture_percent") \
                .in_("plant_id", plant_ids)

            if cutoff_timestamp is not None:
                query = query.gte("timestamp", cutoff_timestamp)

            response = query.order("timestamp", desc=False) \
                .range(offset, offset + batch_size - 1) \
                .execute()
            return response.data
        except Exception as exc:
            last_error = exc
            if attempt < max_retries - 1:
                sleep(1)

    raise last_error


def get_latest_source_timestamp(user_id):
    plant_alias_map = _build_plant_alias_map(user_id)
    if not plant_alias_map:
        raise ValueError("No plants assigned to this user")

    plant_ids = list(plant_alias_map.keys())
    last_error = None

    for attempt in range(3):
        try:
            response = supabase.table("plant_readings") \
                .select("timestamp") \
                .in_("plant_id", plant_ids) \
                .order("timestamp", desc=True) \
                .limit(1) \
                .execute()

            data = response.data or []
            if data:
                timestamp_value = data[0].get("timestamp")
                if timestamp_value is None:
                    raise ValueError("Latest reading is missing timestamp")

                latest = pd.to_datetime(timestamp_value, utc=True)
                return latest.tz_convert("US/Eastern")

            break
        except Exception as exc:
            last_error = exc
            if attempt < 2:
                sleep(1)

    cached_df = _load_cached_raw_data(user_id)
    if cached_df is not None and "timestamp" in cached_df.columns:
        cached_df["timestamp"] = pd.to_datetime(
            cached_df["timestamp"],
            utc=True,
            errors="coerce",
        )
        cached_df = cached_df.dropna(subset=["timestamp"])
        if not cached_df.empty:
            latest = cached_df["timestamp"].max()
            return latest.tz_convert("US/Eastern")

    if last_error is not None:
        raise last_error

    raise ValueError("No timestamp data returned from Supabase")


def get_latest_environment_reading(user_id):
    """Return the most recent environment reading (temperature, humidity, light).
    Returns a dict with keys: temperature, humidity, light, timestamp (ISO) or None
    """
    # Ensure user has plants (same guard as other helpers)
    plant_alias_map = _build_plant_alias_map(user_id)
    if not plant_alias_map:
        raise ValueError("No plants assigned to this user")

    try:
        # Guard: only expose env data to users that actually have at least
        # one plant reading for their assigned plants.
        plant_ids = list(plant_alias_map.keys())
        plant_probe = supabase.table("plant_readings") \
            .select("timestamp") \
            .in_("plant_id", plant_ids) \
            .order("timestamp", desc=True) \
            .limit(1) \
            .execute()
        if not (plant_probe.data or []):
            raise ValueError("No plant readings available for this user")

        resp = supabase.table("environment_readings") \
            .select("timestamp, temperature, humidity, light_level") \
            .order("timestamp", desc=True) \
            .limit(1) \
            .execute()
        data = resp.data or []
        if not data:
            raise ValueError("No environment readings available")

        row = data[0]
        ts = pd.to_datetime(row.get("timestamp"), utc=True).tz_convert("US/Eastern")
        return {
            "temperature": float(row.get("temperature")) if row.get("temperature") is not None else None,
            "humidity": float(row.get("humidity")) if row.get("humidity") is not None else None,
            "light": float(row.get("light_level")) if row.get("light_level") is not None else None,
            "timestamp": ts.isoformat(),
        }
    except Exception:
        # Fall back to cached CSV if present
        cached_df = _load_cached_raw_data(user_id)
        if cached_df is None:
            raise

        # env readings are not stored in cached plant CSV; nothing to return
        raise ValueError("No environment readings available")


def get_latest_raw_moisture_by_plant(user_id):
    plant_alias_map = _build_plant_alias_map(user_id)
    if not plant_alias_map:
        raise ValueError("No plants assigned to this user")

    latest_by_plant = {}

    for plant_id, plant_name in plant_alias_map.items():
        last_error = None
        row = None

        for attempt in range(3):
            try:
                response = supabase.table("plant_readings") \
                    .select("timestamp, soil_moisture_percent") \
                    .eq("plant_id", plant_id) \
                    .order("timestamp", desc=True) \
                    .limit(1) \
                    .execute()

                data = response.data or []
                if data:
                    row = data[0]
                break
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    sleep(1)

        if row is None:
            if last_error is not None:
                raise last_error
            latest_by_plant[plant_name] = {
                "moisture": None,
                "timestamp": None,
            }
            continue

        timestamp_value = row.get("timestamp")
        moisture_value = row.get("soil_moisture_percent")
        if timestamp_value is None or moisture_value is None:
            latest_by_plant[plant_name] = {
                "moisture": None,
                "timestamp": None,
            }
            continue

        ts = pd.to_datetime(
            timestamp_value,
            utc=True,
        ).tz_convert("US/Eastern")
        latest_by_plant[plant_name] = {
            "moisture": float(moisture_value),
            "timestamp": ts.isoformat(),
            }

    # Try to fetch the latest environment reading (global, not per-plant)
    env_row = None
    try:
        resp = supabase.table("environment_readings") \
            .select("timestamp, temperature, humidity, light_level") \
            .order("timestamp", desc=True) \
            .limit(1) \
            .execute()
        data = resp.data or []
        if data:
            env_row = data[0]
    except Exception:
        env_row = None

    env_temp = float(env_row.get("temperature")) if env_row and env_row.get("temperature") is not None else None
    env_hum = float(env_row.get("humidity")) if env_row and env_row.get("humidity") is not None else None
    env_light = float(env_row.get("light_level")) if env_row and env_row.get("light_level") is not None else None

    # Attach environment readings to each plant's latest entry so the frontend can show them
    for k in latest_by_plant.keys():
        latest_by_plant[k]["temperature"] = env_temp
        latest_by_plant[k]["humidity"] = env_hum
        latest_by_plant[k]["light"] = env_light

    return latest_by_plant


# Load and prepare data
def load_and_prepare_data(user_id):
    plant_alias_map = _build_plant_alias_map(user_id)
    if not plant_alias_map:
        raise ValueError("No plants assigned to this user")

    plant_ids = list(plant_alias_map.keys())
    cutoff_timestamp = None

    if ANALYSIS_LOOKBACK_HOURS > 0:
        try:
            latest = get_latest_source_timestamp(user_id)
            cutoff = latest - pd.Timedelta(hours=ANALYSIS_LOOKBACK_HOURS)
            cutoff_timestamp = cutoff.tz_convert("UTC").isoformat()
        except Exception:
            cutoff_timestamp = None

    all_data = []
    offset = 0
    batch_size = 1000
    cached_df = None

    # Pagination loop
    while True:
        try:
            batch = _fetch_batch(plant_ids, offset, batch_size, cutoff_timestamp)
        except Exception:
            cached_df = _load_cached_raw_data(user_id)
            if cached_df is None:
                raise
            break

        if not batch:
            break

        all_data.extend(batch)
        offset += len(batch)

    if cached_df is not None:
        df = cached_df
    else:
        df = pd.DataFrame(all_data)

    if not df.empty:
        os.makedirs("data/raw", exist_ok=True)
        df.to_csv(_cache_path(user_id), index=False)

    if df.empty:
        raise ValueError("No data returned from Supabase")

    # Convert timestamp and normalize to Eastern time for display
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, format="mixed")
    df["timestamp"] = df["timestamp"].dt.tz_convert("US/Eastern")

    # Map plant IDs to names
    df["plant_name"] = df["plant_id"].map(plant_alias_map)

    if df["plant_name"].isna().any():
        raise ValueError("Unknown plant_id found in data")

    # Pivot to time-series format
    pivot = df.pivot_table(
        index="timestamp",
        columns="plant_name",
        values="soil_moisture_percent"
    )

    # Clean and align
    pivot = pivot.sort_index()

    # 5 min analysis
    pivot = pivot.resample("5min").mean().ffill()

    # Ensure both plants exist
    for col in DEFAULT_PLANT_ALIASES:
        if col not in pivot.columns:
            pivot[col] = float("nan")

    pivot = pivot.astype(float)

    return pivot
