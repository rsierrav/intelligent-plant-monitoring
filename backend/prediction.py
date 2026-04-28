import numpy as np
import pandas as pd

# Configuration constants
THRESHOLD = 40
FORECAST_WINDOW_MINUTES = 60
WATERING_JUMP_THRESHOLD = 6.0


# Helper functions for prediction

def to_minutes(ts):
    return (ts - ts.iloc[0]).dt.total_seconds() / 60.0


def fit_linear(series):
    s = series.dropna()
    if len(s) < 5:
        return None, None

    x = to_minutes(s.index.to_series())
    y = s.values
    slope, intercept = np.polyfit(x, y, 1)
    return slope, intercept


def time_to_threshold(current_value, slope):
    if slope is None or slope >= 0:
        return None

    minutes = (THRESHOLD - current_value) / slope
    if minutes < 0:
        return 0

    return minutes


def build_prediction_line(last_time, current_value, slope, horizon_minutes):
    if slope is None:
        return None, None

    periods = max(2, int(np.ceil(horizon_minutes / 5.0)))

    future_times = pd.date_range(
        start=last_time + pd.Timedelta(minutes=5),
        periods=periods,
        freq="5min",
    )

    horizon_end = last_time + pd.Timedelta(minutes=float(horizon_minutes))

    if future_times.empty or future_times[-1] < horizon_end:
        future_times = future_times.append(pd.DatetimeIndex([horizon_end]))

    minutes_from_now = (
        (future_times - last_time).total_seconds() / 60.0
    )

    y_future = current_value + slope * minutes_from_now

    return future_times, y_future


# Main prediction function

def _get_cycle_start_times(series):
    s = series.dropna()
    if len(s) < 3:
        return [s.index[0]] if len(s) else []

    jump_times = s.diff()[lambda x: x >= WATERING_JUMP_THRESHOLD].index
    starts = [s.index[0]] + list(jump_times)

    deduped = []
    for ts in starts:
        if not deduped or ts != deduped[-1]:
            deduped.append(ts)

    return deduped


def _historical_slope_estimate(series):
    s = series.dropna()

    if len(s) < 10:
        return None

    starts = _get_cycle_start_times(s)

    if not starts:
        return None

    current_start = starts[-1]
    current_cycle = s[s.index >= current_start]

    # Recent trend
    recent = s[
        s.index >= s.index[-1] - pd.Timedelta(minutes=FORECAST_WINDOW_MINUTES)
    ]

    if len(recent) < 5:
        recent = s.tail(20)

    recent_slope, _ = fit_linear(recent)

    # Current cycle trend
    current_slope, _ = fit_linear(current_cycle)

    # Historical cycles
    cycle_slopes = []

    for i in range(len(starts) - 1):
        seg = s[(s.index >= starts[i]) & (s.index < starts[i + 1])]

        if len(seg) < 6:
            continue

        seg_slope, _ = fit_linear(seg)

        if seg_slope is not None:
            cycle_slopes.append(seg_slope)

    historical_slope = None
    if cycle_slopes:
        historical_slope = float(np.median(cycle_slopes))

    # Combine estimates with weights
    weighted = []

    if recent_slope is not None:
        weighted.append((recent_slope, 0.45))

    if current_slope is not None:
        weighted.append((current_slope, 0.35))

    if historical_slope is not None:
        weighted.append((historical_slope, 0.20))

    if not weighted:
        return None

    total_w = sum(w for _, w in weighted)

    blended_slope = sum(v * w for v, w in weighted) / total_w

    return blended_slope


# Main function to call for prediction

def predict_plant(series, horizon_minutes=72 * 60):
    s = series.dropna()

    if len(s) < 5:
        s = s.tail(20)

        if len(s) < 5:
            return None

    slope = _historical_slope_estimate(s)

    if slope is None:
        slope, _ = fit_linear(s.tail(20))

    if slope is None:
        return None

    current = float(s.iloc[-1])
    last_time = s.index[-1]

    minutes = time_to_threshold(current, slope)

    # Extend horizon if needed
    effective_horizon = horizon_minutes
    if minutes is not None:
        effective_horizon = max(horizon_minutes, float(minutes))

    future_t, future_y = build_prediction_line(
        last_time,
        current,
        slope,
        effective_horizon,
    )

    eta_to_40 = None
    if minutes is not None:
        eta_to_40 = last_time + pd.Timedelta(minutes=float(minutes))

    eta_hours = float(minutes / 60) if minutes is not None else None

    forecast = None

    if future_t is not None and future_y is not None:
        forecast = [
            {
                "t": t.isoformat(),
                "value": float(v)
            }
            for t, v in zip(future_t, future_y)
        ]

    return {
        "current": current,
        "slope": float(slope),
        "minutes_to_40": float(minutes) if minutes is not None else None,
        "eta_to_40": eta_to_40.isoformat() if eta_to_40 else None,
        "eta_hours": eta_hours,
        "forecast": forecast
    }

# Formatting function for display


def format_prediction(pred, name="Plant"):
    if pred is None:
        return f"{name}: Forecast unavailable"

    if pred["minutes_to_40"] is None:
        return f"{name}: Stable"

    if pred["minutes_to_40"] == 0:
        return f"{name}: At or below threshold"

    days = pred["minutes_to_40"] / (60 * 24)

    return f"{name}: ~{days:.1f} days until dry"
