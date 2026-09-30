# Fase 2 — Kern bouwen (plan)

Versie 0.1 · 30 september 2026 · eigenaar: Rubert Rietkerk.

Doel van fase 2 (SPEC §10): register, koppelflow, webhooks, budgetmotor en wachtrij
staan; alle tests (inclusief 429 en `CREDENTIALS`) draaien groen tegen `test/fake-unipile/`.
Nog geen MCP-server, geen sequenties, geen echte Unipile-aanroepen buiten fase 1.

Poort naar fase 3: `pnpm test` (of `npm test`) groen op een schone checkout, migratie
`0001_init.sql` schoon uitvoerbaar tegen een lege Postgres, en de fake-Unipile dekt de
foutpaden 429, `CREDENTIALS` en time-out per actietype.

## 1. Projectopzet

**Runtime en taal**
- Node 20 LTS, TypeScript strict, ES modules (`"type": "module"` in `package.json`,
  `"module": "NodeNext"` en `"moduleResolution": "NodeNext"` in `tsconfig.json`).
- `tsconfig.json`: `strict: true`, `noUncheckedIndexedAccess: true`,
  `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `target: "ES2022"`.
- Packagemanager: **pnpm** (snel, lock deterministisch). Fallback naar `npm` mag; scripts
  blijven identiek.

**Structuur**

```
src/
  config/         env-lezing en limits.json laden
  db/             Postgres-client, query-helpers, transacties
  unipile/        enige route naar Unipile (client, typen, retry, fouten)
  register/       clients, accounts, koppelflow (hosted auth)
  webhooks/       HTTP-endpoint + parsers per source
  budget/         zes controles uit SPEC §5
  queue/          wachtrij, planner, worker
  errors.ts       gedeelde foutklassen met NL-boodschappen
  logger.ts       gestructureerde logs; nooit .env-inhoud, nooit berichttekst
db/
  migrations/     platte SQL, 0001_init.sql eerst
test/
  fake-unipile/   nagebootste Unipile-server (HTTP) + scenario-helpers
  fixtures/       voorbeeld-payloads uit docs/unipile-notities.md
  ...             tests naast elke module (queue.test.ts, budget.test.ts, …)
config/
  limits.json     werknormen (deze fase aangemaakt)
```

**Testframework**
- Ingebouwde **`node:test`** met `tsx` als loader (`node --import tsx --test`). Reden:
  past bij "geen frameworks die we niet nodig hebben" (CLAUDE.md), geen extra afhankelijkheid,
  parallelisme en `--watch` zitten erin.
- Assertions via `node:assert/strict`.
- Elke module heeft een `*.test.ts` in dezelfde map (colocated).

**Database en migraties**
- Productie/ontwikkeling: **Supabase, Frankfurt (`eu-central-1`)**, project-ref
  `uujvmoqsalpgshptiljy`. Postgres 15+, EU-regio, PITR beschikbaar.
- Client: `postgres` (Porsager) — kleine footprint, template-strings, transacties met
  `sql.begin()`. Geen ORM.
- Migraties: platte SQL-bestanden in `db/migrations/NNNN_naam.sql`, uitgevoerd door een
  eigen `scripts/migrate.ts` (10 regels: lijst bestanden, run in transactie, log naam).
  Compatibel met `supabase/migrations/` als we later Supabase-CLI willen gebruiken.
  **Migraties op Supabase pas uitvoeren na expliciet akkoord van Rubert per migratie.**
- Verbindingsstring uit `DATABASE_URL`; tests draaien tegen **PGlite**
  (`@electric-sql/pglite`) — een in-process Postgres, geen Docker en geen lokale server
  nodig. `src/db/` accepteert zowel `postgres`-client als PGlite via een dun `Sql`-adapter.
  Nooit tegen productie testen.

**Omgevingsvariabelen**
- Één `src/config/env.ts` module leest `process.env` en valideert (handmatig schema, geen
  zod als het niet nodig is). Verplicht: `UNIPILE_DSN`, `UNIPILE_API_KEY`, `WEBHOOK_SECRET`,
  `DATABASE_URL`. Ontbrekende sleutels → NL-foutmelding met naam van variabele; **waarde
  wordt nooit gelogd**.
- `.env.example` uitbreiden met `NODE_ENV`, `PORT`, `LOG_LEVEL`, `TIMEZONE_DEFAULT`
  (`Europe/Amsterdam`).

**HTTP-server (voor webhooks en later MCP)**
- **`hono`** — klein, typesafe, één afhankelijkheid. Draait op Node's `serve` uit
  `@hono/node-server`.

**Overige gereedschappen**
- Formatter: `prettier` (config in repo). Linter: `eslint` met `@typescript-eslint`.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` als scripts.
- CI: nog niet in scope; lokaal groen is de poort.

## 2. Databaseschema — migratie `0001_init.sql`

Vertaling van SPEC §4 naar Postgres. Alle timestamps in UTC (`timestamptz`). Enums als
Postgres-`enum` voor betere leesbaarheid en indexeerbaarheid. Zachte verwijdering niet
in v1 (klein, we kunnen rijen bewaren of hard verwijderen op verzoek).

```sql
-- 0001_init.sql — MARKaaS LinkedIn-gateway, initieel schema.

create extension if not exists "pgcrypto";  -- gen_random_uuid()

create type account_subscription as enum (
  'free', 'premium_career', 'premium_business', 'salesnav_core', 'salesnav_advanced'
);

create type account_status as enum (
  'OK', 'CONNECTING', 'CREDENTIALS', 'ERROR', 'STOPPED', 'RECONNECTED'
);

create type action_type as enum (
  'search', 'profile', 'invite', 'message', 'inmail'
);

create type action_status as enum (
  'draft', 'approved', 'queued', 'running', 'done', 'failed', 'rejected'
);

create type event_source as enum ('unipile', 'gateway');

create table clients (
  id           uuid primary key default gen_random_uuid(),
  naam         text not null,
  slug         text not null unique,
  actief       boolean not null default true,
  aangemaakt_op timestamptz not null default now()
);

create table accounts (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete restrict,
  eigenaar_naam       text not null,
  unipile_account_id  text unique,               -- null zolang koppeling niet klaar is
  abonnement          account_subscription not null,
  status              account_status not null default 'CONNECTING',
  status_sinds        timestamptz not null default now(),
  opbouw_factor       numeric(3,2) not null default 0.50
                       check (opbouw_factor >= 0.50 and opbouw_factor <= 1.00),
  afkoeling_tot       timestamptz,
  tijdzone            text not null default 'Europe/Amsterdam',
  aangemaakt_op       timestamptz not null default now()
);

create index accounts_client_idx on accounts(client_id);
create index accounts_status_idx on accounts(status);

create table actions (
  id               uuid primary key default gen_random_uuid(),
  account_id       uuid not null references accounts(id) on delete restrict,
  type             action_type not null,
  payload          jsonb not null,
  status           action_status not null default 'draft',
  reden            text,                            -- reden bij failed/rejected/queued
  goedgekeurd_door text,                            -- e-mail / naam
  goedgekeurd_op   timestamptz,
  gepland_op       timestamptz,
  uitgevoerd_op    timestamptz,
  unipile_response jsonb,
  aangemaakt_op    timestamptz not null default now()
);

create index actions_planning_idx on actions(status, gepland_op);
create index actions_account_type_idx on actions(account_id, type);

create table usage (
  account_id  uuid not null references accounts(id) on delete cascade,
  type        action_type not null,
  dag         date not null,                        -- lokale dag in tijdzone account
  aantal      integer not null default 0 check (aantal >= 0),
  primary key (account_id, type, dag)
);

create type sequence_status as enum (
  'lopend', 'geaccepteerd', 'reactie', 'gestopt', 'mislukt'
);

create table sequences (
  id                 uuid primary key default gen_random_uuid(),
  account_id         uuid not null references accounts(id) on delete restrict,
  lead_linkedin_url  text not null,
  lead_provider_id   text,                          -- Unipile-provider-id, indien bekend
  stap               integer not null default 0,
  status             sequence_status not null default 'lopend',
  volgende_actie_op  timestamptz,
  laatste_gebeurtenis jsonb,
  aangemaakt_op      timestamptz not null default now()
);

create index sequences_planning_idx on sequences(status, volgende_actie_op);
create unique index sequences_account_lead_idx on sequences(account_id, lead_linkedin_url);

create table events (
  id           uuid primary key default gen_random_uuid(),
  bron         event_source not null,
  type         text not null,
  account_id   uuid references accounts(id) on delete set null,
  payload      jsonb not null,
  ontvangen_op timestamptz not null default now()
);

create index events_account_idx on events(account_id, ontvangen_op desc);
create index events_type_idx on events(type, ontvangen_op desc);
```

Aandachtspunten:

- `usage.dag` is een **lokale** dag (tijdzone van het account) om SPEC §5 controle 3
  (dagbudget) intuïtief te houden bij zomer-/wintertijd.
- `sequences_account_lead_idx` voorkomt dubbele sequenties voor dezelfde lead per account
  (SPEC §2: eenvoudige sequenties, geen dubbelloop).
- `events` slaat webhooks integraal op voor ontdubbeling (`new_relation` vs. eerste
  bericht met `is_sender: true` — zie docs/unipile-notities.md).
- Geen kolommen voor `contact_info` of `birthdate` in `accounts` of elders: SPEC §9 zegt
  standaard wegfilteren vóór opslag.

Toekomstige migraties (buiten deze fase): sequenties-verrijking, klantvoorkeuren, indexen
op basis van gebruikspatroon.

## 3. Test-eerst per onderdeel (SPEC §10-volgorde)

Elk onderdeel: tests schrijven en rood zien vóór de implementatie. Fake-Unipile dekt 200,
422-varianten, 429 met `Retry-After`, en time-out (vertraagd antwoord). Alle NL-teksten
in foutmeldingen worden op woord getest — foutieve tekst = foutieve test.

### 3.1 Register en koppelflow (`src/register/`)

**Fake-Unipile-endpoints**: `POST /api/v1/hosted/accounts/link`,
`GET /api/v1/accounts`, callback simulatie (webhook payload injecteren).

Tests:

- `clients.create` en `clients.getBySlug` — uniek op `slug`, actief-flag standaard true.
- `accounts.registreer` — koppelt aan client, `status=CONNECTING`, `opbouw_factor=0.50`,
  nog geen `unipile_account_id`.
- `koppellink.maak(type: 'create')` — bouwt correcte body: `providers: ['LINKEDIN']`,
  `expiresOn` in UTC met ms, `disabled_options: ['cookie_auth']`, `single_use: true`,
  `notify_url` uit config, `name` = interne account-id. Antwoord bevat `url`.
- `koppellink.maak(type: 'reconnect')` — vereist bestaand `unipile_account_id`; verstuurt
  `reconnect_account`, geen `providers`.
- `callback.verwerk('CREATION_SUCCESS')` — vult `unipile_account_id`, zet `status=OK`,
  `opbouw_factor=0.5`, logregel zonder token.
- `callback.verwerk('RECONNECTED')` — status weer `OK`, `afkoeling_tot=null`, wachtende
  acties uit `queued` naar `approved` (voor zover budget toelaat).

Foutpaden:

- **429** bij `hosted/link`: client eerbiedigt `Retry-After` (max 1 retry), daarna
  `LinkTijdelijkNietBeschikbaar` met NL-tekst en zonder link in de database.
- **`CREDENTIALS`** callback: alle lopende `queued`/`running` acties voor dat account op
  `queued` met `reden = 'Sessie verlopen; opnieuw koppelen vereist.'`, reconnect-link
  automatisch aangemaakt, mail-hook aangeroepen (mock).
- **Time-out** (`AbortSignal` na 10s): geen link opgeslagen, NL-melding
  `'Unipile reageerde niet binnen 10 seconden — probeer het over een minuut opnieuw.'`

### 3.2 Webhooks (`src/webhooks/`)

Endpoint: `POST /webhooks/unipile`. Verplicht: header met `WEBHOOK_SECRET` (constant-time
vergelijking). Body-parser per `source`.

Tests:

- **Handtekening**: correcte header → 200; ontbrekende/verkeerde header → 401 met NL-body,
  niets naar `events`.
- `account_status` events:
  - `OK` → `accounts.status = 'OK'`, `status_sinds = now()`.
  - `CREDENTIALS` → status bijgewerkt, lopende acties gepauzeerd (koppelflow-hook).
  - `RECONNECTED` → status OK, `afkoeling_tot` gewist, wachtende acties herstart.
  - Onbekende status → 200, event opgeslagen, geen crash.
- `users.new_relation` — sequentie (indien aanwezig) stap-verder; als geen sequentie,
  event loggen en klaar.
- `messaging.message_received`:
  - Filtert `is_sender: true` uit als *reactie*, maar herkent het als **acceptatiesignaal**
    wanneer het het eerste bericht in een nieuw gesprek is (docs/unipile-notities.md).
  - `is_sender: false` → sequentie op `reactie`, hook naar Pipedrive (mock).
- **Ontdubbeling**: `new_relation` + eerste eigen bericht binnen 10 minuten → één
  overgang, niet twee.
- `event_type: null` → geen crash, event opgeslagen met type `unknown`.
- Onbekend `source` → 200, event opgeslagen als bron `unipile`, type = ruwe eventnaam.

Foutpaden:

- **429** komt in de praktijk niet als *inkomend* voor (webhooks worden gestuurd); wel
  testen dat wij bij downstream 429 (Pipedrive-hook) niet crashen en het event bewaren.
- **Time-out** naar downstream: webhook antwoordt **direct 200** naar Unipile, event
  achtergrondafhandeling met retry. (Anders levert Unipile opnieuw.)
- **Body corrupt / niet-JSON** → 400 met NL-tekst, geen opslag.

### 3.3 Budgetmotor (`src/budget/`)

Puur functioneel waar mogelijk: `beoordeel(account, actie, nu, gebruikVandaag, gebruikWeek)`
→ `{status: 'toegestaan' | 'wachtrij' | 'weigering', reden?}`. Waarden komen uit
`config/limits.json`, niet uit code.

Tests voor de zes controles (SPEC §5), in de opgegeven volgorde:

1. **Account gezond** — `OK` slaagt; `CREDENTIALS`/`ERROR`/`STOPPED` → weigering met
   NL-reden per status. `CONNECTING` → wachtrij (tijdelijk).
2. **Goedgekeurd** — `invite`/`message`/`inmail` zonder `goedgekeurd_door` → weigering;
   `search`/`profile` slaan deze controle over.
3. **Dagbudget** — op de grens (gebruik = norm × opbouw_factor) → wachtrij; onder de grens
   → door; norm × 0.5 opbouw op nieuw account → helft van tabel.
4. **Weekbudget** — schuivend 7-daags venster; test op dagovergang, en op zaterdag/zondag
   waar geen nieuw verbruik bijkomt.
5. **Tijdvenster** — 08:29 (te vroeg) en 17:31 (te laat) in Europe/Amsterdam → wachtrij;
   binnen 2 minuten na vorige actie → wachtrij (test met vast seed voor de willekeur).
   Zomer-/wintertijd-omschakeling: 25 en 26 oktober test.
6. **Afkoeling** — na 429: `afkoeling_tot = now + 48u`, `opbouw_factor = 0.5` voor 7 dagen
   na afkoeling. Tijdens afkoeling: alle acties → wachtrij met reden.

Extra:

- **Opbouw**: tests voor +0.2 per week als 7-daagse acceptatie ≥ 30%, cap op 1.00,
  reset op 0.5 na 429/captcha/waarschuwing.
- **`usage` ≥ 75% in Unipile-antwoord**: budgetmotor leest `usage` uit response van
  `/users/invite`, past `opbouw_factor` automatisch omlaag (docs/unipile-notities.md).

Foutpaden:

- **429** in respons → afkoelingsflag gezet, actie op `queued` met reden
  `'LinkedIn vroeg te snel om pauze; account 48 uur op stop.'`
- **`CREDENTIALS`** ontdekt tijdens budgetcheck → weigering; koppelflow-hook.
- **Time-out** naar Unipile → actie op `queued` met reden
  `'Unipile onbereikbaar; automatisch opnieuw geprobeerd over 5 minuten.'`, geen
  usage-telling verhoogd.

### 3.4 Wachtrij (`src/queue/`)

Twee onderdelen: **planner** (kiest volgende actie per account uit `approved`) en
**worker** (voert uit via `src/unipile/`). Draait als in-process interval; geen aparte
queue-server in v1.

Tests planner:

- Kiest oudste `approved` actie per account, respecteert `gepland_op`.
- Roept budgetmotor aan; bij `wachtrij` → status blijft `queued` met reden, `gepland_op`
  op eerstvolgende moment binnen tijdvenster.
- Bij `weigering` → `rejected` met reden; geen retry.
- Twee planners tegelijk (concurrency-test met `SELECT … FOR UPDATE SKIP LOCKED`) pakken
  niet dezelfde actie.

Tests worker:

- `search`/`profile` — geen goedkeuring nodig, direct uitvoeren, `done` met
  `unipile_response`, `usage` bijwerken.
- `invite`/`message`/`inmail` — alleen als `goedgekeurd_door` gezet is; anders `failed`
  met interne fout ("Actie zonder goedkeuring in wachtrij — programmeerfout.").
- `queue_action` maakt standaard `draft`; expliciete `goedkeur` zet naar `approved`.

Foutpaden:

- Fake-Unipile geeft **429** met `Retry-After: 60` → actie terug naar `queued`,
  afkoelingsflag gezet, budget-consequentie via §3.3.
- Fake-Unipile geeft **422** met `already_invited_recently` → actie `failed` (permanent),
  reden in NL, geen retry.
- Fake-Unipile geeft **422** met `limit_exceeded` → actie `queued`, account in afkoeling.
- Fake-Unipile **time-out** (>10s) → actie op `queued` + 5 min, geen dubbele verzending
  (idempotency-sleutel per actie-id, in-memory dedup binnen worker-run).
- **CREDENTIALS** komt binnen via webhook tijdens `running` → worker herkent bij volgende
  poll, zet actie terug naar `queued`, koppelflow-hook.

## 4. Fake-Unipile (`test/fake-unipile/`)

- HTTP-server op willekeurige poort (`node:http`, één bestand). Basis-URL wordt door de
  test in de Unipile-client geïnjecteerd; productie gebruikt `UNIPILE_DSN`.
- Scenario-helpers: `metStatus(429, {retryAfter: 60})`, `metVertraging(15_000)`,
  `metJson(200, payload)`, `sequence([...])` voor meerstaps.
- Vaste fixtures voor: `AccountList`, `UserInvitationSent`, `MessageSent`, `ChatStarted`,
  `HostedAuthUrl`, callback-payloads. Overgenomen uit docs/unipile-notities.md,
  geanonimiseerd.
- Tellingen per endpoint zodat tests kunnen vaststellen dat er geen dubbele call gebeurt.

Tests raken **nooit** de echte DSN. In `src/unipile/client.ts` wordt `baseUrl` verplicht;
tests injecteren de fake, dev/prod injecteren `UNIPILE_DSN` via env.

## 5. Volgorde van werk en poorten

1. Projectopzet + `0001_init.sql` — poort: `pnpm test` draait (leeg), migratie schoon op
   een verse PGlite-instantie in een test.
2. `src/config` + `src/db` + `src/unipile` (skeleton met fake) — poort: unit tests voor
   env-lezing en Unipile-client-retry groen.
3. Register en koppelflow — poort: alle §3.1-tests groen.
4. Webhooks — poort: alle §3.2-tests groen, inclusief ontdubbeling.
5. Budgetmotor — poort: alle §3.3-tests groen, inclusief zomer-/wintertijd en 429.
6. Wachtrij — poort: alle §3.4-tests groen; end-to-end-test die een `invite` uit `draft`
   → `approved` → `queued` → `done` brengt via fake-Unipile.

Daarna: overgang naar fase 3 (MCP-server + sequenties). Dat valt **buiten** deze fase.

## 6. Beslissingen en open punten (uit SPEC §11)

Vastgesteld bij akkoord op dit plan (30 sep 2026):

- **Database**: Supabase, Frankfurt (`eu-central-1`), project-ref `uujvmoqsalpgshptiljy`.
  Migraties alleen na expliciet akkoord per migratie uitvoeren.
- **Tests**: PGlite (`@electric-sql/pglite`); geen Docker, geen lokale Postgres nodig.
- **HTTP-server**: `hono` met `@hono/node-server`.
- **Testframework**: `node:test` + `tsx`.
- **`salesnav_advanced`**: gelijk aan `salesnav_core` totdat aparte werknormen bekend zijn.

Nog open:

- **Hosting**: Railway of Fly.io — beslissing pas nodig bij deployment (fase 3).
- **API-versie**: v1 blijft basis in fase 2; v2-migratie apart traject.

Volgorde na akkoord: `package.json` + `tsconfig` + scripts → `src/config/env.ts` +
`db/migrations/0001_init.sql` + PGlite-testhelper → `test/fake-unipile/`-skeleton →
tests-first per onderdeel in de volgorde van §5.
