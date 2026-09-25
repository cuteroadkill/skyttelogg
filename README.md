# Skyttelogg

En installerbar PWA för att logga träningspass, tävlingar och annat på
skjutbanan — direkt till ett Google Kalkylark i användarens **egen** Google
Drive. Appen har ingen egen server och ingen egen databas.

**Hittat en bugg, eller har en idé?** Öppna en
[Issue](../../issues/new/choose) — det finns färdiga mallar för båda.

## Hur appen fungerar

- **En person hostar** appen (GitHub Pages) och Google Cloud-projektet.
  Alla andra öppnar bara länken och loggar in med sitt eget Google-konto.
- **Varje användare har sitt eget ark** i sin egen Drive. Värden ser aldrig
  någon annans data.
- Appen använder behörigheten **`drive.file`**: den kommer bara åt filer
  den själv har skapat, eller som användaren uttryckligen valt i Googles
  filväljare (Picker). Resten av Driven är osynlig för appen.
- Eftersom appen inte kan söka i Driven kan den inte "hitta" ett ark på en
  ny enhet. Första inloggningen på en enhet visar därför **Koppla ditt
  kalkylark**: välj ditt befintliga ark i Google Drive, eller skapa ett nytt.
  Valet sparas på enheten.

## Appens delar

Appen har en bottenmeny med tre flikar:

- **Logga** — startvyn. Datum (dagens är förvalt), typ av pass, vapen och
  antal, plats, notering, **Logga pass**, och under det de senaste passen.
  Tryck på ett pass för att redigera eller radera det.
- **Kalender** — månadsvy med en prick per aktivitetstyp och dag (ljus =
  träning, större i accentfärg = tävling, grå ring = annat), antal dagar per
  typ för månaden, och passen för vald dag.
- **Meny** — Exportera till PDF, Öppna kalkylarket, Inställningar (Vapen,
  Tema, Ark), Rapportera bugg, Bjud på en kaffe, Integritetspolicy och
  Logga ut.

## Värdens uppsättning (engångsjobb)

### 1. Google Cloud-projekt

1. [console.cloud.google.com](https://console.cloud.google.com) → skapa ett
   projekt, t.ex. "Skyttelogg".
2. **APIs och tjänster → Bibliotek** → aktivera:
   - **Google Sheets API** (läsa/skriva i arken)
   - **Google Picker API** (filväljaren)
3. **Google Auth Platform** (hette tidigare OAuth-samtyckesskärm):
   - **Branding**: appnamn "Skyttelogg", supportmejl, länk till
     integritetspolicyn (`.../skyttelogg/privacy.html`).
   - **Audience**: User type **External**. Publishing status **In
     production** — med enbart `drive.file` (non-sensitive) krävs ingen
     verifiering och ingen testanvändarlista.
   - **Data Access**: lägg till scopet
     `https://www.googleapis.com/auth/drive.file` — och inget annat.
4. **Autentiseringsuppgifter → Skapa → OAuth-klient-ID**:
   - Typ: **Webbapp**
   - **Auktoriserade JavaScript-ursprung**: `https://användarnamn.github.io`
     (utan avslutande snedstreck och utan repo-namn)
   - Kopiera **Client ID**. Client Secret behövs inte — rör den inte.
5. **Autentiseringsuppgifter → Skapa → API-nyckel** (för Picker):
   - **Application restrictions → Websites**: `https://användarnamn.github.io/*`
   - **API restrictions → Google Picker API**
   - Nyckeln syns i källkoden per design — begränsningarna ovan är skyddet.

### 2. config.js

| Fält | Värde |
|---|---|
| `CLIENT_ID` | Client ID från steg 1.4. Kopiera direkt från Console. |
| `SPREADSHEET_ID` | `""` — alltid tomt i den delade appen. |
| `SCOPES` | `https://www.googleapis.com/auth/drive.file` — rör inte. |
| `PICKER_API_KEY` | API-nyckeln från steg 1.5. Tom = Drive-knapparna döljs. |
| `ISSUES_URL` | Länk till repots issues, eller `""` för att dölja. |
| `SWISH_PARTS` | Swish-nummer för kaffeknappen, eller `[]` för att dölja. Numret är publikt. |

Picker behöver också Cloud-projektets **projektnummer**. Appen läser det
automatiskt ur `CLIENT_ID` (siffrorna före första bindestrecket) — inget
extra att fylla i.

### 3. GitHub Pages

1. Ladda upp alla filer, inklusive mappen `icons/` med `icon-192.png` och
   `icon-512.png`. Kontrollera på github.com att ikonerna faktiskt ligger i
   `icons/` — dra-och-släpp-uppladdning tappar ibland undermappar.
2. **Settings → Pages** → Deploy from a branch → `main` → `/ (root)`.
3. Appen är live på `https://användarnamn.github.io/reponamn/` efter någon
   minut.

## Bjuda in en ny användare

Skicka länken. Personen behöver inget Cloud-projekt, inget GitHub och
ingen `config.js` — bara logga in och välja **Skapa nytt ark** första
gången.

## Installera på hemskärmen

Öppna länken i mobilen → webbläsarmenyn → **Lägg till på hemskärmen** /
**Installera app**.

## Byta telefon eller webbläsare

Logga in → **Koppla ditt kalkylark** visas → **Välj befintligt i Google
Drive** → välj ditt ark. Klart. Samma sak går att göra när som helst under
**Meny → Ark**.

Välj **inte** "Skapa nytt ark" om du vill behålla din historik — då får du
ett nytt, tomt ark bredvid det gamla.

Alla ark appen skapar heter "Skyttelogg". Under **Meny → Ark** visas därför
även de fyra sista tecknen i arkets ID (t.ex. `Skyttelogg · …a3F9`) — jämför
med slutet av adressen när arket är öppet i Google Sheets.

## Vad appen gör automatiskt

- **Nytt ark** skapas med rätt rubriker och svensk språkinställning.
  Kolumnerna är, i exakt denna ordning (A–F):
  `Datum | Aktivitet | Vapengrupp/Typ | Antal skott | Plats/Förening | Notering`.
  Appen skriver efter **position**, inte rubriknamn — flytta inte kolumnerna.
- **Vapenlista**: fliken "Vapen" skapas automatiskt med fyra standardvapen.
  Hanteras under **Meny → Vapen** (lägg till, ta bort, favorit, dra för att
  sortera).
- **Offline-loggning**: utan täckning (vanligt inomhus på banor) eller om
  sessionen gått ut sparas passet lokalt och skickas automatiskt senare.
  "X pass väntar på synk" visas ovanför Logga pass så länge något ligger i kö.
- **Utgången session**: Googles inloggning gäller ungefär en timme. Efter
  det visas "Sessionen gick ut" — tryck på den för att logga in igen.
- **Ark som slutat svara**: om arket raderas eller åtkomsten försvinner
  under en session tänds en röd prick på **Meny**, och **Ark**-raden visar
  vad som behöver göras. Obs: ett ark som bara ligger i papperskorgen
  fungerar fortfarande och ger ingen varning.
- **Utloggning** kräver bekräftelse, och nämner om det finns pass i kö.
- **Säker redigering**: innan ett pass sparas om eller raderas kontrollerar
  appen att raden i arket fortfarande är samma pass som visas.
- **PDF-sammanställning** per vapengrupp (antal pass, varav tävling, totalt
  antal askar/skott), användbar som underlag för aktivitetsintyg.

## Uppdatera appen

Redigera en fil på github.com och committa — sidan uppdateras inom någon
minut, eftersom appen alltid hämtar färska filer från nätet först.
**Öppna filen igen efteråt och kontrollera** att ändringen faktiskt sparades;
en redigering i fel gren ger inget felmeddelande.

Vid större releaser: höj `CACHE_VERSION` i `sw.js`, så rensas den gamla
offline-reserven.

### Testa större ändringar i beta först

1. Lägg de ändrade filerna i mappen `beta/`, tillsammans med kopior av
   `config.js`, `privacy.html` och `icons/`.
2. Testa på `https://användarnamn.github.io/reponamn/beta/` — öppna i
   webbläsaren, installera inte på hemskärmen. Samma domän gör att
   inloggning och Picker fungerar utan ändringar i Console, och betan
   hittar användarens vanliga ark.
3. När allt fungerar: kopiera de ändrade filerna till roten. Behåll
   `beta/` som testmiljö till nästa gång — då behöver bara de ändrade
   filerna läggas dit.

## Köra en helt egen, fristående kopia

Gör om hela "Värdens uppsättning" med **ditt eget** Cloud-projekt och
**dina egna** värden i `config.js`. Använd aldrig någon annans `CLIENT_ID`
eller `PICKER_API_KEY`, även om de ser kompletta ut.

## Felsökning

- **"OAuth client was not found" / Error 401 invalid_client**: `CLIENT_ID`
  är fel — avklippt, med mellanslag, eller inklistrat två gånger.
- **"origin_mismatch" / Error 400**: JavaScript-ursprunget i Console matchar
  inte exakt adressen appen körs på. Inget avslutande snedstreck. Google
  cachar ändringen en stund — vänta några minuter.
- **"Access blocked"**: appen är i läget Testing och kontot saknas under
  **Test users** — eller publicera appen (In production).
- **"Google Sheets/Picker API has not been used in project… or it is
  disabled"**: aktivera API:et under **Bibliotek** och vänta en minut.
- **Drive-knappen syns inte**: `PICKER_API_KEY` är tom i `config.js`.
- **Filväljaren öppnas men valt ark ger "Appen har inte åtkomst"**: kontrollera
  att Picker API är aktiverat och att API-nyckeln är begränsad till rätt
  webbadress. Kontrollera också att `CLIENT_ID` är komplett — projektnumret
  läses ur det.
- **"Koppla ditt kalkylark" visas trots att jag använt appen förut**: enheten
  kommer inte åt det tidigare arket (ny telefon, rensad webbläsardata, eller
  ändrad behörighet). Välj ditt ark i Google Drive.
- **Röd prick på Meny**: appen kommer inte åt det kopplade arket. Öppna
  **Meny → Ark** och välj ditt ark igen via Google Drive.
- **Manuellt inklistrad länk ger "Appen har inte åtkomst"**: med `drive.file`
  fungerar länk/ID bara för ark appen redan kommer åt. Använd Drive-knappen.
- **"This app cannot be installed"**: `manifest.json` hittar inte ikonerna —
  se GitHub Pages punkt 1.
- **En uppdatering syns inte**: testa i ett inkognitofönster. Syns den där
  är det cache — stäng och öppna appen igen.

## Kända begränsningar

- Ett ark som ligger i papperskorgen i Drive fungerar tills Google raderar
  det automatiskt (efter 30 dagar) — appen varnar inte för det ännu.
- Swish-numret för kaffeknappen är publikt i repot. Medvetet val.
