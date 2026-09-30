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

## Profiel ophalen

## Connectieverzoek

## Bericht aan connectie

## InMail

## Webhooks

## Hosted auth (koppelen en opnieuw koppelen)
