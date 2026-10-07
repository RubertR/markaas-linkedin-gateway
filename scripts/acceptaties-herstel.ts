/**
 * CLI: verwerk new_relation-events die binnenkwamen toen de gateway
 * `user_provider_id` nog niet las (fix 7 okt 2026). Registreert de acceptatie
 * en zet de lopende sequentie op 'geaccepteerd', zodat stap 2 wordt ingepland.
 * Raakt de teller openstaande_verzoeken niet (die is toen al verlaagd).
 * Standaard een dry-run; alleen met --uitvoeren wordt er geschreven.
 *
 * Gebruik:
 *   npm run acceptaties:herstel                (dry-run)
 *   npm run acceptaties:herstel -- --uitvoeren
 */

import { systeemKlok } from '../src/budget/klok.ts';
import { laadLimieten } from '../src/budget/limits.ts';
import { postgresBackend } from '../src/db/postgres-backend.ts';
import { systeemWerkdagenKiezer } from '../src/sequences/wachttijd.ts';
import { herstelGemisteAcceptaties } from '../src/webhooks/acceptatie-herstel.ts';

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
    const regels = await herstelGemisteAcceptaties(db, limieten, systeemKlok, systeemWerkdagenKiezer, {
      uitvoeren,
    });
    if (regels.length === 0) {
      process.stdout.write('Geen new_relation-events gevonden; niets te doen.\n');
      return;
    }
    const kop = uitvoeren ? 'Verwerkt' : 'Plan (dry-run; --uitvoeren om te schrijven)';
    process.stdout.write(`${kop} (${regels.length} events):\n`);
    for (const r of regels) {
      const lead = r.leadNaam ? ` ${r.leadNaam}` : '';
      const seq = r.sequentieId ? ` [sequentie ${r.sequentieId}]` : '';
      process.stdout.write(`  - ${r.ontvangenOp}${lead}${seq}: ${r.uitkomst}\n`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`acceptaties:herstel-fout: ${bericht}\n`);
  process.exit(1);
});
