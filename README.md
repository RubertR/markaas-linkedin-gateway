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

## Scripts

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
