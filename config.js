// Konfiguration för Skyttelogg. Se README.md för hur värdena tas fram.

const CONFIG = {
  // OAuth-klient-ID (typ Webbapp) från Google Cloud Console →
  // Autentiseringsuppgifter.
  CLIENT_ID: "1069993239744-r9lqg38t6u4gku0at7j86n8pbqv5a0pl.apps.googleusercontent.com",

  // Fast ark-ID för en fristående installation. Tomt i den delade appen:
  // varje användare väljer eller skapar sitt ark vid första inloggningen.
  SPREADSHEET_ID: "",

  // Appens enda behörighet. Ändras inte.
  SCOPES: "https://www.googleapis.com/auth/drive.file",

  // API-nyckel för Google Picker (Välj ark i Google Drive). Begränsad till
  // webbplatsens adress och Google Picker API i Cloud Console. Tom sträng
  // döljer Drive-knapparna.
  PICKER_API_KEY: "AIzaSyDgECxEcpRWfZYSsHDJjBMK3Bhy5_2bBh4",

  // Länk för Meny → Rapportera bugg eller idé. Tom sträng döljer raden.
  ISSUES_URL: "https://github.com/cuteroadkill/skyttelogg/issues/new/choose",

  // Swish-nummer för Meny → Bjud på en kaffe (delarna sätts ihop). Numret
  // är publikt. Tom lista döljer raden.
  SWISH_PARTS: ["073", "378", "4500"]
};
