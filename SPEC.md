# SPEC — MARKaaS LinkedIn-gateway

Versie 0.1 · 30 september 2026 · eigenaar: Rubert Rietkerk (MARKaaS)

## 1. Doel

Een kleine dienst tussen de Claude-skills van MARKaaS en de Unipile-API. Unipile levert de
verbinding met LinkedIn. De gateway voegt toe wat MARKaaS als product onderscheidt:

- elke LinkedIn-actie wordt vooraf getoetst aan een budget per account en per actie;
- niets wordt verzonden zonder goedkeuring van een mens;
- per klant is zichtbaar welke accounts gekoppeld zijn en of hun sessie werkt;
- reacties en geaccepteerde verzoeken komen terug in Pipedrive.

## 2. Afbakening

**Wel (v1)**

- 10–25 klanten, gemiddeld 2 LinkedIn-accounts per klant.
- Alleen MARKaaS bedient het systeem. Klanten koppelen alleen hun LinkedIn-account via een link.
- Acties: zoeken (LinkedIn en Sales Navigator), profiel ophalen, connectieverzoek, bericht aan
  connectie, InMail.
- Eenvoudige sequenties: verzoek → geaccepteerd → bericht → opvolging; stopt bij een reactie.

**Niet (v1)**

- Klantportaal met eigen login, facturatie, zelfbediening.
- E-mail, WhatsApp of andere kanalen van Unipile.
- Posts plaatsen, liken of reageren namens klanten.
- Engagement-scraping (likers/commenters van posts) — blijft voorlopig in Phantombuster.

## 3. Architectuur

```
Claude-skills ──(MCP)──▶ ┌──────────── gateway ────────────┐
Rubert (goedkeuring) ──▶ │ accountregister · budgetmotor    │
                         │ wachtrij/planner · sequenties    │
                         │ webhooks · MCP-server            │
                         └───────────────┬─────────────────┘
                                         │ enige route
                                         ▼
                                   Unipile-API  ◀── webhooks
                                         │
                                 LinkedIn-accounts
```

Eén TypeScript-project (Node 20+), één database (Postgres, EU-regio). Geen microservices.

## 4. Datamodel (eerste opzet)

| Tabel | Belangrijkste velden |
| --- | --- |
| `clients` | id, naam, slug, actief |
| `accounts` | id, client_id, eigenaar_naam, unipile_account_id, abonnement (`free`, `premium_career`, `premium_business`, `salesnav_core`, `salesnav_advanced`), status (Unipile-status), status_sinds, opbouw_factor (0.5–1.0), afkoeling_tot, tijdzone |
| `actions` | id, account_id, type (`search`, `profile`, `invite`, `message`, `inmail`), payload (json), status (`draft`, `approved`, `queued`, `running`, `done`, `failed`, `rejected`), reden, goedgekeurd_door, gepland_op, uitgevoerd_op, unipile_response |
| `usage` | account_id, type, dag, aantal |
| `sequences` | id, account_id, lead_linkedin_url, stap, status, volgende_actie_op, laatste_gebeurtenis |
| `events` | id, bron (`unipile`, `gateway`), type, account_id, payload, ontvangen_op |

## 5. Budgetmotor

Elke actie passeert zes controles, in deze volgorde. Faalt er één, dan blijft de actie in de
wachtrij (tijdelijk) of wordt ze geweigerd met reden (structureel).

1. **Account gezond** — status `OK`. Bij `CREDENTIALS`, `ERROR`, `STOPPED` stopt alles.
2. **Goedgekeurd** — `invite`, `message`, `inmail` vereisen `goedgekeurd_door`. `search` en
   `profile` niet.
3. **Dagbudget** — verbruik vandaag + deze actie ≤ dagnorm × opbouw_factor.
4. **Weekbudget** — schuivend over 7 dagen, ≤ weeknorm × opbouw_factor.
5. **Tijdvenster** — werkdag, 08:30–17:30 in de tijdzone van het account; 2–8 minuten
   willekeurig tussen twee acties op hetzelfde account.
6. **Afkoeling** — na HTTP 429, captcha of waarschuwing: 48 uur pauze, daarna 7 dagen
   opbouw_factor 0.5.

Normen: zie `docs/limieten.md`. Normen staan in configuratie, niet in code.

**Opbouw:** nieuw of stil account start op 0.5; elke week +0.2 zolang acceptatie van
verzoeken ≥ 30%; maximaal 1.0.

## 6. Koppelen van accounts

1. Rubert maakt via de MCP-tool of CLI een koppellink: Unipile hosted auth, `type: create`,
   `name` = interne account-id, `notify_url` = gateway-webhook.
2. De link gaat per mail naar de accounteigenaar (links verlopen snel; niet in een iframe).
3. Callback `CREATION_SUCCESS` → `unipile_account_id` opslaan, opbouw_factor 0.5.
4. Status `CREDENTIALS` → account op pauze, nieuwe link met `type: reconnect`, mail naar Rubert
   en eigenaar. Bij `RECONNECTED` lopen wachtende acties door.

## 7. MCP-tools voor skills

| Tool | Doet | Budget |
| --- | --- | --- |
| `list_accounts` | Accounts per klant met status, abonnement, opbouw | nee |
| `account_health` | Sessiestatus, laatste fout, afkoeling | nee |
| `get_budget` | Resterend budget per actie, vandaag en deze week | nee |
| `search_people` | LinkedIn- of Sales Navigator-zoekopdracht | ja |
| `get_profile` | Eén profiel | ja |
| `queue_action` | Verzoek, bericht of InMail als **concept** (status `draft`) | ja, bij uitvoering |
| `start_sequence` | Start een sequentie voor één lead; maakt alleen het **concept** voor stap 1 (invite) | ja, bij uitvoering |
| `get_results` | Status van acties, acceptaties, reacties, en lopende sequenties | nee |

Er is **geen** tool die direct verstuurt of een vrije API-aanroep doet. Er is ook **geen**
MCP-tool die een actie kan goedkeuren, afwijzen of op `approved` zetten; `queue_action`
en `start_sequence` plaatsen hun acties uitsluitend als `draft` in de wachtrij.
Goedkeuring loopt uitsluitend via de goedkeuringspagina van de gateway (zie §12).

De MCP-server luistert via Streamable HTTP op `/mcp` binnen de bestaande HTTP-server en is
beveiligd met een bearer-token (`MCP_TOKEN` uit `.env`, in constante tijd vergeleken,
nooit gelogd). Verzoeken zonder of met een fout token krijgen HTTP 401.

**Pauze per actietype voor synchrone MCP-tools.** `search_people` en `get_profile`
worden direct door de MCP afgehandeld; om LinkedIn niet te overbelasten geldt een
willekeurige pauze op basis van de laatst **uitgevoerde** actie van hetzelfde type
op hetzelfde account. Grenzen staan in `config/limits.json`
(`tijdvenster.pauze_mcp_sync_seconden`): `profile` 30–90 s, `search` 2–8 min.
Is de pauze nog niet verstreken, dan antwoordt de tool met een NL-melding
"probeer opnieuw over N seconden" en wordt géén actie aangemaakt en géén
Unipile-aanroep gedaan.

## 12. Goedkeuring en bediening

Goedkeuren, afwijzen en opnieuw plannen van `invite`-, `message`- en `inmail`-acties
gebeurt uitsluitend via de **goedkeuringspagina van de gateway** zelf. Deze pagina:

- is onderdeel van dezelfde HTTP-server als de webhooks en de MCP-server;
- heeft een eigen login (alleen Rubert) en is niet via de MCP bereikbaar;
- schrijft rechtstreeks in de `actions`-tabel (`status = 'approved'`, `goedgekeurd_door`
  en `goedgekeurd_op`) via de bestaande helpers in `src/queue/acties.ts`.

Skills zien goedgekeurde acties alleen terug via `get_results`; ze kunnen zelf niets
goedkeuren of versturen.

## 13. Hosting

De gateway draait op **Railway** in de EU-regio (bij voorkeur `europe-west4`), zodat alle
verwerking van zakelijke profieldata binnen de EU blijft (SPEC §9). De uitrol — eerste
deploy, DNS, secrets instellen in Railway — is een **aparte stap** die pas start na
expliciet akkoord van Rubert en wordt uitgevoerd in ronde 4 van fase 3 (zie
`docs/fase-3-plan.md`).

## 8. Webhooks van Unipile

- Accountstatus → `accounts.status` bijwerken, pauze/hervatten.
- Nieuwe relatie (verzoek geaccepteerd) → sequentie een stap verder.
- Nieuw bericht → sequentie stoppen, notitie in Pipedrive.

Geen polling op vaste tijden; waar polling nodig is: enkele keren per dag op willekeurige
momenten.

## 8a. Sequenties

Een sequentie is één drie-staps-traject per lead per account: **verzoek → eerste bericht
→ opvolging**. Elke stap verschijnt als `draft` op de goedkeuringspagina; verzenden
gebeurt pas na menselijke goedkeuring (SPEC §12). De gateway stuurt zelf niets uit en
keurt zelf niets goed — alle harde regels uit CLAUDE.md gelden onverkort.

### 8a.1 Stappen en wachttijden

| Stap | Wat | Trigger / wachttijd |
| --- | --- | --- |
| 1 (invite) | `draft`-invite, met of zonder notitie | Meteen bij `start_sequence` |
| 2 (eerste bericht) | `draft`-message in de bestaande chat | 1–3 werkdagen na `new_relation`, willekeurig |
| 3 (opvolging) | `draft`-message, kortere herinnering | 5–7 werkdagen nadat stap 2 is verstuurd en zonder reactie, willekeurig |

Wachttijden staan in `config/limits.json` (`sequenties.wachttijden_werkdagen`); niet
hardcoderen. "Werkdagen" wordt bepaald in de tijdzone van het account (zelfde regels
als §5 controle 5). Willekeurige keuze is uniform binnen de bandbreedte, met één
`SeqPauzeKiezer` die in tests vervangen wordt door een vaste waarde.

### 8a.2 Status en stoppen

Status-enum (`sequence_status`, zie §4):

- `lopend` — invite is `draft`/`queued`/`approved`, nog geen `new_relation` ontvangen.
- `geaccepteerd` — `new_relation` ontvangen; wacht op (of heeft al) een `draft`-message
  voor stap 2 of 3.
- `reactie` — lead stuurde een bericht (`message_received`, `is_sender=false`); sequentie
  stopt en openstaande `draft`/`queued`-stappen worden `rejected` met reden
  "lead heeft gereageerd".
- `gestopt` — eindigt zonder reactie. Redenen vastgelegd in `sequences.stop_reden`:
  "verzoek niet geaccepteerd" (na 21 dagen zonder `new_relation`) of "sequentie
  voltooid" (opvolging is verstuurd).
- `mislukt` — gereserveerd voor onvoorziene fouten; nog niet actief gebruikt.

### 8a.3 Pauze versus stoppen

De sequentie **stopt** alleen bij een reactie of bij 21 dagen zonder acceptatie. Alle
andere obstakels zijn **pauzes** die vanzelf voorbijgaan:

- Account `CREDENTIALS`, `ERROR`, `STOPPED` of in afkoeling → de tick maakt geen
  nieuwe `draft`-stap zolang de account niet weer `OK`/`RECONNECTED` is. Status
  blijft wat hij was; wachttijden lopen door (geen inhaalslag).
- Dubbele `new_relation` of dubbel `message_received` binnen tien minuten → de
  bestaande events-dedup (uniek `extern_id`) telt het slechts één keer; de
  sequentie-overgang gebeurt dus ook één keer.

Verzoek intrekken is **niet** onderdeel van v1; na 21 dagen zonder acceptatie wordt
de sequentie `gestopt` zonder een intrekactie te plannen.

### 8a.4 Sequentie-tick

Eén idempotente tick (`verwerkSequentieTick`) kiest per lopende sequentie welke
volgende `draft` aan de beurt is. Bij elke tick-run:

1. **21-dagen-stop** — sequenties met `status='lopend'` en `aangemaakt_op <= nu - 21d`
   worden `gestopt` (`stop_reden = 'verzoek niet geaccepteerd'`).
2. **Stap 2** — sequenties met `status='geaccepteerd'`, `stap = 1`, geen stap-2-actie
   en `volgende_actie_op <= nu` → maak `draft`-message aan, zet `stap = 2`, bereken
   `volgende_actie_op` voor stap 3 (op basis van `uitgevoerd_op`, maar bij ontbreken
   terugvallend op "nu" zodat de tick zelfhelend is).
3. **Stap 3** — sequenties met `stap = 2`, geen stap-3-actie, stap-2-actie is `done`,
   `volgende_actie_op <= nu` → maak `draft`-opvolging aan, zet `stap = 3`.
4. **Afronden** — sequenties met `stap = 3` waarvan de opvolging `done` is → status
   `gestopt`, `stop_reden = 'sequentie voltooid'`.

Account-pauze wordt per sequentie gecontroleerd (status moet `OK` of `RECONNECTED`
zijn en `afkoeling_tot` moet voorbij zijn). De tick staat los van de bestaande
`voerPlannerTickUit`; de planner behandelt de `approved` acties die uit de
goedkeuringspagina rollen.

### 8a.5 Koppeling met de goedkeuringspagina

De `actions`-tabel krijgt in migratie `0002` twee velden: `sequence_id` (uuid) en
`sequence_stap` (integer 1–3). De goedkeuringspagina toont bij elk concept met een
`sequence_id` de regel "Stap N van 3 · sequentie gestart op …" zodat Rubert ziet uit
welke sequentie het verzoek komt zonder in de database te duiken.

## 9. Niet-functionele eisen

- Alle Unipile-aanroepen in één module (`src/unipile/`), zodat de leverancier vervangbaar is.
- Geen LinkedIn-cookies opslaan; Unipile beheert sessies.
- Geheimen alleen in omgevingsvariabelen, nooit in de repo.
- Database in de EU; alleen zakelijke profieldata; bewaartermijn configureerbaar.
  Velden `contact_info` en `birthdate` uit profielen worden standaard weggefilterd vóór opslag;
  alleen opslaan als de klant daar een grondslag voor heeft en het expliciet aanzet.
- Foutmeldingen richting skills in het Nederlands, met oorzaak en vervolgstap.
- Elke module heeft tests; Unipile wordt in tests nagebootst (`test/fake-unipile/`).

## 10. Fasen en poorten

| Fase | Inhoud | Poort naar volgende fase |
| --- | --- | --- |
| 1 Verkennen | Unipile-proefaccount, eigen account koppelen, endpoints uitproberen | Alle acties werken handmatig op Ruberts account |
| 2 Kern bouwen | Register, koppelflow, webhooks, budgetmotor, wachtrij, nep-Unipile | Tests groen, inclusief 429 en CREDENTIALS |
| 3 Eigen proef | MCP-server, sequenties, alleen Ruberts account op halve normen | 3 weken zonder waarschuwing |
| 4 Klanten over | Per klant HeyReach uit, gateway aan: IPknowledge, Aqua, ICT Media, TAG | — |

## 11. Open vragen

- ~~Hosting: Railway of Fly.io (EU)?~~ Beslist: **Railway, EU-regio** (zie §13).
- ~~Supabase als database, of een beheerde Postgres bij de host?~~ Beslist in fase 2:
  **Supabase, Frankfurt (`eu-central-1`)**.
- Unipile-API-versie: de proefomgeving (30 sep 2026) is **v1** (DSN `api68.unipile.com:19841`, account-ID's zonder `acc_`). Vaststellen of v1 de basis blijft of dat we naar v2 migreren.
