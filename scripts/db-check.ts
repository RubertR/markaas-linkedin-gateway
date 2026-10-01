import { postgresBackend } from '../src/db/postgres-backend.ts';

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
  const databaseUrl = leesDatabaseUrl();
  const db = postgresBackend({ databaseUrl });

  try {
    const [versie] = await db.query<{ version: string }>('select version() as version');
    const [huidig] = await db.query<{ database: string }>(
      'select current_database() as database',
    );
    const tabellen = await db.query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by tablename",
    );

    process.stdout.write('Verbinding werkt.\n');
    process.stdout.write(`Postgres  : ${versie?.version ?? '(onbekend)'}\n`);
    process.stdout.write(`Database  : ${huidig?.database ?? '(onbekend)'}\n`);
    if (tabellen.length === 0) {
      process.stdout.write('Tabellen in schema public: (geen)\n');
    } else {
      process.stdout.write(`Tabellen in schema public (${tabellen.length}):\n`);
      for (const rij of tabellen) process.stdout.write(`  - ${rij.tablename}\n`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`db:check-fout: ${bericht}\n`);
  process.exit(1);
});
