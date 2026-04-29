const previewApp = document.querySelector(".app-preview");
const previewUsers = {
  admin: { password: "admin2026", role: "admin", label: "Admin" },
  zaki: { password: "zaki2026", role: "zaki", label: "Zaki" },
};
const PREVIEW_ACTIVITY_KEY = "payment-tracker-preview-activity";
const PREVIEW_TASK_STATE_KEY = "zaki-payment-task-state";
const PREVIEW_SUPABASE_URL = "https://aaeqnlchenzybkfycelo.supabase.co";
const PREVIEW_RECEIPTS_BUCKET = "IOS-PP- Receipts";
let previewUser = { role: "guest", label: "Guest" };
let lastTouchEnd = 0;

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
  document.querySelector("#receiptPreviewTitle").textContent = fileName;
  document.querySelector("#receiptOpenLink").href = url;
  document.querySelector("#receiptPreviewBody").innerHTML = lowerName.endsWith(".pdf")
    ? `<div class="receipt-file-fallback"><strong>PDF receipt</strong><span>Open the file to view the uploaded PDF.</span></div>`
    : `<img src="${url}" alt="Uploaded receipt" />`;
  document.querySelector("#receiptPreviewModal").hidden = false;
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

document.addEventListener("gesturestart", (event) => event.preventDefault());
document.addEventListener("gesturechange", (event) => event.preventDefault());
document.addEventListener("gestureend", (event) => event.preventDefault());
document.addEventListener("touchend", (event) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) event.preventDefault();
  lastTouchEnd = now;
}, { passive: false });

document.querySelector("#previewLoginButton").addEventListener("click", () => {
  const id = document.querySelector("#previewLoginId").value.trim().toLowerCase();
  const password = document.querySelector("#previewLoginPassword").value;
  const user = previewUsers[id];
  if (!user || user.password !== password) {
    document.querySelector("#previewLoginError").hidden = false;
    return;
  }
  setPreviewAccess({ role: user.role, label: user.label });
});

document.querySelector("#previewGuestButton").addEventListener("click", () => {
  setPreviewAccess({ role: "guest", label: "Guest" });
});

document.querySelector("#previewSignOutButton").addEventListener("click", () => {
  previewUser = { role: "guest", label: "Guest" };
  setPreviewAccess(previewUser);
  document.querySelector("#previewLoginScreen").hidden = false;
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

setPreviewAccess(previewUser);
renderActivity();
