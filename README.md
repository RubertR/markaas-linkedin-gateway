# MARKaaS LinkedIn-gateway

Een dienst tussen de Claude-skills van MARKaaS en de Unipile-API. Hij bewaakt per
LinkedIn-account een budget, laat niets versturen zonder goedkeuring en houdt per klant bij
welke accounts werken.

**Status:** fase 3 (eigen proef) ronde 1 afgerond op 1 okt 2026 — de
MCP-server draait op `/mcp` met de zeven tools uit SPEC §7 (geen tool
goedkeurt of verstuurt). 291 tests groen op `node --test` tegen PGlite;
migratie `0001_init.sql` eerder toegepast op Supabase (Frankfurt,
`eu-central-1`, project-ref `uujvmoqsalpgshptiljy`). Volgende rondes:
goedkeuringspagina → sequenties → uitrol op Railway (zie
[docs/fase-3-plan.md](docs/fase-3-plan.md)).

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

Eigenaar: Rubert Rietkerk, MARKaaS.
