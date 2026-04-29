const tasks = [
  { id: "fly", name: "Fly Baghdad Airlines", iqd: 7, usd: 0, status: "pending" },
  { id: "ur", name: "UR Airlines", iqd: 20000000, usd: 0, status: "pending" },
  { id: "sham", name: "Sham Wings Airlines", iqd: 0, usd: 10000, status: "posted" },
  { id: "g9", name: "G9 API", iqd: 0, usd: 5000, status: "failed" },
  { id: "sfg", name: "SFG IQD", iqd: 10000000, usd: 0, status: "pending" },
  { id: "gashtyar", name: "Ghashtyar USD", iqd: 0, usd: 3000, status: "pending" },
  { id: "ia", name: "IA Top up", iqd: 54000000, usd: 0, status: "pending" }
];

const activity = [
  { name: "Sham Wings Airlines", time: "12:31 PM", status: "Posted to Slack" },
  { name: "G9 API", time: "12:22 PM", status: "Slack failed", failed: true },
  { name: "SFG IQD", time: "12:17 PM", status: "Uploading" }
];

const app = document.querySelector(".app");
const taskList = document.querySelector("#taskList");
const activityList = document.querySelector("#activityList");
const receiptModal = document.querySelector("#receiptModal");
const receiptTitle = document.querySelector("#receiptTitle");
const pendingCount = document.querySelector("#pendingCount");
const rolePill = document.querySelector("#rolePill");
const loginScreen = document.querySelector("#loginScreen");
const loginError = document.querySelector("#loginError");
const accessText = document.querySelector("#accessText");
const updateButton = document.querySelector("#updateButton");
const closeReportButton = document.querySelector("#closeReportButton");
const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const users = {
  admin: { password: "admin2026", role: "admin", label: "Admin" },
  zaki: { password: "zaki2026", role: "zaki", label: "Zaki" }
};
let activeFilter = "all";
let currentUser = { role: "guest", label: "Guest" };

function amountText(label, value) {
  if (!value) return "";
  const amount = formatter.format(value);
  return `<span>${label} <b>${amount}</b></span>`;
}

function visibleTasks() {
  if (activeFilter === "all") return tasks;
  return tasks.filter((task) => task.status === activeFilter);
}

function canPost() {
  return currentUser.role === "admin" || currentUser.role === "zaki";
}

function canCloseDay() {
  return currentUser.role === "admin";
}

function actionButton(task) {
  if (!canPost() && task.status !== "posted") {
    return `<button class="upload locked-action" type="button" disabled>View only</button>`;
  }

  if (task.status === "failed") {
    return `<button class="upload compact-action" data-preview="${task.id}" type="button">Post</button>
      <button class="retry compact-action" data-retry="${task.id}" type="button">Retry</button>`;
  }

  return `<button class="upload" data-preview="${task.id}" type="button" aria-label="${task.status === "posted" ? "View receipt" : "Post receipt"}">
    <span>${task.status === "posted" ? "View" : "Post"}</span>
  </button>`;
}

function applyAccess() {
  rolePill.textContent = currentUser.label;
  app.dataset.role = currentUser.role;
  updateButton.disabled = currentUser.role === "guest";
  closeReportButton.disabled = !canCloseDay();

  if (currentUser.role === "admin") {
    accessText.textContent = "Signed in as Admin. You can post, retry failed Slack posts, review activity, and close the day.";
  } else if (currentUser.role === "zaki") {
    accessText.textContent = "Signed in as Zaki. You can upload receipts and post payments, withdrawals, and exchange records.";
  } else {
    accessText.textContent = "Guest mode is view only. Sign in as Zaki or Admin to post, retry, or close the day.";
  }

  renderTasks();
}

function renderTasks() {
  pendingCount.textContent = tasks.filter((task) => task.status !== "posted").length;
  taskList.innerHTML = visibleTasks()
    .map((task) => `
      <article class="task-row ${task.status}">
        <span class="dot" aria-hidden="true"></span>
        <div>
          <div class="task-name">${task.name}</div>
          <div class="amounts">
            ${amountText("IQD", task.iqd)}
            ${amountText("USD", task.usd)}
          </div>
        </div>
        <div class="row-actions">
          ${actionButton(task)}
        </div>
      </article>
    `)
    .join("");
}

function renderActivity() {
  activityList.innerHTML = activity
    .map((item) => `
      <article class="activity-row">
        <div>
          <strong>${item.name}</strong>
          <span>${item.time} - ${item.status}</span>
        </div>
        <b class="badge ${item.failed ? "failed" : ""}">${item.failed ? "Failed" : "OK"}</b>
      </article>
    `)
    .join("");
}

function signIn(user) {
  currentUser = user;
  loginError.hidden = true;
  loginScreen.hidden = true;
  applyAccess();
}

document.querySelector("#loginButton").addEventListener("click", () => {
  const id = document.querySelector("#loginId").value.trim().toLowerCase();
  const password = document.querySelector("#loginPassword").value;
  const user = users[id];

  if (!user || user.password !== password) {
    loginError.hidden = false;
    return;
  }

  signIn({ role: user.role, label: user.label });
});

document.querySelector("#guestButton").addEventListener("click", () => {
  signIn({ role: "guest", label: "Guest" });
});

document.querySelectorAll("[data-demo-user]").forEach((button) => {
  button.addEventListener("click", () => {
    const userId = button.dataset.demoUser;
    document.querySelector("#loginId").value = userId;
    document.querySelector("#loginPassword").value = users[userId].password;
    document.querySelectorAll("[data-demo-user]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    loginError.hidden = true;
  });
});

document.querySelector("#signOutButton").addEventListener("click", () => {
  currentUser = { role: "guest", label: "Guest" };
  applyAccess();
  loginScreen.hidden = false;
});

document.querySelectorAll(".bottom-nav button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".bottom-nav button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
    button.classList.add("active");
    document.querySelector(`#${button.dataset.view}`).classList.add("active");
  });
});

document.querySelectorAll("[data-theme-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    app.dataset.theme = button.dataset.themeChoice;
    document.querySelectorAll("[data-theme-choice]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  });
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    renderTasks();
  });
});

taskList.addEventListener("click", (event) => {
  const previewButton = event.target.closest("[data-preview]");
  const retryButton = event.target.closest("[data-retry]");

  if (previewButton) {
    const task = tasks.find((item) => item.id === previewButton.dataset.preview);
    receiptTitle.textContent = task?.name || "Receipt";
    receiptModal.hidden = false;
  }

  if (retryButton) {
    if (!canPost()) return;
    const task = tasks.find((item) => item.id === retryButton.dataset.retry);
    if (!task) return;
    task.status = "posted";
    activity.unshift({ name: task.name, time: "Now", status: "Retried and posted" });
    renderTasks();
    renderActivity();
  }
});

document.querySelector("#closeReceipt").addEventListener("click", () => {
  receiptModal.hidden = true;
});

receiptModal.addEventListener("click", (event) => {
  if (event.target === receiptModal) receiptModal.hidden = true;
});

renderTasks();
renderActivity();
applyAccess();
