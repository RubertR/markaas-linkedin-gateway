# CLAUDE.md — huisregels voor dit project

Lees `SPEC.md` voordat je code schrijft. Bij twijfel geldt de SPEC; wijkt iets af, pas eerst
de SPEC aan (met Rubert) en dan de code.

## Harde regels

1. **Nooit direct naar LinkedIn verzenden.** Elke `invite`, `message` of `inmail` loopt via de
   wachtrij en de budgetmotor en vereist een goedkeuring. Schrijf geen code, script of test die
   deze route omzeilt — ook niet "even om te testen".
2. **Alle Unipile-aanroepen alleen in `src/unipile/`.** Andere modules importeren de client
   daarvandaan.
3. **Geen echte accounts in tests.** Tests gebruiken `test/fake-unipile/`. Handmatige proeven
   alleen op Ruberts eigen account in de ontwikkel-app van Unipile.
4. **Geen geheimen in de repo.** API-sleutels, DSN's en webhook-secrets komen uit `.env`
   (zie `.env.example`). Nooit loggen.
5. **Geen cookies of wachtwoorden opslaan.** Unipile beheert de sessies.
6. **Normen uit configuratie.** Limieten staan in `config/limits.json`, afgeleid van
   `docs/limieten.md`. Nooit hardcoderen.

## Stijl

- TypeScript strict, Node 20+, ES modules.
- Kleine modules met één verantwoordelijkheid; geen frameworks die we niet nodig hebben.
- Foutmeldingen richting skills en gebruiker in het Nederlands: wat ging mis, waarom, wat nu.
- Code en identifiers in het Engels; documentatie in het Nederlands.

## Werkwijze

- Werk per onderdeel in de volgorde van SPEC §10: register en koppelflow → webhooks →
  budgetmotor → wachtrij → sequenties → MCP-server.
- Elk onderdeel: eerst tests (inclusief foutpaden 429, CREDENTIALS, time-out), dan code.
- Twijfel over het gedrag van een Unipile-endpoint: zoek het op in de Unipile-documentatie
  (of via de Unipile-MCP in de ontwikkelomgeving) en leg het vast in `docs/unipile-notities.md`.
- Voordat je iets op een echt account uitvoert: meld wat, op welk account, hoeveel, en wacht op
  akkoord.

## Omgevingen

| Omgeving | Unipile-app | Accounts |
| --- | --- | --- |
| ontwikkeling | `markaas-dev` | alleen Rubert |
| productie | `markaas-prod` | klantaccounts |

Aparte API-sleutels per omgeving.
