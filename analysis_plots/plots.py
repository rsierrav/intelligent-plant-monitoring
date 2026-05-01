import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

PLOT_DIR = "figures"
os.makedirs(PLOT_DIR, exist_ok=True)


def plot_rolling(df, rolling):
    ax = df.plot(alpha=0.3)
    rolling.plot(ax=ax, linewidth=2)

    ax.set_title("Moisture Trends with Rolling Average")
    ax.set_ylabel("Moisture (%)")
    ax.legend(["Raw A", "Raw B", "Smoothed A", "Smoothed B"])

    path = os.path.join(PLOT_DIR, "rolling_average.png")
    plt.savefig(path, bbox_inches="tight")
    plt.close()
    return path


def plot_rolling_with_events(df, smoothed, rate):
    threshold = 3

    ax = df.plot(alpha=0.2, linestyle="--")
    smoothed.plot(ax=ax, linewidth=3)

    for col in rate.columns:
        spikes = rate[col] > threshold

        ax.scatter(
            rate.index[spikes],
            smoothed[col][spikes],
            s=80,
            zorder=5,
            label=f"{col} Watering",
        )

    ax.set_title("Moisture Trends with Detected Watering Events")
    ax.set_ylabel("Moisture (%)")

    handles, labels = ax.get_legend_handles_labels()
    unique = dict(zip(labels, handles))
    ax.legend(unique.values(), unique.keys())

    path = os.path.join(PLOT_DIR, "rolling_with_events.png")
    plt.savefig(path, bbox_inches="tight")
    plt.close()
    return path
