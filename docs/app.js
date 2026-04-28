const API_URL = "http://127.0.0.1:5000";
let chart;
let interval;
let lastUpdateTime = null;
let autoRefreshEnabled = false;
// blinking control for live point indicator
let blinkInterval = null;
let blinkOn = true;
// track last seen per-plant timestamps from /dashboard/latest
let lastSeenTimestamp = { Plant_A: null, Plant_B: null };

// Poll /dashboard/latest and only call full `load()` when timestamps change.
async function pollLatestForChanges() {
  try {
    const res = await fetch(`${API_URL}/dashboard/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const a = data.latest?.Plant_A?.timestamp ?? null;
    const b = data.latest?.Plant_B?.timestamp ?? null;

    // If either timestamp is new, trigger a full load
    if (a && a !== lastSeenTimestamp.Plant_A) {
      lastSeenTimestamp.Plant_A = a;
      load();
      return;
    }
    if (b && b !== lastSeenTimestamp.Plant_B) {
      lastSeenTimestamp.Plant_B = b;
      load();
      return;
    }
  } catch (err) {
    // ignore polling errors; full load will surface failures
  }
}

function startBlink() {
  stopBlink();
  blinkInterval = setInterval(() => {
    blinkOn = !blinkOn;
    if (!chart) return;
    chart.data.datasets.forEach((ds) => {
      if (ds.label && ds.label.includes("Live")) {
        ds.pointRadius = blinkOn ? 6 : 0;
      }
    });
    chart.update("none");
  }, 600);
}

function stopBlink() {
  if (blinkInterval) {
    clearInterval(blinkInterval);
    blinkInterval = null;
  }
}

function createChartOptions(isLight) {
  return {
    responsive: true,
    animation: false,
    parsing: true,
    normalized: true,
    interaction: {
      mode: "nearest",
      axis: "xy",
      intersect: true
    },
    plugins: {
      legend: {
        labels: {
          color: isLight ? "#111827" : "#ffffff",
          filter: (item) => !item.text.includes(" Live")
        },
        position: "top"
      },
      tooltip: {
        enabled: true,
        mode: "nearest",
        intersect: true,
        callbacks: {
          title: (items) => {
            if (!items.length) return "";
            const x = items[0].parsed?.x ?? items[0].label ?? null;
            if (!x) return "";
            const ms = typeof x === "number" ? x : new Date(x).getTime();
            return luxon.DateTime.fromMillis(ms).toFormat("MMM d, yyyy HH:mm");
          },
          label: (context) => {
            const value = context.parsed?.y;
            if (value == null) return context.dataset.label;
            return `${context.dataset.label}: ${Number(value).toFixed(1)}%`;
          }
        }
      }
    },
    scales: {
      x: {
        type: "time",
        time: {
          unit: "day",
          displayFormats: {
            day: "MMM d"
          },
          tooltipFormat: "MMM d, yyyy HH:mm"
        },
        title: {
          display: true,
          text: "Time",
          color: isLight ? "#111827" : "#ffffff"
        },
        ticks: {
          color: isLight ? "#111827" : "#ffffff",
          autoSkip: true,
          maxTicksLimit: 10,
          maxRotation: 35,
          minRotation: 35,
          callback: (value) => luxon.DateTime.fromMillis(value).toFormat("MMM d HH:mm")
        },
        grid: {
          color: isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)"
        }
      },
      y: {
        min: 0,
        max: 100,
        title: {
          display: true,
          text: "Moisture %",
          color: isLight ? "#111827" : "#ffffff"
        },
        ticks: {
          color: isLight ? "#111827" : "#ffffff"
        },
        grid: {
          color: isLight ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)"
        }
      }
    }
  };
}

function setAutoRefresh(enabled) {
  autoRefreshEnabled = enabled;

  if (interval) {
    clearInterval(interval);
    interval = null;
  }

  if (autoRefreshEnabled) {
    // poll latest changes frequently and only run full load when needed
    interval = setInterval(pollLatestForChanges, 7000);
  }

  const toggleButton = document.getElementById("autoRefreshToggle");
  if (toggleButton) {
    toggleButton.innerText = autoRefreshEnabled
      ? "Pause Auto-Refresh"
      : "Resume Auto-Refresh";
  }

  localStorage.setItem(
    "autoRefreshEnabled",
    autoRefreshEnabled ? "true" : "false"
  );
}

// Fetch only the latest small payload to populate UI immediately
async function fetchLatestOnly() {
  try {
    const res = await fetch(`${API_URL}/dashboard/latest`);
    if (!res.ok) return;
    const data = await res.json();
    const latestA = data.latest?.Plant_A;
    const latestB = data.latest?.Plant_B;

    if (latestA) {
      document.getElementById("valueA").innerText = `${latestA.moisture}%`;
      if (latestA.light !== undefined) document.getElementById("lightA").innerText = `${Number(latestA.light).toFixed(1)} lux`;
      if (latestA.temperature !== undefined) document.getElementById("tempA").innerText = `${Number(latestA.temperature).toFixed(1)} °C`;
      if (latestA.humidity !== undefined) document.getElementById("humidityA").innerText = `${Number(latestA.humidity).toFixed(1)} %`;
    }
    if (latestB) {
      document.getElementById("valueB").innerText = `${latestB.moisture}%`;
      if (latestB.light !== undefined) document.getElementById("lightB").innerText = `${Number(latestB.light).toFixed(1)} lux`;
      if (latestB.temperature !== undefined) document.getElementById("tempB").innerText = `${Number(latestB.temperature).toFixed(1)} °C`;
      if (latestB.humidity !== undefined) document.getElementById("humidityB").innerText = `${Number(latestB.humidity).toFixed(1)} %`;
    }

    lastUpdateTime = new Date();
    updateStatusBar("live");
  } catch (err) {
    // ignore lightweight failures; full load() will handle errors
  }
}

// Fetch prediction summary (latest + forecast) so we can render dotted forecast lines
// immediately while full history loads in background.
async function fetchSummaryOnly() {
  try {
    const res = await fetch(`${API_URL}/dashboard/summary`);
    if (!res.ok) return;
    const data = await res.json();

    const predA = data.prediction?.Plant_A;
    const predB = data.prediction?.Plant_B;
    const latestA = data.latest?.Plant_A;
    const latestB = data.latest?.Plant_B;

    if (predA && predB) {
      document.getElementById("forecastText").innerText =
        `Plant A: ~${predA.eta_hours?.toFixed(1)} hours until dry\nPlant B: ~${predB.eta_hours?.toFixed(1)} hours until dry`;

      const futureOnlyA = (predA.forecast || []).map((p) => ({ x: new Date(p.t), y: p.value }));
      const futureOnlyB = (predB.forecast || []).map((p) => ({ x: new Date(p.t), y: p.value }));

      const livePointA = latestA && latestA.timestamp ? [{ x: new Date(latestA.timestamp), y: latestA.moisture }] : [];
      const livePointB = latestB && latestB.timestamp ? [{ x: new Date(latestB.timestamp), y: latestB.moisture }] : [];

      // Create a visual break after the live point so the dotted forecast starts cleanly.
      const forecastDataA = livePointA.length
        ? [{ x: livePointA[0].x, y: null }, ...futureOnlyA]
        : futureOnlyA;
      const forecastDataB = livePointB.length
        ? [{ x: livePointB[0].x, y: null }, ...futureOnlyB]
        : futureOnlyB;

      // minimal datasets: forecasts + live points + threshold
      const datasets = [
        {
          label: "Plant A Forecast",
          data: forecastDataA,
          borderColor: "#3b82f6",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          spanGaps: false,
          order: 3,
          parsing: true
        },
        {
          label: "Plant B Forecast",
          data: forecastDataB,
          borderColor: "#f97316",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          spanGaps: false,
          order: 3,
          parsing: true
        },
        {
          label: "Plant A Live",
          data: livePointA,
          borderColor: "#3b82f6",
          backgroundColor: "#3b82f6",
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          order: 1
        },
        {
          label: "Plant B Live",
          data: livePointB,
          borderColor: "#f97316",
          backgroundColor: "#f97316",
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          order: 1
        },
        {
          label: "Threshold (40%)",
          data: [
            { x: new Date(Date.now() - 7 * 24 * 3600 * 1000), y: 40 },
            { x: new Date(Date.now() + 7 * 24 * 3600 * 1000), y: 40 }
          ],
          borderColor: "red",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0,
          order: 4
        }
      ];

      // If chart exists and already contains history, don't overwrite full chart here;
      // otherwise create/update a minimal forecast-only chart so user sees dotted lines immediately.
      if (!chart) {
        const ctx = document.getElementById("chart").getContext("2d");
        chart = new Chart(ctx, {
          type: "line",
          data: { datasets },
          options: createChartOptions(document.body.classList.contains("light"))
        });
        startBlink();
      } else {
        // If chart already has history datasets, merge forecast/live/threshold
        // into it instead of replacing everything (preserve history for hover).
        const hasHistory = chart.data.datasets.some((ds) => ds.label === "Plant A" || ds.label === "Plant B");
        if (hasHistory) {
          datasets.forEach((newDs) => {
            const idx = chart.data.datasets.findIndex((ds) => ds.label === newDs.label);
            if (idx >= 0) {
              // replace data and a few display props
              chart.data.datasets[idx].data = newDs.data;
              chart.data.datasets[idx].borderDash = newDs.borderDash;
              chart.data.datasets[idx].borderColor = newDs.borderColor;
              chart.data.datasets[idx].pointRadius = newDs.pointRadius;
              chart.data.datasets[idx].pointHoverRadius = newDs.pointHoverRadius;
              chart.data.datasets[idx].pointHitRadius = newDs.pointHitRadius;
            } else {
              chart.data.datasets.push(newDs);
            }
          });
          chart.update("none");
          startBlink();
        } else {
          // No history present: replace entire datasets (minimal chart)
          chart.data.datasets = datasets;
          chart.update("none");
          startBlink();
        }
      }
    }
  } catch (err) {
    // ignore; full load will populate everything
  }
}

async function load() {
  try {
    const res = await fetch(`${API_URL}/dashboard`);
    const data = await res.json();

    // Update last update time
    lastUpdateTime = new Date();
    updateStatusBar("live");

    const A = data.prediction.Plant_A;
    const B = data.prediction.Plant_B;

    const latestA = data.latest.Plant_A;
    const latestB = data.latest.Plant_B;

    // Get historical data
    const historyA = data.history.Plant_A || [];
    const historyB = data.history.Plant_B || [];

    updatePlant("A", data.decision.Plant_A, latestA.moisture, A, latestA);
    updatePlant("B", data.decision.Plant_B, latestB.moisture, B, latestB);

    document.getElementById("forecastText").innerText =
      `Plant A: ~${A.eta_hours?.toFixed(1)} hours until dry\nPlant B: ~${B.eta_hours?.toFixed(1)} hours until dry`;

    buildChart(historyA, A.forecast, historyB, B.forecast);
  } catch (error) {
    console.error("Failed to load dashboard:", error);
    updateStatusBar("offline");
  }
}

function updateStatusBar(status) {
  const indicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const lastUpdatedEl = document.getElementById("lastUpdated");

  indicator.className = `indicator-dot ${status}`;

  if (status === "live") {
    statusText.innerText = "🟢 Live";
  } else if (status === "stale") {
    statusText.innerText = "🟡 Stale";
  } else {
    statusText.innerText = "🔴 Offline";
  }

  if (lastUpdateTime) {
    lastUpdatedEl.innerText = `Last updated: ${lastUpdateTime.toLocaleTimeString()}`;
  }
}

// Monitor connection status (mark as stale if no update for 60 seconds)
setInterval(() => {
  if (lastUpdateTime) {
    const secondsAgo = (new Date() - lastUpdateTime) / 1000;
    if (secondsAgo > 60) {
      updateStatusBar("stale");
    }
  }
}, 10000);

function updatePlant(id, status, moisture, pred, sensorData) {
  document.getElementById(`value${id}`).innerText = `${moisture}%`;

  // Update sensor data if available
  const light = sensorData?.light ?? sensorData?.light_intensity;
  const temp = sensorData?.temperature;
  const humidity = sensorData?.humidity;

  if (light !== undefined) {
    document.getElementById(`light${id}`).innerText = `${light.toFixed(1)} lux`;
  }
  if (temp !== undefined) {
    document.getElementById(`temp${id}`).innerText = `${temp.toFixed(1)} °C`;
  }
  if (humidity !== undefined) {
    document.getElementById(`humidity${id}`).innerText = `${humidity.toFixed(1)} %`;
  }

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

function buildChart(historyA, forecastA, historyB, forecastB) {
  const isLight = document.body.classList.contains("light");
  const ctx = document.getElementById("chart").getContext("2d");

  // HISTORY DATA (solid lines)
  const historyDataA = historyA.map((p) => ({
    x: new Date(p.t),
    y: p.value
  }));
  const historyDataB = historyB.map((p) => ({
    x: new Date(p.t),
    y: p.value
  }));

  // FORECAST DATA (dotted continuation)
  const futureOnlyA = forecastA.map((p) => ({
    x: new Date(p.t),
    y: p.value
  }));
  const futureOnlyB = forecastB.map((p) => ({
    x: new Date(p.t),
    y: p.value
  }));

  // Start forecast from the last observed point for a seamless continuation.
  const forecastDataA = historyDataA.length
    ? [{ x: historyDataA[historyDataA.length - 1].x, y: null }, ...futureOnlyA]
    : futureOnlyA;
  const forecastDataB = historyDataB.length
    ? [{ x: historyDataB[historyDataB.length - 1].x, y: null }, ...futureOnlyB]
    : futureOnlyB;

  // Current live points (last observed historical sample).
  const livePointA = historyDataA.length
    ? [historyDataA[historyDataA.length - 1]]
    : [];
  const livePointB = historyDataB.length
    ? [historyDataB[historyDataB.length - 1]]
    : [];

  // Build a stable domain: minimum 1 week back + 1 week forward.
  const latestObservedMs = Math.max(
    historyDataA[historyDataA.length - 1]?.x?.getTime() || -Infinity,
    historyDataB[historyDataB.length - 1]?.x?.getTime() || -Infinity
  );

  const allPoints = [
    ...historyDataA,
    ...historyDataB,
    ...forecastDataA,
    ...forecastDataB
  ];

  const fallbackNowMs = allPoints.length
    ? Math.max(...allPoints.map((p) => p.x.getTime()))
    : Date.now();
  const anchorMs = Number.isFinite(latestObservedMs) ? latestObservedMs : fallbackNowMs;

  // Round anchor to hour to prevent tiny x-axis shifts every refresh.
  const hourMs = 60 * 60 * 1000;
  const stabilizedAnchorMs = Math.floor(anchorMs / hourMs) * hourMs;

  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
  const minWindowStartMs = stabilizedAnchorMs - oneWeekMs;
  const minWindowEndMs = stabilizedAnchorMs + oneWeekMs;

  const dataMinMs = allPoints.length
    ? Math.min(...allPoints.map((p) => p.x.getTime()))
    : minWindowStartMs;
  const dataMaxMs = allPoints.length
    ? Math.max(...allPoints.map((p) => p.x.getTime()))
    : minWindowEndMs;

  const xMin = new Date(Math.min(minWindowStartMs, dataMinMs));
  const xMax = new Date(Math.max(minWindowEndMs, dataMaxMs));

  const thresholdData =
    xMin && xMax
      ? [
          { x: xMin, y: 40 },
          { x: xMax, y: 40 }
        ]
      : [];

  const datasets = [
        // HISTORY (solid)
        {
          label: "Plant A",
          data: historyDataA,
          borderColor: "#3b82f6",
          borderWidth: 2,
          fill: false,
          tension: 0,
          // small visible points so tooltips can reliably target them
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointBackgroundColor: "#3b82f6",
          order: 2,
          spanGaps: false,
          parsing: true
        },
        {
          label: "Plant B",
          data: historyDataB,
          borderColor: "#f97316",
          borderWidth: 2,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointBackgroundColor: "#f97316",
          order: 2,
          spanGaps: false,
          parsing: true
        },

        // LIVE POINTS (current observed values)
        {
          label: "Plant A Live",
          data: livePointA,
          borderColor: "#3b82f6",
          backgroundColor: "#3b82f6",
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          order: 1
        },
        {
          label: "Plant B Live",
          data: livePointB,
          borderColor: "#f97316",
          backgroundColor: "#f97316",
          showLine: false,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          order: 1
        },

        // FORECAST (dotted continuation)
        {
          label: "Plant A Forecast",
          data: forecastDataA,
          borderColor: "#3b82f6",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          spanGaps: false,
          order: 3,
          parsing: true
        },
        {
          label: "Plant B Forecast",
          data: forecastDataB,
          borderColor: "#f97316",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          tension: 0,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          spanGaps: false,
          order: 3,
          parsing: true
        },

        // THRESHOLD (red dashed)
        {
          label: "Threshold (40%)",
          data: thresholdData,
          borderColor: "red",
          borderDash: [5, 5],
          borderWidth: 2,
          fill: false,
          pointRadius: 0,
          pointHoverRadius: 0,
          tension: 0,
          order: 4
        }
      ];

  const chartOptions = createChartOptions(isLight);
  chartOptions.scales.x.min = xMin;
  chartOptions.scales.x.max = xMax;

  if (!chart) {
    chart = new Chart(ctx, {
      type: "line",
      data: { datasets },
      options: chartOptions
    });
    startBlink();
    return;
  }

  chart.data.datasets = datasets;
  chart.update("none");
  startBlink();
}

window.onload = () => {
  // Initialize status bar
  updateStatusBar("live");

  fetchSummaryOnly(); // render forecast immediately
  fetchLatestOnly(); // populate UI quickly with minimal payload
  load(); // then load full dashboard (chart etc.)

  const toggle = document.getElementById("themeToggle");
  // Always enable continuous auto-refresh (no UI toggle)
  autoRefreshEnabled = true;
  setAutoRefresh(true);

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
};