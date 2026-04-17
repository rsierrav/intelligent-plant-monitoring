import os
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

# Plant ID mapping
PLANT_MAP = {
    "8394700b-b00a-4e8d-8c87-ea67af9227dd": "Plant_A",
    "639b7e57-2d84-477d-89fb-5a961f6d1dd8": "Plant_B"
}


# Load and prepare data
def load_and_prepare_data():
    all_data = []
    offset = 0
    batch_size = 5000

    # Pagination loop
    while True:
        response = supabase.table("plant_readings") \
            .select("plant_id, timestamp, soil_moisture_percent") \
            .range(offset, offset + batch_size - 1) \
            .execute()

        batch = response.data

        if not batch:
            break

        all_data.extend(batch)
        offset += batch_size

    df = pd.DataFrame(all_data)

    os.makedirs("data/raw", exist_ok=True)
    df.to_csv("data/raw/raw_supabase_data.csv", index=False)

    if df.empty:
        raise ValueError("No data returned from Supabase")

    # Convert timestamp
    df["timestamp"] = pd.to_datetime(df["timestamp"])

    # Map plant IDs to names
    df["plant_name"] = df["plant_id"].map(PLANT_MAP)

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
    for col in ["Plant_A", "Plant_B"]:
        if col not in pivot.columns:
            pivot[col] = None

    return pivot
