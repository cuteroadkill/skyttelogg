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
  setDateFor("dateInput", "dateDisplay", todayLocalStr());
  wireDatePicker("dateInput", "dateDisplay");
  wireDatePicker("editDateInput", "editDateDisplay");
  wireDatePicker("exportFromInput", "exportFromDisplay");
  wireDatePicker("exportToInput", "exportToDisplay");
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

let recentRowsCache = {}; // radnummer (1-indexerat i arket) -> radens värden

async function loadRecent() {
  const list = document.getElementById("recentList");
  list.innerHTML = `<p class="muted small">Laddar...</p>`;
  try {
    const range = encodeURIComponent(`${sheetTitle}!A2:F`);
    const data = await sheetsFetch(
      `${CONFIG.SPREADSHEET_ID}/values/${range}`
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

  WEAPONS.forEach(w => container.appendChild(weaponChip(w.value, w.label)));

  // Fritextchip för valfritt vapen
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
    </span>`;
  container.appendChild(chip);
  wireChip(chip, true);
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
    </span>`;
  wireChip(chip, false);
  return chip;
}

function wireChip(chip, isCustom) {
  const cb = chip.querySelector(".chip-input");
  const amountEl = chip.querySelector(".amount");
  const buttons = chip.querySelectorAll(".step-btn");

  if (isCustom) {
    const nameInput = chip.querySelector(".custom-name");
    // Skriver man i fältet räknas raden som vald - annars måste man
    // kryssa i den manuellt trots att den saknar synlig kryssruta
    nameInput.addEventListener("click", e => e.stopPropagation());
    nameInput.addEventListener("input", () => {
      cb.checked = nameInput.value.trim().length > 0;
    });
  }

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
  });
  setMode("training");
}

// ---------- Redigera / radera loggat pass ----------
let editingRow = null;

function openEditOverlay(rowNumber) {
  const row = recentRowsCache[rowNumber];
  if (!row) return;
  editingRow = rowNumber;
  const [date, activity, weapon, amount, , note] = row;
  setDateFor("editDateInput", "editDateDisplay", date || todayLocalStr());
  document.getElementById("editActivity").value = activity || "";
  document.getElementById("editWeapon").value = weapon || "";
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
      `${CONFIG.SPREADSHEET_ID}/values/${range}?valueInputOption=USER_ENTERED`,
      { method: "PUT", body: JSON.stringify({ values: [[date, activity, weapon, amount, "MSF", note]] }) }
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
    await sheetsFetch(`${CONFIG.SPREADSHEET_ID}:batchUpdate`, {
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
    const data = await sheetsFetch(`${CONFIG.SPREADSHEET_ID}/values/${range}`);
    const rows = (data.values || [])
      .filter(r => r[0] && r[0] >= from && r[0] <= to)
      .sort((a, b) => a[0].localeCompare(b[0])); // kronologisk i PDF:en, äldst först

    if (rows.length === 0) {
      showToast("Inga pass i det valda intervallet.", true);
      return;
    }

    buildPdf(rows, from, to);
    showToast("PDF skapad!", false);
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
  doc.text("MSF Skyttelogg", marginX, y);
  y += 8;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(110, 110, 110);
  doc.text(`Period: ${formatDateDisplay(from)} \u2013 ${formatDateDisplay(to)}`, marginX, y);
  y += 5;
  doc.text(`Skapad: ${formatDateDisplay(todayLocalStr())}`, marginX, y);
  y += 9;

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

  doc.save(`msf-skyttelogg-${from}-till-${to}.pdf`);
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

    document.querySelectorAll(".weapon-chip").forEach(chip => {
      const cb = chip.querySelector(".chip-input");
      if (!cb.checked) return;
      let weapon = chip.dataset.weapon;
      const custom = chip.querySelector(".custom-name");
      if (custom) {
        weapon = custom.value.trim();
        if (!weapon) { customError = true; return; }
      }
      const val = parseFloat(chip.querySelector(".amount").dataset.val);
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
