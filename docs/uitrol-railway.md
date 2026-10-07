# Uitrol op Railway — stappenplan

Versie 0.1 · 1 oktober 2026 · voor: Rubert Rietkerk.

Dit document beschrijft de eerste uitrol van de gateway op Railway (fase 3, ronde 4,
SPEC §13). Je voert alles zelf uit in het Railway-dashboard; Claude Code rolt niets uit.

Bij de eerste uitrol staat de **planner uit** (`PLANNER_ENABLED=false`). De gateway
ontvangt dan wel webhooks, beantwoordt de MCP en toont de goedkeuringspagina, maar
verstuurt niets naar LinkedIn. Pas als alle controles hieronder goed zijn, zet je de
planner in een aparte stap aan.

## Wat de dienst doet bij het starten

- Startcommando: `npm start` (Railway pakt dit automatisch op uit `package.json`).
- Controleert eerst alle verplichte variabelen. Ontbreekt er iets, dan stopt hij met
  één Nederlandse foutregel per ontbrekende variabele (alleen de naam, nooit de waarde).
- Luistert op de poort uit `PORT` (Railway zet die zelf).
- Draait **geen** databasemigraties. Die blijven een aparte handmatige stap.
- Logt als JSON, één regel per gebeurtenis. Sleutels, tokens, de wachtwoord-hash en
  `DATABASE_URL` worden afgeschermd.

## Vooraf

1. **Migraties.** De database moet bij zijn. Migratie `0002_sequences.sql` is op
   1 oktober 2026 op Supabase uitgevoerd; `npm run migrate -- --dry-run` meldde daarna
   "Geen openstaande migraties". Controleer dit vóór elke uitrol opnieuw met dezelfde
   dry-run. Komt er een nieuwe migratie bij, voer die dan pas na een bewuste beslissing
   uit met `npm run migrate`.
2. **Wachtwoord-hash.** Maak lokaal een hash met `npm run admin:hash` en houd de regel
   bij de hand. Kies hiervoor een ander wachtwoord dan voor je lokale demo.
3. **Productie-sleutels.** Unipile v1 kent geen aparte apps: productie gebruikt
   **dezelfde DSN** als ontwikkeling. Maak in het Unipile-dashboard wel een **eigen
   Access Token** voor de gateway, met een lange geldigheid en een herkenbare naam
   (bijv. `gateway-railway`). Gebruik dus niet het token uit je lokale `.env`; dan kun je
   het productie-token apart intrekken of vervangen. Maak daarnaast een **nieuw**
   `WEBHOOK_SECRET` en `MCP_TOKEN`. Een sterk geheim maak je bijvoorbeeld met
   `openssl rand -base64 32`.
4. **Databaseverbinding.** Gebruik de URL van de Supabase **Session pooler** (poort 5432),
   dezelfde soort als lokaal voor `npm run db:check`. De directe verbinding werkt alleen
   via IPv6 en is vanaf Railway niet betrouwbaar bereikbaar.

## Stap 1 — Project aanmaken vanuit GitHub

1. Ga naar [railway.com](https://railway.com) en log in.
2. Klik op **New Project** → **Deploy from GitHub repo**.
3. Geef Railway toegang tot de repository `RubertR/markaas-linkedin-gateway` (alleen
   deze repo is genoeg) en kies hem.
4. Railway begint meteen te bouwen. De eerste uitrol mislukt omdat de variabelen nog
   ontbreken. Dat is verwacht: in de logs zie je per ontbrekende variabele een regel.

## Stap 2 — Regio EU West (Amsterdam)

1. Open de service → **Settings** → **Deploy** → **Regions**.
2. Kies **EU West (Amsterdam, Netherlands)**. Zet geen andere regio's aan.
3. Controleer dat er maar één replica draait. De sessies van de goedkeuringspagina en
   de brute-force-blokkade staan in het geheugen van één proces.

## Stap 3 — Variabelen invullen

Open de service → **Variables** → **New Variable**. Plak elke waarde precies zoals hij
is, zonder aanhalingstekens. Waarden staan niet in dit document; gebruik de productie-
waarden uit "Vooraf".

| Variabele | Verplicht | Wat erin hoort |
| --- | --- | --- |
| `UNIPILE_DSN` | ja | Dezelfde Unipile-DSN als bij ontwikkeling (host:poort) |
| `UNIPILE_API_KEY` | ja | Het eigen Access Token voor de gateway (bijv. `gateway-railway`), lange geldigheid |
| `WEBHOOK_SECRET` | ja | Nieuw geheim voor de Unipile-webhooks |
| `MCP_TOKEN` | ja | Nieuw bearer-token voor de skills |
| `ADMIN_PASSWORD_HASH` | ja | De regel uit `npm run admin:hash` (alleen het deel na `=`) |
| `DATABASE_URL` | ja | Supabase Session-pooler-URL (poort 5432) |
| `NODE_ENV` | ja, voor productie | `production` |
| `PLANNER_ENABLED` | ja, bij eerste uitrol | `false` |
| `LOG_LEVEL` | nee | `info` |
| `TIMEZONE_DEFAULT` | nee | `Europe/Amsterdam` |
| `PUBLIC_BASE_URL` | nee | Alleen bij een eigen domein, bijv. `https://gateway.markaas.nl` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | nee | Alle drie of geen; zonder staat betalen uit. Zie README, "Stripe inrichten" |

`PORT` vul je **niet** in; die zet Railway zelf.

Wat `NODE_ENV=production` doet:

- cookies van de goedkeuringspagina krijgen de vlag `Secure` (alleen via https);
- het client-IP voor de brute-force-blokkade komt uit de proxy-headers van Railway.

Klik daarna op **Deploy** (of wacht tot Railway de wijziging zelf uitrolt).

## Stap 4 — Publiek domein en health check

1. Service → **Settings** → **Networking** → **Generate Domain**. Je krijgt een adres
   als `https://<naam>.up.railway.app`. De gateway gebruikt dat automatisch voor de
   `notify_url` van koppellinks (via `RAILWAY_PUBLIC_DOMAIN`), tenzij je
   `PUBLIC_BASE_URL` invult.
2. Service → **Settings** → **Deploy** → **Healthcheck Path**: vul `/health` in.
   Railway zet een nieuwe versie pas live als dit adres antwoordt.

## Stap 5 — Controleren

### /health

Open `https://<jouw-domein>/health` in de browser. Je hoort dit te zien:

```json
{"status":"ok","versie":"0.1.0","database":{"bereikbaar":true}}
```

- `"bereikbaar": false` met `"status":"database_onbereikbaar"`: de dienst draait, maar
  kan de database niet bereiken. Controleer `DATABASE_URL` (Session pooler, poort 5432)
  en kijk in de logs.
- Geen antwoord of een Railway-foutpagina: kijk in **Deployments** → laatste uitrol →
  **Deploy Logs**. Ontbrekende variabelen staan daar als losse foutregels.

In de logs hoort bij het starten deze regel te staan, met `"planner":"uit"`:

```json
{"niveau":"info","bericht":"Gateway gestart","omgeving":"production","planner":"uit", ...}
```

### /admin

1. Open `https://<jouw-domein>/admin/`. Je wordt doorgestuurd naar `/admin/login`.
2. Log in met het wachtwoord waarvan je in "Vooraf" de hash maakte.
3. Je ziet het overzicht met concepten en onzekere acties (op een verse database leeg).
4. Controleer in de browser (ontwikkelhulpmiddelen → Application/Opslag → Cookies) dat
   `admin_sessie` de vlaggen **Secure**, **HttpOnly** en **SameSite=Strict** heeft.

Na elke nieuwe uitrol moet je opnieuw inloggen: sessies staan in het geheugen.

### /mcp (optioneel)

Een verzoek zonder token moet geweigerd worden:

```sh
curl -i -X POST https://<jouw-domein>/mcp
```

Verwacht: `HTTP/2 401`.

## Nog niet doen in deze stap

- **Planner aanzetten.** Pas na geslaagde controles en jouw akkoord: zet
  `PLANNER_ENABLED=true` en rol opnieuw uit. In de logs staat dan
  `"Planner staat aan; ticks op willekeurige momenten binnen werktijd."`. De planner
  tickt op willekeurige momenten (2–8 minuten uit elkaar, uit `config/limits.json`) en
  alleen op werkdagen tussen 08:30 en 17:30 (Europe/Amsterdam).
- **Unipile-webhooks omzetten** naar `https://<jouw-domein>/webhooks/unipile`. Dat is
  een aparte stap uit `docs/fase-3-plan.md` ronde 4.
- **Eigen domein** (`gateway.markaas.nl`) en Supabase-netwerkregels. Ook aparte stappen.

## Terugdraaien

- Iets mis na een uitrol: **Deployments** → vorige geslaagde uitrol → **Redeploy**.
- Direct alles stilzetten zonder terug te rollen: zet `PLANNER_ENABLED=false` en rol
  opnieuw uit. Webhooks, MCP en `/admin` blijven werken; er gaat niets meer naar
  LinkedIn.
