const MAP_SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const MAP_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const MAP_USERS_TABLE = "app_users";
const MAP_LOCATION_TABLE = "user_locations";
const mapSupabase = window.supabase?.createClient(MAP_SUPABASE_URL, MAP_SUPABASE_ANON_KEY);
const fallbackUsers = window.PAYMENT_TRACKER_USERS || {};

let allowedUsers = fallbackUsers;
let map;
let markers = new Map();
let latestRows = [];
let realtimeChannel = null;
let pollTimer = null;
let lastRefreshAt = null;

const els = {
  login: document.querySelector("#mapLogin"),
  form: document.querySelector("#mapLoginForm"),
  id: document.querySelector("#mapLoginId"),
  password: document.querySelector("#mapLoginPassword"),
  error: document.querySelector("#mapLoginError"),
  shell: document.querySelector("#mapShell"),
  status: document.querySelector("#mapStatus"),
  refreshNote: document.querySelector("#mapRefreshNote"),
  list: document.querySelector("#userLocationList"),
  refresh: document.querySelector("#mapRefreshButton"),
  signout: document.querySelector("#mapSignOutButton"),
};

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
  if (!mapSupabase) return;
  const { data, error } = await mapSupabase.from(MAP_USERS_TABLE).select("*").order("id", { ascending: true });
  if (error) {
    console.warn("Map user load skipped:", error.message);
    allowedUsers = { ...fallbackUsers };
    return;
  }

  allowedUsers = {
    ...fallbackUsers,
    ...(data?.length ? usersFromRows(data) : {}),
  };
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

function mapsLink(row) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${row.latitude},${row.longitude}`)}`;
}

function initMap() {
  if (map) return;
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
  const rowByUser = new Map(locationRows.map((row) => [row.user_id, row]));
  const configured = Object.entries(allowedUsers)
    .map(([id, user]) => normalizeUser(id, user))
    .filter((user) => user.role !== "admin")
    .map((user) => ({
      user_id: user.id,
      user_label: user.label,
      user_role: user.role,
      ...(rowByUser.get(user.id) || {}),
    }));

  const extraRows = locationRows.filter((row) => !configured.some((user) => user.user_id === row.user_id));
  return [...configured, ...extraRows].sort((a, b) => {
    const aTime = new Date(a.updated_at || 0).getTime();
    const bTime = new Date(b.updated_at || 0).getTime();
    return bTime - aTime;
  });
}

function hasLocation(row) {
  return Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude));
}

function renderLocations(rows = []) {
  latestRows = configuredUserRows(rows);
  const locatedRows = latestRows.filter(hasLocation);
  lastRefreshAt = new Date();
  els.status.textContent = locatedRows.length
    ? `${locatedRows.length} user${locatedRows.length === 1 ? "" : "s"} reporting location.`
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
          return `
            <article class="user-card ${located ? "" : "not-seen"}">
              <div class="user-card-top">
                <strong>${escapeText(row.user_label || row.user_id)}</strong>
                <b class="${located ? "" : "offline"}">${escapeText(updated)}</b>
              </div>
              <span>Last seen: ${escapeText(lastSeen)}</span>
              <span>${escapeText(row.last_action || "Waiting for location")} - ${escapeText(accuracy)}</span>
              ${located ? `<span>${Number(row.latitude).toFixed(5)}, ${Number(row.longitude).toFixed(5)}</span>` : ""}
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

  if (bounds.length && !map._paymentTrackerCentered) {
    map.fitBounds(bounds, { padding: [45, 45], maxZoom: 16 });
    map._paymentTrackerCentered = true;
  }
}

async function loadLocations() {
  if (!mapSupabase) return;
  const { data, error } = await mapSupabase
    .from(MAP_LOCATION_TABLE)
    .select("*")
    .order("updated_at", { ascending: false });

  if (error) {
    els.status.textContent = `Location table not ready: ${error.message}`;
    return;
  }

  renderLocations(data || []);
}

function subscribeLocations() {
  if (!mapSupabase || realtimeChannel) return;
  realtimeChannel = mapSupabase
    .channel("admin-live-user-locations")
    .on("postgres_changes", { event: "*", schema: "public", table: MAP_LOCATION_TABLE }, () => {
      void loadLocations();
    })
    .subscribe();
}

function openAdminMap() {
  els.login.hidden = true;
  els.shell.hidden = false;
  initMap();
  window.setTimeout(() => map.invalidateSize(), 0);
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
  openAdminMap();
});

els.refresh.addEventListener("click", () => void loadLocations());

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
  els.id.value = "";
  els.password.value = "";
  els.id.focus();
});

void loadUsers();

