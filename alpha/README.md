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

Appen har en bottenmeny med fyra flikar:

- **Logga** — startvyn. Datum (dagens är förvalt), typ av pass, vapen och
  antal, plats, notering, **Logga pass**, och under det de senaste passen.
  Tryck på ett pass för att redigera eller radera det.
- **Kalender** — månadsvy med en prick per aktivitetstyp och dag (ljus =
  träning, större i accentfärg = tävling, grå ring = annat), antal dagar per
  typ för månaden, och passen för vald dag.
- **Statistik** — antal pass, skott och tävlingar sedan första loggade pass,
  och per vapen: senast skjutet, pass och skott totalt och de senaste 12
  månaderna. Här finns också **Exportera till PDF**, en sammanställning som
  kan användas som underlag när föreningen ska intyga skytteaktivitet. Efter
  exporten kan PDF:en delas direkt via telefonens delningsmeny eller sparas.
- **Meny** — Öppna kalkylarket, Inställningar (Vapen, Tema, Ark),
  Rapportera bugg, Bjud på en kaffe, Integritetspolicy och Logga ut.

## Värdens uppsättning (engångsjobb)

### 1. Google Cloud-projekt

1. [console.cloud.google.com](https://console.cloud.google.com) → skapa ett
   projekt, t.ex. "Skyttelogg".
2. **APIs och tjänster → Bibliotek** → aktivera:
   - **Google Sheets API** (läsa/skriva i arken)
   - **Google Picker API** (filväljaren)
   - **Google Drive API** (kontroll av om arket ligger i papperskorgen)
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
  sortera, skott per ask, dölja). Kolumnerna är
  `Namn | Favorit | Skott per ask | Dold`; saknas skott per ask räknas det
  som 50. Dolda vapen syns inte när man loggar men finns kvar i statistiken. Tar man bort ett vapen som har
  loggade pass ligger passen kvar och räknas under det gamla namnet.
- **Statistik**: pass loggade i askar räknas om till skott med vapnets
  askstorlek och visas som uppskattning (≈). Samma siffror skrivs som värden
  till fliken "Statistik" i arket när statistiken öppnas i appen. Fliken ägs
  av appen och skrivs om — bygg egna beräkningar i en annan flik.
- **Skydd i arket**: flikarna Vapen och Statistik, samt rubrikraden i
  Loggbok, har ett varningsskydd. Man kan fortfarande redigera, men Google
  Sheets ber om bekräftelse först. Loggbokens rader går att ändra fritt.
  Bredvid vapenlistan (kolumn F) förklaras vad kolumnerna betyder.
- **Offline-loggning**: utan täckning (vanligt inomhus på banor) eller om
  sessionen gått ut sparas passet lokalt och skickas automatiskt senare.
  Samma sak gäller om Google tillfälligt begränsar antalet anrop (fel 429);
  då görs ett nytt försök efter en minut.
  "X pass väntar på synk" visas ovanför Logga pass så länge något ligger i kö.
- **Inloggning**: Googles inloggning gäller ungefär en timme och sparas på
  enheten under den tiden, så appen kan öppnas igen utan ny inloggning (med
  en kort startanimation medan passen hämtas). Därefter räcker ett tryck på
  **Fortsätt**. Går inloggningen ut medan appen är öppen visas "Sessionen
  gick ut" — tryck på den för att fortsätta. Utloggning tar bort den sparade
  inloggningen.
- **Ark som slutat svara**: om arket raderas eller åtkomsten försvinner
  under en session tänds en röd prick på **Meny**, och **Ark**-raden visar
  vad som behöver göras. Samma varning visas om arket ligger i
  papperskorgen i Drive, eftersom Google då raderar det efter 30 dagar.
- **Utloggning** kräver bekräftelse, och nämner om det finns pass i kö.
- **Säker redigering**: innan ett pass sparas om eller raderas kontrollerar
  appen att raden i arket fortfarande är samma pass som visas.
- **PDF-sammanställning** per vapengrupp (antal pass, varav tävling, totalt
  antal askar/skott), användbar som underlag för aktivitetsintyg.

## Versioner och kanaler

- **Beta** — den publicerade appen i repots rot. Används av alla, fungerar,
  men utvecklas fortfarande. Märks med `BETA` bredvid appnamnet.
- **Alpha** — testkanalen i mappen `alpha/`. Nytt testas här först av
  utvecklaren och ett par testare. Märks med `ALPHA` i varningsfärg.

Versionen skrivs som `ÅÅ.M.N` (år, månad, löpnummer inom månaden), t.ex.
`26.9.1`, och står i `APP_VERSION` överst i `app.js`. Den visas längst ned i
Meny, t.ex. `26.9.1 · alpha`. Samma nummer gäller i båda kanalerna, så en
version flyttas från alpha till beta utan att någon fil ändras. Ange
versionen i buggrapporter. Via **Meny → Rapportera bugg** eller **Föreslå en
idé** fylls versionen i automatiskt, och ett tryck på versionen längst ned i
Meny kopierar den.

`PUBLIC_BETA` i `app.js` styr beta-märkningen och sätts till `false` när
appen anses färdig.

## Uppdatera appen

1. Räkna upp `APP_VERSION` i `app.js` (även för små rättningar).
2. Lägg de ändrade filerna i `alpha/`. Mappen innehåller också egna kopior
   av `config.js`, `privacy.html`, `manifest.json` och `icons/`.
3. Öppna `https://användarnamn.github.io/reponamn/alpha/` i webbläsaren
   (installera inte på hemskärmen) och kontrollera att Meny visar rätt
   version innan testet börjar. Samma domän gör att inloggning och Picker
   fungerar utan ändringar i Console, och alpha hittar användarens vanliga
   ark.
4. När allt fungerar: kopiera de ändrade filerna till roten. Meny i den
   publicerade appen ska då visa samma version, med `beta`.

**Öppna varje fil igen efter uppladdning och kontrollera** att ändringen
faktiskt sparades; en redigering i fel gren ger inget felmeddelande.

Service workern registreras med versionen i adressen och ber alltid servern
bekräfta att filerna är aktuella, så en ny version slår igenom direkt och
den gamla offline-reserven rensas automatiskt.

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
  Är Drive API inte aktiverat fungerar appen ändå, men varningen för ark i
  papperskorgen uteblir.
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
- **En uppdatering syns inte**: jämför versionen längst ned i Meny med den
  som laddades upp. Stäng alla flikar med appen och öppna igen.

## Kända begränsningar

- Swish-numret för kaffeknappen är publikt i repot. Medvetet val.
