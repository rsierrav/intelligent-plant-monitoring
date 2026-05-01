import os
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

PLOT_DIR = "figures"


def plot_time_to_dry(df):
    os.makedirs(PLOT_DIR, exist_ok=True)

    results = {}

    for col in df.columns:
        values = df[col]

        # find watering points
        spikes = values.diff() > 5

        drying_times = []
        start = None

        for i in range(len(values)):
            if spikes.iloc[i]:
                if start is not None:
                    drying_times.append(i - start)
                start = i

        # average drying time
        if drying_times:
            avg = sum(drying_times) / len(drying_times)
        else:
            avg = 0

        results[col] = avg

    # Convert 5-min intervals to hours
    for k in results:
        results[k] = results[k] * 5 / 60

    # Plot
    plt.figure()

    plt.bar(results.keys(), results.values())

    plt.title("Average Time to Dry")
    plt.ylabel("Hours")

    path = os.path.join(PLOT_DIR, "time_to_dry.png")
    plt.savefig(path, bbox_inches="tight")
    plt.close()
    return path
