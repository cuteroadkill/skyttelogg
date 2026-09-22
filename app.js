// =================================================================
// Skyttelogg — app.js
// Google Identity Services (inloggning) + Sheets API (databas)
// =================================================================

// Standardvapen som sätts upp första gången (i "Vapen"-fliken i arket).
// Efter det är listan helt användarens egen - hanteras via "Hantera vapen".
const DEFAULT_WEAPONS = [
  "Vapengrupp C (.22 LR)",
  "Vapengrupp A (9mm)",
  "Vapengrupp R (Revolver)",
  "Gevär"
];
let weaponsList = [];

// Fyra kurerade teman + möjlighet att välja valfri egen färg.
// Bakgrund/text/ytor rörs aldrig - bara accentfärgen (mässing som standard).
const THEMES = [
  { id: "brass",  name: "Mässing", hex: "#C4915E", dim: "#8A6740", rgb: "196, 145, 94" },
  { id: "steel",  name: "Stål",    hex: "#6B9BC3", dim: "#4A6D8C", rgb: "107, 155, 195" },
  { id: "forest", name: "Skog",    hex: "#7FA65C", dim: "#5A7A3F", rgb: "127, 166, 92" },
  { id: "wine",   name: "Vinröd",  hex: "#B25A6B", dim: "#7D3E4A", rgb: "178, 90, 107" }
];
const THEME_KEY = "msf_theme";
let currentThemeId = "brass";

// ---------- Anonym användningsräkning (GoatCounter) ----------
// Skickar aldrig persondata - bara "det här hände, en gång till". Om
// skriptet är blockerat (annonsblockerare e.dyl.) eller inte hunnit ladda
// än gör funktionen ingenting, kraschar aldrig resten av appen.
function trackEvent(name) {
  try {
    if (window.goatcounter && window.goatcounter.count) {
      window.goatcounter.count({ path: name, event: true });
    }
  } catch (e) { /* strunta i, aldrig kritiskt */ }
}

let accessToken = null;
let tokenClient = null;
let spreadsheetId = null;   // dynamiskt: från config.js ELLER auto-skapat ark
let sheetTitle = null;   // fliknamnet, hämtas en gång vid inloggning
let sheetGridId = null;  // numeriskt sheetId, används för sortering
let weaponsSheetGridId = null; // numeriskt sheetId för "Vapen"-fliken
let currentMode = "training";

const LOCAL_SHEET_KEY = "msf_spreadsheet_id";
const LOCATION_KEY = "skyttelogg_location";
const DEFAULT_LOCATION = "Skjutbana";
const SPREADSHEET_FILE_NAME = "Skyttelogg";
const QUEUE_KEY = "msf_pending_queue";
const WEAPONS_TAB_NAME = "Vapen";
const HEADER_ROW = ["Datum", "Aktivitet", "Vapengrupp/Typ", "Antal skott", "Plats/Förening", "Notering"];

// ---------- Init ----------
window.addEventListener("load", () => {
  loadSavedTheme();
  setDateFor("dateInput", "dateDisplay", todayLocalStr());
  wireDatePicker("dateInput", "dateDisplay");
  wireDatePicker("editDateInput", "editDateDisplay");
  wireDatePicker("exportFromInput", "exportFromDisplay");
  wireDatePicker("exportToInput", "exportToDisplay");
  wireStaticEvents();
  updateQueueBadge();
  document.getElementById("locationInput").value =
    localStorage.getItem(LOCATION_KEY) || DEFAULT_LOCATION;
  window.addEventListener("online", trySyncQueue);

  if (CONFIG.ISSUES_URL) {
    const link = document.getElementById("issuesLink");
    link.href = CONFIG.ISSUES_URL;
    link.classList.remove("hidden");
  }

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

function formatDateDisplay(isoStr) {
  const [y, m, d] = isoStr.split("-");
  return `${y}/${m}/${d}`;
}

function setDateFor(inputId, displayId, isoStr) {
  document.getElementById(inputId).value = isoStr;
  document.getElementById(displayId).textContent = formatDateDisplay(isoStr);
}

function wireDatePicker(inputId, displayId) {
  const dateInput = document.getElementById(inputId);
  const dateDisplay = document.getElementById(displayId);

  dateDisplay.addEventListener("click", () => {
    if (dateInput.showPicker) {
      dateInput.showPicker();
    } else {
      dateInput.focus();
      dateInput.click();
    }
  });

  dateInput.addEventListener("change", () => {
    if (dateInput.value) dateDisplay.textContent = formatDateDisplay(dateInput.value);
  });
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
  document.querySelectorAll(".unit-btn").forEach(btn => {
    btn.addEventListener("click", () => setAmmoUnit(btn.dataset.unit));
  });

  // Redigeringsoverlay
  document.getElementById("editCancelBtn").addEventListener("click", closeEditOverlay);
  document.getElementById("editSaveBtn").addEventListener("click", saveEditedRow);
  document.getElementById("editDeleteBtn").addEventListener("click", deleteEditedRow);
  document.getElementById("editOverlay").addEventListener("click", e => {
    if (e.target.id === "editOverlay") closeEditOverlay();
  });

  // Exportoverlay
  document.getElementById("exportPdfBtn").addEventListener("click", openExportOverlay);
  document.getElementById("exportCancelBtn").addEventListener("click", closeExportOverlay);
  document.getElementById("exportGenerateBtn").addEventListener("click", generatePdf);
  document.getElementById("exportOverlay").addEventListener("click", e => {
    if (e.target.id === "exportOverlay") closeExportOverlay();
  });

  // Vapenhantering
  document.getElementById("manageWeaponsBtn").addEventListener("click", openWeaponsOverlay);
  document.getElementById("weaponsCloseBtn").addEventListener("click", closeWeaponsOverlay);
  document.getElementById("addWeaponBtn").addEventListener("click", addWeapon);
  document.getElementById("pickerBtn").addEventListener("click", openDrivePicker);
  document.getElementById("newWeaponInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addWeapon(); }
  });
  document.getElementById("weaponsOverlay").addEventListener("click", e => {
    if (e.target.id === "weaponsOverlay") closeWeaponsOverlay();
  });

  // Peka om till befintligt ark
  document.getElementById("reconnectSheetBtn").addEventListener("click", async () => {
    const input = document.getElementById("reconnectSheetInput");
    const btn = document.getElementById("reconnectSheetBtn");
    if (!input.value.trim()) return;
    btn.disabled = true;
    try {
      await reconnectSheet(input.value);
      input.value = "";
      showToast("Nu pekar appen på det arket!", false);
    } catch (e) {
      showToast("Kunde inte använda det arket: " + e.message, true);
    } finally {
      btn.disabled = false;
    }
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
  document.getElementById("topbarActions").classList.remove("hidden");

  try {
    await ensureSpreadsheet();
    await loadSheetMeta();
    await ensureWeaponsSheet();
    await loadWeapons();
    buildWeaponList();
    document.getElementById("sheetLink").href =
      `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    await trySyncQueue();
    loadRecent();
  } catch (e) {
    showToast("Kunde inte läsa kalkylarket: " + e.message, true);
  }
}

// Prioritetsordning för att avgöra vilket ark som ska användas:
// 1. config.js pekar redan på ett specifikt ark (t.ex. en egen fristående
//    installation) - använd det, rör ingenting mer.
// 2. Redan känt på DEN HÄR enheten sedan tidigare (snabbaste vägen).
// 3. Inget av ovan - skapa ett nytt ark, med rätt rubriker på plats.
//
// OBS: med drive.file-scopet kan appen inte längre söka igenom hela Driven
// efter ett ark med rätt namn (det scopet ser bara filer appen redan fått
// tillgång till). Byter man enhet måste man därför välja sitt befintliga
// ark via Google-filväljaren under Inställningar → Ark, en gång.
async function ensureSpreadsheet() {
  if (CONFIG.SPREADSHEET_ID) {
    spreadsheetId = CONFIG.SPREADSHEET_ID;
    return;
  }
  const stored = localStorage.getItem(LOCAL_SHEET_KEY);
  if (stored) {
    spreadsheetId = stored;
    return;
  }

  showToast("Skapar ditt kalkylark...", false);

  const created = await sheetsFetch("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: SPREADSHEET_FILE_NAME },
      sheets: [{ properties: { title: "Loggbok" } }]
    })
  });
  spreadsheetId = created.spreadsheetId;

  const headerRange = encodeURIComponent("Loggbok!A1:F1");
  await sheetsFetch(
    `${spreadsheetId}/values/${headerRange}?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: JSON.stringify({ values: [HEADER_ROW] }) }
  );

  // Fetstil på rubrikraden - litet estetiskt plus, inget kritiskt om det misslyckas
  try {
    await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          repeatCell: {
            range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold"
          }
        }]
      })
    });
  } catch (e) { /* kosmetiskt, strunta i fel här */ }

  localStorage.setItem(LOCAL_SHEET_KEY, spreadsheetId);
  showToast("Ditt kalkylark är klart!", false);
}

// Peka om till ett specifikt, befintligt ark - antingen valt via Google-
// filväljaren (Picker) eller inklistrat ID/länk manuellt som reserv.
// Skriver INTE över spreadsheetId permanent i configen - bara i den här
// enhetens lokala minne, precis som auto-skapandet gör.
async function reconnectSheet(idOrUrl) {
  let id = idOrUrl.trim();
  const match = id.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) id = match[1];
  if (!id) throw new Error("Inget ID angavs.");

  spreadsheetId = id;
  await loadSheetMeta();       // verifierar samtidigt att ID:t är giltigt och nåbart
  await ensureWeaponsSheet();
  await loadWeapons();
  buildWeaponList();
  localStorage.setItem(LOCAL_SHEET_KEY, spreadsheetId);
  document.getElementById("sheetLink").href =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  loadRecent();
}

// ---------- Google Picker (filväljare för "Ark"-inställningen) ----------
// Laddas lat - bara när man faktiskt trycker på "Välj i Drive", så den
// inte tynger ner appens starttid för alla som aldrig behöver den.
let pickerLoaded = false;

function openDrivePicker() {
  if (!CONFIG.PICKER_API_KEY) {
    showToast("Picker är inte konfigurerad (saknar API-nyckel).", true);
    return;
  }
  if (pickerLoaded) {
    showPickerDialog();
    return;
  }
  const script = document.createElement("script");
  script.src = "https://apis.google.com/js/api.js";
  script.onload = () => {
    gapi.load("picker", () => {
      pickerLoaded = true;
      showPickerDialog();
    });
  };
  document.head.appendChild(script);
}

function showPickerDialog() {
  const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
    .setMode(google.picker.DocsViewMode.LIST);

  const picker = new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(accessToken)
    .setDeveloperKey(CONFIG.PICKER_API_KEY)
    .setCallback(pickerCallback)
    .build();
  picker.setVisible(true);
}

async function pickerCallback(data) {
  if (data.action !== google.picker.Action.PICKED) return;
  const fileId = data.docs[0].id;
  try {
    await reconnectSheet(fileId);
    showToast("Nu pekar appen på det arket!", false);
  } catch (e) {
    showToast("Kunde inte använda det arket: " + e.message, true);
  }
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("topbarActions").classList.add("hidden");
  document.getElementById("signedOutView").classList.remove("hidden");
}

// ---------- Sheets API ----------
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(path, options = {}) {
  const url = path ? `${SHEETS_BASE}/${path}` : SHEETS_BASE;
  const res = await fetch(url, {
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
    `${spreadsheetId}?fields=sheets.properties`
  );
  const all = data.sheets.map(s => s.properties);
  const logSheet = all.find(s => s.title !== WEAPONS_TAB_NAME) || all[0];
  sheetTitle = logSheet.title;
  sheetGridId = logSheet.sheetId;
  const weaponsSheet = all.find(s => s.title === WEAPONS_TAB_NAME);
  weaponsSheetGridId = weaponsSheet ? weaponsSheet.sheetId : null;
}

// Skapar fliken "Vapen" om den inte redan finns, och fyller den med
// standardvapnen som utgångspunkt (samma text som redan används i arket).
async function ensureWeaponsSheet() {
  if (weaponsSheetGridId !== null) return;

  const result = await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: WEAPONS_TAB_NAME } } }]
    })
  });
  weaponsSheetGridId = result.replies[0].addSheet.properties.sheetId;

  const range = encodeURIComponent(`${WEAPONS_TAB_NAME}!A1:B${DEFAULT_WEAPONS.length}`);
  await sheetsFetch(
    `${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: JSON.stringify({ values: DEFAULT_WEAPONS.map(w => [w, ""]) }) }
  );
}

async function loadWeapons() {
  try {
    const range = encodeURIComponent(`${WEAPONS_TAB_NAME}!A:B`);
    const data = await sheetsFetch(`${spreadsheetId}/values/${range}`);
    const values = (data.values || [])
      .map(r => ({ name: (r[0] || "").trim(), favorite: r[1] === "1" }))
      .filter(w => w.name);
    weaponsList = values.length > 0
      ? values
      : DEFAULT_WEAPONS.map(name => ({ name, favorite: false }));
  } catch (e) {
    weaponsList = DEFAULT_WEAPONS.map(name => ({ name, favorite: false })); // reserv
  }
}

async function saveWeapons(list) {
  // Rensa hela intervallet först - annars kan borttagna vapen bli kvar
  // som spökrader om nya listan är kortare än den gamla.
  await sheetsFetch(
    `${spreadsheetId}/values/${encodeURIComponent(WEAPONS_TAB_NAME + "!A:B")}:clear`,
    { method: "POST" }
  );
  if (list.length > 0) {
    const range = encodeURIComponent(`${WEAPONS_TAB_NAME}!A1:B${list.length}`);
    await sheetsFetch(
      `${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: list.map(w => [w.name, w.favorite ? "1" : ""]) }) }
    );
  }
}

let recentRowsCache = {}; // radnummer (1-indexerat i arket) -> radens värden

async function loadRecent() {
  const list = document.getElementById("recentList");
  list.innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    const range = encodeURIComponent(`${sheetTitle}!A2:F`);
    const data = await sheetsFetch(
      `${spreadsheetId}/values/${range}`
    );
    const allRows = data.values || [];
    // Arket sorteras redan nyast-först vid varje loggning (se sortSheetByDateDesc),
    // så de FÖRSTA raderna är de senaste - ingen omvändning behövs.
    const rows = allRows.slice(0, 8);
    recentRowsCache = {};
    if (rows.length === 0) {
      list.innerHTML = `<p class="muted small">Inga pass loggade ännu.</p>`;
      return;
    }
    list.innerHTML = rows.map((row, i) => {
      const rowNumber = i + 2; // rad 2 i arket = första dataraden (efter rubriken)
      recentRowsCache[rowNumber] = row;
      return rowToCard(row, rowNumber);
    }).join("");
    list.querySelectorAll(".recent-item").forEach(el => {
      el.addEventListener("click", () => openEditOverlay(parseInt(el.dataset.row, 10)));
    });
  } catch (e) {
    list.innerHTML = `<p class="muted small">Kunde inte hämta: ${escapeHtml(e.message)}</p>`;
  }
}

function rowToCard(row, rowNumber) {
  const [date, activity, weapon, amount, , note] = row;
  const line2 = [weapon, amount].filter(Boolean).join(" · ");
  return `
    <div class="recent-item" data-row="${rowNumber}">
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
    `${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", body: JSON.stringify({ values: rows }) }
  );
}

async function sortSheetByDateDesc() {
  await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
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

// ---------- Offline-kö ----------
// Om loggning misslyckas pga uteblivet nätverk sparas passet lokalt på
// enheten (bara som en tillfällig buffert - den riktiga datan lever i
// arket så fort synk lyckas) och skickas automatiskt så fort uppkoppling
// finns igen.
function getQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
  catch (e) { return []; }
}

function setQueue(queue) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  updateQueueBadge();
}

function updateQueueBadge() {
  const badge = document.getElementById("queueBadge");
  const n = getQueue().length;
  if (n === 0) {
    badge.classList.add("hidden");
    return;
  }
  badge.textContent = n === 1
    ? "1 pass väntar på synk"
    : `${n} pass väntar på synk`;
  badge.classList.remove("hidden");
}

function queueRows(rows) {
  const queue = getQueue();
  queue.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2), rows });
  setQueue(queue);
}

async function trySyncQueue() {
  if (!accessToken || !spreadsheetId) return;
  let queue = getQueue();
  if (queue.length === 0) return;

  let syncedAny = false;
  while (queue.length > 0) {
    try {
      await appendRows(queue[0].rows);
      queue.shift();
      setQueue(queue);
      syncedAny = true;
    } catch (e) {
      break; // fortfarande offline (eller annat fel) - försök igen nästa gång
    }
  }

  if (syncedAny) {
    try { await sortSheetByDateDesc(); } catch (e) { /* strunta i, kosmetiskt */ }
    showToast("Köade pass synkade!", false);
    loadRecent();
  }
}

// ---------- Vapenlista (UI) ----------
function buildWeaponList() {
  const container = document.getElementById("weaponList");
  container.innerHTML = "";

  weaponsList.forEach(w => container.appendChild(weaponChip(w.name, w.name)));

  // Fritextchip för valfritt vapen - alltid tillgängligt, oavsett hanterad lista
  const chip = document.createElement("label");
  chip.className = "weapon-chip weapon-chip--custom";
  chip.dataset.weapon = "";
  chip.innerHTML = `
    <input type="checkbox" class="chip-input">
    <input type="text" class="input custom-name" placeholder="Annat vapen...">
    <span class="chip-stepper">
      <button type="button" class="step-btn" data-delta="-0.5">−</button>
      <span class="amount mono" data-val="1">1</span>
      <button type="button" class="step-btn" data-delta="0.5">+</button>
    </span>
    <span class="chip-shots">
      <input type="number" class="shots-input mono" inputmode="numeric" min="0" placeholder="Antal">
    </span>`;
  container.appendChild(chip);
  wireChip(chip, true);
}

// ---------- Tema ----------
function hexToRgbTriple(hex) {
  const h = hex.replace("#", "");
  const r = parseInt(h.substr(0, 2), 16);
  const g = parseInt(h.substr(2, 2), 16);
  const b = parseInt(h.substr(4, 2), 16);
  return `${r}, ${g}, ${b}`;
}

function darkenHex(hex, factor) {
  const h = hex.replace("#", "");
  const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  const r = parseInt(h.substr(0, 2), 16) * factor;
  const g = parseInt(h.substr(2, 2), 16) * factor;
  const b = parseInt(h.substr(4, 2), 16) * factor;
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function applyThemeColors(hex, dim, rgb, id) {
  const root = document.documentElement.style;
  root.setProperty("--brass", hex);
  root.setProperty("--brass-dim", dim);
  root.setProperty("--brass-rgb", rgb);
  currentThemeId = id;
  updateActiveSwatch();
}

function selectPresetTheme(id) {
  const t = THEMES.find(t => t.id === id);
  if (!t) return;
  applyThemeColors(t.hex, t.dim, t.rgb, t.id);
  localStorage.setItem(THEME_KEY, JSON.stringify({ id: t.id, hex: t.hex }));
}

function selectCustomTheme(hex) {
  applyThemeColors(hex, darkenHex(hex, 0.62), hexToRgbTriple(hex), "custom");
  localStorage.setItem(THEME_KEY, JSON.stringify({ id: "custom", hex }));
}

function loadSavedTheme() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(THEME_KEY) || "null"); }
  catch (e) { saved = null; }
  if (!saved) return;

  if (saved.id === "custom" && saved.hex) {
    applyThemeColors(saved.hex, darkenHex(saved.hex, 0.62), hexToRgbTriple(saved.hex), "custom");
  } else {
    const t = THEMES.find(t => t.id === saved.id);
    if (t) applyThemeColors(t.hex, t.dim, t.rgb, t.id);
  }
}

function renderThemeSwatches() {
  const container = document.getElementById("themeSwatches");
  const customHex = currentThemeId === "custom"
    ? (JSON.parse(localStorage.getItem(THEME_KEY) || "{}").hex || "#C4915E")
    : "#C4915E";

  container.innerHTML = THEMES.map(t => `
    <button type="button" class="theme-swatch" data-theme="${t.id}" style="background:${t.hex}" title="${t.name}" aria-label="${t.name}"></button>
  `).join("") + `
    <label class="theme-swatch theme-swatch--custom" title="Egen färg" aria-label="Egen färg">
      <input type="color" id="customThemeInput" value="${customHex}">
    </label>
  `;

  container.querySelectorAll(".theme-swatch[data-theme]").forEach(btn => {
    btn.addEventListener("click", () => selectPresetTheme(btn.dataset.theme));
  });
  document.getElementById("customThemeInput").addEventListener("input", e => {
    selectCustomTheme(e.target.value);
  });
  updateActiveSwatch();
}

function updateActiveSwatch() {
  document.querySelectorAll(".theme-swatch[data-theme]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === currentThemeId);
  });
  const customSwatch = document.querySelector(".theme-swatch--custom");
  if (customSwatch) customSwatch.classList.toggle("active", currentThemeId === "custom");
}

// ---------- Hantera vapen (overlay) ----------
function openWeaponsOverlay() {
  renderThemeSwatches();
  renderWeaponsManageList();
  document.getElementById("weaponsOverlay").classList.remove("hidden");
}

function closeWeaponsOverlay() {
  document.getElementById("weaponsOverlay").classList.add("hidden");
  document.getElementById("newWeaponInput").value = "";
}

function renderWeaponsManageList() {
  const container = document.getElementById("weaponsManageList");
  if (weaponsList.length === 0) {
    container.innerHTML = `<p class="muted small">Inga vapen tillagda än.</p>`;
    return;
  }
  container.innerHTML = weaponsList.map((w, i) => `
    <div class="weapon-manage-row${w.favorite ? " favorite" : ""}" data-index="${i}">
      <span class="weapon-drag-handle" aria-label="Dra för att ändra ordning">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="4" y1="8" x2="20" y2="8"></line>
          <line x1="4" y1="16" x2="20" y2="16"></line>
        </svg>
      </span>
      <button type="button" class="weapon-star-btn" data-index="${i}" aria-label="${w.favorite ? "Ta bort favorit" : "Gör till favorit"}">${w.favorite ? "★" : "☆"}</button>
      <span class="weapon-manage-name">${escapeHtml(w.name)}</span>
      <button type="button" class="weapon-remove-btn" data-index="${i}" aria-label="Ta bort">×</button>
    </div>`).join("");

  container.querySelectorAll(".weapon-remove-btn").forEach(btn => {
    btn.addEventListener("click", () => removeWeapon(parseInt(btn.dataset.index, 10)));
  });
  container.querySelectorAll(".weapon-star-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleFavorite(parseInt(btn.dataset.index, 10)));
  });
  container.querySelectorAll(".weapon-manage-row").forEach(row => {
    wireDragHandle(row);
  });
}

function toggleFavorite(index) {
  const item = weaponsList[index];
  item.favorite = !item.favorite;
  if (item.favorite) {
    // Flytta favoritmarkerat vapen till toppen av listan
    weaponsList.splice(index, 1);
    weaponsList.unshift(item);
  }
  persistAndRefreshWeapons();
}

// ---------- Dra för att ändra ordning ----------
// Fungerar med både touch och mus via Pointer Events. Endast själva
// handtaget (de två strecken) startar en dragning, inte hela raden -
// annars kolliderar det med tryck på stjärna/kryss.
let dragState = null;

function wireDragHandle(row) {
  const handle = row.querySelector(".weapon-drag-handle");

  handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    const container = document.getElementById("weaponsManageList");
    const rows = Array.from(container.querySelectorAll(".weapon-manage-row"));
    dragState = {
      row,
      pointerId: e.pointerId,
      startY: e.clientY,
      startIndex: rows.indexOf(row),
      rowHeight: row.getBoundingClientRect().height
    };
    row.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener("pointermove", e => {
    if (!dragState || dragState.row !== row || e.pointerId !== dragState.pointerId) return;
    const dy = e.clientY - dragState.startY;
    row.style.transform = `translateY(${dy}px)`;
  });

  const endDrag = e => {
    if (!dragState || dragState.row !== row || e.pointerId !== dragState.pointerId) return;
    const dy = e.clientY - dragState.startY;
    const moveBy = Math.round(dy / dragState.rowHeight);
    const newIndex = Math.max(0, Math.min(weaponsList.length - 1, dragState.startIndex + moveBy));

    row.style.transform = "";
    row.classList.remove("dragging");

    if (newIndex !== dragState.startIndex) {
      const [moved] = weaponsList.splice(dragState.startIndex, 1);
      weaponsList.splice(newIndex, 0, moved);
      persistAndRefreshWeapons();
    }
    dragState = null;
  };

  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}

async function persistAndRefreshWeapons() {
  renderWeaponsManageList();
  try {
    await saveWeapons(weaponsList);
    buildWeaponList();
  } catch (e) {
    showToast("Kunde inte spara: " + e.message, true);
  }
}

async function addWeapon() {
  const input = document.getElementById("newWeaponInput");
  const name = input.value.trim();
  if (!name) return;
  if (weaponsList.some(w => w.name === name)) {
    showToast("Det vapnet finns redan i listan.", true);
    return;
  }
  weaponsList.push({ name, favorite: false });
  input.value = "";
  await persistAndRefreshWeapons();
}

async function removeWeapon(index) {
  weaponsList.splice(index, 1);
  await persistAndRefreshWeapons();
}

function weaponChip(value, label) {
  const chip = document.createElement("label");
  chip.className = "weapon-chip";
  chip.dataset.weapon = value;
  chip.innerHTML = `
    <input type="checkbox" class="chip-input">
    <span class="chip-label">${label}</span>
    <span class="chip-stepper">
      <button type="button" class="step-btn" data-delta="-0.5">−</button>
      <span class="amount mono" data-val="1">1</span>
      <button type="button" class="step-btn" data-delta="0.5">+</button>
    </span>
    <span class="chip-shots">
      <input type="number" class="shots-input mono" inputmode="numeric" min="0" placeholder="Antal">
    </span>`;
  wireChip(chip, false);
  return chip;
}

function wireChip(chip, isCustom) {
  const cb = chip.querySelector(".chip-input");
  const amountEl = chip.querySelector(".amount");
  const buttons = chip.querySelectorAll(".step-btn");
  const shotsInput = chip.querySelector(".shots-input");

  if (isCustom) {
    const nameInput = chip.querySelector(".custom-name");
    // Skriver man i fältet räknas raden som vald - annars måste man
    // kryssa i den manuellt trots att den saknar synlig kryssruta
    nameInput.addEventListener("click", e => e.stopPropagation());
    nameInput.addEventListener("input", () => {
      cb.checked = nameInput.value.trim().length > 0;
    });
  }

  shotsInput.addEventListener("click", e => e.stopPropagation());
  shotsInput.addEventListener("focus", () => { cb.checked = true; });

  buttons.forEach(btn => {
    btn.addEventListener("click", e => {
      e.preventDefault(); // hindra att klicket också togglar kryssrutan via label
      if (!cb.checked) {
        cb.checked = true;
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

// ---------- Mängdenhet (askar / skott) ----------
let currentAmmoUnit = "ask";

function setAmmoUnit(unit) {
  currentAmmoUnit = unit;
  document.getElementById("weaponList").dataset.unit = unit;
  document.querySelectorAll(".unit-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.unit === unit);
  });
  document.querySelector(".hint").textContent = unit === "ask"
    ? "Mängd anges i askar per vapengrupp"
    : "Mängd anges i exakt antal skott per vapengrupp";
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
  setDateFor("dateInput", "dateDisplay", todayLocalStr());
  document.querySelectorAll(".weapon-chip").forEach(chip => {
    chip.querySelector(".chip-input").checked = false;
    const amountEl = chip.querySelector(".amount");
    amountEl.dataset.val = 1;
    amountEl.textContent = "1";
    const custom = chip.querySelector(".custom-name");
    if (custom) custom.value = "";
    const shotsInput = chip.querySelector(".shots-input");
    if (shotsInput) shotsInput.value = "";
  });
  setAmmoUnit("ask");
  setMode("training");
}

// ---------- Redigera / radera loggat pass ----------
let editingRow = null;

function openEditOverlay(rowNumber) {
  const row = recentRowsCache[rowNumber];
  if (!row) return;
  editingRow = rowNumber;
  const [date, activity, weapon, amount, location, note] = row;
  setDateFor("editDateInput", "editDateDisplay", date || todayLocalStr());
  document.getElementById("editActivity").value = activity || "";
  document.getElementById("editWeapon").value = weapon || "";
  document.getElementById("editLocation").value = location || DEFAULT_LOCATION;
  document.getElementById("editAmount").value = amount || "";
  document.getElementById("editNote").value = note || "";
  document.getElementById("editOverlay").classList.remove("hidden");
}

function closeEditOverlay() {
  document.getElementById("editOverlay").classList.add("hidden");
  editingRow = null;
}

async function saveEditedRow() {
  if (!editingRow) return;
  const date = document.getElementById("editDateInput").value;
  const activity = document.getElementById("editActivity").value.trim();
  const weapon = document.getElementById("editWeapon").value.trim();
  const location = document.getElementById("editLocation").value.trim() || DEFAULT_LOCATION;
  const amount = document.getElementById("editAmount").value.trim();
  const note = document.getElementById("editNote").value;

  if (!date || !activity) {
    return showToast("Datum och aktivitet krävs.", true);
  }

  const btn = document.getElementById("editSaveBtn");
  btn.disabled = true;
  try {
    const range = encodeURIComponent(`${sheetTitle}!A${editingRow}:F${editingRow}`);
    await sheetsFetch(
      `${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: [[date, activity, weapon, amount, location, note]] }) }
    );
    await sortSheetByDateDesc();
    showToast("Passet uppdaterat!", false);
    closeEditOverlay();
    loadRecent();
  } catch (e) {
    showToast("Ett fel uppstod: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function deleteEditedRow() {
  if (!editingRow) return;
  if (!confirm("Radera det här passet permanent? Går inte att ångra.")) return;

  const btn = document.getElementById("editDeleteBtn");
  btn.disabled = true;
  try {
    await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          deleteDimension: {
            range: { sheetId: sheetGridId, dimension: "ROWS", startIndex: editingRow - 1, endIndex: editingRow }
          }
        }]
      })
    });
    showToast("Passet raderat.", false);
    closeEditOverlay();
    loadRecent();
  } catch (e) {
    showToast("Ett fel uppstod: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

// ---------- PDF-export ----------
// Tolkar "1 ask" / "2½ askar" / "½ ask" / "43 skott" tillbaka till ett tal
// OCH vilken enhet det var - de två går inte att slå ihop till samma summa.
function parseAmount(str) {
  if (!str) return { value: 0, unit: null };
  const s = str.trim();
  if (/skott$/.test(s)) {
    const n = parseInt(s, 10);
    return { value: isNaN(n) ? 0 : n, unit: "skott" };
  }
  if (s.startsWith("½")) return { value: 0.5, unit: "ask" };
  const m = s.match(/^(\d+)(½)?/);
  if (!m) return { value: 0, unit: null };
  let n = parseInt(m[1], 10);
  if (m[2]) n += 0.5;
  return { value: n, unit: "ask" };
}

function buildSummary(rows) {
  const weaponStats = {}; // vapen -> { sessions, tavling, askTotal, skottTotal }
  const otherStats = {};  // aktivitet -> antal

  rows.forEach(row => {
    const [, activity, rawWeapon, amount] = row;
    // Normalisera bort dubbla mellanslag / osynliga tecken, så att äldre
    // loggposter med lite olika skrivsätt av samma vapen slås ihop korrekt.
    const weapon = (rawWeapon || "").replace(/\s+/g, " ").trim();
    if (weapon) {
      if (!weaponStats[weapon]) weaponStats[weapon] = { sessions: 0, tavling: 0, askTotal: 0, skottTotal: 0 };
      weaponStats[weapon].sessions++;
      if (activity === "Tävling") weaponStats[weapon].tavling++;
      const parsed = parseAmount(amount);
      if (parsed.unit === "skott") weaponStats[weapon].skottTotal += parsed.value;
      else if (parsed.unit === "ask") weaponStats[weapon].askTotal += parsed.value;
    } else {
      const key = activity || "Övrigt";
      otherStats[key] = (otherStats[key] || 0) + 1;
    }
  });

  return { weaponStats, otherStats };
}

function openExportOverlay() {
  const today = todayLocalStr();
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  const yearAgo = d.toISOString().slice(0, 10);
  setDateFor("exportFromInput", "exportFromDisplay", yearAgo);
  setDateFor("exportToInput", "exportToDisplay", today);
  document.getElementById("exportOverlay").classList.remove("hidden");
}

function closeExportOverlay() {
  document.getElementById("exportOverlay").classList.add("hidden");
}

async function generatePdf() {
  const from = document.getElementById("exportFromInput").value;
  const to = document.getElementById("exportToInput").value;
  if (!from || !to) return showToast("Välj både från- och till-datum.", true);
  if (from > to) return showToast("Från-datum måste vara före till-datum.", true);

  const btn = document.getElementById("exportGenerateBtn");
  btn.disabled = true;
  showToast("Skapar PDF...", false);

  try {
    const range = encodeURIComponent(`${sheetTitle}!A2:F`);
    const data = await sheetsFetch(`${spreadsheetId}/values/${range}`);
    const rows = (data.values || [])
      .filter(r => r[0] && r[0] >= from && r[0] <= to)
      .sort((a, b) => a[0].localeCompare(b[0])); // kronologisk i PDF:en, äldst först

    if (rows.length === 0) {
      showToast("Inga pass i det valda intervallet.", true);
      return;
    }

    buildPdf(rows, from, to);
    showToast("PDF skapad!", false);
    trackEvent("pdf-exporterad");
    closeExportOverlay();
  } catch (e) {
    showToast("Ett fel uppstod: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

function buildPdf(rows, from, to) {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 18;
  let y = 20;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(20, 20, 20);
  doc.text("Skyttelogg", marginX, y);
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110, 110, 110);
  doc.text(`Period: ${formatDateDisplay(from)} \u2013 ${formatDateDisplay(to)}`, marginX, y);
  y += 5;
  doc.text(`Skapad: ${formatDateDisplay(todayLocalStr())}`, marginX, y);
  y += 9;

  // ---- Sammanställning ----
  const { weaponStats, otherStats } = buildSummary(rows);
  const weaponNames = Object.keys(weaponStats);

  if (weaponNames.length > 0 || Object.keys(otherStats).length > 0) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 20, 20);
    doc.text("Sammanställning", marginX, y);
    y += 6;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(50, 50, 50);

    const nameColWidth = 62;
    const passColX = marginX + 66;
    const passColWidth = 40;
    const totalColX = marginX + 110;
    const totalColWidth = pageWidth - marginX - totalColX;
    const summaryLineHeight = 4.2;

    weaponNames.forEach(name => {
      const s = weaponStats[name];
      const passText = s.sessions === 1 ? "1 pass" : `${s.sessions} pass`;
      const tavlingText = s.tavling > 0 ? ` (varav ${s.tavling} tävling)` : "";
      const askText = s.askTotal > 0
        ? `${fractionText(s.askTotal)} ${s.askTotal > 1 ? "askar" : "ask"}`
        : "";
      const skottText = s.skottTotal > 0 ? `${s.skottTotal} skott` : "";
      const totalText = [askText, skottText].filter(Boolean).join(" + ");

      // Samma teknik som i detaljtabellen: dela upp långa vapennamn OCH
      // långa totalsummor (t.ex. "13½ askar + 43 skott") i så många rader
      // som faktiskt behövs, och basera radhöjden på den bredaste kolumnen -
      // annars kan text krocka med nästa rad eller rinna av sidan.
      const nameLines = doc.splitTextToSize(name, nameColWidth);
      const totalLines = totalText ? doc.splitTextToSize(totalText, totalColWidth) : [];
      const rowHeight = Math.max(nameLines.length, totalLines.length, 1) * summaryLineHeight;

      if (y + rowHeight > 275) {
        doc.addPage();
        y = 20;
      }

      doc.text(nameLines, marginX, y);
      doc.text(passText + tavlingText, passColX, y);
      if (totalLines.length) doc.text(totalLines, totalColX, y);

      y += rowHeight + 1.3;
    });

    const otherKeys = Object.keys(otherStats);
    if (otherKeys.length > 0) {
      const otherLine = "Övrigt: " + otherKeys.map(k => `${k} (${otherStats[k]})`).join(", ");
      const otherLines = doc.splitTextToSize(otherLine, pageWidth - marginX * 2);
      doc.text(otherLines, marginX, y);
      y += otherLines.length * summaryLineHeight;
    }

    y += 6;
  }

  doc.setDrawColor(196, 145, 94);
  doc.setLineWidth(0.5);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 9;

  const cols = [
    { label: "Datum", x: marginX, w: 22 },
    { label: "Aktivitet", x: marginX + 24, w: 24 },
    { label: "Vapengrupp/Typ", x: marginX + 50, w: 58 },
    { label: "Antal", x: marginX + 110, w: 20 },
    { label: "Notering", x: marginX + 132, w: pageWidth - marginX - (marginX + 132) }
  ];

  function drawHeader() {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(30, 30, 30);
    cols.forEach(c => doc.text(c.label, c.x, y));
    y += 3;
    doc.setDrawColor(190, 190, 190);
    doc.setLineWidth(0.2);
    doc.line(marginX, y, pageWidth - marginX, y);
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setTextColor(50, 50, 50);
  }

  drawHeader();

  const lineHeight = 4.2; // mm per textrad vid 9pt

  rows.forEach(row => {
    const [date, activity, weapon, amount, , note] = row;
    const cells = [date || "", activity || "", weapon || "", amount || "", note || ""];

    // Dela upp varje kolumns text i så många rader som faktiskt behövs
    // för att rymmas i kolumnbredden - detta är det jsPDF INTE gör åt
    // dig automatiskt när du bara sätter maxWidth på doc.text().
    const splitCells = cells.map((text, idx) => doc.splitTextToSize(text, cols[idx].w));
    const rowLines = Math.max(...splitCells.map(lines => lines.length), 1);
    const rowHeight = rowLines * lineHeight;

    // Kolla platsen INNAN vi ritar, annars kapas raden mitt itu vid sidbrytning
    if (y + rowHeight > 275) {
      doc.addPage();
      y = 20;
      drawHeader();
    }

    splitCells.forEach((lines, idx) => doc.text(lines, cols[idx].x, y));

    const rowBottom = y + rowHeight;
    doc.setDrawColor(232, 232, 232);
    doc.setLineWidth(0.15);
    doc.line(marginX, rowBottom + 1.5, pageWidth - marginX, rowBottom + 1.5);

    y = rowBottom + 5; // radhöjd + luft till nästa rad
  });

  y += 6;
  doc.setDrawColor(196, 145, 94);
  doc.setLineWidth(0.5);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.setTextColor(20, 20, 20);
  doc.text(`Totalt antal loggade poster: ${rows.length}`, marginX, y);

  doc.save(`skyttelogg-${from}-till-${to}.pdf`);
}

// ---------- Submit ----------
async function submitLog() {
  const note = document.getElementById("noteInput").value;
  const dateVal = document.getElementById("dateInput").value;
  const logBtn = document.getElementById("logBtn");
  const locationInput = document.getElementById("locationInput");
  const location = locationInput.value.trim() || DEFAULT_LOCATION;

  let rows = [];
  let activity = "Träning";

  if (currentMode === "training" || currentMode === "competition") {
    activity = (currentMode === "competition") ? "Tävling" : "Träning";
    let customError = false;
    let shotsError = false;

    document.querySelectorAll(".weapon-chip").forEach(chip => {
      const cb = chip.querySelector(".chip-input");
      if (!cb.checked) return;
      let weapon = chip.dataset.weapon;
      const custom = chip.querySelector(".custom-name");
      if (custom) {
        weapon = custom.value.trim();
        if (!weapon) { customError = true; return; }
      }

      let amountVal;
      if (currentAmmoUnit === "ask") {
        const val = parseFloat(chip.querySelector(".amount").dataset.val);
        amountVal = amountText(val);
      } else {
        const shots = parseInt(chip.querySelector(".shots-input").value, 10);
        if (!shots || shots <= 0) { shotsError = true; return; }
        amountVal = `${shots} skott`;
      }

      rows.push([dateVal, activity, weapon, amountVal, location, note]);
    });

    if (customError) return showToast("Skriv in namnet på det valfria vapnet, eller bocka ur raden.", true);
    if (shotsError) return showToast("Ange antal skott för alla ibockade vapen.", true);
    if (rows.length === 0) return showToast("Välj minst ett vapen!", true);
  } else {
    activity = document.getElementById("activityTypeInput").value.trim();
    if (!activity) return showToast("Skriv vad aktiviteten gäller!", true);
    rows.push([dateVal, activity, "", "", location, note]);
  }

  localStorage.setItem(LOCATION_KEY, location);

  logBtn.disabled = true;
  showToast("Loggar...", false);

  try {
    await appendRows(rows);
    await sortSheetByDateDesc();
    showToast("Passet är loggat!", false);
    trackEvent("pass-loggat");
    resetForm();
    loadRecent();
  } catch (e) {
    const isOffline = !navigator.onLine || e instanceof TypeError;
    if (isOffline) {
      queueRows(rows);
      showToast("Ingen uppkoppling - sparat, synkas automatiskt.", false);
      trackEvent("pass-loggat");
      resetForm();
    } else {
      showToast("Ett fel uppstod: " + e.message, true);
    }
  } finally {
    logBtn.disabled = false;
  }
}
