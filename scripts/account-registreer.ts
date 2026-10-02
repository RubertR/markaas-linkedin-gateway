/**
 * CLI om een klant en een al bij Unipile gekoppeld account te registreren.
 * Status OK, opbouw_factor 0.5, tijdzone Europe/Amsterdam. Idempotent.
 * Meldingen gaan naar stderr; stdout bevat alleen het interne account-id.
 *
 * Gebruik:
 *   npm run account:registreer -- --klant "MARKaaS" --eigenaar "Rubert Rietkerk" \
 *     --unipile-id <id> --abonnement salesnav_core [--dry-run]
 */

import { postgresBackend } from '../src/db/postgres-backend.ts';
import {
  parseerArgumenten,
  registreerKlantEnAccount,
  type Stap,
} from '../src/register/registreer.ts';

const TEKST: Record<Stap, string> = {
  aangemaakt: 'aangemaakt',
  bestaat_al: 'bestaat al',
  zou_aanmaken: 'zou worden aangemaakt (dry-run)',
};

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
  const { invoer, dryRun } = parseerArgumenten(process.argv.slice(2));
  const db = postgresBackend({ databaseUrl: leesDatabaseUrl() });

  try {
    const uitkomst = await registreerKlantEnAccount(db, invoer, { dryRun });
    if (dryRun) process.stderr.write('Dry-run: er is niets geschreven.\n');
    process.stderr.write(`Klant "${invoer.klant}": ${TEKST[uitkomst.klant]}.\n`);
    process.stderr.write(`Account: ${TEKST[uitkomst.account]}.\n`);
    if (uitkomst.accountId) process.stdout.write(`${uitkomst.accountId}\n`);
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`account:registreer-fout: ${bericht}\n`);
  process.exit(1);
});
