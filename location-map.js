const MAP_SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const MAP_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const MAP_USERS_TABLE = "app_users";
const MAP_LOCATION_TABLE = "user_locations";
const MAP_LOCATION_HISTORY_TABLE = "user_location_history";
const mapSupabase = window.supabase?.createClient(MAP_SUPABASE_URL, MAP_SUPABASE_ANON_KEY);
const builtInUsers = {
  admin: {
    password: "admin2026",
    role: "admin",
    label: "Admin",
    permissions: { post: true, update: true, exchange: true, viewAllActivity: true, manageUsers: true },
  },
  zaki: {
    password: "zaki2026",
    role: "zaki",
    label: "Zaki",
    permissions: { post: true, update: true, exchange: true, viewAllActivity: false, manageUsers: false },
  },
};
const fallbackUsers = {
  ...builtInUsers,
  ...(window.PAYMENT_TRACKER_USERS || {}),
};

let allowedUsers = fallbackUsers;
let map;
let markers = new Map();
let historyMarkers = [];
let historyLines = [];
let latestRows = [];
let latestLocationRows = [];
let latestHistoryRows = [];
let currentMapUser = null;
let localAdminLocation = null;
let realtimeChannel = null;
let pollTimer = null;
let lastRefreshAt = null;
let historyVisible = true;

const els = {
  login: document.querySelector("#mapLogin"),
  form: document.querySelector("#mapLoginForm"),
  id: document.querySelector("#mapLoginId"),
  password: document.querySelector("#mapLoginPassword"),
  error: document.querySelector("#mapLoginError"),
  shell: document.querySelector("#mapShell"),
  status: document.querySelector("#mapStatus"),
  debug: document.querySelector("#mapDebug"),
  refreshNote: document.querySelector("#mapRefreshNote"),
  list: document.querySelector("#userLocationList"),
  refresh: document.querySelector("#mapRefreshButton"),
  signout: document.querySelector("#mapSignOutButton"),
  historyToggle: document.querySelector("#historyToggleButton"),
};

function setDebug(message) {
  if (els.debug) els.debug.textContent = `v20260503-location-10 - ${message}`;
}

function escapeText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeUser(id, user = {}) {
  return {
    id,
    password: user.password || "",
    role: user.role || "viewer",
    label: user.label || id,
    permissions: user.permissions || {},
  };
}

function usersFromRows(rows = []) {
  return rows.reduce((items, row) => {
    items[row.id] = {
      password: row.password || "",
      role: row.role || "viewer",
      label: row.label || row.id,
      permissions: row.permissions || {},
    };
    return items;
  }, {});
}

async function loadUsers() {
  if (!mapSupabase) {
    allowedUsers = { ...fallbackUsers };
    setDebug(`Supabase unavailable. Loaded ${Object.keys(allowedUsers).length} fallback users.`);
    return;
  }

  const { data, error } = await mapSupabase.from(MAP_USERS_TABLE).select("*").order("id", { ascending: true });
  if (error) {
    console.warn("Map user load skipped:", error.message);
    allowedUsers = { ...fallbackUsers };
    setDebug(`User table blocked. Loaded ${Object.keys(allowedUsers).length} fallback users.`);
    return;
  }

  allowedUsers = {
    ...fallbackUsers,
    ...(data?.length ? usersFromRows(data) : {}),
  };
  setDebug(`Loaded ${Object.keys(allowedUsers).length} users. Location rows pending.`);
}

function isAdmin(user) {
  return user?.role === "admin" || Boolean(user?.permissions?.manageUsers || user?.permissions?.viewAllActivity);
}

function timeAgo(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleString();
}

function fullDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not seen yet";
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function dayStartIso() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function mapsLink(row) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${row.latitude},${row.longitude}`)}`;
}

function initMap() {
  if (map) return;
  if (!window.L) {
    els.status.textContent = "Map tiles are still loading. User list is available below.";
    return;
  }

  map = L.map("locationMap", {
    zoomControl: true,
    attributionControl: true,
  }).setView([33.3152, 44.3661], 12);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(map);
}

function markerIcon(label) {
  const initials = String(label || "?")
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  return L.divIcon({
    html: `<div class="live-marker">${escapeText(initials)}</div>`,
    className: "",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function configuredUserRows(locationRows = []) {
  if (!Object.keys(allowedUsers || {}).length) {
    allowedUsers = { ...fallbackUsers };
  }

  const mergedLocationRows = localAdminLocation ? [localAdminLocation, ...locationRows] : locationRows;
  const rowByUser = new Map(mergedLocationRows.map((row) => [row.user_id, row]));
  const configured = Object.entries(allowedUsers)
    .map(([id, user]) => normalizeUser(id, user))
    .map((user) => ({
      user_id: user.id,
      user_label: user.label,
      user_role: user.role,
      ...(rowByUser.get(user.id) || {}),
    }));

  const extraRows = mergedLocationRows.filter((row) => !configured.some((user) => user.user_id === row.user_id));
  return [...configured, ...extraRows].sort((a, b) => {
    const aTime = new Date(a.updated_at || 0).getTime();
    const bTime = new Date(b.updated_at || 0).getTime();
    return bTime - aTime;
  });
}

async function saveMapUserLocation(row) {
  if (!mapSupabase) return;
  const { error } = await mapSupabase.from(MAP_LOCATION_TABLE).upsert(row, { onConflict: "user_id" });
  if (error) {
    setDebug(`Admin location shown locally. Supabase save blocked: ${error.message}`);
    return;
  }

  const { error: historyError } = await mapSupabase.from(MAP_LOCATION_HISTORY_TABLE).insert({
    ...row,
    recorded_at: row.updated_at,
  });
  if (historyError) setDebug(`Admin location shown. History save blocked: ${historyError.message}`);
}

function requestCurrentAdminLocation() {
  if (!navigator.geolocation || !currentMapUser) {
    setDebug("Admin location unavailable on this browser.");
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (position) => {
      const coords = position.coords || {};
      localAdminLocation = {
        user_id: currentMapUser.id,
        user_label: currentMapUser.label,
        user_role: currentMapUser.role,
        latitude: Number(coords.latitude),
        longitude: Number(coords.longitude),
        accuracy_m: Number.isFinite(coords.accuracy) ? Math.round(coords.accuracy) : null,
        heading: Number.isFinite(coords.heading) ? coords.heading : null,
        speed_mps: Number.isFinite(coords.speed) ? coords.speed : null,
        last_action: "Viewing admin map",
        updated_at: new Date().toISOString(),
      };
      renderLocations(latestLocationRows);
      void saveMapUserLocation(localAdminLocation);
    },
    (error) => {
      setDebug(`Admin location not allowed: ${error.message}`);
      renderLocations(latestLocationRows);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

function hasLocation(row) {
  return Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude));
}

function historyForUser(userId, historyRows = latestHistoryRows) {
  return historyRows
    .filter((row) => row.user_id === userId && hasLocation(row))
    .sort((a, b) => new Date(b.recorded_at || 0).getTime() - new Date(a.recorded_at || 0).getTime());
}

function historyColor(index) {
  const colors = ["#ff3f6d", "#4fdc83", "#63d4ff", "#ffc247", "#c58bff", "#ff8a4c"];
  return colors[index % colors.length];
}

function clearHistoryLayers() {
  if (!map) return;
  historyMarkers.forEach((marker) => map.removeLayer(marker));
  historyLines.forEach((line) => map.removeLayer(line));
  historyMarkers = [];
  historyLines = [];
}

function renderHistoryLayers(historyRows = latestHistoryRows) {
  if (!map) return;
  clearHistoryLayers();
  if (!historyVisible) return;

  const rowsByUser = new Map();
  historyRows.filter(hasLocation).forEach((row) => {
    if (!rowsByUser.has(row.user_id)) rowsByUser.set(row.user_id, []);
    rowsByUser.get(row.user_id).push(row);
  });

  [...rowsByUser.entries()].forEach(([userId, rows], userIndex) => {
    const ordered = rows.sort((a, b) => new Date(a.recorded_at || 0).getTime() - new Date(b.recorded_at || 0).getTime());
    const color = historyColor(userIndex);
    const points = ordered.map((row) => [Number(row.latitude), Number(row.longitude)]);

    if (points.length > 1) {
      const line = L.polyline(points, {
        color,
        weight: 3,
        opacity: 0.58,
        dashArray: "7 8",
      }).addTo(map);
      historyLines.push(line);
    }

    ordered.forEach((row, pointIndex) => {
      const marker = L.circleMarker([Number(row.latitude), Number(row.longitude)], {
        radius: pointIndex === ordered.length - 1 ? 6 : 4,
        color: "#fff",
        weight: 2,
        fillColor: color,
        fillOpacity: 0.88,
      })
        .addTo(map)
        .bindPopup(`
          <strong>${escapeText(row.user_label || userId)}</strong><br />
          ${escapeText(row.last_action || "App opened")}<br />
          ${escapeText(fullDateTime(row.recorded_at))}<br />
          ${row.accuracy_m ? `Accuracy ${escapeText(row.accuracy_m)}m<br />` : ""}
          <a href="${mapsLink(row)}" target="_blank" rel="noreferrer">Open in Maps</a>
        `);
      historyMarkers.push(marker);
    });
  });
}

function renderLocations(rows = [], historyRows = latestHistoryRows) {
  latestLocationRows = rows;
  latestHistoryRows = historyRows;
  latestRows = configuredUserRows(rows);
  const locatedRows = latestRows.filter(hasLocation);
  const historyCount = latestHistoryRows.filter(hasLocation).length;
  lastRefreshAt = new Date();
  setDebug(`Rendered ${latestRows.length} users, ${locatedRows.length} with location, ${historyCount} history points.`);
  els.status.textContent = locatedRows.length
    ? `${locatedRows.length} user${locatedRows.length === 1 ? "" : "s"} reporting location. ${historyCount} app-open/location history point${historyCount === 1 ? "" : "s"} today.`
    : latestRows.length
      ? "No GPS locations yet. Location permission has not been allowed from the app."
      : "No users found. Check app_users or users.js.";
  els.refreshNote.textContent = `Auto-refresh on - Last checked ${fullDateTime(lastRefreshAt)}`;

  els.list.innerHTML = latestRows.length
    ? latestRows
        .map((row) => {
          const located = hasLocation(row);
          const updated = located ? timeAgo(row.updated_at) : "Not seen";
          const lastSeen = located ? fullDateTime(row.updated_at) : "Not seen yet";
          const accuracy = located && row.accuracy_m ? `Accuracy ${row.accuracy_m}m` : "No GPS permission yet";
          const userHistory = historyForUser(row.user_id, latestHistoryRows).slice(0, 5);
          const historyHtml = userHistory.length
            ? `<div class="history-list">
                ${userHistory
                  .map(
                    (point, index) => `
                      <div class="history-point">
                        <b>${index + 1}</b>
                        <span>${escapeText(fullDateTime(point.recorded_at))}<br />${escapeText(point.last_action || "App opened")}</span>
                      </div>
                    `,
                  )
                  .join("")}
              </div>`
            : "";
          return `
            <article class="user-card ${located ? "" : "not-seen"}">
              <div class="user-card-top">
                <strong>${escapeText(row.user_label || row.user_id)}</strong>
                <b class="${located ? "" : "offline"}">${escapeText(updated)}</b>
              </div>
              <span>Last seen: ${escapeText(lastSeen)}</span>
              <span>${escapeText(row.last_action || "Waiting for location")} - ${escapeText(accuracy)}</span>
              ${located ? `<span>${Number(row.latitude).toFixed(5)}, ${Number(row.longitude).toFixed(5)}</span>` : ""}
              ${historyHtml}
              <div class="user-card-actions ${located ? "" : "single"}">
                ${
                  located
                    ? `<button class="center-user" type="button" data-user-id="${escapeText(row.user_id)}">Center</button>
                       <a class="map-link" href="${mapsLink(row)}" target="_blank" rel="noreferrer">Maps</a>`
                    : `<button class="center-user" type="button" disabled>No location yet</button>`
                }
              </div>
            </article>
          `;
        })
        .join("")
    : "";

  const bounds = [];
  if (!map) return;

  locatedRows.forEach((row) => {
    const latLng = [Number(row.latitude), Number(row.longitude)];
    if (!Number.isFinite(latLng[0]) || !Number.isFinite(latLng[1])) return;

    bounds.push(latLng);
    const popup = `
      <strong>${escapeText(row.user_label || row.user_id)}</strong><br />
      ${escapeText(row.last_action || "App active")}<br />
      Updated ${escapeText(timeAgo(row.updated_at))}<br />
      <a href="${mapsLink(row)}" target="_blank" rel="noreferrer">Open in Maps</a>
    `;

    if (markers.has(row.user_id)) {
      markers.get(row.user_id).setLatLng(latLng).setIcon(markerIcon(row.user_label || row.user_id)).bindPopup(popup);
    } else {
      markers.set(row.user_id, L.marker(latLng, { icon: markerIcon(row.user_label || row.user_id) }).addTo(map).bindPopup(popup));
    }
  });

  [...markers.keys()].forEach((userId) => {
    if (!locatedRows.some((row) => row.user_id === userId)) {
      map.removeLayer(markers.get(userId));
      markers.delete(userId);
    }
  });

  renderHistoryLayers(latestHistoryRows);

  if (bounds.length && !map._paymentTrackerCentered) {
    map.fitBounds(bounds, { padding: [45, 45], maxZoom: 16 });
    map._paymentTrackerCentered = true;
  }
}

async function loadLocations() {
  if (!mapSupabase) {
    renderLocations([]);
    return;
  }

  await loadUsers();
  const { data, error } = await mapSupabase
    .from(MAP_LOCATION_TABLE)
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    els.status.textContent = `Location table not ready: ${error.message}`;
    setDebug(`Location table error: ${error.message}`);
    renderLocations([]);
    return;
  }

  const { data: historyData, error: historyError } = await mapSupabase
    .from(MAP_LOCATION_HISTORY_TABLE)
    .select("*")
    .gte("recorded_at", dayStartIso())
    .order("recorded_at", { ascending: false })
    .limit(300);

  if (historyError) {
    setDebug(`History table error: ${historyError.message}`);
    renderLocations(data || [], []);
    return;
  }

  renderLocations(data || [], historyData || []);
}

function subscribeLocations() {
  if (!mapSupabase || realtimeChannel) return;
  realtimeChannel = mapSupabase
    .channel("admin-live-user-locations")
    .on("postgres_changes", { event: "*", schema: "public", table: MAP_LOCATION_TABLE }, () => {
      void loadLocations();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: MAP_LOCATION_HISTORY_TABLE }, () => {
      void loadLocations();
    })
    .subscribe();
}

function openAdminMap() {
  els.login.hidden = true;
  els.shell.hidden = false;
  renderLocations([]);
  initMap();
  window.setTimeout(() => map?.invalidateSize(), 0);
  requestCurrentAdminLocation();
  void loadLocations();
  subscribeLocations();
  pollTimer = window.setInterval(loadLocations, 5000);
}

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadUsers();
  const id = els.id.value.trim().toLowerCase();
  const user = allowedUsers[id] ? normalizeUser(id, allowedUsers[id]) : null;
  if (!user || user.password !== els.password.value || !isAdmin(user)) {
    els.error.hidden = false;
    els.password.value = "";
    return;
  }

  els.error.hidden = true;
  els.password.value = "";
  currentMapUser = user;
  openAdminMap();
});

els.refresh.addEventListener("click", () => void loadLocations());

els.historyToggle?.addEventListener("click", () => {
  historyVisible = !historyVisible;
  els.historyToggle.textContent = historyVisible ? "Hide History" : "Show History";
  renderLocations(latestLocationRows, latestHistoryRows);
});

els.list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-id]");
  if (!button || !map) return;
  const row = latestRows.find((item) => item.user_id === button.dataset.userId);
  if (!row) return;
  map.setView([Number(row.latitude), Number(row.longitude)], 17, { animate: true });
  markers.get(row.user_id)?.openPopup();
});

els.signout.addEventListener("click", () => {
  if (pollTimer) window.clearInterval(pollTimer);
  pollTimer = null;
  realtimeChannel?.unsubscribe();
  realtimeChannel = null;
  els.shell.hidden = true;
  els.login.hidden = false;
  currentMapUser = null;
  localAdminLocation = null;
  els.id.value = "";
  els.password.value = "";
  els.id.focus();
});

void loadUsers();

