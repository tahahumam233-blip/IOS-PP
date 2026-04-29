const previewApp = document.querySelector(".app-preview");
const previewUsers = {
  admin: { password: "admin2026", role: "admin", label: "Admin" },
  zaki: { password: "zaki2026", role: "zaki", label: "Zaki" },
};
let previewUser = { role: "guest", label: "Guest" };
let lastTouchEnd = 0;

function previewCanPost() {
  return previewUser.role === "admin" || previewUser.role === "zaki";
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
  if (previewCanPost()) return;
  if (!event.target.closest('[data-action="open-upload"]')) return;
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

setPreviewAccess(previewUser);
