const SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const SOURCE_ADMIN_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/source-admin`;
const USERS_TABLE = "app_users";
const ADMIN_SESSION_KEY = "payment-tracker-admin-session-v1";
const SOURCE_ADMIN_SESSION_KEY = "payment-tracker-source-admin-session-v1";
const ACTIVE_SHEET_SOURCE_STORAGE_KEY = "payment-tracker-active-sheet-source-v1";
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const SOURCE_TEST_FRESH_MS = 30 * 60 * 1000;
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const permissionInfo = {
  post: { label: "Post", description: "Upload receipts and publish work" },
  update: { label: "Update data", description: "Refresh live Sheet data" },
  exchange: { label: "Exchange", description: "Create exchange records" },
  viewAllActivity: { label: "All activity", description: "Review activity from every user" },
  manageUsers: { label: "Administration", description: "Manage users and data sources" },
};

const roleDefaults = {
  admin: { post: true, update: true, exchange: true, viewAllActivity: true, manageUsers: true },
  zaki: { post: true, update: true, exchange: true, viewAllActivity: false, manageUsers: false },
  viewer: { post: false, update: false, exchange: false, viewAllActivity: false, manageUsers: false },
};

const roleLabels = { admin: "Administrator", zaki: "Operator", viewer: "Viewer" };

const EXISTING_Q2_SOURCE = {
  id: "soa-current",
  name: "SOA 2026 Q2 PP",
  spreadsheet_id: "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw",
  sheet_name: "PP",
  sheet_gid: "0",
  payment_range: "A7:J200",
  withdrawal_range: "L26:N200",
  layout_key: "pp-v1",
  enabled: true,
  last_test_status: "success",
  last_test_message: "Active from the existing Payment Tracker configuration.",
  isFallback: true,
};

const appState = {
  currentUser: null,
  users: [],
  sources: [],
  activeSourceId: "",
  settingsVersion: 0,
  editingUserId: "",
  editingSourceId: "",
  sourceSetupError: "",
  sourceAdminToken: "",
  sourceAdminExpiresAt: "",
  sourceAdminError: "",
  sourceCatalogAvailable: false,
  activeView: "overview",
};

let sourceSessionExpiryTimer = 0;
let pendingSourcePreset = "";

const sourcePresets = {
  q3: {
    id: "soa-2026-q3",
    name: "SOA 2026 Q3 PP",
    sheet_name: "PP",
    sheet_gid: "0",
    payment_range: "A7:J200",
    withdrawal_range: "L26:N200",
  },
};

const byId = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizeId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 63);
}

function normalizeUser(row = {}) {
  const role = row.role || "viewer";
  return {
    id: String(row.id || ""),
    password: String(row.password || ""),
    role,
    label: String(row.label || row.id || "Unnamed user"),
    permissions: { ...(roleDefaults[role] || roleDefaults.viewer), ...(row.permissions || {}) },
    updated_at: row.updated_at || "",
  };
}

function normalizeSource(row = {}) {
  const spreadsheetId = row.spreadsheet_id ?? row.spreadsheetId ?? "";
  const isExistingQ2 = row.id === EXISTING_Q2_SOURCE.id
    || spreadsheetId === EXISTING_Q2_SOURCE.spreadsheet_id;
  return {
    id: String(row.id || ""),
    name: String(isExistingQ2 ? EXISTING_Q2_SOURCE.name : (row.name || row.id || "Unnamed source")),
    spreadsheet_id: String(spreadsheetId),
    sheet_name: String(row.sheet_name ?? row.sheetName ?? "PP"),
    sheet_gid: String(row.sheet_gid ?? row.sheetGid ?? "0"),
    payment_range: String(row.payment_range ?? row.paymentRange ?? "A7:J200").toUpperCase(),
    withdrawal_range: String(row.withdrawal_range ?? row.withdrawalRange ?? "L26:N200").toUpperCase(),
    layout_key: String(row.layout_key ?? row.layoutKey ?? "pp-v1"),
    enabled: row.enabled !== false,
    config_version: Number(row.config_version ?? row.configVersion ?? 1),
    tested_config_version: row.tested_config_version ?? row.testedConfigVersion ?? null,
    last_test_status: String(row.last_test_status ?? row.lastTestStatus ?? "untested"),
    last_tested_at: row.last_tested_at ?? row.lastTestedAt ?? "",
    last_test_message: String(row.last_test_message ?? row.lastTestMessage ?? ""),
    created_at: row.created_at ?? row.createdAt ?? "",
    updated_at: row.updated_at ?? row.updatedAt ?? "",
    is_validated: row.is_validated === true || row.isValidated === true,
    isCatalogSummary: Boolean(row.isCatalogSummary),
    isFallback: Boolean(row.isFallback),
  };
}

function isExistingQ2Source(source) {
  return source?.id === EXISTING_Q2_SOURCE.id
    || source?.spreadsheet_id === EXISTING_Q2_SOURCE.spreadsheet_id;
}

function readRememberedActiveSource() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_SHEET_SOURCE_STORAGE_KEY) || "null");
    if (!saved?.id || !saved?.spreadsheetId || !saved?.sheetName || !saved?.layoutKey) return null;
    const source = normalizeSource({
      id: saved.id,
      name: saved.name,
      spreadsheet_id: saved.spreadsheetId,
      sheet_name: saved.sheetName,
      sheet_gid: saved.sheetGid,
      payment_range: saved.paymentRange,
      withdrawal_range: saved.withdrawalRange,
      layout_key: saved.layoutKey,
      enabled: true,
    });
    if (
      !/^\d+$/.test(source.sheet_gid)
      || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(source.payment_range)
      || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(source.withdrawal_range)
    ) return null;
    return { source, configVersion: Number(saved.configVersion) || 0 };
  } catch {
    return null;
  }
}

function rememberActiveSource(source, configVersion) {
  try {
    localStorage.setItem(ACTIVE_SHEET_SOURCE_STORAGE_KEY, JSON.stringify({
      id: source.id,
      name: source.name,
      spreadsheetId: source.spreadsheet_id,
      sheetName: source.sheet_name,
      sheetGid: source.sheet_gid,
      paymentRange: source.payment_range,
      withdrawalRange: source.withdrawal_range,
      layoutKey: source.layout_key,
      configVersion: Number(configVersion) || 0,
      sheetUrl: sheetUrl(source),
    }));
  } catch {
    // The manager remains usable if browser storage is disabled.
  }
}

function initials(value) {
  return String(value || "AD")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((item) => item[0] || "")
    .join("")
    .toUpperCase() || "AD";
}

function formatDate(value, fallback = "Not tested yet") {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return fallback;
  return new Intl.DateTimeFormat([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sheetUrl(source) {
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheet_id}/edit?gid=${source.sheet_gid}#gid=${source.sheet_gid}`;
}

function showToast(title, message = "", type = "success") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.innerHTML = `
    <span>${type === "error" ? "!" : "✓"}</span>
    <span><strong>${escapeHtml(title)}</strong>${message ? `<small>${escapeHtml(message)}</small>` : ""}</span>
  `;
  byId("toastStack").appendChild(toast);
  window.setTimeout(() => toast.remove(), 4200);
}

function setFormMessage(element, message = "") {
  element.textContent = message;
  element.hidden = !message;
}

function openDialog(dialog) {
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
}

function closeDialog(dialog) {
  if (typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
}

function hasSourceAdminSession() {
  const expiresAt = new Date(appState.sourceAdminExpiresAt).getTime();
  return Boolean(appState.sourceAdminToken && Number.isFinite(expiresAt) && expiresAt > Date.now());
}

function removeStoredSourceAdminSession() {
  try {
    sessionStorage.removeItem(SOURCE_ADMIN_SESSION_KEY);
  } catch {
    // Storage can be unavailable in hardened browser modes.
  }
}

function saveSourceAdminSession() {
  if (!hasSourceAdminSession()) {
    removeStoredSourceAdminSession();
    return;
  }

  try {
    sessionStorage.setItem(SOURCE_ADMIN_SESSION_KEY, JSON.stringify({
      token: appState.sourceAdminToken,
      expiresAt: appState.sourceAdminExpiresAt,
    }));
  } catch {
    // The current in-memory session remains usable until the page closes.
  }
}

function restoreSourceAdminSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SOURCE_ADMIN_SESSION_KEY) || "null");
    const token = String(saved?.token || "");
    const expiresAt = String(saved?.expiresAt || "");
    const expiresAtMs = new Date(expiresAt).getTime();

    if (!/^[A-Za-z0-9_-]{43}$/.test(token)
      || !Number.isFinite(expiresAtMs)
      || expiresAtMs <= Date.now()) {
      removeStoredSourceAdminSession();
      return false;
    }

    appState.sourceAdminToken = token;
    appState.sourceAdminExpiresAt = expiresAt;
    appState.sourceAdminError = "";
    scheduleSourceAdminExpiry();
    return true;
  } catch {
    removeStoredSourceAdminSession();
    return false;
  }
}

function scheduleSourceAdminExpiry() {
  window.clearTimeout(sourceSessionExpiryTimer);
  sourceSessionExpiryTimer = 0;
  if (!hasSourceAdminSession()) return;

  const expiresAt = new Date(appState.sourceAdminExpiresAt).getTime();
  sourceSessionExpiryTimer = window.setTimeout(async () => {
    clearSourceAdminSession("Your source-control session expired. Unlock it again to continue.");
    await loadSources();
    renderAll();
  }, Math.max(0, expiresAt - Date.now() + 100));
}

function clearSourceAdminSession(message = "") {
  window.clearTimeout(sourceSessionExpiryTimer);
  sourceSessionExpiryTimer = 0;
  appState.sourceAdminToken = "";
  appState.sourceAdminExpiresAt = "";
  appState.sourceAdminError = message;
  removeStoredSourceAdminSession();
}

function sourceAdminError(payload, status) {
  const error = payload?.error;
  const message = typeof error === "string" ? error : error?.message;
  return new Error(message || `Source controls returned ${status}.`);
}

async function sourceAdminRequest(path, { method = "GET", body, useSession = true } = {}) {
  if (useSession && !hasSourceAdminSession()) {
    clearSourceAdminSession("Source controls are locked. Unlock them to continue.");
    throw new Error(appState.sourceAdminError);
  }

  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (useSession) headers.Authorization = `Bearer ${appState.sourceAdminToken}`;

  let response;
  try {
    response = await fetch(`${SOURCE_ADMIN_FUNCTION_URL}${path}`, {
      method,
      cache: "no-store",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    const isLocalFile = window.location.protocol === "file:";
    const isLocalHost = ["localhost", "127.0.0.1"].includes(window.location.hostname);
    const isApprovedLocalPort = ["8000", "5173", "5500"].includes(window.location.port);

    if (isLocalFile || (isLocalHost && !isApprovedLocalPort)) {
      throw new Error(
        "Open the manager at http://127.0.0.1:8000/user-manager.html. Direct file access and this preview port cannot reach the protected source controls."
      );
    }

    throw new Error(
      "Could not reach the protected source controls. Check your connection and open the manager from its approved site address."
    );
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && useSession) {
      clearSourceAdminSession("Your source-control session expired. Unlock it again to continue.");
    }
    throw sourceAdminError(payload, response.status);
  }
  return payload;
}

function openSourceUnlock() {
  setFormMessage(byId("sourceUnlockError"));
  byId("sourceAdminKeyInput").value = "";
  openDialog(byId("sourceUnlockDialog"));
  window.setTimeout(() => byId("sourceAdminKeyInput").focus(), 0);
}

async function unlockSourceControls(event) {
  event.preventDefault();
  const keyInput = byId("sourceAdminKeyInput");
  const adminKey = keyInput.value.trim();
  if (!adminKey) return setFormMessage(byId("sourceUnlockError"), "Enter the source-control key.");

  const button = byId("unlockSourceButton");
  button.disabled = true;
  button.textContent = "Unlocking…";
  setFormMessage(byId("sourceUnlockError"));
  try {
    const payload = await sourceAdminRequest("/session", {
      method: "POST",
      body: { adminKey },
      useSession: false,
    });
    keyInput.value = "";
    appState.sourceAdminToken = String(payload.sessionToken || "");
    appState.sourceAdminExpiresAt = String(payload.expiresAt || "");
    appState.sourceAdminError = "";
    if (!hasSourceAdminSession()) throw new Error("The server returned an invalid source-control session.");
    saveSourceAdminSession();
    scheduleSourceAdminExpiry();
    closeDialog(byId("sourceUnlockDialog"));
    await loadSources();
    if (appState.sourceAdminError) {
      const registryError = appState.sourceAdminError;
      try {
        await sourceAdminRequest("/session", { method: "DELETE" });
      } catch {
        // Clearing the in-memory token still leaves the manager fail-closed.
      }
      clearSourceAdminSession();
      throw new Error(registryError);
    }
    renderAll();
    showToast("Source controls unlocked", "Changes are protected for this browser session.");
    if (pendingSourcePreset) {
      const preset = pendingSourcePreset;
      pendingSourcePreset = "";
      openPresetSourceEditor(preset);
    }
  } catch (error) {
    clearSourceAdminSession();
    setFormMessage(byId("sourceUnlockError"), error.message || "Source controls could not be unlocked.");
  } finally {
    keyInput.value = "";
    button.disabled = false;
    button.textContent = "Unlock controls";
  }
}

async function lockSourceControls({ revoke = true, notify = true } = {}) {
  if (revoke && hasSourceAdminSession()) {
    try {
      await sourceAdminRequest("/session", { method: "DELETE" });
    } catch {
      // Local locking must still succeed if the server is unavailable.
    }
  }
  clearSourceAdminSession();
  await loadSources();
  renderAll();
  if (notify) showToast("Source controls locked", "The short-lived administration session was cleared.");
}

let confirmationResolver = null;

function requestConfirmation({ title, message, actionLabel = "Confirm", danger = true }) {
  byId("confirmTitle").textContent = title;
  byId("confirmMessage").textContent = message;
  byId("confirmActionButton").textContent = actionLabel;
  byId("confirmActionButton").className = `button ${danger ? "button-danger" : "button-primary"}`;
  byId("confirmMark").textContent = danger ? "!" : "✓";
  openDialog(byId("confirmDialog"));
  return new Promise((resolve) => {
    confirmationResolver = resolve;
  });
}

function settleConfirmation(result) {
  closeDialog(byId("confirmDialog"));
  if (confirmationResolver) confirmationResolver(result);
  confirmationResolver = null;
}

function readAdminSession() {
  try {
    const session = JSON.parse(sessionStorage.getItem(ADMIN_SESSION_KEY) || "null");
    if (!session?.id || !session?.permissions?.manageUsers || Number(session.expiresAt) <= Date.now()) return null;
    return session;
  } catch {
    return null;
  }
}

function saveAdminSession(user) {
  const session = {
    id: user.id,
    label: user.label,
    role: user.role,
    permissions: user.permissions,
    expiresAt: Date.now() + ADMIN_SESSION_MS,
  };
  sessionStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(session));
  return session;
}

function clearAdminSession() {
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
}

async function authenticateAdmin(id, password) {
  let remoteUser = null;
  let remoteLookupSucceeded = false;
  if (supabaseClient) {
    const { data, error } = await supabaseClient
      .from(USERS_TABLE)
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!error) {
      remoteLookupSucceeded = true;
      if (data) remoteUser = normalizeUser(data);
    }
  }

  const backupUser = window.PAYMENT_TRACKER_USERS?.[id]
    ? normalizeUser({ id, ...window.PAYMENT_TRACKER_USERS[id] })
    : null;
  const user = remoteLookupSucceeded ? remoteUser : (remoteUser || backupUser);
  if (!user || user.password !== password) throw new Error("The user ID or password is incorrect.");
  if (!user.permissions.manageUsers) throw new Error("This account does not have administration access.");
  return user;
}

function revealAdminApp(session) {
  appState.currentUser = session;
  byId("authGate").hidden = true;
  byId("adminApp").hidden = false;
  byId("adminName").textContent = session.label;
  byId("adminAvatar").textContent = initials(session.label);
  void loadWorkspace();
}

async function loadUsers() {
  if (!supabaseClient) {
    appState.users = Object.entries(window.PAYMENT_TRACKER_USERS || {}).map(([id, user]) => normalizeUser({ id, ...user }));
    return;
  }
  const { data, error } = await supabaseClient.from(USERS_TABLE).select("*").order("label", { ascending: true });
  if (error) {
    appState.users = Object.entries(window.PAYMENT_TRACKER_USERS || {}).map(([id, user]) => normalizeUser({ id, ...user }));
    throw new Error(`Live users could not be loaded: ${error.message}`);
  }
  appState.users = (data || []).map(normalizeUser);
}

async function loadSources() {
  const previousPublicCatalog = appState.sourceCatalogAvailable && appState.sources.length
    ? {
      activeSourceId: appState.activeSourceId,
      sources: appState.sources
        .filter((source) => source.enabled)
        .map((source) => normalizeSource({
          id: source.id,
          name: source.name,
          enabled: true,
          isValidated: sourceHasValidatedConfig(source),
          lastTestStatus: sourceHasValidatedConfig(source) ? "success" : "untested",
          isCatalogSummary: true,
        })),
    }
    : null;
  appState.sourceSetupError = "";
  appState.sourceCatalogAvailable = false;
  appState.sourceAdminError = hasSourceAdminSession() ? appState.sourceAdminError : "";
  const previousActive = appState.sources.find((source) => source.id === appState.activeSourceId);
  const remembered = readRememberedActiveSource();
  const lastConfirmedNonQ2 = [previousActive, remembered?.source]
    .find((source) => source && !isExistingQ2Source(source));

  const useLastConfirmed = (message) => {
    if (lastConfirmedNonQ2) {
      appState.sources = [lastConfirmedNonQ2];
      appState.activeSourceId = lastConfirmedNonQ2.id;
      appState.settingsVersion = remembered?.configVersion || appState.settingsVersion || 0;
      appState.sourceSetupError = `${message} Keeping ${lastConfirmedNonQ2.name} as the last confirmed source; Q2 substitution was blocked.`;
      return;
    }
    const q2 = normalizeSource(EXISTING_Q2_SOURCE);
    appState.sources = [q2];
    appState.activeSourceId = q2.id;
    appState.settingsVersion = 0;
    appState.sourceSetupError = `${message} SOA 2026 Q2 PP remains the built-in pre-migration source.`;
  };

  if (hasSourceAdminSession()) {
    try {
      const state = await sourceAdminRequest("/state");
      const sources = (state.sources || []).map(normalizeSource);
      const activeSourceId = String(state.settings?.activeSourceId || "");
      const active = sources.find((source) => source.id === activeSourceId && source.enabled);
      if (!active) throw new Error("The protected registry did not return a valid active source.");
      appState.sources = sources;
      appState.activeSourceId = active.id;
      appState.settingsVersion = Number(state.settings?.version || 0);
      appState.sourceAdminExpiresAt = String(state.sessionExpiresAt || appState.sourceAdminExpiresAt);
      appState.sourceCatalogAvailable = true;
      saveSourceAdminSession();
      rememberActiveSource(active, appState.settingsVersion);
      return;
    } catch (error) {
      appState.sourceAdminError = error.message || "The protected source registry could not be loaded.";
    }
  }

  let publicCatalog = previousPublicCatalog;
  try {
    const catalog = await sourceAdminRequest("/catalog", { useSession: false });
    const rows = Array.isArray(catalog?.sources) ? catalog.sources : [];
    if (!rows.length || rows.length > 100) throw new Error("The public source catalog is invalid.");
    const ids = new Set();
    const sources = rows.map((row) => {
      const id = String(row?.id || "");
      const name = String(row?.name || "").trim();
      if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)
        || !name
        || name.length > 80
        || /[\u0000-\u001f\u007f]/.test(name)
        || typeof row.enabled !== "boolean"
        || typeof row.isValidated !== "boolean"
        || ids.has(id)) {
        throw new Error("The public source catalog is invalid.");
      }
      ids.add(id);
      return normalizeSource({
        id,
        name,
        enabled: row.enabled,
        isValidated: row.isValidated,
        lastTestStatus: row.isValidated ? "success" : "untested",
        isCatalogSummary: true,
      });
    });
    const activeSourceId = String(catalog?.activeSourceId || "");
    if (!sources.length || !sources.some((source) => source.id === activeSourceId && source.enabled)) {
      throw new Error("The public source catalog has no valid active source.");
    }
    publicCatalog = { sources, activeSourceId };
  } catch {
    appState.sourceSetupError = publicCatalog
      ? "The live saved-source list is temporarily unavailable. Showing the last confirmed source list."
      : "The saved-source list is temporarily unavailable. Showing the active source only; no sources were removed.";
  }

  if (!supabaseClient) {
    if (publicCatalog) {
      appState.sources = publicCatalog.sources;
      appState.activeSourceId = publicCatalog.activeSourceId;
      appState.settingsVersion = 0;
      appState.sourceCatalogAvailable = true;
      return;
    }
    useLastConfirmed("Supabase is unavailable, so the active source could not be checked.");
    return;
  }

  try {
    const { data, error } = await supabaseClient.rpc("get_active_app_sheet_source");
    if (error) throw error;
    const response = Array.isArray(data) ? data[0] : data;
    const row = response?.source || response;
    if (!row) throw new Error("No active sheet source is configured.");
    const source = normalizeSource({
      ...row,
      id: row.source_id ?? row.id,
      name: row.source_name ?? row.name,
      last_test_status: row.last_test_status ?? "success",
    });
    if (!source.id || !source.spreadsheet_id || !source.enabled) {
      throw new Error("The active source response is incomplete.");
    }
    const catalogHasActive = publicCatalog?.sources.some((item) => item.id === source.id);
    appState.sources = catalogHasActive
      ? publicCatalog.sources.map((item) => item.id === source.id
        ? { ...item, ...source, isCatalogSummary: true, is_validated: item.is_validated }
        : item)
      : [source];
    appState.activeSourceId = source.id;
    appState.settingsVersion = Number(
      response?.settings_version ?? response?.settingsVersion ?? response?.version ?? 0,
    );
    appState.sourceCatalogAvailable = Boolean(catalogHasActive);
    if (!catalogHasActive && !appState.sourceSetupError) {
      appState.sourceSetupError = "The complete saved-source list is temporarily unavailable. Showing the active source only; no sources were removed.";
    }
    rememberActiveSource(source, appState.settingsVersion);
  } catch (error) {
    if (publicCatalog) {
      appState.sources = publicCatalog.sources;
      appState.activeSourceId = publicCatalog.activeSourceId;
      appState.settingsVersion = 0;
      appState.sourceCatalogAvailable = true;
      return;
    }
    useLastConfirmed(`The saved active-source registry could not be loaded: ${error.message || error}`);
  }
}

async function loadWorkspace() {
  const results = await Promise.allSettled([loadUsers(), loadSources()]);
  results.forEach((result) => {
    if (result.status === "rejected") showToast("Workspace partially loaded", result.reason?.message || String(result.reason), "error");
  });
  renderAll();
}

function renderAll() {
  renderOverview();
  renderUsers();
  renderSources();
  renderBackup();
}

function renderOverview() {
  const active = appState.sources.find((source) => source.id === appState.activeSourceId);
  const adminCount = appState.users.filter((user) => user.role === "admin" && user.permissions.manageUsers).length;
  const validatedCount = appState.sources.filter(sourceHasValidatedConfig).length;
  const sourceDetailsUnlocked = hasSourceAdminSession() && !appState.sourceAdminError;

  byId("userStat").textContent = String(appState.users.length);
  byId("userStatNote").textContent = appState.users.length === 1 ? "1 active account" : `${appState.users.length} active accounts`;
  byId("adminStat").textContent = String(adminCount);
  byId("sourceStat").textContent = String(appState.sources.length);
  byId("sourceStatNote").textContent = `${validatedCount} validated`;
  byId("versionStat").textContent = appState.settingsVersion ? `v${appState.settingsVersion}` : "v–";

  if (active) {
    byId("heroSourceName").textContent = active.name;
    byId("heroSourceMeta").textContent = sourceDetailsUnlocked
      ? `${active.sheet_name} tab · ${active.payment_range} payments · ${active.withdrawal_range} withdrawals`
      : "Current live source · Saved securely in Supabase";
    if (sourceDetailsUnlocked) {
      byId("heroSheetLink").href = sheetUrl(active);
      byId("heroSheetLink").hidden = false;
    } else {
      byId("heroSheetLink").hidden = true;
    }
  } else {
    byId("heroSourceName").textContent = appState.sourceSetupError ? "Configuration required" : "No active source";
    byId("heroSourceMeta").textContent = appState.sourceSetupError || "Choose a tested Google Sheet source to start live operations.";
    byId("heroSheetLink").hidden = true;
  }
}

function permissionSummary(user) {
  const enabled = Object.entries(permissionInfo)
    .filter(([key]) => user.permissions[key])
    .map(([, info]) => info.label);
  return enabled.length ? enabled.join(" · ") : "View-only access";
}

function renderUsers() {
  const search = byId("userSearch").value.trim().toLowerCase();
  const role = byId("roleFilter").value;
  const visibleUsers = appState.users.filter((user) => {
    const matchesSearch = !search || `${user.label} ${user.id}`.toLowerCase().includes(search);
    const matchesRole = role === "all" || user.role === role;
    return matchesSearch && matchesRole;
  });

  byId("userResultCount").textContent = `${visibleUsers.length} ${visibleUsers.length === 1 ? "user" : "users"}`;
  const list = byId("userList");
  if (!visibleUsers.length) {
    list.innerHTML = `<div class="empty-state"><strong>No users found</strong><p>Adjust the search or role filter, or create a new account.</p></div>`;
    return;
  }

  list.innerHTML = visibleUsers.map((user) => `
    <article class="user-card" data-user-id="${escapeHtml(user.id)}">
      <div class="user-identity">
        <span class="avatar">${escapeHtml(initials(user.label))}</span>
        <div><strong>${escapeHtml(user.label)}</strong><span>@${escapeHtml(user.id)}</span></div>
      </div>
      <span class="role-badge ${escapeHtml(user.role)}">${escapeHtml(roleLabels[user.role] || user.role)}</span>
      <div class="user-access"><span class="permission-summary">${escapeHtml(permissionSummary(user))}</span><small>Password configured · ${Object.values(user.permissions).filter(Boolean).length} permissions</small></div>
      <span class="user-updated">Updated ${escapeHtml(formatDate(user.updated_at, "locally"))}</span>
      <div class="user-actions">
        <button class="compact-button" type="button" data-user-action="edit">Edit</button>
        <button class="button-quiet-danger" type="button" data-user-action="delete">Delete</button>
      </div>
    </article>
  `).join("");
}

function renderPermissionGrid(permissions) {
  byId("permissionGrid").innerHTML = Object.entries(permissionInfo).map(([key, info]) => `
    <label class="permission-option">
      <input type="checkbox" data-permission="${key}" ${permissions[key] ? "checked" : ""} />
      <span><strong>${escapeHtml(info.label)}</strong><small>${escapeHtml(info.description)}</small></span>
    </label>
  `).join("");
}

function sourceHasValidatedConfig(source) {
  if (!source.enabled) return false;
  if (source.isCatalogSummary) return source.is_validated;
  return source.last_test_status === "success"
    && Number(source.tested_config_version) === Number(source.config_version);
}

function sourceTestIsCurrent(source) {
  if (!sourceHasValidatedConfig(source) || source.isCatalogSummary) return false;
  const testedAt = new Date(source.last_tested_at).getTime();
  return Number.isFinite(testedAt) && testedAt > Date.now() - SOURCE_TEST_FRESH_MS;
}

function openUserEditor(userId = "") {
  const user = appState.users.find((item) => item.id === userId);
  appState.editingUserId = user?.id || "";
  const role = user?.role || "viewer";
  byId("userDialogTitle").textContent = user ? `Edit ${user.label}` : "Add user";
  byId("userNameInput").value = user?.label || "";
  byId("userIdInput").value = user?.id || "";
  byId("userIdInput").readOnly = Boolean(user);
  byId("userRoleInput").value = role;
  byId("userPasswordInput").value = "";
  byId("userPasswordInput").type = "password";
  byId("togglePasswordButton").textContent = "Show";
  byId("passwordFieldLabel").textContent = user ? "New password" : "Password";
  byId("passwordHelp").textContent = user ? "Leave blank to keep the current password." : "Required for a new account.";
  renderPermissionGrid(user?.permissions || roleDefaults[role]);
  setFormMessage(byId("userFormError"));
  openDialog(byId("userDialog"));
  window.setTimeout(() => byId("userNameInput").focus(), 0);
}

function collectPermissions() {
  return Object.fromEntries(
    [...byId("permissionGrid").querySelectorAll("[data-permission]")]
      .map((input) => [input.dataset.permission, input.checked]),
  );
}

async function saveUser(event) {
  event.preventDefault();
  const existing = appState.users.find((user) => user.id === appState.editingUserId);
  const id = normalizeId(byId("userIdInput").value);
  const label = byId("userNameInput").value.trim();
  const role = byId("userRoleInput").value;
  const suppliedPassword = byId("userPasswordInput").value;
  const password = suppliedPassword || existing?.password || "";
  const permissions = collectPermissions();

  if (!id || id.length < 2) return setFormMessage(byId("userFormError"), "Enter a valid user ID with at least two characters.");
  if (!label) return setFormMessage(byId("userFormError"), "Enter the user's name.");
  if (!password) return setFormMessage(byId("userFormError"), "Create a password for the new account.");
  if (!existing && appState.users.some((user) => user.id === id)) return setFormMessage(byId("userFormError"), "That user ID already exists.");

  if (existing?.id === appState.currentUser?.id && (!permissions.manageUsers || role !== "admin")) {
    return setFormMessage(byId("userFormError"), "You cannot remove your own administrator access while signed in.");
  }

  const otherAdmins = appState.users.filter((user) => user.id !== existing?.id && user.role === "admin" && user.permissions.manageUsers);
  if (existing?.role === "admin" && existing.permissions.manageUsers && role !== "admin" && !otherAdmins.length) {
    return setFormMessage(byId("userFormError"), "Keep at least one administrator with administration access.");
  }

  const saveButton = byId("saveUserButton");
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";
  setFormMessage(byId("userFormError"));
  const row = { id, label, role, password, permissions, updated_at: new Date().toISOString() };

  try {
    if (!supabaseClient) throw new Error("Supabase is unavailable.");
    const { error } = await supabaseClient.from(USERS_TABLE).upsert(row, { onConflict: "id" });
    if (error) throw error;
    const nextUser = normalizeUser(row);
    appState.users = existing
      ? appState.users.map((user) => (user.id === existing.id ? nextUser : user))
      : [...appState.users, nextUser];
    closeDialog(byId("userDialog"));
    renderAll();
    showToast(existing ? "User updated" : "User created", `${label} can use the live app on the next sign-in.`);
  } catch (error) {
    setFormMessage(byId("userFormError"), error.message || "The user could not be saved.");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save user";
  }
}

async function deleteUser(userId) {
  const user = appState.users.find((item) => item.id === userId);
  if (!user) return;
  if (user.id === appState.currentUser?.id) return showToast("Cannot delete this account", "Sign in as another administrator first.", "error");
  const otherAdmins = appState.users.filter((item) => item.id !== user.id && item.role === "admin" && item.permissions.manageUsers);
  if (user.role === "admin" && user.permissions.manageUsers && !otherAdmins.length) {
    return showToast("Keep one administrator", "Create another administrator before deleting this account.", "error");
  }

  const confirmed = await requestConfirmation({
    title: `Delete ${user.label}?`,
    message: "This removes their live login immediately. The action cannot be undone from this screen.",
    actionLabel: "Delete user",
  });
  if (!confirmed) return;

  const { error } = await supabaseClient.from(USERS_TABLE).delete().eq("id", user.id);
  if (error) return showToast("User was not deleted", error.message, "error");
  appState.users = appState.users.filter((item) => item.id !== user.id);
  renderAll();
  showToast("User deleted", `${user.label}'s login was removed.`);
}

function renderSources() {
  const sourceSessionActive = hasSourceAdminSession();
  const sourceControlsUnlocked = sourceSessionActive && !appState.sourceAdminError;
  const alert = byId("sourceSetupAlert");
  alert.textContent = appState.sourceSetupError;
  alert.hidden = !appState.sourceSetupError;

  byId("sourceAccessCard").classList.toggle("unlocked", sourceControlsUnlocked);
  byId("sourceAccessStatus").textContent = sourceControlsUnlocked
    ? "Protected session active"
    : (sourceSessionActive ? "Source registry unavailable" : "Source controls locked");
  byId("sourceAccessMeta").textContent = sourceControlsUnlocked
    ? `Create, test, and activate sources until ${formatDate(appState.sourceAdminExpiresAt, "this session expires")}.`
    : (appState.sourceAdminError || (appState.sourceCatalogAvailable
      ? "Saved sources remain visible here. Unlock only when you want to test, edit, or activate one."
      : "Unlock with the dedicated source-control key to make production changes."));
  byId("unlockSourcesButton").hidden = sourceSessionActive;
  byId("lockSourcesButton").hidden = !sourceSessionActive;
  byId("addSourceButton").disabled = sourceSessionActive && !sourceControlsUnlocked;
  byId("addSourceButton").textContent = sourceSessionActive && !sourceControlsUnlocked
    ? "Registry unavailable"
    : "Add Q3 source";

  const active = appState.sources.find((source) => source.id === appState.activeSourceId);
  if (active) {
    byId("activeSourceName").textContent = active.name;
    if (sourceControlsUnlocked) {
      const verificationLabel = active.last_tested_at
        ? `Verified ${formatDate(active.last_tested_at)}`
        : (active.isFallback ? "Current pre-migration source" : "Verified production source");
      byId("activeSourceMeta").textContent = `${active.sheet_name} · Payments ${active.payment_range} · Withdrawals ${active.withdrawal_range} · ${verificationLabel}`;
      byId("activeSourceLink").href = sheetUrl(active);
      byId("activeSourceLink").hidden = false;
    } else {
      byId("activeSourceMeta").textContent = "Serving live now · Saved securely in Supabase · Protected details locked";
      byId("activeSourceLink").hidden = true;
    }
  } else {
    byId("activeSourceName").textContent = "No active source";
    byId("activeSourceMeta").textContent = "Add and test a Google Sheet source before activation.";
    byId("activeSourceLink").hidden = true;
  }

  byId("sourceCount").textContent = sourceControlsUnlocked || appState.sourceCatalogAvailable
    ? `${appState.sources.length} saved ${appState.sources.length === 1 ? "source" : "sources"}`
    : "Active source only";
  const list = byId("sourceList");
  if (!appState.sources.length) {
    list.innerHTML = `<div class="empty-state"><strong>No data sources available</strong><p>${escapeHtml(appState.sourceSetupError || "Add the current workbook, test the connection, and activate it.")}</p></div>`;
    return;
  }

  list.innerHTML = appState.sources.map((source) => {
    const isActive = source.id === appState.activeSourceId;
    const hasValidatedConfig = sourceHasValidatedConfig(source);
    const testIsCurrent = sourceTestIsCurrent(source);
    const status = !source.enabled
      ? "error"
      : isActive
        ? "active"
      : (testIsCurrent || hasValidatedConfig) ? "success" : source.last_test_status;
    const statusLabel = !source.enabled
      ? "Disabled"
      : isActive
        ? "Active"
      : sourceControlsUnlocked && testIsCurrent
        ? "Ready"
        : hasValidatedConfig
          ? "Waiting"
          : source.last_test_status === "error"
            ? "Needs attention"
            : source.last_test_status === "testing" ? "Testing" : "Saved";

    const lockedDetails = `
      <div class="source-meta-grid">
        <div><span>Storage</span><strong>Saved in Supabase</strong></div>
        <div><span>State</span><strong>${isActive ? "Serving live now" : hasValidatedConfig ? "Waiting for activation" : "Needs connection test"}</strong></div>
      </div>
      <p class="source-test-note">${isActive
        ? "This source is currently live."
        : hasValidatedConfig
          ? "Saved and waiting for you. Retest immediately before activation."
          : "Saved safely. Unlock controls to test it before activation."}</p>
      <div class="source-actions">
        <button class="compact-button ${!isActive && hasValidatedConfig ? "activate" : ""}" type="button" data-source-action="unlock">${!isActive && hasValidatedConfig ? "Unlock to activate" : "Unlock to manage"}</button>
      </div>
    `;

    const testNote = !isActive && hasValidatedConfig && !testIsCurrent
      ? "Saved and validated. Run Test connection when you are ready to activate it."
      : source.last_test_message || (source.last_tested_at ? `Last tested ${formatDate(source.last_tested_at)}` : "Test access and row layout before activation.");
    const unlockedDetails = `
      <div class="source-meta-grid">
        <div><span>Worksheet</span><strong>${escapeHtml(source.sheet_name)} · gid ${escapeHtml(source.sheet_gid)}</strong></div>
        <div><span>Spreadsheet ID</span><strong title="${escapeHtml(source.spreadsheet_id)}">${escapeHtml(source.spreadsheet_id)}</strong></div>
        <div><span>Payments</span><strong>${escapeHtml(source.payment_range)}</strong></div>
        <div><span>Withdrawals</span><strong>${escapeHtml(source.withdrawal_range)}</strong></div>
      </div>
      <p class="source-test-note">${escapeHtml(testNote)}</p>
      <div class="source-actions">
        ${!source.isFallback ? `<button class="compact-button" type="button" data-source-action="test" ${source.last_test_status === "testing" ? "disabled" : ""}>${source.last_test_status === "testing" ? "Testing…" : "Test connection"}</button>` : ""}
        ${!isActive ? `<button class="compact-button" type="button" data-source-action="edit">Edit</button>` : ""}
        ${!isActive && testIsCurrent ? `<button class="compact-button activate" type="button" data-source-action="activate">Activate</button>` : ""}
        <a class="compact-button button" href="${escapeHtml(sheetUrl(source))}" target="_blank" rel="noreferrer">Open</a>
        ${!isActive ? `<button class="button-quiet-danger" type="button" data-source-action="delete">Delete</button>` : ""}
      </div>
    `;
    return `
      <article class="source-card ${isActive ? "active" : ""}" data-source-id="${escapeHtml(source.id)}">
        <div class="source-card-head">
          <div><h4>${escapeHtml(source.name)}</h4><p class="source-key">${escapeHtml(source.id)}</p></div>
          <span class="source-status ${escapeHtml(status)}">${escapeHtml(statusLabel)}</span>
        </div>
        ${sourceControlsUnlocked ? unlockedDetails : lockedDetails}
      </article>
    `;
  }).join("");
}

let sourceIdManuallyEdited = false;

function openPresetSourceEditor(presetId) {
  const preset = sourcePresets[presetId];
  const existing = preset && appState.sources.find((source) => source.id === preset.id);
  openSourceEditor(existing?.id || "", presetId);
}

function openSourceEditor(sourceId = "", presetId = "") {
  if (!hasSourceAdminSession()) {
    pendingSourcePreset = presetId;
    openSourceUnlock();
    return;
  }
  if (appState.sourceAdminError) {
    return showToast("Source registry unavailable", appState.sourceAdminError, "error");
  }
  if (appState.sourceSetupError) {
    return showToast("Source registry unavailable", appState.sourceSetupError, "error");
  }
  const source = appState.sources.find((item) => item.id === sourceId);
  const preset = source ? null : sourcePresets[presetId];
  if (source?.id === appState.activeSourceId) {
    return showToast("Active source is protected", "Activate another tested source before editing this connection.", "error");
  }
  appState.editingSourceId = source?.id || "";
  sourceIdManuallyEdited = Boolean(source || preset);
  byId("sourceDialogTitle").textContent = source ? `Edit ${source.name}` : (preset ? "Add SOA 2026 Q3" : "Add data source");
  byId("sourceNameInput").value = source?.name || preset?.name || "";
  byId("sourceIdInput").value = source?.id || preset?.id || "";
  byId("sourceIdInput").readOnly = Boolean(source);
  byId("spreadsheetInput").value = source ? sheetUrl(source) : "";
  byId("sheetNameInput").value = source?.sheet_name || preset?.sheet_name || "PP";
  byId("sheetGidInput").value = source?.sheet_gid || preset?.sheet_gid || "0";
  byId("paymentRangeInput").value = source?.payment_range || preset?.payment_range || "A7:J200";
  byId("withdrawalRangeInput").value = source?.withdrawal_range || preset?.withdrawal_range || "L26:N200";
  setFormMessage(byId("sourceFormError"));
  openDialog(byId("sourceDialog"));
  window.setTimeout(() => byId("sourceNameInput").focus(), 0);
}

function extractSheetDetails(value) {
  const input = String(value || "").trim();
  const idMatch = input.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  const gidMatch = input.match(/[?#&]gid=(\d+)/);
  return {
    spreadsheetId: idMatch?.[1] || input,
    gid: gidMatch?.[1] || "",
  };
}

function normalizeRange(value) {
  const range = String(value || "").trim().split("!").pop().replace(/'/g, "").toUpperCase();
  return range;
}

async function saveSource(event) {
  event.preventDefault();
  const existing = appState.sources.find((source) => source.id === appState.editingSourceId);
  const name = byId("sourceNameInput").value.trim();
  const id = normalizeId(byId("sourceIdInput").value || name);
  const details = extractSheetDetails(byId("spreadsheetInput").value);
  const sheetName = byId("sheetNameInput").value.trim();
  const sheetGid = details.gid || byId("sheetGidInput").value.trim();
  const paymentRange = normalizeRange(byId("paymentRangeInput").value);
  const withdrawalRange = normalizeRange(byId("withdrawalRangeInput").value);

  if (!name) return setFormMessage(byId("sourceFormError"), "Enter a clear source name, such as SOA Q3 2026.");
  if (!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(id)) return setFormMessage(byId("sourceFormError"), "Enter a valid source key with at least two characters.");
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(details.spreadsheetId)) return setFormMessage(byId("sourceFormError"), "Paste a valid Google Sheet URL or spreadsheet ID.");
  if (!sheetName) return setFormMessage(byId("sourceFormError"), "Enter the worksheet tab name.");
  if (!/^\d+$/.test(sheetGid)) return setFormMessage(byId("sourceFormError"), "The tab gid must contain numbers only.");
  if (!/^[A-Z]+\d+:[A-Z]+\d+$/.test(paymentRange)) return setFormMessage(byId("sourceFormError"), "Use an A1 payment range such as A7:J200.");
  if (!/^[A-Z]+\d+:[A-Z]+\d+$/.test(withdrawalRange)) return setFormMessage(byId("sourceFormError"), "Use an A1 withdrawal range such as L26:N200.");
  if (!existing && appState.sources.some((source) => source.id === id)) return setFormMessage(byId("sourceFormError"), "That source key already exists.");

  const sourceInput = {
    id,
    name,
    spreadsheetId: details.spreadsheetId,
    sheetName,
    sheetGid,
    paymentRange,
    withdrawalRange,
    layoutKey: "pp-v1",
    enabled: true,
  };

  const button = byId("saveSourceButton");
  button.disabled = true;
  button.textContent = "Saving…";
  setFormMessage(byId("sourceFormError"));
  try {
    const body = existing ? { ...sourceInput } : sourceInput;
    if (existing) delete body.id;
    await sourceAdminRequest(existing ? `/sources/${encodeURIComponent(existing.id)}` : "/sources", {
      method: existing ? "PATCH" : "POST",
      body,
    });
    closeDialog(byId("sourceDialog"));
    await loadSources();
    renderAll();
    showToast(existing ? "Source updated" : "Source added", "Run Test connection before activating it.");
  } catch (error) {
    setFormMessage(byId("sourceFormError"), error.message || "The source could not be saved.");
  } finally {
    button.disabled = false;
    button.textContent = "Save source";
  }
}

async function testSource(sourceId) {
  if (!hasSourceAdminSession()) return openSourceUnlock();
  const source = appState.sources.find((item) => item.id === sourceId);
  if (!source) return;
  source.last_test_status = "testing";
  source.last_test_message = "Connecting securely to Google Sheets…";
  renderSources();

  try {
    const payload = await sourceAdminRequest(`/sources/${encodeURIComponent(source.id)}/test`, {
      method: "POST",
      body: {},
    });
    await loadSources();
    renderAll();
    const payments = Number(payload.test?.paymentRowCount || 0);
    const withdrawals = Number(payload.test?.withdrawalRowCount || 0);
    showToast("Connection verified", `${payments} payment tasks · ${withdrawals} withdrawals`);
  } catch (error) {
    if (hasSourceAdminSession()) {
      await loadSources().catch(() => {});
      renderAll();
    } else {
      renderSources();
    }
    showToast("Connection failed", error.message || "The Google Sheet connection failed.", "error");
  }
}

async function activateSource(sourceId) {
  if (!hasSourceAdminSession()) return openSourceUnlock();
  const source = appState.sources.find((item) => item.id === sourceId);
  if (!source || source.id === appState.activeSourceId) return;
  if (!sourceTestIsCurrent(source)) return showToast("Test required", "Verify this exact source configuration before activation.", "error");

  const active = appState.sources.find((item) => item.id === appState.activeSourceId);
  const confirmed = await requestConfirmation({
    title: `Activate ${source.name}?`,
    message: `Every device will switch from ${active?.name || "the current source"} to ${source.name}. The previous source will remain available for rollback.`,
    actionLabel: "Activate source",
    danger: false,
  });
  if (!confirmed) return;

  try {
    await sourceAdminRequest(`/sources/${encodeURIComponent(source.id)}/activate`, {
      method: "POST",
      body: { expectedVersion: appState.settingsVersion },
    });
  } catch (error) {
    await loadSources();
    renderAll();
    return showToast("Source was not activated", error.message, "error");
  }

  await loadSources();
  renderAll();
  showToast("Source activated", `${source.name} is now live. The app will refresh automatically within 20 seconds.`);
}

async function deleteSource(sourceId) {
  if (!hasSourceAdminSession()) return openSourceUnlock();
  const source = appState.sources.find((item) => item.id === sourceId);
  if (!source || source.id === appState.activeSourceId) return;
  const confirmed = await requestConfirmation({
    title: `Delete ${source.name}?`,
    message: "The saved connection will be removed. This does not delete or modify the Google Sheet.",
    actionLabel: "Delete source",
  });
  if (!confirmed) return;

  try {
    await sourceAdminRequest(`/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" });
    await loadSources();
    renderAll();
    showToast("Source deleted", `${source.name} was removed from the registry.`);
  } catch (error) {
    showToast("Source was not deleted", error.message || "The source could not be deleted.", "error");
  }
}

function renderBackup() {
  const users = Object.fromEntries(
    appState.users.map((user) => [user.id, {
      password: user.password,
      role: user.role,
      label: user.label,
      permissions: user.permissions,
    }]),
  );
  byId("backupOutput").value = `window.PAYMENT_TRACKER_USERS = ${JSON.stringify(users, null, 2)};\n`;
}

function selectView(view) {
  const titles = {
    overview: ["Overview", "Control center"],
    users: ["Users", "Access management"],
    sources: ["Data sources", "Google Sheets"],
    advanced: ["Advanced", "System utilities"],
  };
  if (!titles[view]) return;
  appState.activeView = view;
  document.querySelectorAll(".admin-view").forEach((section) => {
    section.hidden = section.dataset.section !== view;
  });
  document.querySelectorAll("[data-view]").forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  byId("breadcrumbLabel").textContent = titles[view][0];
  byId("pageTitle").textContent = titles[view][1];
  history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("payment-tracker-admin-theme", next);
  byId("themeButton").textContent = next === "dark" ? "Switch to light" : "Switch to dark";
}

async function signOutAdmin() {
  if (hasSourceAdminSession()) {
    try {
      await sourceAdminRequest("/session", { method: "DELETE" });
    } catch {
      // Signing out locally must not depend on network availability.
    }
  }
  clearSourceAdminSession();
  clearAdminSession();
  window.location.reload();
}

byId("adminLoginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = byId("adminLoginButton");
  button.disabled = true;
  button.textContent = "Checking access…";
  setFormMessage(byId("adminLoginError"));
  try {
    const id = byId("adminLoginId").value.trim().toLowerCase();
    const password = byId("adminLoginPassword").value;
    const user = await authenticateAdmin(id, password);
    byId("adminLoginPassword").value = "";
    revealAdminApp(saveAdminSession(user));
  } catch (error) {
    setFormMessage(byId("adminLoginError"), error.message || "Administration access was not granted.");
  } finally {
    button.disabled = false;
    button.textContent = "Enter admin console";
  }
});

document.querySelectorAll("[data-view]").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});

document.querySelectorAll("[data-quick-view]").forEach((button) => {
  button.addEventListener("click", () => {
    selectView(button.dataset.quickView);
    if (button.dataset.quickView === "users") openUserEditor();
    if (button.dataset.sourcePreset) openPresetSourceEditor(button.dataset.sourcePreset);
  });
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => closeDialog(byId(button.dataset.closeDialog)));
});

byId("switchSourceButton").addEventListener("click", () => selectView("sources"));
byId("addUserButton").addEventListener("click", () => openUserEditor());
byId("addSourceButton").addEventListener("click", () => {
  openPresetSourceEditor("q3");
});
byId("userForm").addEventListener("submit", saveUser);
byId("sourceForm").addEventListener("submit", saveSource);
byId("sourceUnlockForm").addEventListener("submit", unlockSourceControls);
byId("unlockSourcesButton").addEventListener("click", openSourceUnlock);
byId("lockSourcesButton").addEventListener("click", () => void lockSourceControls());
byId("userSearch").addEventListener("input", renderUsers);
byId("roleFilter").addEventListener("change", renderUsers);

byId("userRoleInput").addEventListener("change", (event) => {
  renderPermissionGrid(roleDefaults[event.target.value] || roleDefaults.viewer);
});

byId("togglePasswordButton").addEventListener("click", () => {
  const input = byId("userPasswordInput");
  input.type = input.type === "password" ? "text" : "password";
  byId("togglePasswordButton").textContent = input.type === "password" ? "Show" : "Hide";
});

byId("sourceNameInput").addEventListener("input", (event) => {
  if (!sourceIdManuallyEdited) byId("sourceIdInput").value = normalizeId(event.target.value);
});

byId("sourceIdInput").addEventListener("input", (event) => {
  sourceIdManuallyEdited = true;
  event.target.value = normalizeId(event.target.value);
});

byId("spreadsheetInput").addEventListener("input", (event) => {
  const details = extractSheetDetails(event.target.value);
  if (details.gid) byId("sheetGidInput").value = details.gid;
});

byId("userList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-user-action]");
  const card = button?.closest("[data-user-id]");
  if (!button || !card) return;
  if (button.dataset.userAction === "edit") openUserEditor(card.dataset.userId);
  if (button.dataset.userAction === "delete") void deleteUser(card.dataset.userId);
});

byId("sourceList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-source-action]");
  const card = button?.closest("[data-source-id]");
  if (!button || !card) return;
  const sourceId = card.dataset.sourceId;
  if (button.dataset.sourceAction === "test") void testSource(sourceId);
  if (button.dataset.sourceAction === "edit") openSourceEditor(sourceId);
  if (button.dataset.sourceAction === "activate") void activateSource(sourceId);
  if (button.dataset.sourceAction === "delete") void deleteSource(sourceId);
  if (button.dataset.sourceAction === "unlock") openSourceUnlock();
});

byId("confirmForm").addEventListener("submit", (event) => {
  event.preventDefault();
  settleConfirmation(true);
});
byId("confirmCancelButton").addEventListener("click", () => settleConfirmation(false));
byId("confirmDialog").addEventListener("cancel", (event) => {
  event.preventDefault();
  settleConfirmation(false);
});

byId("copyBackupButton").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(byId("backupOutput").value);
    showToast("Backup copied", "users.js is ready to paste into the project.");
  } catch {
    byId("backupOutput").select();
    showToast("Select and copy", "Clipboard access was blocked, so the backup text is selected.", "error");
  }
});

byId("downloadBackupButton").addEventListener("click", () => {
  const blob = new Blob([byId("backupOutput").value], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "users.js";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Backup downloaded", "users.js was created successfully.");
});

byId("themeButton").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

byId("profileButton").addEventListener("click", (event) => {
  event.stopPropagation();
  const menu = byId("profileMenu");
  menu.hidden = !menu.hidden;
  byId("profileButton").setAttribute("aria-expanded", menu.hidden ? "false" : "true");
});

byId("profileMenu").addEventListener("click", (event) => event.stopPropagation());
document.addEventListener("click", () => {
  byId("profileMenu").hidden = true;
  byId("profileButton").setAttribute("aria-expanded", "false");
});

byId("headerThemeButton").addEventListener("click", () => {
  applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  byId("profileMenu").hidden = true;
});
byId("adminSignOutButton").addEventListener("click", signOutAdmin);
byId("headerSignOutButton").addEventListener("click", signOutAdmin);

applyTheme(localStorage.getItem("payment-tracker-admin-theme") || "dark");
const initialView = location.hash.slice(1);
selectView(["overview", "users", "sources", "advanced"].includes(initialView) ? initialView : "overview");
const savedSession = readAdminSession();
if (savedSession) {
  restoreSourceAdminSession();
  revealAdminApp(savedSession);
} else {
  clearSourceAdminSession();
  window.setTimeout(() => byId("adminLoginId").focus(), 0);
}
