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
    plants = _get_user_plants(user_id)
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


def _fetch_batch(plant_ids, offset, batch_size, max_retries=3):
    last_error = None

    for attempt in range(max_retries):
        try:
            response = supabase.table("plant_readings") \
                .select("plant_id, timestamp, soil_moisture_percent") \
                .in_("plant_id", plant_ids) \
                .order("timestamp", desc=False) \
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
                latest = pd.to_datetime(data[0]["timestamp"], utc=True)
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

        ts = pd.to_datetime(
            row["timestamp"],
            utc=True,
        ).tz_convert("US/Eastern")
        latest_by_plant[plant_name] = {
            "moisture": row["soil_moisture_percent"],
            "timestamp": ts,
        }

    return latest_by_plant


# Load and prepare data
def load_and_prepare_data(user_id):
    plant_alias_map = _build_plant_alias_map(user_id)
    if not plant_alias_map:
        raise ValueError("No plants assigned to this user")

    plant_ids = list(plant_alias_map.keys())
    all_data = []
    offset = 0
    batch_size = 1000
    cached_df = None

    # Pagination loop
    while True:
        try:
            batch = _fetch_batch(plant_ids, offset, batch_size)
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
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True)
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
            pivot[col] = None

    return pivot
