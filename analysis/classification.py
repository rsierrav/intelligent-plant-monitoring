DRY_THRESHOLD = 40
SPIKE_THRESHOLD = 2


def classify(moisture, rate):
    if rate > SPIKE_THRESHOLD:
        return "Recently Watered"
    elif moisture < DRY_THRESHOLD:
        return "Needs Water"
    elif rate < -0.1:
        return "Drying"
    else:
        return "Stable"


def classify_series(df, rate_df):
    states = df.copy()

    states["Plant_A_state"] = [
        classify(df["Plant_A"][i], rate_df["Plant_A"][i])
        for i in df.index
    ]

    states["Plant_B_state"] = [
        classify(df["Plant_B"][i], rate_df["Plant_B"][i])
        for i in df.index
    ]

    return states
