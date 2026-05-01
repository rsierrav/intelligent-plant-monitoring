import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

PLOT_DIR = "figures"


def plot_baseline(df):
    os.makedirs(PLOT_DIR, exist_ok=True)

    df.plot(title="Baseline Soil Moisture Comparison")
    plt.xlabel("Time")
    plt.ylabel("Moisture (%)")

    path = os.path.join(PLOT_DIR, "baseline.png")
    plt.savefig(path, bbox_inches="tight")
    plt.close()
    return path
