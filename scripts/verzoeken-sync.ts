/**
 * CLI: zet `openstaande_verzoeken` per gekoppeld account nu gelijk aan het
 * aantal openstaande invites volgens Unipile (SPEC §5a). Eén lichte GET per
 * account (`GET /api/v1/users/invite/sent`; twee bij meer dan 250 openstaand).
 *
 * Standaard een dry-run: de GET gebeurt wel, er wordt niets geschreven.
 * Alleen met --uitvoeren gaat de teller om en telt dit als de sync van
 * vandaag (de planner doet dan vandaag geen tweede GET). Alleen accounts met
 * status OK/RECONNECTED, buiten afkoeling, op een werkdag binnen het
 * tijdvenster van het account. Toont geen leadgegevens.
 *
 * Gebruik:
 *   npm run verzoeken:sync                (dry-run)
 *   npm run verzoeken:sync -- --uitvoeren
 */

import { systeemKlok } from '../src/budget/klok.ts';
import { laadLimieten } from '../src/budget/limits.ts';
import { syncVerzoekenNu } from '../src/budget/verzoekensync.ts';
import { postgresBackend } from '../src/db/postgres-backend.ts';
import { unipileBaseUrl } from '../src/server/app.ts';
import { maakUnipileClient } from '../src/unipile/client.ts';

function verplicht(naam: string, uitleg: string): string {
  const waarde = process.env[naam];
  if (!waarde || waarde.trim() === '') {
    throw new Error(`${naam} ontbreekt. ${uitleg}`);
  }
  return waarde;
}

async function main(): Promise<void> {
  const uitvoeren = process.argv.includes('--uitvoeren');
  const databaseUrl = verplicht('DATABASE_URL', 'Zet hem in .env (Supabase Session pooler, poort 5432).');
  const dsn = verplicht('UNIPILE_DSN', 'Zet hem in .env (zie .env.example).');
  const apiKey = verplicht('UNIPILE_API_KEY', 'Zet hem in .env (zie .env.example).');

  const limieten = await laadLimieten();
  const db = postgresBackend({ databaseUrl });
  const unipile = maakUnipileClient({ baseUrl: unipileBaseUrl(dsn), apiKey });

  try {
    const uit = await syncVerzoekenNu({ db, unipile, limieten, klok: systeemKlok }, { uitvoeren });
    const namen = new Map(
      (await db.query<{ id: string; eigenaar_naam: string }>('select id, eigenaar_naam from accounts'))
        .map((r) => [r.id, r.eigenaar_naam]),
    );
    if (uit.resultaten.length === 0 && !uit.gatewayGestopt) {
      process.stdout.write('Geen gekoppelde accounts; niets te doen.\n');
      return;
    }
    process.stdout.write(
      uitvoeren ? 'Uitgevoerd:\n' : 'Dry-run (niets geschreven; --uitvoeren om te schrijven):\n',
    );
    for (const r of uit.resultaten) {
      process.stdout.write(
        `  - ${r.accountId} (${namen.get(r.accountId) ?? '?'})  ${r.resultaat}: ${r.reden}\n`,
      );
    }
    if (uit.gatewayGestopt) {
      process.stdout.write(
        'Gestopt: Unipile weigert de API-sleutel (401/403). Controleer UNIPILE_API_KEY; overige accounts niet bekeken.\n',
      );
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`verzoeken:sync-fout: ${bericht}\n`);
  process.exit(1);
});
