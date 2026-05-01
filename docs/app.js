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
const STALE_READING_SECONDS = 180;
// blinking control for fresh latest-reading indicators
let blinkInterval = null;
let blinkOn = true;
// track last seen per-plant timestamps from /dashboard/latest
let lastSeenTimestamp = {};
let originalDashboardMarkup = null;
let aliasToIndex = {};

// ============ ADMIN SETUP ============
const ADMIN_EMAILS = ["grader@test.com"];
let isAdmin = false;
let selectedUserId = null;  // when admin selects a different user
let allUsers = [];          // cache of all users for dropdown

// ============ AUTH FUNCTIONS ============

function getActiveUserId() {
  // If admin has selected a different user, use that; otherwise use current user
  return selectedUserId || currentUser.id;
}

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
    isAdmin = ADMIN_EMAILS.includes(currentUser.email);
    selectedUserId = null;  // reset selection
    
    // Auto-sync user to users table
    try {
      await supabaseClient
        .from('users')
        .upsert({
          id: currentUser.id,
          email: currentUser.email
        });
    } catch (err) {
      console.error("Failed to sync user:", err);
    }
    
    // If admin, fetch all users for dropdown
    if (isAdmin) {
      try {
        allUsers = await fetchAllUsers();
      } catch (err) {
        console.error("Failed to fetch users:", err);
      }
    }
    
    showDashboard();
    showAdminControls();
    
    // Initialize dashboard on login
    updateStatusBar("live");
    
    try {
      await fetchLatestOnly();
      // Start full dashboard load in background (don't block UI)
      load();
    } catch (err) {
      console.error("Initialization failed:", err);
    }
    
    // Enable auto-refresh
    autoRefreshEnabled = true;
    setAutoRefresh(true);
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
    isAdmin = ADMIN_EMAILS.includes(currentUser.email);
    selectedUserId = null;  // reset selection
    
    // Auto-sync user to users table
    try {
      await supabaseClient
        .from('users')
        .upsert({
          id: currentUser.id,
          email: currentUser.email
        });
    } catch (err) {
      console.error("Failed to sync user:", err);
    }
    
    // If admin, fetch all users for dropdown
    if (isAdmin) {
      try {
        allUsers = await fetchAllUsers();
      } catch (err) {
        console.error("Failed to fetch users:", err);
      }
    }
    
    showDashboard();
    showAdminControls();
    
    // Initialize dashboard on signup
    updateStatusBar("live");
    
    try {
      await fetchLatestOnly();
      load();
    } catch (err) {
      console.error("Initialization failed:", err);
    }
    
    // Enable auto-refresh
    autoRefreshEnabled = true;
    setAutoRefresh(true);
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
  document.getElementById("authSection").style.display = "flex";
  document.querySelector(".container").style.display = "none";
  document.querySelector(".status-bar").style.display = "none";
}

function showDashboard() {
  document.getElementById("authSection").style.display = "none";
  document.querySelector(".container").style.display = "block";
  document.querySelector(".status-bar").style.display = "flex";
  document.getElementById("userEmail").textContent = currentUser.email;
  // Hide admin controls by default
  const adminControls = document.getElementById("adminControls");
  if (adminControls) adminControls.style.display = "none";
}

function createPlantCard(plant, index) {
  return `
    <div class="card">
      <h3>${plant.plant_name}</h3>
      <div class="sensor-grid">
        <div class="sensor-item">
          <div class="sensor-label">Moisture</div>
          <div class="value" id="value${index}">--%</div>
        </div>
        <div class="sensor-item">
          <div class="sensor-label">Light</div>
          <div class="sensor-value" id="light${index}">-- lux</div>
        </div>
        <div class="sensor-item">
          <div class="sensor-label">Temp</div>
          <div class="sensor-value" id="temp${index}">-- °C</div>
        </div>
        <div class="sensor-item">
          <div class="sensor-label">Humidity</div>
          <div class="sensor-value" id="humidity${index}">-- %</div>
        </div>
      </div>
      <div class="badge" id="status${index}">--</div>
      <div class="meta" id="eta${index}"></div>
    </div>
  `;
}

function applyThemeFromStorage() {
  const toggle = document.getElementById("themeToggle");
  const savedTheme = localStorage.getItem("theme");

  if (!savedTheme || savedTheme === "light") {
    document.body.classList.add("light");
    localStorage.setItem("theme", "light");
    if (toggle) toggle.checked = true;
  } else {
    document.body.classList.remove("light");
    if (toggle) toggle.checked = false;
  }

  if (toggle && !toggle.dataset.bound) {
    toggle.dataset.bound = "true";
    toggle.addEventListener("change", () => {
      document.body.classList.toggle("light", toggle.checked);
      localStorage.setItem("theme", toggle.checked ? "light" : "dark");

      if (chart) {
        chart.options = createChartOptions(document.body.classList.contains("light"));
        chart.update("none");
      }
    });
  }
}

function togglePlantForm() {
  const form = document.getElementById("addPlantForm");
  form.style.display = form.style.display === "none" ? "block" : "none";
  if (form.style.display === "block") {
    document.getElementById("newPlantName").focus();
  }
}

async function submitPlant() {
  const name = document.getElementById("newPlantName").value;
  const type = document.getElementById("newPlantType").value;

  if (!name) {
    showAuthError("Please enter a plant name");
    return;
  }

  try {
    const res = await fetch(`${API_URL}/plants/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: getActiveUserId(),
        plant_name: name,
        plant_type: type,
      }),
    });

    if (!res.ok) {
      throw new Error("Failed to create plant");
    }

    document.getElementById("newPlantName").value = "";
    document.getElementById("newPlantType").value = "";
    togglePlantForm();
    load();
  } catch (err) {
    showAuthError(err.message || "Could not create plant");
  }
}

// ============ END AUTH FUNCTIONS ============

// Poll /dashboard/latest and only call full `load()` when timestamps change.
async function pollLatestForChanges() {
  try {
    const activeUserId = getActiveUserId();
    const res = await fetch(`${API_URL}/dashboard/latest?user_id=${activeUserId}`);
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
      if (ds.label && ds.label.includes("Latest Reading") && getReadingStatus() === "live") {
        ds.pointRadius = blinkOn ? 6 : 4;
      } else if (ds.label && ds.label.includes("Latest Reading")) {
        ds.pointRadius = 5;
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
          filter: (item) => !item.text.includes(" Latest Reading")
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

function getNewestPlantReadingTime(latestMap) {
  let newest = null;

  Object.values(latestMap || {}).forEach((reading) => {
    if (!reading?.timestamp) return;
    const timestamp = new Date(reading.timestamp);
    if (Number.isNaN(timestamp.getTime())) return;
    if (!newest || timestamp > newest) {
      newest = timestamp;
    }
  });

  return newest;
}

function getReadingStatus() {
  if (!lastUpdateTime) return "offline";

  const secondsAgo = (new Date() - lastUpdateTime) / 1000;
  return secondsAgo > STALE_READING_SECONDS ? "stale" : "live";
}

function updateLastPlantReadingTime(latestMap) {
  lastUpdateTime = getNewestPlantReadingTime(latestMap);
  updateStatusBar(getReadingStatus());
}

function buildForecastText(plants, prediction) {
  const forecastLines = (plants || [])
    .map((plant) => {
      const pred = prediction?.[plant.alias];
      const etaHours = pred?.eta_hours;
      if (typeof etaHours !== "number" || Number.isNaN(etaHours)) return null;
      return `${plant.plant_name}: ~${etaHours.toFixed(1)} hours until dry`;
    })
    .filter(Boolean);

  return forecastLines.length
    ? forecastLines.join("\n")
    : "No forecast available yet.";
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

// ============ ADMIN HELPERS ============

async function fetchAllUsers() {
  try {
    // Fetch all users from the users table
    const { data, error } = await supabaseClient
      .from('users')
      .select('id, email');
    if (error) throw error;
    return data || [];
  } catch (err) {
    console.error("Failed to fetch users:", err);
    return [];
  }
}

async function onAdminUserSelect(event) {
  const userId = event.target.value;
  if (!userId) {
    selectedUserId = null;
  } else {
    selectedUserId = userId;
  }
  
  // Clear state to prevent plant card mixing
  aliasToIndex = {};
  lastSeenTimestamp = {};
  const cardsContainer = document.getElementById("plantCards");
  if (cardsContainer) {
    cardsContainer.innerHTML = "";
  }
  
  // Reload dashboard for selected user
  await fetchLatestOnly();
  await load();
}

function toggleAdminPanel() {
  const panel = document.getElementById("adminPanel");
  if (!panel) return;
  
  const isNowVisible = panel.style.display === "none";
  panel.style.display = isNowVisible ? "block" : "none";
  
  // Populate plant lists when opening the panel
  if (isNowVisible) {
    populateAdminPlantList();
    populateAssignPlantDropdown();
    populateAssignUserDropdown();
  }
}

async function populateAdminPlantList() {
  try {
    // Fetch all plants for deletion listing
    const { data, error } = await supabaseClient
      .from('plants')
      .select('id, plant_name, user_id, is_protected');
    
    if (error) throw error;
    
    const plantList = document.getElementById("adminPlantList");
    if (!plantList) return;
    
    if (!data || data.length === 0) {
      plantList.innerHTML = "<p style='color: var(--subtext); font-size: 11px;'>No plants yet</p>";
      return;
    }
    
    // Build plant list with delete buttons
    plantList.innerHTML = "";
    data.forEach((plant) => {
      const isProtected = plant.is_protected || false;
      const item = document.createElement("div");
      item.style.cssText = "display: flex; justify-content: space-between; align-items: center; padding: 8px; background: rgba(255,255,255,0.05); border-radius: 4px; margin-bottom: 6px; font-size: 11px;";
      
      // Render plant name with lock icon if protected
      const nameHtml = isProtected 
        ? `<span>${plant.plant_name} 🔒</span>`
        : `<span>${plant.plant_name}</span>`;
      
      // Render delete button - disabled if protected
      const deleteBtn = isProtected
        ? `<button disabled style="padding: 4px 8px; background: #9ca3af; color: white; border: none; border-radius: 3px; cursor: not-allowed; font-size: 10px; opacity: 0.6;">Delete</button>`
        : `<button onclick="adminDeletePlant('${plant.id}')" style="padding: 4px 8px; background: #ef4444; color: white; border: none; border-radius: 3px; cursor: pointer; font-size: 10px;">Delete</button>`;
      
      item.innerHTML = nameHtml + deleteBtn;
      plantList.appendChild(item);
    });
  } catch (err) {
    console.error("Failed to populate plant list:", err);
  }
}

async function populateUserDropdown() {
  const select = document.getElementById("userSelect");
  if (!select) return;
  
  // Clear existing options except the default
  while (select.options.length > 1) {
    select.remove(1);
  }
  
  // Add all users
  if (allUsers && allUsers.length > 0) {
    allUsers.forEach((user) => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = user.email;
      select.appendChild(option);
    });
  }
}

async function adminCreatePlant() {
  const name = document.getElementById("adminPlantName").value;
  const type = document.getElementById("adminPlantType").value;
  
  if (!name) {
    alert("Plant name required");
    return;
  }
  
  try {
    const res = await fetch(`${API_URL}/plants/create`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: getActiveUserId(),
        plant_name: name,
        plant_type: type,
      }),
    });
    
    if (!res.ok) throw new Error("Failed to create plant");
    
    document.getElementById("adminPlantName").value = "";
    document.getElementById("adminPlantType").value = "";
    
    // Refresh plant lists in admin panel
    populateAdminPlantList();
    populateAssignPlantDropdown();
    
    await fetchLatestOnly();
    load();
  } catch (err) {
    alert("Error creating plant: " + err.message);
  }
}

async function adminDeletePlant(plantId) {
  if (!confirm("Delete this plant?")) return;
  
  try {
    const res = await fetch(`${API_URL}/plants/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plant_id: plantId }),
    });
    
    if (!res.ok) throw new Error("Failed to delete plant");
    
    // Refresh plant lists in admin panel
    populateAdminPlantList();
    populateAssignPlantDropdown();
    
    await fetchLatestOnly();
    load();
  } catch (err) {
    alert("Error deleting plant: " + err.message);
  }
}

async function populateAssignPlantDropdown() {
  try {
    // Fetch all plants to allow assignment
    const { data, error } = await supabaseClient
      .from('plants')
      .select('id, plant_name, user_id');
    
    if (error) throw error;
    
    const plantSelect = document.getElementById("assignPlantSelect");
    if (!plantSelect) return;
    
    // Clear existing options except the default
    while (plantSelect.options.length > 1) {
      plantSelect.remove(1);
    }
    
    // Populate with all plants
    if (data && data.length > 0) {
      data.forEach((plant) => {
        const option = document.createElement("option");
        option.value = plant.id;
        option.textContent = plant.plant_name;
        plantSelect.appendChild(option);
      });
    }
  } catch (err) {
    console.error("Failed to populate plants dropdown:", err);
  }
}

async function populateAssignUserDropdown() {
  const userSelect = document.getElementById("assignUserSelect");
  if (!userSelect) return;
  
  // Clear existing options except the default
  while (userSelect.options.length > 1) {
    userSelect.remove(1);
  }
  
  // Populate with all users
  if (allUsers && allUsers.length > 0) {
    allUsers.forEach((user) => {
      const option = document.createElement("option");
      option.value = user.id;
      option.textContent = user.email;
      userSelect.appendChild(option);
    });
  }
}

async function adminAssignPlant() {
  const plantId = document.getElementById("assignPlantSelect").value;
  const userId = document.getElementById("assignUserSelect").value;
  
  if (!plantId || !userId) {
    alert("Please select both a plant and a user");
    return;
  }
  
  try {
    // Try backend endpoint first
    const res = await fetch(`${API_URL}/plants/assign`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        plant_id: plantId,
        user_id: userId
      }),
    });
    
    if (res.ok) {
      // Reset dropdowns
      document.getElementById("assignPlantSelect").value = "";
      document.getElementById("assignUserSelect").value = "";
      
      // Refresh plant lists in admin panel
      populateAdminPlantList();
      populateAssignPlantDropdown();
      
      await fetchLatestOnly();
      load();
    } else {
      throw new Error("Failed to assign plant");
    }
  } catch (err) {
    alert("Error assigning plant: " + err.message);
  }
}

function showAdminControls() {
  const adminControls = document.getElementById("adminControls");
  const addPlantBtn = document.getElementById("addPlantButtonContainer");
  
  if (adminControls && isAdmin) {
    adminControls.style.display = "flex";
    populateUserDropdown();
    populateAssignPlantDropdown();
    populateAssignUserDropdown();
    
    // Hide the add plant button in admin mode
    if (addPlantBtn) {
      addPlantBtn.style.display = "none";
    }
  } else {
    // Show add plant button in normal user mode
    if (addPlantBtn) {
      addPlantBtn.style.display = "block";
    }
  }
}

// ============ FETCH FUNCTIONS ============

// Fetch only the latest small payload to populate UI immediately
async function fetchLatestOnly() {
  try {
    const activeUserId = getActiveUserId();
    // Ensure the UI shell exists: fetch plants metadata (lightweight)
    const plantsRes = await fetch(`${API_URL}/dashboard/plants?user_id=${activeUserId}`);
    if (!plantsRes.ok) return;
    const plantsData = await plantsRes.json();
    const plants = plantsData.plants || [];

    const cardsContainer = document.getElementById("plantCards");
    // If cards are missing or count differs, build the UI shell immediately
    if (!cardsContainer || cardsContainer.children.length !== plants.length) {
      cardsContainer.innerHTML = "";
      aliasToIndex = {};
      plants.forEach((p, idx) => {
        cardsContainer.innerHTML += createPlantCard(p, idx);
        aliasToIndex[p.alias] = idx;
      });
    }

    // Now fetch latest small payload and populate values
    const res = await fetch(`${API_URL}/dashboard/latest?user_id=${activeUserId}`);
    if (!res.ok) return;
    const data = await res.json();
    const latestMap = data.latest || {};

    Object.keys(latestMap).forEach((alias) => {
      const latest = latestMap[alias];
      const idx = aliasToIndex[alias];
      if (idx === undefined) return;

      const valueEl = document.getElementById(`value${idx}`);
      if (valueEl) {
        valueEl.innerText = latest && latest.moisture != null ? `${latest.moisture}%` : "--%";
      }
    });

    // Fetch global environment readings and populate env fields on each card
    try {
      const envRes = await fetch(`${API_URL}/dashboard/env?user_id=${activeUserId}`);
      if (envRes && envRes.ok) {
        const envData = await envRes.json();
        const env = envData.env || {};
        Object.keys(latestMap).forEach((alias) => {
          const idx = aliasToIndex[alias];
          if (idx === undefined) return;
          if (env.temperature !== undefined && env.temperature !== null) {
            const el = document.getElementById(`temp${idx}`);
            if (el) el.innerText = `${Number(env.temperature).toFixed(1)} °C`;
          }
          if (env.humidity !== undefined && env.humidity !== null) {
            const el = document.getElementById(`humidity${idx}`);
            if (el) el.innerText = `${Number(env.humidity).toFixed(1)} %`;
          }
          if (env.light !== undefined && env.light !== null) {
            const el = document.getElementById(`light${idx}`);
            if (el) el.innerText = `${Number(env.light).toFixed(1)} lux`;
          }
        });
      }
    } catch (err) {
      // ignore env fetch errors; frontend can continue without env
    }

    updateLastPlantReadingTime(latestMap);
  } catch (err) {
    // ignore lightweight failures; full load() will handle errors
  }
}

// Fetch prediction summary (latest + forecast) so we can render dotted forecast lines
// immediately while full history loads in background.
async function fetchSummaryOnly() {
  try {
    const activeUserId = getActiveUserId();
    const res = await fetch(`${API_URL}/dashboard/summary?user_id=${activeUserId}`);
    if (!res.ok) return;
    const data = await res.json();
    const plants = data.plants || [];
    if (plants.length === 0) return;

    document.getElementById("forecastText").innerText = buildForecastText(plants, data.prediction);
    updateLastPlantReadingTime(data.latest || {});

    try {
      const colors = ["#3b82f6", "#f97316", "#8b5cf6", "#10b981", "#ec4899", "#f59e0b"];
      const datasets = [];

      plants.forEach((plant, index) => {
        const color = colors[index % colors.length];
        const pred = data.prediction?.[plant.alias];
        const latest = data.latest?.[plant.alias];
        const futureOnly = (pred?.forecast || []).map((p) => ({ x: new Date(p.t), y: p.value }));
        const livePoint = latest && latest.timestamp
          ? [{ x: new Date(latest.timestamp), y: latest.moisture }]
          : [];
        const forecastData = livePoint.length
          ? [{ x: livePoint[0].x, y: null }, ...futureOnly]
          : futureOnly;

        datasets.push({
          label: `${plant.plant_name} Forecast`,
          data: forecastData,
          borderColor: color,
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
        });

        datasets.push({
          label: `${plant.plant_name} Latest Reading`,
          data: livePoint,
          borderColor: color,
          backgroundColor: color,
          showLine: false,
          pointRadius: 5,
          pointHoverRadius: 4,
          pointHitRadius: 8,
          pointStyle: "circle",
          pointBorderColor: "#ffffff",
          pointBorderWidth: 2,
          z: 10,
          order: 1
        });
      });

      datasets.push({
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
      });

      if (!chart) {
        const ctx = document.getElementById("chart").getContext("2d");
        chart = new Chart(ctx, {
          type: "line",
          data: { datasets },
          options: createChartOptions(document.body.classList.contains("light"))
        });
        startBlink();
      } else {
        const plantNames = new Set(plants.map((plant) => plant.plant_name));
        const hasHistory = chart.data.datasets.some((ds) => plantNames.has(ds.label));
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
    const activeUserId = getActiveUserId();
    const res = await fetch(`${API_URL}/dashboard?user_id=${activeUserId}`);
    
    if (!res.ok) {
      throw new Error("Dashboard request failed");
    }

    const data = await res.json();

    const plants = data.plants || [];
    if (!plants.length) {
      lastUpdateTime = null;
      updateStatusBar("offline");
      const cardsContainer = document.getElementById("plantCards");
      cardsContainer.innerHTML = `
        <div class="card" style="text-align:center; padding:40px;">
          <h2>No Plants Yet</h2>
          <p>Add a plant to start monitoring moisture.</p>
        </div>
      `;
      document.querySelector("#chart").parentElement.style.display = "none";
      document.getElementById("forecastText").innerText = "";
      return;
    }

    updateLastPlantReadingTime(data.latest || {});

    // If plants exist but readings are still missing, keep rendering the dashboard.
    const hasAnyData = Object.values(data.latest || {}).some((v) => {
      return v && v.moisture != null;
    });
    
    if (!hasAnyData) {
      document.querySelector("#chart").parentElement.style.display = "none";
      document.getElementById("forecastText").innerText = "";
    } else {
      document.querySelector("#chart").parentElement.style.display = "block";
    }

    const cardsContainer = document.getElementById("plantCards");
    const existingCardCount = cardsContainer.children.length;
    const shouldRebuildCards = existingCardCount !== plants.length;

    if (shouldRebuildCards) {
      cardsContainer.innerHTML = "";
      aliasToIndex = {};
      plants.forEach((plant, index) => {
        cardsContainer.innerHTML += createPlantCard(plant, index);
        aliasToIndex[plant.alias] = index;
      });
    }

    plants.forEach((plant, index) => {
      const idx = aliasToIndex[plant.alias] !== undefined ? aliasToIndex[plant.alias] : index;
      const latest = data.latest?.[plant.alias] || null;
      const pred = data.prediction?.[plant.alias] || {};
      const decision = data.decision?.[plant.alias] || "No data yet";

      updatePlant(idx, decision, latest?.moisture, pred, latest);
    });

    document.getElementById("forecastText").innerText = buildForecastText(plants, data.prediction);

    // Re-apply environment values after full load so cards do not flicker back to '--'
    try {
      const activeUserId = getActiveUserId();
      const envRes = await fetch(`${API_URL}/dashboard/env?user_id=${activeUserId}`);
      if (envRes && envRes.ok) {
        const envData = await envRes.json();
        const env = envData.env || {};
        plants.forEach((plant, index) => {
          const idx = aliasToIndex[plant.alias] !== undefined ? aliasToIndex[plant.alias] : index;
          if (env.temperature !== undefined && env.temperature !== null) {
            const el = document.getElementById(`temp${idx}`);
            if (el) el.innerText = `${Number(env.temperature).toFixed(1)} °C`;
          }
          if (env.humidity !== undefined && env.humidity !== null) {
            const el = document.getElementById(`humidity${idx}`);
            if (el) el.innerText = `${Number(env.humidity).toFixed(1)} %`;
          }
          if (env.light !== undefined && env.light !== null) {
            const el = document.getElementById(`light${idx}`);
            if (el) el.innerText = `${Number(env.light).toFixed(1)} lux`;
          }
        });
      }
    } catch (err) {
      // ignore env refresh errors
    }

    if (hasAnyData) {
      buildChart(plants, data);
    }
  } catch (error) {
    console.error("Dashboard partial error:", error);
  }
}

function updateStatusBar(status) {
  const indicator = document.getElementById("statusIndicator");
  const statusText = document.getElementById("statusText");
  const lastUpdatedEl = document.getElementById("lastUpdated");
  const displayStatus = status === "live" ? getReadingStatus() : status;

  indicator.className = `indicator-dot ${displayStatus}`;

  if (displayStatus === "live") {
    statusText.innerText = "Live";
  } else if (displayStatus === "stale") {
    statusText.innerText = "Stale";
  } else {
    statusText.innerText = "Offline";
  }

  if (lastUpdateTime) {
    lastUpdatedEl.innerText = `Last plant reading: ${lastUpdateTime.toLocaleString()}`;
  } else {
    lastUpdatedEl.innerText = "Last plant reading: --";
  }
}

// Monitor connection status (mark as stale if no update for 180 seconds)
setInterval(() => {
  updateStatusBar(getReadingStatus());
}, 10000);

function updatePlant(index, status, moisture, pred, sensorData) {
  // Early exit if no data at all
  if (!sensorData || moisture == null) {
    const badge = document.getElementById(`status${index}`);
    const etaEl = document.getElementById(`eta${index}`);

    badge.innerText = "No Data Yet";
    badge.className = "badge critical";

    if (etaEl) {
      etaEl.innerText = "Connect ESP32 to start receiving data";
    }

    return;
  }

  const valueEl = document.getElementById(`value${index}`);
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
    const el = document.getElementById(`light${index}`);
    if (el) el.innerText = `${Number(light).toFixed(1)} lux`;
  }
  if (temp !== undefined && !Number.isNaN(Number(temp))) {
    const el = document.getElementById(`temp${index}`);
    if (el) el.innerText = `${Number(temp).toFixed(1)} °C`;
  }
  if (humidity !== undefined && !Number.isNaN(Number(humidity))) {
    const el = document.getElementById(`humidity${index}`);
    if (el) el.innerText = `${Number(humidity).toFixed(1)} %`;
  }

  const badge = document.getElementById(`status${index}`);
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
  const etaText = typeof pred.eta_hours === "number" && !Number.isNaN(pred.eta_hours)
    ? `${pred.eta_hours.toFixed(1)} hrs (~${eta})`
    : "Forecast unavailable";
  const readingTime = sensorData?.timestamp
    ? new Date(sensorData.timestamp).toLocaleString()
    : "--";

  const etaEl = document.getElementById(`eta${index}`);
  if (etaEl) etaEl.innerText = `${etaText}\nLast reading: ${readingTime}`;
}

function buildChart(plants, data) {
  const isLight = document.body.classList.contains("light");
  const ctx = document.getElementById("chart").getContext("2d");

  const colors = ["#3b82f6", "#f97316", "#8b5cf6", "#10b981", "#ec4899", "#f59e0b"];
  const datasets = [];
  const allPoints = [];

  // Build datasets for each plant
  plants.forEach((plant, idx) => {
    const color = colors[idx % colors.length];
    const history = (data.history?.[plant.alias] || []).map((p) => ({
      x: new Date(p.t),
      y: p.value
    }));
    const forecast = (data.prediction?.[plant.alias]?.forecast || []).map((p) => ({
      x: new Date(p.t),
      y: p.value
    }));

    // Forecast starts from last observed point for seamless continuation
    const forecastData = history.length
      ? [{ x: history[history.length - 1].x, y: null }, ...forecast]
      : forecast;

    // Latest reading point is the last observed data point
    const livePoint = history.length ? [history[history.length - 1]] : [];

    allPoints.push(...history, ...forecastData, ...livePoint);

    // History dataset
    datasets.push({
      label: plant.plant_name,
      data: history,
      borderColor: color,
      borderWidth: 2,
      fill: false,
      tension: 0,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 8,
      pointBackgroundColor: color,
      order: 2,
      spanGaps: false,
      parsing: true
    });

    // Latest reading point dataset
    datasets.push({
      label: `${plant.plant_name} Latest Reading`,
      data: livePoint,
      borderColor: color,
      backgroundColor: color,
      showLine: false,
      pointRadius: 5,
      pointHoverRadius: 4,
      pointHitRadius: 8,
      pointStyle: "circle",
      pointBorderColor: "#ffffff",
      pointBorderWidth: 2,
      z: 10,
      order: 1
    });

    // Forecast dataset
    datasets.push({
      label: `${plant.plant_name} Forecast`,
      data: forecastData,
      borderColor: color,
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
    });
  });

  // Build time domain - simple 7-day window
  const now = Date.now();
  const oneWeekMs = 7 * 24 * 60 * 60 * 1000;

  const xMin = new Date(now - oneWeekMs);
  const xMax = new Date(now + oneWeekMs);

  // Add threshold line
  datasets.push({
    label: "Threshold (40%)",
    data: [
      { x: xMin, y: 40 },
      { x: xMax, y: 40 }
    ],
    borderColor: "red",
    borderDash: [5, 5],
    borderWidth: 2,
    fill: false,
    pointRadius: 0,
    pointHoverRadius: 0,
    tension: 0,
    order: 4
  });

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

  // Rebuild chart completely for dynamic plant count changes
  chart.data.datasets = datasets;
  chart.options = chartOptions;
  chart.update("none");
  startBlink();
}

window.onload = async () => {
  // Apply theme before any dashboard rendering so the first chart paint is correct.
  try {
    applyThemeFromStorage();
  } catch (err) {
    // ignore theme bootstrap errors
  }

  // Check for existing session using Supabase
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    
    // If no session but user is already set (e.g., from previous login before refresh), skip re-auth
    if (session) {
      currentUser = session.user;
      // Restore admin status after session recovery
      isAdmin = ADMIN_EMAILS.includes(currentUser.email);
      selectedUserId = null;  // reset selection
      
      // If admin, fetch all users for dropdown
      if (isAdmin) {
        try {
          allUsers = await fetchAllUsers();
        } catch (err) {
          console.error("Failed to fetch users:", err);
        }
      }
    } else if (currentUser) {
      // currentUser already set
    } else {
      showAuthSection();
      return;
    }
    
    // At this point, currentUser should be set
    showDashboard();
    showAdminControls();

    // Show loading indicator
    const cardsContainer = document.getElementById("plantCards");
    cardsContainer.innerHTML = '<div style="padding: 40px; text-align: center;">Loading plants...</div>';

    // Initialize status bar
    updateStatusBar("live");

    // Fetch lightweight latest data first for instant UI response
    try {
      await fetchLatestOnly();
    } catch (err) {
      console.error("fetchLatestOnly failed:", err);
    }
    
    // Start full dashboard load in background so UI remains responsive
    try {
      load();
    } catch (err) {
      console.error("load() failed:", err);
    }
    
    
    // Always enable continuous auto-refresh (no UI toggle)
    autoRefreshEnabled = true;
    setAutoRefresh(true);
  } catch (e) {
    console.error("Auth error:", e);
    showAuthSection();
  }
};
