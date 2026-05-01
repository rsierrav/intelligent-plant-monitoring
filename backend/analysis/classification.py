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

    for plant in ("Plant_A", "Plant_B"):
        states[f"{plant}_state"] = [
            classify(moisture, rate)
            for moisture, rate in zip(df[plant].to_numpy(), rate_df[plant].to_numpy())
        ]

    return states
