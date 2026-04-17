import os
import matplotlib.pyplot as plt


def plot_baseline(df):
    os.makedirs("data/processed", exist_ok=True)

    df.plot(title="Baseline Soil Moisture Comparison")
    plt.xlabel("Time")
    plt.ylabel("Moisture (%)")

    plt.savefig("data/processed/baseline.png")
    plt.show()
