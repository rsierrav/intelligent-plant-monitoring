import streamlit as st
import pandas as pd
import matplotlib.pyplot as plt

# Title
st.title("Plant Moisture Dashboard (Basic)")

# Load dataset
df = pd.read_csv("data/raw/raw_supabase_data.csv")

# Convert timestamp
df['timestamp'] = pd.to_datetime(df['timestamp'])
df = df.sort_values('timestamp')

# Split plants
plant_a = df[df['plant_id'] == '8394700b-b00a-4e8d-8c87-ea67af9227dd']
plant_b = df[df['plant_id'] == '639b7e57-2d84-477d-89fb-5a961f6d1dd8']

# Create plot
fig, ax = plt.subplots(figsize=(10, 5))

ax.plot(plant_a['timestamp'], plant_a['soil_moisture_percent'], 
        label='Plant A', linewidth=2)
ax.plot(plant_b['timestamp'], plant_b['soil_moisture_percent'], 
        label='Plant B', linewidth=2)

ax.grid(True, linestyle='--', alpha=0.5)

# Labels
ax.set_xlabel("Time")
ax.set_ylabel("Moisture %")
ax.set_title("Soil Moisture Over Time")

ax.legend()

# Show in Streamlit
fig.autofmt_xdate()
st.pyplot(fig)
