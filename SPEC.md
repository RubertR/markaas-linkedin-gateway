# SPEC — MARKaaS LinkedIn-gateway

Versie 0.4 (concept) · 9 oktober 2026 · eigenaar: Rubert Rietkerk (MARKaaS)

> **Wijziging 0.4 (9 okt 2026, voorstel, nog niet vastgesteld):** de klant beantwoordt een vraag van
> MARKaaS over het klantprofiel in het portaal (gesprek per profielversie, §14.6), en MARKaaS kan in
> de admin het portaal van een klant alleen-lezen bekijken (§14.7).
>
> **Wijziging 0.3 (8 okt 2026, besluit Rubert):** na het aanmelden vult de klant
> in het portaal een intake in voor zijn klantprofiel en ICP. MARKaaS stelt het profiel vast;
> de prospectieskill leest het via de MCP. Zie §14.6.

> **Wijziging 0.2 (7 okt 2026, besluit Rubert):** de gateway wordt een betaald product. Klanten
> krijgen een eigen portaal met login, keuren zelf concepten goed en betalen een abonnement via
> Stripe. Zie §14. Dit vervangt de uitsluiting "klantportaal, facturatie, zelfbediening" uit §2.

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
- MARKaaS bedient het systeem: zoeken, concepten maken, sequenties starten. Klanten koppelen
  hun LinkedIn-account via een link, keuren concepten voor hun eigen accounts goed in het
  klantportaal en betalen een abonnement (§14).
- Acties: zoeken (LinkedIn en Sales Navigator), profiel ophalen, connectieverzoek, bericht aan
  connectie, InMail.
- Eenvoudige sequenties: verzoek → geaccepteerd → bericht → opvolging; stopt bij een reactie.

**Niet (v1)**

- Zelfbediening voor zoeken, teksten schrijven of sequenties starten door klanten.
- Aanmelden zonder uitnodiging van MARKaaS.
- E-mail versturen vanuit de gateway: uitnodigings- en koppellinks kopieert Rubert zelf in
  een mail (later eventueel een e-maildienst).
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
| `events` | id, bron (`unipile`, `gateway`, `stripe`), type, extern_id, account_id, payload, ontvangen_op |

## 5. Budgetmotor

Elke actie passeert zes controles, in deze volgorde. Faalt er één, dan blijft de actie in de
wachtrij (tijdelijk) of wordt ze geweigerd met reden (structureel).

1. **Account gezond** — status `OK`. Bij `CREDENTIALS`, `ERROR`, `STOPPED` stopt alles.
   Direct daarna de **betaalpoort** (§14.4, controle 1a): zonder actief abonnement worden
   `invite`, `message` en `inmail` bij klanten met `abonnement_vereist` **geparkeerd**
   (wachtrij, opnieuw beoordelen na 60 minuten), niet afgewezen: zodra er een actief
   abonnement is, gaan goedgekeurde acties alsnog.
2. **Goedgekeurd** — `invite`, `message`, `inmail` vereisen `goedgekeurd_door`. `search` en
   `profile` niet.
3. **Dagbudget** — verbruik vandaag + deze actie ≤ dagnorm × opbouw_factor.
4. **Weekbudget** — schuivend over 7 dagen, ≤ weeknorm × opbouw_factor.

   Geschaalde normen worden naar beneden afgerond, maar komen nooit onder 1 als de
   ongeschaalde norm ≥ 1 is (anders blokkeert bijv. `search.runs_per_dag` = 1 tijdens de
   opbouw volledig). Afkoeling blijft een aparte stop: dan gaat er niets door.

   De opbouw_factor geldt **niet voor InMail**: InMail-tegoed is betaald maandtegoed en blijft
   op de volle abonnementsnorm per kalendermaand.
5. **Tijdvenster** — werkdag, 08:30–17:30 in de tijdzone van het account; 2–8 minuten
   willekeurig tussen twee acties op hetzelfde account.
6. **Afkoeling** — na HTTP 429, captcha of waarschuwing: 48 uur pauze, daarna 7 dagen
   opbouw_factor 0.5.

Normen: zie `docs/limieten.md`. Normen staan in configuratie, niet in code.

**Opbouw:** nieuw of stil account start op 0.5; elke week +0.2 zolang acceptatie van
verzoeken ≥ 30%; maximaal 1.0.

## 5a. Openstaande verzoeken

`accounts.openstaande_verzoeken` voedt de grens "openstaand < 500" voor invites (controle 3).

- **Omhoog:** +1 in dezelfde transactie waarin een invite op `done` gaat. Ook bij
  `onzeker` (time-out tijdens verzenden): LinkedIn kan de invite wél hebben ontvangen, dus
  de veilige kant is meetellen. Per actie telt dit één keer (gateway-event
  `invite_openstaand:<actie-id>`): onzeker → handmatig `done`, of onzeker → opnieuw
  goedgekeurd → `done`, verhoogt niet nog eens. Blijkt een onzeker-invite niet verstuurd en
  komt hij er ook later niet door, dan corrigeert de dagelijkse sync de teller.
- **Omlaag:** −1 bij acceptatie (zie §8a.3, Acceptatiesignalen), één keer per
  account+attendee; nooit onder 0.
- **Dagelijkse sync (bron van waarheid):** één keer per werkdag per account zet de gateway
  de teller gelijk aan het aantal openstaande invites volgens Unipile
  (`GET /api/v1/users/invite/sent`, zie `docs/unipile-notities.md`). Die lijst bevat alleen
  nog openstaande invites, dus verlopen, ingetrokken en buiten de gateway verstuurde invites
  tellen vanzelf goed mee.
  - Alleen voor accounts met status `OK`/`RECONNECTED`, buiten afkoeling, op een werkdag
    binnen het tijdvenster in de tijdzone van het account (§5 controle 5).
  - Moment: per account en dag een vast maar willekeurig moment binnen het venster (§8: geen
    polling op vaste tijden). Draait mee in de planner-tick, vóór de planner.
  - Eén GET per account per dag (pagina's van 250; een tweede GET alleen bij meer dan 250
    openstaand). Grootte en maximum aantal pagina's in `config/limits.json`
    (`verzoeken_sync`). Is de lijst na het maximum nog niet op, dan wordt de teller het
    getelde aantal (een ondergrens ≥ 500, dus invites blijven tegengehouden).
  - Eén poging per dag, ook bij een fout; de teller blijft dan staan. HTTP 429 → afkoeling
    (§5 controle 6). Time-out of serverfout → volgende werkdag opnieuw. Sessie verlopen →
    account op `CREDENTIALS`. Gateway-sleutel geweigerd → planner stopt.
  - Elke poging staat als gateway-event `verzoeken_sync` (per account per dag) met voor,
    werkelijk en resultaat.
- **Eenmalig gelijkzetten:** `npm run verzoeken:sync` (standaard dry-run die alleen leest;
  `--uitvoeren` om te schrijven). Wacht niet op het moment van de dag, maar blijft binnen
  werkdag en tijdvenster. Telt bij `--uitvoeren` als de sync van die dag.

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
| `get_budget` | Resterend budget per actie, vandaag en deze week; tijdens afkoeling overal 0 met `afkoelingTot` en reden | nee |
| `search_people` | LinkedIn- of Sales Navigator-zoekopdracht | ja |
| `get_profile` | Eén profiel | ja |
| `queue_action` | Verzoek, bericht of InMail als **concept** (status `draft`) | ja, bij uitvoering |
| `start_sequence` | Start een sequentie voor één lead; maakt alleen het **concept** voor stap 1 (invite) | ja, bij uitvoering |
| `get_results` | Status van acties, acceptaties, reacties, en lopende sequenties | nee |
| `get_klantprofiel` | Laatste vastgestelde klantprofiel van één klant (§14.6), plus de status van een nieuwere versie | nee |

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
- `geaccepteerd` — acceptatie ontvangen (`new_relation` of het eerste eigen bericht in een
  nieuw gesprek, zie hieronder); wacht op (of heeft al) een `draft`-message voor stap 2 of 3.
- `reactie` — lead stuurde een bericht (`message_received`, `is_sender=false`); sequentie
  stopt en openstaande `draft`/`queued`-stappen worden `rejected` met reden
  "lead heeft gereageerd".
- `gestopt` — eindigt zonder reactie. Redenen vastgelegd in `sequences.stop_reden`:
  "verzoek niet geaccepteerd" (na 21 dagen zonder `new_relation`), "sequentie
  voltooid" (opvolging is verstuurd) of "afgewezen bij goedkeuring: <reden>" (zie
  hieronder).
- `mislukt` — gereserveerd voor onvoorziene fouten; nog niet actief gebruikt.

### 8a.3 Pauze versus stoppen

De sequentie **stopt** bij een reactie, bij 21 dagen zonder acceptatie of bij afwijzing
van een stap. Alle andere obstakels zijn **pauzes** die vanzelf voorbijgaan:

- Account `CREDENTIALS`, `ERROR`, `STOPPED` of in afkoeling → de tick maakt geen
  nieuwe `draft`-stap zolang de account niet weer `OK`/`RECONNECTED` is. Status
  blijft wat hij was; wachttijden lopen door (geen inhaalslag).
- Dubbele `new_relation` of dubbel `message_received` binnen tien minuten → de
  bestaande events-dedup (uniek `extern_id`) telt het slechts één keer; de
  sequentie-overgang gebeurt dus ook één keer.

**Afwijzen van een stap.** Wordt een sequentie-stap (1, 2 of 3) afgewezen op de
goedkeuringspagina, dan gaat de sequentie in dezelfde transactie naar `gestopt` met
stop_reden "afgewezen bij goedkeuring: <ingevulde reden>" (voorvoegsel uit
`sequenties.stop_redenen.afgewezen` in `config/limits.json`). Overige openstaande stappen
(`draft`/`queued`/`approved`) van die sequentie worden met dezelfde reden afgewezen.

**Opnieuw starten.** `start_sequence` voor een lead met een eerdere sequentie mag alleen
als die eerdere sequentie `gestopt` is én een afgewezen stap heeft. Na een reactie, na
"verzoek niet geaccepteerd" of na "sequentie voltooid" blijft opnieuw starten geweigerd.
De database bewaakt hooguit één actieve (`lopend`/`geaccepteerd`) sequentie per
account+lead (migratie `0003`). Er gaat nooit een tweede invite naar dezelfde lead:

- Invite van een vorige sequentie **niet verstuurd** (stap 1 afgewezen) → de nieuwe
  sequentie begint gewoon bij stap 1 met een `draft`-invite.
- Invite **verstuurd en geaccepteerd** (vorige sequentie kwam voorbij stap 0, of er is een
  `acceptatie`/`new_relation`-event voor deze lead) → de nieuwe sequentie begint bij
  stap 2: status `geaccepteerd`, `volgende_actie_op` = nu, geen invite. De tick maakt het
  stap-2-concept met de nieuwe tekst en neemt de `chatId` over uit de vorige sequentie.
- Invite **verstuurd maar nog niet geaccepteerd** → `start_sequence` weigert met een
  NL-melding: wachten op acceptatie of op het verlopen van het verzoek.

"Verstuurd" betekent dat de invite de status `done` of `onzeker` heeft.

Bestaande sequenties die nog `lopend`/`geaccepteerd` staan met een afgewezen stap
(van vóór deze regel) zet `npm run sequenties:herstel` op `gestopt`; standaard een
dry-run, schrijven alleen met `--uitvoeren`.

**Acceptatiesignalen.** Twee signalen tellen als acceptatie:

1. `new_relation` (Unipile detecteert dit periodiek; kan uren later komen).
2. Het eerste eigen bericht (`message_received` met `is_sender=true`) in een gesprek met
   een attendee naar wie we een invite verstuurden (`actions.status` is `done` of `onzeker`;
   beide tellen mee in `openstaande_verzoeken`, zie §5a). Bij
   acceptatie zet LinkedIn de uitnodigingsnotitie als eerste bericht in het nieuwe gesprek.
   De ontvanger komt uit `attendees` (zonder de afzender).

Per account+attendee telt maar één acceptatie: een gateway-event `acceptatie` met
`extern_id = acceptatie:<unipile_account_id>:<attendee_provider_id>` ontdubbelt. Alleen de
eerste verlaagt `openstaande_verzoeken` en zet de sequentie op `geaccepteerd`. Eigen
berichten worden opgeslagen als event `message_sent_self`; ze tellen nooit als reactie en
stoppen nooit een sequentie.

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
| 4 Klanten over | Per klant HeyReach uit, gateway aan: IPknowledge, Aqua, ICT Media, TAG | Eerste klant 3 weken zonder waarschuwing |
| 5 Product | Onboarding, klantportaal, Stripe-abonnement, voorwaarden en verwerkersovereenkomst (§14) | Eerste betalende klant via de volledige flow |

## 11. Open vragen

- ~~Hosting: Railway of Fly.io (EU)?~~ Beslist: **Railway, EU-regio** (zie §13).
- ~~Supabase als database, of een beheerde Postgres bij de host?~~ Beslist in fase 2:
  **Supabase, Frankfurt (`eu-central-1`)**.
- Unipile-API-versie: de proefomgeving (30 sep 2026) is **v1** (DSN `api68.unipile.com:19841`, account-ID's zonder `acc_`). Vaststellen of v1 de basis blijft of dat we naar v2 migreren.
- Apart Unipile-account voor productie vóór fase 4? Nu delen ontwikkeling en productie
  één Unipile-account en DSN, en verschillen ze alleen in hun Access Token. Besluiten
  voordat de eerste klantaccounts overgaan.

## 14. Klantportaal, onboarding en abonnement

*Toegevoegd in versie 0.2. Volgorde van bouwen: 14.1 → 14.2 → 14.3 → 14.4.*

### 14.1 Rollen

| Rol | Wie | Waar | Mag |
| --- | --- | --- | --- |
| Beheerder | Rubert (MARKaaS) | `/admin/` (bestaand, §12) | Alles: klanten aanmaken, uitnodigen, alle concepten goedkeuren |
| Klantgebruiker | Meerdere per klant | `/portaal/` (nieuw) | Alleen de accounts van de eigen klant zien; concepten van die accounts goedkeuren of afwijzen; resultaten bekijken; abonnement starten en beheren |

Een klantgebruiker ziet nooit gegevens van een andere klant. Elke query in het portaal filtert
op `client_id` van de ingelogde gebruiker; tests bewijzen dat een gebruiker van klant A geen
actie, account of resultaat van klant B kan lezen of goedkeuren.

Goedkeuren kan door de klant én door MARKaaS. `goedgekeurd_door` legt vast wie:
`rubert` of `klant:<e-mailadres>`.

### 14.2 Onboarding van een nieuwe klant

1. **Klant aanmaken** (`/admin/klanten/nieuw`): klantnaam, slug, naam en e-mail van de
   accounteigenaar, LinkedIn-abonnement. Maakt `clients` + `accounts` (status `CONNECTING`,
   nog geen `unipile_account_id`) en een **koppeluitnodiging**.
2. **Koppeluitnodiging:** een eigen token van de gateway (willekeurig, 32 bytes, in de database
   alleen als hash), standaard 7 dagen geldig, eenmalig. Rubert kopieert de link
   `/koppelen/<token>` in een mail aan de accounteigenaar. De Unipile-link zelf wordt pas
   gemaakt op het moment dat de eigenaar akkoord geeft, omdat die snel verloopt (§6).
3. **Koppelpagina** (`/koppelen/<token>`, publiek, zonder login): uitleg in gewone taal wat er
   gebeurt, welke limieten gelden en dat elk bericht eerst wordt goedgekeurd. Drie verplichte
   vinkjes:
   - ik ben eigenaar van dit LinkedIn-account of handel met toestemming van de eigenaar;
   - ik geef toestemming om dit account via de gateway te gebruiken binnen de vastgelegde limieten;
   - ik heb de voorwaarden en de verwerkersovereenkomst (met versienummer) gelezen.
4. **Toestemming vastleggen** in `account_consents`: account, naam, e-mail, tekstversie van
   voorwaarden en verwerkersovereenkomst, tijdstip, gehashte IP (SHA-256 met geheim zout) en
   user-agent, plus een momentopname van klant (client_id, klantnaam), accounteigenaar en
   unipile_account_id (migratie 0007), zodat het bewijs leesbaar blijft na verwijderen of
   hernoemen. Bewaard zolang het account bestaat plus 2 jaar.
   De koppelpagina heeft CSRF in twee lagen: HMAC van het token én een double-submit-cookie
   (`koppel_csrf`, HttpOnly, SameSite=Lax, Path=/koppelen).
5. Daarna maakt de gateway een Unipile hosted-auth-link (`type: create`) en stuurt de browser
   door. Callback `CREATION_SUCCESS` werkt zoals in §6.
6. De pagina toont na terugkomst "gekoppeld" of een duidelijke foutmelding met vervolgstap.

### 14.3 Klantportaal

- **Uitnodigen** (`/admin/klanten/<slug>`): Rubert vult naam en e-mail in en krijgt een
  uitnodigingslink (zelfde tokenregels als 14.2, 7 dagen, eenmalig). De gebruiker kiest
  daarmee zijn wachtwoord (minimaal 12 tekens, scrypt-hash zoals de admin).
- **Inloggen** (`/portaal/login`): e-mail + wachtwoord, eigen sessiecookie (`portaal_sessie`,
  HttpOnly, Secure, SameSite=Lax — zodat de terugkeer van Stripe niet op het loginscherm valt;
  elke POST eist het CSRF-token en geen GET wijzigt iets), CSRF-token per sessie, vertraging na mislukte pogingen
  zoals bij de admin. Wachtwoord vergeten: Rubert maakt een nieuwe uitnodigingslink (v1).
- **Concepten** (`/portaal/`): open concepten van de eigen accounts met lead, tekst en stap;
  goedkeuren, afwijzen met reden, of alles tegelijk goedkeuren. Dezelfde helpers als de admin
  (`src/queue/acties.ts`), zodat budget, tijdvenster en sequentieregels identiek gelden.
  Zolang een klant met `abonnement_vereist` geen `trialing`/`active`/`past_due`-abonnement
  heeft, kan de klant in het portaal niet goedkeuren (NL-melding); de admin wel, met een
  waarschuwing (de actie blijft dan geparkeerd, §5).
- **Foutmeldingen:** alleen eigen foutklassen met een NL-tekst voor de klant worden letterlijk
  getoond; overige fouten geven "Er ging iets mis; probeer het opnieuw of neem contact op met
  MARKaaS" en de details gaan naar de log.
- **Resultaten** (`/portaal/resultaten`): per account verstuurd, geaccepteerd, gereageerd,
  per week; status van het account (gekoppeld, opnieuw koppelen nodig met knop voor een
  reconnect-link, in afkoeling). De knop werkt alleen in de stand "opnieuw koppelen nodig",
  maximaal één reconnect-link per account per 5 minuten. Een nog niet gekoppeld account krijgt
  vanuit het portaal geen nieuwe uitnodiging: "Vraag MARKaaS om een nieuwe koppellink voor de
  accounteigenaar" (de toestemming loopt via §14.2).
- **Abonnement** (`/portaal/abonnement`): status, proefperiode tot, volgende betaling; knop
  "Abonnement starten" (Stripe Checkout) of "Abonnement beheren" (Stripe Customer Portal).
- Sessies van het portaal worden in de database bewaard (tabel `portal_sessions`), omdat er
  meerdere gebruikers zijn en een herstart ze niet mag uitloggen.

### 14.4 Abonnement via Stripe

- Alle Stripe-aanroepen alleen in `src/stripe/` (zelfde regel als `src/unipile/`). Tests
  gebruiken `test/fake-stripe/`. Sleutels uit `.env`: `STRIPE_SECRET_KEY`,
  `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`.
- **Prijsmodel:** maandabonnement met **30 dagen proefperiode** (de pilot). Opzeggen vóór het
  einde van de proef = geen betaling ("geen resultaat, geen factuur"). Prijs en proefduur staan
  in Stripe en `config/abonnement.json`, nooit in de code.
- **Checkout:** Stripe Checkout in `subscription`-modus, één Stripe-customer per klant
  (`metadata.client_id`). Aantal = aantal gekoppelde LinkedIn-accounts als de prijs per
  account is. Vóór de Checkout haalt de gateway de abonnementen van de customer op
  (`status=all`); bestaat er een niet-beëindigd abonnement (niet `canceled` of
  `incomplete_expired`), dan geen nieuwe Checkout maar een melding en door naar "Abonnement
  beheren".
- **Proefperiode maar één keer:** `trial_period_days` alleen als de klant nog nooit een
  abonnement had (geen `stripe_subscription_id` of `proef_tot` in de tabel en geen enkel
  abonnement bij Stripe).
- **Aantal bijhouden:** bij prijs per account werkt de gateway na een nieuw gekoppeld account
  (`CREATION_SUCCESS`) de quantity van het lopende abonnement bij
  (`POST /v1/subscriptions/{id}`, `items[0][id]`, `items[0][quantity]`,
  `proration_behavior=create_prorations`). Ontkoppelen of verwijderen gebeurt (nog) buiten de
  gateway; daarvoor staat op de klantpagina in de admin de knop "Aantal in Stripe bijwerken".
  Een Stripe-fout laat de koppeling niet falen: log + event (`stripe_aantal_mislukt`) dat de
  admin op de klantpagina toont.
- **Webhook** `/webhooks/stripe`: handtekening controleren met `STRIPE_WEBHOOK_SECRET`;
  dedup op event-id in `events`. Verwerkt `checkout.session.completed`,
  `customer.subscription.created|updated|deleted`, `invoice.paid`, `invoice.payment_failed`.
  Bij elk van deze events haalt de gateway het abonnement opnieuw op bij Stripe en slaat die
  actuele stand op (alleen als Stripe het niet meer kent: de stand uit het event).
- **Tabel `subscriptions`:** client_id, stripe_customer_id, stripe_subscription_id, status
  (Stripe-status), proef_tot, periode_tot, opgezegd_per_einde, stripe_event_op, bijgewerkt_op.
  `stripe_event_op` = `created` van het laatst toegepaste event: Stripe levert niet op volgorde,
  een ouder event (strikt eerder tijdstip) overschrijft geen nieuwere stand, ook niet bij een
  ander abonnement-id; een beëindigd ander abonnement overschrijft een lopend abonnement niet.
- **Betaalpoort in de budgetmotor:** voor klanten met `abonnement_vereist = true`:
  - `trialing`, `active` → normaal;
  - `past_due` → normaal, met waarschuwing in portaal en ochtendbriefing (de briefing leest
    `klantAbonnement` uit `get_budget`);
  - `unpaid`, `canceled`, `incomplete_expired` of geen abonnement → **geen verzending**
    (`invite`, `message`, `inmail`): de budgetmotor parkeert de actie in de wachtrij met de
    NL-reden "Abonnement niet actief" (geen definitieve afwijzing). Zoeken en profielen
    blijven mogelijk voor MARKaaS.
  - MARKaaS, IPknowledge en TAG krijgen `abonnement_vereist = false` (besluit Rubert,
    7 okt 2026). Aqua, ICT Media en alle nieuwe klanten krijgen `true`: zij hebben een
    actief abonnement (of proefperiode) nodig voordat er verzonden wordt.

### 14.5 Juridisch

- Voorwaarden en verwerkersovereenkomst staan als versie-genummerde documenten vast; de
  koppelpagina toont de actuele versie en `account_consents` legt vast welke versie is
  geaccepteerd.
- Subverwerkers (opnemen in de verwerkersovereenkomst): Unipile (LinkedIn-verbinding),
  Railway (hosting, EU West), Supabase (database, Frankfurt), Stripe (betalingen),
  Anthropic (Claude, opstellen van concepten en selectie van leads).
- De documenten worden juridisch getoetst voordat de eerste betalende klant start.

### 14.6 Klantprofiel en ICP-intake

*Toegevoegd in versie 0.3 (besluit Rubert, 8 okt 2026). Bouwen na 14.4.*

**Doel.** De klant ervaart dat er voor hem een eigen klantprofiel en ICP wordt opgesteld, en
MARKaaS krijgt de antwoorden gestructureerd binnen in plaats van via losse gesprekken. Het
vastgestelde profiel is de bron voor de prospectieskill (`klanten/<slug>.md` wordt daarvan
afgeleid of vervalt).

**Flow**

1. **Na de eerste login** (wachtwoord gekozen, §14.3) gaat een klantgebruiker naar
   `/portaal/profiel` zolang zijn klant nog geen ingediend of vastgesteld profiel heeft.
   Daarna toont elke portaalpagina een balk "Stap 1: vul uw klantprofiel in" tot het profiel is
   ingediend. De intake blokkeert goedkeuren en de andere pagina's niet.
2. **Intake in korte rondes**, één scherm per ronde, met keuzes plus "Anders, namelijk …".
   Elke ronde wordt bij "Volgende" als concept opgeslagen; terug kan altijd; een collega van
   dezelfde klant kan verdergaan waar de ander stopte.
   1. *Propositie:* wat verkoopt u, welk probleem lost het op, wat levert het de klant op.
   2. *Doelgroep:* sectoren, omvang (medewerkers), regio, functies van de beslissers.
   3. *Signalen en uitsluitingen:* wanneer is een bedrijf nu rijp (triggers); wie benaderen we
      niet (concurrenten, B2C, overheid, bestaande klanten met een lijst van namen).
   4. *Afzender en toon:* wie de afzenders zijn en hoe ze ondertekenen (de gekoppelde
      LinkedIn-accounts staan erbij als geheugensteun); welke naam in de berichten staat (eigen merk of partner); je of u; taal;
      ervaring van de afzender in een paar zinnen.
   5. *Bewijs en aanbod:* wat mag genoemd worden (resultaten, klantnamen, garanties, ervaring)
      en wat het aanbod is (bijv. vrijblijvend gesprek). Elke claim krijgt een verplicht
      vinkje "Dit klopt en mag in berichten gebruikt worden"; een ingevulde claim zonder vinkje
      geeft een NL-melding en de ronde wordt niet opgeslagen.
   6. *Overzicht:* de antwoorden in gewone taal, met "Wijzigen" per ronde en de knop
      "Indienen bij MARKaaS".
3. **Vaststellen door MARKaaS** op `/admin/klanten/<slug>/profiel`: antwoorden lezen, een
   interne aanvulling toevoegen (vrije tekst: zoekfilters, extra uitsluitingen, haken en sectoren
   voor het dashboard; nooit zichtbaar voor de klant) en "Vaststellen". De interne aanvulling van
   een vastgesteld profiel kan later worden bijgewerkt zonder nieuwe versie. Terugsturen met een vraag aan
   de klant kan ook: de versie gaat dan terug naar concept met de vraag zichtbaar in het
   portaal.
4. **Na vaststellen** ziet de klant op `/portaal/profiel` "Uw klantprofiel is vastgesteld" met
   een samenvatting (alleen lezen) en de knop "Wijziging aanvragen", die een nieuwe
   conceptversie opent op basis van de vastgestelde. Tot de nieuwe versie is vastgesteld,
   blijft de vorige gelden.
5. **MARKaaS kan namens de klant invullen** via de admin (voor bestaande klanten zoals TAG);
   `ingediend_door` legt dan `rubert` vast.

**Vraag en antwoord** *(0.4)*. Terugsturen met een vraag en antwoorden vormen samen een kort
gesprek bij de profielversie (tabel `klantprofiel_berichten`, migratie 0009: id, profiel_id,
van `markaas` | `klant`, tekst (max 1.000), door, op). In het portaal staat bij een open vraag op het
overzicht een tekstveld "Uw antwoord aan MARKaaS" (optioneel) boven de knop "Indienen bij MARKaaS";
indienen bewaart het antwoord als bericht van de klant en zet het profiel op `ingediend`. De klant
kan daarnaast de antwoorden in de rondes aanpassen. Het hele gesprek staat in het portaal (alleen
lezen) en in de admin bij het profiel, nieuwste onderaan. `vraag_van_markaas` blijft de laatste
open vraag; het gesprek is de geschiedenis. Een bericht wordt nooit gewijzigd of verwijderd.

**Vragen in configuratie.** De rondes, vragen en keuzes staan in `config/intake.json` met een
versienummer, niet in de code. Een profiel bewaart de `intake_versie` waarmee het is ingevuld.

**Opslag** (migratie 0008, tabel `klantprofielen`): id, client_id, versie (oplopend per
klant), status (`concept` | `ingediend` | `vastgesteld` | `vervangen`), intake_versie,
antwoorden (jsonb), interne_aanvulling (tekst, alleen admin en MCP), vraag_van_markaas,
revisie (teller per wijziging), ingediend_door, ingediend_op, vastgesteld_door, vastgesteld_op,
aangemaakt_op, bijgewerkt_op. Per klant
hooguit één `concept`/`ingediend` en één `vastgesteld`; bij vaststellen wordt de vorige
`vastgesteld` → `vervangen`. Opslaan van een ronde vergelijkt de `revisie` uit het formulier (optimistisch):
heeft een collega intussen opgeslagen, dan een NL-melding en de nieuwste stand, geen stille
overschrijving.

**Rechten en veiligheid.** Zoals §14.3: elke query filtert op `client_id` van de ingelogde
gebruiker; tests bewijzen dat klant A het profiel van klant B niet kan lezen of wijzigen. CSRF
op elke POST, geen GET die iets wijzigt. Vrije tekstvelden maximaal 1.000 tekens, als tekst
opgeslagen en altijd ge-escaped getoond. Antwoorden zijn bedrijfsgegevens; persoonsgegevens
alleen van de afzenders (naam, ervaring) en de lijst bestaande klanten (bedrijfsnamen).

**MCP-tool `get_klantprofiel`** (`clientSlug`): geeft de laatste vastgestelde versie
(antwoorden + interne aanvulling + versie + vastgesteld_op) en, als die er is, de status van
een nieuwere versie (`concept` of `ingediend`). Geen vastgesteld profiel → NL-melding "Er is
nog geen vastgesteld klantprofiel voor <klant>; laat de klant de intake invullen of stel het
ingediende profiel vast." Er is geen MCP-tool die een profiel schrijft of vaststelt.

**Prospectieskill.** Leest bij stap 0 `get_klantprofiel`; zonder vastgesteld profiel geen
ronde. Bewijs uit het profiel mag alleen gebruikt worden als het met het vinkje is bevestigd.

**Later (niet in v1).** Doorvragen door Claude tijdens de intake (vervolgvragen op vage
antwoorden), voorstellen voor zoekfilters op basis van de antwoorden, en de klant zelf
voorbeeldteksten laten beoordelen vóór de eerste ronde.

### 14.7 Portaal bekijken als klant (alleen lezen)

*Toegevoegd in versie 0.4 (concept).*

- Op de klantpagina in de admin staat de knop **"Bekijk als klant"**. Die opent
  `/admin/klanten/<slug>/als-klant` met dezelfde pagina's als het portaal: concepten, resultaten,
  abonnement en klantprofiel (overzicht en rondes), met de gegevens van die klant.
- Bovenaan elke pagina een opvallende balk: "Voorbeeld: zo ziet <klant> het portaal. U kunt hier
  niets wijzigen." met een link terug naar de klantpagina.
- **Alleen lezen, afgedwongen aan de serverkant:** er zijn onder `/als-klant` geen POST-routes;
  formulieren en knoppen worden uitgeschakeld weergegeven en hebben geen `action`. Links tussen
  portaalpagina's verwijzen naar de voorbeeldversie. Er wordt geen portaalsessie gemaakt en er wordt
  niets in de database gewijzigd (geen login-registratie, geen flash).
- Alleen voor de beheerder (admin-sessie). De interne aanvulling van het profiel blijft verborgen,
  net als in het echte portaal. Tests bewijzen dat de voorbeeldpagina's niets kunnen wijzigen en dat
  een klantgebruiker er niet bij kan.

