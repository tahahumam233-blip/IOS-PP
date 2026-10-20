const DEFAULT_SHEET_SOURCE = Object.freeze({
  id: "soa-current",
  name: "SOA 2026 Q2 PP",
  spreadsheetId: "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw",
  sheetName: "PP",
  sheetGid: "0",
  paymentRange: "A7:J200",
  withdrawalRange: "L26:N200",
  layoutKey: "pp-v1",
  configVersion: 0,
});
const SHEET_DATA_URL = "sheet-data.json";
const SHEET_REQUEST_TIMEOUT_MS = 15000;
const SHEET_AUTO_REFRESH_MS = 20000;
const BAGHDAD_TIME_ZONE = "Asia/Baghdad";
const STORAGE_KEY = "zaki-payment-task-state";
const SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const SHEET_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/sheet-data`;
const ACTIVE_SHEET_SOURCE_STORAGE_KEY = "payment-tracker-active-sheet-source-v1";
const RECEIPTS_BUCKET = "IOS-PP- Receipts";
const SLACK_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/hyper-action`;
const ZAPIER_DRAFT_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/22095219/uvk15pv/";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function readRememberedSheetSource() {
  try {
    const saved = JSON.parse(localStorage.getItem(ACTIVE_SHEET_SOURCE_STORAGE_KEY) || "null");
    const paymentRange = String(saved?.paymentRange || "").toUpperCase();
    const withdrawalRange = String(saved?.withdrawalRange || "").toUpperCase();
    if (
      !saved?.id
      || !saved?.spreadsheetId
      || !saved?.sheetName
      || !/^\d+$/.test(String(saved?.sheetGid ?? ""))
      || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(paymentRange)
      || !/^[A-Z]+\d+:[A-Z]+\d+$/.test(withdrawalRange)
      || !saved?.layoutKey
    ) return null;

    const configVersion = Number(saved.configVersion);
    return {
      ...DEFAULT_SHEET_SOURCE,
      ...saved,
      sheetGid: String(saved.sheetGid),
      paymentRange,
      withdrawalRange,
      configVersion: Number.isFinite(configVersion) ? configVersion : 0,
    };
  } catch {
    return null;
  }
}

const rememberedSheetSource = readRememberedSheetSource();

const demoPayments = [
  { id: "payment-demo-1", type: "payment", name: "Al Noor Trading", iqd: 1850000, usd: 420 },
  { id: "payment-demo-2", type: "payment", name: "Baghdad Mobile Parts", iqd: 2450000, usd: 680 },
  { id: "payment-demo-3", type: "payment", name: "Erbil Pro Supply", iqd: 3210000, usd: 910 },
];

const demoWithdrawals = [
  { id: "withdrawal-demo-1", type: "withdrawal", name: "Zaki Cash Run", iqd: 1500000, usd: 0 },
  { id: "withdrawal-demo-2", type: "withdrawal", name: "Market Purchases", iqd: 0, usd: 350 },
];

const state = {
  payments: demoPayments,
  withdrawals: demoWithdrawals,
  activeType: "payment",
  source: "Demo preview",
  sourceMode: "demo",
  sheetSource: rememberedSheetSource || { ...DEFAULT_SHEET_SOURCE },
  loading: false,
  syncing: false,
  uploadJobs: {},
  statusQueue: [],
  showingStatus: false,
  audioContext: null,
  audioUnlocked: false,
  savingExchange: false,
  activeUploadTaskId: "",
  taskState: JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
};

const els = {
  clock: document.querySelector("#clock"),
  connectionLabel: document.querySelector("#connectionLabel"),
  sheetName: document.querySelector("#sheetName"),
  lastUpdated: document.querySelector("#lastUpdated"),
  updateButton: document.querySelector("#updateButton"),
  uploadProgress: document.querySelector("#uploadProgress"),
  uploadProgressBar: document.querySelector("#uploadProgressBar"),
  uploadJobs: document.querySelector("#uploadJobs"),
  paymentsTab: document.querySelector("#paymentsTab"),
  withdrawalsTab: document.querySelector("#withdrawalsTab"),
  exchangeTab: document.querySelector("#exchangeTab"),
  metrics: document.querySelector("#metrics"),
  taskTypeLabel: document.querySelector("#taskTypeLabel"),
  taskList: document.querySelector("#taskList"),
  exchangePanel: document.querySelector("#exchangePanel"),
  exchangeSide: document.querySelector("#exchangeSide"),
  exchangeAmountA: document.querySelector("#exchangeAmountA"),
  exchangeAmountB: document.querySelector("#exchangeAmountB"),
  exchangeRate: document.querySelector("#exchangeRate"),
  saveExchangeButton: document.querySelector("#saveExchangeButton"),
  gridWrap: document.querySelector(".grid-wrap"),
  uploadModal: document.querySelector("#uploadModal"),
  uploadForm: document.querySelector("#uploadForm"),
  uploadTaskName: document.querySelector("#uploadTaskName"),
  closeUploadModal: document.querySelector("#closeUploadModal"),
  modalFileInput: document.querySelector("#modalFileInput"),
  modalUploadNote: document.querySelector("#modalUploadNote"),
  modalSaveButton: document.querySelector("#modalSaveButton"),
  successModal: document.querySelector("#successModal"),
  successTitle: document.querySelector("#successTitle"),
  successMessage: document.querySelector("#successMessage"),
  successOkButton: document.querySelector("#successOkButton"),
  rowCount: document.querySelector("#rowCount"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  sheetLink: document.querySelector("#sheetLink"),
  createPaymentDraftButton: document.querySelector("#createPaymentDraftButton"),
  copyPaymentEmailTopButton: document.querySelector("#copyPaymentEmailTopButton"),
  copyPaymentEmailButton: document.querySelector("#copyPaymentEmailButton"),
  createWithdrawalDraftButton: document.querySelector("#createWithdrawalDraftButton"),
  priorityModal: document.querySelector("#priorityModal"),
  priorityTaskName: document.querySelector("#priorityTaskName"),
  priorityLevel: document.querySelector("#priorityLevel"),
  priorityNote: document.querySelector("#priorityNote"),
  closePriorityModal: document.querySelector("#closePriorityModal"),
  prioritySaveButton: document.querySelector("#prioritySaveButton"),
};

function tickClock() {
  if (!els.clock) return;
  els.clock.textContent = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function todayKey() {
  const now = new Date();
  const taskDate = new Date(now);
  if (now.getHours() >= 23) taskDate.setDate(taskDate.getDate() + 1);
  return new Intl.DateTimeFormat("en-CA").format(taskDate);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseAmount(value) {
  const raw = String(value ?? "").trim();
  if (raw.startsWith("=")) return 0;
  const cleaned = raw
    .replace(/[^\d.-]/g, "")
    .trim();
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : 0;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function stripSheetNameFromRange(value, fallback) {
  const range = String(value || fallback || "").split("!").pop().replace(/'/g, "").trim();
  return /^[A-Za-z]+\d+:[A-Za-z]+\d+$/.test(range) ? range.toUpperCase() : fallback;
}

function getRangeStartRow(value, fallback) {
  const range = stripSheetNameFromRange(value, "");
  const match = range.match(/^[A-Za-z]+(\d+):/);
  return match ? Number(match[1]) : fallback;
}

function normalizeSheetSource(source = {}) {
  const current = state?.sheetSource || DEFAULT_SHEET_SOURCE;
  const spreadsheetId = String(source.spreadsheetId || source.spreadsheet_id || current.spreadsheetId);
  const sheetGid = String(source.sheetGid ?? source.sheet_gid ?? current.sheetGid);
  return {
    id: String(source.sourceId || source.id || current.id),
    name: String(source.sourceName || source.name || current.name),
    spreadsheetId,
    sheetName: String(source.sheetName || source.sheet_name || current.sheetName),
    sheetGid,
    paymentRange: stripSheetNameFromRange(
      source.paymentRange || source.payment_range,
      current.paymentRange,
    ),
    withdrawalRange: stripSheetNameFromRange(
      source.withdrawalRange || source.withdrawal_range,
      current.withdrawalRange,
    ),
    layoutKey: String(source.layoutKey || source.layout_key || current.layoutKey),
    configVersion: Number(source.configVersion ?? source.version ?? 0),
    sheetUrl: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit?gid=${sheetGid}#gid=${sheetGid}`,
  };
}

function rememberSheetSource(source) {
  try {
    localStorage.setItem(ACTIVE_SHEET_SOURCE_STORAGE_KEY, JSON.stringify({
      id: source.id,
      name: source.name,
      spreadsheetId: source.spreadsheetId,
      sheetName: source.sheetName,
      sheetGid: source.sheetGid,
      paymentRange: source.paymentRange,
      withdrawalRange: source.withdrawalRange,
      layoutKey: source.layoutKey,
      configVersion: source.configVersion,
      sheetUrl: source.sheetUrl,
    }));
  } catch {
    // Loading the live source should still work if browser storage is unavailable.
  }
}

function applySheetSource(source = {}, { remember = false } = {}) {
  state.sheetSource = normalizeSheetSource(source);
  if (remember) rememberSheetSource(state.sheetSource);
  if (els.sheetName) els.sheetName.textContent = state.sheetSource.name;
  if (els.sheetLink) els.sheetLink.href = state.sheetSource.sheetUrl;
  return state.sheetSource;
}

function sheetSourceIdentity(source = {}) {
  const configVersion = source.configVersion ?? source.version;
  return {
    id: String(source.sourceId ?? source.id ?? ""),
    spreadsheetId: String(source.spreadsheetId ?? source.spreadsheet_id ?? ""),
    sheetName: String(source.sheetName ?? source.sheet_name ?? ""),
    sheetGid: String(source.sheetGid ?? source.sheet_gid ?? ""),
    paymentRange: stripSheetNameFromRange(source.paymentRange ?? source.payment_range, ""),
    withdrawalRange: stripSheetNameFromRange(source.withdrawalRange ?? source.withdrawal_range, ""),
    layoutKey: String(source.layoutKey ?? source.layout_key ?? ""),
    configVersion: configVersion === undefined || configVersion === null || configVersion === ""
      ? null
      : Number(configVersion),
  };
}

function assertSheetSourceIdentity(payload, expectedSource, context) {
  const expected = sheetSourceIdentity(expectedSource);
  const actual = sheetSourceIdentity(payload);
  const fields = [
    ["id", "source ID"],
    ["spreadsheetId", "spreadsheet ID"],
    ["sheetName", "worksheet name"],
    ["sheetGid", "worksheet gid"],
    ["paymentRange", "payment range"],
    ["withdrawalRange", "withdrawal range"],
    ["layoutKey", "layout key"],
  ];
  const problems = [];

  fields.forEach(([key, label]) => {
    if (!actual[key]) problems.push(`${label} is missing`);
    else if (actual[key] !== expected[key]) {
      problems.push(`${label} expected “${expected[key]}” but received “${actual[key]}”`);
    }
  });

  if (actual.configVersion === null || !Number.isFinite(actual.configVersion)) {
    problems.push("configuration version is missing or invalid");
  } else if (actual.configVersion !== expected.configVersion) {
    problems.push(`configuration version expected ${expected.configVersion} but received ${actual.configVersion}`);
  }

  if (problems.length) {
    throw new Error(`${context} source verification failed: ${problems.join("; ")}. The returned data was not accepted.`);
  }
}

function currentSourceId() {
  return state.sheetSource?.id || DEFAULT_SHEET_SOURCE.id;
}

function makeTaskId(type, rowNumber, name, iqd, usd) {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  const sourceId = slugify(currentSourceId()) || "sheet";
  return `${todayKey()}-${sourceId}-${type}-${rowNumber}-${cleanName}-${iqd}-${usd}`;
}

function isSheetSummaryRow(name) {
  const cleanName = String(name || "").trim().toLowerCase();
  return (
    !cleanName ||
    cleanName === "total" ||
    cleanName.startsWith("total ") ||
    cleanName.includes("total iqd") ||
    cleanName.includes("total usd") ||
    cleanName.startsWith("updated")
  );
}

function normalizeWithdrawalRows(csvRows) {
  return csvRows
    .map((row, index) => {
      const name = (row[0] || "").trim();
      const iqd = parseAmount(row[1]);
      const usd = parseAmount(row[2]);
      const rowNumber = getRangeStartRow(state.sheetSource.withdrawalRange, 26) + index;
      return { id: makeTaskId("withdrawal", rowNumber, name, iqd, usd), type: "withdrawal", name, iqd, usd };
    })
    .filter((task) => !isSheetSummaryRow(task.name) && (task.iqd > 0 || task.usd > 0));
}

function normalizeTasks(csvRows, withdrawalRows = []) {
  const providerHeaderIndex = csvRows.findIndex((row) => {
    const nameHeader = String(row[0] || "").toLowerCase();
    const usdHeader = String(row[9] || "").toLowerCase();
    return nameHeader.includes("provider") && usdHeader.includes("usd payment");
  });
  const paymentStartIndex = providerHeaderIndex >= 0 ? providerHeaderIndex + 1 : 0;

  const payments = csvRows
    .slice(paymentStartIndex)
    .map((row, index) => {
      const name = (row[0] || "").trim();
      const iqd = parseAmount(row[8]);
      const usd = parseAmount(row[9]);
      const rowNumber = getRangeStartRow(state.sheetSource.paymentRange, 7) + paymentStartIndex + index;
      return { id: makeTaskId("payment", rowNumber, name, iqd, usd), type: "payment", name, iqd, usd };
    })
    .filter((task) => task.name && (task.iqd > 0 || task.usd > 0));

  const withdrawals = normalizeWithdrawalRows(withdrawalRows);

  return { payments, withdrawals };
}

function formatIQD(value) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} IQD`;
}

function formatUSD(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatCompactAmount(value, currency) {
  const amount = Number(value) || 0;
  if (!amount) return "-";
  const formatted = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: amount >= 1000000 ? 1 : 0,
  }).format(amount);
  return currency === "USD" ? `$${formatted}` : `${formatted} IQD`;
}

function formatPlainNumber(value, currency = "") {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: currency === "USD" ? 2 : 0,
  }).format(number);
}

function formatExchangeInput(input, currency) {
  const raw = input.value;
  if (!raw) return;
  const parsed = parseAmount(raw);
  if (!parsed) {
    input.value = "";
    return;
  }
  input.value = formatPlainNumber(parsed, currency);
}

function getTasks(type = state.activeType) {
  return type === "withdrawal" ? state.withdrawals : state.payments;
}

function getAppRole() {
  return document.querySelector(".app-preview")?.dataset.role || "guest";
}

function isAdminUser() {
  return getAppRole() === "admin";
}

function splitStoredList(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return String(value || "")
    .split(/\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function joinStoredList(values) {
  return splitStoredList(values).join("\n");
}

function mergeStoredList(...lists) {
  return [...new Set(lists.flatMap((list) => splitStoredList(list)))];
}

function normalizeSavedTask(saved = {}) {
  const fileNames = splitStoredList(saved.fileNames || saved.receiptName);
  const filePaths = splitStoredList(saved.filePaths || saved.filePath);
  const priority = ["priority", "urgent"].includes(saved.priority) ? saved.priority : "normal";
  return {
    done: Boolean(saved.done),
    receiptName: joinStoredList(fileNames),
    fileName: fileNames[0] || "",
    fileNames,
    filePath: filePaths[0] || "",
    filePaths,
    notePath: saved.notePath || "",
    notePaths: splitStoredList(saved.notePaths || saved.notePath),
    uploadNote: saved.uploadNote || "",
    receiptSavedAt: saved.receiptSavedAt || "",
    priority,
    adminNote: saved.adminNote || "",
    priorityUpdatedBy: saved.priorityUpdatedBy || "",
    priorityUpdatedAt: saved.priorityUpdatedAt || "",
  };
}

function getSavedTask(id) {
  return normalizeSavedTask(state.taskState[id] || { done: false, receiptName: "" });
}

function saveTaskState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.taskState));
}

function slugify(value) {
  return String(value || "task")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

function getTaskDateFromId(id) {
  return id.slice(0, 10);
}

function getAllTasks() {
  return [...state.payments, ...state.withdrawals];
}

function findTask(taskId) {
  return getAllTasks().find((task) => task.id === taskId);
}

function getTaskMatchKey(task) {
  return `${currentSourceId()}|${todayKey()}|${task.type}|${slugify(task.name)}`;
}

function getTaskMatchKeyFromRow(row) {
  const sourceId = row.sheet_source_id || DEFAULT_SHEET_SOURCE.id;
  return `${sourceId}|${row.task_date || todayKey()}|${row.task_type}|${slugify(row.task_name)}`;
}

function normalizeTaskStatusRow(row) {
  return {
    done: Boolean(row.done),
    receiptName: row.file_name || "",
    filePath: row.file_path || "",
    fileNames: splitStoredList(row.file_name),
    filePaths: splitStoredList(row.file_path),
    receiptSavedAt: row.updated_at || "",
    priority: row.priority || "normal",
    adminNote: row.admin_note || "",
    priorityUpdatedBy: row.priority_updated_by || "",
    priorityUpdatedAt: row.priority_updated_at || "",
  };
}

function getSupabaseRow(task, saved = getSavedTask(task.id)) {
  return {
    id: task.id,
    sheet_source_id: currentSourceId(),
    task_type: task.type,
    task_date: getTaskDateFromId(task.id),
    task_name: task.name,
    done: Boolean(saved.done),
    file_path: joinStoredList(saved.filePaths) || null,
    file_name: joinStoredList(saved.fileNames) || null,
    priority: saved.priority || "normal",
    admin_note: saved.adminNote || null,
    priority_updated_by: saved.priorityUpdatedBy || null,
    priority_updated_at: saved.priorityUpdatedAt || null,
    updated_at: new Date().toISOString(),
  };
}

function getBasicSupabaseRow(task, saved = getSavedTask(task.id)) {
  return {
    id: task.id,
    sheet_source_id: currentSourceId(),
    task_type: task.type,
    task_date: getTaskDateFromId(task.id),
    task_name: task.name,
    done: Boolean(saved.done),
    file_path: joinStoredList(saved.filePaths) || null,
    file_name: joinStoredList(saved.fileNames) || null,
    updated_at: new Date().toISOString(),
  };
}

async function loadRemoteTaskState() {
  if (!supabaseClient) return;

  const tasks = getAllTasks();
  const taskIds = tasks.map((task) => task.id);
  if (!taskIds.length) return;

  taskIds.forEach((taskId) => {
    delete state.taskState[taskId];
  });

  let query = supabaseClient
    .from("task_status")
    .select("*")
    .eq("task_date", todayKey())
    .in("task_type", ["payment", "withdrawal"]);

  query = currentSourceId() === DEFAULT_SHEET_SOURCE.id
    ? query.or(`sheet_source_id.eq.${DEFAULT_SHEET_SOURCE.id},sheet_source_id.is.null`)
    : query.eq("sheet_source_id", currentSourceId());

  let { data, error } = await query;
  if (error && /sheet_source_id/i.test(error.message || "")) {
    if (currentSourceId() !== DEFAULT_SHEET_SOURCE.id) return;
    const legacy = await supabaseClient
      .from("task_status")
      .select("*")
      .eq("task_date", todayKey())
      .in("task_type", ["payment", "withdrawal"]);
    data = legacy.data;
    error = legacy.error;
  }
  if (error) throw error;

  const rows = [...(data || [])].sort((a, b) => new Date(a.updated_at || 0) - new Date(b.updated_at || 0));
  const rowsByTaskId = new Map(rows.map((row) => [row.id, row]));
  const rowsByMatchKey = new Map(rows.map((row) => [getTaskMatchKeyFromRow(row), row]));

  tasks.forEach((task) => {
    const row = rowsByTaskId.get(task.id) || rowsByMatchKey.get(getTaskMatchKey(task));
    if (!row) return;

    state.taskState[task.id] = normalizeTaskStatusRow(row);
  });
  saveTaskState();
}

async function saveRemoteTaskState(taskId, options = {}) {
  if (!supabaseClient) return;

  const task = findTask(taskId);
  if (!task) return;

  const { error } = await supabaseClient.from("task_status").upsert(getSupabaseRow(task), { onConflict: "id" });
  if (!error) return;

  const needsSourceColumn = /sheet_source_id/i.test(error.message || "");
  if (needsSourceColumn) {
    if (currentSourceId() !== DEFAULT_SHEET_SOURCE.id) throw error;
    const legacyRow = getSupabaseRow(task);
    delete legacyRow.sheet_source_id;
    const legacy = await supabaseClient.from("task_status").upsert(legacyRow, { onConflict: "id" });
    if (!legacy.error) return;
    if (/priority|admin_note/i.test(legacy.error.message || "") && !options.requirePriority) {
      const basicLegacyRow = getBasicSupabaseRow(task);
      delete basicLegacyRow.sheet_source_id;
      const basicLegacy = await supabaseClient.from("task_status").upsert(basicLegacyRow, { onConflict: "id" });
      if (!basicLegacy.error) return;
      throw basicLegacy.error;
    }
    throw legacy.error;
  }

  const needsPriorityColumns = /priority|admin_note/i.test(error.message || "");
  if (!needsPriorityColumns) throw error;
  if (options.requirePriority) throw error;

  const fallback = await supabaseClient.from("task_status").upsert(getBasicSupabaseRow(task), { onConflict: "id" });
  if (fallback.error) throw fallback.error;
}

function setUploadProgress(percent, isVisible = true) {
  const safePercent = Math.max(0, Math.min(100, percent));
  els.uploadProgress.classList.toggle("active", isVisible);
  els.uploadProgress.setAttribute("aria-hidden", isVisible ? "false" : "true");
  els.uploadProgressBar.style.width = `${safePercent}%`;
}

function renderUploadJobs() {
  const jobs = Object.values(state.uploadJobs);
  els.uploadJobs.innerHTML = jobs
    .map((job) => `
      <div class="upload-job ${job.failed ? "failed" : ""}">
        <div class="upload-job-top">
          <span class="upload-job-name">${escapeHtml(job.name)}</span>
          <span class="upload-job-percent">${Math.round(job.percent)}%</span>
        </div>
        <div class="upload-job-status">${escapeHtml(job.status)}</div>
        <div class="upload-job-track">
          <div class="upload-job-fill" style="width: ${Math.max(0, Math.min(100, job.percent))}%"></div>
        </div>
      </div>
    `)
    .join("");
}

function createUploadJob(task) {
  const jobId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  state.uploadJobs[jobId] = {
    id: jobId,
    name: task.name,
    status: "Waiting",
    percent: 1,
    failed: false,
  };
  renderUploadJobs();
  return jobId;
}

function updateUploadJob(jobId, changes) {
  if (!state.uploadJobs[jobId]) return;
  state.uploadJobs[jobId] = { ...state.uploadJobs[jobId], ...changes };
  renderUploadJobs();
}

function finishUploadJob(jobId, changes = {}) {
  updateUploadJob(jobId, changes);
  window.setTimeout(() => {
    delete state.uploadJobs[jobId];
    renderUploadJobs();
  }, 1800);
}

function getAudioContext() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;

  if (!state.audioContext) {
    state.audioContext = new AudioContext();
  }

  return state.audioContext;
}

function unlockNotificationSound() {
  const context = getAudioContext();
  if (!context || state.audioUnlocked) return;

  const gain = context.createGain();
  const oscillator = context.createOscillator();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.03);
  state.audioUnlocked = true;
}

function playNotificationSound(type = "success") {
  const context = getAudioContext();
  if (!context) return;

  if (context.state === "suspended") {
    context.resume().catch(() => {});
  }

  const gain = context.createGain();
  gain.connect(context.destination);
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.55);

  const tones = type === "error"
    ? [
        { frequency: 260, start: 0, duration: 0.16 },
        { frequency: 180, start: 0.18, duration: 0.22 },
      ]
    : [
        { frequency: 520, start: 0, duration: 0.13 },
        { frequency: 780, start: 0.14, duration: 0.2 },
      ];

  tones.forEach((tone) => {
    const oscillator = context.createOscillator();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(tone.frequency, context.currentTime + tone.start);
    oscillator.connect(gain);
    oscillator.start(context.currentTime + tone.start);
    oscillator.stop(context.currentTime + tone.start + tone.duration);
  });
}

function getStorageUploadUrl(filePath) {
  const encodedBucket = encodeURIComponent(RECEIPTS_BUCKET);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `${SUPABASE_URL}/storage/v1/object/${encodedBucket}/${encodedPath}`;
}

function getNoteFilePath(filePath) {
  const extensionIndex = filePath.lastIndexOf(".");
  if (extensionIndex === -1) return `${filePath}-note.txt`;
  return `${filePath.slice(0, extensionIndex)}-note.txt`;
}

function getNoteOnlyFilePath(task) {
  const uniqueId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const folder = task.type === "withdrawal" ? "withdrawals" : "payments";
  return `${getTaskDateFromId(task.id)}/${folder}/${slugify(task.name)}-note-${uniqueId}.txt`;
}

async function uploadToStorage(filePath, body, contentType, onProgress = () => {}) {
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", getStorageUploadUrl(filePath));
    request.setRequestHeader("apikey", SUPABASE_ANON_KEY);
    request.setRequestHeader("Authorization", `Bearer ${SUPABASE_ANON_KEY}`);
    request.setRequestHeader("Content-Type", contentType || "application/octet-stream");
    request.setRequestHeader("Cache-Control", "3600");
    request.setRequestHeader("x-upsert", "true");

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 92));
    });

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
        return;
      }

      let message = `Storage upload returned ${request.status}`;
      try {
        const response = JSON.parse(request.responseText);
        message = response.message || response.error || message;
      } catch {
        if (request.responseText) message = request.responseText;
      }
      reject(new Error(message));
    });

    request.addEventListener("error", () => reject(new Error("Network error during upload.")));
    request.addEventListener("abort", () => reject(new Error("Upload was cancelled.")));
    request.send(body);
  });
}

async function uploadTaskFile(taskId, file, onProgress = () => {}) {
  if (!supabaseClient) throw new Error("Supabase is not loaded yet.");

  const task = findTask(taskId);
  if (!task) throw new Error("Task was not found.");

  const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "file";
  const folder = task.type === "withdrawal" ? "withdrawals" : "payments";
  const uniqueId = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const filePath = `${getTaskDateFromId(task.id)}/${folder}/${slugify(task.name)}-${uniqueId}.${extension}`;

  await uploadToStorage(filePath, file, file.type || "application/octet-stream", onProgress);

  return filePath;
}

async function uploadTaskNote(filePath, task, noteText) {
  const cleanNote = noteText.trim();
  if (!cleanNote) return "";

  const notePath = filePath ? getNoteFilePath(filePath) : getNoteOnlyFilePath(task);
  const noteBody = [
    "Upload Note",
    `Date: ${new Date().toLocaleString()}`,
    `Task: ${task.name}`,
    `Type: ${task.type}`,
    "",
    cleanNote,
  ].join("\n");
  const noteBlob = new Blob([noteBody], { type: "text/plain;charset=utf-8" });
  await uploadToStorage(notePath, noteBlob, "text/plain;charset=utf-8");
  return notePath;
}

async function removeUploadedFiles(paths) {
  const cleanPaths = splitStoredList(paths);
  if (!supabaseClient || !cleanPaths.length) return;

  try {
    await supabaseClient.storage.from(RECEIPTS_BUCKET).remove(cleanPaths);
  } catch {
    // Best effort cleanup only. Slack errors should remain the visible message.
  }
}

async function postUploadToSlack({ filePath, fileName, task, noteText, noteOnly = false }) {
  const response = await fetch(SLACK_FUNCTION_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({
      filePath,
      fileName,
      taskName: task.name,
      taskType: task.type,
      hasFile: Boolean(filePath) && !noteOnly,
      noteOnly,
      iqd: task.iqd || 0,
      usd: task.usd || 0,
      exchangeSide: task.exchangeSide || "",
      rate: task.rate || 0,
      noteText: noteText.trim(),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Slack post failed: ${response.status}`);
  }
}

function openUploadModal(taskId) {
  const task = findTask(taskId);
  if (!task) return;

  state.activeUploadTaskId = taskId;
  els.uploadTaskName.textContent = task.name;
  els.modalFileInput.value = "";
  els.modalUploadNote.value = getSavedTask(taskId).uploadNote || "";
  els.uploadModal.hidden = false;
  window.setTimeout(() => els.modalFileInput.focus(), 0);
}

function closeUploadModal() {
  state.activeUploadTaskId = "";
  els.uploadModal.hidden = true;
  els.modalFileInput.value = "";
  els.modalUploadNote.value = "";
}

function showStatusMessage(title, message) {
  if (state.showingStatus) {
    state.statusQueue.push({ title, message });
    return;
  }

  state.showingStatus = true;
  els.successTitle.textContent = title;
  els.successMessage.textContent = message;
  els.successModal.hidden = false;
}

function closeSuccessMessage() {
  els.successModal.hidden = true;
  const next = state.statusQueue.shift();
  if (next) {
    window.setTimeout(() => {
      els.successTitle.textContent = next.title;
      els.successMessage.textContent = next.message;
      els.successModal.hidden = false;
    }, 120);
    return;
  }

  state.showingStatus = false;
}

function getVisibleTasks() {
  const query = els.searchInput.value.trim().toLowerCase();
  const tasks = getTasks();
  const visibleTasks = query ? tasks.filter((task) => task.name.toLowerCase().includes(query)) : tasks;
  const priorityWeight = { urgent: 0, priority: 1, normal: 2 };
  return [...visibleTasks].sort((a, b) => {
    const aSaved = getSavedTask(a.id);
    const bSaved = getSavedTask(b.id);
    const priorityDiff = (priorityWeight[aSaved.priority] ?? 2) - (priorityWeight[bSaved.priority] ?? 2);
    if (priorityDiff) return priorityDiff;
    return tasks.indexOf(a) - tasks.indexOf(b);
  });
}

function getTotals(tasks) {
  return tasks.reduce(
    (totals, task) => ({
      iqd: totals.iqd + task.iqd,
      usd: totals.usd + task.usd,
      done: totals.done + (getSavedTask(task.id).done ? 1 : 0),
    }),
    { iqd: 0, usd: 0, done: 0 }
  );
}

function getMonthTitle() {
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());
}

function getEmailDateTitle() {
  return new Intl.DateTimeFormat("en-CA").format(new Date()).replaceAll("-", "/");
}

function formatEmailAmount(value, currency) {
  const amount = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
  return `${currency} ${amount}`;
}

function getEmailRows(type) {
  const tasks = type === "withdrawal" ? state.withdrawals : state.payments;
  return tasks.flatMap((task) => {
    const rows = [];
    if (task.iqd > 0) rows.push({ name: `${task.name} IQD`, amount: formatEmailAmount(task.iqd, "IQD") });
    if (task.usd > 0) rows.push({ name: `${task.name} USD`, amount: formatEmailAmount(task.usd, "USD") });
    return rows;
  });
}

function buildEmailPayload(type) {
  const isWithdrawal = type === "withdrawal";
  const tasks = isWithdrawal ? state.withdrawals : state.payments;
  const rows = getEmailRows(type);
  const totals = getTotals(tasks);
  const reportTitle = isWithdrawal ? "Withdrawals" : "Payments";
  const intro = isWithdrawal
    ? "Kindly process the following withdrawal today."
    : "Kindly process the following payment today.";
  const tableRows = rows
    .map(
      (row) => `
        <tr>
          <td style="border:1px solid #ffffff;padding:8px 10px;font-weight:700;background:#2a2a2a;color:#ffffff;">${escapeHtml(row.name)}</td>
          <td style="border:1px solid #ffffff;padding:8px 10px;font-weight:800;background:#2a2a2a;color:#ffffff;">${escapeHtml(row.amount)}</td>
        </tr>`
    )
    .join("");
  const textRows = rows.map((row) => `${row.name}: ${row.amount}`).join("\n");
  const htmlBody = `
    <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#222222;">
      <p>Dear Zaki,</p>
      <p>${intro}</p>
      <table style="border-collapse:collapse;width:400px;max-width:100%;margin:0 0 12px 0;">
        ${tableRows}
      </table>
      <p style="margin:12px 0;">
        <strong>Total USD: ${formatEmailAmount(totals.usd, "USD")}</strong><br>
        <strong>Total IQD: ${formatEmailAmount(totals.iqd, "IQD")}</strong>
      </p>
      <p>Best regards,</p>
      <table style="border-collapse:collapse;margin-top:26px;">
        <tr>
          <td style="padding-right:18px;vertical-align:middle;">
            <img src="https://tahahumam233-blip.github.io/IOS-PP/assets/logo-red.png" alt="Sindibad" width="86" style="display:block;">
          </td>
          <td style="vertical-align:middle;font-size:13px;line-height:1.55;">
            <strong style="font-size:15px;">Taha Humam</strong><br>
            <span style="color:#d6003a;font-weight:700;">Accountant</span><br>
            <a href="https://sindibad.iq" style="color:#d6003a;">Sindibad.iq</a><br>
            <span style="color:#d6003a;font-weight:700;">+9647709983201</span>
          </td>
        </tr>
      </table>
    </div>`;
  const textBody = `Dear Zaki,\n\n${intro}\n\n${textRows}\n\nTotal USD: ${formatEmailAmount(totals.usd, "USD")}\nTotal IQD: ${formatEmailAmount(totals.iqd, "IQD")}\n\nBest regards,\n\nTaha Humam\nAccountant\nSindibad.iq\n+9647709983201`;

  return {
    action: "create_outlook_draft",
    reportType: type,
    date: getEmailDateTitle(),
    month: getMonthTitle(),
    subject: `${reportTitle} - ${getMonthTitle()}`,
    intro,
    rows,
    totals: {
      iqd: totals.iqd,
      usd: totals.usd,
      iqdFormatted: formatEmailAmount(totals.iqd, "IQD"),
      usdFormatted: formatEmailAmount(totals.usd, "USD"),
    },
    htmlBody,
    textBody,
  };
}

async function createZapierDraft(type) {
  const appRole = document.querySelector(".app-preview")?.dataset.role || "guest";
  if (appRole !== "admin") {
    showStatusMessage("Admin Only", "Only Admin can create Outlook draft emails.");
    return;
  }

  const button = type === "withdrawal" ? els.createWithdrawalDraftButton : els.createPaymentDraftButton;
  const payload = buildEmailPayload(type);
  if (!payload.rows.length) {
    showStatusMessage("No Email Items", "There are no payments or withdrawals with amounts to include.");
    return;
  }

  const originalText = button?.textContent || "";
  if (button) {
    button.disabled = true;
    button.textContent = "Creating Draft...";
  }

  try {
    const formBody = new URLSearchParams({
      payload: JSON.stringify(payload),
      reportType: payload.reportType,
      subject: payload.subject,
      htmlBody: payload.htmlBody,
      textBody: payload.textBody,
      date: payload.date,
      month: payload.month,
      iqdTotal: payload.totals.iqdFormatted,
      usdTotal: payload.totals.usdFormatted,
    });
    await fetch(ZAPIER_DRAFT_WEBHOOK_URL, {
      method: "POST",
      mode: "no-cors",
      body: formBody,
    });
    showStatusMessage("Draft Request Sent", `${payload.subject} was sent to Zapier for Outlook draft creation.`);
  } catch (error) {
    showStatusMessage("Draft Failed", error.message || "Zapier did not accept the draft request.");
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard copy was blocked.");
}

async function copyEmailText(type) {
  const payload = buildEmailPayload(type);
  if (!payload.rows.length) {
    showStatusMessage("No Email Items", "There are no payments with amounts to copy.");
    return;
  }

  const buttons = type === "payment"
    ? [els.copyPaymentEmailTopButton, els.copyPaymentEmailButton].filter(Boolean)
    : [];
  const originalTexts = new Map(buttons.map((button) => [button, button.textContent]));
  buttons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Copying...";
  });

  try {
    await writeClipboardText(payload.textBody);
    showStatusMessage(
      "Payment Email Copied",
      `${payload.rows.length} payment lines copied. Total USD: ${payload.totals.usdFormatted}. Total IQD: ${payload.totals.iqdFormatted}.`
    );
  } catch (error) {
    showStatusMessage("Copy Failed", error.message || "The browser did not allow clipboard copy.");
  } finally {
    buttons.forEach((button) => {
      button.disabled = false;
      button.textContent = originalTexts.get(button) || "Copy Email";
    });
  }
}

async function loadActiveSheetConfiguration() {
  if (!supabaseClient) return state.sheetSource;

  const { data, error } = await supabaseClient.rpc("get_active_app_sheet_source");
  if (error) throw error;
  const response = Array.isArray(data) ? data[0] : data;
  const source = response?.source || response;
  if (!source) throw new Error("No active sheet source is configured.");

  return normalizeSheetSource({
    ...source,
    id: source.source_id ?? source.id,
    name: source.source_name ?? source.name,
    configVersion: response?.settings_version ?? response?.settingsVersion ?? response?.version,
  });
}

function getSheetCsvUrl(range = state.sheetSource.paymentRange, source = state.sheetSource) {
  const params = new URLSearchParams({
    tqx: "out:csv",
    gid: source.sheetGid,
    range,
    cache: Date.now().toString(),
  });
  return `https://docs.google.com/spreadsheets/d/${source.spreadsheetId}/gviz/tq?${params.toString()}`;
}

async function loadSheetFromProxy({ expectedSource = state.sheetSource } = {}) {
  const url = new URL(SHEET_FUNCTION_URL);
  url.searchParams.set("cache", Date.now().toString());

  const response = await fetchWithTimeout(url, {
    cache: "no-store",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Live sheet service returned ${response.status}.`);
  }
  if (!Array.isArray(payload.paymentsRows) || !Array.isArray(payload.withdrawalRows)) {
    throw new Error("Live sheet service returned incomplete data.");
  }
  assertSheetSourceIdentity(payload, expectedSource, "Live sheet service");
  return payload;
}

async function loadSheetSnapshot(expectedSource = state.sheetSource) {
  const response = await fetch(`${SHEET_DATA_URL}?cache=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Sheet snapshot returned ${response.status}`);
  const snapshot = await response.json();
  if (!Array.isArray(snapshot.paymentsRows) || !Array.isArray(snapshot.withdrawalRows)) {
    throw new Error("Sheet snapshot is missing payment or withdrawal rows.");
  }
  assertSheetSourceIdentity(snapshot, expectedSource, "Saved sheet snapshot");
  return snapshot;
}

function formatSheetDataTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "an unknown date";
  return new Intl.DateTimeFormat([], {
    timeZone: BAGHDAD_TIME_ZONE,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = SHEET_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function loadSheetFromGoogleCsv(source = state.sheetSource) {
  const [response, withdrawalResponse] = await Promise.all([
    fetchWithTimeout(getSheetCsvUrl(source.paymentRange, source), { cache: "no-store" }),
    fetchWithTimeout(getSheetCsvUrl(source.withdrawalRange, source), { cache: "no-store" }),
  ]);
  if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
  if (!withdrawalResponse.ok) throw new Error(`Google Sheets withdrawals returned ${withdrawalResponse.status}`);
  const text = await response.text();
  const withdrawalText = await withdrawalResponse.text();
  if (text.trim().startsWith("<")) {
    throw new Error("Google returned an HTML page. Publish the sheet to the web or make it accessible to fetch.");
  }
  if (withdrawalText.trim().startsWith("<")) {
    throw new Error("Google returned an HTML page for withdrawals. Publish the sheet to the web or make it accessible to fetch.");
  }
  return {
    generatedAt: new Date().toISOString(),
    paymentsRows: parseCsvRows(text),
    withdrawalRows: parseCsvRows(withdrawalText),
    source: source.name,
    sourceId: source.id,
    sourceName: source.name,
    spreadsheetId: source.spreadsheetId,
    sheetName: source.sheetName,
    sheetGid: source.sheetGid,
    paymentRange: source.paymentRange,
    withdrawalRange: source.withdrawalRange,
    layoutKey: source.layoutKey,
    configVersion: source.configVersion,
  };
}

function setLoading(isLoading) {
  state.loading = isLoading;
  els.updateButton.disabled = isLoading;
  if (els.refreshButton) els.refreshButton.disabled = isLoading;
  els.connectionLabel.textContent = isLoading ? "Updating" : state.source;
  els.updateButton.textContent = isLoading ? "Updating..." : "Update Data";
}

async function loadSheet({ background = false, force = false } = {}) {
  if (state.loading) return;
  if (background) {
    state.loading = true;
  } else {
    setLoading(true);
  }

  try {
    let snapshot;
    let usingFallback = false;
    let usingDirectGoogle = false;
    let configurationError = null;
    let expectedSource = state.sheetSource;

    try {
      expectedSource = await loadActiveSheetConfiguration();
    } catch (error) {
      configurationError = error;
    }

    try {
      snapshot = await loadSheetFromProxy({ force, expectedSource });
    } catch (liveSheetError) {
      if (background && state.sourceMode === "live") {
        els.connectionLabel.textContent = "Live sheet retrying";
        return;
      }

      try {
        snapshot = await loadSheetSnapshot(expectedSource);
        usingFallback = true;
      } catch (snapshotError) {
        try {
          snapshot = await loadSheetFromGoogleCsv(expectedSource);
          usingDirectGoogle = true;
        } catch (directGoogleError) {
          const details = [
            `Live service: ${liveSheetError.message || "request failed"}`,
            `Saved snapshot: ${snapshotError.message || "unavailable"}`,
            `Direct Google Sheets: ${directGoogleError.message || "request failed"}`,
          ];
          if (configurationError) {
            details.unshift(`Active-source configuration: ${configurationError.message || "unavailable"}`);
          }
          throw new Error(`Could not load ${expectedSource.name}. ${details.join(" ")}`);
        }
      }
    }

    applySheetSource({ ...snapshot, sourceName: expectedSource.name });
    const { payments, withdrawals } = normalizeTasks(snapshot.paymentsRows, snapshot.withdrawalRows);
    if (!payments.length && !withdrawals.length) {
      throw new Error(
        `No actionable payment or withdrawal tasks were found in ${state.sheetSource.name}. Check the configured ranges and amount columns.`,
      );
    }
    rememberSheetSource(state.sheetSource);

    state.payments = payments;
    state.withdrawals = withdrawals;
    await loadRemoteTaskState();
    state.sourceMode = usingFallback ? "snapshot" : "live";
    state.source = usingFallback
      ? `Saved fallback · ${state.sheetSource.name}`
      : `${usingDirectGoogle ? "Direct" : "Live"} · ${state.sheetSource.name}`;
    els.connectionLabel.textContent = state.source;
    if (usingFallback) {
      els.lastUpdated.textContent = `Fallback snapshot from ${formatSheetDataTimestamp(snapshot.generatedAt)}`;
    } else {
      els.lastUpdated.textContent = `Synced ${new Intl.DateTimeFormat([], {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date())}`;
    }
    render();
  } catch (error) {
    if (!background || state.source === "Demo preview") {
      state.source = "Demo preview";
      state.sourceMode = "demo";
      els.lastUpdated.textContent = error.message;
      render();
    } else {
      els.connectionLabel.textContent = "Live sheet retrying";
    }
  } finally {
    if (background) {
      state.loading = false;
    } else {
      setLoading(false);
    }
  }
}

function renderMetrics() {
  if (state.activeType === "exchange") {
    const rate = parseAmount(els.exchangeRate.value);
    const amountA = parseAmount(els.exchangeAmountA.value);
    const amountB = parseAmount(els.exchangeAmountB.value);

    els.metrics.innerHTML = `
      <article class="metric-card total-card">
        <div>
          <b>Exchange rate</b>
          <strong>${rate ? formatIQD(rate).replace(" IQD", "") : "0"}</strong>
        </div>
        <span class="metric-chip">IQD per USD</span>
      </article>
      <article class="metric-card total-card">
        <div>
          <b>Current entry</b>
          <strong>${amountA || amountB ? "Ready" : "Draft"}</strong>
        </div>
        <span class="metric-chip">Save as text</span>
      </article>
    `;
    return;
  }

  const activeTasks = getTasks();
  const totals = getTotals(activeTasks);
  const pending = activeTasks.length - totals.done;
  const typeName = state.activeType === "withdrawal" ? "withdrawals" : "payments";

  els.metrics.innerHTML = `
    <article class="metric-card total-card">
      <div>
        <b>Total IQD ${typeName}</b>
        <strong>${formatIQD(totals.iqd)}</strong>
      </div>
      <span class="metric-chip">${pending} pending</span>
    </article>
    <article class="metric-card total-card">
      <div>
        <b>Total USD ${typeName}</b>
        <strong>${formatUSD(totals.usd)}</strong>
      </div>
      <span class="metric-chip">${totals.done} done</span>
    </article>
  `;
}

function calculateExchange() {
  const amountA = parseAmount(els.exchangeAmountA.value);
  const amountB = parseAmount(els.exchangeAmountB.value);
  els.exchangeRate.value = amountA && amountB ? formatPlainNumber(amountA / amountB, "IQD") : "";

  renderMetrics();
}

function getExchangeText() {
  const now = new Date();
  const amountA = parseAmount(els.exchangeAmountA.value);
  const amountB = parseAmount(els.exchangeAmountB.value);
  const rate = parseAmount(els.exchangeRate.value);

  return [
    "Exchange Entry",
    `Date: ${now.toLocaleString()}`,
    `Operation: ${els.exchangeSide.value}`,
    `Amount 1: ${formatPlainNumber(amountA, "IQD")} IQD`,
    `Amount 2: ${formatPlainNumber(amountB, "USD")} USD`,
    `Exchange Rate: ${formatPlainNumber(rate, "IQD")} IQD per 1 USD`,
    "",
    "Saved from Zaki Payment Tasks",
  ].join("\n");
}

async function saveExchangeEntry() {
  const amountA = parseAmount(els.exchangeAmountA.value);
  const amountB = parseAmount(els.exchangeAmountB.value);
  const rate = parseAmount(els.exchangeRate.value);
  if (!amountA || !amountB || !rate) throw new Error("Enter two amounts or an amount plus exchange rate first.");

  const stamp = Date.now();
  const fileName = `exchange-${stamp}.txt`;
  const filePath = `${todayKey()}/exchange/${fileName}`;
  const text = getExchangeText();
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });

  await uploadToStorage(filePath, blob, "text/plain;charset=utf-8", (percent) => {
    setUploadProgress(percent);
    els.connectionLabel.textContent = `Saving ${percent}%`;
  });

  const row = {
    id: `${todayKey()}-${slugify(currentSourceId())}-exchange-${stamp}`,
    sheet_source_id: currentSourceId(),
    task_type: "exchange",
    task_date: todayKey(),
    task_name: `${els.exchangeSide.value}: ${formatPlainNumber(amountA, "IQD")} IQD to ${formatPlainNumber(amountB, "USD")} USD`,
    done: true,
    file_path: filePath,
    file_name: fileName,
    updated_at: new Date().toISOString(),
  };
  let { error } = await supabaseClient.from("task_status").upsert(row, { onConflict: "id" });
  if (error && /sheet_source_id/i.test(error.message || "") && currentSourceId() === DEFAULT_SHEET_SOURCE.id) {
    const legacyRow = { ...row };
    delete legacyRow.sheet_source_id;
    ({ error } = await supabaseClient.from("task_status").upsert(legacyRow, { onConflict: "id" }));
  }
  if (error) throw error;

  await postUploadToSlack({
    filePath,
    fileName,
    task: {
      name: row.task_name,
      type: "exchange",
      iqd: amountA,
      usd: amountB,
      rate,
      exchangeSide: els.exchangeSide.value,
    },
    noteText: "",
  });

  return fileName;
}

function renderTaskList() {
  if (state.activeType === "exchange") {
    els.taskTypeLabel.textContent = "Exchange Entry";
    els.rowCount.textContent = "Calculator";
    els.searchInput.hidden = true;
    if (els.copyPaymentEmailTopButton) els.copyPaymentEmailTopButton.hidden = true;
    els.gridWrap.hidden = true;
    els.exchangePanel.hidden = false;
    return;
  }

  const tasks = getVisibleTasks();
  const typeLabel = state.activeType === "withdrawal" ? "Withdrawals" : "Supplier Payments";

  els.searchInput.hidden = false;
  if (els.copyPaymentEmailTopButton) els.copyPaymentEmailTopButton.hidden = state.activeType !== "payment";
  els.gridWrap.hidden = false;
  els.exchangePanel.hidden = true;
  els.taskTypeLabel.textContent = typeLabel;
  els.rowCount.textContent = `${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`;

  if (!tasks.length) {
    els.taskList.innerHTML = `
      <tr>
        <td colspan="5">
          <div class="empty-state">No pending ${escapeHtml(typeLabel.toLowerCase())} found.</div>
        </td>
      </tr>
    `;
    return;
  }

  els.taskList.innerHTML = tasks
    .map((task) => {
      const saved = getSavedTask(task.id);
      const uploadLabel = task.type === "withdrawal" ? "Upload invoice" : "Upload receipt";
      const uploadCount = saved.fileNames.length;
      const isUploaded = saved.done;
      const isNoteOnly = isUploaded && uploadCount === 1 && saved.fileNames[0] === "Note only.txt";
      const status = isNoteOnly ? "Posted note" : isUploaded ? "Uploaded" : "Pending";
      const uploadState = isUploaded ? "uploaded" : "idle";
      const uploadTitle = uploadCount
        ? `Uploaded ${uploadCount} ${uploadCount === 1 ? "file" : "files"}: ${saved.fileNames.join(", ")}`
        : isNoteOnly
          ? "Posted with note only"
          : uploadLabel;
      const priority = saved.priority || "normal";
      const priorityLabel = priority === "urgent" ? "Urgent" : priority === "priority" ? "Priority" : "";
      const priorityNote = saved.adminNote ? `
        <span class="admin-note">${escapeHtml(saved.adminNote)}</span>
      ` : "";
      const adminPriorityButton = isAdminUser()
        ? `<button class="priority-edit-button" type="button" data-action="edit-priority" title="Set priority for ${escapeHtml(task.name)}">Priority</button>`
        : "";
      return `
        <tr class="${isUploaded ? "done" : ""} priority-${escapeHtml(priority)}" data-task-id="${escapeHtml(task.id)}">
          <td class="status-cell" data-label="Status">
            <span class="status-dot ${isUploaded ? "uploaded" : "pending"}" title="${escapeHtml(status)}" aria-label="${escapeHtml(status)}"></span>
          </td>
          <td class="name-cell">
            <span class="task-title-line">
              <span class="task-name-text">${escapeHtml(task.name)}</span>
              ${priorityLabel ? `<span class="priority-badge ${escapeHtml(priority)}">${priorityLabel}</span>` : ""}
            </span>
            ${priorityNote}
          </td>
          <td class="amount-cell" data-label="IQD">${escapeHtml(formatCompactAmount(task.iqd, "IQD"))}</td>
          <td class="amount-cell" data-label="USD">${escapeHtml(formatCompactAmount(task.usd, "USD"))}</td>
          <td class="file-cell" data-label="File">
            ${adminPriorityButton}
            <button class="upload-control ${uploadState}" type="button" data-action="open-upload" title="${escapeHtml(uploadTitle)}" aria-label="${escapeHtml(uploadTitle)}">
              <span class="invoice-icon" aria-hidden="true"></span>
            </button>
          </td>
        </tr>
      `;
    })
    .join("");
}

function setActiveType(type) {
  state.activeType = type;
  els.paymentsTab.classList.toggle("active", type === "payment");
  els.withdrawalsTab.classList.toggle("active", type === "withdrawal");
  els.exchangeTab.classList.toggle("active", type === "exchange");
  els.searchInput.value = "";
  render();
}

function openPriorityModal(taskId) {
  if (!isAdminUser()) {
    showStatusMessage("Admin Only", "Only Admin can set payment priorities.");
    return;
  }

  const task = findTask(taskId);
  if (!task) return;
  const saved = getSavedTask(taskId);
  state.activePriorityTaskId = taskId;
  els.priorityTaskName.textContent = task.name;
  els.priorityLevel.value = saved.priority || "normal";
  els.priorityNote.value = saved.adminNote || "";
  els.priorityModal.hidden = false;
  window.setTimeout(() => els.priorityLevel.focus(), 0);
}

function closePriorityModal() {
  state.activePriorityTaskId = "";
  els.priorityModal.hidden = true;
}

async function saveTaskPriority() {
  const taskId = state.activePriorityTaskId;
  const task = findTask(taskId);
  if (!task || !isAdminUser()) return;

  const saved = getSavedTask(taskId);
  const priority = els.priorityLevel.value;
  const adminNote = els.priorityNote.value.trim();
  const updatedAt = new Date().toISOString();
  const roleLabel = document.querySelector("#previewRolePill")?.textContent?.trim() || "Admin";
  const nextSaved = {
    ...saved,
    priority,
    adminNote,
    priorityUpdatedBy: roleLabel,
    priorityUpdatedAt: updatedAt,
  };

  const originalText = els.prioritySaveButton.textContent;
  els.prioritySaveButton.disabled = true;
  els.prioritySaveButton.textContent = "Saving...";
  try {
    state.taskState[taskId] = nextSaved;
    await saveRemoteTaskState(taskId, { requirePriority: true });
    saveTaskState();
    if (typeof addActivity === "function") {
      const label = priority === "urgent" ? "Urgent" : priority === "priority" ? "Priority" : "Normal";
      addActivity({
        title: "Priority updated",
        message: `${task.name} set to ${label}${adminNote ? `: ${adminNote}` : "."}`,
        status: "changed",
        user: roleLabel,
        task: task.name,
        taskType: task.type === "withdrawal" ? "Withdrawal" : "Payment",
      });
    }
    closePriorityModal();
    showStatusMessage("Priority Saved", `${task.name} priority was updated for Zaki.`);
  } catch (error) {
    state.taskState[taskId] = saved;
    saveTaskState();
    const message = /priority|admin_note/i.test(error.message || "")
      ? "Priority database columns are missing. Run supabase-priority.sql in Supabase, then try again."
      : error.message || "Could not save priority to Supabase.";
    showStatusMessage("Priority Not Saved", message);
  } finally {
    els.prioritySaveButton.disabled = false;
    els.prioritySaveButton.textContent = originalText;
    render();
  }
}

function render() {
  els.connectionLabel.textContent = state.source;
  renderMetrics();
  renderTaskList();
}

els.taskList.addEventListener("click", (event) => {
  const priorityButton = event.target.closest('[data-action="edit-priority"]');
  if (priorityButton) {
    const card = priorityButton.closest("[data-task-id]");
    if (card) openPriorityModal(card.dataset.taskId);
    return;
  }

  const uploadButton = event.target.closest('[data-action="open-upload"]');
  if (!uploadButton) return;

  const card = uploadButton.closest("[data-task-id]");
  if (card) openUploadModal(card.dataset.taskId);
});

async function runBackgroundUpload({ jobId, taskId, files, noteText }) {
  const task = findTask(taskId);
  const uploadedFiles = [];
  const notePaths = [];

  try {
    if (!task) throw new Error("Task was not found.");

    if (!files.length) {
      updateUploadJob(jobId, { status: "Saving note", percent: 28 });
      const notePath = await uploadTaskNote("", task, noteText);
      if (notePath) notePaths.push(notePath);

      updateUploadJob(jobId, { status: "Posting note to Slack", percent: 88 });
      await postUploadToSlack({
        filePath: notePath,
        fileName: "Note only.txt",
        task,
        noteText,
        noteOnly: true,
      });

      const previous = getSavedTask(taskId);
      state.taskState[taskId] = {
        ...previous,
        done: true,
        receiptName: notePath ? "Note only.txt" : previous.receiptName,
        fileName: notePath ? "Note only.txt" : previous.fileName,
        fileNames: notePath ? ["Note only.txt"] : previous.fileNames,
        filePath: notePath || previous.filePath,
        filePaths: notePath ? [notePath] : previous.filePaths,
        notePath: notePath || previous.notePath,
        notePaths: mergeStoredList(previous.notePaths, notePaths),
        uploadNote: noteText,
        receiptSavedAt: new Date().toISOString(),
      };
      saveTaskState();
      await saveRemoteTaskState(taskId);

      els.lastUpdated.textContent = `Posted ${task.name} note to Slack`;
      finishUploadJob(jobId, { status: "Done", percent: 100 });
      playNotificationSound("success");
      showStatusMessage("Posted to Slack", `${task.name}: note posted without picture.`);
      render();
      return;
    }

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const filePath = await uploadTaskFile(taskId, file, (percent) => {
        const totalPercent = Math.round(((index + percent / 100) / files.length) * 84);
        updateUploadJob(jobId, {
          status: `Uploading ${index + 1}/${files.length}`,
          percent: totalPercent,
        });
      });
      uploadedFiles.push({ filePath, fileName: file.name });

      const notePath = await uploadTaskNote(filePath, task, noteText);
      if (notePath) notePaths.push(notePath);
    }

    updateUploadJob(jobId, { status: "Posting to Slack", percent: 88 });

    for (let index = 0; index < uploadedFiles.length; index += 1) {
      const uploadedFile = uploadedFiles[index];
      updateUploadJob(jobId, {
        status: `Posting ${index + 1}/${uploadedFiles.length}`,
        percent: Math.round(88 + ((index + 1) / uploadedFiles.length) * 8),
      });
      await postUploadToSlack({
        filePath: uploadedFile.filePath,
        fileName: uploadedFile.fileName,
        task,
        noteText,
      });
    }

    const previous = getSavedTask(taskId);
    const fileNames = mergeStoredList(previous.fileNames, uploadedFiles.map((file) => file.fileName));
    const filePaths = mergeStoredList(previous.filePaths, uploadedFiles.map((file) => file.filePath));
    const mergedNotePaths = mergeStoredList(previous.notePaths, notePaths);
    state.taskState[taskId] = {
      ...previous,
      done: true,
      receiptName: joinStoredList(fileNames),
      fileName: fileNames[0] || "",
      fileNames,
      filePath: filePaths[0] || "",
      filePaths,
      notePath: mergedNotePaths[0] || previous.notePath || "",
      notePaths: mergedNotePaths,
      uploadNote: noteText,
      receiptSavedAt: new Date().toISOString(),
    };
    saveTaskState();
    await saveRemoteTaskState(taskId);

    const fileWord = uploadedFiles.length === 1 ? "file" : "files";
    els.lastUpdated.textContent = `Posted ${task.name} to Slack`;
    finishUploadJob(jobId, { status: "Done", percent: 100 });
    playNotificationSound("success");
    showStatusMessage("Posted to Slack", `${task.name}: ${uploadedFiles.length} ${fileWord} posted.`);
    render();
  } catch (error) {
    await removeUploadedFiles([...uploadedFiles.map((file) => file.filePath), ...notePaths]);
    const message = error instanceof Error ? error.message : String(error);
    els.lastUpdated.textContent = `Upload not saved: ${message}`;
    finishUploadJob(jobId, { status: "Failed", percent: 100, failed: true });
    playNotificationSound("error");
    showStatusMessage("Slack Post Failed", `${task?.name || "Upload"} was not saved. ${message}`);
  }
}

els.uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockNotificationSound();
  const taskId = state.activeUploadTaskId;
  const task = findTask(taskId);
  const files = Array.from(els.modalFileInput.files || []);
  const noteText = els.modalUploadNote.value.trim();
  if (!task) return;

  if (!files.length) {
    if (!noteText) {
      showStatusMessage("Nothing to Post", "Add a picture/PDF or write a note before posting.");
      return;
    }

    const confirmed = window.confirm(`Post ${task.name} to Slack with note only and no picture?`);
    if (!confirmed) return;
  }

  const jobId = createUploadJob(task);
  closeUploadModal();
  els.lastUpdated.textContent = files.length ? `Uploading ${task.name}` : `Posting note for ${task.name}`;
  void runBackgroundUpload({ jobId, taskId, files, noteText });
});

els.updateButton.addEventListener("click", () => void loadSheet({ force: true }));
els.refreshButton?.addEventListener("click", () => void loadSheet({ force: true }));
els.searchInput.addEventListener("input", renderTaskList);
els.closeUploadModal.addEventListener("click", closeUploadModal);
els.uploadModal.addEventListener("click", (event) => {
  if (event.target === els.uploadModal) closeUploadModal();
});
els.closePriorityModal?.addEventListener("click", closePriorityModal);
els.priorityModal?.addEventListener("click", (event) => {
  if (event.target === els.priorityModal) closePriorityModal();
});
els.prioritySaveButton?.addEventListener("click", saveTaskPriority);
els.successOkButton.addEventListener("click", closeSuccessMessage);
els.successModal.addEventListener("click", (event) => {
  if (event.target === els.successModal) closeSuccessMessage();
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.uploadModal.hidden) closeUploadModal();
  if (event.key === "Escape" && !els.successModal.hidden) closeSuccessMessage();
});
els.paymentsTab.addEventListener("click", () => setActiveType("payment"));
els.withdrawalsTab.addEventListener("click", () => setActiveType("withdrawal"));
els.exchangeTab.addEventListener("click", () => setActiveType("exchange"));
els.createPaymentDraftButton?.addEventListener("click", () => createZapierDraft("payment"));
els.copyPaymentEmailTopButton?.addEventListener("click", () => copyEmailText("payment"));
els.copyPaymentEmailButton?.addEventListener("click", () => copyEmailText("payment"));
els.createWithdrawalDraftButton?.addEventListener("click", () => createZapierDraft("withdrawal"));
els.exchangeAmountA.addEventListener("input", () => {
  formatExchangeInput(els.exchangeAmountA, "IQD");
  calculateExchange();
});
els.exchangeAmountB.addEventListener("input", () => {
  formatExchangeInput(els.exchangeAmountB, "USD");
  calculateExchange();
});
els.exchangePanel.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.savingExchange) return;
  state.savingExchange = true;
  els.saveExchangeButton.disabled = true;
  els.saveExchangeButton.textContent = "Saving...";
  els.connectionLabel.textContent = "Saving";
  setUploadProgress(3);
  try {
    const fileName = await saveExchangeEntry();
    setUploadProgress(100);
    els.lastUpdated.textContent = `Saved ${fileName}`;
  } catch (error) {
    els.lastUpdated.textContent = `Exchange save failed: ${error.message}`;
  } finally {
    window.setTimeout(() => {
      setUploadProgress(0, false);
      els.connectionLabel.textContent = state.source;
      state.savingExchange = false;
      els.saveExchangeButton.disabled = false;
      els.saveExchangeButton.textContent = "Save Exchange";
      render();
    }, 550);
  }
});
applySheetSource(state.sheetSource);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    let refreshing = false;

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    });

    navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" })
      .then((registration) => {
        const checkForUpdate = () => registration.update().catch(() => {});
        checkForUpdate();

        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          if (!worker) return;

          worker.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });

        window.addEventListener("focus", checkForUpdate);
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") {
            checkForUpdate();
          }
        });
      })
      .catch(() => {});
  });
}

function refreshVisibleSheet() {
  if (document.visibilityState === "visible") {
    void loadSheet({ background: true, force: true });
  }
}

document.addEventListener("visibilitychange", refreshVisibleSheet);
window.addEventListener("online", refreshVisibleSheet);

tickClock();
setInterval(tickClock, 1000 * 30);
setInterval(() => {
  if (document.visibilityState === "visible") void loadSheet({ background: true });
}, SHEET_AUTO_REFRESH_MS);
render();
void loadSheet({ force: true });
