# MSF Skyttelogg — egen app-version

En snygg, installerbar PWA som loggar direkt mot ditt eget Google Sheet.
Varje person kör sin egen version — eget kalkylark, eget Google Cloud-projekt,
egen GitHub Pages-sida. Ingen delar data med någon annan.

## 0. Hämta filerna

Fick du den här guiden tillsammans med en zip-fil? Packa upp den och gå
vidare till steg 1.

Fick du istället en länk till någon annans GitHub-repo (t.ex.
`github.com/personens-användarnamn/skyttelogg`)? Gå till repot →
**Code**-knappen (grön, nära fillistan) → **Download ZIP**. Packa upp den
nedladdade filen — det ger dig exakt samma filer som en delad zip skulle,
fast direkt från källan. Du behöver inte skapa konto hos den personen eller
be om tillgång till något; det är ett publikt repo.

## 1. Kalkylarket — låt appen skapa det, eller peka på ett du redan har

**Enklast: gör ingenting här.** Lämna `SPREADSHEET_ID` i `config.js` som en tom
sträng (`""`) — se steg 3. Appen skapar då automatiskt ett nytt Google Sheet
åt dig, med rätt rubriker redan ifyllda, **första gången du loggar in**. Du
behöver aldrig röra Google Sheets manuellt.

**Har du redan ett ark** (t.ex. om du migrerar från en tidigare version av
appen och vill fortsätta på samma historik): hoppa över auto-skapandet genom
att fylla i `SPREADSHEET_ID` i steg 3 istället. Kontrollera då att rad 1 har
exakt dessa sex rubriker, i exakt den här ordningen (A till F):
```
Datum | Aktivitet | Vapengrupp/Typ | Antal skott | Plats/Förening | Notering
```
Detta är viktigt: appen skriver till kolumnerna efter **position**, inte
efter rubriknamn. Fel ordning eller en kolumn för mycket/lite gör att data
hamnar fel, utan att appen visar något felmeddelande. Kopiera även arkets ID
ur adressfältet: `https://docs.google.com/spreadsheets/d/DETTA_ÄR_ID:T/edit`

## 2. Skapa Google Cloud-projekt (engångsjobb, ~15 min)

1. Gå till [console.cloud.google.com](https://console.cloud.google.com) → skapa ett nytt projekt, t.ex. "MSF Skyttelogg".
2. **APIs och tjänster → Bibliotek** → sök upp **Google Sheets API** → Aktivera.
3. **APIs och tjänster → OAuth-samtyckesskärm** (kan också heta **Google Auth Platform**):
   - User type: **External**
   - Fyll i appnamn ("MSF Skyttelogg"), din e-post som supportkontakt.
   - Under **Data Access / Scopes**: lägg till `https://www.googleapis.com/auth/spreadsheets`.
   - Under **Audience / Testanvändare**: lägg till ditt eget Google-konto.
   - Spara — låt appen stå kvar i **Testing**.
4. **APIs och tjänster → Autentiseringsuppgifter → Skapa autentiseringsuppgifter → OAuth-klient-ID**:
   - Typ: **Webbapp**
   - Namn: valfritt
   - **Auktoriserade JavaScript-ursprung**: lägg till din kommande GitHub Pages-URL, t.ex.
     `https://dittanvandarnamn.github.io`
     (utan avslutande snedstreck, utan repo-namn — bara `https://användarnamn.github.io`)
   - Skapa → kopiera **Client ID** (`....apps.googleusercontent.com`)
   - **Rör aldrig "Client Secret"** om det dyker upp — den behövs inte här.

> Eftersom det bara är du som testanvändare spelar 7-dagarsgränsen ingen roll i praktiken — det är bara du som klickar igenom en påminnelse-inloggning ibland, inget att skicka instruktioner om till någon annan.

## 3. Fyll i config.js

Öppna `config.js`. **Om filen redan innehåller värden** (t.ex. för att du fick
den genom att kopiera någon annans repo snarare än en tom mall) — det är
**deras** uppgifter, inte dina. Radera båda raderna och fyll i dina egna:
- `CLIENT_ID` — det du kopierade i steg 2. Kopiera det **direkt från Cloud Console**,
  inte genom att skriva av för hand — och kolla att du inte råkat klistra in det
  två gånger i rad (lätt hänt, och ger felet "OAuth client was not found").
- `SPREADSHEET_ID` — lämna som tom sträng (`""`) för att låta appen skapa ett
  nytt ark automatiskt, eller klistra in ID:t från steg 1 om du redan har ett
  befintligt ark du vill använda.

En ifylld `config.js` är **aldrig** rätt att använda som den är — den pekar
alltid mot en specifik person. Byt ut båda värdena, även om de redan ser
kompletta och fungerande ut.

## 4. Lägg upp på GitHub Pages

1. Skapa ett nytt repo på GitHub (kan vara privat eller publikt — publikt kostar
   dig inget extra, koden innehåller inga hemligheter eftersom Client ID är
   tänkt att vara publikt synligt i webbappar).
2. Ladda upp **alla filer**, inklusive `icons`-mappen med de två `.png`-filerna
   i den. Mappar via GitHubs "dra och släpp"-uppladdning missar ibland
   undermappar — kontrollera efteråt att `icons/icon-192.png` och
   `icons/icon-512.png` faktiskt syns i fillistan på github.com, inte bara i
   repots rot.
3. **Settings → Pages** → Source: **Deploy from a branch** → main → `/ (root)` → Save.
4. Efter en minut är appen live på `https://dittanvandarnamn.github.io/reponamn/`.
5. Om den URL:en skiljer sig från den du angav i steg 2 (t.ex. har ett
   `/reponamn/`-suffix) — gå tillbaka till Cloud Console och lägg till den
   exakta URL:en som ytterligare ett auktoriserat ursprung.

## 5. Installera på hemskärmen

Öppna appens URL i mobilen → Chrome/Safari-menyn → "Lägg till på hemskärmen"
eller "Installera app". Klart — nu har du en egen ikon som öppnar en snabb,
installerad app utan adressfält och flikar runt om.

## Att uppdatera senare

Ändra en fil på github.com (pennikonen → redigera → committa) — sidan
uppdateras automatiskt inom en minut, tack vare att appen alltid hämtar
färska filer från nätverket först. Ingen ny inloggning eller omdeploy krävs
för vanliga kodändringar, eftersom OAuth-klienten och kalkylarket förblir
desamma.

**Kontrollera alltid att ändringen faktiskt sparades**, särskilt om du
klistrar in kod på mobilen: öppna filen igen på github.com efteråt och
bekräfta att innehållet stämmer, innan du testar i appen. En redigering som
råkar hamna i fel gren, eller aldrig committas, ger inget felmeddelande —
sidan visar bara tyst den gamla versionen.

## Vad appen gör automatiskt

- **Vapenlista**: en flik som heter "Vapen" skapas automatiskt i ditt ark
  första gången du loggar in, förifylld med fyra standardvapen. Hantera din
  egen lista via kugghjulsikonen högst upp i appen — lägg till eller ta bort
  fritt, det syns direkt i loggformuläret.
- **Offline-loggning**: har du dålig täckning (vanligt inomhus på
  skjutbanor) sparas ett pass lokalt på telefonen istället för att
  misslyckas, och skickas automatiskt till arket så fort du har uppkoppling
  igen. En liten notis ("X pass väntar på synk") visar om något ligger och
  väntar.
- **PDF-sammanställning**: exporten visar nu en summering per vapengrupp
  (antal pass, varav tävling, totalt antal askar) överst i dokumentet,
  användbart som underlag för aktivitetsintyg.

## Felsökning

- **"OAuth client was not found" / Error 401: invalid_client**: `CLIENT_ID`
  i `config.js` är felaktigt — oftast avklippt, med extra mellanslag, eller
  klistrat in dubbelt. Kopiera det på nytt direkt från Cloud Console.
- **"origin_mismatch" / Error 400**: den auktoriserade JavaScript-URL:en i
  Cloud Console matchar inte exakt den URL appen faktiskt körs på. Jämför
  tecken för tecken (inget avslutande snedstreck), spara på nytt, och vänta
  några minuter — Google cachar inställningen en stund efter en ändring.
- **"Access blocked" vid inloggning**: kolla att ditt Google-konto faktiskt
  ligger med i testanvändarlistan i steg 2.
- **"This app cannot be installed"**: `manifest.json` hittar inte ikonerna —
  se punkt 2 under steg 4 ovan.
- **Data visas inte / "Kunde inte läsa kalkylarket"**: dubbelkolla att
  `SPREADSHEET_ID` i `config.js` stämmer, och att kontot du loggar in med har
  redigeringsåtkomst till arket.
- **Appen skapade ett nytt, tomt ark trots att jag redan hade ett**: `SPREADSHEET_ID`
  i `config.js` var tomt när du loggade in första gången. Öppna det nya arket
  (länken "Öppna kalkylarket" i appen), radera det om du inte vill ha det kvar,
  klistra in ditt riktiga ID i `config.js` istället, och rensa webbläsarens
  data för sidan en gång (annars minns den fortfarande det tomma arket).
- **En uppdatering syns inte i appen**: testa alltid i ett inkognitofönster
  först — syns ändringen där men inte i din vanliga flik eller installerade
  app, är det en cache-fråga snarare än att filen är fel. Stäng och öppna
  appen på nytt; det brukar räcka.
