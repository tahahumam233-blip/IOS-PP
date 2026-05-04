const SHEET_ID = "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw";
const SHEET_GID = "0";
const RANGE = "A1:N110";
const WITHDRAWAL_RANGE = "L25:N38";
const STORAGE_KEY = "zaki-payment-task-state";
const SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const RECEIPTS_BUCKET = "IOS-PP- Receipts";
const SLACK_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/hyper-action`;
const ZAPIER_DRAFT_WEBHOOK_URL = "https://hooks.zapier.com/hooks/catch/22095219/uvk15pv/";
const supabaseClient = window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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
  createWithdrawalDraftButton: document.querySelector("#createWithdrawalDraftButton"),
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
  const cleaned = String(value ?? "")
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

function makeTaskId(type, rowNumber, name, iqd, usd) {
  const cleanName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${todayKey()}-${type}-${rowNumber}-${cleanName}-${iqd}-${usd}`;
}

function normalizeWithdrawalRows(csvRows) {
  return csvRows
    .map((row, index) => {
      const name = (row[0] || "").trim();
      const iqd = parseAmount(row[1]);
      const usd = parseAmount(row[2]);
      const rowNumber = 25 + index;
      return { id: makeTaskId("withdrawal", rowNumber, name, iqd, usd), type: "withdrawal", name, iqd, usd };
    })
    .filter((task) => task.name && (task.iqd > 0 || task.usd > 0));
}

function normalizeTasks(csvRows, withdrawalRows = []) {
  const providerHeaderIndex = csvRows.findIndex((row) => {
    const nameHeader = String(row[0] || "").toLowerCase();
    const usdHeader = String(row[9] || "").toLowerCase();
    return nameHeader.includes("provider") && usdHeader.includes("usd payment");
  });
  const paymentStartIndex = providerHeaderIndex >= 0 ? providerHeaderIndex + 1 : 0;

  const payments = csvRows
    .slice(paymentStartIndex, 110)
    .map((row, index) => {
      const name = (row[0] || "").trim();
      const iqd = parseAmount(row[8]);
      const usd = parseAmount(row[9]);
      const rowNumber = paymentStartIndex + index + 1;
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
  return `${todayKey()}|${task.type}|${slugify(task.name)}`;
}

function getTaskMatchKeyFromRow(row) {
  return `${row.task_date || todayKey()}|${row.task_type}|${slugify(row.task_name)}`;
}

function normalizeTaskStatusRow(row) {
  return {
    done: Boolean(row.done),
    receiptName: row.file_name || "",
    filePath: row.file_path || "",
    fileNames: splitStoredList(row.file_name),
    filePaths: splitStoredList(row.file_path),
    receiptSavedAt: row.updated_at || "",
  };
}

function getSupabaseRow(task, saved = getSavedTask(task.id)) {
  return {
    id: task.id,
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

  const { data, error } = await supabaseClient
    .from("task_status")
    .select("*")
    .eq("task_date", todayKey())
    .in("task_type", ["payment", "withdrawal"]);
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

async function saveRemoteTaskState(taskId) {
  if (!supabaseClient) return;

  const task = findTask(taskId);
  if (!task) return;

  const { error } = await supabaseClient.from("task_status").upsert(getSupabaseRow(task), { onConflict: "id" });
  if (error) throw error;
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

async function postUploadToSlack({ filePath, fileName, task, noteText }) {
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
      hasFile: Boolean(filePath),
      noteOnly: !filePath,
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
  return query ? tasks.filter((task) => task.name.toLowerCase().includes(query)) : tasks;
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

function getSheetCsvUrl(range = RANGE) {
  const params = new URLSearchParams({
    tqx: "out:csv",
    gid: SHEET_GID,
    range,
    cache: Date.now().toString(),
  });
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${params.toString()}`;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  els.updateButton.disabled = isLoading;
  if (els.refreshButton) els.refreshButton.disabled = isLoading;
  els.connectionLabel.textContent = isLoading ? "Updating" : state.source;
  els.updateButton.textContent = isLoading ? "Updating..." : "Update Data";
}

async function loadSheet() {
  setLoading(true);
  try {
    const [response, withdrawalResponse] = await Promise.all([
      fetch(getSheetCsvUrl(RANGE), { cache: "no-store" }),
      fetch(getSheetCsvUrl(WITHDRAWAL_RANGE), { cache: "no-store" }),
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

    const { payments, withdrawals } = normalizeTasks(parseCsvRows(text), parseCsvRows(withdrawalText));
    if (!payments.length && !withdrawals.length) throw new Error("No payment or withdrawal tasks were found.");

    state.payments = payments;
    state.withdrawals = withdrawals;
    await loadRemoteTaskState();
    state.source = "Live sheet";
    els.sheetName.textContent = "Zaki Work List";
    els.lastUpdated.textContent = `Updated ${new Intl.DateTimeFormat([], {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date())}`;
    render();
  } catch (error) {
    state.source = "Demo preview";
    els.lastUpdated.textContent = error.message;
    render();
  } finally {
    setLoading(false);
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
    id: `${todayKey()}-exchange-${stamp}`,
    task_type: "exchange",
    task_date: todayKey(),
    task_name: `${els.exchangeSide.value}: ${formatPlainNumber(amountA, "IQD")} IQD to ${formatPlainNumber(amountB, "USD")} USD`,
    done: true,
    file_path: filePath,
    file_name: fileName,
    updated_at: new Date().toISOString(),
  };
  const { error } = await supabaseClient.from("task_status").upsert(row, { onConflict: "id" });
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
    els.gridWrap.hidden = true;
    els.exchangePanel.hidden = false;
    return;
  }

  const tasks = getVisibleTasks();
  const typeLabel = state.activeType === "withdrawal" ? "Withdrawals" : "Supplier Payments";

  els.searchInput.hidden = false;
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
      return `
        <tr class="${isUploaded ? "done" : ""}" data-task-id="${escapeHtml(task.id)}">
          <td class="status-cell" data-label="Status">
            <span class="status-dot ${isUploaded ? "uploaded" : "pending"}" title="${escapeHtml(status)}" aria-label="${escapeHtml(status)}"></span>
          </td>
          <td class="name-cell">${escapeHtml(task.name)}</td>
          <td class="amount-cell" data-label="IQD">${escapeHtml(formatCompactAmount(task.iqd, "IQD"))}</td>
          <td class="amount-cell" data-label="USD">${escapeHtml(formatCompactAmount(task.usd, "USD"))}</td>
          <td class="file-cell" data-label="File">
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

function render() {
  els.connectionLabel.textContent = state.source;
  renderMetrics();
  renderTaskList();
}

els.taskList.addEventListener("click", (event) => {
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
        filePath: "",
        fileName: "",
        task,
        noteText,
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

els.updateButton.addEventListener("click", loadSheet);
els.refreshButton?.addEventListener("click", loadSheet);
els.searchInput.addEventListener("input", renderTaskList);
els.closeUploadModal.addEventListener("click", closeUploadModal);
els.uploadModal.addEventListener("click", (event) => {
  if (event.target === els.uploadModal) closeUploadModal();
});
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
els.sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${SHEET_GID}#gid=${SHEET_GID}`;

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

tickClock();
setInterval(tickClock, 1000 * 30);
render();
loadSheet();
