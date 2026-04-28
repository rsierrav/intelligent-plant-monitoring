const API_URL = CONFIG.API_URL;

// Initialize Supabase client (only once)
let supabaseClient;
if (!window.supabaseClient) {
  supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  window.supabaseClientInstance = supabaseClient;
} else {
  supabaseClient = window.supabaseClientInstance;
}

// Auth state
let currentUser = null;

let chart;
let interval;
let lastUpdateTime = null;
let autoRefreshEnabled = false;
// blinking control for live point indicator
let blinkInterval = null;
let blinkOn = true;
// track last seen per-plant timestamps from /dashboard/latest
let lastSeenTimestamp = {};

// ============ AUTH FUNCTIONS ============

function toggleSignupMode() {
  document.getElementById("authForm").style.display = 
    document.getElementById("authForm").style.display === "none" ? "block" : "none";
  document.getElementById("signupForm").style.display = 
    document.getElementById("signupForm").style.display === "none" ? "block" : "none";
}

async function handleLogin() {
  const email = document.getElementById("authEmail").value;
  const password = document.getElementById("authPassword").value;
  const button = event.target;

  if (!email || !password) {
    showAuthError("Email and password required");
    return;
  }

  if (!email.includes("@")) {
    showAuthError("Enter a valid email");
    return;
  }

  // Show loading state
  button.innerText = "Logging in...";
  button.disabled = true;

  try {
    const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (error) {
      showAuthError(error.message);
      button.innerText = "Login";
      button.disabled = false;
      return;
    }

    currentUser = data.user;
    showDashboard();
  } catch (err) {
    showAuthError(err.message || "Login failed");
    button.innerText = "Login";
    button.disabled = false;
  }
}

async function handleSignup() {
  const email = document.getElementById("signupEmail").value;
  const password = document.getElementById("signupPassword").value;
  const passwordConfirm = document.getElementById("signupPasswordConfirm").value;
  const button = event.target;

  if (!email || !password || !passwordConfirm) {
    showAuthError("All fields required");
    return;
  }

  if (!email.includes("@")) {
    showAuthError("Enter a valid email");
    return;
  }

  if (password.length < 6) {
    showAuthError("Password must be at least 6 characters");
    return;
  }

  if (password !== passwordConfirm) {
    showAuthError("Passwords do not match");
    return;
  }

  // Show loading state
  button.innerText = "Creating account...";
  button.disabled = true;

  try {
    const { data, error } = await supabaseClient.auth.signUp({ email, password });

    if (error) {
      showAuthError(error.message);
      button.innerText = "Sign Up";
      button.disabled = false;
      return;
    }

    // Auto-login after signup
    currentUser = data.user;
    showDashboard();
  } catch (err) {
    showAuthError(err.message || "Signup failed");
    button.innerText = "Sign Up";
    button.disabled = false;
  }
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  currentUser = null;
  location.reload();
}

function showAuthError(message) {
  document.getElementById("authError").textContent = message;
}

function showAuthSection() {
  document.getElementById("authSection").style.display = "block";
  document.querySelector(".container").style.display = "none";
  document.querySelector(".status-bar").style.display = "none";
}

function showDashboard() {
  document.getElementById("authSection").style.display = "none";
  document.querySelector(".container").style.display = "block";
  document.querySelector(".status-bar").style.display = "block";
  document.getElementById("userEmail").textContent = currentUser.email;
  load();
}

async function openAddPlant() {
  const plantName = prompt("Enter plant name:");
  const plantType = prompt("Enter plant type:");

  if (!plantName) {
    return;
  }

  try {
    const res = await fetch(`${API_URL}/plants/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: currentUser.id,
        plant_name: plantName,
        plant_type: plantType,
      }),
    });

    if (!res.ok) {
      throw new Error("Failed to create plant");
    }

    location.reload();
  } catch (err) {
    showAuthError(err.message || "Could not create plant");
  }
}

// ============ END AUTH FUNCTIONS ============

// Poll /dashboard/latest and only call full `load()` when timestamps change.
async function pollLatestForChanges() {
  try {
    const res = await fetch(`${API_URL}/dashboard/latest?user_id=${currentUser.id}`);
    if (!res.ok) return;
    const data = await res.json();
    const latestMap = data.latest || {};
    for (const alias of Object.keys(latestMap)) {
      const ts = latestMap[alias]?.timestamp ?? null;
      if (ts && ts !== lastSeenTimestamp[alias]) {
        lastSeenTimestamp[alias] = ts;
        load();
        return;
      }
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
        ds.pointRadius = blinkOn ? 6 : 4;
      }
    });
    chart.draw();
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
    animation: {
      duration: 0
    },
    transitions: {
      active: {
        animation: {
          duration: 0
        }
      }
    },
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
        bounds: "data",
        offset: false,
        grace: 0,
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
    const res = await fetch(`${API_URL}/dashboard/latest?user_id=${currentUser.id}`);
    if (!res.ok) return;
    const data = await res.json();
    const latestMap = data.latest || {};
    Object.keys(latestMap).forEach((alias) => {
      const latest = latestMap[alias];
      const suffix = `_${alias}`;
      const valueEl = document.getElementById(`value${suffix}`);
      if (valueEl) {
        valueEl.innerText = latest && latest.moisture != null ? `${latest.moisture}%` : "--%";
      }
      if (latest) {
        if (latest.light !== undefined) {
          const el = document.getElementById(`light${suffix}`);
          if (el) el.innerText = `${Number(latest.light).toFixed(1)} lux`;
        }
        if (latest.temperature !== undefined) {
          const el = document.getElementById(`temp${suffix}`);
          if (el) el.innerText = `${Number(latest.temperature).toFixed(1)} °C`;
        }
        if (latest.humidity !== undefined) {
          const el = document.getElementById(`humidity${suffix}`);
          if (el) el.innerText = `${Number(latest.humidity).toFixed(1)} %`;
        }
      }
    });

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
    const res = await fetch(`${API_URL}/dashboard/summary?user_id=${currentUser.id}`);
    if (!res.ok) return;
    const data = await res.json();
    // Build forecast summary text for up to two plants
    const plants = data.plants || [];
    if (plants.length === 0) return;

    const aliases = plants.map(p => p.alias);
    const first = aliases[0];
    const second = aliases[1];

    const pred1 = data.prediction?.[first];
    const pred2 = data.prediction?.[second];

    let forecastText = "";
    if (pred1) forecastText += `${plants[0].plant_name}: ~${pred1.eta_hours?.toFixed(1)} hours until dry`;
    if (pred2) forecastText += `\n${plants[1].plant_name}: ~${pred2.eta_hours?.toFixed(1)} hours until dry`;
    document.getElementById("forecastText").innerText = forecastText;

    try {
      const futureOnly1 = (pred1?.forecast || []).map((p) => ({ x: new Date(p.t), y: p.value }));
      const futureOnly2 = (pred2?.forecast || []).map((p) => ({ x: new Date(p.t), y: p.value }));

      const latest1 = data.latest?.[first];
      const latest2 = data.latest?.[second];
      const livePoint1 = latest1 && latest1.timestamp ? [{ x: new Date(latest1.timestamp), y: latest1.moisture }] : [];
      const livePoint2 = latest2 && latest2.timestamp ? [{ x: new Date(latest2.timestamp), y: latest2.moisture }] : [];

      const forecastData1 = livePoint1.length ? [{ x: livePoint1[0].x, y: null }, ...futureOnly1] : futureOnly1;
      const forecastData2 = livePoint2.length ? [{ x: livePoint2[0].x, y: null }, ...futureOnly2] : futureOnly2;

      // minimal datasets for forecasts + live + threshold
      const datasets = [
        {
          label: `${plants[0].plant_name} Forecast`,
          data: forecastData1,
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
          label: `${plants[1]?.plant_name || 'Plant'} Forecast`,
          data: forecastData2,
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
          label: `${plants[0].plant_name} Live`,
          data: livePoint1,
          borderColor: "#3b82f6",
          backgroundColor: "#3b82f6",
          showLine: false,
          pointRadius: 5,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          z: 10,
          order: 1
        },
        {
          label: `${plants[1]?.plant_name || 'Plant'} Live`,
          data: livePoint2,
          borderColor: "#f97316",
          backgroundColor: "#f97316",
          showLine: false,
          pointRadius: 5,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          z: 10,
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

      if (!chart) {
        const ctx = document.getElementById("chart").getContext("2d");
        chart = new Chart(ctx, {
          type: "line",
          data: { datasets },
          options: createChartOptions(document.body.classList.contains("light"))
        });
        startBlink();
      } else {
        const hasHistory = chart.data.datasets.some((ds) => ds.label === plants[0].plant_name || ds.label === plants[1]?.plant_name);
        if (hasHistory) {
          datasets.forEach((newDs) => {
            const idx = chart.data.datasets.findIndex((ds) => ds.label === newDs.label);
            if (idx >= 0) {
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
          chart.data.datasets = datasets;
          chart.update("none");
          startBlink();
        }
      }
    } catch (err) {
      // ignore forecast rendering errors
    }
  } catch (err) {
    // ignore; full load will populate everything
  }
}

async function load() {
  try {
    const res = await fetch(`${API_URL}/dashboard?user_id=${currentUser.id}`);
    if (!res.ok) {
      throw new Error("Dashboard request failed");
    }

    const data = await res.json();

    // Update last update time
    lastUpdateTime = new Date();
    updateStatusBar("live");

    const plants = data.plants || [];
    if (!plants.length) {
      const firstSection = document.querySelector(".section");
      if (firstSection) {
        firstSection.innerHTML = `
          <div class="card" style="text-align:center; padding:40px;">
            <h2>No Plants Yet</h2>
            <p>Add a plant to start monitoring moisture.</p>
            <button onclick="openAddPlant()">+ Add Plant</button>
          </div>
        `;
      }
      return;
    }

    // Render plant cards dynamically
    const firstSection = document.querySelector(".section");
    if (!firstSection) return;

    const cardsHtml = plants
      .map((p) => {
        const alias = p.alias;
        const safe = `_${alias}`;
        return `
          <div class="card">
            <div style="display:flex; justify-content:space-between; align-items:center">
              <h3>${p.plant_name}</h3>
              <span id="status_${alias}" class="badge">${"No data yet"}</span>
            </div>
            <div style="font-size:28px; margin-top:8px">Moisture: <span id="value_${alias}">--%</span></div>
            <div style="margin-top:8px">ETA: <span id="eta_${alias}">N/A</span></div>
            <div style="margin-top:8px; font-size:12px; color:#666">Sensors: Light <span id="light_${alias}">-</span> • Temp <span id="temp_${alias}">-</span> • Humidity <span id="humidity_${alias}">-</span></div>
          </div>
        `;
      })
      .join("\n");

    firstSection.innerHTML = cardsHtml;

    // Populate each plant's data
    plants.forEach((p) => {
      const alias = p.alias;
      const latest = data.latest?.[alias] || null;
      const pred = data.prediction?.[alias] || {};
      const decision = data.decision?.[alias] || "No data yet";
      updatePlant(alias, decision, latest?.moisture, pred, latest);
    });

    // Build chart for up to two plants (fallback to first two)
    const chartPlants = plants.slice(0, 2);
    const history0 = data.history?.[chartPlants[0].alias] || [];
    const forecast0 = data.prediction?.[chartPlants[0].alias]?.forecast || [];
    const history1 = chartPlants[1] ? (data.history?.[chartPlants[1].alias] || []) : [];
    const forecast1 = chartPlants[1] ? (data.prediction?.[chartPlants[1].alias]?.forecast || []) : [];

    buildChart(history0, forecast0, history1, forecast1);
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
    statusText.innerText = "Live";
  } else if (status === "stale") {
    statusText.innerText = "Stale";
  } else {
    statusText.innerText = "Offline";
  }

  if (lastUpdateTime) {
    lastUpdatedEl.innerText = `Last updated: ${lastUpdateTime.toLocaleTimeString()}`;
  }
}

// Monitor connection status (mark as stale if no update for 180 seconds)
setInterval(() => {
  if (lastUpdateTime) {
    const secondsAgo = (new Date() - lastUpdateTime) / 1000;
    if (secondsAgo > 180) {
      updateStatusBar("stale");
    }
  }
}, 10000);

function updatePlant(id, status, moisture, pred, sensorData) {
  const suffix = `_${id}`;
  const valueEl = document.getElementById(`value${suffix}`);
  if (valueEl) {
    if (moisture === null || moisture === undefined) {
      valueEl.innerText = "--%";
    } else {
      valueEl.innerText = `${moisture}%`;
    }
  }

  // Update sensor data if available
  const light = sensorData?.light ?? sensorData?.light_intensity;
  const temp = sensorData?.temperature;
  const humidity = sensorData?.humidity;

  if (light !== undefined && !Number.isNaN(Number(light))) {
    const el = document.getElementById(`light${suffix}`);
    if (el) el.innerText = `${Number(light).toFixed(1)} lux`;
  }
  if (temp !== undefined && !Number.isNaN(Number(temp))) {
    const el = document.getElementById(`temp${suffix}`);
    if (el) el.innerText = `${Number(temp).toFixed(1)} °C`;
  }
  if (humidity !== undefined && !Number.isNaN(Number(humidity))) {
    const el = document.getElementById(`humidity${suffix}`);
    if (el) el.innerText = `${Number(humidity).toFixed(1)} %`;
  }

  const badge = document.getElementById(`status_${id}`);
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

  const etaEl = document.getElementById(`eta_${id}`);
  if (etaEl) etaEl.innerText = `${pred.eta_hours?.toFixed(1)} hrs (~${eta})`;
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

  // Round anchor to 6-hour blocks to prevent tiny x-axis shifts every refresh.
  const hourMs = 60 * 60 * 1000;
  const stabilizedAnchorMs = Math.floor(anchorMs / (6 * hourMs)) * (6 * hourMs);

  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  // Find where actual data starts
  const dataPointsWithTime = [
    ...historyDataA,
    ...historyDataB
  ].filter(p => p.x);
  
  const dataStartMs = dataPointsWithTime.length
    ? Math.min(...dataPointsWithTime.map(p => p.x.getTime()))
    : stabilizedAnchorMs - oneWeekMs;

  const desiredMin = stabilizedAnchorMs - oneWeekMs;
  
  // Smart window: show 7 days if data exists, else snap to data start
  const xMin = new Date(Math.max(desiredMin, dataStartMs));
  const xMax = new Date(stabilizedAnchorMs + oneWeekMs);

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
          pointRadius: 5,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          z: 10,
          order: 1
        },
        {
          label: "Plant B Live",
          data: livePointB,
          borderColor: "#f97316",
          backgroundColor: "#f97316",
          showLine: false,
          pointRadius: 5,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          z: 10,
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

  // Update only the data, not the entire dataset structure
  datasets.forEach((newDs, i) => {
    if (chart.data.datasets[i]) {
      chart.data.datasets[i].data = newDs.data;
    }
  });
  chart.update("none");
  startBlink();
}

window.onload = async () => {
  // Check for existing session using Supabase
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    
    if (session) {
      currentUser = session.user;
      showDashboard();

      // Initialize status bar
      updateStatusBar("live");

      fetchSummaryOnly(); // render forecast immediately
      fetchLatestOnly(); // populate UI quickly with minimal payload
      load(); // then load full dashboard (chart etc.)

      // Always enable continuous auto-refresh (no UI toggle)
      autoRefreshEnabled = true;
      setAutoRefresh(true);
    } else {
      showAuthSection();
    }
  } catch (e) {
    console.error("Auth error:", e);
    showAuthSection();
  }

  // Setup theme toggle (only on dashboard)
  try {
    const toggle = document.getElementById("themeToggle");
    if (toggle) {
      // Load saved theme preference (default to light)
      const savedTheme = localStorage.getItem("theme");
      if (!savedTheme) {
        document.body.classList.add("light");
        localStorage.setItem("theme", "light");
        toggle.checked = true;
      } else if (savedTheme === "light") {
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
    }
  } catch (err) {
    // ignore theme toggle errors
  }
};