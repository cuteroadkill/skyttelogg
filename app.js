// =================================================================
// MSF Skyttelogg — app.js
// Google Identity Services (inloggning) + Sheets API (databas)
// =================================================================

const WEAPONS = [
  { id: "c22", label: "C-vapen (.22 LR)", value: "Vapengrupp C (.22 LR)" },
  { id: "a9",  label: "A-vapen (9mm)",     value: "Vapengrupp A (9mm)" },
  { id: "rev", label: "R-vapen (Revolver)", value: "Vapengrupp R (Revolver)" },
  { id: "gev", label: "Gevär",             value: "Gevär" }
];

let accessToken = null;
let tokenClient = null;
let sheetTitle = null;   // fliknamnet, hämtas en gång vid inloggning
let sheetGridId = null;  // numeriskt sheetId, används för sortering
let currentMode = "training";

// ---------- Init ----------
window.addEventListener("load", () => {
  document.getElementById("dateInput").value = todayLocalStr();
  buildWeaponList();
  wireStaticEvents();

  // Google-biblioteket laddas async — vänta tills det finns
  waitForGoogleLib(() => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: onTokenReceived
    });
    document.getElementById("signInBtn").disabled = false;
  });
});

function waitForGoogleLib(cb) {
  if (window.google && google.accounts && google.accounts.oauth2) return cb();
  setTimeout(() => waitForGoogleLib(cb), 100);
}

function todayLocalStr() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}

// ---------- Inloggning ----------
function wireStaticEvents() {
  document.getElementById("signInBtn").addEventListener("click", () => {
    tokenClient.requestAccessToken({ prompt: "" });
  });
  document.getElementById("signOutBtn").addEventListener("click", signOut);
  document.getElementById("logBtn").addEventListener("click", submitLog);
  document.getElementById("refreshBtn").addEventListener("click", loadRecent);
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
}

async function onTokenReceived(resp) {
  if (resp.error) {
    showToast("Inloggning misslyckades: " + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  document.getElementById("signedOutView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("signOutBtn").classList.remove("hidden");

  try {
    await loadSheetMeta();
    document.getElementById("sheetLink").href =
      `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/edit`;
    loadRecent();
  } catch (e) {
    showToast("Kunde inte läsa kalkylarket: " + e.message, true);
  }
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("signOutBtn").classList.add("hidden");
  document.getElementById("signedOutView").classList.remove("hidden");
}

// ---------- Sheets API ----------
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(path, options = {}) {
  const res = await fetch(`${SHEETS_BASE}/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (res.status === 401) {
    // Token har gått ut - be om en ny och avbryt det här anropet
    accessToken = null;
    tokenClient.requestAccessToken({ prompt: "" });
    throw new Error("Sessionen gick ut, logga in igen.");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadSheetMeta() {
  const data = await sheetsFetch(
    `${CONFIG.SPREADSHEET_ID}?fields=sheets.properties`
  );
  const first = data.sheets[0].properties;
  sheetTitle = first.title;
  sheetGridId = first.sheetId;
}

async function loadRecent() {
  const list = document.getElementById("recentList");
  list.innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    const range = encodeURIComponent(`${sheetTitle}!A2:F`);
    const data = await sheetsFetch(
      `${CONFIG.SPREADSHEET_ID}/values/${range}`
    );
    const rows = (data.values || []).slice(-8).reverse();
    if (rows.length === 0) {
      list.innerHTML = `<p class="muted small">Inga pass loggade ännu.</p>`;
      return;
    }
    list.innerHTML = rows.map(rowToCard).join("");
  } catch (e) {
    list.innerHTML = `<p class="muted small">Kunde inte hämta: ${escapeHtml(e.message)}</p>`;
  }
}

function rowToCard(row) {
  const [date, activity, weapon, amount, , note] = row;
  const line2 = [weapon, amount].filter(Boolean).join(" · ");
  return `
    <div class="recent-item">
      <div class="recent-date mono">${escapeHtml(date || "")}</div>
      <div class="recent-body">
        <div class="recent-activity">${escapeHtml(activity || "")}</div>
        ${line2 ? `<div class="recent-detail muted">${escapeHtml(line2)}</div>` : ""}
        ${note ? `<div class="recent-note muted">${escapeHtml(note)}</div>` : ""}
      </div>
    </div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

async function appendRows(rows) {
  const range = encodeURIComponent(`${sheetTitle}!A:F`);
  await sheetsFetch(
    `${CONFIG.SPREADSHEET_ID}/values/${range}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", body: JSON.stringify({ values: rows }) }
  );
}

async function sortSheetByDateDesc() {
  await sheetsFetch(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        sortRange: {
          range: {
            sheetId: sheetGridId,
            startRowIndex: 1,   // hoppa över rubrikraden
            startColumnIndex: 0,
            endColumnIndex: 6
          },
          sortSpecs: [{ dimensionIndex: 0, sortOrder: "DESCENDING" }]
        }
      }]
    })
  });
}

// ---------- Vapenlista (UI) ----------
function buildWeaponList() {
  const container = document.getElementById("weaponList");
  container.innerHTML = "";

  WEAPONS.forEach(w => container.appendChild(weaponRow(w.value, w.label)));

  // Fritextrad för valfritt vapen
  const row = document.createElement("div");
  row.className = "weapon-row";
  row.dataset.weapon = "";
  row.innerHTML = `
    <input type="checkbox" class="weapon-check">
    <input type="text" class="input custom-name" placeholder="Annat vapen...">
    <div class="stepper disabled">
      <button type="button" class="step-btn" data-delta="-0.5">−</button>
      <span class="amount mono" data-val="1">1</span>
      <button type="button" class="step-btn" data-delta="0.5">+</button>
    </div>`;
  container.appendChild(row);

  wireWeaponRow(row, true);
}

function weaponRow(value, label) {
  const row = document.createElement("div");
  row.className = "weapon-row";
  row.dataset.weapon = value;
  row.innerHTML = `
    <label class="weapon-label">
      <input type="checkbox" class="weapon-check">
      <span>${label}</span>
    </label>
    <div class="stepper disabled">
      <button type="button" class="step-btn" data-delta="-0.5">−</button>
      <span class="amount mono" data-val="1">1</span>
      <button type="button" class="step-btn" data-delta="0.5">+</button>
    </div>`;
  wireWeaponRow(row, false);
  return row;
}

function wireWeaponRow(row, isCustom) {
  const cb = row.querySelector(".weapon-check");
  const stepper = row.querySelector(".stepper");
  const amountEl = row.querySelector(".amount");
  const buttons = row.querySelectorAll(".step-btn");

  function setActive(active) {
    stepper.classList.toggle("disabled", !active);
    buttons.forEach(b => b.disabled = !active);
    row.classList.toggle("active", active);
  }

  cb.addEventListener("change", () => setActive(cb.checked));

  if (isCustom) {
    const nameInput = row.querySelector(".custom-name");
    nameInput.addEventListener("input", () => {
      const has = nameInput.value.trim().length > 0;
      cb.checked = has;
      setActive(has);
    });
  }

  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (!cb.checked) {
        cb.checked = true;
        setActive(true);
        if (parseFloat(btn.dataset.delta) < 0) return;
      }
      let val = parseFloat(amountEl.dataset.val);
      val = Math.min(10, Math.max(0.5, val + parseFloat(btn.dataset.delta)));
      amountEl.dataset.val = val;
      amountEl.textContent = fractionText(val);
    });
  });
}

function fractionText(v) {
  if (v === 0.5) return "½";
  if (v % 1 === 0.5) return Math.floor(v) + "½";
  return String(v);
}
function amountText(v) {
  return fractionText(v) + (v > 1 ? " askar" : " ask");
}

// ---------- Läge ----------
function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll(".mode-btn").forEach(btn => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  const usesWeapons = (mode === "training" || mode === "competition");
  document.getElementById("weaponBlock").classList.toggle("hidden", !usesWeapons);
  document.getElementById("otherActivityBlock").classList.toggle("hidden", usesWeapons);
}

// ---------- Toast ----------
let toastTimer;
function showToast(msg, isError) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.classList.remove("toast-error", "toast-success");
  toast.classList.add(isError ? "toast-error" : "toast-success");
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
}

// ---------- Reset ----------
function resetForm() {
  document.getElementById("noteInput").value = "";
  document.getElementById("activityTypeInput").value = "";
  document.getElementById("dateInput").value = todayLocalStr();
  document.querySelectorAll(".weapon-row").forEach(row => {
    const cb = row.querySelector(".weapon-check");
    cb.checked = false;
    const amountEl = row.querySelector(".amount");
    amountEl.dataset.val = 1;
    amountEl.textContent = "1";
    const custom = row.querySelector(".custom-name");
    if (custom) custom.value = "";
    row.classList.remove("active");
    row.querySelector(".stepper").classList.add("disabled");
    row.querySelectorAll(".step-btn").forEach(b => b.disabled = true);
  });
  setMode("training");
}

// ---------- Submit ----------
async function submitLog() {
  const note = document.getElementById("noteInput").value;
  const dateVal = document.getElementById("dateInput").value;
  const logBtn = document.getElementById("logBtn");

  let rows = [];
  let activity = "Träning";

  if (currentMode === "training" || currentMode === "competition") {
    activity = (currentMode === "competition") ? "Tävling" : "Träning";
    let customError = false;

    document.querySelectorAll(".weapon-row").forEach(row => {
      const cb = row.querySelector(".weapon-check");
      if (!cb.checked) return;
      let weapon = row.dataset.weapon;
      const custom = row.querySelector(".custom-name");
      if (custom) {
        weapon = custom.value.trim();
        if (!weapon) { customError = true; return; }
      }
      const val = parseFloat(row.querySelector(".amount").dataset.val);
      rows.push([dateVal, activity, weapon, amountText(val), "MSF", note]);
    });

    if (customError) return showToast("Skriv in namnet på det valfria vapnet, eller bocka ur raden.", true);
    if (rows.length === 0) return showToast("Välj minst ett vapen!", true);
  } else {
    activity = document.getElementById("activityTypeInput").value.trim();
    if (!activity) return showToast("Skriv vad aktiviteten gäller!", true);
    rows.push([dateVal, activity, "", "", "MSF", note]);
  }

  logBtn.disabled = true;
  showToast("Loggar...", false);

  try {
    await appendRows(rows);
    await sortSheetByDateDesc();
    showToast("Passet är loggat!", false);
    resetForm();
    loadRecent();
  } catch (e) {
    showToast("Ett fel uppstod: " + e.message, true);
  } finally {
    logBtn.disabled = false;
  }
}
