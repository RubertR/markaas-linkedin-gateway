/**
 * CLI om de drie Unipile-webhooks van de gateway aan te maken (accountstatus,
 * messaging, relaties), met het webhook-geheim als header. Standaard een
 * dry-run; alleen met --uitvoeren wordt er echt iets aangemaakt. Idempotent
 * op naam. Geheim en API-sleutel worden nooit getoond.
 *
 * Gebruik:
 *   npm run webhooks:registreer -- --env-file .env.railway            (dry-run)
 *   npm run webhooks:registreer -- --env-file .env.railway --uitvoeren
 */

import { unipileBaseUrl } from '../src/server/app.ts';
import { maakUnipileClient } from '../src/unipile/client.ts';
import { draaiRegistratie } from '../src/webhooks/registratie.ts';

const REQUEST_URL = 'https://markaas-linkedin-gateway-production.up.railway.app/webhooks/unipile';

draaiRegistratie(process.argv.slice(2), {
  requestUrl: REQUEST_URL,
  maakClient: (env) =>
    maakUnipileClient({ baseUrl: unipileBaseUrl(env.unipileDsn), apiKey: env.unipileApiKey }),
})
  .then((uitvoer) => {
    process.stdout.write(`${uitvoer}\n`);
  })
  .catch((err: unknown) => {
    const bericht = err instanceof Error ? err.message : String(err);
    process.stderr.write(`webhooks:registreer-fout: ${bericht}\n`);
    process.exit(1);
  });
