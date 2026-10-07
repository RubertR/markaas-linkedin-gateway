# MARKaaS LinkedIn-gateway

Een dienst tussen de Claude-skills van MARKaaS en de Unipile-API. Hij bewaakt per
LinkedIn-account een budget, laat niets versturen zonder goedkeuring en houdt per klant bij
welke accounts werken.

**Status:** fase 3 (eigen proef) ronde 2 afgerond op 1 okt 2026 — de
goedkeuringspagina staat op `/admin/*` naast MCP (`/mcp`) en webhooks
(`/webhooks/*`); alleen Rubert kan daar invite-, message- en inmail-
acties goedkeuren, afwijzen of opnieuw plannen (SPEC §12). De MCP uit
ronde 1 kreeg een correctie: `search_people` en `get_profile` houden
zich nu aan een per-type pauze (profile 30–90 s, zoek 2–8 min) op basis
van de laatst uitgevoerde actie van dat type. 350 tests groen op
`node --test` tegen PGlite; migratie `0001_init.sql` eerder toegepast
op Supabase (Frankfurt, `eu-central-1`, project-ref
`uujvmoqsalpgshptiljy`). Volgende rondes: sequenties → uitrol op Railway
(zie [docs/fase-3-plan.md](docs/fase-3-plan.md)).

Geteste Unipile-endpoints staan in `docs/unipile-notities.md`.

| Document | Waarvoor |
| --- | --- |
| [SPEC.md](SPEC.md) | Wat we bouwen: doel, afbakening, datamodel, budgetmotor, MCP-tools |
| [CLAUDE.md](CLAUDE.md) | Huisregels voor Claude Code in dit project |
| [docs/fase-1-verkennen.md](docs/fase-1-verkennen.md) | Afgerond — proefverkenning van Unipile |
| [docs/fase-2-plan.md](docs/fase-2-plan.md) | Afgerond — kernbouw, test-eerst per onderdeel |
| [docs/fase-3-plan.md](docs/fase-3-plan.md) | Lopend — MCP-server, goedkeuringspagina, sequenties, uitrol Railway |
| [docs/limieten.md](docs/limieten.md) | Werknormen per account en actie |
| [docs/uitrol-railway.md](docs/uitrol-railway.md) | Stappenplan voor de uitrol op Railway (EU West) |

## Nieuwe klant aanmaken (SPEC §14.2)

1. Log in op `/admin/` en kies **Klanten** → **Nieuwe klant**.
2. Vul klantnaam, slug (leeg = voorstel uit de naam), naam en e-mail van de
   accounteigenaar en het LinkedIn-abonnement in. Laat **Abonnement vereist** aan, behalve
   voor MARKaaS, IPknowledge en TAG (SPEC §14.4).
3. De volgende pagina toont de koppellink (`<PUBLIC_BASE_URL>/koppelen/<token>`) en een
   voorbeeldmail. **Kopieer ze meteen**: de link is daarna niet meer op te vragen (alleen een
   hash staat in de database). Plak de mail in je eigen mailprogramma en verstuur hem.
4. De link is 7 dagen geldig (`config/juridisch.json`) en werkt één keer. De eigenaar leest de
   uitleg, vult naam en e-mail in, zet drie vinkjes en gaat door naar de inlogpagina van
   Unipile. De toestemming staat dan in `account_consents`.
5. Na het inloggen stuurt Unipile de eigenaar naar `/koppelen/klaar` (of `/koppelen/mislukt`)
   en meldt de koppeling via de webhook; het account gaat dan van `CONNECTING` naar `OK`.
6. Verlopen of kwijt? Klik bij het account in **Klanten** op **Nieuwe koppellink**. De vorige
   link vervalt daarmee.

Nieuwe versie van de voorwaarden of verwerkersovereenkomst: pas `versie` (en eventueel
`url`) aan in `config/juridisch.json`. Lege `url` = de pagina meldt dat MARKaaS het document
meestuurt.

## Klantgebruiker uitnodigen (SPEC §14.3)

1. Log in op `/admin/`, kies **Klanten** en klik op de naam van de klant
   (`/admin/klanten/<slug>`).
2. Vul onder **Gebruiker uitnodigen** naam en e-mail in. Een e-mailadres kan maar bij één
   klant horen.
3. De volgende pagina toont de uitnodigingslink (`<PUBLIC_BASE_URL>/portaal/uitnodiging/<token>`)
   en een voorbeeldmail. **Kopieer ze meteen**: de link is daarna niet meer op te vragen. De
   link is 7 dagen geldig (`config/juridisch.json`) en werkt één keer.
4. De gebruiker kiest via de link een wachtwoord (minimaal 12 tekens) en is daarna ingelogd op
   `/portaal/`. Daar keurt hij concepten van de accounts van zijn eigen klant goed of af
   (`goedgekeurd_door`/`afgewezen_door` = `klant:<e-mail>`) en ziet hij onder **Resultaten**
   per account en per week de verstuurde verzoeken, acceptaties en reacties. Is een account
   niet (meer) gekoppeld, dan kan hij daar zelf een (her)koppellink starten.
5. **Wachtwoord vergeten:** klik bij de gebruiker op **Nieuwe link** en stuur die door. De
   vorige link vervalt; het nieuwe wachtwoord logt alle oude sessies uit.
6. **Toegang intrekken:** **Deactiveren** logt de gebruiker direct overal uit en maakt open
   links ongeldig. **Activeren met nieuwe link** geeft weer toegang (met een nieuw wachtwoord).

## Scripts

- `npm start` — start de gateway (hono-server met `/health`, `/webhooks/*`,
  `/mcp`, `/admin/*`, `/koppelen/*`, `/portaal/*`, plus de planner-lus als `PLANNER_ENABLED=true`). Dit is
  het startcommando op Railway; zie [docs/uitrol-railway.md](docs/uitrol-railway.md).
- `npm run dev` — hetzelfde, maar leest lokaal `.env`.
- `npm test` — alle tests tegen PGlite.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run db:check` — alleen-lezen verbindingstest tegen Supabase.
- `npm run migrate -- --dry-run` — toont openstaande migraties, wijzigt niets.
- `npm run migrate` — voert openstaande migraties uit (alleen na akkoord van Rubert).
- `npm run admin:hash` — vraagt tweemaal een wachtwoord (verborgen invoer) en
  toont de regel voor `ADMIN_PASSWORD_HASH` in `.env`.
- `npm run -s dev:demo` — start de goedkeuringspagina lokaal op PGlite
  in-memory met demodata (1 klant "Demo", 1 account "Rubert (demo)", 3
  concepten en 1 onzeker-actie). Geen Supabase, geen Unipile, geen planner
  of worker. Alleen `ADMIN_PASSWORD_HASH` komt uit `.env`. Toont één regel:
  het adres om te openen.

Eigenaar: Rubert Rietkerk, MARKaaS.
