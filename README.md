# Intelligent IoT Plant Monitoring

This project is an IoT plant dashboard that reads plant, soil moisture, and environment data from Supabase, analyzes the data with a Python reasoning engine, and displays the results in a browser dashboard.

## What each part is for

- `backend/app.py` - Flask API used by the dashboard. It exposes endpoints for dashboard data, latest readings, environment readings, and plant management.
- `backend/analysis/` - data loading, smoothing, rate analysis, classification, and watering decision logic.
- `backend/prediction.py` - forecast logic used by the dashboard prediction cards.
- `docs/` - static frontend dashboard files. `index.html` loads `app.js`, `style.css`, and `config.js`.
- `main.py` - capstone analysis script that generates plot files and prints the latest plant watering decisions.
- `analysis_plots/` - plotting helpers used by `main.py`.
- `data/processed/` - generated plot output from `main.py`. This folder is created when the script runs and is not committed.
- `PlantMonitoringBoard/` - microcontroller/PlatformIO code for the physical plant monitoring board.

## Requirements

- Python 3.10 or newer
- A Supabase project with the app tables and plant data
- A Supabase API key for the backend
- A Supabase anon key for frontend login

## 1. Install dependencies

From the repo root:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

On macOS/Linux, activate the environment with:

```bash
source .venv/bin/activate
```

## 2. Create backend environment variables

In the repo root, create a `.env` file:

```env
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_KEY=YOUR_SERVICE_ROLE_OR_API_KEY

# Optional: lets dashboard API requests work without manually passing user_id
DEMO_USER_ID=your-user-uuid
```

`SUPABASE_KEY` is used by the Flask backend to read and update Supabase data. Do not put a service role key in frontend files.

## 3. Configure the frontend

Edit `docs/config.js`:

```js
const CONFIG = {
  SUPABASE_URL: "https://YOUR_PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR_SUPABASE_ANON_KEY",
  API_URL: "http://127.0.0.1:5000"
};
```

Use the anon key here because this file is loaded by the browser.

## 4. Start the backend API

From the repo root:

```bash
python backend/app.py
```

Flask should start on:

```text
http://127.0.0.1:5000
```

You can quickly check it by opening `http://127.0.0.1:5000/`. It should return `API running`.

## 5. Serve the frontend

In a second terminal from the repo root:

```bash
python -m http.server 5500 -d docs
```

Open:

```text
http://localhost:5500/
```

The frontend calls the local Flask API configured in `docs/config.js`.

## How to use the dashboard

1. Open `http://localhost:5500/`.
2. Log in or create an account using Supabase Auth.
3. Create or assign plants from the dashboard controls.
4. Use **Refresh Data** to load the latest readings.
5. Review the live moisture values, historical chart, environment readings, watering decision, and prediction output.

## Run the analysis script

To run the standalone analysis and generate local plots, either set `DEMO_USER_ID` in `.env` or pass a Supabase user id directly:

```bash
python main.py
```

```bash
python main.py your-user-uuid
```

This uses the same Supabase environment variables as the dashboard. It prints the latest watering decisions in the terminal and saves these plots:

- `data/processed/baseline.png`
- `data/processed/rolling_average.png`
- `data/processed/watering_trends.png`
- `data/processed/time_to_dry.png`
- `data/processed/rolling_with_events.png`

## Capstone review guide

For a quick code review, start with these files:

1. `backend/analysis/preprocessing.py` - pulls and prepares Supabase time-series data.
2. `backend/analysis/reasoning_engine.py` - runs smoothing, rate-of-change, and classification.
3. `backend/analysis/classification.py` - contains the watering decision rules.
4. `backend/prediction.py` - estimates future moisture trend and time to dry.
5. `backend/app.py` - serves the dashboard API.
6. `docs/app.js` - frontend dashboard behavior and API calls.
7. `main.py` - reproducible plot-generation entry point.
8. `analysis_plots/` - plot-generation code used for the capstone figures.

## Build / production notes

There is no frontend build step right now. The `docs/` folder is plain static HTML, CSS, and JavaScript, so `docs/` is the frontend build output.

For local development on Windows, use:

```bash
python backend/app.py
```
