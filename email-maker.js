// Payment emails section of the admin console. Ports the desktop Sindibad
// Payment Email Maker: builds Zaki's payment or withdrawal email from the
// active Google Sheet and copies it as a table that pastes into Outlook.
// Relies on SUPABASE_URL, SUPABASE_ANON_KEY, escapeHtml and showToast from
// user-manager.js.
(() => {
  const SHEET_FUNCTION_URL = `${SUPABASE_URL}/functions/v1/sheet-data`;
  const STALE_MS = 60 * 1000;
  const EMPTY_VALUES = ["", "-", "--", "—"];

  const state = { type: "payment", sheet: null, loadedAt: 0, loading: false, error: "" };
  const el = (id) => document.getElementById(id);

  function formatAmount(value, currency) {
    return `${currency} ${new Intl.NumberFormat("en-US").format(value)}`;
  }

  function isSummaryRow(name) {
    const clean = String(name || "").trim().toLowerCase();
    return (
      !clean ||
      clean === "total" ||
      clean.startsWith("total ") ||
      clean.includes("total iqd") ||
      clean.includes("total usd") ||
      clean.startsWith("updated")
    );
  }

  // "Acme USD" + IQD becomes "Acme IQD", never "Acme USD IQD".
  function smartName(name, currency) {
    const clean = String(name).replace(/\b(?:USD|IQD)\b/gi, "").split(/\s+/).filter(Boolean).join(" ");
    return `${clean} ${currency}`.trim();
  }

  function columnLetter(index) {
    let letters = "";
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
    }
    return letters;
  }

  function rangeStart(range, fallbackRow) {
    const match = String(range || "").split("!").pop().replace(/'/g, "").match(/^([A-Za-z]+)(\d+)/);
    if (!match) return { column: 0, row: fallbackRow };
    const column = [...match[1].toUpperCase()].reduce((total, char) => total * 26 + char.charCodeAt(0) - 64, 0) - 1;
    return { column, row: Number(match[2]) };
  }

  // Entries are { name, amounts: [[currency, raw, location]] }. Unreadable
  // amounts are reported by location instead of silently left out.
  function buildRows(entries) {
    const rows = [];
    const issues = [];
    entries.forEach(({ name, amounts }) => {
      if (isSummaryRow(name)) return;
      amounts.forEach(([currency, raw, location]) => {
        const value = String(raw ?? "").trim();
        if (EMPTY_VALUES.includes(value)) return;
        const number = Number(value.replace(/,|\$|USD|IQD/gi, "").trim());
        if (value.startsWith("=") || !Number.isFinite(number)) {
          issues.push({ name, currency, value, location });
        } else if (Math.trunc(number) > 0) {
          const amount = Math.trunc(number);
          rows.push({ name: smartName(name, currency), currency, value: amount, amount: formatAmount(amount, currency) });
        }
      });
    });
    return { rows, issues };
  }

  function sheetEntries(type) {
    const sheet = state.sheet;
    if (!sheet) return [];
    const tab = sheet.sheetName || "PP";
    if (type === "withdrawal") {
      const start = rangeStart(sheet.withdrawalRange, 26);
      return sheet.withdrawalRows.map((row, index) => ({
        name: String(row[0] || "").trim(),
        amounts: [
          ["IQD", row[1], `${tab}!${columnLetter(start.column + 1)}${start.row + index}`],
          ["USD", row[2], `${tab}!${columnLetter(start.column + 2)}${start.row + index}`],
        ],
      }));
    }
    const start = rangeStart(sheet.paymentRange, 7);
    const headerIndex = sheet.paymentsRows.findIndex(
      (row) => String(row[0] || "").toLowerCase().includes("provider") && String(row[9] || "").toLowerCase().includes("usd payment")
    );
    const firstIndex = headerIndex + 1;
    return sheet.paymentsRows.slice(firstIndex).map((row, index) => {
      const rowNumber = start.row + firstIndex + index;
      return {
        name: String(row[0] || "").trim(),
        amounts: [
          ["IQD", row[8], `${tab}!${columnLetter(start.column + 8)}${rowNumber}`],
          ["USD", row[9], `${tab}!${columnLetter(start.column + 9)}${rowNumber}`],
        ],
      };
    });
  }

  // Hand-pasted rows: full payment rows (IQD and USD in columns 9 and 10) or
  // the 3-column withdrawal block (name, IQD, USD).
  function manualEntries(text) {
    const entries = [];
    const malformed = [];
    text.split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      const cols = line.split("\t");
      const name = String(cols[0] || "").trim();
      const amounts = cols.length >= 9 ? [cols[8], cols[9]] : cols.length === 3 ? [cols[1], cols[2]] : null;
      if (!amounts) {
        malformed.push({ name, currency: "", value: `${cols.length} column(s)`, location: `line ${index + 1}` });
        return;
      }
      entries.push({ name, amounts: [["IQD", amounts[0], `line ${index + 1}`], ["USD", amounts[1], `line ${index + 1}`]] });
    });
    return { entries, malformed };
  }

  function currentEmail() {
    const manualText = el("emailManualInput").value.trim();
    if (manualText) {
      const { entries, malformed } = manualEntries(manualText);
      const result = buildRows(entries);
      return { manual: true, rows: result.rows, issues: [...malformed, ...result.issues] };
    }
    return { manual: false, ...buildRows(sheetEntries(state.type)) };
  }

  function totals(rows) {
    return rows.reduce(
      (sum, row) => ({ ...sum, [row.currency]: sum[row.currency] + row.value }),
      { IQD: 0, USD: 0 }
    );
  }

  // Same layout the desktop Payment Email Maker pasted into Outlook.
  function emailHtml(rows) {
    const sum = totals(rows);
    const cell = "border:1px solid #000;padding:10px;";
    const rowsHtml = rows
      .map((row) => `<tr><td style="${cell}">${escapeHtml(row.name)}</td><td style="${cell}font-weight:bold;">${escapeHtml(row.amount)}</td></tr>`)
      .join("");
    return `<html><head><meta charset="utf-8"></head><body style="font-family:'Aptos',sans-serif;background-color:#ffffff;padding:20px;">
<p style="color:#333;">Dear Zaki,</p>
<p style="color:#333;">Kindly process the following ${state.type} today.</p>
<table style="border-collapse:collapse;width:100%;max-width:500px;border:1px solid #000;">${rowsHtml}</table>
<p style="margin-top:15px;color:#000;"><strong>Total USD: ${formatAmount(sum.USD, "USD")}</strong><br><strong>Total IQD: ${formatAmount(sum.IQD, "IQD")}</strong></p>
<p style="color:#333;">Best regards,</p>
</body></html>`;
  }

  function emailText(rows) {
    const sum = totals(rows);
    return [
      "Dear Zaki,",
      "",
      `Kindly process the following ${state.type} today.`,
      "",
      ...rows.map((row) => `${row.name}\t${row.amount}`),
      "",
      `Total USD: ${formatAmount(sum.USD, "USD")}`,
      `Total IQD: ${formatAmount(sum.IQD, "IQD")}`,
      "",
      "Best regards,",
    ].join("\n");
  }

  // Rich HTML pastes into Outlook as a real table; the copy event is the
  // fallback when the async clipboard API is refused.
  async function writeClipboard(html, text) {
    if (window.ClipboardItem && navigator.clipboard?.write) {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/html": new Blob([html], { type: "text/html" }),
            "text/plain": new Blob([text], { type: "text/plain" }),
          }),
        ]);
        return;
      } catch {
        // Fall through to the copy event.
      }
    }
    const onCopy = (event) => {
      event.clipboardData.setData("text/html", html);
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    document.addEventListener("copy", onCopy);
    try {
      if (!document.execCommand("copy")) throw new Error("The browser blocked clipboard access.");
    } finally {
      document.removeEventListener("copy", onCopy);
    }
  }

  async function copyEmail() {
    const { rows } = currentEmail();
    if (!rows.length) return showToast("Nothing to copy", `There are no ${state.type}s with amounts.`, "error");
    try {
      await writeClipboard(emailHtml(rows), emailText(rows));
      const sum = totals(rows);
      showToast(
        `${state.type === "withdrawal" ? "Withdrawal" : "Payment"} email copied`,
        `${rows.length} lines · ${formatAmount(sum.USD, "USD")} · ${formatAmount(sum.IQD, "IQD")}. Paste it into Outlook.`
      );
    } catch (error) {
      showToast("Copy failed", error.message || "The browser did not allow clipboard copy.", "error");
    }
  }

  function render() {
    const { manual, rows, issues } = currentEmail();
    const sum = totals(rows);
    const label = state.type === "withdrawal" ? "withdrawal" : "payment";
    document.querySelectorAll("[data-email-type]").forEach((button) => {
      const active = button.dataset.emailType === state.type;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    el("emailTitle").textContent = `${label[0].toUpperCase()}${label.slice(1)} email`;
    el("emailManualClear").hidden = !manual;
    el("copyEmailButton").disabled = !rows.length;
    el("emailRefreshButton").disabled = state.loading;
    el("emailRefreshButton").textContent = state.loading ? "Loading…" : "Refresh";
    el("emailSourceLabel").textContent = manual
      ? "Using pasted rows. Clear them to go back to the sheet."
      : state.loading && !state.sheet
        ? "Loading the active sheet…"
        : state.error
          ? state.error
          : state.sheet?.statusLabel || "";
    el("emailSourceLabel").classList.toggle("is-error", Boolean(state.error) && !manual);

    el("emailIssues").hidden = !issues.length;
    el("emailIssues").innerHTML = issues.length
      ? `<strong>${issues.length} amount${issues.length === 1 ? "" : "s"} left out of the email</strong>
        <ul>${issues
          .slice(0, 10)
          .map((issue) => `<li><b>${escapeHtml(issue.location)}</b> ${escapeHtml(issue.currency)} <code>${escapeHtml(issue.value)}</code> ${escapeHtml(issue.name)}</li>`)
          .join("")}</ul>${issues.length > 10 ? `<span>…and ${issues.length - 10} more</span>` : ""}`
      : "";

    el("emailTotals").innerHTML = rows.length
      ? `<span>${rows.length} line${rows.length === 1 ? "" : "s"}</span><b>${formatAmount(sum.USD, "USD")}</b><b>${formatAmount(sum.IQD, "IQD")}</b>`
      : "";
    el("emailPreview").innerHTML = rows.length
      ? `<table class="email-table"><tbody>${rows
          .map((row) => `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.amount)}</td></tr>`)
          .join("")}</tbody></table>`
      : `<p class="email-empty">${state.loading ? "Loading…" : `No ${label}s with amounts.`}</p>`;
  }

  async function fetchJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, cache: "no-store", signal: controller.signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || `Request returned ${response.status}.`);
      if (!Array.isArray(payload.paymentsRows) || !Array.isArray(payload.withdrawalRows)) {
        throw new Error("Sheet data is incomplete.");
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }

  async function load({ force = false } = {}) {
    if (state.loading || (!force && state.sheet && Date.now() - state.loadedAt < STALE_MS)) return;
    state.loading = true;
    render();
    try {
      const payload = await fetchJson(`${SHEET_FUNCTION_URL}?cache=${Date.now()}`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      });
      state.sheet = { ...payload, statusLabel: `Live · ${payload.sourceName || "active sheet"} · loaded ${new Date().toLocaleTimeString()}` };
      state.error = "";
    } catch (liveError) {
      try {
        const snapshot = await fetchJson(`sheet-data.json?cache=${Date.now()}`);
        const savedAt = snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleString() : "an unknown time";
        state.sheet = { ...snapshot, statusLabel: `Saved snapshot · ${snapshot.sourceName || "sheet"} · from ${savedAt}. The live sheet failed: ${liveError.message}` };
        state.error = "";
      } catch {
        state.error = `Could not load the sheet: ${liveError.message}`;
      }
    } finally {
      state.loading = false;
      state.loadedAt = Date.now();
      render();
    }
  }

  document.querySelectorAll("[data-email-type]").forEach((button) =>
    button.addEventListener("click", () => {
      state.type = button.dataset.emailType;
      render();
    })
  );
  el("emailManualInput").addEventListener("input", render);
  el("emailManualClear").addEventListener("click", () => {
    el("emailManualInput").value = "";
    render();
  });
  el("emailRefreshButton").addEventListener("click", () => void load({ force: true }));
  el("copyEmailButton").addEventListener("click", () => void copyEmail());
  document.addEventListener("keydown", (event) => {
    if (el("emailsView").hidden) return;
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void copyEmail();
    }
  });

  window.emailMaker = { load };
  render();
  // Opened straight to #emails: selectView ran before this script existed.
  if (!el("emailsView").hidden) void load();
})();
