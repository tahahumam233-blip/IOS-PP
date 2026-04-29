const previewApp = document.querySelector(".app-preview");
const previewUsers = {
  admin: { password: "admin2026", role: "admin", label: "Admin" },
  zaki: { password: "zaki2026", role: "zaki", label: "Zaki" },
};
const PREVIEW_ACTIVITY_KEY = "payment-tracker-preview-activity";
const PREVIEW_TASK_STATE_KEY = "zaki-payment-task-state";
const REMEMBER_LOGIN_ID_KEY = "payment-tracker-remember-login-id";
const PREVIEW_SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const PREVIEW_RECEIPTS_BUCKET = "IOS-PP- Receipts";
let previewUser = { role: "guest", label: "Guest" };
let lastTouchEnd = 0;
let previewReceiptTaskId = "";
let previewReplaceTaskId = "";

function syncAppViewport() {
  const viewport = window.visualViewport;
  const height = Math.ceil(viewport?.height || window.innerHeight || document.documentElement.clientHeight);
  document.documentElement.style.setProperty("--app-height", `${height}px`);
  document.documentElement.style.setProperty("--app-width", `${Math.ceil(viewport?.width || window.innerWidth)}px`);
}

function previewCanPost() {
  return previewUser.role === "admin" || previewUser.role === "zaki";
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

function addActivity({ title, message, status }) {
  const items = readActivity();
  items.unshift({
    title,
    message,
    status,
    time: new Intl.DateTimeFormat([], { hour: "numeric", minute: "2-digit" }).format(new Date()),
  });
  saveActivity(items);
  renderActivity();
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

  list.innerHTML = items.map((item) => `
    <article class="activity-row">
      <div>
        <strong>${item.title}</strong>
        <span>${item.time} · ${item.message}</span>
      </div>
      <b class="${item.status === "failed" ? "failed" : ""}">${item.status === "failed" ? "Failed" : "Posted"}</b>
    </article>
  `).join("");
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
  const value = pending === 0 ? `All ${isPayments ? "payments" : "withdrawals"} completed` : String(pending);
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
  const filePath = filePaths[0];
  const fileName = fileNames[0] || "Uploaded receipt";

  if (!filePath) {
    alert("No uploaded receipt was found for this task yet.");
    return;
  }

  const url = getPreviewFileUrl(filePath);
  const lowerName = fileName.toLowerCase();
  previewReceiptTaskId = taskId;
  document.querySelector("#receiptPreviewTitle").textContent = fileName;
  document.querySelector("#receiptOpenLink").href = url;
  document.querySelector("#replaceReceiptButton").hidden = !previewCanPost();
  document.querySelector("#receiptPreviewBody").innerHTML = lowerName.endsWith(".pdf")
    ? `<div class="receipt-file-fallback"><strong>PDF receipt</strong><span>Open the file to view the uploaded PDF.</span></div>`
    : `<img src="${url}" alt="Uploaded receipt" />`;
  document.querySelector("#receiptPreviewModal").hidden = false;
}

function openReplaceUpload(taskId) {
  const task = findTask(taskId);
  if (!task) return;

  previewReplaceTaskId = taskId;
  document.querySelector("#receiptPreviewModal").hidden = true;
  state.activeUploadTaskId = taskId;
  els.uploadTaskName.textContent = `Replace ${task.name}`;
  els.modalFileInput.value = "";
  els.modalUploadNote.value = getSavedTask(taskId).uploadNote || "";
  els.modalSaveButton.textContent = "Replace & Post";
  els.uploadModal.hidden = false;
  window.setTimeout(() => els.modalFileInput.focus(), 0);
}

function resetReplaceMode() {
  previewReplaceTaskId = "";
  els.modalSaveButton.textContent = "Save & Post";
}

async function runBackgroundReplace({ jobId, taskId, files, noteText }) {
  const task = findTask(taskId);
  const uploadedFiles = [];
  const notePaths = [];

  try {
    if (!task) throw new Error("Task was not found.");
    const previous = getSavedTask(taskId);
    const oldPaths = [...previous.filePaths, ...previous.notePaths];
    if (!oldPaths.length) throw new Error("No previous receipt was found to replace.");

    updateUploadJob(jobId, { status: "Removing old receipt", percent: 8 });
    await removeUploadedFiles(oldPaths);

    state.taskState[taskId] = {
      ...previous,
      done: false,
      receiptName: "",
      fileName: "",
      fileNames: [],
      filePath: "",
      filePaths: [],
      notePath: "",
      notePaths: [],
      uploadNote: "",
      receiptSavedAt: "",
    };
    saveTaskState();
    await saveRemoteTaskState(taskId);

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const filePath = await uploadTaskFile(taskId, file, (percent) => {
        const totalPercent = Math.round(12 + ((index + percent / 100) / files.length) * 72);
        updateUploadJob(jobId, {
          status: `Uploading replacement ${index + 1}/${files.length}`,
          percent: totalPercent,
        });
      });
      uploadedFiles.push({ filePath, fileName: file.name });

      const notePath = await uploadTaskNote(filePath, task, noteText);
      if (notePath) notePaths.push(notePath);
    }

    updateUploadJob(jobId, { status: "Posting replacement", percent: 88 });
    for (let index = 0; index < uploadedFiles.length; index += 1) {
      const uploadedFile = uploadedFiles[index];
      await postUploadToSlack({
        filePath: uploadedFile.filePath,
        fileName: uploadedFile.fileName,
        task,
        noteText,
      });
    }

    const fileNames = uploadedFiles.map((file) => file.fileName);
    const filePaths = uploadedFiles.map((file) => file.filePath);
    state.taskState[taskId] = {
      ...previous,
      done: true,
      receiptName: joinStoredList(fileNames),
      fileName: fileNames[0] || "",
      fileNames,
      filePath: filePaths[0] || "",
      filePaths,
      notePath: notePaths[0] || "",
      notePaths,
      uploadNote: noteText,
      receiptSavedAt: new Date().toISOString(),
    };
    saveTaskState();
    await saveRemoteTaskState(taskId);

    const fileWord = uploadedFiles.length === 1 ? "file" : "files";
    els.lastUpdated.textContent = `Replaced ${task.name} receipt`;
    finishUploadJob(jobId, { status: "Done", percent: 100 });
    playNotificationSound("success");
    showStatusMessage("Receipt Replaced", `${task.name}: ${uploadedFiles.length} replacement ${fileWord} posted.`);
    addActivity({
      title: "Receipt replaced",
      message: `${task.name}: ${uploadedFiles.length} replacement ${fileWord} posted.`,
      status: "posted",
    });
    render();
  } catch (error) {
    await removeUploadedFiles([...uploadedFiles.map((file) => file.filePath), ...notePaths]);
    const message = error instanceof Error ? error.message : String(error);
    els.lastUpdated.textContent = `Replace failed: ${message}`;
    finishUploadJob(jobId, { status: "Failed", percent: 100, failed: true });
    playNotificationSound("error");
    showStatusMessage("Replace Failed", `${task?.name || "Receipt"} was not replaced. ${message}`);
  } finally {
    resetReplaceMode();
  }
}

function setPreviewAccess(user) {
  previewUser = user;
  previewApp.dataset.role = user.role;
  document.querySelector("#previewRolePill").textContent = user.label;
  document.querySelector("#previewLoginScreen").hidden = true;
  document.querySelector("#previewLoginError").hidden = true;
  document.querySelector("#updateButton").disabled = user.role === "guest";
  document.querySelector("#refreshButton").disabled = user.role === "guest";
  document.querySelector("#saveExchangeButton").disabled = user.role === "guest";
  document.querySelector("#previewAccessText").textContent = user.role === "admin"
    ? "Signed in as Admin. You can post, retry, review activity, and close the day."
    : user.role === "zaki"
      ? "Signed in as Zaki. You can upload receipts and post payments, withdrawals, and exchange records."
    : "Guest mode is view-only. Sign in as Zaki or Admin to post.";
}

function resetLoginForm({ keepRememberedId = true } = {}) {
  const loginScreen = document.querySelector("#previewLoginScreen");
  const idInput = document.querySelector("#previewLoginId");
  const passwordInput = document.querySelector("#previewLoginPassword");
  const rememberInput = document.querySelector("#rememberLoginId");
  const rememberedId = keepRememberedId ? localStorage.getItem(REMEMBER_LOGIN_ID_KEY) || "" : "";

  previewUser = { role: "guest", label: "Guest" };
  previewApp.dataset.role = "guest";
  document.querySelector("#previewRolePill").textContent = "Guest";
  document.querySelector("#updateButton").disabled = true;
  document.querySelector("#refreshButton").disabled = true;
  document.querySelector("#saveExchangeButton").disabled = true;
  document.querySelector("#previewAccessText").textContent = "Login is required before posting, updating, or saving exchange records.";
  idInput.value = rememberedId;
  passwordInput.value = "";
  rememberInput.checked = Boolean(rememberedId);
  document.querySelector("#previewLoginError").hidden = true;
  loginScreen.hidden = false;

  window.setTimeout(() => (rememberedId ? passwordInput : idInput).focus(), 0);
}

document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("gesturechange", (event) => event.preventDefault());
document.addEventListener("gestureend", (event) => event.preventDefault());
window.addEventListener("resize", syncAppViewport);
window.addEventListener("orientationchange", syncAppViewport);
window.visualViewport?.addEventListener("resize", syncAppViewport);
window.visualViewport?.addEventListener("scroll", syncAppViewport);
document.addEventListener("touchend", (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) event.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

document.querySelector("#previewLoginButton").addEventListener("click", () => {
  const id = document.querySelector("#previewLoginId").value.trim().toLowerCase();
  const password = document.querySelector("#previewLoginPassword").value;
  const rememberInput = document.querySelector("#rememberLoginId");
  const user = previewUsers[id];
  if (!user || user.password !== password) {
    document.querySelector("#previewLoginError").hidden = false;
    document.querySelector("#previewLoginPassword").value = "";
    return;
  }

  if (rememberInput.checked) {
    localStorage.setItem(REMEMBER_LOGIN_ID_KEY, id);
  } else {
    localStorage.removeItem(REMEMBER_LOGIN_ID_KEY);
  }

  document.querySelector("#previewLoginPassword").value = "";
  setPreviewAccess({ role: user.role, label: user.label });
});

document.querySelector("#previewLoginPassword").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    document.querySelector("#previewLoginButton").click();
  }
});

document.querySelector("#previewSignOutButton").addEventListener("click", () => {
  resetLoginForm();
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    previewApp.dataset.theme = button.dataset.themeChoice;
    document.querySelectorAll("[data-theme-choice]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
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

document.querySelector("#replaceReceiptButton").addEventListener("click", () => {
  if (!previewCanPost()) return;
  openReplaceUpload(previewReceiptTaskId);
});

document.querySelector("#receiptPreviewModal").addEventListener("click", (event) => {
  if (event.target.id === "receiptPreviewModal") {
    document.querySelector("#receiptPreviewModal").hidden = true;
  }
});

document.querySelector("#uploadForm").addEventListener("submit", (event) => {
  if (!previewReplaceTaskId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  unlockNotificationSound();

  const taskId = previewReplaceTaskId;
  const task = findTask(taskId);
  const files = Array.from(els.modalFileInput.files || []);
  if (!task || !files.length) return;

  const jobId = createUploadJob(task);
  const noteText = els.modalUploadNote.value.trim();
  closeUploadModal();
  els.lastUpdated.textContent = `Replacing ${task.name}`;
  void runBackgroundReplace({ jobId, taskId, files, noteText });
}, true);

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
    message: text,
    status: "posted",
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

resetLoginForm();
renderActivity();
syncAppViewport();
window.requestAnimationFrame(() => {
  syncAppViewport();
  enhanceTaskRows();
  updatePendingMetric();
});
