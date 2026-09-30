# Unipile-notities

Wat we in de praktijk leren over Unipile. Per actie: endpoint, verplichte velden, voorbeeld
(geanonimiseerd), foutcodes, en welk LinkedIn-budget het verbruikt. Wordt gevuld in fase 1.

## Accounts ophalen

*Getest 30 sep 2026, v1, alleen lezen.*

- `GET https://{DSN}/api/v1/accounts` (DSN `api68.unipile.com:19841`), header `X-API-KEY`.
- MCP: spec-titel `Unipile API Reference` bij `branch=v1.0`; bij `branch=v2.0` geeft de v1-sleutel 401.
- Antwoord (`AccountList`): per account `id`, `type: LINKEDIN`, `sources[].status` (`OK`),
  `status_counts` (OK, CONNECTING, CREDENTIALS, STOPPED).
- Nuttig voor het accountregister: `connection_params.im`:
  - `connection_method` (`credentials`), `proxy.country` (`NL`)
  - `premiumFeatures` (`["sales_navigator"]`), `premiumContractId`, `premiumId`
  - `organizations[]`: bedrijfspagina's met eigen inbox (`messaging_enabled`, `mailbox_urn`)
- Telt niet mee voor een LinkedIn-budget (Unipile-metadata, geen LinkedIn-verkeer).

## Zoeken

*Getest 30 sep 2026, v1, Sales Navigator people, 25 resultaten.*

**Stap 1 — ID's opzoeken** (elk telt als lichte LinkedIn-aanroep):
`GET /api/v1/linkedin/search/parameters?account_id=…&type=…&keywords=…&limit=5`

| Filter | `type` | Voorbeeld-ID |
| --- | --- | --- |
| Regio / hoofdkantoor | `REGION` | Netherlands = `102890719` |
| Branche (Sales Nav) | `SALES_INDUSTRY` | Transportation, Logistics, Supply Chain and Storage = `116` |
| Afdeling | `DEPARTMENT` | Information Technology = `13` |

ID's zijn stabiel: cache ze in de gateway in plaats van ze elke keer op te vragen.

**Stap 2 — zoeken:** `POST /api/v1/linkedin/search?account_id=…&limit=25`, body met
`api: sales_navigator`, `category: people` en filters (`company_location`, `industry`,
`function`, `seniority`, `company_headcount` met vaste klassen 201–500, 501–1000).

- Antwoord: `paging.total_count` (hier 86), `cursor` voor de volgende pagina.
- Per persoon o.a.: `id` (provider-id, nodig voor profiel/verzoek/bericht), `public_identifier`,
  `network_distance` (`DISTANCE_2`/`DISTANCE_3`), `current_positions[]` (`role`, `company`,
  `company_id`, `tenure_at_role`), `recently_hired`, `recent_posts_count`,
  `shared_connections_count`, `pending_invitation`, `premium`.
- **Kwaliteit:** filter `industry` + `company_location` matcht soms op een ándere of eerdere
  functie of een buitenlandse vestiging. Na het ophalen per resultaat controleren of het
  huidige bedrijf echt in scope is (hier ca. 5 van 25 twijfelgevallen).
- **Budget:** telt als 25 zoekresultaten (werknorm 2.500/dag Sales Navigator).

## Profiel ophalen

*Getest 30 sep 2026, v1, 3 profielen van 1e-graads connecties.*

`GET /api/v1/users/{identifier}?account_id=…&linkedin_sections=*_preview&notify=false`

- `identifier`: publieke id (`public_identifier`) werkt voor classic; voor
  `linkedin_api=sales_navigator` is de interne provider-id nodig. Een verouderde publieke id
  wordt doorgestuurd naar de actuele (antwoord bevat de nieuwe `public_identifier`).
- `notify=false` is de standaard: het bezoek wordt niet gemeld aan de ander.
- `linkedin_sections`: `*_preview` geeft van elke sectie de eerste items (ervaring, opleiding,
  skills, aanbevelingen). `*` (alles volledig) kan LinkedIn laten afknijpen; lege secties staan
  dan in `throttled_sections`. Vraag alleen wat nodig is.
- Nuttige velden: `provider_id` (nodig voor verzoek/bericht), `network_distance`
  (`FIRST_DEGREE` …), `connected_at`, `is_open_profile`, `is_premium`, `can_send_inmail`,
  `is_open_to_work`, `shared_connections_count`, `work_experience[]` met `start`/`end`/`current`.
- **AVG — let op:** bij 1e-graads connecties bevat het antwoord `contact_info` (ook privé-e-mail
  en mobiel) en soms `birthdate`. De gateway slaat deze velden standaard **niet** op (zie SPEC §9).
- **Budget:** telt als 1 profielbezoek per aanroep (werknorm 150/dag Sales Navigator).

## Connectieverzoek

*Getest 30 sep 2026, v1, 1 verzoek met notitie aan een bekende (2e graad), na akkoord.*

**Ontvanger vinden:** classic-zoekopdracht op naam + context
(`POST /api/v1/linkedin/search`, `api: classic`, `category: people`, `keywords`).
Let op: classic geeft een pagina van 10 resultaten, ook als `limit` lager is. In de resultaten
is `public_identifier` vaak `null`; gebruik `id` (provider-id) als sleutel.

**Versturen:** `POST /api/v1/users/invite`, JSON-body:
`account_id`, `provider_id` (verplicht), `message` (optioneel, max. 300 tekens), `user_email`
(alleen als LinkedIn dat eist).

- Antwoord: `{"object":"UserInvitationSent","invitation_id":"…"}`.
- Optioneel veld `usage`: percentage van LinkedIns limiet, alleen meegegeven bij het passeren
  van 50/75/90/95%. **De budgetmotor moet dit veld uitlezen**: bij ≥75% direct afremmen.
- Relevante 422-fouten: `already_invited_recently`, `already_connected`,
  `cannot_resend_yet`, `connection_limit_reached`, `limit_exceeded`. Bij `limit_exceeded` of
  `connection_limit_reached`: account in afkoeling (SPEC §5).
- **Budget:** 1 verzoek (werknorm 20/dag, 100/week Sales Navigator).

## Bericht aan connectie

*Getest 30 sep 2026, v1, 1 bericht in een bestaand gesprek (na acceptatie), na akkoord.*

**In een bestaand gesprek:** `POST /api/v1/chats/{chat_id}/messages`, **multipart/form-data**
(niet JSON) met `text` en `account_id`. Met `account_id` weigert Unipile het bericht als het
gesprek niet bij dat account hoort: altijd meesturen.

- Antwoord: `{"object":"MessageSent","message_id":"…"}`.
- `chat_id` komt uit de webhook `message_received` (of `GET /api/v1/chats`).
- Optioneel: `quote_id` (reageren op een specifiek bericht), bijlagen, spraak/video.
- Nieuw gesprek starten (nog te testen): `POST /api/v1/chats` met `attendees_ids` = provider-id.
- Webhook-payload bevat bij `sender.attendee_specifics` ook `network_distance`
  (`DISTANCE_1` na acceptatie): bruikbaar als bevestiging van de relatie.
- **Budget:** 1 bericht (werknorm 25/dag, 150/week Sales Navigator).

## InMail

*Getest 30 sep 2026, v1, 1 InMail via Sales Navigator aan een bekende (2e graad), na akkoord.*

`POST /api/v1/chats`, **multipart/form-data**:
`account_id`, `attendees_ids` (provider-id), `subject`, `text`, `linkedin[api]=sales_navigator`.

- **ID-soort bepaalt de API:** `ACo…` = classic, `ACw…` = Sales Navigator, `AE…` = Recruiter.
  Voor Sales Navigator-InMail eerst het `ACw`-id ophalen: Sales Navigator-zoekopdracht met
  `first_name` + `last_name` (1 lichte aanroep). Classic-zoeken geeft alleen `ACo`.
- Classic-InMail kan ook: `linkedin[api]=classic` + `linkedin[inmail]=true` met `ACo`-id
  (niet getest; verbruikt Premium- i.p.v. Sales Navigator-credits).
- Antwoord: `{"object":"ChatStarted","chat_id":"…","message_id":"…"}`.
- Verwachte fouten (422): `insufficient_credits`, `not_allowed_inmail`, `user_unreachable`.
- Credits: Sales Navigator Core 50/maand; terug bij antwoord binnen 90 dagen. Het antwoord
  geeft **geen** resterend tegoed terug: de budgetmotor moet zelf tellen.
- Nieuw gesprek starten met een 1e-graads connectie gaat via hetzelfde endpoint zonder
  InMail-opties.

## Webhooks

*Aangemaakt 30 sep 2026, v1, alleen voor Ruberts account, doel: tijdelijke test-URL.*

`POST /api/v1/webhooks` met `request_url`, `source`, `events`, `account_ids`, `enabled`,
optioneel `name`, `format: json`, `headers` (voor een eigen geheim) en `data`.

| `source` | Events | Gebruik in de gateway |
| --- | --- | --- |
| `users` | `new_relation` | Verzoek geaccepteerd → sequentie een stap verder |
| `messaging` | `message_received` (ook read, reaction, edited, deleted, delivered) | Reactie → sequentie stoppen, notitie in Pipedrive |
| `account_status` | `credentials`, `error`, `stopped`, `reconnected`, `ok`, `permissions`, … | Sessie verlopen → account pauzeren en koppellink sturen |

- `account_ids` weglaten = webhook geldt voor **alle huidige én toekomstige** accounts. In
  productie per klant of bewust globaal instellen.
- `data` bepaalt welke velden meekomen. Voor de testwebhook op webhook.site is de
  berichttekst (`message`) bewust **weggelaten**: een externe test-URL is openbaar leesbaar.
- In productie: eigen endpoint, geheim in `headers` meesturen en controleren.
- Testwebhooks na fase 1 verwijderen: `DELETE /api/v1/webhooks/{id}`.

**Waarnemingen 30 sep 2026 (acceptatie van het testverzoek):**

- Bij acceptatie zet LinkedIn de uitnodigingsnotitie als eerste bericht in een nieuw gesprek.
  Dat komt binnen als `message_received` met `is_sender: true` (≈ moment van acceptatie).
  → **Snelste acceptatiesignaal = eerste bericht met `is_sender: true` in een nieuw gesprek met
  de ontvanger**, niet `new_relation`.
- `new_relation` was 3+ minuten na acceptatie nog niet binnen (Unipile detecteert dit
  periodiek; kan uren duren). Gateway moet beide signalen accepteren en ontdubbelen.
- `message_received` komt ook voor **eigen** berichten (`is_sender: true`): filteren, anders
  telt een eigen bericht als reactie.
- Payload (zonder berichttekst): `event`, `account_id`, `timestamp`, `chat_id`, `message_id`,
  `sender{attendee_id, attendee_name, attendee_provider_id}`, `is_sender`, `message_type`,
  `webhook_name`. `event_type` was `null`.
- Koppeling lead ↔ gesprek: `sender.attendee_provider_id` = de `provider_id` uit zoeken/profiel.
- Reactie van de ontvanger kwam 2,5 minuut na acceptatie → sequentie moet direct stoppen.

## Hosted auth (koppelen en opnieuw koppelen)

*Getest 30 sep 2026, v1: twee links aangemaakt, niet gebruikt.*

`POST /api/v1/hosted/accounts/link`, JSON.

| Veld | Nieuw account (`type: create`) | Opnieuw koppelen (`type: reconnect`) |
| --- | --- | --- |
| Verplicht | `expiresOn`, `api_url`, `providers` | `expiresOn`, `api_url`, `reconnect_account` |
| `providers` | `["LINKEDIN"]` | n.v.t. |
| Nuttig | `name` (eigen account-id), `notify_url`, `single_use: true` | `name`, `notify_url` |

- `api_url` = `https://{DSN}` (hier `https://api68.unipile.com:19841`).
- `expiresOn` in UTC met milliseconden (`2026-09-30T15:15:00.000Z`). **Alle links verlopen
  bij de dagelijkse herstart**, ongeacht de datum: per klik een nieuwe link maken.
- `disabled_options: ["cookie_auth"]` dwingt de Credentials-methode af (eigen sessie, los van
  de browser van de klant). Andere opties: `proxy`, `autoproxy`, `credentials_auth`, `sync_limit`.
- `disabled_features` kan `linkedin_sales_navigator` of `linkedin_organizations_mailboxes`
  uitzetten — handig als een klant alleen classic mag gebruiken.
- `sync_limit.MESSAGING` beperkt hoeveel berichtgeschiedenis Unipile synchroniseert (AVG: liever
  laag houden).
- Antwoord: `{"object":"HostedAuthUrl","url":"https://account.unipile.com/…"}`.
- Callback op `notify_url` na succes: `status: CREATION_SUCCESS` / `RECONNECTED`, `account_id`,
  `name` (nog niet waargenomen; links zijn niet gebruikt).
- Links niet in een iframe tonen (captcha/OAuth). Niet in chat of logs laten slingeren.

## Opruimen na fase 1

- 30 sep 2026: de drie testwebhooks naar webhook.site verwijderd (`DELETE /api/v1/webhooks/{id}`,
  antwoord `WebhookDeleted`); `GET /api/v1/webhooks` is leeg.
