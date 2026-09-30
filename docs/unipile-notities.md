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

## InMail

## Webhooks

## Hosted auth (koppelen en opnieuw koppelen)
