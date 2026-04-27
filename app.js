const SHEET_ID = "1K14ioxhRa-oCNOQ9T3DodnpNIyimkfQvsOPHP59rCbw";
const SHEET_GID = "0";
const RANGE = "A1:N100";
const STORAGE_KEY = "zaki-payment-task-state";
const SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhZXFubGNoZW56eWJrZnljZWxvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcyNzQ1OTUsImV4cCI6MjA5Mjg1MDU5NX0.2qHHPs2sx-WUjpTQGStbLKzjAI51NSv-xGl4wQvbU5Q";
const RECEIPTS_BUCKET = "receipts";
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
  taskState: JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"),
};

const els = {
  clock: document.querySelector("#clock"),
  connectionLabel: document.querySelector("#connectionLabel"),
  sheetName: document.querySelector("#sheetName"),
  lastUpdated: document.querySelector("#lastUpdated"),
  updateButton: document.querySelector("#updateButton"),
  paymentsTab: document.querySelector("#paymentsTab"),
  withdrawalsTab: document.querySelector("#withdrawalsTab"),
  metrics: document.querySelector("#metrics"),
  taskTypeLabel: document.querySelector("#taskTypeLabel"),
  taskList: document.querySelector("#taskList"),
  rowCount: document.querySelector("#rowCount"),
  searchInput: document.querySelector("#searchInput"),
  refreshButton: document.querySelector("#refreshButton"),
  sheetLink: document.querySelector("#sheetLink"),
};

function tickClock() {
  els.clock.textContent = new Intl.DateTimeFormat([], {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date());
}

function todayKey() {
  return new Intl.DateTimeFormat("en-CA").format(new Date());
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

function normalizeTasks(csvRows) {
  const payments = csvRows
    .slice(6, 100)
    .map((row, index) => {
      const name = (row[0] || "").trim();
      const iqd = parseAmount(row[8]);
      const usd = parseAmount(row[9]);
      const rowNumber = index + 7;
      return { id: makeTaskId("payment", rowNumber, name, iqd, usd), type: "payment", name, iqd, usd };
    })
    .filter((task) => task.name && (task.iqd > 0 || task.usd > 0));

  const withdrawals = csvRows
    .slice(25, 38)
    .map((row, index) => {
      const name = (row[11] || "").trim();
      const iqd = parseAmount(row[12]);
      const usd = parseAmount(row[13]);
      const rowNumber = index + 26;
      return { id: makeTaskId("withdrawal", rowNumber, name, iqd, usd), type: "withdrawal", name, iqd, usd };
    })
    .filter((task) => task.name && (task.iqd > 0 || task.usd > 0));

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

function getTasks(type = state.activeType) {
  return type === "withdrawal" ? state.withdrawals : state.payments;
}

function getSavedTask(id) {
  return state.taskState[id] || { done: false, receiptName: "" };
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

function getSupabaseRow(task, saved = getSavedTask(task.id)) {
  return {
    id: task.id,
    task_type: task.type,
    task_date: getTaskDateFromId(task.id),
    task_name: task.name,
    done: Boolean(saved.done),
    file_path: saved.filePath || null,
    file_name: saved.receiptName || null,
    updated_at: new Date().toISOString(),
  };
}

async function loadRemoteTaskState() {
  if (!supabaseClient) return;

  const taskIds = getAllTasks().map((task) => task.id);
  if (!taskIds.length) return;

  const { data, error } = await supabaseClient.from("task_status").select("*").in("id", taskIds);
  if (error) throw error;

  data.forEach((row) => {
    state.taskState[row.id] = {
      done: Boolean(row.done),
      receiptName: row.file_name || "",
      filePath: row.file_path || "",
      receiptSavedAt: row.updated_at || "",
    };
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

async function uploadTaskFile(taskId, file) {
  if (!supabaseClient) throw new Error("Supabase is not loaded yet.");

  const task = findTask(taskId);
  if (!task) throw new Error("Task was not found.");

  const extension = file.name.includes(".") ? file.name.split(".").pop().toLowerCase() : "file";
  const folder = task.type === "withdrawal" ? "withdrawals" : "payments";
  const filePath = `${getTaskDateFromId(task.id)}/${folder}/${slugify(task.name)}-${Date.now()}.${extension}`;

  const { error } = await supabaseClient.storage.from(RECEIPTS_BUCKET).upload(filePath, file, {
    cacheControl: "3600",
    upsert: true,
  });
  if (error) throw error;

  return filePath;
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

function getSheetCsvUrl() {
  const params = new URLSearchParams({
    tqx: "out:csv",
    gid: SHEET_GID,
    range: RANGE,
    cache: Date.now().toString(),
  });
  return `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?${params.toString()}`;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  els.updateButton.disabled = isLoading;
  els.refreshButton.disabled = isLoading;
  els.connectionLabel.textContent = isLoading ? "Updating" : state.source;
  els.updateButton.textContent = isLoading ? "Updating..." : "Update Data";
}

async function loadSheet() {
  setLoading(true);
  try {
    const response = await fetch(getSheetCsvUrl(), { cache: "no-store" });
    if (!response.ok) throw new Error(`Google Sheets returned ${response.status}`);
    const text = await response.text();
    if (text.trim().startsWith("<")) {
      throw new Error("Google returned an HTML page. Publish the sheet to the web or make it accessible to fetch.");
    }

    const { payments, withdrawals } = normalizeTasks(parseCsvRows(text));
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

function renderTaskList() {
  const tasks = getVisibleTasks();
  const totals = getTotals(tasks);
  const typeLabel = state.activeType === "withdrawal" ? "Withdrawals" : "Supplier Payments";

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

  els.taskList.innerHTML =
    tasks
      .map((task) => {
        const saved = getSavedTask(task.id);
        const status = saved.done ? "Done" : "Pending";
        const uploadLabel = task.type === "withdrawal" ? "Upload invoice" : "Upload receipt";
        const uploadState = saved.receiptName ? "uploaded" : saved.done ? "missing" : "idle";
        const uploadTitle = saved.receiptName
          ? `Uploaded: ${saved.receiptName}`
          : saved.done
            ? `${uploadLabel} required`
            : uploadLabel;
        return `
          <tr class="${saved.done ? "done" : ""}" data-task-id="${escapeHtml(task.id)}">
            <td>
              <label class="task-check" title="${escapeHtml(status)}">
                <input type="checkbox" data-action="toggle" ${saved.done ? "checked" : ""} />
                <span class="check-mark" aria-hidden="true"></span>
                <span class="sr-only">${escapeHtml(status)}</span>
              </label>
            </td>
            <td class="name-cell">${escapeHtml(task.name)}</td>
            <td>${escapeHtml(formatIQD(task.iqd))}</td>
            <td>${escapeHtml(formatUSD(task.usd))}</td>
            <td>
              <label class="upload-control ${uploadState}" title="${escapeHtml(uploadTitle)}" aria-label="${escapeHtml(uploadTitle)}">
                <input type="file" accept="image/*,.pdf" data-action="upload" />
                <span class="invoice-icon" aria-hidden="true"></span>
              </label>
            </td>
          </tr>
        `;
      })
      .join("") +
    `
      <tr class="total-row">
        <td></td>
        <td>Visible total</td>
        <td>${escapeHtml(formatIQD(totals.iqd))}</td>
        <td>${escapeHtml(formatUSD(totals.usd))}</td>
        <td></td>
      </tr>
    `;
}

function setActiveType(type) {
  state.activeType = type;
  els.paymentsTab.classList.toggle("active", type === "payment");
  els.withdrawalsTab.classList.toggle("active", type === "withdrawal");
  els.searchInput.value = "";
  render();
}

function render() {
  els.connectionLabel.textContent = state.source;
  renderMetrics();
  renderTaskList();
}

els.taskList.addEventListener("change", async (event) => {
  const card = event.target.closest("[data-task-id]");
  if (!card) return;

  const taskId = card.dataset.taskId;
  const saved = getSavedTask(taskId);

  if (event.target.dataset.action === "toggle") {
    state.taskState[taskId] = { ...saved, done: event.target.checked };
    saveTaskState();
    render();
    try {
      await saveRemoteTaskState(taskId);
      els.lastUpdated.textContent = `Saved ${new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date())}`;
    } catch (error) {
      els.lastUpdated.textContent = `Local only: ${error.message}`;
    }
  }

  if (event.target.dataset.action === "upload" && event.target.files[0]) {
    const file = event.target.files[0];
    els.connectionLabel.textContent = "Uploading";
    try {
      const filePath = await uploadTaskFile(taskId, file);
      state.taskState[taskId] = {
        ...getSavedTask(taskId),
        receiptName: file.name,
        filePath,
        receiptSavedAt: new Date().toISOString(),
      };
      saveTaskState();
      await saveRemoteTaskState(taskId);
      els.lastUpdated.textContent = `Uploaded ${file.name}`;
    } catch (error) {
      state.taskState[taskId] = {
        ...getSavedTask(taskId),
        receiptName: file.name,
        receiptSavedAt: new Date().toISOString(),
      };
      saveTaskState();
      els.lastUpdated.textContent = `Upload failed: ${error.message}`;
    } finally {
      els.connectionLabel.textContent = state.source;
      render();
    }
  }
});

els.updateButton.addEventListener("click", loadSheet);
els.refreshButton.addEventListener("click", loadSheet);
els.searchInput.addEventListener("input", renderTaskList);
els.paymentsTab.addEventListener("click", () => setActiveType("payment"));
els.withdrawalsTab.addEventListener("click", () => setActiveType("withdrawal"));
els.sheetLink.href = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${SHEET_GID}#gid=${SHEET_GID}`;

tickClock();
setInterval(tickClock, 1000 * 30);
render();
loadSheet();
