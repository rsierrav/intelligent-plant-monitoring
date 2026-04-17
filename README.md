# Intelligent IoT Plant Monitoring
This project analyzes soil moisture data from two plants using time-series reasoning.
## Features
- Real-time data collection via Supabase
- Rolling average smoothing
- Rate-of-change event detection
- Watering event identification
- Comparative plant analysis
## Visualizations
- Baseline moisture comparison
- Smoothed moisture trends
- Watering event detection
- Time-to-dry comparison
### How to Run
1. Install dependencies:
```
pip install -r requirements.txt
```

2. Create a `.env` file:
```
SUPABASE_URL=your_url

SUPABASE_KEY=your_key
```

3. Run:
```
python main.py
```
## Project Structure

- `analysis/` → core logic
- `experiments/` → analysis graphs
- `visualization/` → plotting