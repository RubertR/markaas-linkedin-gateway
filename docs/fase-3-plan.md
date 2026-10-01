# Fase 3 — Eigen proef (plan)

Versie 0.1 · 1 oktober 2026 · eigenaar: Rubert Rietkerk.

Doel van fase 3 (SPEC §10): MCP-server, goedkeuringspagina en sequenties staan;
drie weken op Ruberts eigen account op halve normen zonder waarschuwing van
LinkedIn of Unipile. Poort naar fase 4 is dezelfde drie weken foutloos achter de
rug — pas dan gaan klanten over.

Werkwijze: zoals SPEC §10 en CLAUDE.md voorschrijven, **eerst de SPEC, dan de
code**. Elk onderdeel start met tests (inclusief foutpaden 429, `CREDENTIALS`,
time-out). Geen echte LinkedIn- of Unipile-aanroepen uit de rondes zelf — tests
blijven tegen `test/fake-unipile/`. Handmatige proeven op Ruberts account
blijven voorbehouden aan Rubert zelf, los van deze rondes.

## Rondes

### Ronde 1 — MCP-server (`src/mcp/`)

Doel: een Streamable-HTTP-MCP-endpoint op `/mcp` binnen de bestaande hono-server
met de zeven tools uit SPEC §7. Niets meer, niets minder.

**Harde grenzen** (hergezegd vanuit SPEC §7 en §12):

- Geen tool kan een actie goedkeuren, afwijzen, op `approved` zetten of direct
  verzenden. `queue_action` plaatst de actie uitsluitend als `draft`.
- Alleen de zeven tools zijn beschikbaar: `list_accounts`, `account_health`,
  `get_budget`, `search_people`, `get_profile`, `queue_action`, `get_results`.
  Een vrije HTTP-pass-through of een "test-tool" is uitgesloten.
- `search_people` en `get_profile` lopen via de budgetmotor en wachtrij —
  nooit rechtstreeks naar Unipile. Overschrijding → NL-foutmelding met oorzaak
  en vervolgstap uit de bestaande `beoordeel`-helper.
- Transport: Streamable HTTP, beveiligd met een bearer-token uit `MCP_TOKEN`
  (`.env.example` bijgewerkt, waarde nooit gelogd, vergelijking via
  `timingSafeEqual` net als bij `WEBHOOK_SECRET`). Zonder of met fout token: 401.

**Tests-first (SPEC §10):**

- Geen enkele tool kan een actie goedkeuren of verzenden (gecontroleerd per
  tool: `queue_action` schrijft `status='draft'`, alle andere tools roeren
  `goedgekeurd_door`/`goedgekeurd_op` niet aan).
- Verzoek zonder bearer-token → 401, geen tool-aanroep uitgevoerd.
- Verzoek met fout bearer-token → 401, body-vorm identiek aan het geval
  zonder token (constante tijd, geen informatielek).
- `search_people` en `get_profile` die de budgetmotor "weigering" of "wachtrij"
  teruggeven → NL-foutmelding richting skill met reden en vervolgstap.
- Fake-Unipile `429` tijdens `get_profile` → budgetmotor zet account in
  afkoeling, tool-respons bevat de NL-tekst, actie belandt in `events`.
- `queue_action` zonder goedkeuring in de payload → actie `draft`; met een
  `approved: true`-poging in de payload → 400 met NL-tekst (de MCP accepteert
  dat veld bewust niet).

**Omvang:**

- `src/mcp/server.ts` — hono-handler op `/mcp` die MCP-protocolberichten
  pareert, de token controleert en de tool-dispatcher aanroept.
- `src/mcp/tools.ts` — zeven tool-implementaties, pure functies die de
  bestaande helpers aanroepen (`src/register/`, `src/queue/`, `src/budget/`,
  `src/unipile/`).
- `src/mcp/schema.ts` — JSON-schema's per tool (invoer en uitvoer), zodat de
  skills tegen een duidelijk contract draaien.
- `.env.example` krijgt `MCP_TOKEN=`; `src/config/env.ts` valideert hem als
  verplicht.

Poort naar ronde 2: alle tests groen, inclusief de 401-paden en de drie
budget-foutpaden. Handmatige rooktest op Ruberts account **buiten de code**: één
`get_profile` op Rubert zelf via de MCP, met akkoord vooraf.

### Ronde 2 — Goedkeuringspagina (`src/admin/`) — afgerond 1 okt 2026

Doel: een kleine webpagina binnen dezelfde hono-server waarmee Rubert `draft`-
en `onzeker`-acties kan inzien, goedkeuren, afwijzen of opnieuw plannen. Geen
MCP-tool, geen publieke API.

**Harde grenzen (ingevuld):**

- Login verplicht; alleen Rubert. Wachtwoord-hash in env
  (`ADMIN_PASSWORD_HASH`, scrypt uit de standaard-library), sessie-cookie
  met HttpOnly + Secure + SameSite=Strict en 12 uur geldigheid.
- CSRF-token op elk formulier (per sessie, in constante tijd vergeleken).
- Brute-force-blokkade: 5 foute pogingen → 15 min blokkade per IP.
- `admin/dienst.ts` is de ENIGE plek in de code die
  `goedgekeurd_door = 'rubert'` zet; een invariant-test scant `src/` en
  slaat alarm bij elke andere plek die `keurActieGoed` aanroept of direct
  UPDATE's op `goedgekeurd_door` uitvoert.
- Correctie op ronde 1: `search_people`/`get_profile` kiezen hun pauze uit
  `config/limits.json` (`tijdvenster.pauze_mcp_sync_seconden`, profile
  30–90 s, search 2–8 min) op basis van de laatst uitgevoerde actie van dat
  type op dat account. Nog niet verstreken → NL-melding "probeer opnieuw
  over N seconden", géén Unipile-aanroep.

**Tests-first (groen):**

- Niet-ingelogde GET → redirect naar `/admin/login`.
- Verkeerd wachtwoord → 401 met "Onjuist wachtwoord", geen informatielek.
- CSRF-token ontbreekt → 403 op elke mutatie, inclusief login.
- Goedkeuren zet `status='approved'`, `goedgekeurd_door='rubert'`,
  `goedgekeurd_op=now()`; tekst-aanpassing vóór goedkeuren wordt
  gepersisteerd in `payload`.
- Batch-goedkeuren verwerkt een lijst actie-id's; foutieve id's komen in
  `overgeslagen` zonder de rest te blokkeren.
- Afwijzen zet `status='rejected'` met reden uit het formulier (verplicht,
  niet-leeg).
- Onzeker-acties: knoppen "was verstuurd → done" en "opnieuw goedkeuren".
- Brute-force: na 5 foute pogingen → 429 voor 15 min, ook met het juiste
  wachtwoord geweigerd tot de blokkade voorbij is.
- Invariant-scan over `src/` dwingt af dat alleen `admin/dienst.ts`
  `keurActieGoed` aanroept en dat alleen `queue/acties.ts` het veld
  `goedgekeurd_door` schrijft via SQL.

**Omvang (gerealiseerd):**

- `src/admin/server.ts` — hono-sub-app met `/admin/login`,
  `/admin/logout`, `/admin/` (overzicht) en de vijf POST-routes voor
  goedkeuren, batch-goedkeuren, afwijzen, onzeker-done en
  onzeker-opnieuw.
- `src/admin/views.ts` — server-rendered HTML, mobielvriendelijk via
  `viewport`-meta en responsieve CSS; geen client-side JavaScript.
- `src/admin/dienst.ts` — leest drafts/onzeker, past tekst aan, roept
  `keurActieGoed`/`zetActieStatus` aan.
- `src/admin/sessie.ts`, `src/admin/pogingen.ts`,
  `src/admin/wachtwoord.ts` — bouwstenen (in-memory sessies, brute-force-
  tracker, scrypt-hash + verify).
- `scripts/admin-hash.ts` — leest tweemaal een wachtwoord zonder echo en
  print de `ADMIN_PASSWORD_HASH`-regel. Aangeroepen via
  `npm run admin:hash`.
- `.env.example` krijgt `ADMIN_PASSWORD_HASH=`; `src/config/env.ts`
  valideert hem als verplicht.

Poort naar ronde 3: alle tests groen (350), typecheck schoon. Handmatige
rooktest door Rubert op een lokale draai met `npm run admin:hash` +
`.env` voordat ronde 3 begint.

### Ronde 3 — Sequenties (`src/sequences/`) — afgerond 1 okt 2026

Doel: eenvoudige sequentie verzoek → geaccepteerd → bericht → opvolging; stopt
bij een reactie (SPEC §2). Datamodel staat al (`sequences`-tabel uit migratie
`0001_init.sql`); kolommen voor leaddata, teksten en koppeling aan `actions`
staan in migratie `0002_sequences.sql` (nog niet uitgevoerd op Supabase).

**Harde grenzen:**

- Een sequentie plaatst zélf nooit een actie met status `approved`. Elke
  stap die een `invite`/`message`/`inmail` nodig heeft, komt als `draft` in de
  wachtrij — pas na goedkeuring via ronde 2 loopt hij door.
- Sequenties reageren op webhooks via de bestaande events-tabel: `new_relation`
  → één stap verder; `message_received` (`is_sender=false`) → status `reactie`
  en sequentie stopt.
- Ontdubbeling blijft bij de bestaande webhook-helpers; sequenties lezen
  alleen eigen state.

**Tests-first:**

- Start sequentie voor een lead: maakt rij in `sequences` met `stap=0`,
  `status='lopend'`, een eerste `draft`-invite in `actions`, geen approved.
- `new_relation` voor die lead → `stap=1`, nieuwe `draft`-message, geen
  approved. Als er geen openstaande sequentie is → sequentie wordt niet
  gestart (webhook blijft "voor onderzoek").
- `message_received` (reactie) → `status='reactie'`, geen nieuwe actie meer
  gegenereerd.
- Dubbele `new_relation` binnen tien minuten → één stap verder, niet twee
  (ontdubbeling via events-tabel).
- Sequentie waarvan het account `CREDENTIALS` krijgt → geen nieuwe acties
  tot het account weer `OK` of `RECONNECTED` is.

**Omvang (gerealiseerd):**

- `src/sequences/motor.ts` — pure stap-logica: `startSequentie`,
  `verwerkAcceptatie` (new_relation), `verwerkReactie` (message_received),
  `verwerkSequentieTick` (21-dagen-verval, stap 2, stap 3, afronden).
- `src/sequences/hooks.ts` — koppelt de motor aan de bestaande Unipile-
  webhook-flow (`verwerkUnipileWebhook` krijgt een optionele
  `SequentieHookDeps`).
- `src/sequences/wachttijd.ts` — werkdagen-kiezer (vast of random) en de
  `teltDoorWerkdagen`-helper die zaterdag/zondag overslaat in de tijdzone
  van het account.
- MCP-tool `start_sequence` (SPEC §7) accepteert lead + drie teksten en
  maakt alleen stap 1 (invite) als `draft`.
- `get_results` toont per sequentie stap, status en laatste gebeurtenis.
- Goedkeuringspagina toont bij elke concept-actie uit een sequentie
  "Stap N van 3 · sequentie gestart op …".
- `scripts/dev-demo.ts` bevat één lopende sequentie zodat Rubert hem lokaal
  op `/admin` ziet.
- Tests tegen PGlite + fake-Unipile; geen echte accounts (401 tests groen,
  typecheck schoon).

Poort naar ronde 4: alle tests groen, planner-tick kiest de volgende stap van
een sequentie correct per account, en Rubert heeft handmatig één sequentie
doorlopen op zijn eigen account via de goedkeuringspagina.

### Ronde 4 — Uitrol op Railway

Doel: de gateway live krijgen op Railway in de EU-regio zodat Ruberts
sequenties echt op zijn account draaien gedurende de drie-weken-proef (SPEC
§10). **Deze ronde start pas na expliciet akkoord van Rubert.**

**Harde grenzen:**

- Alleen Ruberts account draait live. Geen klantaccounts in deze fase.
- Database blijft Supabase (Frankfurt, `eu-central-1`). Geen tweede database.
- Secrets gaan in Railway's secret store; `.env` blijft lokaal. Geen secrets
  in de repo, geen secrets in logs (geldt al, hier bevestigd).
- Observability: minimaal gestructureerde logs plus de events-tabel. Geen
  nieuwe tooling tot er een concreet gemis is.

**Deel A — code klaar voor Railway (afgerond 1 okt 2026, nog niets uitgerold):**

- `npm start` (`src/main.ts`): één proces met de hono-server (`/health`,
  `/webhooks/*`, `/mcp`, `/admin/*`) en de planner-lus (`src/queue/lus.ts`).
  De lus draait alleen bij `PLANNER_ENABLED=true` (standaard uit), tickt op
  willekeurige momenten (`tijdvenster.pauze_tussen_acties_minuten`) en alleen
  binnen werkdagen/werktijd; per tick eerst de sequentie-tick, dan de planner.
  Bij een geweigerde gateway-sleutel stopt de lus tot een herstart.
- `GET /health`: altijd 200 met versie en `database.bereikbaar`; geen
  geheimen of accountgegevens.
- `NODE_ENV=production`: cookies `Secure`, client-IP uit Railway's
  proxy-headers (laatste `X-Forwarded-For`-item); poort uit `PORT`.
- Variabelencontrole bij het starten: één NL-foutregel per ontbrekende of
  ongeldige variabele, nooit waarden.
- JSON-logging (`src/log/logger.ts`) met afscherming op veldnaam én op
  bekende geheime waarden.
- Webhooks zijn nu gekoppeld aan de sequentie-motor (`sequentieHook`).
- Stappenplan voor Rubert: [docs/uitrol-railway.md](uitrol-railway.md).

**Checklist deel B (geen testdoelen; dit zijn uitrolstappen):**

- Railway-project aanmaken, regio EU West (Amsterdam, `europe-west4`),
  service gekoppeld aan de repo.
- Variabelen zetten: `UNIPILE_DSN`, `UNIPILE_API_KEY`, `WEBHOOK_SECRET`,
  `DATABASE_URL`, `MCP_TOKEN`, `ADMIN_PASSWORD_HASH`,
  `NODE_ENV=production`, `PLANNER_ENABLED=false`, optioneel
  `TIMEZONE_DEFAULT`, `LOG_LEVEL`, `PUBLIC_BASE_URL`. (Een apart
  sessie-geheim is niet nodig: sessies staan in het geheugen.)
- Migratie `0002_sequences.sql` op Supabase, na akkoord.
- Startcommando: `npm start`.
- Domein instellen (bijv. `gateway.markaas.nl`), DNS via Railway.
- Supabase-netwerkregel: alleen Railway-egress-IP's toelaten als
  Supabase dat ondersteunt zonder stabiel-IP-abonnement; anders
  SSL-only + sterke `DATABASE_URL` als enige poort.
- Unipile-webhook-URL's omzetten van ontwikkel- naar productie-endpoint.
- Eén handmatige rooktest per endpoint (webhook, MCP, goedkeuringspagina),
  door Rubert, voordat sequenties worden geactiveerd.

Poort naar fase 4 (SPEC §10): drie weken op halve normen zonder waarschuwing
van LinkedIn of Unipile — pas dan gaan de eerste klantaccounts over
(IPknowledge, Aqua, ICT Media, TAG).

## Beslissingen vastgelegd

- MCP-tools goedkeuren of versturen niet. Goedkeuring loopt uitsluitend via de
  goedkeuringspagina (SPEC §7, §12).
- Hosting: Railway, EU-regio (SPEC §13).
- Uitrol is een aparte ronde met akkoord vooraf (ronde 4).

## Open punten

- Exacte Railway-regio: `europe-west4` of `europe-west1`. Keuze bij ronde 4.
- Observability-niveau in productie: minimaal nu, uitbreiden op signaal.
- Pipedrive-koppeling: valt buiten fase 3; eerste prototype pas als sequenties
  stabiel lopen.
