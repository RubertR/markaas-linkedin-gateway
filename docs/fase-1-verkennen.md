# Fase 1 — Verkennen (week 1–2)

Doel: elke actie uit de SPEC één keer handmatig werkend zien op Ruberts eigen account, en
vastleggen hoe Unipile zich gedraagt. Er wordt nog geen gateway gebouwd.

**Poort naar fase 2:** alle zes acties hieronder zijn gelukt en beschreven in
`docs/unipile-notities.md`.

## Stap 1 — Unipile-account (Rubert, ca. 15 minuten)

- [ ] Maak een account op https://dashboard.unipile.com (7 dagen proef, geen creditcard).
- [ ] Maak een app `markaas-dev`. Noteer de **DSN** en maak een **API-sleutel**.
- [ ] Zet beide in een lokaal `.env` (zie `.env.example`), nooit in de repo.

## Stap 2 — Eigen LinkedIn-account koppelen (Rubert)

- [ ] Koppel in het Unipile-dashboard je eigen LinkedIn-account (hosted auth).
- [ ] Controleer in het dashboard dat de status `OK` is en of Sales Navigator herkend wordt.
- [ ] Koppel **niet** tegelijk een ander systeem dat voor dit account verstuurt (HeyReach).
      Phantombuster voor data ophalen mag blijven; houd de volumes in fase 1 minimaal.

## Stap 3 — Unipile-MCP in Claude (voor verkennen)

- [ ] Voeg in Claude een connector toe: `https://developer.unipile.com/mcp`, header
      `X-API-KEY` = de sleutel van `markaas-dev`.
- [ ] Gebruik hem alleen in deze fase en alleen met de ontwikkel-sleutel; verwijder hem als de
      gateway-MCP klaar is.

## Stap 4 — Acties uitproberen (met Claude, op je eigen account)

Laat Claude per actie het endpoint opzoeken, het verzoek tonen en pas na jouw akkoord uitvoeren.

| # | Actie | Wat je test | Maximaal volume |
| --- | --- | --- | --- |
| 1 | Accounts ophalen | Account-id, status, abonnement | — |
| 2 | Zoeken (LinkedIn én Sales Navigator) | Filters, paginering, velden | 1 zoekopdracht, 25 resultaten |
| 3 | Profiel ophalen | Welke velden, provider-id vs. publieke URL | 3 profielen |
| 4 | Connectieverzoek | Met notitie, foutmelding bij te lange notitie | 2 verzoeken, aan bekenden |
| 5 | Bericht aan connectie | Nieuw gesprek vs. bestaand gesprek | 1 bericht, aan een collega |
| 6 | InMail | Tegoedverbruik, foutmelding zonder tegoed | 1 InMail, aan een bekende |

Plus, zonder actie op LinkedIn:

- [ ] Webhooks: registreer een tijdelijke test-URL (bijv. webhook.site) voor accountstatus,
      nieuwe relatie en nieuw bericht; kijk welke gebeurtenissen binnenkomen bij stap 4 en 5.
- [ ] Hosted auth: maak een koppellink via de API (`type: create` en `type: reconnect`) en
      noteer de callback-payload.

## Stap 5 — Vastleggen

- [ ] Per actie in `docs/unipile-notities.md`: endpoint, verplichte velden, voorbeeldantwoord
      (geanonimiseerd), foutcodes die je zag, en of het meetelt voor welk LinkedIn-budget.
- [ ] Beslis welke API-versie (v1 of v2) we gebruiken en werk SPEC §11 bij.
