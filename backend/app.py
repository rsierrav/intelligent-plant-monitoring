from flask import Flask, jsonify
from flask_cors import CORS
from analysis.reasoning_engine import run_reasoning_engine, get_latest_decision
from analysis.preprocessing import get_latest_raw_moisture_by_plant
from prediction import predict_plant

app = Flask(__name__)
CORS(app)


@app.route("/")
def home():
    return "API running"


@app.route("/dashboard/<user_id>")
def dashboard(user_id):
    df, smoothed, rate, states = run_reasoning_engine(user_id)

    decision = get_latest_decision(states)
    latest = get_latest_raw_moisture_by_plant(user_id)

    pred_A = predict_plant(df["Plant_A"], 72*60)
    pred_B = predict_plant(df["Plant_B"], 72*60)

    return jsonify({
        "latest": latest,
        "decision": decision,
        "prediction": {
            "Plant_A": pred_A,
            "Plant_B": pred_B
        }
    })


if __name__ == "__main__":
    app.run(debug=True)
