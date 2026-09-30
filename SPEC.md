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
| `queue_action` | Verzoek, bericht of InMail als **concept** | ja, bij uitvoering |
| `get_results` | Status van acties, acceptaties, reacties | nee |

Er is **geen** tool die direct verstuurt of een vrije API-aanroep doet.

## 8. Webhooks van Unipile

- Accountstatus → `accounts.status` bijwerken, pauze/hervatten.
- Nieuwe relatie (verzoek geaccepteerd) → sequentie een stap verder.
- Nieuw bericht → sequentie stoppen, notitie in Pipedrive.

Geen polling op vaste tijden; waar polling nodig is: enkele keren per dag op willekeurige
momenten.

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

- Hosting: Railway of Fly.io (EU)? Keuze in fase 2.
- Supabase als database, of een beheerde Postgres bij de host?
- Unipile-API-versie: de proefomgeving (30 sep 2026) is **v1** (DSN `api68.unipile.com:19841`, account-ID's zonder `acc_`). Vaststellen of v1 de basis blijft of dat we naar v2 migreren.
