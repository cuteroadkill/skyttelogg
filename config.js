// ---------------------------------------------------------------
// Fyll i dina egna värden här. Se README.md för hur du hittar dem.
// ---------------------------------------------------------------

const CONFIG = {
  // Från Google Cloud Console → API:er och tjänster → Autentiseringsuppgifter
  // → OAuth-klient-ID (typ "Webbapp")
  CLIENT_ID: "1069993239744-r9lqg38t6u4gku0at7j86n8pbqv5a0pl.apps.googleusercontent.com",

  // ID:t i URL:en till ditt kalkylark, OM du redan har ett du vill använda
  // (t.ex. migrerar från en tidigare version av appen):
  // https://docs.google.com/spreadsheets/d/DETTA_ÄR_ID:T/edit
  //
  // Har du INGET ark än? Lämna kvar som tom sträng ("") - appen skapar då
  // automatiskt ett nytt ark åt dig, med rätt kolumner redan på plats, första
  // gången du loggar in. Den kommer ihåg vilket ark den skapade på den här
  // enheten. Vill du kunna öppna appen på en ny enhet längre fram utan att den
  // skapar ännu ett ark: öppna länken "Öppna kalkylarket" i appen efteråt,
  // kopiera ID:t ur adressfältet, och klistra in det här istället.
  SPREADSHEET_ID: "",

  // Behörighet appen ber om — rör inte denna
  SCOPES: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly"
};
