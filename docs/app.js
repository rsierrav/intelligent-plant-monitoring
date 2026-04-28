const API_URL = "http://127.0.0.1:5000";
let chart;

async function load() {
  const res = await fetch(`${API_URL}/dashboard`);
  const data = await res.json();

  const A = data.prediction.Plant_A;
  const B = data.prediction.Plant_B;

  const latestA = data.latest.Plant_A;
  const latestB = data.latest.Plant_B;

  updatePlant("A", data.decision.Plant_A, latestA.moisture, A);
  updatePlant("B", data.decision.Plant_B, latestB.moisture, B);

  document.getElementById("forecastText").innerText =
    `Plant A: ~${A.eta_hours?.toFixed(1)} hours until dry\nPlant B: ~${B.eta_hours?.toFixed(1)} hours until dry`;

  buildChart(A.forecast, B.forecast);
}

function updatePlant(id, status, moisture, pred) {
  document.getElementById(`value${id}`).innerText = `${moisture}%`;

  const badge = document.getElementById(`status${id}`);
  badge.innerText = status;
  badge.className = "badge";

  if (status.toLowerCase().includes("stable")) {
    badge.classList.add("stable");
  } else if (status.toLowerCase().includes("dry")) {
    badge.classList.add("drying");
  } else {
    badge.classList.add("critical");
  }

  const eta = pred.eta_to_40
    ? new Date(pred.eta_to_40).toLocaleString()
    : "N/A";

  document.getElementById(`eta${id}`).innerText =
    `${pred.eta_hours?.toFixed(1)} hrs (~${eta})`;
}

function buildChart(forecastA, forecastB) {
  const labels = forecastA.map((p) => new Date(p.t).toLocaleTimeString());
  const dataA = forecastA.map((p) => p.value);
  const dataB = forecastB.map((p) => p.value);
  const isLight = document.body.classList.contains("light");
  const ctx = document.getElementById("chart").getContext("2d");

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Plant A",
          data: dataA,
          borderColor: "#3b82f6"
        },
        {
          label: "Plant B",
          data: dataB,
          borderColor: "#f97316"
        },
        {
          label: "Threshold (40%)",
          data: labels.map(() => 40),
          borderDash: [5, 5]
        }
      ]
    },
    options: {
      plugins: {
        legend: {
          labels: { color: isLight ? "black" : "white" }
        }
      },
      scales: {
        x: {
          ticks: { color: isLight ? "black" : "white" }
        },
        y: {
          ticks: { color: isLight ? "black" : "white" }
        }
      }
    }
  });
}

window.addEventListener("DOMContentLoaded", () => {
  load();

  const toggle = document.getElementById("themeToggle");

  // Load saved theme preference
  if (localStorage.getItem("theme") === "light") {
    document.body.classList.add("light");
    toggle.checked = true;
  }

  toggle.addEventListener("change", () => {
    if (toggle.checked) {
      document.body.classList.add("light");
      localStorage.setItem("theme", "light");
    } else {
      document.body.classList.remove("light");
      localStorage.setItem("theme", "dark");
    }
  });
});