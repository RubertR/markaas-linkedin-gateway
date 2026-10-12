/**
 * CLI: herstel eerste berichten (stap 2) die mislukten met een 404 "Chat not
 * found" omdat de gateway een placeholder-gesprek `pending:…` gebruikte (fix
 * 12 okt 2026). Maakt per sequentie een nieuwe `draft` voor stap 2; de worker
 * start na goedkeuring een nieuw gesprek met de providerId. Zet nooit iets op
 * `approved`: elke draft moet op de goedkeuringspagina goedgekeurd worden.
 * Standaard een dry-run; alleen met --uitvoeren wordt er geschreven.
 *
 * Gebruik:
 *   npm run berichten:herstel                (dry-run)
 *   npm run berichten:herstel -- --uitvoeren
 */

import { systeemKlok } from '../src/budget/klok.ts';
import { laadLimieten } from '../src/budget/limits.ts';
import { postgresBackend } from '../src/db/postgres-backend.ts';
import { herstelMislukteEersteBerichten } from '../src/sequences/herstel.ts';
import { systeemWerkdagenKiezer } from '../src/sequences/wachttijd.ts';

function leesDatabaseUrl(): string {
  const waarde = process.env['DATABASE_URL'];
  if (!waarde || waarde.trim() === '') {
    throw new Error(
      'DATABASE_URL ontbreekt. Zet hem in .env (Supabase Session pooler, poort 5432).',
    );
  }
  return waarde;
}

async function main(): Promise<void> {
  const uitvoeren = process.argv.includes('--uitvoeren');
  const limieten = await laadLimieten();
  const db = postgresBackend({ databaseUrl: leesDatabaseUrl() });

  try {
    const regels = await herstelMislukteEersteBerichten(
      db,
      { klok: systeemKlok, limieten, werkdagen: systeemWerkdagenKiezer },
      { uitvoeren },
    );
    if (regels.length === 0) {
      process.stdout.write('Geen mislukte eerste berichten op een placeholder-gesprek; niets te doen.\n');
      return;
    }
    const kop = uitvoeren
      ? 'Nieuwe draft aangemaakt (goedkeuren op de goedkeuringspagina)'
      : 'Plan (dry-run; --uitvoeren om te schrijven)';
    process.stdout.write(`${kop} (${regels.length}):\n`);
    for (const r of regels) {
      const nieuw = r.nieuweActieId ? ` → nieuwe draft ${r.nieuweActieId}` : '';
      const status = uitvoeren && !r.uitgevoerd ? ' [overgeslagen: intussen gewijzigd]' : '';
      process.stdout.write(
        `  - sequentie ${r.sequentieId}, mislukte actie ${r.misluktActieId}${nieuw}${status}\n`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`berichten:herstel-fout: ${bericht}\n`);
  process.exit(1);
});
