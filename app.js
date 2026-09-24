// =================================================================
// Skyttelogg — app.js
// Google Identity Services (inloggning) + Sheets API (databas)
// + Google Picker (välja befintligt ark, krävs med drive.file-scopet)
// =================================================================

// Standardvapen som sätts upp första gången (i "Vapen"-fliken i arket).
// Efter det är listan helt användarens egen - hanteras via kugghjulet.
const DEFAULT_WEAPONS = [
  "Vapengrupp C (.22 LR)",
  "Vapengrupp A (9mm)",
  "Vapengrupp R (Revolver)",
  "Gevär"
];
let weaponsList = [];
let weaponsRowCount = 0; // antal rader i Vapen-fliken senast vi läste/skrev

// Fyra kurerade teman + möjlighet att välja valfri egen färg.
// Bakgrund/text/ytor rörs aldrig - bara accentfärgen (mässing som standard).
const THEMES = [
  { id: "brass",  name: "Mässing", hex: "#C4915E", dim: "#8A6740", rgb: "196, 145, 94" },
  { id: "steel",  name: "Stål",    hex: "#6B9BC3", dim: "#4A6D8C", rgb: "107, 155, 195" },
  { id: "forest", name: "Skog",    hex: "#7FA65C", dim: "#5A7A3F", rgb: "127, 166, 92" },
  { id: "wine",   name: "Vinröd",  hex: "#B25A6B", dim: "#7D3E4A", rgb: "178, 90, 107" }
];

// OBS: localStorage-nycklarna nedan heter fortfarande "msf_*" från tiden då
// appen hette MSF Skyttelogg. Byt INTE namn på dem - då tappar alla befintliga
// installationer sitt sparade ark, sitt tema och eventuella köade pass.
const THEME_KEY = "msf_theme";
const LOCAL_SHEET_KEY = "msf_spreadsheet_id";
const QUEUE_KEY = "msf_pending_queue";
const LOCATION_KEY = "skyttelogg_location";

let currentThemeId = "brass";

const DEFAULT_LOCATION = "Skjutbana";
const SPREADSHEET_FILE_NAME = "Skyttelogg";
const LOG_TAB_NAME = "Loggbok";
const WEAPONS_TAB_NAME = "Vapen";
const HEADER_ROW = ["Datum", "Aktivitet", "Vapengrupp/Typ", "Antal skott", "Plats/Förening", "Notering"];
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.0.0/jspdf.umd.min.js";
const GAPI_URL = "https://apis.google.com/js/api.js";

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
let tokenExpiresAt = 0;
let tokenClient = null;
let spreadsheetId = null;      // från config.js, sparat på enheten, valt eller nyskapat
let sheetTitle = null;         // loggflikens namn, hämtas vid anslutning
let sheetGridId = null;        // numeriskt sheetId, används för sortering/radering
let weaponsSheetGridId = null; // numeriskt sheetId för "Vapen"-fliken
let appReady = false;          // true när ett ark är anslutet och laddat
let currentMode = "training";

// ---------- Små hjälpare ----------
function isHexColor(s) {
  return typeof s === "string" && /^#[0-9a-f]{6}$/i.test(s);
}

// A1-notation med citerat fliknamn - fungerar även för flikar med
// mellanslag eller specialtecken (t.ex. äldre ark med "Blad 1").
function a1(tab, range) {
  return encodeURIComponent(`'${String(tab).replace(/'/g, "''")}'!${range}`);
}

// Text som börjar med = + - @ tolkas annars som en formel av Google Sheets
// (t.ex. noteringen "-5 i sidvind" blir #ERROR!). Ett inledande ' tvingar
// fram ren text och syns inte i cellen.
function safeText(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function sanitizeRow(row) {
  return row.map((cell, i) => (i === 0 ? cell : safeText(cell)));
}

function localIsoDate(d) {
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}
function todayLocalStr() {
  return localIsoDate(new Date());
}

// Läser datum som rådata (serienummer) istället för arkets formaterade text,
// så appen fungerar oavsett vilket språk/land arket är inställt på.
function cellToIsoDate(v) {
  if (typeof v === "number" && isFinite(v)) {
    // 25569 = antal dagar mellan 1899-12-30 (Sheets epok) och 1970-01-01
    return new Date(Math.round((Math.floor(v) - 25569) * 86400000)).toISOString().slice(0, 10);
  }
  return v === undefined || v === null ? "" : String(v).trim();
}
function normalizeRow(row) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const v = row[i];
    if (i === 0) out.push(cellToIsoDate(v));
    else out.push(v === undefined || v === null ? "" : String(v));
  }
  return out;
}
function sameRow(a, b) {
  const norm = r => normalizeRow(r || []).map(s => s.trim());
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

// Laddar ett externt skript en gång, vid behov (jsPDF, Google Picker).
const scriptPromises = {};
function loadScriptOnce(src) {
  if (!scriptPromises[src]) {
    scriptPromises[src] = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        delete scriptPromises[src];
        s.remove();
        reject(new Error("Kunde inte ladda " + src));
      };
      document.head.appendChild(s);
    });
  }
  return scriptPromises[src];
}

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

  // Utan API-nyckel kan filväljaren inte öppnas - dölj knapparna istället
  // för att visa något som bara ger fel.
  if (!CONFIG.PICKER_API_KEY) {
    document.getElementById("pickerBtn").classList.add("hidden");
    document.getElementById("setupPickerBtn").classList.add("hidden");
    const createBtn = document.getElementById("setupCreateBtn");
    createBtn.classList.remove("btn-secondary");
    createBtn.classList.add("btn-primary");
  }

  // Google-biblioteket laddas async — vänta tills det finns
  waitForGoogleLib(() => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CONFIG.CLIENT_ID,
      scope: CONFIG.SCOPES,
      callback: onTokenReceived
    });
    const btn = document.getElementById("signInBtn");
    btn.textContent = "Logga in med Google";
    btn.disabled = false;
  });
});

function waitForGoogleLib(cb, waited = 0) {
  if (window.google && google.accounts && google.accounts.oauth2) return cb();
  if (waited === 8000) {
    document.getElementById("signInBtn").textContent =
      "Väntar på Google… kontrollera uppkopplingen";
  }
  setTimeout(() => waitForGoogleLib(cb, waited + 100), 100);
}

function formatDateDisplay(isoStr) {
  const [y, m, d] = String(isoStr).split("-");
  if (!m || !d) return String(isoStr);
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

// ---------- Händelser ----------
function wireStaticEvents() {
  document.getElementById("signInBtn").addEventListener("click", () => {
    tokenClient.requestAccessToken({ prompt: "" });
  });
  document.getElementById("reauthBanner").addEventListener("click", () => {
    if (tokenClient) tokenClient.requestAccessToken({ prompt: "" });
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

  // Inställningar / vapenhantering
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

  // Bjud mig på en kaffe
  if (CONFIG.SWISH_PARTS && CONFIG.SWISH_PARTS.length > 0) {
    document.getElementById("coffeeBtn").addEventListener("click", openCoffeeOverlay);
  } else {
    document.getElementById("coffeeBtn").classList.add("hidden");
  }
  document.getElementById("coffeeCloseBtn").addEventListener("click", closeCoffeeOverlay);
  document.getElementById("swishPayBtn").addEventListener("click", openSwishApp);
  document.getElementById("copySwishBtn").addEventListener("click", copySwishNumber);
  document.getElementById("coffeeOverlay").addEventListener("click", e => {
    if (e.target.id === "coffeeOverlay") closeCoffeeOverlay();
  });

  // Peka om till befintligt ark (Inställningar → Ark)
  wireManualSheetInput("reconnectSheetInput", "reconnectSheetBtn", null);

  // Koppla ark (visas när enheten inte vet vilket ark som gäller)
  document.getElementById("setupPickerBtn").addEventListener("click", openDrivePicker);
  document.getElementById("setupCreateBtn").addEventListener("click", createNewSheetFromSetup);
  document.getElementById("setupSignOutBtn").addEventListener("click", signOut);
  wireManualSheetInput("setupSheetInput", "setupSheetBtn", closeSheetSetup);
}

function wireManualSheetInput(inputId, btnId, onSuccess) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const run = async () => {
    if (!input.value.trim()) return;
    btn.disabled = true;
    try {
      await reconnectSheet(input.value);
      input.value = "";
      if (onSuccess) onSuccess();
      showToast("Nu pekar appen på det arket!", false);
    } catch (e) {
      showToast(sheetErrorText(e), true);
    } finally {
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", run);
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); run(); }
  });
}

// ---------- Inloggning / session ----------
async function onTokenReceived(resp) {
  if (resp.error) {
    showToast("Inloggning misslyckades: " + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  hideReauthBanner();

  document.getElementById("signedOutView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("topbarActions").classList.remove("hidden");

  // Förnyad session (efter "Sessionen gick ut") - allt är redan laddat,
  // skicka bara iväg det som köats under tiden.
  if (appReady) {
    await trySyncQueue();
    loadRecent();
    return;
  }

  // Vilket ark gäller?
  // 1. config.js pekar på ett specifikt ark (fristående installation).
  // 2. Arket den här enheten använde senast.
  // 3. Inget känt - låt användaren välja befintligt ELLER skapa nytt.
  //    (Med drive.file-scopet kan appen inte söka i Driven efter ett ark,
  //    så ett automatiskt nytt ark skulle bli en tom dubblett för den som
  //    redan har historik.)
  const knownId = CONFIG.SPREADSHEET_ID || localStorage.getItem(LOCAL_SHEET_KEY);
  if (!knownId) {
    openSheetSetup();
    return;
  }

  try {
    await connectSheet(knownId);
  } catch (e) {
    if (isSheetUnreachable(e)) {
      openSheetSetup(
        "Appen kommer inte åt arket den här enheten använde senast " +
        "(vanligt efter byte av telefon eller behörighet). Välj ditt " +
        "befintliga ark för att behålla historiken — skapa bara ett nytt " +
        "om du vill börja om."
      );
    } else {
      showToast("Kunde inte läsa kalkylarket: " + e.message, true);
    }
  }
}

function isSheetUnreachable(e) {
  return e && (e.status === 404 || (e.status === 403 && /permission/i.test(e.message || "")));
}

function sheetErrorText(e) {
  if (isSheetUnreachable(e)) {
    return "Appen har inte åtkomst till det arket. Välj det via Google Drive-knappen istället.";
  }
  return "Kunde inte använda det arket: " + e.message;
}

function tokenIsValid() {
  return !!accessToken && Date.now() < tokenExpiresAt - 60000;
}

function sessionExpiredError() {
  accessToken = null;
  showReauthBanner();
  const err = new Error("Sessionen gick ut — tryck på \"Logga in igen\".");
  err.authExpired = true;
  return err;
}

function showReauthBanner() {
  document.getElementById("reauthBanner").classList.remove("hidden");
}
function hideReauthBanner() {
  document.getElementById("reauthBanner").classList.add("hidden");
}

function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  tokenExpiresAt = 0;
  appReady = false;
  spreadsheetId = null;
  recentRowsCache = {};
  hideReauthBanner();
  closeSheetSetup();
  document.querySelectorAll(".overlay").forEach(o => o.classList.add("hidden"));
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("topbarActions").classList.add("hidden");
  document.getElementById("signedOutView").classList.remove("hidden");
}

// ---------- Koppla ark ----------
// Ansluter appen till ett ark: verifierar åtkomst, ser till att Vapen-
// fliken finns, laddar vapen och senaste pass. Misslyckas verifieringen
// behåller appen det ark den hade innan.
async function connectSheet(id) {
  const previousId = spreadsheetId;
  spreadsheetId = id;
  try {
    await loadSheetMeta(); // verifierar samtidigt att ID:t är giltigt och nåbart
  } catch (e) {
    spreadsheetId = previousId;
    throw e;
  }
  await ensureWeaponsSheet();
  await loadWeapons();
  buildWeaponList();
  if (!CONFIG.SPREADSHEET_ID) localStorage.setItem(LOCAL_SHEET_KEY, spreadsheetId);
  document.getElementById("sheetLink").href =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  appReady = true;
  await trySyncQueue();
  loadRecent();
}

async function reconnectSheet(idOrUrl) {
  let id = String(idOrUrl).trim();
  const match = id.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if (match) id = match[1];
  if (!id) throw new Error("Inget ID angavs.");
  await connectSheet(id);
}

function openSheetSetup(message) {
  document.getElementById("sheetSetupMsg").textContent = message ||
    "Den här enheten vet inte vilket ark den ska använda. Har du loggat " +
    "pass förut — välj ditt befintliga ark så fortsätter historiken där. " +
    "Första gången? Skapa ett nytt.";
  document.getElementById("sheetSetupOverlay").classList.remove("hidden");
}

function closeSheetSetup() {
  document.getElementById("sheetSetupOverlay").classList.add("hidden");
}

async function createNewSheetFromSetup() {
  const btn = document.getElementById("setupCreateBtn");
  btn.disabled = true;
  try {
    const id = await createSpreadsheet();
    await connectSheet(id);
    closeSheetSetup();
    showToast("Ditt kalkylark är klart!", false);
  } catch (e) {
    showToast("Kunde inte skapa arket: " + e.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function createSpreadsheet() {
  showToast("Skapar ditt kalkylark...", false);

  // Svensk locale gör att datum, decimaler m.m. beter sig likadant för
  // alla, oavsett vilket språk Google-kontot är inställt på.
  const created = await sheetsFetch("", {
    method: "POST",
    body: JSON.stringify({
      properties: { title: SPREADSHEET_FILE_NAME, locale: "sv_SE", timeZone: "Europe/Stockholm" },
      sheets: [{ properties: { title: LOG_TAB_NAME } }]
    })
  });
  const id = created.spreadsheetId;
  const firstSheet = created.sheets && created.sheets[0] && created.sheets[0].properties;
  const gridId = firstSheet ? firstSheet.sheetId : 0;

  await sheetsFetch(
    `${id}/values/${a1(LOG_TAB_NAME, "A1:F1")}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: [HEADER_ROW] }) }
  );

  // Fetstil på rubrikraden - kosmetiskt, inget kritiskt om det misslyckas
  try {
    await sheetsFetch(`${id}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          repeatCell: {
            range: { sheetId: gridId, startRowIndex: 0, endRowIndex: 1 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: "userEnteredFormat.textFormat.bold"
          }
        }]
      })
    });
  } catch (e) { /* kosmetiskt */ }

  return id;
}

// ---------- Google Picker (filväljare) ----------
// Laddas först när någon faktiskt trycker på knappen.
let pickerReady = null;

function loadPicker() {
  if (!pickerReady) {
    pickerReady = loadScriptOnce(GAPI_URL)
      .then(() => new Promise(resolve => gapi.load("picker", resolve)))
      .catch(e => { pickerReady = null; throw e; });
  }
  return pickerReady;
}

// Projektnumret är siffrorna först i OAuth-klientens ID. Picker behöver det
// (setAppId) för att en vald fil ska räknas som "öppnad av appen" - utan det
// ger drive.file-scopet ingen åtkomst till filen man valt.
function getCloudProjectNumber() {
  const m = String(CONFIG.CLIENT_ID || "").match(/^(\d+)-/);
  return m ? m[1] : null;
}

async function openDrivePicker() {
  if (!CONFIG.PICKER_API_KEY) {
    showToast("Filväljaren är inte konfigurerad (saknar API-nyckel).", true);
    return;
  }
  if (!tokenIsValid()) {
    showReauthBanner();
    showToast("Sessionen har gått ut — logga in igen först.", true);
    return;
  }
  try {
    await loadPicker();
  } catch (e) {
    showToast("Kunde inte ladda Googles filväljare. Kontrollera uppkopplingen.", true);
    return;
  }

  const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS)
    .setMode(google.picker.DocsViewMode.LIST);

  const builder = new google.picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(accessToken)
    .setDeveloperKey(CONFIG.PICKER_API_KEY)
    .setLocale("sv")
    .setCallback(pickerCallback);

  const projectNumber = getCloudProjectNumber();
  if (projectNumber) builder.setAppId(projectNumber);

  builder.build().setVisible(true);
}

async function pickerCallback(data) {
  if (data.action !== google.picker.Action.PICKED) return;
  const fileId = data.docs[0].id;
  try {
    await reconnectSheet(fileId);
    closeSheetSetup();
    showToast("Nu pekar appen på det arket!", false);
  } catch (e) {
    showToast(sheetErrorText(e), true);
  }
}

// ---------- Sheets API ----------
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";

async function sheetsFetch(path, options = {}) {
  if (!tokenIsValid()) throw sessionExpiredError();

  const url = path ? `${SHEETS_BASE}/${path}` : SHEETS_BASE;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  if (res.status === 401) throw sessionExpiredError();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error((body.error && body.error.message) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Läser loggrader som rådata och normaliserar dem till 6 textceller med
// datum i ISO-format (ÅÅÅÅ-MM-DD), oberoende av arkets språkinställning.
async function readLogRows(range) {
  const data = await sheetsFetch(
    `${spreadsheetId}/values/${a1(sheetTitle, range)}` +
    `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
  );
  return (data.values || []).map(normalizeRow);
}

async function loadSheetMeta() {
  const data = await sheetsFetch(`${spreadsheetId}?fields=sheets.properties`);
  const all = data.sheets.map(s => s.properties);
  const logSheet =
    all.find(s => s.title === LOG_TAB_NAME) ||
    all.find(s => s.title !== WEAPONS_TAB_NAME) ||
    all[0];
  sheetTitle = logSheet.title;
  sheetGridId = logSheet.sheetId;
  const weaponsSheet = all.find(s => s.title === WEAPONS_TAB_NAME);
  weaponsSheetGridId = weaponsSheet ? weaponsSheet.sheetId : null;
}

// Skapar fliken "Vapen" om den inte redan finns, med standardvapnen.
async function ensureWeaponsSheet() {
  if (weaponsSheetGridId !== null) return;

  const result = await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ addSheet: { properties: { title: WEAPONS_TAB_NAME } } }]
    })
  });
  weaponsSheetGridId = result.replies[0].addSheet.properties.sheetId;

  await sheetsFetch(
    `${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, `A1:B${DEFAULT_WEAPONS.length}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: DEFAULT_WEAPONS.map(w => [w, ""]) }) }
  );
  weaponsRowCount = DEFAULT_WEAPONS.length;
}

async function loadWeapons() {
  try {
    const data = await sheetsFetch(`${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, "A:B")}`);
    const raw = data.values || [];
    weaponsRowCount = raw.length;
    const values = raw
      .map(r => ({ name: String(r[0] || "").trim(), favorite: r[1] === "1" }))
      .filter(w => w.name);
    weaponsList = values.length > 0
      ? values
      : DEFAULT_WEAPONS.map(name => ({ name, favorite: false }));
  } catch (e) {
    weaponsList = DEFAULT_WEAPONS.map(name => ({ name, favorite: false })); // reserv
    weaponsRowCount = 100; // okänt - töm generöst vid nästa sparning
  }
}

// Sparar hela listan i ETT anrop (istället för "rensa, sedan skriv"), så
// listan aldrig kan bli tom i arket om skrivningen misslyckas. Överskjutande
// gamla rader skrivs över med tomt. Sparningar körs i tur och ordning, så
// snabba klick (stjärna, dra, ta bort) inte kan krocka.
let weaponsSaveChain = Promise.resolve();

function saveWeapons(list) {
  const snapshot = list.map(w => [w.name, w.favorite ? "1" : ""]);
  const run = async () => {
    const total = Math.max(snapshot.length, weaponsRowCount, 1);
    const values = snapshot.concat(
      Array.from({ length: total - snapshot.length }, () => ["", ""])
    );
    await sheetsFetch(
      `${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, `A1:B${total}`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values }) }
    );
    weaponsRowCount = snapshot.length;
  };
  const p = weaponsSaveChain.then(run, run);
  weaponsSaveChain = p.catch(() => {});
  return p;
}

// ---------- Senaste pass ----------
let recentRowsCache = {}; // radnummer (1-indexerat i arket) -> normaliserad rad

async function loadRecent() {
  if (!appReady) return;
  const list = document.getElementById("recentList");
  list.innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    // Arket sorteras nyast-först vid varje loggning (se sortSheetByDateDesc),
    // så rad 2–9 är de åtta senaste.
    const rows = await readLogRows("A2:F9");
    recentRowsCache = {};
    const cards = [];
    rows.forEach((row, i) => {
      if (row.every(c => !c.trim())) return; // hoppa över tomma rader
      const rowNumber = i + 2;
      recentRowsCache[rowNumber] = row;
      cards.push(rowToCard(row, rowNumber));
    });
    if (cards.length === 0) {
      list.innerHTML = `<p class="muted small">Inga pass loggade ännu.</p>`;
      return;
    }
    list.innerHTML = cards.join("");
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
  await sheetsFetch(
    `${spreadsheetId}/values/${a1(sheetTitle, "A:F")}:append?valueInputOption=USER_ENTERED`,
    { method: "POST", body: JSON.stringify({ values: rows.map(sanitizeRow) }) }
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
// Om loggning misslyckas pga uteblivet nätverk eller utgången session sparas
// passet lokalt på enheten (bara som tillfällig buffert) och skickas
// automatiskt så fort det går igen.
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

let syncInProgress = false;

async function trySyncQueue() {
  if (!appReady || !tokenIsValid() || !spreadsheetId || syncInProgress) return;
  let queue = getQueue();
  if (queue.length === 0) return;

  syncInProgress = true;
  let syncedAny = false;
  try {
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
  } finally {
    syncInProgress = false;
  }

  if (syncedAny) {
    try { await sortSheetByDateDesc(); } catch (e) { /* kosmetiskt */ }
    showToast("Köade pass synkade!", false);
    loadRecent();
  }
}

// ---------- Vapenlista (UI) ----------
function buildWeaponList() {
  const container = document.getElementById("weaponList");
  container.innerHTML = "";

  weaponsList.forEach(w => container.appendChild(weaponChip(w.name)));

  // Fritextchip för valfritt vapen - alltid tillgängligt
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
  if (!isHexColor(hex)) return;
  applyThemeColors(hex, darkenHex(hex, 0.62), hexToRgbTriple(hex), "custom");
  localStorage.setItem(THEME_KEY, JSON.stringify({ id: "custom", hex }));
}

function getSavedTheme() {
  try { return JSON.parse(localStorage.getItem(THEME_KEY) || "null"); }
  catch (e) { return null; }
}

function loadSavedTheme() {
  const saved = getSavedTheme();
  if (!saved) return;

  if (saved.id === "custom" && isHexColor(saved.hex)) {
    applyThemeColors(saved.hex, darkenHex(saved.hex, 0.62), hexToRgbTriple(saved.hex), "custom");
  } else {
    const t = THEMES.find(t => t.id === saved.id);
    if (t) applyThemeColors(t.hex, t.dim, t.rgb, t.id);
  }
}

function renderThemeSwatches() {
  const container = document.getElementById("themeSwatches");
  const saved = getSavedTheme();
  const customHex = currentThemeId === "custom" && saved && isHexColor(saved.hex)
    ? saved.hex
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

// ---------- Bjud mig på en kaffe (Swish) ----------
function getSwishNumber() {
  return (CONFIG.SWISH_PARTS || []).join("");
}

function openCoffeeOverlay() {
  document.getElementById("swishNumberDisplay").textContent = getSwishNumber();
  document.getElementById("coffeeOverlay").classList.remove("hidden");
}

function closeCoffeeOverlay() {
  document.getElementById("coffeeOverlay").classList.add("hidden");
}

function openSwishApp() {
  const number = getSwishNumber();
  if (!number) return;
  // Internationellt format utan inledande nolla, som Swish-länkar förväntar sig.
  const intNumber = "46" + number.replace(/^0/, "");
  const payload = {
    version: 1,
    payee: { value: intNumber, editable: false },
    amount: { value: "20", editable: true },
    message: { value: "Tack för Skyttelogg!", editable: true }
  };
  const url = "swish://payment?data=" + encodeURIComponent(JSON.stringify(payload));
  // Experimentellt - fungerar det inte öppnas bara ingenting, och numret
  // för manuell Swish står redan synligt i samma panel som reserv.
  window.location.href = url;
}

async function copySwishNumber() {
  try {
    await navigator.clipboard.writeText(getSwishNumber());
    showToast("Numret kopierat!", false);
  } catch (e) {
    showToast("Kunde inte kopiera - markera numret manuellt.", true);
  }
}

// ---------- Inställningar (overlay) ----------
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
// Pointer Events (touch + mus). Endast handtaget startar en dragning.
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
  buildWeaponList();
  try {
    await saveWeapons(weaponsList);
  } catch (e) {
    showToast("Kunde inte spara vapenlistan: " + e.message, true);
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

function weaponChip(name) {
  const chip = document.createElement("label");
  chip.className = "weapon-chip";
  chip.dataset.weapon = name;
  chip.innerHTML = `
    <input type="checkbox" class="chip-input">
    <span class="chip-label">${escapeHtml(name)}</span>
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
    // Skriver man i fältet räknas raden som vald
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
  toastTimer = setTimeout(() => toast.classList.remove("visible"), isError ? 4500 : 2800);
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
  setDateFor("editDateInput", "editDateDisplay",
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : todayLocalStr());
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

// Radnumret kommer från när listan laddades. Har arket ändrats sedan dess
// (kösynk, annan enhet, sortering) kan samma nummer peka på ett annat pass -
// kontrollera därför att raden fortfarande är exakt densamma innan vi
// skriver över eller raderar den.
async function assertRowUnchanged(rowNumber) {
  const [current] = await readLogRows(`A${rowNumber}:F${rowNumber}`);
  const cached = recentRowsCache[rowNumber];
  if (!current || !cached || !sameRow(current, cached)) {
    const err = new Error("Arket har ändrats sedan listan laddades. Listan är uppdaterad — öppna passet igen.");
    err.rowChanged = true;
    throw err;
  }
}

function handleEditError(e) {
  showToast(e.rowChanged ? e.message : "Ett fel uppstod: " + e.message, true);
  if (e.rowChanged) {
    closeEditOverlay();
    loadRecent();
  }
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
    await assertRowUnchanged(editingRow);
    await sheetsFetch(
      `${spreadsheetId}/values/${a1(sheetTitle, `A${editingRow}:F${editingRow}`)}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: [sanitizeRow([date, activity, weapon, amount, location, note])] }) }
    );
  } catch (e) {
    handleEditError(e);
    btn.disabled = false;
    return;
  }

  try { await sortSheetByDateDesc(); } catch (e) { /* kosmetiskt */ }
  showToast("Passet uppdaterat!", false);
  closeEditOverlay();
  loadRecent();
  btn.disabled = false;
}

async function deleteEditedRow() {
  if (!editingRow) return;
  if (!confirm("Radera det här passet permanent? Går inte att ångra.")) return;

  const btn = document.getElementById("editDeleteBtn");
  btn.disabled = true;
  try {
    await assertRowUnchanged(editingRow);
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
    handleEditError(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------- PDF-export ----------
// Tolkar "1 ask" / "2½ askar" / "½ ask" / "43 skott" tillbaka till ett tal
// OCH vilken enhet det var - de två går inte att slå ihop till samma summa.
function parseAmount(str) {
  if (!str) return { value: 0, unit: null };
  const s = String(str).trim();
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
    // Normalisera bort dubbla mellanslag, så att olika skrivsätt slås ihop.
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
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  setDateFor("exportFromInput", "exportFromDisplay", localIsoDate(d));
  setDateFor("exportToInput", "exportToDisplay", todayLocalStr());
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
    // jsPDF laddas först här, så appens start inte tyngs av den.
    try {
      await loadScriptOnce(JSPDF_URL);
    } catch (e) {
      throw new Error("Kunde inte ladda PDF-verktyget. Kontrollera uppkopplingen.");
    }

    const rows = (await readLogRows("A2:F"))
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

    const splitCells = cells.map((text, idx) => doc.splitTextToSize(text, cols[idx].w));
    const rowLines = Math.max(...splitCells.map(lines => lines.length), 1);
    const rowHeight = rowLines * lineHeight;

    // Kolla platsen INNAN vi ritar, annars kapas raden vid sidbrytning
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

    y = rowBottom + 5;
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
  if (!appReady) return showToast("Koppla ett kalkylark först.", true);

  const note = document.getElementById("noteInput").value;
  const dateVal = document.getElementById("dateInput").value;
  const logBtn = document.getElementById("logBtn");
  const locationInput = document.getElementById("locationInput");
  const location = locationInput.value.trim() || DEFAULT_LOCATION;

  const rows = [];
  let activity;

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

  // Själva skrivningen. Bara om DEN misslyckas köas passet - annars kunde
  // ett lyckat pass hamna i kön och dubbleras vid nästa synk.
  try {
    await appendRows(rows);
  } catch (e) {
    const isOffline = !navigator.onLine || e instanceof TypeError;
    if (isOffline || e.authExpired) {
      queueRows(rows);
      showToast(isOffline
        ? "Ingen uppkoppling - sparat, synkas automatiskt."
        : "Sessionen gick ut - passet är sparat och synkas när du loggat in igen.", false);
      trackEvent("pass-loggat");
      resetForm();
    } else {
      showToast("Ett fel uppstod: " + e.message, true);
    }
    logBtn.disabled = false;
    return;
  }

  try { await sortSheetByDateDesc(); } catch (e) { /* kosmetiskt - passet är sparat */ }
  showToast("Passet är loggat!", false);
  trackEvent("pass-loggat");
  resetForm();
  loadRecent();
  logBtn.disabled = false;
}
