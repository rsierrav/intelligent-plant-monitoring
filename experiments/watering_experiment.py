import os
import matplotlib.pyplot as plt

SPIKE_THRESHOLD = 2


def detect_spikes(rate_df):
    spikes_A = rate_df["Plant_A"] > SPIKE_THRESHOLD
    spikes_B = rate_df["Plant_B"] > SPIKE_THRESHOLD

    return spikes_A, spikes_B


def plot_watering(df):
    os.makedirs("data/processed", exist_ok=True)

    df.plot(title="Watering Experiment Moisture Trends")
    plt.ylabel("Moisture (%)")

    plt.savefig("data/processed/watering_trends.png")
    plt.show()
