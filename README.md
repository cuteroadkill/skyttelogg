# MSF Skyttelogg — egen app-version

En snygg, installerbar PWA som loggar direkt mot ditt befintliga Google Sheet.
Byggd för dig själv — inget delningsflöde, ingen OAuth-testanvändarlista att sköta.

## 1. Skapa Google Cloud-projekt (engångsjobb, ~15 min)

1. Gå till [console.cloud.google.com](https://console.cloud.google.com) → skapa ett nytt projekt, t.ex. "MSF Skyttelogg".
2. **APIs och tjänster → Bibliotek** → sök upp **Google Sheets API** → Aktivera.
3. **APIs och tjänster → OAuth-samtyckesskärm**:
   - User type: **External**
   - Fyll i appnamn ("MSF Skyttelogg"), din e-post som supportkontakt.
   - Scopes: lägg till `.../auth/spreadsheets`.
   - Under **Testanvändare**: lägg till ditt eget Google-konto.
   - Spara — låt appen stå kvar i **Testing**.
4. **APIs och tjänster → Autentiseringsuppgifter → Skapa autentiseringsuppgifter → OAuth-klient-ID**:
   - Typ: **Webbapp**
   - Namn: valfritt
   - **Auktoriserade JavaScript-ursprung**: lägg till din kommande GitHub Pages-URL, t.ex.
     `https://dittanvandarnamn.github.io`
     (du kan lägga till fler senare, eller uppdatera den här om URL:en ändras)
   - Skapa → kopiera **Client ID** (`....apps.googleusercontent.com`)

> Eftersom det bara är du som testanvändare spelar 7-dagarsgränsen ingen roll i praktiken — det är bara du som klickar igenom en påminnelse-inloggning ibland, inget att skicka instruktioner om till någon annan.

## 2. Fyll i config.js

Öppna `config.js` och klistra in:
- `CLIENT_ID` — det du kopierade i steg 1.
- `SPREADSHEET_ID` — ID:t ur din befintliga skytteloggs-URL:
  `https://docs.google.com/spreadsheets/d/DETTA_ÄR_ID:T/edit`

## 3. Lägg upp på GitHub Pages

1. Skapa ett nytt repo på GitHub (kan vara privat eller publikt — publikt kostar
   dig inget extra, koden innehåller inga hemligheter eftersom Client ID är
   tänkt att vara publikt synligt i webbappar).
2. Ladda upp alla filer i den här mappen till repots rot.
3. **Settings → Pages** → Source: **Deploy from a branch** → main → `/ (root)` → Save.
4. Efter en minut är appen live på `https://dittanvandarnamn.github.io/reponamn/`.
5. Om den URL:en skiljer sig från den du angav i steg 1 (t.ex. har ett
   `/reponamn/`-suffix) — gå tillbaka till Cloud Console och lägg till den
   exakta URL:en som ytterligare ett auktoriserat ursprung.

## 4. Installera på hemskärmen

Öppna appens URL i mobilen → Chrome/Safari-menyn → "Lägg till på hemskärmen".
Klart — nu har du en egen ikon som öppnar en snabb, installerad app.

## Att uppdatera senare

Ändra filerna lokalt (eller be om ny kod), pusha till GitHub — sidan uppdateras
automatiskt inom en minut. Ingen ny inloggning eller omdeploy krävs för
vanliga kodändringar, eftersom OAuth-klienten och kalkylarket förblir desamma.

## Felsökning

- **"Redirect URI mismatch" eller inloggningen gör inget**: kontrollera att
  GitHub Pages-URL:en exakt matchar ett auktoriserat JavaScript-ursprung i
  Cloud Console (inklusive `https://`, utan avslutande snedstreck).
- **"Access blocked" vid inloggning**: kolla att ditt Google-konto faktiskt
  ligger med i testanvändarlistan i steg 1.
- **Data visas inte / "Kunde inte läsa kalkylarket"**: dubbelkolla att
  `SPREADSHEET_ID` i `config.js` stämmer, och att kontot du loggar in med har
  redigeringsåtkomst till arket.
