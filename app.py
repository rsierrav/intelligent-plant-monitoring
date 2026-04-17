import streamlit as st
import matplotlib.pyplot as plt
import streamlit.components.v1 as components
import numpy as np
import pandas as pd
import os
from dotenv import load_dotenv
from supabase import create_client
from analysis.reasoning_engine import (
    run_reasoning_engine,
    get_latest_decision,
)
from analysis.preprocessing import (
    get_latest_source_timestamp,
    get_latest_raw_moisture_by_plant,
)


load_dotenv()

THRESHOLD = 40
FORECAST_WINDOW_MINUTES = 60
FORECAST_HORIZON_HOURS = 72


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


def build_prediction_line(series, slope, intercept, horizon_minutes):
    s = series.dropna()
    if s.empty:
        return None, None

    last_time = s.index[-1]
    periods = max(2, int(np.ceil(horizon_minutes / 5.0)))
    future_times = pd.date_range(
        start=last_time + pd.Timedelta(minutes=5),
        periods=periods,
        freq="5min",
    )

    # Include the exact horizon endpoint so threshold crossings are visible.
    horizon_end = last_time + pd.Timedelta(minutes=float(horizon_minutes))
    if future_times.empty or future_times[-1] < horizon_end:
        future_times = future_times.append(pd.DatetimeIndex([horizon_end]))

    x_future = (future_times - s.index[0]).total_seconds() / 60.0
    y_future = slope * x_future + intercept
    return future_times, y_future


def predict_plant(series, horizon_minutes):
    s = series.dropna()
    if len(s) < 5:
        s = series.dropna().tail(20)
        if len(s) < 5:
            return None

    slope, intercept = fit_linear(s)
    if slope is None:
        return None

    current = s.iloc[-1]
    last_time = s.index[-1]
    minutes = time_to_threshold(current, slope)

    # If we're drying, always extend the projection enough to reach 40%.
    effective_horizon = horizon_minutes
    if minutes is not None:
        effective_horizon = max(horizon_minutes, float(minutes))

    future_t, future_y = build_prediction_line(
        s,
        slope,
        intercept,
        effective_horizon,
    )

    eta_to_40 = None
    if minutes is not None:
        eta_to_40 = last_time + pd.Timedelta(minutes=float(minutes))

    return {
        "slope": slope,
        "current": current,
        "last_time": last_time,
        "minutes_to_40": minutes,
        "eta_to_40": eta_to_40,
        "future_t": future_t,
        "future_y": future_y,
    }


def format_prediction(pred, name):
    if pred is None:
        return f"{name}: Forecast unavailable"

    if pred["minutes_to_40"] is None:
        return f"{name}: Stable"

    if pred["minutes_to_40"] == 0:
        return f"{name}: At or below threshold"

    days = pred["minutes_to_40"] / (60 * 24)
    return f"{name}: ~{days:.1f} days until dry"


def get_supabase_client():
    supabase_url = os.getenv("SUPABASE_URL")
    supabase_key = os.getenv("SUPABASE_KEY")

    if not supabase_url or not supabase_key:
        raise ValueError("Missing SUPABASE_URL or SUPABASE_KEY in environment")

    return create_client(supabase_url, supabase_key)


def render_auth_sidebar(supabase):
    st.sidebar.title("Authentication")

    if "demo_view" not in st.session_state:
        query_demo = str(st.query_params.get("demo", "0")).lower()
        st.session_state["demo_view"] = query_demo in ["1", "true", "yes"]

    demo_view = st.sidebar.toggle(
        "Demo View (skip login)",
        key="demo_view",
    )
    st.query_params["demo"] = "1" if demo_view else "0"

    if demo_view:
        demo_user_id = os.getenv("DEMO_USER_ID")
        demo_user_email = os.getenv("DEMO_USER_EMAIL", "demo@local")

        if not demo_user_id:
            st.sidebar.warning(
                "Demo mode needs DEMO_USER_ID in .env or below."
            )
            demo_user_id = st.sidebar.text_input(
                "Demo user ID",
                key="demo_user_id_input",
                placeholder="Paste a user UUID",
            ).strip()
            if not demo_user_id:
                return None

        st.sidebar.info("Demo mode active. Auth is bypassed.")
        show_user_id = st.sidebar.checkbox("Show user ID", value=False)
        if show_user_id:
            st.sidebar.write(f"User ID: {demo_user_id}")

        return {
            "id": demo_user_id,
            "email": demo_user_email,
            "is_demo": True,
        }

    if "auth_user" not in st.session_state:
        st.session_state["auth_user"] = None

    auth_user = st.session_state["auth_user"]

    if auth_user:
        st.sidebar.success(f"Logged in as {auth_user['email']}")
        show_user_id = st.sidebar.checkbox("Show user ID", value=False)
        if show_user_id:
            st.sidebar.write(f"User ID: {auth_user['id']}")
        if st.sidebar.button("Logout"):
            try:
                supabase.auth.sign_out()
            except Exception:
                pass
            st.session_state["auth_user"] = None
            st.rerun()
        return auth_user

    auth_action = st.sidebar.radio(
        "Action",
        ["Login", "Sign Up"],
        horizontal=True,
    )
    email = st.sidebar.text_input("Email")
    password = st.sidebar.text_input("Password", type="password")

    if auth_action == "Login":
        if st.sidebar.button("Login"):
            if not email or not password:
                st.sidebar.error("Email and password are required")
            else:
                try:
                    response = supabase.auth.sign_in_with_password(
                        {
                            "email": email,
                            "password": password,
                        }
                    )
                    if response.user:
                        st.session_state["auth_user"] = {
                            "id": response.user.id,
                            "email": response.user.email,
                        }
                        st.rerun()
                    else:
                        st.sidebar.error("Login failed")
                except Exception as exc:
                    st.sidebar.error(f"Login failed: {exc}")
    else:
        if st.sidebar.button("Create Account"):
            if not email or not password:
                st.sidebar.error("Email and password are required")
            else:
                try:
                    response = supabase.auth.sign_up(
                        {
                            "email": email,
                            "password": password,
                        }
                    )
                    if response.user:
                        if response.session:
                            st.session_state["auth_user"] = {
                                "id": response.user.id,
                                "email": response.user.email,
                            }
                            st.rerun()
                        else:
                            st.sidebar.success(
                                "Account created. Check your email "
                                "to confirm it, then log in."
                            )
                    else:
                        st.sidebar.error("Sign up failed")
                except Exception as exc:
                    st.sidebar.error(f"Sign up failed: {exc}")

    return None


@st.cache_data(show_spinner=False)
def load_reasoning_snapshot(user_id, source_key):
    return run_reasoning_engine(user_id)


try:
    supabase = get_supabase_client()
except Exception as exc:
    st.error(f"Failed to initialize Supabase client: {exc}")
    st.stop()

current_user = render_auth_sidebar(supabase)
if not current_user:
    st.title("Plant Moisture Dashboard")
    st.info("Please log in from the sidebar to view live plant data.")
    st.stop()

user_id = current_user["id"]
is_demo = current_user.get("is_demo", False)

st.title("Plant Moisture Dashboard")

if is_demo:
    st.caption("Demo Mode")
    live_mode = False
    refresh_seconds = 20
else:
    live_mode = st.toggle("Live Mode", value=True)
    refresh_seconds = st.slider(
        "Auto-refresh interval (seconds)",
        min_value=5,
        max_value=120,
        value=20,
        step=5,
    )

if st.button("Refresh Data"):
    load_reasoning_snapshot.clear()
    st.rerun()

try:
    latest_source_time = get_latest_source_timestamp(user_id)
except Exception as exc:
    st.error(f"Failed to check latest data timestamp: {exc}")
    st.stop()

source_key = f"{user_id}:{latest_source_time.isoformat()}"
previous_key = st.session_state.get("latest_source_key")
st.session_state["latest_source_key"] = source_key

try:
    df, smoothed, rate, states = load_reasoning_snapshot(user_id, source_key)
except Exception as exc:
    st.error(f"Failed to load decision data: {exc}")
    st.stop()

for col in ["Plant_A", "Plant_B"]:
    if col not in df.columns:
        st.error(f"Missing required column: {col}")
        st.stop()

try:
    latest_raw = get_latest_raw_moisture_by_plant(user_id)
except Exception:
    latest_raw = {
        "Plant_A": {
            "moisture": float(df["Plant_A"].dropna().iloc[-1]),
            "timestamp": df.index.max(),
        },
        "Plant_B": {
            "moisture": float(df["Plant_B"].dropna().iloc[-1]),
            "timestamp": df.index.max(),
        },
    }

decision = get_latest_decision(states)

latest_sensor_time = max(
    latest_raw["Plant_A"]["timestamp"],
    latest_raw["Plant_B"]["timestamp"],
).strftime("%Y-%m-%d %I:%M:%S %p %Z")

st.caption(f"Latest sensor reading: {latest_sensor_time}")

st.subheader("Live Moisture + Decision")

col1, col2 = st.columns(2)

col1.metric(
    "Plant A (Live)",
    f"{latest_raw['Plant_A']['moisture']:.2f}%",
    decision["Plant_A"],
)
col2.metric(
    "Plant B (Live)",
    f"{latest_raw['Plant_B']['moisture']:.2f}%",
    decision["Plant_B"],
)

window_minutes = FORECAST_WINDOW_MINUTES
forecast_horizon_hours = FORECAST_HORIZON_HOURS

now = df.index.max()
recent = df[df.index >= now - pd.Timedelta(minutes=window_minutes)]

if len(recent.dropna()) < 5:
    recent = df.tail(50)

forecast_horizon_minutes = forecast_horizon_hours * 60
pred_A = predict_plant(recent["Plant_A"], forecast_horizon_minutes)
pred_B = predict_plant(recent["Plant_B"], forecast_horizon_minutes)

st.subheader("Forecast")
st.write(format_prediction(pred_A, "Plant A"))
st.write(format_prediction(pred_B, "Plant B"))
st.caption(
    "Forecast is calculated automatically from the latest "
    "60 minutes of data."
)

fig, ax = plt.subplots(figsize=(10, 5))

ax.plot(
    smoothed.index,
    smoothed["Plant_A"],
    linewidth=2,
    label="Plant A",
)
ax.plot(
    smoothed.index,
    smoothed["Plant_B"],
    linewidth=2,
    label="Plant B",
)

if pred_A is not None and pred_A["future_t"] is not None:
    y_future_a = np.clip(pred_A["future_y"], 0, 100)
    ax.plot(
        pred_A["future_t"],
        y_future_a,
        linestyle=":",
        linewidth=2,
        label="Plant A Forecast",
    )
    ax.text(
        pred_A["future_t"][-1],
        y_future_a[-1],
        "A",
        color="blue",
    )

if pred_B is not None and pred_B["future_t"] is not None:
    y_future_b = np.clip(pred_B["future_y"], 0, 100)
    ax.plot(
        pred_B["future_t"],
        y_future_b,
        linestyle=":",
        linewidth=2,
        label="Plant B Forecast",
    )
    ax.text(
        pred_B["future_t"][-1],
        y_future_b[-1],
        "B",
        color="orange",
    )

ax.axhline(
    y=THRESHOLD,
    color="red",
    linestyle="-.",
    linewidth=1.5,
    alpha=0.8,
    label="Threshold",
)

# Mark latest real-time reading so users can see immediate changes.
ax.scatter(
    latest_raw["Plant_A"]["timestamp"],
    latest_raw["Plant_A"]["moisture"],
    color="blue",
    s=80,
    # zorder=5,
)
ax.scatter(
    latest_raw["Plant_B"]["timestamp"],
    latest_raw["Plant_B"]["moisture"],
    color="orange",
    s=80,
    # zorder=5,
)

ax.grid(True, alpha=0.5)
ax.set_xlabel("Time")
ax.set_ylabel("Moisture %")
ax.set_title("Moisture Trend & Short-Term Forecast")

# Keep the plot vertically tight so the trend sits closer to the x-axis.
y_candidates = []
for col in ["Plant_A", "Plant_B"]:
    y_candidates.extend(smoothed[col].dropna().tolist())

if pred_A is not None and pred_A["future_y"] is not None:
    y_candidates.extend(np.clip(pred_A["future_y"], 0, 100).tolist())
if pred_B is not None and pred_B["future_y"] is not None:
    y_candidates.extend(np.clip(pred_B["future_y"], 0, 100).tolist())

y_candidates.append(THRESHOLD)
if y_candidates:
    y_max = min(100, max(y_candidates) + 3)
    if y_max < 6:
        y_max = 6
    ax.set_ylim(0, y_max)

# Remove extra side padding so time-series starts at the edge of the axis.
ax.margins(x=0)

ax.legend()

fig.autofmt_xdate()
st.pyplot(fig)

if live_mode:
    components.html(
        f"""
        <script>
        setTimeout(() => window.parent.location.reload(),
            {refresh_seconds * 1000});
        </script>
        """,
        height=0,
    )
