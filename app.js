// =================================================================
// Skyttelogg — app.js
// Google Identity Services (inloggning) + Sheets API (databas)
// + Google Picker (välja befintligt ark, krävs med drive.file-scopet)
// =================================================================

// ---------- Version och kanal ----------
// ÅÅ.M.N: år, månad och löpnummer inom månaden. Räknas upp vid varje
// leverans, även rättningar. Samma nummer i alpha och beta: uppflyttning
// till den publicerade appen görs utan att ändra någon fil.
const APP_VERSION = "26.9.7";
// Den publicerade appen märks som beta så länge den utvecklas. Sätts till
// false när appen anses färdig.
const PUBLIC_BETA = true;
// alpha = testkanalen i mappen alpha/, beta = den publicerade appen.
const APP_CHANNEL = /\/alpha\//.test(location.pathname) ? "alpha" : (PUBLIC_BETA ? "beta" : "");

// Så som versionen visas, t.ex. "26.9.2 · beta".
const VERSION_LABEL = APP_VERSION + (APP_CHANNEL ? " · " + APP_CHANNEL : "");

function renderVersion() {
  if (APP_CHANNEL) {
    document.querySelectorAll("#channelTag, .start-tag").forEach(tag => {
      tag.textContent = APP_CHANNEL.toUpperCase();
      tag.classList.add("channel-tag--" + APP_CHANNEL);
      tag.classList.remove("hidden");
    });
  }
  document.getElementById("appVersion").textContent = VERSION_LABEL;
}

async function copyVersion() {
  try {
    await navigator.clipboard.writeText(VERSION_LABEL);
    showToast("Version kopierad: " + VERSION_LABEL, false);
  } catch (e) {
    showToast("Version: " + VERSION_LABEL, false);
  }
}

// Länkar direkt till rätt formulär på GitHub med versionen ifylld. Fältets
// id i mallen ("version") används som parameter i adressen.
function issueFormUrl(template) {
  const base = String(CONFIG.ISSUES_URL || "").replace(/\/new(\/choose)?\/?$/, "");
  return `${base}/new?template=${encodeURIComponent(template)}&version=${encodeURIComponent(VERSION_LABEL)}`;
}

// Standardvapen när fliken "Vapen" skapas. Därefter hanteras listan under
// Meny → Vapen.
const DEFAULT_WEAPONS = [
  "Vapengrupp C (.22 LR)",
  "Vapengrupp A (9mm)",
  "Vapengrupp R (Revolver)",
  "Gevär"
];
let weaponsList = [];
let weaponsRowCount = 0; // antal rader i Vapen-fliken senast vi läste/skrev

// Förinställda accentfärger, plus valfri egen färg. Temat påverkar bara
// accenten, aldrig bakgrund, ytor eller text. Mörk text på accentfärgen ska
// klara kontrastkravet 4,5:1.
const THEMES = [
  { id: "brass",  name: "Mässing", hex: "#C4915E", dim: "#8A6740", rgb: "196, 145, 94" },
  { id: "steel",  name: "Stål",    hex: "#6B9BC3", dim: "#4A6D8C", rgb: "107, 155, 195" },
  { id: "forest", name: "Skog",    hex: "#7FA65C", dim: "#5A7A3F", rgb: "127, 166, 92" },
  { id: "wine",   name: "Vinröd",  hex: "#C46E7F", dim: "#7A4550", rgb: "196, 110, 127" }
];

// Prefixet msf_ är kvar från appens tidigare namn. Nycklarna får inte döpas
// om: befintliga installationer skulle då tappa sitt ark, tema och sin kö.
const THEME_KEY = "msf_theme";
const LOCAL_SHEET_KEY = "msf_spreadsheet_id";
const QUEUE_KEY = "msf_pending_queue";
const LOCATION_KEY = "skyttelogg_location";
const SESSION_KEY = "skyttelogg_session";  // sparad inloggning, högst en timme
const KNOWN_KEY = "skyttelogg_known";      // inloggad förut på enheten, ej utloggad
const NEWS_SEEN_KEY = "skyttelogg_news_seen"; // senaste version vars nyheter visats
const UNIT_PREF_KEY = "skyttelogg_units";      // senast använd enhet per vapennamn

let currentThemeId = "brass";

const DEFAULT_LOCATION = "Skjutbana";
const SPREADSHEET_FILE_NAME = "Skyttelogg";
const LOG_TAB_NAME = "Loggbok";
const WEAPONS_TAB_NAME = "Vapen";
const STATS_TAB_NAME = "Statistik";
const DEFAULT_BOX_SIZE = 50;     // skott per ask när inget annat angetts
const MAX_BOX_SIZE = 1000;
const HEADER_ROW = ["Datum", "Aktivitet", "Vapengrupp/Typ", "Antal skott", "Plats/Förening", "Notering"];
const JSPDF_URL = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.0.0/jspdf.umd.min.js";
const GAPI_URL = "https://apis.google.com/js/api.js";

const MONTH_NAMES = ["januari", "februari", "mars", "april", "maj", "juni", "juli",
  "augusti", "september", "oktober", "november", "december"];
const WEEKDAY_NAMES = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];

// ---------- Anonym händelseräkning (GoatCounter) ----------
// Skickar bara händelsens namn, aldrig persondata. Är skriptet blockerat
// eller inte laddat görs ingenting.
function trackEvent(name) {
  try {
    if (window.goatcounter && window.goatcounter.count) {
      window.goatcounter.count({ path: name, event: true });
    }
  } catch (e) { /* ignoreras */ }
}

let accessToken = null;
let tokenExpiresAt = 0;
let tokenClient = null;
let spreadsheetId = null;      // från config.js, sparat på enheten, valt eller nyskapat
let spreadsheetTitle = "";     // arkets filnamn, visas under Meny → Ark
let sheetTitle = null;         // loggflikens namn, hämtas vid anslutning
let sheetGridId = null;        // numeriskt sheetId, används för sortering/radering
let weaponsSheetGridId = null; // numeriskt sheetId för "Vapen"-fliken
let appReady = false;          // true när ett ark är anslutet och laddat
let connecting = false;        // true medan connectSheet provar ett (nytt) ark
let sheetProblem = null;       // null, "unreachable" (403/404) eller "trashed"
let statsSheetGridId = null;   // numeriskt sheetId för "Statistik", null = saknas
let protectedKeys = new Set(); // beskrivningar på befintliga skydd i arket
let currentMode = "training";
let currentView = "log";

// ---------- Hjälpfunktioner ----------
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

// Träning / Tävling / allt annat (även fritext efter redigering).
function activityType(activity) {
  const a = String(activity || "").trim();
  if (a === "Träning") return "training";
  if (a === "Tävling") return "competition";
  return "other";
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

// ---------- Start ----------
window.addEventListener("load", () => {
  renderVersion();
  loadSavedTheme();
  setLogDate("today");
  wireDatePicker("editDateInput", "editDateDisplay");
  wireDatePicker("exportFromInput", "exportFromDisplay");
  wireDatePicker("exportToInput", "exportToDisplay");
  wireStaticEvents();
  updateQueueBadge();
  document.getElementById("locationInput").value =
    localStorage.getItem(LOCATION_KEY) || DEFAULT_LOCATION;
  window.addEventListener("online", trySyncQueue);

  if (CONFIG.ISSUES_URL) {
    const bug = document.getElementById("menuBugLink");
    const idea = document.getElementById("menuIdeaLink");
    bug.href = issueFormUrl("bug_report.yml");
    idea.href = issueFormUrl("feature_request.yml");
    bug.classList.remove("hidden");
    idea.classList.remove("hidden");
  }
  document.getElementById("appVersion").addEventListener("click", copyVersion);

  // Utan API-nyckel finns ingen filväljare: dölj dess knappar och visa den
  // manuella vägen direkt.
  if (!CONFIG.PICKER_API_KEY) {
    document.getElementById("sheetPickerBtn").classList.add("hidden");
    document.getElementById("setupPickerBtn").classList.add("hidden");
    document.getElementById("sheetManualDetails").open = true;
    document.getElementById("setupManualDetails").open = true;
    const createBtn = document.getElementById("setupCreateBtn");
    createBtn.classList.remove("btn-secondary");
    createBtn.classList.add("btn-primary");
  }

  // Sparad inloggning som fortfarande gäller: splash och rakt in. Annars
  // startsidan, med "Fortsätt" för den som loggat in här förut.
  const session = loadSession();
  if (session) {
    showSplash();
    onTokenReceived({
      access_token: session.token,
      expires_in: Math.floor((session.expiresAt - Date.now()) / 1000),
      restored: true
    });
  } else {
    showStartScreen();
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

// ---------- Sparad inloggning ----------
// Googles åtkomsttoken gäller ungefär en timme och ger bara åtkomst till
// appens eget ark (drive.file). Den sparas på enheten under den tiden så att
// appen kan öppnas igen utan ny inloggning; därefter krävs ett tryck, eftersom
// Google bara lämnar ut en ny token efter en handling från användaren.
function saveSession() {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token: accessToken, expiresAt: tokenExpiresAt }));
    localStorage.setItem(KNOWN_KEY, "1");
  } catch (e) { /* ignoreras */ }
}

function loadSession() {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
    if (s && s.token && Number(s.expiresAt) - Date.now() > 120000) return s;
  } catch (e) { /* ignoreras */ }
  clearSession();
  return null;
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignoreras */ }
}

function showStartScreen() {
  const known = localStorage.getItem(KNOWN_KEY) === "1";
  document.getElementById("signInBtn").textContent = known ? "Fortsätt" : "Logga in med Google";
  document.getElementById("startIntro").classList.toggle("hidden", known);
  document.getElementById("startHint").classList.toggle("hidden", !known);
  document.getElementById("startPrivacy").classList.toggle("hidden", known);
  document.getElementById("appView").classList.add("hidden");
  document.getElementById("bottomNav").classList.add("hidden");
  document.getElementById("signedOutView").classList.remove("hidden");
}

// Splashen visas minst 2 s så att animationen (ca 1,5 s) hinner klart,
// men aldrig längre än laddningen när den tar längre tid. Tryck hoppar över.
const SPLASH_MIN_MS = 2000;
let splashMinUntil = 0;
let splashHidePending = false;

function showSplash() {
  const splash = document.getElementById("splash");
  splash.classList.remove("hidden", "fading");
  splashMinUntil = Date.now() + SPLASH_MIN_MS;
  splashHidePending = false;
  splash.addEventListener("click", skipSplash, { once: true });
}

function skipSplash() {
  splashMinUntil = 0;
  if (splashHidePending) hideSplash();
}

function hideSplash() {
  const splash = document.getElementById("splash");
  if (splash.classList.contains("hidden")) return;
  const wait = splashMinUntil - Date.now();
  if (wait > 0) {
    if (!splashHidePending) {
      splashHidePending = true;
      setTimeout(() => { if (splashHidePending) hideSplash(); }, wait);
    }
    return;
  }
  splashHidePending = false;
  splash.classList.add("fading");
  setTimeout(() => splash.classList.add("hidden"), 260);
}

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

// Stänger ett overlay när man trycker på den mörka bakgrunden.
function wireBackdropClose(overlayId, closeFn) {
  document.getElementById(overlayId).addEventListener("click", e => {
    if (e.target.id === overlayId) closeFn();
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
  document.getElementById("logBtn").addEventListener("click", submitLog);
  document.getElementById("refreshBtn").addEventListener("click", loadRecent);
  document.querySelectorAll(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => setMode(btn.dataset.mode));
  });
  document.getElementById("activityTypeInput").addEventListener("input", updateLogButton);

  // Datumchips
  document.getElementById("dateTodayBtn").addEventListener("click", () => setLogDate("today"));
  document.getElementById("dateYesterdayBtn").addEventListener("click", () => setLogDate("yesterday"));
  document.getElementById("datePickBtn").addEventListener("click", () => {
    const input = document.getElementById("dateInput");
    if (input.showPicker) input.showPicker();
    else { input.focus(); input.click(); }
  });
  document.getElementById("dateInput").addEventListener("change", e => {
    if (e.target.value) setLogDate("custom", e.target.value);
  });

  // Bottenmeny
  document.querySelectorAll(".nav-btn").forEach(btn => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  // Kalender
  document.getElementById("calPrevBtn").addEventListener("click", () => shiftCalendarMonth(-1));
  document.getElementById("calNextBtn").addEventListener("click", () => shiftCalendarMonth(1));

  // Redigeringsoverlay
  document.getElementById("editCancelBtn").addEventListener("click", closeEditOverlay);
  document.getElementById("editSaveBtn").addEventListener("click", saveEditedRow);
  document.getElementById("editDeleteBtn").addEventListener("click", deleteEditedRow);
  wireBackdropClose("editOverlay", closeEditOverlay);

  // Statistik → PDF-export
  document.getElementById("statsExportBtn").addEventListener("click", openExportOverlay);
  document.getElementById("exportCancelBtn").addEventListener("click", closeExportOverlay);
  document.getElementById("exportGenerateBtn").addEventListener("click", generatePdf);
  document.getElementById("exportShareBtn").addEventListener("click", sharePdf);
  document.getElementById("exportSaveBtn").addEventListener("click", savePdf);
  document.getElementById("exportDoneCloseBtn").addEventListener("click", closeExportOverlay);
  wireBackdropClose("exportOverlay", closeExportOverlay);

  // Meny → Vapen
  document.getElementById("menuWeaponsBtn").addEventListener("click", openWeaponsOverlay);
  document.getElementById("weaponsCloseBtn").addEventListener("click", closeWeaponsOverlay);
  document.getElementById("addWeaponBtn").addEventListener("click", addWeapon);
  document.getElementById("newWeaponInput").addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); addWeapon(); }
  });
  wireBackdropClose("weaponsOverlay", closeWeaponsOverlay);

  // Meny → Tema
  document.getElementById("menuThemeBtn").addEventListener("click", openThemeOverlay);
  document.getElementById("themeCloseBtn").addEventListener("click", closeThemeOverlay);
  wireBackdropClose("themeOverlay", closeThemeOverlay);

  // Meny → Ark
  document.getElementById("menuSheetBtn").addEventListener("click", openSheetOverlay);
  document.getElementById("sheetCloseBtn").addEventListener("click", closeSheetOverlay);
  document.getElementById("sheetPickerBtn").addEventListener("click", openDrivePicker);
  wireBackdropClose("sheetOverlay", closeSheetOverlay);
  wireManualSheetInput("reconnectSheetInput", "reconnectSheetBtn", closeSheetOverlay);

  // Meny → Om appen
  if (CONFIG.SWISH_PARTS && CONFIG.SWISH_PARTS.length > 0) {
    document.getElementById("menuCoffeeBtn").addEventListener("click", openCoffeeOverlay);
  } else {
    document.getElementById("menuCoffeeBtn").classList.add("hidden");
  }
  document.getElementById("coffeeCloseBtn").addEventListener("click", closeCoffeeOverlay);
  document.getElementById("swishPayBtn").addEventListener("click", openSwishApp);
  document.getElementById("copySwishBtn").addEventListener("click", copySwishNumber);
  wireBackdropClose("coffeeOverlay", closeCoffeeOverlay);

  // Meny → Nyheter
  document.getElementById("menuNewsBtn").addEventListener("click", openNewsOverlay);
  document.getElementById("newsCloseBtn").addEventListener("click", closeNewsOverlay);
  wireBackdropClose("newsOverlay", closeNewsOverlay);

  // Meny → Logga ut (med bekräftelse)
  document.getElementById("menuSignOutBtn").addEventListener("click", confirmSignOut);

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

// ---------- Vyer ----------
function setView(view) {
  currentView = view;
  document.getElementById("viewLog").classList.toggle("hidden", view !== "log");
  document.getElementById("viewCalendar").classList.toggle("hidden", view !== "calendar");
  document.getElementById("viewStats").classList.toggle("hidden", view !== "stats");
  document.getElementById("viewMenu").classList.toggle("hidden", view !== "menu");
  document.querySelectorAll(".nav-btn").forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle("active", active);
    if (active) btn.setAttribute("aria-current", "page");
    else btn.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
  if (view === "calendar") loadCalendar();
  if (view === "stats") loadStats();
  if (view === "menu") { updateMenuMeta(); updateNewsBadge(); }
}

// Efter loggning, redigering, radering eller kösynk.
function refreshData() {
  allRows = null; // läses om när kalendern eller statistiken visas
  loadRecent();
  if (currentView === "calendar") loadCalendar();
  if (currentView === "stats") loadStats();
}

// ---------- Inloggning / session ----------
async function onTokenReceived(resp) {
  if (resp.error) {
    showToast("Inloggning misslyckades: " + resp.error, true);
    return;
  }
  accessToken = resp.access_token;
  tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 3600) * 1000;
  if (!resp.restored) saveSession();
  hideReauthBanner();

  document.getElementById("signedOutView").classList.add("hidden");
  document.getElementById("appView").classList.remove("hidden");
  document.getElementById("bottomNav").classList.remove("hidden");

  // Förnyad session: allt är redan laddat, synka bara kön.
  if (appReady) {
    hideSplash();
    await trySyncQueue();
    refreshData();
    return;
  }

  // Vilket ark gäller?
  // 1. Ett fast ark i config.js (fristående installation).
  // 2. Arket enheten använde senast.
  // 3. Okänt: användaren väljer befintligt ark eller skapar ett nytt.
  //    drive.file tillåter inte sökning i Drive, så ett automatiskt nytt ark
  //    skulle bli en tom dubblett för den som redan har historik.
  const knownId = CONFIG.SPREADSHEET_ID || localStorage.getItem(LOCAL_SHEET_KEY);
  if (!knownId) {
    hideSplash();
    openSheetSetup();
    return;
  }

  try {
    await connectSheet(knownId);
    hideSplash();
  } catch (e) {
    hideSplash();
    if (e.authExpired) {
      // Den sparade inloggningen godtogs inte längre: tillbaka till startsidan.
      clearSession();
      hideReauthBanner();
      showStartScreen();
    } else if (isSheetUnreachable(e)) {
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
  clearSession();
  showReauthBanner();
  const err = new Error("Sessionen gick ut. Tryck på bannern överst för att logga in igen.");
  err.authExpired = true;
  return err;
}

function showReauthBanner() {
  document.getElementById("reauthBanner").classList.remove("hidden");
}
function hideReauthBanner() {
  document.getElementById("reauthBanner").classList.add("hidden");
}

function confirmSignOut() {
  const n = getQueue().length;
  let msg = "Logga ut?";
  if (n > 0) {
    msg += `\n\n${n === 1 ? "1 pass väntar" : n + " pass väntar"} på synk. ` +
      "De sparas och skickas när du loggar in igen.";
  }
  if (confirm(msg)) signOut();
}

function signOut() {
  if (accessToken && window.google && google.accounts && google.accounts.oauth2) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  clearSession();
  try { localStorage.removeItem(KNOWN_KEY); } catch (e) { /* ignoreras */ }
  accessToken = null;
  tokenExpiresAt = 0;
  appReady = false;
  spreadsheetId = null;
  spreadsheetTitle = "";
  rowCache = {};
  allRows = null;
  lastStatsJson = null;
  setSheetProblem(null);
  hideReauthBanner();
  closeSheetSetup();
  document.querySelectorAll(".overlay").forEach(o => o.classList.add("hidden"));
  setView("log");
  hideSplash();
  showStartScreen();
}

// ---------- Ark-problem (indikator) ----------
// "unreachable": arket svarar 403/404 under en session, t.ex. raderat eller
// åtkomst återkallad. "trashed": arket ligger i papperskorgen i Drive och
// raderas automatiskt efter 30 dagar. Släcks när ett ark kopplats utan fel.
const SHEET_PROBLEM_TEXT = {
  unreachable: {
    menu: "Appen kommer inte åt arket — tryck för att koppla om",
    box: "Appen kommer inte åt arket just nu. Välj ditt ark igen via Google Drive nedan."
  },
  trashed: {
    menu: "Arket ligger i papperskorgen — tryck för mer info",
    box: "Arket ligger i papperskorgen i Google Drive och raderas automatiskt efter 30 dagar. " +
      "Återställ det i Google Drive (Papperskorg → Återställ) så försvinner varningen nästa gång du öppnar appen."
  }
};

function setSheetProblem(kind) {
  sheetProblem = kind || null;
  const on = !!sheetProblem;
  document.getElementById("menuAlertDot").classList.toggle("hidden", !on);
  const box = document.getElementById("sheetProblemBox");
  box.classList.toggle("hidden", !on);
  if (on) box.textContent = SHEET_PROBLEM_TEXT[sheetProblem].box;
  document.getElementById("menuSheetBtn").classList.toggle("has-problem", on);
  updateMenuMeta();
}

// Kontrollerar via Drive API om arket ligger i papperskorgen. Sheets API
// svarar normalt även för slängda ark, så det syns inte annars. Fel här
// (t.ex. Drive API ej aktiverat) ignoreras - appen fungerar som vanligt.
async function checkTrashed() {
  const id = spreadsheetId;
  if (!id || !tokenIsValid()) return;
  try {
    const res = await fetch(`${DRIVE_BASE}/files/${encodeURIComponent(id)}?fields=trashed`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return;
    const data = await res.json();
    if (id === spreadsheetId && data.trashed === true) setSheetProblem("trashed");
  } catch (e) { /* ignoreras */ }
}

// ---------- Koppla ark ----------
// Ansluter appen till ett ark: verifierar åtkomst, ser till att Vapen-
// fliken finns, laddar vapen och senaste pass. Misslyckas verifieringen
// behåller appen det ark den hade innan.
async function connectSheet(id) {
  const previousId = spreadsheetId;
  spreadsheetId = id;
  connecting = true;
  try {
    await loadSheetMeta(); // verifierar samtidigt att ID:t är giltigt och nåbart
  } catch (e) {
    spreadsheetId = previousId;
    throw e;
  } finally {
    connecting = false;
  }
  await ensureWeaponsSheet();
  try { await ensureProtections(); } catch (e) { /* ej kritiskt */ }
  await loadWeapons();
  buildWeaponList();
  if (!CONFIG.SPREADSHEET_ID) localStorage.setItem(LOCAL_SHEET_KEY, spreadsheetId);
  document.getElementById("menuSheetLink").href =
    `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  appReady = true;
  rowCache = {};
  allRows = null;
  lastStatsJson = null;
  setSheetProblem(null);
  checkTrashed();
  await trySyncQueue();
  refreshData();
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

  // Fetstil på rubrikraden. Ett fel här stoppar inte skapandet.
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
  } catch (e) { /* ej kritiskt */ }

  return id;
}

// ---------- Google Picker (filväljare) ----------
// Laddas först vid behov.
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
    closeSheetOverlay();
    showToast("Nu pekar appen på det arket!", false);
  } catch (e) {
    showToast(sheetErrorText(e), true);
  }
}

// ---------- Sheets API ----------
const SHEETS_BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

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
    // Det kopplade arket svarar inte längre: tänd indikatorn. Gäller inte
    // när ett nytt ark provas, där hanteras felet av anroparen.
    if (appReady && !connecting && spreadsheetId && path.startsWith(spreadsheetId) &&
        isSheetUnreachable(err)) {
      setSheetProblem("unreachable");
    }
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
  const data = await sheetsFetch(
    `${spreadsheetId}?fields=properties.title,sheets(properties,protectedRanges(description))`
  );
  spreadsheetTitle = (data.properties && data.properties.title) || "";
  const all = data.sheets.map(s => s.properties);
  const logSheet =
    all.find(s => s.title === LOG_TAB_NAME) ||
    all.find(s => s.title !== WEAPONS_TAB_NAME && s.title !== STATS_TAB_NAME) ||
    all[0];
  sheetTitle = logSheet.title;
  sheetGridId = logSheet.sheetId;
  const weaponsSheet = all.find(s => s.title === WEAPONS_TAB_NAME);
  weaponsSheetGridId = weaponsSheet ? weaponsSheet.sheetId : null;
  const statsSheet = all.find(s => s.title === STATS_TAB_NAME);
  statsSheetGridId = statsSheet ? statsSheet.sheetId : null;
  protectedKeys = new Set();
  data.sheets.forEach(s => (s.protectedRanges || []).forEach(p => {
    if (p.description) protectedKeys.add(p.description);
  }));
}

// ---------- Skydd i arket ----------
// Varningsskydd: alla kan fortfarande redigera, men Google Sheets ber om
// bekräftelse. Appens egna skrivningar via API påverkas inte. Läggs till en
// gång per ark, känns igen på beskrivningen.
const PROTECTION = {
  header: "Skyttelogg: kolumnrubriker",
  weapons: "Skyttelogg: vapenlista",
  stats: "Skyttelogg: statistik"
};

const WEAPONS_HELP = [
  ["Hanteras av Skyttelogg"],
  ["Ändra vapen i appen: Meny → Vapen."],
  ["A: vapnets namn"],
  ["B: 1 = favorit"],
  ["C: skott per ask"],
  ["D: 1 = dold i loggningen"]
];

function protectRequest(description, range) {
  return { addProtectedRange: { protectedRange: { description, range, warningOnly: true } } };
}

async function ensureProtections() {
  const requests = [];
  let weaponsAdded = false;
  if (!protectedKeys.has(PROTECTION.header) && sheetGridId !== null) {
    requests.push(protectRequest(PROTECTION.header, { sheetId: sheetGridId, startRowIndex: 0, endRowIndex: 1 }));
  }
  if (!protectedKeys.has(PROTECTION.weapons) && weaponsSheetGridId !== null) {
    requests.push(protectRequest(PROTECTION.weapons, { sheetId: weaponsSheetGridId }));
    weaponsAdded = true;
  }
  if (!protectedKeys.has(PROTECTION.stats) && statsSheetGridId !== null) {
    requests.push(protectRequest(PROTECTION.stats, { sheetId: statsSheetGridId }));
  }
  if (requests.length === 0) return;

  await sheetsFetch(`${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({ requests })
  });
  requests.forEach(r => protectedKeys.add(r.addProtectedRange.protectedRange.description));

  // Förklaring bredvid vapenlistan. Kolumn F läses och skrivs aldrig annars.
  if (weaponsAdded) {
    await sheetsFetch(
      `${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, `F1:F${WEAPONS_HELP.length}`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values: WEAPONS_HELP }) }
    );
  }
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
    `${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, `A1:D${DEFAULT_WEAPONS.length}`)}?valueInputOption=RAW`,
    { method: "PUT", body: JSON.stringify({ values: DEFAULT_WEAPONS.map(w => [w, "", DEFAULT_BOX_SIZE, ""]) }) }
  );
  weaponsRowCount = DEFAULT_WEAPONS.length;
}

async function loadWeapons() {
  try {
    const data = await sheetsFetch(`${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, "A:D")}`);
    const raw = data.values || [];
    weaponsRowCount = raw.length;
    const values = raw
      .map(r => ({
        name: String(r[0] || "").trim(),
        favorite: r[1] === "1",
        box: parseBoxSize(r[2]),
        hidden: r[3] === "1"
      }))
      .filter(w => w.name);
    weaponsList = values.length > 0
      ? values
      : DEFAULT_WEAPONS.map(name => ({ name, favorite: false, box: DEFAULT_BOX_SIZE, hidden: false }));
  } catch (e) {
    weaponsList = DEFAULT_WEAPONS.map(name => ({ name, favorite: false, box: DEFAULT_BOX_SIZE, hidden: false }));
    weaponsRowCount = 100; // okänt antal: töm med marginal vid nästa sparning
  }
}

// Skott per ask: heltal 1–1000, annars standardvärdet.
function parseBoxSize(v) {
  const n = parseInt(v, 10);
  return n >= 1 && n <= MAX_BOX_SIZE ? n : DEFAULT_BOX_SIZE;
}

// Sparar hela listan i ett anrop i stället för att först rensa, så att
// listan aldrig blir tom i arket om skrivningen misslyckas. Överskjutande
// rader töms. Sparningar köas, så att snabba ändringar inte krockar.
let weaponsSaveChain = Promise.resolve();

function saveWeapons(list) {
  const snapshot = list.map(w => [w.name, w.favorite ? "1" : "", w.box || DEFAULT_BOX_SIZE, w.hidden ? "1" : ""]);
  const run = async () => {
    const total = Math.max(snapshot.length, weaponsRowCount, 1);
    const values = snapshot.concat(
      Array.from({ length: total - snapshot.length }, () => ["", "", "", ""])
    );
    await sheetsFetch(
      `${spreadsheetId}/values/${a1(WEAPONS_TAB_NAME, `A1:D${total}`)}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values }) }
    );
    weaponsRowCount = snapshot.length;
  };
  const p = weaponsSaveChain.then(run, run);
  weaponsSaveChain = p.catch(() => {});
  return p;
}

// ---------- Radcache (för redigering) ----------
// radnummer (1-indexerat i arket) -> normaliserad rad, så som den såg ut när
// den senast lästes. Fylls av både Senaste och Kalendern. assertRowUnchanged
// jämför mot arket innan något skrivs, så en inaktuell post är ofarlig.
let rowCache = {};

// ---------- Senaste pass ----------
async function loadRecent() {
  if (!appReady) return;
  const list = document.getElementById("recentList");
  list.innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    // Arket sorteras nyast-först vid varje loggning (se sortSheetByDateDesc),
    // så rad 2–9 är de åtta senaste.
    const rows = await readLogRows("A2:F9");
    const cards = [];
    rows.forEach((row, i) => {
      if (row.every(c => !c.trim())) return;
      const rowNumber = i + 2;
      rowCache[rowNumber] = row;
      cards.push(rowToCard(row, rowNumber));
    });
    if (cards.length === 0) {
      list.innerHTML = `<p class="muted small">Inga pass loggade ännu.</p>`;
      return;
    }
    list.innerHTML = cards.join("");
    wireCardClicks(list);
  } catch (e) {
    list.innerHTML = `<p class="muted small">Kunde inte hämta: ${escapeHtml(e.message)}</p>`;
  }
}

function wireCardClicks(container) {
  container.querySelectorAll(".recent-item").forEach(el => {
    el.addEventListener("click", () => openEditOverlay(parseInt(el.dataset.row, 10)));
  });
}

function rowToCard(row, rowNumber) {
  const [date, activity, weapon, amount, , note] = row;
  const line2 = [weapon, amount].filter(Boolean).join(" · ");
  return `
    <button type="button" class="recent-item" data-row="${rowNumber}">
      <span class="recent-date mono">${escapeHtml(date || "")}</span>
      <span class="recent-body">
        <span class="recent-activity" style="display:block">${escapeHtml(activity || "")}</span>
        ${line2 ? `<span class="recent-detail muted" style="display:block">${escapeHtml(line2)}</span>` : ""}
        ${note ? `<span class="recent-note muted" style="display:block">${escapeHtml(note)}</span>` : ""}
      </span>
    </button>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

// ---------- Hela loggboken (kalender, statistik) ----------
let allRows = null;         // [{ row, rowNumber }], null = inte läst än
let allRowsLoading = null;  // pågående läsning, så att flera anrop delar samma

async function ensureAllRows() {
  if (allRows) return allRows;
  if (!allRowsLoading) {
    allRowsLoading = (async () => {
      try {
        const rows = await readLogRows("A2:F");
        const parsed = [];
        rows.forEach((row, i) => {
          if (!row[0] || row.every(c => !c.trim())) return;
          const rowNumber = i + 2;
          rowCache[rowNumber] = row;
          parsed.push({ row, rowNumber });
        });
        allRows = parsed;
        return parsed;
      } finally {
        allRowsLoading = null;
      }
    })();
  }
  return allRowsLoading;
}

// ---------- Kalender ----------
let calMonth = null;         // Date, första dagen i visad månad
let calSelected = null;      // ISO-datum för vald dag

function ensureCalendarState() {
  if (!calSelected) calSelected = todayLocalStr();
  if (!calMonth) {
    const [y, m] = calSelected.split("-").map(Number);
    calMonth = new Date(y, m - 1, 1);
  }
}

async function loadCalendar() {
  if (!appReady) return;
  ensureCalendarState();
  renderCalendar(); // rita direkt (tomt eller med tidigare data)
  if (allRows) return;

  document.getElementById("calDayList").innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    await ensureAllRows();
  } catch (e) {
    document.getElementById("calDayList").innerHTML =
      `<p class="muted small">Kunde inte hämta: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (currentView === "calendar") renderCalendar();
}

function shiftCalendarMonth(delta) {
  ensureCalendarState();
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + delta, 1);
  renderCalendar();
}

function selectCalendarDay(iso) {
  calSelected = iso;
  const [y, m] = iso.split("-").map(Number);
  if (y !== calMonth.getFullYear() || m - 1 !== calMonth.getMonth()) {
    calMonth = new Date(y, m - 1, 1);
  }
  renderCalendar();
}

function renderCalendar() {
  const year = calMonth.getFullYear();
  const month = calMonth.getMonth();
  const today = todayLocalStr();
  document.getElementById("calMonthLabel").textContent =
    MONTH_NAMES[month].charAt(0).toUpperCase() + MONTH_NAMES[month].slice(1) + " " + year;

  // Typer per datum (unika, i ordningen träning, tävling, annat)
  const typesByDate = {};
  (allRows || []).forEach(({ row }) => {
    const d = row[0];
    if (!typesByDate[d]) typesByDate[d] = new Set();
    typesByDate[d].add(activityType(row[1]));
  });
  const ORDER = ["training", "competition", "other"];
  const LABEL = { training: "träning", competition: "tävling", other: "annat" };

  // Rutnät: måndag först, 6 veckor om det behövs
  const first = new Date(year, month, 1);
  const offset = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - offset);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells = Math.ceil((offset + daysInMonth) / 7) * 7;

  let html = "";
  for (let i = 0; i < cells; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const iso = localIsoDate(d);
    const types = typesByDate[iso] ? ORDER.filter(t => typesByDate[iso].has(t)) : [];
    const cls = ["cal-day"];
    if (d.getMonth() !== month) cls.push("cal-day--outside");
    if (iso === calSelected) cls.push("cal-day--selected");
    if (iso === today) cls.push("cal-day--today");
    const label = `${d.getDate()} ${MONTH_NAMES[d.getMonth()]}` +
      (types.length ? ", " + types.map(t => LABEL[t]).join(" och ") : "");
    html += `
      <button type="button" class="${cls.join(" ")}" data-date="${iso}" aria-label="${label}"${iso === calSelected ? ' aria-pressed="true"' : ""}>
        <span class="cal-num">${d.getDate()}</span>
        <span class="cal-dots">${types.map(t => `<span class="dot dot--${t}"></span>`).join("")}</span>
      </button>`;
  }
  const grid = document.getElementById("calGrid");
  grid.innerHTML = html;
  grid.querySelectorAll(".cal-day").forEach(btn => {
    btn.addEventListener("click", () => selectCalendarDay(btn.dataset.date));
  });

  // Summering: antal dagar per typ i visad månad
  const prefix = `${year}-${String(month + 1).padStart(2, "0")}-`;
  const counts = { training: 0, competition: 0, other: 0 };
  Object.keys(typesByDate).forEach(iso => {
    if (!iso.startsWith(prefix)) return;
    typesByDate[iso].forEach(t => { counts[t]++; });
  });
  const loaded = allRows !== null;
  document.getElementById("calSummaryLabel").textContent = `Dagar i ${MONTH_NAMES[month]}`;
  document.getElementById("calCountTraining").textContent = loaded ? counts.training : "–";
  document.getElementById("calCountCompetition").textContent = loaded ? counts.competition : "–";
  document.getElementById("calCountOther").textContent = loaded ? counts.other : "–";

  const [sy, sm, sd] = calSelected.split("-").map(Number);
  const selDate = new Date(sy, sm - 1, sd);
  const wd = WEEKDAY_NAMES[selDate.getDay()];
  document.getElementById("calDayTitle").textContent =
    `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${sd} ${MONTH_NAMES[sm - 1]}`;

  if (!loaded) return; // "Laddar..." eller felmeddelande står kvar
  const list = document.getElementById("calDayList");
  const dayRows = allRows.filter(r => r.row[0] === calSelected);
  if (dayRows.length === 0) {
    list.innerHTML = `<p class="muted small">Inga pass den här dagen.</p>`;
    return;
  }
  list.innerHTML = dayRows.map(r => rowToCard(r.row, r.rowNumber)).join("");
  wireCardClicks(list);
}

// ---------- Statistik ----------
// Beräknas ur hela loggboken. Pass i askar räknas om med vapnets askstorlek
// och markeras som uppskattning (≈). Samma siffror skrivs till fliken
// Statistik i arket, som värden och inte formler: formlers syntax beror på
// arkets språkinställning.
let lastStatsJson = null;   // senast skrivna innehåll, så att oförändrat inte skrivs om
let statsWriting = false;

function daysSince(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const then = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((today - then) / 86400000);
}

function relativeDays(n) {
  if (n <= 0) return "idag";
  if (n === 1) return "igår";
  if (n < 14) return `${n} dagar sedan`;
  if (n < 60) return `${Math.round(n / 7)} veckor sedan`;
  if (n < 730) return `${Math.round(n / 30.44)} mån sedan`;
  return `${Math.floor(n / 365.25)} år sedan`;
}

function formatCount(n, approx) {
  const s = Math.round(n).toLocaleString("sv-SE");
  return approx ? "≈ " + s : s;
}

function boxSizeFor(key) {
  const w = weaponsList.find(w => normalizeWeaponName(w.name) === key);
  return w ? (w.box || DEFAULT_BOX_SIZE) : DEFAULT_BOX_SIZE;
}

function shotsFor(amount, box) {
  const p = parseAmount(amount);
  if (p.unit === "skott") return { shots: p.value, approx: false };
  if (p.unit === "ask") return { shots: p.value * box, approx: true };
  return { shots: 0, approx: false };
}

function computeStats(rows) {
  const cut = new Date();
  cut.setFullYear(cut.getFullYear() - 1);
  const cutoff = localIsoDate(cut);

  const weapons = {};
  const sessions = new Set();
  const comps = new Set();
  const months = {};
  let since = null;
  let totalShots = 0;
  let totalApprox = false;

  rows.forEach(({ row }) => {
    const [date, activity, rawWeapon, amount] = row;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const type = activityType(activity);
    if (!since || date < since) since = date;
    sessions.add(date + "|" + type);
    if (type === "competition") comps.add(date);

    const mk = date.slice(0, 7);
    if (!months[mk]) {
      months[mk] = { training: new Set(), competition: new Set(), other: new Set(), shots: 0 };
    }
    months[mk][type].add(date);

    // Annat-aktiviteter utan mängd (t.ex. äldre rader med fritext i
    // vapenkolumnen) räknas inte som vapen.
    const key = normalizeWeaponName(rawWeapon);
    if (!key || (type === "other" && parseAmount(amount).unit === null)) return;
    const { shots, approx } = shotsFor(amount, boxSizeFor(key));
    totalShots += shots;
    if (approx) totalApprox = true;
    months[mk].shots += shots;

    if (!weapons[key]) {
      weapons[key] = { name: key, pass: 0, pass12: 0, shots: 0, shots12: 0,
        approx: false, approx12: false, last: date, first: date };
    }
    const w = weapons[key];
    w.pass++;
    w.shots += shots;
    if (approx) w.approx = true;
    if (date > cutoff) {
      w.pass12++;
      w.shots12 += shots;
      if (approx) w.approx12 = true;
    }
    if (date > w.last) w.last = date;
    if (date < w.first) w.first = date;
  });

  return {
    since,
    passCount: sessions.size,
    compCount: comps.size,
    totalShots,
    totalApprox,
    weapons: Object.values(weapons).sort((a, b) =>
      b.last.localeCompare(a.last) || a.name.localeCompare(b.name, "sv")),
    months: Object.keys(months).sort().reverse().map(k => ({
      month: k,
      training: months[k].training.size,
      competition: months[k].competition.size,
      other: months[k].other.size,
      shots: months[k].shots
    }))
  };
}

async function loadStats() {
  if (!appReady) return;
  const list = document.getElementById("statsWeaponList");
  if (!allRows) list.innerHTML = `<p class="muted small">Laddar...</p>`;
  let rows;
  try {
    rows = await ensureAllRows();
  } catch (e) {
    list.innerHTML = `<p class="muted small">Kunde inte hämta: ${escapeHtml(e.message)}</p>`;
    return;
  }
  if (currentView !== "stats") return;
  const stats = computeStats(rows);
  renderStats(stats);
  writeStatsSheet(stats);
}

function renderStats(stats) {
  document.getElementById("statsSince").textContent = stats.since ? `Sedan ${stats.since}` : "";
  document.getElementById("statsPass").textContent = formatCount(stats.passCount, false);
  document.getElementById("statsShots").textContent = formatCount(stats.totalShots, stats.totalApprox);
  document.getElementById("statsComps").textContent = formatCount(stats.compCount, false);

  const list = document.getElementById("statsWeaponList");
  if (stats.weapons.length === 0) {
    list.innerHTML = `<p class="muted small">Inga pass med vapen loggade ännu.</p>`;
    return;
  }
  list.innerHTML = stats.weapons.map(w => {
    const days = daysSince(w.last);
    return `
      <div class="stat-card">
        <div class="stat-head">
          <span class="stat-name">${escapeHtml(w.name)}</span>
          <span class="stat-last${days <= 30 ? " stat-last--recent" : ""}">${relativeDays(days)}</span>
        </div>
        <div class="stat-grid">
          <div class="stat-cell"><span>Pass</span><span class="mono">${formatCount(w.pass, false)}</span></div>
          <div class="stat-cell"><span>12 mån</span><span class="mono">${formatCount(w.pass12, false)}</span></div>
          <div class="stat-cell"><span>Skott</span><span class="mono">${formatCount(w.shots, w.approx)}</span></div>
          <div class="stat-cell"><span>12 mån</span><span class="mono">${formatCount(w.shots12, w.approx12)}</span></div>
        </div>
      </div>`;
  }).join("");
}

// Fliken Statistik ägs av appen och skrivs om helt. Fel här påverkar inte
// statistiken i appen och visas därför inte.
async function writeStatsSheet(stats) {
  const table = [
    ["Vapen", "Pass", "Pass 12 mån", "Skott", "Skott 12 mån", "Senast"],
    ...stats.weapons.map(w => [w.name, w.pass, w.pass12, Math.round(w.shots), Math.round(w.shots12), w.last]),
    [],
    ["Månad", "Träning (dagar)", "Tävling (dagar)", "Annat (dagar)", "Skott"],
    ...stats.months.map(m => [m.month, m.training, m.competition, m.other, Math.round(m.shots)]),
    [],
    ["Skott från pass i askar är beräknade med askstorleken i fliken Vapen."]
  ];
  const json = JSON.stringify(table);
  if (json === lastStatsJson || statsWriting) return;

  const now = new Date();
  const stamp = `${todayLocalStr()} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const values = [
    ["Statistik"],
    [`Skapas och skrivs om av Skyttelogg varje gång statistiken öppnas i appen. Ändra inget här – bygg egna beräkningar i en annan flik. Senast uppdaterad ${stamp}.`],
    [],
    ...table
  ];

  const id = spreadsheetId;
  statsWriting = true;
  try {
    if (statsSheetGridId === null) {
      try {
        const result = await sheetsFetch(`${id}:batchUpdate`, {
          method: "POST",
          body: JSON.stringify({ requests: [{ addSheet: { properties: { title: STATS_TAB_NAME } } }] })
        });
        statsSheetGridId = result.replies[0].addSheet.properties.sheetId;
      } catch (e) {
        if (!/already exists|finns redan/i.test(e.message || "")) throw e;
        await loadSheetMeta(); // skapad från en annan enhet under tiden
      }
    }
    try { await ensureProtections(); } catch (e) { /* ej kritiskt */ }
    await sheetsFetch(`${id}/values/${a1(STATS_TAB_NAME, "A:Z")}:clear`, { method: "POST", body: "{}" });
    await sheetsFetch(
      `${id}/values/${a1(STATS_TAB_NAME, "A1")}?valueInputOption=RAW`,
      { method: "PUT", body: JSON.stringify({ values }) }
    );
    if (id === spreadsheetId) lastStatsJson = json;
  } catch (e) {
    /* ignoreras */
  } finally {
    statsWriting = false;
  }
}

// ---------- Skriva ----------
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
  const row = document.getElementById("queueRow");
  const n = getQueue().length;
  if (n === 0) {
    row.classList.add("hidden");
    return;
  }
  row.textContent = n === 1
    ? "1 pass väntar på synk"
    : `${n} pass väntar på synk`;
  row.classList.remove("hidden");
}

function queueRows(rows) {
  const queue = getQueue();
  queue.push({ id: Date.now() + "-" + Math.random().toString(36).slice(2), rows });
  setQueue(queue);
}

let syncInProgress = false;
let queueRetryTimer = null;

// Vid 429 (för många anrop) görs ett nytt försök efter en minut, när
// Googles kvot har fyllts på.
function scheduleQueueRetry() {
  if (queueRetryTimer) return;
  queueRetryTimer = setTimeout(() => {
    queueRetryTimer = null;
    trySyncQueue();
  }, 60000);
}

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
        if (e.status === 429) scheduleQueueRetry();
        break; // fortfarande offline (eller annat fel) - försök igen nästa gång
      }
    }
  } finally {
    syncInProgress = false;
  }

  if (syncedAny) {
    try { await sortSheetByDateDesc(); } catch (e) { /* ej kritiskt */ }
    showToast("Köade pass synkade!", false);
    refreshData();
  }
}

// ---------- Datum för nytt pass ----------
// Idag · Igår · Välj datum. Ett eget datum som råkar vara idag eller igår
// markerar motsvarande chip.
function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const s = `${d}/${m}`;
  return y === new Date().getFullYear() ? s : `${s} ${y}`;
}

function setLogDate(kind, iso) {
  const today = todayLocalStr();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterday = localIsoDate(y);
  if (kind === "today") iso = today;
  if (kind === "yesterday") iso = yesterday;
  if (iso === today) kind = "today";
  else if (iso === yesterday) kind = "yesterday";

  document.getElementById("dateInput").value = iso;
  document.getElementById("dateTodayBtn").innerHTML = `Idag <span class="mono">${shortDate(today)}</span>`;
  const pick = document.getElementById("datePickBtn");
  pick.innerHTML = kind === "custom" ? `<span class="mono">${shortDate(iso)}</span>` : "Välj datum";
  document.getElementById("dateTodayBtn").classList.toggle("active", kind === "today");
  document.getElementById("dateYesterdayBtn").classList.toggle("active", kind === "yesterday");
  pick.classList.toggle("active", kind === "custom");
}

// ---------- Vapenkort ----------
// Varje valt vapen har egen enhet: askar (stegare, ½-steg) eller skott
// (sifferfält). Förval vid val: senast använda enhet för vapnet, härledd ur
// redan inlästa loggrader, annars sparad lokalt, annars askar. Radformatet i
// arket är oförändrat ("2 askar", "½ ask", "20 skott").
const UNIT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>';

function chipControlsHtml() {
  return `
    <div class="chip-controls">
      <div class="chip-amount">
        <span class="chip-stepper">
          <button type="button" class="step-btn" data-delta="-0.5" aria-label="Minska">−</button>
          <span class="amount mono" data-val="1">1</span>
          <button type="button" class="step-btn" data-delta="0.5" aria-label="Öka">+</button>
        </span>
        <input type="number" class="shots-input mono" inputmode="numeric" min="1" placeholder="Antal" aria-label="Antal skott">
        <button type="button" class="unit-pill" aria-label="Byt enhet"><span class="unit-text">askar</span>${UNIT_ICON}</button>
      </div>
      <div class="chip-approx mono"></div>
    </div>`;
}

function buildWeaponList() {
  const container = document.getElementById("weaponList");
  container.innerHTML = "";
  weaponsList.filter(w => !w.hidden).forEach(w => container.appendChild(weaponChip(w.name)));

  // Annat vapen: hopfällt tills man trycker
  const open = document.createElement("button");
  open.type = "button";
  open.className = "custom-open";
  open.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>Annat vapen';
  container.appendChild(open);

  const chip = document.createElement("div");
  chip.className = "weapon-chip weapon-chip--custom hidden";
  chip.dataset.weapon = "";
  chip.innerHTML = `
    <div class="custom-head">
      <input type="text" class="input custom-name" placeholder="Vapnets namn" aria-label="Annat vapen">
      <button type="button" class="custom-close" aria-label="Stäng annat vapen">×</button>
    </div>` + chipControlsHtml();
  container.appendChild(chip);
  wireCustomChip(open, chip);
  updateLogButton();
}

function weaponChip(name) {
  const chip = document.createElement("div");
  chip.className = "weapon-chip";
  chip.dataset.weapon = name;
  chip.innerHTML = `
    <button type="button" class="chip-toggle" aria-pressed="false">
      <span class="chip-label">${escapeHtml(name)}</span>
    </button>` + chipControlsHtml();
  chip.querySelector(".chip-toggle").addEventListener("click", () => {
    setChipSelected(chip, !chip.classList.contains("selected"));
  });
  wireChipControls(chip);
  return chip;
}

function wireCustomChip(open, chip) {
  const name = chip.querySelector(".custom-name");
  open.addEventListener("click", () => {
    open.classList.add("hidden");
    chip.classList.remove("hidden");
    chip.classList.add("selected"); // kontrollerna syns; räknas som valt först med namn
    setChipUnit(chip, preferredUnit(""));
    name.focus();
    updateLogButton();
  });
  name.addEventListener("input", updateLogButton);
  chip.querySelector(".custom-close").addEventListener("click", () => {
    collapseCustomChip(chip, open);
    updateLogButton();
  });
  wireChipControls(chip);
}

function collapseCustomChip(chip, open) {
  chip.querySelector(".custom-name").value = "";
  resetChipAmount(chip);
  chip.classList.remove("selected");
  chip.classList.add("hidden");
  (open || document.querySelector(".custom-open")).classList.remove("hidden");
}

function wireChipControls(chip) {
  const amountEl = chip.querySelector(".amount");
  chip.querySelectorAll(".step-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      let val = parseFloat(amountEl.dataset.val);
      val = Math.min(10, Math.max(0.5, val + parseFloat(btn.dataset.delta)));
      amountEl.dataset.val = val;
      amountEl.textContent = fractionText(val);
      updateApprox(chip);
    });
  });
  chip.querySelector(".unit-pill").addEventListener("click", () => {
    setChipUnit(chip, chip.dataset.qtyUnit === "skott" ? "ask" : "skott");
    if (chip.dataset.qtyUnit === "skott") chip.querySelector(".shots-input").focus();
  });
}

function setChipSelected(chip, on) {
  chip.classList.toggle("selected", on);
  chip.querySelector(".chip-toggle").setAttribute("aria-pressed", on ? "true" : "false");
  if (on) setChipUnit(chip, preferredUnit(chip.dataset.weapon));
  else resetChipAmount(chip);
  updateLogButton();
}

// Byter enhet och återställer mängden (1 ask / tomt skottfält).
function setChipUnit(chip, unit) {
  chip.dataset.qtyUnit = unit;
  chip.querySelector(".unit-text").textContent = unit === "skott" ? "skott" : "askar";
  resetChipAmount(chip);
}

function resetChipAmount(chip) {
  const amountEl = chip.querySelector(".amount");
  amountEl.dataset.val = 1;
  amountEl.textContent = "1";
  chip.querySelector(".shots-input").value = "";
  updateApprox(chip);
}

// "≈ N skott" under stegaren, bara för vapen med askstorlek i listan.
function updateApprox(chip) {
  const el = chip.querySelector(".chip-approx");
  const key = normalizeWeaponName(chip.dataset.weapon);
  const w = key && weaponsList.find(x => normalizeWeaponName(x.name) === key);
  if (!w) { el.textContent = ""; return; }
  const val = parseFloat(chip.querySelector(".amount").dataset.val);
  el.textContent = `≈ ${formatCount(val * (w.box || DEFAULT_BOX_SIZE), false)} skott`;
}

function loadUnitPrefs() {
  try { return JSON.parse(localStorage.getItem(UNIT_PREF_KEY) || "{}") || {}; }
  catch (e) { return {}; }
}

function saveUnitPrefs(rows) {
  const prefs = loadUnitPrefs();
  rows.forEach(r => {
    const key = normalizeWeaponName(r[2]);
    const unit = parseAmount(r[3]).unit;
    if (key && unit) prefs[key] = unit;
  });
  try { localStorage.setItem(UNIT_PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* ignoreras */ }
}

// Senast använda enhet: inlästa loggrader (nyast först) → lokalt sparad → askar.
function preferredUnit(name) {
  const key = normalizeWeaponName(name);
  if (!key) return "ask";
  const fromRows = list => {
    for (const row of list) {
      if (normalizeWeaponName(row[2]) !== key) continue;
      const unit = parseAmount(row[3]).unit;
      if (unit) return unit;
    }
    return null;
  };
  let unit = null;
  if (allRows) unit = fromRows(allRows.map(r => r.row));
  if (!unit) {
    const cached = Object.keys(rowCache).map(Number).sort((a, b) => a - b).map(n => rowCache[n]);
    unit = fromRows(cached);
  }
  return unit || loadUnitPrefs()[key] || "ask";
}

// ---------- Logga-knappen ----------
let logInProgress = false;

function selectedWeaponChips() {
  return Array.from(document.querySelectorAll("#weaponList .weapon-chip.selected")).filter(chip =>
    !chip.classList.contains("weapon-chip--custom") ||
    chip.querySelector(".custom-name").value.trim().length > 0);
}

function updateLogButton() {
  const btn = document.getElementById("logBtn");
  if (currentMode === "training" || currentMode === "competition") {
    const n = selectedWeaponChips().length;
    btn.textContent = n ? `Logga pass · ${n} vapen` : "Välj vapen för att logga";
    btn.disabled = logInProgress || n === 0;
  } else {
    btn.textContent = "Logga pass";
    btn.disabled = logInProgress || !document.getElementById("activityTypeInput").value.trim();
  }
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
    // Förinställda teman läses från THEMES, så ändrade färgvärden slår
    // igenom även för tidigare sparade val.
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

function openThemeOverlay() {
  renderThemeSwatches();
  document.getElementById("themeOverlay").classList.remove("hidden");
}
function closeThemeOverlay() {
  document.getElementById("themeOverlay").classList.add("hidden");
}

// ---------- Nyheter ----------
// Innehållet hämtas från CHANGELOG.md bredvid appen, så att changeloggen på
// GitHub och i appen alltid är samma text. Stöder det som filen använder:
// ## rubriker, - punkter (med indragna fortsättningsrader) och **fetstil**.
// Varje rubrik blir ett hopfällbart avsnitt; bara ett är öppet åt gången,
// från början det senaste.
let newsLoaded = false;

function renderChangelog(md) {
  const inline = s => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  let html = "";
  let inList = false;
  let item = null;
  const flushItem = () => { if (item !== null) { html += `<li>${inline(item)}</li>`; item = null; } };
  const closeList = () => { flushItem(); if (inList) { html += "</ul>"; inList = false; } };

  let sections = 0;
  const closeSection = () => { closeList(); if (sections) html += "</div></div></div>"; };

  md.split(/\r?\n/).forEach(line => {
    if (/^## /.test(line)) {
      closeSection();
      const open = sections === 0;
      sections++;
      html += `<div class="news-item${open ? " open" : ""}">` +
        `<button type="button" class="news-head" aria-expanded="${open}">` +
        `<span>${inline(line.slice(3).trim())}</span><span class="news-chev" aria-hidden="true">›</span></button>` +
        `<div class="news-body"><div class="news-inner">`;
    } else if (/^- /.test(line)) {
      flushItem();
      if (!inList) { html += "<ul>"; inList = true; }
      item = line.slice(2).trim();
    } else if (item !== null && /^\s+\S/.test(line)) {
      item += " " + line.trim();
    } else if (!line.trim() || /^(#|---)/.test(line)) {
      flushItem();
    }
  });
  closeSection();
  return html;
}

function wireNewsAccordion(box) {
  box.querySelectorAll(".news-head").forEach(head => {
    head.addEventListener("click", () => {
      const item = head.parentElement;
      const opening = !item.classList.contains("open");
      box.querySelectorAll(".news-item.open").forEach(other => {
        other.classList.remove("open");
        other.querySelector(".news-head").setAttribute("aria-expanded", "false");
      });
      if (opening) {
        item.classList.add("open");
        head.setAttribute("aria-expanded", "true");
        setTimeout(() => head.scrollIntoView({ block: "nearest", behavior: "smooth" }), 280);
      }
    });
  });
}

async function openNewsOverlay() {
  document.getElementById("newsOverlay").classList.remove("hidden");
  localStorage.setItem(NEWS_SEEN_KEY, APP_VERSION);
  updateNewsBadge();
  if (newsLoaded) return;
  const box = document.getElementById("newsContent");
  try {
    const res = await fetch("CHANGELOG.md");
    if (!res.ok) throw new Error("HTTP " + res.status);
    box.innerHTML = renderChangelog(await res.text());
    wireNewsAccordion(box);
    newsLoaded = true;
  } catch (e) {
    box.innerHTML = `<p class="muted small">Kunde inte hämta nyheterna. Kontrollera uppkopplingen.</p>`;
  }
}

function closeNewsOverlay() {
  document.getElementById("newsOverlay").classList.add("hidden");
}

function updateNewsBadge() {
  const seen = localStorage.getItem(NEWS_SEEN_KEY);
  document.getElementById("menuNewsBadge").classList.toggle("hidden", seen === APP_VERSION);
}

// ---------- Meny ----------
function updateMenuMeta() {
  const n = weaponsList.length;
  const hiddenCount = weaponsList.filter(w => w.hidden).length;
  document.getElementById("menuWeaponsCount").textContent =
    n ? `${n} st` + (hiddenCount ? ` · ${hiddenCount} dolda` : "") : "";
  document.getElementById("menuSheetSub").textContent = sheetProblem
    ? SHEET_PROBLEM_TEXT[sheetProblem].menu
    : (spreadsheetTitle ? `Kopplad: ${spreadsheetTitle}` : "");
}

// ---------- Meny → Ark ----------
// Alla nya ark heter "Skyttelogg". De sista tecknen i ID:t gör det möjligt
// att jämföra med adressraden i Google Sheets.
function openSheetOverlay() {
  const shortId = spreadsheetId ? ` · …${spreadsheetId.slice(-4)}` : "";
  document.getElementById("currentSheetName").textContent =
    spreadsheetTitle ? spreadsheetTitle + shortId : "–";
  document.getElementById("sheetOverlay").classList.remove("hidden");
}
function closeSheetOverlay() {
  document.getElementById("sheetOverlay").classList.add("hidden");
  document.getElementById("reconnectSheetInput").value = "";
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
  // Öppnas inte Swish-appen finns numret för manuell betalning i samma panel.
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

// ---------- Meny → Vapen ----------
function openWeaponsOverlay() {
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
    <div class="weapon-manage-row${w.favorite ? " favorite" : ""}${w.hidden ? " is-hidden" : ""}" data-index="${i}">
      <span class="weapon-drag-handle" aria-label="Dra för att ändra ordning">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="4" y1="8" x2="20" y2="8"></line>
          <line x1="4" y1="16" x2="20" y2="16"></line>
        </svg>
      </span>
      <button type="button" class="weapon-star-btn" data-index="${i}" aria-label="${w.favorite ? "Ta bort favorit" : "Gör till favorit"}">${w.favorite ? "★" : "☆"}</button>
      <span class="weapon-manage-name">${escapeHtml(w.name)}</span>
      <label class="weapon-box">
        <input type="number" class="weapon-box-input mono" data-index="${i}" inputmode="numeric" min="1" max="${MAX_BOX_SIZE}" value="${w.box || DEFAULT_BOX_SIZE}" aria-label="Skott per ask för ${escapeHtml(w.name)}">
        <span class="weapon-box-unit">/ask</span>
      </label>
      <button type="button" class="weapon-hide-btn" data-index="${i}" aria-pressed="${w.hidden ? "true" : "false"}" aria-label="${w.hidden ? "Visa i loggningen" : "Dölj i loggningen"}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${w.hidden ? EYE_OFF_ICON : EYE_ICON}</svg>
      </button>
      <button type="button" class="weapon-remove-btn" data-index="${i}" aria-label="Ta bort">×</button>
    </div>`).join("");

  container.querySelectorAll(".weapon-hide-btn").forEach(btn => {
    btn.addEventListener("click", () => toggleHidden(parseInt(btn.dataset.index, 10)));
  });

  container.querySelectorAll(".weapon-box-input").forEach(input => {
    input.addEventListener("change", () => setBoxSize(parseInt(input.dataset.index, 10), input.value));
  });

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

const EYE_ICON = '<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>';
const EYE_OFF_ICON = '<path d="M17.94 17.94A10.1 10.1 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.06-5.94"></path><path d="M9.9 5.24A9.1 9.1 0 0 1 12 5c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"></path><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"></path><line x1="2" y1="2" x2="22" y2="22"></line>';

// Dolda vapen visas inte i loggningen men finns kvar i listan och i
// statistiken.
function toggleHidden(index) {
  const w = weaponsList[index];
  if (!w) return;
  w.hidden = !w.hidden;
  persistAndRefreshWeapons();
}

function toggleFavorite(index) {
  const item = weaponsList[index];
  item.favorite = !item.favorite;
  if (item.favorite) {
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
  updateMenuMeta();
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
  weaponsList.push({ name, favorite: false, box: DEFAULT_BOX_SIZE, hidden: false });
  input.value = "";
  await persistAndRefreshWeapons();
}

function setBoxSize(index, value) {
  const w = weaponsList[index];
  if (!w) return;
  const n = parseInt(value, 10);
  if (!(n >= 1 && n <= MAX_BOX_SIZE)) {
    showToast(`Skott per ask ska vara ett heltal mellan 1 och ${MAX_BOX_SIZE}.`, true);
    renderWeaponsManageList();
    return;
  }
  if (n === w.box) return;
  w.box = n;
  persistAndRefreshWeapons();
}

function normalizeWeaponName(s) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

// Har vapnet loggade pass informeras användaren om att historiken ligger
// kvar under det gamla namnet. Loggboken skrivs aldrig om.
async function removeWeapon(index) {
  const w = weaponsList[index];
  if (!w) return;
  let count = 0;
  try {
    const rows = await ensureAllRows();
    const key = normalizeWeaponName(w.name);
    count = rows.filter(r => normalizeWeaponName(r.row[2]) === key).length;
  } catch (e) { /* utan uppkoppling: ta bort utan räkning */ }

  if (count > 0) {
    const passText = count === 1 ? "1 pass är loggat" : `${count} pass är loggade`;
    const ok = confirm(
      `Ta bort "${w.name}"?\n\n${passText} med det här namnet. De ligger kvar i arket ` +
      "och visas i statistiken under det gamla namnet.\n\n" +
      "Byter du bara namn: lägg till det nya namnet först. Äldre pass räknas då på det gamla namnet."
    );
    if (!ok) return;
  }
  const i = weaponsList.indexOf(w);
  if (i < 0) return;
  weaponsList.splice(i, 1);
  await persistAndRefreshWeapons();
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
  updateLogButton();
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

// ---------- Återställ formulär ----------
function resetForm() {
  document.getElementById("noteInput").value = "";
  document.getElementById("activityTypeInput").value = "";
  setLogDate("today");
  document.querySelectorAll("#weaponList .weapon-chip").forEach(chip => {
    if (chip.classList.contains("weapon-chip--custom")) collapseCustomChip(chip);
    else if (chip.classList.contains("selected")) setChipSelected(chip, false);
  });
  setMode("training");
}

// ---------- Redigera / radera loggat pass ----------
let editingRow = null;

function openEditOverlay(rowNumber) {
  const row = rowCache[rowNumber];
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
  const cached = rowCache[rowNumber];
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
    allRows = null;
    refreshData();
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

  try { await sortSheetByDateDesc(); } catch (e) { /* ej kritiskt */ }
  showToast("Passet uppdaterat!", false);
  closeEditOverlay();
  allRows = null;
  rowCache = {};
  refreshData();
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
    allRows = null;
    rowCache = {};
    refreshData();
  } catch (e) {
    handleEditError(e);
  } finally {
    btn.disabled = false;
  }
}

// ---------- PDF-export ----------
// Tolkar "1 ask", "2½ askar", "½ ask" och "43 skott" till värde och enhet.
// Askar och skott summeras var för sig.
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

// Senast skapade PDF, för Dela/Spara. Delning kräver ett färskt tryck från
// användaren, därför skapas filen först och delas i ett andra steg.
let lastPdf = null; // { doc, blob, name }

function openExportOverlay() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  setDateFor("exportFromInput", "exportFromDisplay", localIsoDate(d));
  setDateFor("exportToInput", "exportToDisplay", todayLocalStr());
  lastPdf = null;
  document.getElementById("exportForm").classList.remove("hidden");
  document.getElementById("exportDone").classList.add("hidden");
  document.getElementById("exportOverlay").classList.remove("hidden");
}

function closeExportOverlay() {
  document.getElementById("exportOverlay").classList.add("hidden");
  lastPdf = null;
}

function pdfFile() {
  return new File([lastPdf.blob], lastPdf.name, { type: "application/pdf" });
}

function canSharePdf() {
  try {
    return !!(lastPdf && navigator.canShare && navigator.share && navigator.canShare({ files: [pdfFile()] }));
  } catch (e) {
    return false;
  }
}

function showExportDone(from, to) {
  document.getElementById("exportDonePeriod").textContent =
    `${formatDateDisplay(from)} – ${formatDateDisplay(to)}`;
  document.getElementById("exportFileName").textContent = lastPdf.name;
  document.getElementById("exportShareBtn").classList.toggle("hidden", !canSharePdf());
  document.getElementById("exportShareHint").classList.toggle("hidden", canSharePdf());
  document.getElementById("exportForm").classList.add("hidden");
  document.getElementById("exportDone").classList.remove("hidden");
}

async function sharePdf() {
  if (!lastPdf) return;
  try {
    await navigator.share({ files: [pdfFile()], title: "Skyttelogg" });
    trackEvent("pdf-delad");
  } catch (e) {
    if (e && e.name === "AbortError") return; // användaren stängde delningen
    showToast("Kunde inte dela filen – använd Spara istället.", true);
  }
}

function savePdf() {
  if (!lastPdf) return;
  lastPdf.doc.save(lastPdf.name);
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

    const doc = buildPdf(rows, from, to);
    lastPdf = { doc, blob: doc.output("blob"), name: `skyttelogg-${from}-till-${to}.pdf` };
    trackEvent("pdf-exporterad");
    showExportDone(from, to);
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

    // Sidbryt före raden om den inte får plats, så att den inte delas.
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

  return doc;
}

// ---------- Logga pass ----------
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

    document.querySelectorAll("#weaponList .weapon-chip.selected").forEach(chip => {
      let weapon = chip.dataset.weapon;
      const custom = chip.querySelector(".custom-name");
      if (custom) {
        weapon = custom.value.trim();
        if (!weapon) return; // utfällt men tomt räknas inte som valt
      }

      let amountVal;
      if (chip.dataset.qtyUnit !== "skott") {
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
  saveUnitPrefs(rows);

  logInProgress = true;
  logBtn.disabled = true;
  showToast("Loggar...", false);

  // Köa bara om själva skrivningen misslyckas. Annars kan ett sparat pass
  // hamna i kön och dubbleras vid nästa synk.
  try {
    await appendRows(rows);
  } catch (e) {
    const isOffline = !navigator.onLine || e instanceof TypeError;
    const rateLimited = e.status === 429;
    if (isOffline || e.authExpired || rateLimited) {
      queueRows(rows);
      if (rateLimited) scheduleQueueRetry();
      showToast(isOffline
        ? "Ingen uppkoppling - sparat, synkas automatiskt."
        : rateLimited
          ? "Många loggar just nu - passet är sparat och skickas om en stund."
          : "Sessionen gick ut - passet är sparat och synkas när du loggat in igen.", false);
      trackEvent("pass-loggat");
      resetForm();
    } else if (isSheetUnreachable(e)) {
      showToast("Appen kommer inte åt arket — se Meny → Ark. Passet är inte sparat.", true);
    } else {
      showToast("Ett fel uppstod: " + e.message, true);
    }
    logInProgress = false;
    updateLogButton();
    return;
  }

  try { await sortSheetByDateDesc(); } catch (e) { /* ej kritiskt, passet är sparat */ }
  showToast("Passet är loggat!", false);
  trackEvent("pass-loggat");
  resetForm();
  refreshData();
  logInProgress = false;
  updateLogButton();
}
