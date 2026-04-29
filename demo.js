const tasks = [
  { name: "Fly Baghdad Airlines", iqd: 7, usd: 0, posted: false },
  { name: "UR Airlines", iqd: 20000000, usd: 0, posted: false },
  { name: "Sham Wings Airlines", iqd: 0, usd: 10000, posted: true },
  { name: "G9 API", iqd: 0, usd: 5000, posted: false },
  { name: "SFG IQD", iqd: 10000000, usd: 0, posted: false },
  { name: "Gashtyar USD", iqd: 0, usd: 3000, posted: false },
  { name: "IA Top up", iqd: 54000000, usd: 0, posted: false },
  { name: "Misc.", iqd: 0, usd: 3800, posted: false }
];

const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function amountPill(label, value) {
  if (!value) return "";
  const prefix = label === "USD" ? "$" : "";
  const suffix = label === "IQD" ? " IQD" : "";
  return `<span class="amount-pill">${label}<b>${prefix}${formatter.format(value)}${suffix}</b></span>`;
}

document.querySelector("#taskGrid").innerHTML = tasks
  .map((task) => `
    <article class="task-row ${task.posted ? "posted" : ""}">
      <span class="status-dot" aria-hidden="true"></span>
      <div>
        <div class="task-name">${task.name}</div>
        <div class="amount-grid">
          ${amountPill("IQD", task.iqd)}
          ${amountPill("USD", task.usd)}
        </div>
      </div>
      <span class="upload-icon" aria-label="${task.posted ? "Uploaded" : "Upload"}"></span>
    </article>
  `)
  .join("");
