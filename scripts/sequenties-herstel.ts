/**
 * CLI: zet sequenties die nog 'lopend'/'geaccepteerd' staan terwijl een stap
 * al is afgewezen op 'gestopt' (SPEC §8a). Standaard een dry-run die alleen
 * toont wat er zou veranderen; alleen met --uitvoeren wordt er geschreven.
 * Toont sequentie-id's en afwijzingsredenen, geen leadgegevens.
 *
 * Gebruik:
 *   npm run sequenties:herstel                (dry-run)
 *   npm run sequenties:herstel -- --uitvoeren
 */

import { laadLimieten } from '../src/budget/limits.ts';
import { postgresBackend } from '../src/db/postgres-backend.ts';
import { herstelAfgewezenSequenties } from '../src/sequences/herstel.ts';

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
    const regels = await herstelAfgewezenSequenties(db, limieten, { uitvoeren });
    if (regels.length === 0) {
      process.stdout.write('Geen lopende sequenties met een afgewezen stap; niets te doen.\n');
      return;
    }
    const kop = uitvoeren ? 'Gestopt' : 'Zouden stoppen (dry-run; --uitvoeren om te schrijven)';
    process.stdout.write(`${kop} (${regels.length}):\n`);
    for (const r of regels) {
      const status = uitvoeren && !r.uitgevoerd ? ' [overgeslagen: intussen gewijzigd]' : '';
      process.stdout.write(
        `  - ${r.sequentieId}  stap ${r.stap ?? '?'}  "${r.stopReden}"${status}\n`,
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`sequenties:herstel-fout: ${bericht}\n`);
  process.exit(1);
});
