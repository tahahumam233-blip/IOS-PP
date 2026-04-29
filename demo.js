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
const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
let activeFilter = "all";

function amountText(label, value) {
  if (!value) return "";
  const amount = formatter.format(value);
  return `<span>${label} <b>${amount}</b></span>`;
}

function visibleTasks() {
  if (activeFilter === "all") return tasks;
  return tasks.filter((task) => task.status === activeFilter);
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
          ${task.status === "failed"
            ? `<button class="upload" data-preview="${task.id}" type="button" aria-label="Post receipt"><span>Post</span></button>
              <button class="retry" data-retry="${task.id}" type="button"><span>Retry</span></button>`
            : `<button class="upload" data-preview="${task.id}" type="button" aria-label="${task.status === "posted" ? "View receipt" : "Post receipt"}">
                <span>${task.status === "posted" ? "View" : "Post"}</span>
              </button>`}
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

document.querySelector("#loginButton").addEventListener("click", () => {
  const role = document.querySelector("#loginRole").value;
  document.querySelector("#rolePill").textContent = role === "admin" ? "Admin" : "Zaki";
  document.querySelector("#loginScreen").hidden = true;
});

document.querySelector("#signOutButton").addEventListener("click", () => {
  document.querySelector("#loginScreen").hidden = false;
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
