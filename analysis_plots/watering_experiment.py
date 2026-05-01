import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

SPIKE_THRESHOLD = 2
PLOT_DIR = "figures"


def detect_spikes(rate_df):
    spikes_A = rate_df["Plant_A"] > SPIKE_THRESHOLD
    spikes_B = rate_df["Plant_B"] > SPIKE_THRESHOLD

    return spikes_A, spikes_B


def plot_watering(df):
    os.makedirs(PLOT_DIR, exist_ok=True)

    df.plot(title="Watering Experiment Moisture Trends")
    plt.ylabel("Moisture (%)")

    path = os.path.join(PLOT_DIR, "watering_trends.png")
    plt.savefig(path, bbox_inches="tight")
    plt.close()
    return path
