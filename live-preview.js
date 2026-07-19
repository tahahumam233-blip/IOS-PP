const previewApp = document.querySelector(".app-preview");
const defaultPreviewUsers = {
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
let previewUsers = window.PAYMENT_TRACKER_USERS || defaultPreviewUsers;
const PREVIEW_ACTIVITY_KEY = "payment-tracker-preview-activity";
const PREVIEW_TASK_STATE_KEY = "zaki-payment-task-state";
const REMEMBER_LOGIN_ID_KEY = "payment-tracker-remember-login-id";
const FACE_ID_LOGIN_KEY = "payment-tracker-face-id-login-v1";
const ADMIN_SESSION_KEY = "payment-tracker-admin-session-v1";
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const FACE_ID_TIMEOUT_MS = 60000;
const PREVIEW_SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const PREVIEW_RECEIPTS_BUCKET = "IOS-PP- Receipts";
const ACTIVITY_TABLE = "activity_log";
const USERS_TABLE = "app_users";
const LOCATION_TABLE = "user_locations";
const LOCATION_HISTORY_TABLE = "user_location_history";
let previewUser = { role: "guest", label: "Guest" };
let lastTouchEnd = 0;
let previewReceiptTaskId = "";
let locationWatchId = null;
let lastLocationSaveAt = 0;
let lastLocationCoords = null;
let locationPermissionRetryArmed = false;
let faceIdAvailable = false;
let faceIdAvailabilityChecked = false;
let faceIdBusyMode = "";
let faceIdNotice = "";
const LOCATION_PROMPT_KEY = "payment-tracker-location-permission-requested";
const LOCATION_MIN_SAVE_MS = 10000;
const LOCATION_MIN_DISTANCE_M = 15;

function setLocationStatus(message) {
  const status = document.querySelector("#locationStatusText");
  if (status) status.textContent = message;
}

function syncAppViewport() {
  document.documentElement.style.setProperty("--app-width", `${Math.ceil(window.innerWidth || document.documentElement.clientWidth)}px`);
}

function previewCanPost() {
  return userCan("post");
}

function getRoleDefaultPermissions(role) {
  if (role === "admin") {
    return { post: true, update: true, exchange: true, viewAllActivity: true, manageUsers: true };
  }
  if (role === "zaki") {
    return { post: true, update: true, exchange: true, viewAllActivity: false, manageUsers: false };
  }
  return { post: false, update: false, exchange: false, viewAllActivity: false, manageUsers: false };
}

function normalizeUser(id, user = {}) {
  const role = user.role || "guest";
  return {
    id,
    role,
    label: user.label || id || "Guest",
    password: user.password || "",
    permissions: {
      ...getRoleDefaultPermissions(role),
      ...(user.permissions || {}),
    },
  };
}

function getFaceIdRecord() {
  try {
    const record = JSON.parse(localStorage.getItem(FACE_ID_LOGIN_KEY) || "null");
    if (!record?.userId || !record?.credentialId) return null;
    return record;
  } catch {
    return null;
  }
}

function saveFaceIdRecord(record) {
  localStorage.setItem(FACE_ID_LOGIN_KEY, JSON.stringify(record));
}

function getFaceIdUser(record = getFaceIdRecord()) {
  const rawUser = record?.userId ? previewUsers[record.userId] : null;
  return rawUser ? normalizeUser(record.userId, rawUser) : null;
}

function isFaceIdRecordEnabled(record) {
  return Boolean(record && record.enabled !== false);
}

function randomCredentialBytes(length = 32) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function encodeBase64Url(buffer) {
  let binary = "";
  new Uint8Array(buffer).forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value) {
  const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function setLoginError(message = "") {
  const error = document.querySelector("#previewLoginError");
  error.textContent = message;
  error.hidden = !message;
}

function faceIdErrorMessage(error, action) {
  if (error?.name === "NotAllowedError") {
    return action === "setup" ? "Face ID setup was cancelled." : "Face ID was cancelled. Try again or use your password.";
  }
  if (error?.name === "InvalidStateError") {
    return "Face ID is already registered. Sign in with your password and replace it in Settings.";
  }
  if (error?.name === "SecurityError") {
    return "Face ID requires the secure app or Safari page.";
  }
  return action === "setup"
    ? "Face ID could not be set up. Password login still works."
    : "Face ID could not sign you in. Use your password and try again.";
}

async function detectFaceIdSupport() {
  if (!window.isSecureContext || !window.PublicKeyCredential || !navigator.credentials) return false;
  if (typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== "function") return true;

  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

function updateFaceIdUi() {
  const record = getFaceIdRecord();
  const faceIdUser = getFaceIdUser(record);
  const enabled = isFaceIdRecordEnabled(record);
  const loginButton = document.querySelector("#previewFaceIdButton");
  const loginStatus = document.querySelector("#faceIdLoginStatus");
  const setupRow = document.querySelector("#setupFaceIdRow");
  const setupCheckbox = document.querySelector("#setupFaceIdOnLogin");
  const settingsStatus = document.querySelector("#faceIdSettingsStatus");
  const settingsButton = document.querySelector("#faceIdSettingsButton");

  loginButton.hidden = !(faceIdAvailable && enabled && faceIdUser);
  loginButton.disabled = Boolean(faceIdBusyMode);
  loginButton.textContent = faceIdBusyMode === "login" ? "Checking Face ID..." : "Use Face ID";
  setupRow.hidden = !faceIdAvailable || Boolean(enabled && faceIdUser);

  if (!faceIdAvailabilityChecked) {
    loginStatus.textContent = "Checking this device...";
  } else if (!faceIdAvailable) {
    loginStatus.textContent = "Face ID is unavailable here. Password login still works.";
  } else if (enabled && faceIdUser) {
    loginStatus.textContent = `Ready for ${faceIdUser.label} on this device.`;
  } else if (record && !faceIdUser) {
    loginStatus.textContent = "The saved Face ID account is unavailable. Sign in with your password.";
  } else if (record && !enabled) {
    loginStatus.textContent = "Face ID is off on this device.";
  } else {
    loginStatus.textContent = "Not set up on this device.";
  }

  if (!faceIdAvailabilityChecked) {
    settingsStatus.textContent = "Checking this device...";
    settingsButton.textContent = "Enable";
    settingsButton.disabled = true;
    return;
  }

  if (!faceIdAvailable) {
    settingsStatus.textContent = "Face ID is unavailable in this browser.";
    settingsButton.textContent = "Unavailable";
    settingsButton.disabled = true;
    return;
  }

  if (faceIdNotice) {
    settingsStatus.textContent = faceIdNotice;
  } else if (previewUser.role === "guest") {
    settingsStatus.textContent = "Sign in to manage Face ID for this device.";
  } else if (record?.userId === previewUser.id && enabled) {
    settingsStatus.textContent = `Enabled for ${previewUser.label} on this device.`;
  } else if (record?.userId === previewUser.id) {
    settingsStatus.textContent = `Disabled for ${previewUser.label} on this device.`;
  } else if (faceIdUser && enabled) {
    settingsStatus.textContent = `Currently enabled for ${faceIdUser.label}.`;
  } else {
    settingsStatus.textContent = `Not set up for ${previewUser.label}.`;
  }

  if (faceIdBusyMode === "setup") {
    settingsButton.textContent = "Setting up...";
  } else if (record?.userId === previewUser.id && enabled) {
    settingsButton.textContent = "Disable";
  } else if (record?.userId === previewUser.id) {
    settingsButton.textContent = "Enable";
  } else if (record) {
    settingsButton.textContent = "Replace";
  } else {
    settingsButton.textContent = "Enable";
  }
  settingsButton.disabled = previewUser.role === "guest" || Boolean(faceIdBusyMode);

  if (!setupRow.hidden && record?.userId === document.querySelector("#previewLoginId").value.trim().toLowerCase()) {
    setupCheckbox.checked = true;
  }
}

async function enrollFaceId(user) {
  if (!faceIdAvailable || faceIdBusyMode) return false;

  faceIdBusyMode = "setup";
  faceIdNotice = "";
  updateFaceIdUi();

  try {
    const credential = await navigator.credentials.create({
      publicKey: {
        challenge: randomCredentialBytes(),
        rp: { name: "Payment Tracker" },
        user: {
          id: randomCredentialBytes(),
          name: user.id,
          displayName: user.label,
        },
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: FACE_ID_TIMEOUT_MS,
        attestation: "none",
      },
    });

    if (!credential?.rawId) throw new Error("Missing Face ID credential");

    saveFaceIdRecord({
      version: 1,
      userId: user.id,
      credentialId: encodeBase64Url(credential.rawId),
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem(REMEMBER_LOGIN_ID_KEY, user.id);
    faceIdNotice = `Face ID is ready for ${user.label}.`;
    return true;
  } catch (error) {
    faceIdNotice = faceIdErrorMessage(error, "setup");
    return false;
  } finally {
    faceIdBusyMode = "";
    updateFaceIdUi();
  }
}

async function authenticateWithFaceId() {
  const record = getFaceIdRecord();
  const user = getFaceIdUser(record);
  if (!faceIdAvailable || !isFaceIdRecordEnabled(record) || !user || faceIdBusyMode) return;

  faceIdBusyMode = "login";
  faceIdNotice = "";
  setLoginError();
  updateFaceIdUi();

  try {
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: randomCredentialBytes(),
        allowCredentials: [{
          type: "public-key",
          id: decodeBase64Url(record.credentialId),
          transports: ["internal"],
        }],
        userVerification: "required",
        timeout: FACE_ID_TIMEOUT_MS,
      },
    });

    if (!credential?.rawId || encodeBase64Url(credential.rawId) !== record.credentialId) {
      throw new Error("Face ID credential did not match");
    }

    setPreviewAccess(user);
    addActivity({
      title: "User signed in with Face ID",
      message: `${user.label} opened the app session with Face ID.`,
      status: "changed",
      user: user.label,
    });
  } catch (error) {
    setLoginError(faceIdErrorMessage(error, "login"));
  } finally {
    faceIdBusyMode = "";
    updateFaceIdUi();
  }
}

function userCan(permission) {
  return Boolean(previewUser?.permissions?.[permission]);
}

function syncAdminConsoleAccess() {
  const card = document.querySelector("#userManagerSettingsCard");
  const allowed = userCan("manageUsers");
  if (card) card.hidden = !allowed;

  try {
    if (allowed) {
      sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify({
        id: previewUser.id,
        label: previewUser.label,
        role: previewUser.role,
        permissions: previewUser.permissions,
        expiresAt: Date.now() + ADMIN_SESSION_MS,
      }));
    } else {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
    }
  } catch {
    // The admin console will ask for credentials when session storage is unavailable.
  }
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

async function loadRemoteUsers() {
  if (!supabaseClient) return;

  const { data, error } = await supabaseClient.from(USERS_TABLE).select("*").order("id", { ascending: true });
  if (error) {
    console.warn("User config load skipped:", error.message);
    return;
  }

  if (data?.length) {
    previewUsers = usersFromRows(data);
  }
}

function readPreviewTaskState() {
  try {
    return JSON.parse(localStorage.getItem(PREVIEW_TASK_STATE_KEY) || "{}");
  } catch {
    return {};
  }
}

function splitPreviewList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPreviewFileUrl(filePath) {
  const bucket = encodeURIComponent(PREVIEW_RECEIPTS_BUCKET);
  const path = filePath.split("/").map(encodeURIComponent).join("/");
  return `${PREVIEW_SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`;
}

function readActivity() {
  try {
    return JSON.parse(localStorage.getItem(PREVIEW_ACTIVITY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveActivity(items) {
  localStorage.setItem(PREVIEW_ACTIVITY_KEY, JSON.stringify(items.slice(0, 80)));
}

function activityUserLabel() {
  return previewUser?.label || "Guest";
}

function activityUserId() {
  return previewUser?.id || previewUser?.role || "guest";
}

function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const radius = 6371000;
  const toRad = (value) => (value * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

async function saveUserLocation(position, action = "App active") {
  if (!supabaseClient || previewUser.role === "guest") return;

  const coords = position.coords || {};
  const latitude = Number(coords.latitude);
  const longitude = Number(coords.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const now = Date.now();
  const currentCoords = { latitude, longitude };
  const movedEnough = distanceMeters(lastLocationCoords, currentCoords) >= LOCATION_MIN_DISTANCE_M;
  if (now - lastLocationSaveAt < LOCATION_MIN_SAVE_MS && !movedEnough) return;

  lastLocationSaveAt = now;
  lastLocationCoords = currentCoords;

  const locationRow = {
    user_id: activityUserId(),
    user_label: activityUserLabel(),
    user_role: previewUser.role,
    latitude,
    longitude,
    accuracy_m: Number.isFinite(coords.accuracy) ? Math.round(coords.accuracy) : null,
    heading: Number.isFinite(coords.heading) ? coords.heading : null,
    speed_mps: Number.isFinite(coords.speed) ? coords.speed : null,
    last_action: action,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabaseClient.from(LOCATION_TABLE).upsert(locationRow, { onConflict: "user_id" });

  if (error) {
    setLocationStatus(`Location could not save: ${error.message}`);
    console.warn("Location save skipped:", error.message);
    return;
  }

  const { error: historyError } = await supabaseClient.from(LOCATION_HISTORY_TABLE).insert({
    ...locationRow,
    recorded_at: locationRow.updated_at,
  });
  if (historyError) console.warn("Location history save skipped:", historyError.message);

  locationPermissionRetryArmed = false;
  setLocationStatus(`Location shared ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date())}.`);
}

function explainLocationPermission(error) {
  if (error?.code === 1) {
    return "Location permission was blocked. Allow location for this website in Safari settings, then reopen the app.";
  }
  if (error?.code === 2) return "Location is unavailable on this device right now.";
  if (error?.code === 3) return "Location request timed out. Keep the app open and try again.";
  return error?.message || "Location is not active.";
}

async function getLocationPermissionState() {
  if (!navigator.permissions?.query) return "unknown";
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    return permission.state || "unknown";
  } catch {
    return "unknown";
  }
}

function locationPromptWasRequested() {
  return localStorage.getItem(LOCATION_PROMPT_KEY) === "true";
}

function rememberLocationPromptRequest() {
  localStorage.setItem(LOCATION_PROMPT_KEY, "true");
}

async function shouldRequestLocation() {
  if (!navigator.geolocation || previewUser.role === "guest") return false;

  const permissionState = await getLocationPermissionState();
  if (permissionState === "granted") return true;
  if (permissionState === "denied") {
    setLocationStatus("Location permission is blocked for this device.");
    return false;
  }
  if (locationPromptWasRequested()) {
    setLocationStatus("Location permission was already requested on this device.");
    return false;
  }

  return true;
}

async function requestFreshLocation(action = "App active", { alertOnBlock = false } = {}) {
  if (!navigator.geolocation || previewUser.role === "guest") return;
  if (!(await shouldRequestLocation())) return;

  rememberLocationPromptRequest();
  navigator.geolocation.getCurrentPosition(
    (position) => void saveUserLocation(position, action),
    (error) => {
      const message = explainLocationPermission(error);
      setLocationStatus(message);
      console.warn("Location update skipped:", error.message);
      if (alertOnBlock && error?.code === 1) window.alert(message);
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
  );
}

function stopLocationTracking() {
  if (locationWatchId !== null && navigator.geolocation) {
    navigator.geolocation.clearWatch(locationWatchId);
  }
  locationWatchId = null;
  lastLocationSaveAt = 0;
  lastLocationCoords = null;
  locationPermissionRetryArmed = false;
}

async function startLocationTracking(action = "Signed in") {
  stopLocationTracking();
  if (!navigator.geolocation || previewUser.role === "guest") return;

  locationPermissionRetryArmed = !locationPromptWasRequested();
  await requestFreshLocation(action, { alertOnBlock: true });
}

function activityStatusLabel(status) {
  if (status === "failed") return "Failed";
  if (status === "changed") return "Changed";
  return "Posted";
}

function activityTitleFromStatus(status) {
  if (status === "failed") return "Action failed";
  if (status === "changed") return "App change";
  return "Slack post";
}

function escapeActivityText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function makeActivityId() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeActivityItem(item = {}) {
  return {
    id: item.id || makeActivityId(),
    date: item.date || todayKey(),
    title: item.title || activityTitleFromStatus(item.status),
    message: item.message || "",
    status: item.status || "posted",
    user: item.user || item.userLabel || activityUserLabel(),
    userId: item.userId || activityUserId(),
    userRole: item.userRole || previewUser?.role || "guest",
    task: item.task || "",
    taskType: item.taskType || "",
    fileCount: Number(item.fileCount || 0),
    note: item.note || "",
    time: item.time || new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date()),
    createdAt: item.createdAt || new Date().toISOString(),
  };
}

function activityItemToRow(item) {
  return {
    id: item.id,
    activity_date: item.date,
    activity_time: item.createdAt,
    user_id: item.userId,
    user_label: item.user,
    user_role: item.userRole,
    title: item.title,
    message: item.message,
    status: item.status,
    task_name: item.task || null,
    task_type: item.taskType || null,
    file_count: item.fileCount || 0,
    has_note: Boolean(item.note),
  };
}

function rowToActivityItem(row) {
  return normalizeActivityItem({
    id: row.id,
    date: row.activity_date,
    title: row.title,
    message: row.message,
    status: row.status,
    user: row.user_label,
    userId: row.user_id,
    userRole: row.user_role,
    task: row.task_name,
    taskType: row.task_type,
    fileCount: row.file_count,
    note: row.has_note ? "Text added" : "",
    time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date(row.activity_time || Date.now())),
    createdAt: row.activity_time,
  });
}

function getActivityTaskType(taskName) {
  const task = typeof getAllTasks === "function"
    ? getAllTasks().find((item) => item.name === taskName)
    : null;
  if (!task) return "";
  if (task.type === "withdrawal") return "Withdrawal";
  if (task.type === "payment") return "Payment";
  return task.type;
}

function parseActivityMessage(message) {
  const uploadMatch = String(message || "").match(/^(.+?):\s*(\d+)\s+files?\s+(?:posted|saved|uploaded)/i);
  if (!uploadMatch) return {};

  const task = uploadMatch[1].trim();
  return {
    task,
    taskType: getActivityTaskType(task),
    fileCount: Number(uploadMatch[2] || 0),
  };
}

async function saveRemoteActivity(item) {
  if (!supabaseClient || previewUser.role === "guest") return;
  const { error } = await supabaseClient.from(ACTIVITY_TABLE).upsert(activityItemToRow(item), { onConflict: "id" });
  if (error) {
    console.warn("Activity log save skipped:", error.message);
  }
}

async function loadRemoteActivity() {
  if (!supabaseClient || previewUser.role === "guest") {
    renderActivity();
    return;
  }

  let query = supabaseClient
    .from(ACTIVITY_TABLE)
    .select("*")
    .eq("activity_date", todayKey())
    .order("activity_time", { ascending: false })
    .limit(100);

  if (!userCan("viewAllActivity")) {
    query = query.eq("user_id", activityUserId());
  }

  const { data, error } = await query;
  if (error) {
    console.warn("Activity log load skipped:", error.message);
    renderActivity();
    return;
  }

  if (data?.length) {
    saveActivity(data.map(rowToActivityItem));
  }
  renderActivity();
}

function addActivity({ title, message, status = "posted", user, task, taskType, fileCount, note }) {
  const items = readActivity();
  const item = normalizeActivityItem({
    title,
    message,
    status,
    user,
    task,
    taskType,
    fileCount,
    note,
  });
  items.unshift(item);
  saveActivity(items);
  renderActivity();
  void saveRemoteActivity(item);
  requestFreshLocation(title || message || "Activity");
}

function renderActivity() {
  const list = document.querySelector("#previewActivityList");
  const items = readActivity();
  if (!items.length) {
    list.innerHTML = `
      <div class="activity-empty">
        <strong>No activity yet</strong>
        <span>Uploads, Slack posts, failures, and exchange saves will appear here.</span>
      </div>
    `;
    return;
  }

  list.innerHTML = items.map((item) => {
    const status = item.status || "posted";
    const meta = [
      item.user ? `User: ${item.user}` : "",
      item.taskType ? item.taskType : "",
      item.fileCount ? `${item.fileCount} ${item.fileCount === 1 ? "file" : "files"}` : "",
      item.note ? "Text added" : "",
      item.time,
    ].filter(Boolean);

    return `
      <article class="activity-row report-row">
        <div class="activity-report-main">
          <div class="activity-report-top">
            <strong>${escapeActivityText(item.title || activityTitleFromStatus(status))}</strong>
            <b class="${status === "failed" ? "failed" : status === "changed" ? "changed" : ""}">${activityStatusLabel(status)}</b>
          </div>
          ${item.task ? `<h3>${escapeActivityText(item.task)}</h3>` : ""}
          <span>${escapeActivityText(item.message || "No summary available.")}</span>
          <div class="activity-meta">
            ${meta.map((entry) => `<em>${escapeActivityText(entry)}</em>`).join("")}
          </div>
        </div>
      </article>
    `;
  }).join("");
}

function enhanceTaskRows() {
  document.querySelectorAll("#taskList .amount-cell").forEach((cell) => {
    const raw = (cell.dataset.rawAmount || cell.textContent || "").trim();
    cell.dataset.rawAmount = raw;
    if (cell.dataset.enhancedAmount === raw) return;

    const label = cell.dataset.label || "";
    const isEmpty = raw === "-" || raw === "$0" || raw === "0 IQD" || raw === "0";

    cell.classList.toggle("empty-amount", isEmpty);
    cell.dataset.enhancedAmount = raw;
    if (isEmpty) {
      cell.innerHTML = "";
      return;
    }

    const value = raw
      .replace(/\s*IQD$/i, "")
      .replace(/^\$/, "")
      .trim();

    cell.innerHTML = `
      <span class="amount-label">${label}</span>
      <span class="amount-number">${value}</span>
    `;
  });
}

function updatePendingMetric() {
  const metrics = document.querySelector("#metrics");
  if (!metrics) return;

  const existing = metrics.querySelector(".preview-pending-card");
  if (document.querySelector("#exchangePanel:not([hidden])")) {
    if (existing) existing.remove();
    return;
  }

  const rows = Array.from(document.querySelectorAll("#taskList tr[data-task-id]"));
  const pending = rows.filter((row) => !row.querySelector(".status-dot.uploaded")).length;
  const isPayments = document.querySelector("#paymentsTab")?.classList.contains("active");
  const label = isPayments ? "Pending payments" : "Pending withdrawals";
  const value = pending === 0 ? `${isPayments ? "Payments" : "Withdrawals"} Completed` : String(pending);
  const isComplete = pending === 0;

  if (existing) {
    const labelNode = existing.querySelector("b");
    const valueNode = existing.querySelector("strong");
    if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
    if (valueNode && valueNode.textContent !== value) valueNode.textContent = value;
    existing.classList.toggle("is-complete", isComplete);
    return;
  }

  const card = document.createElement("article");
  card.className = `metric-card total-card preview-pending-card${isComplete ? " is-complete" : ""}`;
  card.innerHTML = `
    <div>
      <b>${label}</b>
      <strong>${value}</strong>
    </div>
  `;
  metrics.appendChild(card);
}

function showReceiptPreview(taskId) {
  const taskState = readPreviewTaskState()[taskId] || {};
  const filePaths = splitPreviewList(taskState.filePaths || taskState.filePath);
  const fileNames = splitPreviewList(taskState.fileNames || taskState.receiptName);
  const noteText = String(taskState.uploadNote || "").trim();

  if (!filePaths.length) {
    if (!noteText) {
      alert("No uploaded receipt was found for this task yet.");
      return;
    }

    previewReceiptTaskId = taskId;
    document.querySelector("#receiptPreviewTitle").textContent = "Posted note";
    document.querySelector("#receiptOpenLink").hidden = true;
    document.querySelector("#addPostingButton").hidden = !previewCanPost();
    document.querySelector("#receiptPreviewBody").innerHTML = `
      <article class="receipt-preview-item">
        <div class="receipt-file-fallback">
          <strong>Note-only Slack post</strong>
          <span>${escapeActivityText(noteText)}</span>
        </div>
      </article>
    `;
    document.querySelector("#receiptPreviewModal").hidden = false;
    return;
  }

  const firstUrl = getPreviewFileUrl(filePaths[0]);
  previewReceiptTaskId = taskId;
  document.querySelector("#receiptPreviewTitle").textContent = filePaths.length === 1
    ? fileNames[0] || "Uploaded receipt"
    : `${filePaths.length} uploaded receipts`;
  document.querySelector("#receiptOpenLink").hidden = false;
  document.querySelector("#receiptOpenLink").href = firstUrl;
  document.querySelector("#addPostingButton").hidden = !previewCanPost();
  document.querySelector("#receiptPreviewBody").innerHTML = filePaths.map((filePath, index) => {
    const fileName = fileNames[index] || `Receipt ${index + 1}`;
    const url = getPreviewFileUrl(filePath);
    const lowerName = fileName.toLowerCase();
    const preview = lowerName.endsWith(".pdf") || lowerName.endsWith(".txt")
      ? `<div class="receipt-file-fallback"><strong>${lowerName.endsWith(".txt") ? "Posted note" : "PDF receipt"}</strong><span>${escapeActivityText(fileName)}</span></div>`
      : `<img src="${url}" alt="${escapeActivityText(fileName)}" />`;

    return `
      <article class="receipt-preview-item">
        <div class="receipt-preview-item-heading">
          <strong>${escapeActivityText(fileName)}</strong>
          <a href="${url}" target="_blank" rel="noreferrer">Open</a>
        </div>
        ${preview}
      </article>
    `;
  }).join("");
  document.querySelector("#receiptPreviewModal").hidden = false;
}

function openAdditionalPosting(taskId) {
  const task = findTask(taskId);
  if (!task) return;

  document.querySelector("#receiptPreviewModal").hidden = true;
  state.activeUploadTaskId = taskId;
  els.uploadTaskName.textContent = `Add posting for ${task.name}`;
  els.modalFileInput.value = "";
  els.modalUploadNote.value = getSavedTask(taskId).uploadNote || "";
  els.modalSaveButton.textContent = "Save & Post";
  els.uploadModal.hidden = false;
  window.setTimeout(() => els.modalFileInput.focus(), 0);
}

function setPreviewAccess(user) {
  previewUser = user;
  previewApp.dataset.role = user.role;
  document.querySelector("#previewRolePill").textContent = user.label;
  document.querySelector("#previewLoginScreen").hidden = true;
  document.querySelector("#previewLoginError").hidden = true;
  document.querySelector("#updateButton").disabled = !userCan("update");
  document.querySelector("#saveExchangeButton").disabled = !userCan("exchange");
  document.querySelector("#previewAccessText").textContent = userCan("viewAllActivity")
    ? `Signed in as ${user.label}. You can review all activity and manage daily posting.`
    : previewCanPost()
      ? `Signed in as ${user.label}. You can upload and post assigned work.`
      : "Guest mode is view-only. Sign in with a posting account to make changes.";
  syncAdminConsoleAccess();
  if (typeof render === "function") render();
  updateFaceIdUi();
  void loadRemoteActivity();
  startLocationTracking("Signed in");
}

function resetLoginForm({ keepRememberedId = true } = {}) {
  const loginScreen = document.querySelector("#previewLoginScreen");
  const idInput = document.querySelector("#previewLoginId");
  const passwordInput = document.querySelector("#previewLoginPassword");
  const rememberInput = document.querySelector("#rememberLoginId");
  const setupFaceIdInput = document.querySelector("#setupFaceIdOnLogin");
  const faceIdRecord = getFaceIdRecord();
  const rememberedId = keepRememberedId
    ? localStorage.getItem(REMEMBER_LOGIN_ID_KEY) || (isFaceIdRecordEnabled(faceIdRecord) ? faceIdRecord.userId : "")
    : "";

  stopLocationTracking();
  previewUser = normalizeUser("guest", { role: "guest", label: "Guest" });
  previewApp.dataset.role = "guest";
  document.querySelector("#previewRolePill").textContent = "Guest";
  document.querySelector("#updateButton").disabled = true;
  document.querySelector("#saveExchangeButton").disabled = true;
  document.querySelector("#previewAccessText").textContent = "Login is required before posting, updating, or saving exchange records.";
  syncAdminConsoleAccess();
  idInput.value = rememberedId;
  passwordInput.value = "";
  rememberInput.checked = Boolean(rememberedId);
  setupFaceIdInput.checked = true;
  setLoginError();
  loginScreen.hidden = false;
  faceIdNotice = "";
  updateFaceIdUi();
  if (typeof render === "function") render();

  window.setTimeout(() => {
    if (!window.matchMedia("(pointer: fine)").matches || isFaceIdRecordEnabled(faceIdRecord)) return;
    if (rememberedId) {
      passwordInput.focus();
    } else {
      idInput.focus();
    }
  }, 0);
}

document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("gesturechange", (event) => event.preventDefault());
document.addEventListener("gestureend", (event) => event.preventDefault());
window.addEventListener("resize", syncAppViewport);
window.addEventListener("orientationchange", syncAppViewport);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && previewUser.role !== "guest") requestFreshLocation("App resumed");
  if (!document.hidden) renderActivity();
});
document.addEventListener("touchend", (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) event.preventDefault();
  lastTouchEnd = now;
  if (locationPermissionRetryArmed && previewUser.role !== "guest") {
    locationPermissionRetryArmed = false;
    window.setTimeout(() => requestFreshLocation("Permission retry", { alertOnBlock: true }), 0);
  }
}, { passive: false });

document.querySelector("#previewLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = document.querySelector("#previewLoginId").value.trim().toLowerCase();
  const password = document.querySelector("#previewLoginPassword").value;
  const rememberInput = document.querySelector("#rememberLoginId");
  const setupFaceIdInput = document.querySelector("#setupFaceIdOnLogin");
  const loginButton = document.querySelector("#previewLoginButton");
  const rawUser = previewUsers[id];
  const user = rawUser ? normalizeUser(id, rawUser) : null;
  if (!user || user.password !== password) {
    setLoginError("Wrong ID or password.");
    document.querySelector("#previewLoginPassword").value = "";
    return;
  }

  setLoginError();
  loginButton.disabled = true;
  loginButton.textContent = "Signing in...";

  if (rememberInput.checked) {
    localStorage.setItem(REMEMBER_LOGIN_ID_KEY, id);
  } else {
    localStorage.removeItem(REMEMBER_LOGIN_ID_KEY);
  }

  if (!document.querySelector("#setupFaceIdRow").hidden && setupFaceIdInput.checked) {
    await enrollFaceId(user);
  }

  document.querySelector("#previewLoginPassword").value = "";
  loginButton.disabled = false;
  loginButton.textContent = "Login";
  setPreviewAccess(user);
  addActivity({
    title: "User signed in",
    message: `${user.label} opened the app session.`,
    status: "changed",
    user: user.label,
  });
});

document.querySelector("#previewFaceIdButton").addEventListener("click", () => {
  void authenticateWithFaceId();
});

document.querySelector("#faceIdSettingsButton").addEventListener("click", async () => {
  if (previewUser.role === "guest" || !faceIdAvailable || faceIdBusyMode) return;

  const record = getFaceIdRecord();
  faceIdNotice = "";
  if (record?.userId === previewUser.id && isFaceIdRecordEnabled(record)) {
    saveFaceIdRecord({ ...record, enabled: false });
    faceIdNotice = `Face ID is disabled for ${previewUser.label}.`;
    updateFaceIdUi();
    return;
  }

  await enrollFaceId(previewUser);
});

document.querySelector("#previewSignOutButton").addEventListener("click", () => {
  addActivity({
    title: "User signed out",
    message: `${activityUserLabel()} ended the app session.`,
    status: "changed",
    user: activityUserLabel(),
  });
  resetLoginForm();
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    const themeLabel = button.dataset.themeChoice === "light" ? "Light mode" : "Dark mode";
    previewApp.dataset.theme = button.dataset.themeChoice;
    document.querySelectorAll("[data-theme-choice]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    addActivity({
      title: "Theme changed",
      message: `${themeLabel} selected.`,
      status: "changed",
      user: activityUserLabel(),
    });
  });
});

document.querySelectorAll("[data-preview-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-preview-view]").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".preview-view").forEach((view) => {
      view.classList.remove("active");
      view.hidden = true;
    });
    button.classList.add("active");
    const view = document.querySelector(`#${button.dataset.previewView}`);
    view.hidden = false;
    view.classList.add("active");
    if (button.dataset.previewView === "activityView") {
      void loadRemoteActivity();
    }
  });
});

document.querySelector("#taskList").addEventListener("click", (event) => {
  const uploadButton = event.target.closest('[data-action="open-upload"]');
  if (!uploadButton) return;

  if (uploadButton.classList.contains("uploaded")) {
    const row = uploadButton.closest("[data-task-id]");
    if (!row) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    showReceiptPreview(row.dataset.taskId);
    return;
  }

  if (previewCanPost()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  alert("Guest access is view-only. Please sign in as Zaki or Admin to post.");
}, true);

document.querySelector("#exchangePanel").addEventListener("submit", (event) => {
  if (previewCanPost()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  alert("Guest access is view-only. Please sign in as Zaki or Admin to save exchange records.");
}, true);

document.querySelector("#closeReceiptPreview").addEventListener("click", () => {
  document.querySelector("#receiptPreviewModal").hidden = true;
});

document.querySelector("#addPostingButton").addEventListener("click", () => {
  if (!previewCanPost()) return;
  openAdditionalPosting(previewReceiptTaskId);
});

document.querySelector("#receiptPreviewModal").addEventListener("click", (event) => {
  if (event.target.id === "receiptPreviewModal") {
    document.querySelector("#receiptPreviewModal").hidden = true;
  }
});

const statusObserver = new MutationObserver(() => {
  const modal = document.querySelector("#successModal");
  if (modal.hidden) return;
  const title = document.querySelector("#successTitle").textContent.trim();
  const message = document.querySelector("#successMessage").textContent.trim();
  const signature = `${title}|${message}`;
  if (statusObserver.lastSignature === signature) return;
  statusObserver.lastSignature = signature;
  addActivity({
    title,
    message,
    status: title.toLowerCase().includes("failed") ? "failed" : "posted",
    user: activityUserLabel(),
    ...parseActivityMessage(message),
  });
});

statusObserver.observe(document.querySelector("#successModal"), {
  attributes: true,
  attributeFilter: ["hidden"],
  subtree: true,
  childList: true,
  characterData: true,
});

const lastUpdatedObserver = new MutationObserver(() => {
  const text = document.querySelector("#lastUpdated").textContent.trim();
  if (!text.startsWith("Saved exchange-") || lastUpdatedObserver.lastText === text) return;
  lastUpdatedObserver.lastText = text;
  addActivity({
    title: "Exchange saved",
    message: text.replace(/^Saved\s+/i, ""),
    status: "posted",
    user: activityUserLabel(),
    task: "Exchange record",
    taskType: "Exchange",
  });
});

lastUpdatedObserver.observe(document.querySelector("#lastUpdated"), {
  childList: true,
  characterData: true,
  subtree: true,
});

const metricsObserver = new MutationObserver(() => {
  window.requestAnimationFrame(() => {
    enhanceTaskRows();
    updatePendingMetric();
  });
});

metricsObserver.observe(document.querySelector("#metrics"), {
  childList: true,
  subtree: true,
});

const taskListObserver = new MutationObserver(() => {
  window.requestAnimationFrame(() => {
    enhanceTaskRows();
    updatePendingMetric();
  });
});

taskListObserver.observe(document.querySelector("#taskList"), {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["class"],
});

async function bootApp() {
  resetLoginForm();
  const remoteUsersPromise = loadRemoteUsers();
  faceIdAvailable = await detectFaceIdSupport();
  faceIdAvailabilityChecked = true;
  updateFaceIdUi();
  await remoteUsersPromise;
  updateFaceIdUi();
  renderActivity();
  syncAppViewport();
  window.requestAnimationFrame(() => {
    syncAppViewport();
    enhanceTaskRows();
    updatePendingMetric();
  });
}

void bootApp();
