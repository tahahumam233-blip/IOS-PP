// PayDesk "Today" tab: tracks Zaki's day on the Desk. Payments and
// withdrawals come from the active PP sheet (amounts are only ever changed in
// the sheet); their statuses, map places, the change log, and the end-of-day
// cash check live in Supabase (supabase-desk-today.sql). Zaki's IQD/USD
// exchanges are read from the phone app's task_status records.
// Relies on supabaseClient, appState, escapeHtml, and showToast from
// user-manager.js, and on window.emailMaker for the sheet data.
(() => {
  const STATUSES = {
    payment: [["pending", "Pending"], ["in_progress", "In progress"], ["done", "Done"], ["canceled", "Canceled"]],
    withdrawal: [["pending", "Pending"], ["in_progress", "In progress"], ["collected", "Collected"], ["canceled", "Canceled"]],
  };
  const STATUS_LABELS = Object.fromEntries([...STATUSES.payment, ...STATUSES.withdrawal]);
  const SETTLED = { payment: "done", withdrawal: "collected" };
  const OPEN = new Set(["pending", "in_progress"]);
  const OSRM_TRIP = "https://router.project-osrm.org/trip/v1/driving/";
  const GOOGLE_STOPS_PER_LINK = 10; // destination plus Google's 9-waypoint limit
  const BAGHDAD = [33.3152, 44.3661];
  // The map is limited to greater Baghdad; pins outside it are refused.
  const BAGHDAD_BOUNDS = [[33.1, 44.1], [33.55, 44.7]];
  const NOMINATIM = "https://nominatim.openstreetmap.org/search";
  const LIVE_POLL_MS = 30000; // Zaki's posts, exchanges, and location

  const state = {
    list: "payment",
    sheet: null,
    tasks: [],
    statuses: new Map(),
    exchanges: [],
    places: new Map(),
    log: [],
    cashCheck: null,
    zaki: null,
    setupError: "",
    loading: false,
    placing: null,
    pickingStart: false,
    customStart: null,
    route: null,
    map: null,
    layers: null,
    tiles: null,
    fitted: false,
    phonePosts: new Map(),
    names: [],
    mapTab: "route",
    placesFilter: "missing",
    seenPins: new Set(),
    runnerFrame: 0,
    statusTimes: new Map(),
    routeKey: "",
    routeTimer: 0,
    routeFitted: false,
    liveTimer: 0,
  };

  const el = (id) => document.getElementById(id);
  const fmt = (value) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(Math.round(value));
  const money = (value, currency) => `${currency} ${fmt(value)}`;
  const norm = (value) => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
  const who = () => appState.currentUser?.label || appState.currentUser?.id || "Admin";
  const placeId = (kind, name) => `${kind}|${norm(name)}`;
  const deskStatusOf = (task) => state.statuses.get(task.key) || "pending";
  // Zaki posting on his phone always wins: the line counts as Done/Collected.
  const statusOf = (task) => (state.phonePosts.has(task.key) ? SETTLED[task.type] : deskStatusOf(task));

  // Same day boundary as the phone app: after 23:00 counts as the next day.
  function todayKey() {
    const now = new Date();
    if (now.getHours() >= 23) now.setDate(now.getDate() + 1);
    return new Intl.DateTimeFormat("en-CA").format(now);
  }

  function parseAmount(raw) {
    const value = String(raw ?? "").trim();
    if (!value || value.startsWith("=")) return 0;
    const number = Number(value.replace(/,|\$|USD|IQD/gi, "").trim());
    return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
  }

  function isSummaryRow(name) {
    const clean = norm(name);
    return !clean || clean === "total" || clean.startsWith("total ") || clean.includes("total iqd")
      || clean.includes("total usd") || clean.startsWith("updated");
  }

  function rangeStartRow(range, fallback) {
    const match = String(range || "").split("!").pop().replace(/'/g, "").match(/^[A-Za-z]+(\d+):/);
    return match ? Number(match[1]) : fallback;
  }

  // The phone app's task ids look like
  // "2026-10-21-soa-2026-q4-payment-8-ur-airlines-15000000-0": type, sheet
  // row, and slugged name identify the line (amounts are left out so a
  // corrected amount still matches).
  function phoneSlug(name) {
    return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  }

  // Every supplier (PP column A) and withdrawal (PP column L) name, whether
  // or not it has an amount today, so any of them can get a map location.
  function collectNames(sheet) {
    const names = new Map();
    const add = (kind, raw) => {
      const name = String(raw || "").trim();
      if (isSummaryRow(name) || /^\d[\d,.\s]*$/.test(name)) return;
      const id = placeId(kind, name);
      if (!names.has(id)) names.set(id, { id, kind, name });
    };
    const header = sheet.paymentsRows.findIndex(
      (row) => norm(row[0]).includes("provider") && norm(row[9]).includes("usd payment")
    );
    sheet.paymentsRows.slice(header + 1).forEach((row) => add("payment", row[0]));
    sheet.withdrawalRows.forEach((row) => add("withdrawal", row[0]));
    return [...names.values()];
  }

  function insideBaghdad(lat, lng) {
    const [[south, west], [north, east]] = BAGHDAD_BOUNDS;
    return lat >= south && lat <= north && lng >= west && lng <= east;
  }

  function matchPhonePosts(rows) {
    const posts = new Map();
    state.tasks.forEach((task) => {
      const row = rows.find((post) => post.task_type === task.type && String(post.id).includes(task.phoneMarker));
      if (row) posts.set(task.key, row);
    });
    return posts;
  }

  // Task keys use type, name, and occurrence so statuses survive rows moving
  // in the sheet and amounts being corrected there.
  function buildTasks(sheet) {
    const tasks = [];
    const seen = new Map();
    const add = (type, rawName, iqd, usd, row) => {
      const name = String(rawName || "").trim();
      if (isSummaryRow(name) || (!iqd && !usd)) return;
      const base = placeId(type, name);
      const occurrence = (seen.get(base) || 0) + 1;
      seen.set(base, occurrence);
      tasks.push({ key: `${base}|${occurrence}`, type, name, iqd, usd, phoneMarker: `-${type}-${row}-${phoneSlug(name)}-` });
    };
    const header = sheet.paymentsRows.findIndex(
      (row) => norm(row[0]).includes("provider") && norm(row[9]).includes("usd payment")
    );
    const paymentStart = rangeStartRow(sheet.paymentRange, 7) + header + 1;
    const withdrawalStart = rangeStartRow(sheet.withdrawalRange, 26);
    sheet.paymentsRows.slice(header + 1).forEach((row, index) => add("payment", row[0], parseAmount(row[8]), parseAmount(row[9]), paymentStart + index));
    sheet.withdrawalRows.forEach((row, index) => add("withdrawal", row[0], parseAmount(row[1]), parseAmount(row[2]), withdrawalStart + index));
    return tasks;
  }

  // Phone exchange records read "Buying USD: 161,405,000 IQD to 95,000 USD".
  function parseExchange(row) {
    const match = /^(Buying|Selling) USD:\s*([\d,]+)\s*IQD to\s*([\d,]+)\s*USD/i.exec(row.task_name || "");
    if (!match) return null;
    const iqd = Number(match[2].replace(/,/g, ""));
    const usd = Number(match[3].replace(/,/g, ""));
    return { buying: /^buying/i.test(match[1]), iqd, usd, rate: usd ? iqd / usd : 0, at: row.updated_at };
  }

  function sheetRate() {
    const rate = Number(state.sheet?.exchangeRate);
    return Number.isFinite(rate) && rate > 0 ? rate : 0;
  }

  function averageBuyRate() {
    const buys = state.exchanges.filter((x) => x.buying && x.usd);
    const usd = buys.reduce((sum, x) => sum + x.usd, 0);
    return usd ? buys.reduce((sum, x) => sum + x.iqd, 0) / usd : 0;
  }

  // "now" counts only settled items; "eod" counts every item not canceled.
  // Exchanges move IQD and USD in both. USD still to buy is priced at B3.
  function computeTotals() {
    const totals = { now: { IQD: 0, USD: 0 }, eod: { IQD: 0, USD: 0 } };
    state.tasks.forEach((task) => {
      const status = statusOf(task);
      if (status === "canceled") return;
      const sign = task.type === "withdrawal" ? 1 : -1;
      totals.eod.IQD += sign * task.iqd;
      totals.eod.USD += sign * task.usd;
      if (status === SETTLED[task.type]) {
        totals.now.IQD += sign * task.iqd;
        totals.now.USD += sign * task.usd;
      }
    });
    state.exchanges.forEach((x) => {
      const direction = x.buying ? 1 : -1;
      ["now", "eod"].forEach((key) => {
        totals[key].IQD -= direction * x.iqd;
        totals[key].USD += direction * x.usd;
      });
    });
    totals.rate = sheetRate() || averageBuyRate();
    totals.usdToBuy = Math.max(0, -totals.eod.USD);
    totals.iqdForUsd = totals.rate ? totals.usdToBuy * totals.rate : null;
    totals.iqdLeft = totals.rate ? totals.eod.IQD - totals.iqdForUsd : null;
    return totals;
  }

  // ---------- Rendering ----------

  function amountsText(iqd, usd) {
    return [iqd ? money(iqd, "IQD") : "", usd ? money(usd, "USD") : ""].filter(Boolean).join(" · ");
  }

  function signed(value, currency) {
    return `<span class="${value < 0 ? "negative" : ""}">${value < 0 ? "−" : ""}${money(Math.abs(value), currency)}</span>`;
  }

  function renderTotals() {
    const t = computeTotals();
    const rateNote = [
      sheetRate() ? `B3 rate ${fmt(sheetRate())}` : "B3 rate unavailable",
      averageBuyRate() ? `bought today at ${fmt(averageBuyRate())}` : "",
    ].filter(Boolean).join(" · ");
    el("todayTotals").innerHTML = `
      <article class="total-card">
        <span>Zaki has now</span>
        <strong>${signed(t.now.IQD, "IQD")}</strong>
        <strong>${signed(t.now.USD, "USD")}</strong>
        <small>Collected − paid ± exchanges</small>
      </article>
      <article class="total-card">
        <span>End of day</span>
        <strong>${signed(t.eod.IQD, "IQD")}</strong>
        <strong>${signed(t.eod.USD, "USD")}</strong>
        <small>If every open item goes through</small>
      </article>
      <article class="total-card">
        <span>USD still to buy</span>
        <strong>${money(t.usdToBuy, "USD")}</strong>
        <strong class="muted-strong">${t.iqdForUsd === null ? "No rate" : `≈ ${money(t.iqdForUsd, "IQD")}`}</strong>
        <small>${escapeHtml(rateNote)}</small>
      </article>
      <article class="total-card ${t.iqdLeft !== null && t.iqdLeft < 0 ? "short" : ""}">
        <span>IQD left after buying USD</span>
        <strong>${t.iqdLeft === null ? "—" : signed(t.iqdLeft, "IQD")}</strong>
        <small>${t.iqdLeft !== null && t.iqdLeft < 0 ? "Not enough IQD for the day's payments" : "For IQD payments and change"}</small>
      </article>`;
    return t;
  }

  function renderList() {
    const counts = { payment: 0, withdrawal: 0 };
    state.tasks.forEach((task) => counts[task.type]++);
    el("todayCountPayment").textContent = counts.payment;
    el("todayCountWithdrawal").textContent = counts.withdrawal;
    el("todayCountExchange").textContent = state.exchanges.length;
    document.querySelectorAll("[data-today-list]").forEach((button) => {
      const active = button.dataset.todayList === state.list;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });

    if (state.list === "exchange") {
      el("todayList").innerHTML = state.exchanges.length
        ? state.exchanges.map((x) => `
            <div class="task exchange">
              <div class="task-main">
                <span class="task-name">${x.buying ? "Bought" : "Sold"} ${money(x.usd, "USD")}</span>
                <span class="task-amounts">for ${money(x.iqd, "IQD")} · rate ${fmt(x.rate)}</span>
              </div>
              <span class="task-time">${new Date(x.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            </div>`).join("")
        : `<p class="empty">No exchanges recorded on Zaki's phone today.</p>`;
      return;
    }

    const tasks = state.tasks.filter((task) => task.type === state.list);
    el("todayList").innerHTML = tasks.length
      ? tasks.map((task) => {
          const status = statusOf(task);
          const post = state.phonePosts.get(task.key);
          const hasPlace = state.places.has(placeId(task.type, task.name));
          return `
            <div class="task status-${status}${post ? " posted" : ""}" data-task-key="${escapeHtml(task.key)}">
              <div class="task-main">
                <span class="task-name">${escapeHtml(task.name)}</span>
                <span class="task-amounts">${escapeHtml(amountsText(task.iqd, task.usd))}</span>
                ${post ? `<span class="posted-badge">Posted by Zaki · ${new Date(post.updated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>` : ""}
              </div>
              <div class="status-pick" role="group" aria-label="Status for ${escapeHtml(task.name)}"${post ? ` title="Zaki posted this on his phone, so it stays ${STATUS_LABELS[SETTLED[task.type]]}"` : ""}>
                ${STATUSES[task.type].map(([value, label]) => `
                  <button type="button" class="s-${value}${value === status ? " active" : ""}" data-status="${value}" aria-pressed="${value === status}"${post ? " disabled" : ""}>${label}</button>`).join("")}
              </div>
              <button class="icon-btn pin-btn${hasPlace ? " has-place" : ""}" type="button" data-pin
                aria-label="${hasPlace ? "Edit" : "Set"} map location for ${escapeHtml(task.name)}"
                title="${hasPlace ? "Edit location" : "Set location"}">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.1-7-11.5a7 7 0 0 1 14 0C19 14.9 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>
              </button>
            </div>`;
        }).join("")
      : `<p class="empty">${state.loading ? "Loading…" : `No ${state.list}s with amounts in the sheet.`}</p>`;
  }

  function renderLog() {
    const phoneEntries = [...state.phonePosts].map(([key, post]) => {
      const task = state.tasks.find((item) => item.key === key);
      return {
        changed_at: post.updated_at,
        changed_by: "Zaki (phone)",
        task_name: task?.name || post.task_name,
        old_status: "pending",
        new_status: SETTLED[post.task_type],
      };
    });
    const entries = [...state.log, ...phoneEntries].sort((a, b) => String(b.changed_at).localeCompare(String(a.changed_at)));
    el("logCount").textContent = entries.length;
    el("logList").innerHTML = entries.length
      ? entries.map((entry) => `
          <li>
            <time>${new Date(entry.changed_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
            <span><b>${escapeHtml(entry.changed_by)}</b> · ${escapeHtml(entry.task_name)}:
              ${escapeHtml(STATUS_LABELS[entry.old_status] || "Pending")} → ${escapeHtml(STATUS_LABELS[entry.new_status] || entry.new_status)}</span>
          </li>`).join("")
      : `<li class="empty">No changes yet today.</li>`;
  }

  function renderCashCheck(totals) {
    const counted = { IQD: parseAmount(el("countedIqd").value), USD: parseAmount(el("countedUsd").value) };
    const typed = el("countedIqd").value.trim() || el("countedUsd").value.trim();
    el("cashDiff").innerHTML = typed
      ? ["IQD", "USD"].map((currency) => {
          const diff = counted[currency] - totals.now[currency];
          const label = diff === 0 ? "matches" : diff > 0 ? "more than expected" : "short";
          return `<div class="diff ${diff === 0 ? "ok" : diff > 0 ? "over" : "under"}">
            <span>${currency}: expected ${fmt(totals.now[currency])}</span>
            <b>${diff === 0 ? "✓" : `${diff > 0 ? "+" : "−"}${fmt(Math.abs(diff))}`} ${label}</b>
          </div>`;
        }).join("")
      : `<p class="hint">Expected now: ${money(totals.now.IQD, "IQD")} · ${money(totals.now.USD, "USD")}</p>`;
    const check = state.cashCheck;
    el("cashCheckStatus").textContent = check
      ? `Saved ${new Date(check.checked_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} by ${check.checked_by}`
      : "Enter what Zaki hands back.";
  }

  function renderStatus() {
    el("todaySetupAlert").hidden = !state.setupError;
    el("todaySetupAlert").textContent = state.setupError;
    el("todayStatus").textContent = state.sheet
      ? `${state.sheet.sourceName || "Active sheet"} · ${todayKey()}`
      : state.loading ? "Loading the active sheet…" : "";
  }

  function renderAll() {
    renderStatus();
    const totals = renderTotals();
    renderList();
    renderLog();
    renderCashCheck(totals);
    renderPlaces();
    renderStartOptions();
    renderPlacesPanel();
  }

  // ---------- Data ----------

  async function loadRemote() {
    const day = todayKey();
    const source = state.sheet.sourceId;
    const [statuses, exchanges, places, log, cash, zaki, posts] = await Promise.all([
      supabaseClient.from("desk_task_status").select("task_key,status,updated_at").eq("task_date", day).eq("sheet_source_id", source),
      supabaseClient.from("task_status").select("task_name,updated_at").eq("task_type", "exchange").eq("task_date", day).eq("sheet_source_id", source),
      supabaseClient.from("desk_places").select("*"),
      supabaseClient.from("desk_status_log").select("*").eq("task_date", day).eq("sheet_source_id", source).order("changed_at", { ascending: false }).limit(200),
      supabaseClient.from("desk_cash_checks").select("*").eq("id", `${day}|${source}`).maybeSingle(),
      supabaseClient.from("user_locations").select("*").eq("user_role", "zaki").order("updated_at", { ascending: false }).limit(1),
      phonePostsQuery(day, source),
    ]);
    const deskErrors = [statuses, places, log, cash].map((result) => result.error).filter(Boolean);
    state.setupError = deskErrors.length
      ? (deskErrors.some((error) => /relation|does not exist|schema cache/i.test(error.message || ""))
        ? "The Today tables aren't set up yet. Run supabase-desk-today.sql in the Supabase SQL editor, then refresh."
        : `Couldn't load today's statuses: ${deskErrors[0].message}`)
      : "";
    state.statuses = new Map((statuses.data || []).map((row) => [row.task_key, row.status]));
    state.statusTimes = new Map((statuses.data || []).map((row) => [row.task_key, row.updated_at]));
    state.exchanges = (exchanges.data || []).map(parseExchange).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    state.places = new Map((places.data || []).map((row) => [row.id, row]));
    state.log = log.data || [];
    state.cashCheck = cash.data || null;
    if (state.cashCheck && !el("countedIqd").value && !el("countedUsd").value) {
      el("countedIqd").value = fmt(state.cashCheck.counted_iqd);
      el("countedUsd").value = fmt(state.cashCheck.counted_usd);
    }
    state.zaki = zaki.data?.[0] || null;
    state.phonePosts = matchPhonePosts(posts.data || []);
  }

  function phonePostsQuery(day, source) {
    return supabaseClient.from("task_status").select("id,task_type,task_name,updated_at")
      .eq("task_date", day).eq("sheet_source_id", source).eq("done", true).in("task_type", ["payment", "withdrawal"]);
  }

  // Every 30 s while Today is open: Zaki's posts, exchanges, and location.
  async function refreshLive() {
    if (el("todayView").hidden || !state.sheet || state.loading) return;
    const day = todayKey();
    const source = state.sheet.sourceId;
    const [posts, exchanges, zaki] = await Promise.all([
      phonePostsQuery(day, source),
      supabaseClient.from("task_status").select("task_name,updated_at").eq("task_type", "exchange").eq("task_date", day).eq("sheet_source_id", source),
      supabaseClient.from("user_locations").select("*").eq("user_role", "zaki").order("updated_at", { ascending: false }).limit(1),
    ]);
    if (!posts.error) {
      const before = new Set(state.phonePosts.keys());
      state.phonePosts = matchPhonePosts(posts.data || []);
      [...state.phonePosts.keys()].filter((key) => !before.has(key)).forEach((key) => {
        const task = state.tasks.find((item) => item.key === key);
        if (task) showToast(`Zaki posted ${task.name}`, `Marked ${STATUS_LABELS[SETTLED[task.type]]}`);
      });
    }
    if (!exchanges.error) {
      state.exchanges = (exchanges.data || []).map(parseExchange).filter(Boolean).sort((a, b) => String(b.at).localeCompare(String(a.at)));
    }
    if (zaki.data?.[0]) state.zaki = zaki.data[0];
    renderAll();
    renderZaki();
    scheduleRoute();
  }

  async function onSheet(sheet) {
    if (!sheet) return;
    state.sheet = sheet;
    state.tasks = buildTasks(sheet);
    state.names = collectNames(sheet);
    state.loading = true;
    renderAll();
    try {
      await loadRemote();
    } catch (error) {
      state.setupError = `Couldn't reach Supabase: ${error.message}`;
    } finally {
      state.loading = false;
      renderAll();
      renderZaki();
      fitToPlaces();
      scheduleRoute();
    }
  }

  async function setStatus(task, status) {
    if (state.phonePosts.has(task.key)) {
      showToast("Posted by Zaki", `${task.name} was posted on his phone, so it stays ${STATUS_LABELS[SETTLED[task.type]]}.`, "error");
      return;
    }
    const previous = deskStatusOf(task);
    if (previous === status || state.setupError) {
      if (state.setupError) showToast("Today isn't set up yet", state.setupError, "error");
      return;
    }
    state.statuses.set(task.key, status);
    renderAll();
    const day = todayKey();
    const source = state.sheet.sourceId;
    const by = who();
    const at = new Date().toISOString();
    const { error } = await supabaseClient.from("desk_task_status").upsert({
      id: `${day}|${source}|${task.key}`,
      task_date: day,
      sheet_source_id: source,
      task_key: task.key,
      task_type: task.type,
      task_name: task.name,
      status,
      updated_by: by,
      updated_at: at,
    }, { onConflict: "id" });
    if (error) {
      state.statuses.set(task.key, previous);
      renderAll();
      showToast("Status not saved", error.message, "error");
      return;
    }
    const entry = {
      task_date: day,
      sheet_source_id: source,
      task_key: task.key,
      task_type: task.type,
      task_name: task.name,
      old_status: previous,
      new_status: status,
      changed_by: by,
      changed_at: at,
    };
    state.statusTimes.set(task.key, at);
    state.log.unshift(entry);
    renderLog();
    scheduleRoute();
    const logged = await supabaseClient.from("desk_status_log").insert(entry);
    if (logged.error) showToast("Change saved but not logged", logged.error.message, "error");
  }

  async function saveCashCheck() {
    if (!state.sheet) return;
    const totals = computeTotals();
    const day = todayKey();
    const source = state.sheet.sourceId;
    const row = {
      id: `${day}|${source}`,
      task_date: day,
      sheet_source_id: source,
      counted_iqd: parseAmount(el("countedIqd").value),
      counted_usd: parseAmount(el("countedUsd").value),
      expected_iqd: Math.round(totals.now.IQD),
      expected_usd: Math.round(totals.now.USD),
      checked_by: who(),
      checked_at: new Date().toISOString(),
    };
    const { error } = await supabaseClient.from("desk_cash_checks").upsert(row, { onConflict: "id" });
    if (error) return showToast("Cash check not saved", error.message, "error");
    state.cashCheck = row;
    renderCashCheck(totals);
    showToast("Cash check saved", `Expected ${money(row.expected_iqd, "IQD")} · ${money(row.expected_usd, "USD")}`);
  }

  // ---------- Map ----------

  function ensureMap() {
    if (state.map) {
      state.map.invalidateSize();
      return true;
    }
    if (!window.L) {
      el("todayMap").innerHTML = `<p class="empty">The map library couldn't load. Check the internet connection and refresh.</p>`;
      return false;
    }
    const bounds = L.latLngBounds(BAGHDAD_BOUNDS);
    state.map = L.map("todayMap", {
      zoomControl: false,
      minZoom: 11,
      maxBounds: bounds.pad(0.05),
      maxBoundsViscosity: 1,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
    }).setView(BAGHDAD, 12);
    L.control.zoom({ position: "bottomright" }).addTo(state.map);
    // Standard OpenStreetMap tiles (no key needed); dark mode darkens them in CSS.
    state.tiles = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      bounds: bounds.pad(0.1),
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(state.map);
    state.layers = {
      places: L.layerGroup().addTo(state.map),
      route: L.layerGroup().addTo(state.map),
      zaki: L.layerGroup().addTo(state.map),
    };
    state.map.on("click", onMapClick);
    // The map can be created while hidden (behind sign-in or another tab);
    // resize it whenever its box changes so tiles fill the area.
    new ResizeObserver(() => state.map.invalidateSize()).observe(el("todayMap"));
    return true;
  }

  // A place's colour follows today's status of the tasks at it.
  function placeState(place) {
    const tasks = state.tasks.filter((task) => placeId(task.type, task.name) === place.id);
    if (!tasks.length) return "idle";
    const statuses = tasks.map(statusOf);
    if (statuses.some((s) => s === "in_progress")) return "in_progress";
    if (statuses.some((s) => s === "pending")) return "pending";
    if (statuses.every((s) => s === "canceled")) return "canceled";
    return "settled";
  }

  function renderPlaces() {
    if (!state.map) return;
    state.layers.places.clearLayers();
    const order = new Map((state.route?.stops || []).map((stop, index) => [stop.place.id, index + 1]));
    let dropIndex = 0;
    state.places.forEach((place) => {
      const number = order.get(place.id);
      const status = placeState(place);
      // New pins drop in (staggered); pins already on the map stay still.
      const drop = !state.seenPins.has(place.id);
      if (drop) state.seenPins.add(place.id);
      const marker = L.marker([place.latitude, place.longitude], {
        draggable: true,
        title: place.name,
        riseOnHover: true,
        icon: L.divIcon({
          className: "",
          html: `<span class="pin-wrap${drop ? " drop" : ""}" style="--delay:${drop ? Math.min(dropIndex++, 25) * 45 : 0}ms">
              ${status === "in_progress" ? '<i class="pin-pulse"></i>' : ""}
              <span class="pin pin-${place.kind} pin-${status}${number ? " numbered" : ""}"><b>${number || ""}</b></span>
              <i class="pin-shadow"></i>
            </span>`,
          iconSize: [32, 40],
          iconAnchor: [16, 36],
        }),
      });
      marker.bindTooltip(`${escapeHtml(place.name)}${place.kind === "withdrawal" ? " · withdrawal" : ""}`, { direction: "top", offset: [0, -34], className: "pin-tip" });
      marker.on("dragend", () => {
        const { lat, lng } = marker.getLatLng();
        void savePlace(place.kind, place.name, lat, lng);
      });
      marker.on("click", () => startPlacing(place.kind, place.name));
      marker.addTo(state.layers.places);
    });
  }


  function fitToPlaces() {
    if (!state.map || state.fitted || !state.places.size) return;
    const bounds = L.latLngBounds([...state.places.values()].map((place) => [place.latitude, place.longitude]));
    state.map.flyToBounds(bounds.pad(0.2), { maxZoom: 14, duration: 1.4 });
    state.fitted = true;
  }

  function renderZaki() {
    if (!state.map) return;
    state.layers.zaki.clearLayers();
    const zaki = state.zaki;
    if (!zaki) {
      el("zakiLocationStatus").textContent = "Zaki's live location isn't available.";
      return;
    }
    const minutes = Math.round((Date.now() - new Date(zaki.updated_at).getTime()) / 60000);
    const age = minutes < 1 ? "just now"
      : minutes < 60 ? `${minutes} min ago`
      : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago`
      : `${Math.round(minutes / 1440)} days ago`;
    L.marker([zaki.latitude, zaki.longitude], {
      icon: L.divIcon({ className: "", html: `<span class="zaki-dot${minutes > 30 ? " stale" : ""}"></span>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      zIndexOffset: 1000,
    }).bindTooltip(`Zaki · ${age}`, { direction: "top" }).addTo(state.layers.zaki);
    el("zakiLocationStatus").textContent = `Zaki's location updated ${age}.`;
  }

  // Accepts "33.31, 44.36" or full Google Maps links (…/@lat,lng…, ?q=lat,lng, !3dlat!4dlng).
  function parseLocation(text) {
    const value = String(text || "").trim();
    const patterns = [
      /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
      /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/,
      /[?&](?:q|query|ll|destination)=(-?\d+(?:\.\d+)?)(?:,|%2C)\s*(-?\d+(?:\.\d+)?)/i,
      /^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(value);
      if (match) {
        const lat = Number(match[1]);
        const lng = Number(match[2]);
        if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng };
      }
    }
    return null;
  }

  function startPlacing(kind, name) {
    if (state.setupError) return showToast("Today isn't set up yet", state.setupError, "error");
    state.pickingStart = false;
    state.placing = { kind, name };
    const existing = state.places.get(placeId(kind, name));
    el("placingText").textContent = existing
      ? `Move ${name}: drag its pin, click the new spot, or search below`
      : `Place ${name}: click the map where it is, or search below`;
    el("placingLink").value = "";
    el("placingResults").hidden = true;
    el("placingRemove").hidden = !existing;
    if (existing && state.map) state.map.flyTo([existing.latitude, existing.longitude], 16, { duration: 1.1 });
    el("placingBar").hidden = false;
    el("todayMap").classList.add("placing");
    el("todayMap").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function stopPlacing() {
    state.placing = null;
    state.pickingStart = false;
    el("placingBar").hidden = true;
    el("placingResults").hidden = true;
    el("todayMap").classList.remove("placing");
  }

  async function savePlace(kind, name, lat, lng) {
    if (!insideBaghdad(lat, lng)) {
      showToast("Outside Baghdad", `${name} wasn't saved: the map only covers Baghdad.`, "error");
      renderPlaces();
      return;
    }
    const row = {
      id: placeId(kind, name),
      kind,
      name,
      latitude: lat,
      longitude: lng,
      updated_by: who(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabaseClient.from("desk_places").upsert(row, { onConflict: "id" });
    if (error) return showToast("Location not saved", error.message, "error");
    state.places.set(row.id, { ...(state.places.get(row.id) || {}), ...row });
    state.seenPins.delete(row.id);
    renderAll();
    scheduleRoute();
    showToast("Location saved", name);
  }

  async function removePlace() {
    if (!state.placing) return;
    const { kind, name } = state.placing;
    const id = placeId(kind, name);
    const { error } = await supabaseClient.from("desk_places").delete().eq("id", id);
    if (error) return showToast("Pin not removed", error.message, "error");
    state.places.delete(id);
    stopPlacing();
    renderAll();
    scheduleRoute();
    showToast("Pin removed", name);
  }

  // Free OpenStreetMap place search, limited to Baghdad.
  async function searchPlaces(query) {
    const [[south, west], [north, east]] = BAGHDAD_BOUNDS;
    const params = new URLSearchParams({
      q: query,
      format: "jsonv2",
      limit: "6",
      bounded: "1",
      viewbox: `${west},${north},${east},${south}`,
      "accept-language": "en,ar",
    });
    const response = await fetch(`${NOMINATIM}?${params}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Search returned ${response.status}`);
    return (await response.json()).map((item) => ({ lat: Number(item.lat), lng: Number(item.lon), label: item.display_name }));
  }

  function useFoundPoint(point) {
    if (state.placing) {
      const { kind, name } = state.placing;
      stopPlacing();
      void savePlace(kind, name, point.lat, point.lng);
      state.map?.flyTo([point.lat, point.lng], 16, { duration: 1.1 });
    } else if (state.pickingStart) {
      state.customStart = point;
      stopPlacing();
      renderStartOptions();
      el("routeStart").value = "custom";
      state.routeKey = "";
      void planRoute({ auto: true });
    }
  }

  async function findPlacingInput() {
    const text = el("placingLink").value.trim();
    if (!text) return;
    const point = parseLocation(text);
    if (point) return useFoundPoint(point);
    if (/maps\.app\.goo\.gl|goo\.gl\/maps/i.test(text)) {
      return showToast("Short link", "Open the short link in a browser and copy the full Google Maps address instead.", "error");
    }
    const results = el("placingResults");
    el("placingSave").disabled = true;
    try {
      const found = await searchPlaces(text);
      results.hidden = false;
      results.innerHTML = found.length
        ? found.map((item, index) => `<li><button type="button" data-result="${index}">${escapeHtml(item.label)}</button></li>`).join("")
        : `<li class="empty">Nothing found in Baghdad. Try another spelling, or click the map.</li>`;
      results.onclick = (event) => {
        const button = event.target.closest("[data-result]");
        if (button) useFoundPoint(found[Number(button.dataset.result)]);
      };
    } catch (error) {
      showToast("Search failed", error.message, "error");
    } finally {
      el("placingSave").disabled = false;
    }
  }

  // ---------- Places list ----------

  function allPlaceEntries() {
    const entries = new Map(state.names.map((entry) => [entry.id, entry]));
    // Saved places whose name has left the sheet stay editable.
    state.places.forEach((place) => {
      if (!entries.has(place.id)) entries.set(place.id, { id: place.id, kind: place.kind, name: place.name });
    });
    return [...entries.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }

  function renderPlacesPanel() {
    const entries = allPlaceEntries();
    const setCount = entries.filter((entry) => state.places.has(entry.id)).length;
    el("placesCount").textContent = `${setCount}/${entries.length}`;
    document.querySelectorAll("[data-places-filter]").forEach((button) => {
      const active = button.dataset.placesFilter === state.placesFilter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (el("placesPanel").hidden) return;
    const query = norm(el("placesSearch").value);
    const shown = entries.filter((entry) =>
      (state.placesFilter === "all" || !state.places.has(entry.id)) && (!query || norm(entry.name).includes(query))
    );
    el("placesList").innerHTML = shown.length
      ? shown.map((entry) => {
          const place = state.places.get(entry.id);
          return `
            <div class="place-row${place ? " is-set" : ""}" data-place-id="${escapeHtml(entry.id)}">
              <i class="legend-dot legend-${entry.kind}" aria-hidden="true"></i>
              <div class="place-copy">
                <span class="place-name">${escapeHtml(entry.name)}</span>
                <span class="place-meta">${entry.kind === "withdrawal" ? "Withdrawal" : "Supplier"} · ${place ? `On the map · saved by ${escapeHtml(place.updated_by)}` : "No location yet"}</span>
              </div>
              ${place ? `<button class="icon-btn" type="button" data-place-action="focus" aria-label="Show ${escapeHtml(entry.name)} on the map" title="Show on map">
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg></button>` : ""}
              <button class="btn ${place ? "btn-ghost" : "btn-primary"} compact" type="button" data-place-action="locate">${place ? "Edit" : "Set"}</button>
            </div>`;
        }).join("")
      : `<p class="empty">${query ? "No names match that search." : state.placesFilter === "missing" ? "Every supplier and withdrawal has a location." : "No names found in PP."}</p>`;
  }

  function setMapTab(tab) {
    state.mapTab = tab;
    document.querySelectorAll("[data-map-tab]").forEach((button) => {
      const active = button.dataset.mapTab === tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
    el("routeTools").hidden = tab !== "route";
    el("placesPanel").hidden = tab !== "places";
    el("routeResult").hidden = tab !== "route";
    renderPlacesPanel();
  }

  function onMapClick(event) {
    if (state.placing) {
      const { kind, name } = state.placing;
      stopPlacing();
      void savePlace(kind, name, event.latlng.lat, event.latlng.lng);
    } else if (state.pickingStart) {
      state.customStart = { lat: event.latlng.lat, lng: event.latlng.lng };
      stopPlacing();
      renderStartOptions();
      el("routeStart").value = "custom";
      state.routeKey = "";
      void planRoute({ auto: true });
    }
  }

  // ---------- Route ----------

  function renderStartOptions() {
    const select = el("routeStart");
    const current = select.value;
    const options = [];
    if (state.zaki) options.push(["zaki", "Start: Zaki's location"]);
    if (state.customStart) options.push(["custom", "Start: point on map"]);
    options.push(["pick", "Start: click on map…"]);
    [...state.places.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((place) => options.push([`place:${place.id}`, `Start: ${place.name}`]));
    select.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join("");
    const wanted = current || savedStart();
    if (options.some(([value]) => value === wanted)) select.value = wanted;
  }

  function startPoint() {
    const choice = el("routeStart").value;
    if (choice === "zaki" && state.zaki) return { lat: state.zaki.latitude, lng: state.zaki.longitude, label: "Zaki" };
    if (choice === "custom" && state.customStart) return { ...state.customStart, label: "Start" };
    if (choice.startsWith("place:")) {
      const place = state.places.get(choice.slice(6));
      if (place) return { lat: place.latitude, lng: place.longitude, label: place.name };
    }
    return null;
  }

  function distanceKm(a, b) {
    const rad = (value) => (value * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(h));
  }

  function nearestNeighbourOrder(start, stops) {
    const left = [...stops];
    const ordered = [];
    let here = start;
    while (left.length) {
      left.sort((a, b) => distanceKm(here, a) - distanceKm(here, b));
      here = left.shift();
      ordered.push(here);
    }
    return ordered;
  }

  // OSRM's free trip service orders the stops by driving time (no traffic);
  // Google Maps then applies live traffic when Zaki navigates.
  async function orderStops(start, stops) {
    const coords = [start, ...stops].map((point) => `${point.lng.toFixed(6)},${point.lat.toFixed(6)}`).join(";");
    try {
      const response = await fetch(`${OSRM_TRIP}${coords}?source=first&roundtrip=false&destination=any&overview=full&geometries=geojson`, {
        signal: AbortSignal.timeout(12000),
      });
      const data = await response.json();
      if (data.code !== "Ok" || !data.trips?.[0]) throw new Error(data.message || "No trip");
      const ordered = data.waypoints.slice(1)
        .map((waypoint, index) => ({ stop: stops[index], position: waypoint.waypoint_index }))
        .sort((a, b) => a.position - b.position)
        .map((item) => item.stop);
      const trip = data.trips[0];
      const legs = trip.legs.map((leg) => ({ km: leg.distance / 1000, minutes: leg.duration / 60 }));
      return { ordered, legs, geometry: trip.geometry.coordinates.map(([lng, lat]) => [lat, lng]), km: trip.distance / 1000, minutes: trip.duration / 60, roads: true };
    } catch {
      const ordered = nearestNeighbourOrder(start, stops);
      const legs = [];
      [start, ...ordered].reduce((a, b) => { legs.push({ km: distanceKm(a, b), minutes: null }); return b; });
      const km = legs.reduce((sum, leg) => sum + leg.km, 0);
      return { ordered, legs, geometry: [start, ...ordered].map((p) => [p.lat, p.lng]), km, minutes: null, roads: false };
    }
  }

  function googleLinks(start, stops) {
    const links = [];
    let origin = start;
    // Starting at one of the stops: don't send Google back to where Zaki already is.
    const ordered = stops.filter((stop) => stop.lat !== start.lat || stop.lng !== start.lng);
    if (!ordered.length) return links;
    for (let i = 0; i < ordered.length; i += GOOGLE_STOPS_PER_LINK) {
      const chunk = ordered.slice(i, i + GOOGLE_STOPS_PER_LINK);
      const point = (p) => `${p.lat},${p.lng}`;
      const params = new URLSearchParams({ api: "1", travelmode: "driving", origin: point(origin), destination: point(chunk[chunk.length - 1]) });
      if (chunk.length > 1) params.set("waypoints", chunk.slice(0, -1).map(point).join("|"));
      links.push(`https://www.google.com/maps/dir/?${params}`);
      origin = chunk[chunk.length - 1];
    }
    return links;
  }

  const startStorageKey = () => `paydesk-route-start-${todayKey()}`;

  function savedStart() {
    try {
      return localStorage.getItem(startStorageKey()) || "";
    } catch {
      return "";
    }
  }

  function rememberStart(value) {
    try {
      localStorage.setItem(startStorageKey(), value);
    } catch {
      // Remembering the start is only a convenience.
    }
  }

  // Groups today's lines by map place. Finished stops carry the time Zaki
  // finished them (his phone post, or the Desk status change).
  function groupStops(predicate) {
    const byPlace = new Map();
    const unplaced = [];
    state.tasks.filter(predicate).forEach((task) => {
      const place = state.places.get(placeId(task.type, task.name));
      if (!place) return unplaced.push(task);
      if (!byPlace.has(place.id)) byPlace.set(place.id, { place, lat: place.latitude, lng: place.longitude, tasks: [], at: "" });
      const stop = byPlace.get(place.id);
      stop.tasks.push(task);
      const at = String(state.phonePosts.get(task.key)?.updated_at || state.statusTimes.get(task.key) || "");
      if (at > stop.at) stop.at = at;
    });
    return { stops: [...byPlace.values()], unplaced };
  }

  function scheduleRoute() {
    window.clearTimeout(state.routeTimer);
    state.routeTimer = window.setTimeout(() => void planRoute({ auto: true }), 600);
  }

  // The route always runs from Zaki's last finished stop (or the chosen
  // start before he finishes anything) through every open stop, and is
  // re-planned whenever a status, a phone post, or a pin changes.
  async function planRoute({ auto = false } = {}) {
    if (!auto && el("routeStart").value === "pick") {
      if (!ensureMap()) return;
      state.placing = null;
      state.pickingStart = true;
      el("placingText").textContent = "Click the map where Zaki starts";
      el("placingRemove").hidden = true;
      el("placingResults").hidden = true;
      el("placingBar").hidden = false;
      el("todayMap").classList.add("placing");
      return;
    }
    if (!state.sheet) return;
    const finished = groupStops((task) => statusOf(task) === SETTLED[task.type]).stops
      .sort((a, b) => a.at.localeCompare(b.at));
    const { stops, unplaced } = groupStops((task) => OPEN.has(statusOf(task)));
    const last = finished[finished.length - 1];
    const chosen = startPoint();
    const start = last
      ? { lat: last.lat, lng: last.lng, label: last.place.name, finishedAt: last.at }
      : chosen;

    if (!start || !stops.length) {
      state.routeKey = "";
      state.route = { start, stops: [], legs: [], geometry: [], finished, unplaced, empty: true };
      renderPlaces();
      renderRoute({ animate: false });
      return;
    }

    const key = JSON.stringify([start.lat, start.lng, stops.map((stop) => `${stop.place.id}:${stop.tasks.map((t) => t.key).join(",")}`)]);
    if (auto && key === state.routeKey && state.route && !state.route.empty) {
      state.route = { ...state.route, finished, unplaced };
      renderRoute({ animate: false, keepLine: true });
      return;
    }

    el("planRouteButton").disabled = true;
    el("planRouteButton").textContent = "Planning…";
    try {
      const result = await orderStops(start, stops);
      const changed = key !== state.routeKey;
      state.routeKey = key;
      state.route = { start, stops: result.ordered, ...result, finished, unplaced };
      renderPlaces();
      renderRoute({ animate: changed || !auto });
    } finally {
      el("planRouteButton").disabled = false;
      el("planRouteButton").textContent = "Re-plan";
    }
  }


  // Walks the route with Zaki's current cash and flags payments he can't
  // cover yet. With a rate, IQD and USD are pooled since he can exchange.
  function cashWarnings(stops) {
    const totals = computeTotals();
    const rate = totals.rate;
    const cash = { IQD: totals.now.IQD, USD: totals.now.USD };
    return stops.map((stop) => {
      stop.tasks.filter((t) => t.type === "withdrawal").forEach((t) => { cash.IQD += t.iqd; cash.USD += t.usd; });
      stop.tasks.filter((t) => t.type === "payment").forEach((t) => { cash.IQD -= t.iqd; cash.USD -= t.usd; });
      if (rate) {
        const pooled = cash.IQD + cash.USD * rate;
        return pooled < 0 ? `Short about ${money(-pooled, "IQD")} here` : "";
      }
      const short = ["IQD", "USD"].filter((c) => cash[c] < 0).map((c) => money(-cash[c], c));
      return short.length ? `Short ${short.join(" and ")} here` : "";
    });
  }

  // The route draws itself, keeps a soft glow, and a light runs along it.
  function drawAnimatedRoute(geometry, animate = true) {
    L.polyline(geometry, { color: "#ff2d61", weight: 14, opacity: 0.18, className: "route-glow", interactive: false }).addTo(state.layers.route);
    const line = L.polyline(geometry, { color: "#ff4f7b", weight: 4.5, opacity: 0.95, className: "route-line", interactive: false }).addTo(state.layers.route);
    const path = line.getElement();
    if (animate && path?.getTotalLength) {
      const length = path.getTotalLength();
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      path.getBoundingClientRect();
      path.style.transition = "stroke-dashoffset 1.6s cubic-bezier(0.22, 1, 0.36, 1)";
      path.style.strokeDashoffset = "0";
      window.setTimeout(() => { path.style.strokeDasharray = ""; path.style.transition = ""; }, 1700);
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches || geometry.length < 2) return;

    const points = geometry.map((p) => L.latLng(p));
    const distances = [0];
    for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + points[i - 1].distanceTo(points[i]));
    const total = distances[distances.length - 1];
    if (!total) return;
    const runner = L.marker(points[0], {
      interactive: false,
      icon: L.divIcon({ className: "", html: '<span class="route-runner"></span>', iconSize: [16, 16], iconAnchor: [8, 8] }),
    }).addTo(state.layers.route);
    const lapMs = Math.min(14000, Math.max(5000, total / 3));
    const began = performance.now() + (animate ? 1600 : 0);
    const step = (now) => {
      const t = Math.max(0, now - began) % lapMs / lapMs;
      const target = t * total;
      let i = 1;
      while (i < distances.length - 1 && distances[i] < target) i++;
      const span = distances[i] - distances[i - 1] || 1;
      const f = (target - distances[i - 1]) / span;
      const a = points[i - 1];
      const b = points[i];
      runner.setLatLng([a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f]);
      state.runnerFrame = requestAnimationFrame(step);
    };
    state.runnerFrame = requestAnimationFrame(step);
  }

  const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "");
  const legText = (leg) => (leg ? `${leg.km < 10 ? leg.km.toFixed(1) : fmt(leg.km)} km${leg.minutes ? ` · ${Math.max(1, Math.round(leg.minutes))} min` : ""}` : "");

  function renderRoute({ animate = true, keepLine = false } = {}) {
    const box = el("routeResult");
    box.hidden = state.mapTab !== "route";
    const route = state.route;
    if (!keepLine && state.layers) {
      state.layers.route.clearLayers();
      cancelAnimationFrame(state.runnerFrame);
    }
    if (!route) {
      box.innerHTML = `<p class="empty">Loading today's route…</p>`;
      return;
    }
    const { start, stops, legs, geometry, km, minutes, roads, finished, unplaced } = route;

    if (state.map && !keepLine && geometry.length > 1) {
      drawAnimatedRoute(geometry, animate);
      if (start) {
        L.marker([start.lat, start.lng], {
          interactive: true,
          zIndexOffset: 500,
          icon: L.divIcon({ className: "", html: `<span class="route-start${start.finishedAt ? " is-finished" : ""}"></span>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
        }).bindTooltip(start.finishedAt ? `Zaki finished ${escapeHtml(start.label)} at ${clock(start.finishedAt)}` : `Start: ${escapeHtml(start.label)}`, { direction: "top" })
          .addTo(state.layers.route);
      }
      if (animate || !state.routeFitted) {
        state.map.flyToBounds(L.latLngBounds(geometry).pad(0.12), { maxZoom: 15, duration: 1.1 });
        state.routeFitted = true;
      }
    }

    const warnings = stops.length ? cashWarnings(stops) : [];
    const links = stops.length && start ? googleLinks(start, stops) : [];
    const finishedHtml = finished.map((stop) => `
        <li class="route-stop is-done">
          <span class="route-num done" aria-label="Finished">✓</span>
          <div>
            <b>${escapeHtml(stop.place.name)}</b>
            <span class="hint">${stop.tasks.map((t) => `${t.type === "withdrawal" ? "Collected" : "Paid"} ${escapeHtml(amountsText(t.iqd, t.usd))}`).join(" · ")}</span>
            ${stop.at ? `<span class="route-time">Finished ${clock(stop.at)}</span>` : ""}
          </div>
        </li>`).join("");
    const upcomingHtml = stops.map((stop, index) => `
        <li class="route-stop${warnings[index] ? " warn" : ""}">
          <span class="route-num">${index + 1}</span>
          <div>
            <b>${escapeHtml(stop.place.name)}</b>
            <span class="hint">${stop.tasks.map((t) => `${t.type === "withdrawal" ? "Collect" : "Pay"} ${escapeHtml(amountsText(t.iqd, t.usd))}`).join(" · ")}</span>
            <span class="route-leg">${escapeHtml(legText(legs?.[index]))}${index === 0 && start ? ` from ${escapeHtml(start.label)}` : ""}</span>
            ${warnings[index] ? `<span class="route-warn">${escapeHtml(warnings[index])}</span>` : ""}
          </div>
        </li>`).join("");

    let summary;
    if (route.empty && !start) {
      summary = `<div class="route-summary"><strong>Choose where Zaki starts</strong><span class="hint">Pick a start above. Once he finishes a stop, the route starts from there by itself.</span></div>`;
    } else if (route.empty) {
      summary = `<div class="route-summary"><strong>${finished.length ? "All mapped stops are done" : "No stops on the map yet"}</strong><span class="hint">${unplaced.length ? "Set locations in Places to add the rest of today's stops." : "Nothing left to route today."}</span></div>`;
    } else {
      summary = `
        <div class="route-summary">
          <strong>${stops.length} stop${stops.length === 1 ? "" : "s"} left</strong>
          <span class="hint">${legText({ km, minutes })}${minutes ? " without traffic" : ""}${roads ? "" : " · straight-line estimate"}</span>
          <span class="route-from">From <b>${escapeHtml(start.label)}</b>${start.finishedAt ? ` · finished ${clock(start.finishedAt)}` : ""}</span>
          <div class="route-links">
            ${links.map((url, index) => `<a class="btn btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open in Google Maps${links.length > 1 ? ` (${index + 1}/${links.length})` : ""}</a>`).join("")}
          </div>
        </div>`;
    }
    box.innerHTML = `
      ${summary}
      ${finished.length || stops.length ? `<ol class="route-stops">${finishedHtml}${upcomingHtml}</ol>` : ""}
      ${unplaced.length ? `<p class="hint route-unplaced">Not on the map yet: ${unplaced.map((t) => escapeHtml(t.name)).join(", ")}</p>` : ""}`;
  }


  // ---------- Wiring ----------

  async function show() {
    ensureMap();
    renderAll();
    const sheet = window.emailMaker?.sheet();
    if (sheet && sheet !== state.sheet) await onSheet(sheet);
    else if (!sheet) {
      state.loading = true;
      renderStatus();
      void window.emailMaker?.load();
    }
    window.setTimeout(() => state.map?.invalidateSize(), 50);
    if (!state.liveTimer) state.liveTimer = window.setInterval(() => void refreshLive(), LIVE_POLL_MS);
  }

  document.addEventListener("paydesk:sheet", (event) => void onSheet(event.detail));

  document.querySelectorAll("[data-today-list]").forEach((button) =>
    button.addEventListener("click", () => {
      state.list = button.dataset.todayList;
      renderList();
    })
  );

  el("todayList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-task-key]");
    if (!row) return;
    const task = state.tasks.find((item) => item.key === row.dataset.taskKey);
    if (!task) return;
    const statusButton = event.target.closest("[data-status]");
    if (statusButton) return void setStatus(task, statusButton.dataset.status);
    if (event.target.closest("[data-pin]")) {
      if (!ensureMap()) return;
      startPlacing(task.type, task.name);
    }
  });

  el("todayRefreshButton").addEventListener("click", () => void window.emailMaker?.load({ force: true }));
  el("planRouteButton").addEventListener("click", () => {
    state.routeKey = "";
    void planRoute();
  });
  el("routeStart").addEventListener("change", () => {
    const value = el("routeStart").value;
    if (value !== "pick") rememberStart(value);
    if (value === "pick") void planRoute();
    else scheduleRoute();
  });
  const setSideCollapsed = (collapsed) => {
    el("mapLayout").classList.toggle("side-collapsed", collapsed);
    el("sideToggle").setAttribute("aria-expanded", String(!collapsed));
    el("sideToggle").title = collapsed ? "Show the side panel" : "Hide the side panel";
    try {
      localStorage.setItem("paydesk-side-collapsed", collapsed ? "1" : "");
    } catch {
      // Only a convenience.
    }
    window.setTimeout(() => state.map?.invalidateSize(), 320);
  };
  el("sideToggle").addEventListener("click", () => setSideCollapsed(!el("mapLayout").classList.contains("side-collapsed")));
  try {
    if (localStorage.getItem("paydesk-side-collapsed")) setSideCollapsed(true);
  } catch {
    // Ignore unavailable storage.
  }
  el("placingCancel").addEventListener("click", stopPlacing);
  el("placingRemove").addEventListener("click", () => void removePlace());
  el("placingSave").addEventListener("click", () => void findPlacingInput());
  el("placingLink").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void findPlacingInput();
    }
  });
  document.querySelectorAll("[data-map-tab]").forEach((button) =>
    button.addEventListener("click", () => setMapTab(button.dataset.mapTab))
  );
  document.querySelectorAll("[data-places-filter]").forEach((button) =>
    button.addEventListener("click", () => {
      state.placesFilter = button.dataset.placesFilter;
      renderPlacesPanel();
    })
  );
  el("placesSearch").addEventListener("input", renderPlacesPanel);
  el("placesList").addEventListener("click", (event) => {
    const row = event.target.closest("[data-place-id]");
    const action = event.target.closest("[data-place-action]")?.dataset.placeAction;
    if (!row || !action) return;
    const entry = allPlaceEntries().find((item) => item.id === row.dataset.placeId);
    if (!entry || !ensureMap()) return;
    if (action === "focus") {
      const place = state.places.get(entry.id);
      if (place) state.map.flyTo([place.latitude, place.longitude], 16, { duration: 1.1 });
    } else {
      startPlacing(entry.kind, entry.name);
    }
  });
  ["countedIqd", "countedUsd"].forEach((id) => el(id).addEventListener("input", () => renderCashCheck(computeTotals())));
  el("saveCashCheck").addEventListener("click", () => void saveCashCheck());

  window.deskToday = { show };
  if (!el("todayView").hidden) void show();
})();
