import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { draaiMigraties, planMigraties } from '../src/db/migrator.ts';
import { postgresBackend } from '../src/db/postgres-backend.ts';

const HIER = dirname(fileURLToPath(import.meta.url));
const MIGRATIE_MAP = join(HIER, '..', 'db', 'migrations');

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
  const dryRun = process.argv.includes('--dry-run');
  const databaseUrl = leesDatabaseUrl();
  const db = postgresBackend({ databaseUrl });

  try {
    if (dryRun) {
      const openstaand = await planMigraties(db, MIGRATIE_MAP);
      if (openstaand.length === 0) {
        process.stdout.write('Geen openstaande migraties.\n');
      } else {
        process.stdout.write(`Zouden draaien (${openstaand.length}):\n`);
        for (const naam of openstaand) process.stdout.write(`  - ${naam}\n`);
      }
      return;
    }
    const toegepast = await draaiMigraties(db, MIGRATIE_MAP);
    if (toegepast.length === 0) {
      process.stdout.write('Niets te doen; database is bij.\n');
    } else {
      process.stdout.write(`Toegepast (${toegepast.length}):\n`);
      for (const naam of toegepast) process.stdout.write(`  - ${naam}\n`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Migratie-fout: ${bericht}\n`);
  process.exit(1);
});
