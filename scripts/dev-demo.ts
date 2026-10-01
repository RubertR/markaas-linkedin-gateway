/**
 * Lokale rooktest voor de goedkeuringspagina (SPEC §12). Draait de admin-
 * app op PGlite in-memory met demodata, zonder planner/worker en zonder
 * contact met de echte Unipile of Supabase. Alleen `ADMIN_PASSWORD_HASH`
 * komt uit `.env`.
 *
 * Gebruik: `npm run dev:demo`
 *
 * Doel: Rubert kan handmatig door de goedkeuringspagina lopen (login,
 * concepten, batch-goedkeuren, afwijzen, onzeker-knoppen) zonder dat er
 * iets echt verzonden wordt.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';

import { maakAdminApp } from '../src/admin/server.ts';
import { systeemKlok } from '../src/budget/klok.ts';
import { laadLimieten } from '../src/budget/limits.ts';
import { pgliteBackend } from '../src/db/pglite-backend.ts';
import { draaiMigraties } from '../src/db/migrator.ts';
import { maakActie } from '../src/queue/acties.ts';
import {
  markeerAccountGekoppeld,
  registreerAccount,
} from '../src/register/accounts.ts';
import { maakClient } from '../src/register/clients.ts';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HIER = dirname(fileURLToPath(import.meta.url));
const MIGRATIE_MAP = join(HIER, '..', 'db', 'migrations');

function leesWachtwoordHash(): string {
  const w = process.env['ADMIN_PASSWORD_HASH'];
  if (!w || w.trim() === '') {
    throw new Error(
      'ADMIN_PASSWORD_HASH ontbreekt. Maak er een met `npm run admin:hash` en zet hem in .env.',
    );
  }
  return w;
}

async function zaaiDemodata(db: Awaited<ReturnType<typeof pgliteBackend>>): Promise<void> {
  const klant = await maakClient(db, { naam: 'Demo', slug: 'demo' });
  const account = await registreerAccount(db, {
    clientId: klant.id,
    eigenaarNaam: 'Rubert (demo)',
    abonnement: 'salesnav_core',
  });
  await markeerAccountGekoppeld(db, account.id, 'uni-demo-rubert');
  // Opbouw op 1.0 zodat de budget-weergave bij invite 20/dag toont i.p.v. 10.
  await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [account.id]);

  await maakActie(db, {
    accountId: account.id,
    type: 'invite',
    payload: {
      providerId: 'ACo-nina-jansen',
      message:
        'Hoi Nina, we helpen MKB-marketeers met LinkedIn-outreach dat niet als spam voelt. ' +
        'Zullen we even sparren of het bij jullie past?',
      _skill: 'leadworker',
    },
  });
  await maakActie(db, {
    accountId: account.id,
    type: 'message',
    payload: {
      chatId: 'C-leo-bakker',
      tekst:
        'Dag Leo, dank voor de connectie! Je gaf vorige week een lezing over account-based ' +
        'marketing — stuur je me die slides?',
      _skill: 'opvolgwerker',
    },
  });
  await maakActie(db, {
    accountId: account.id,
    type: 'inmail',
    payload: {
      attendeesIds: ['ACo-pieter-vermeulen'],
      onderwerp: 'Korte vraag over jullie B2B-funnel',
      tekst:
        'Hoi Pieter, ik werk aan een gereedschapsset voor B2B-funnels in Pipedrive. ' +
        'Zou je 15 minuten vrij hebben om jullie aanpak te horen?',
      _skill: 'onderzoeker',
    },
  });

  // Eén onzeker-actie — simuleert een time-out tijdens verzenden.
  const onzeker = await maakActie(db, {
    accountId: account.id,
    type: 'invite',
    payload: {
      providerId: 'ACo-marieke-visser',
      message: 'Hoi Marieke, zullen we even sparren over jullie account-based marketing?',
      _skill: 'leadworker',
    },
  });
  await db.query(
    `update actions
     set status = 'onzeker'::action_status,
         reden = 'Time-out tijdens verzenden; mogelijk wél bij LinkedIn aangekomen.'
     where id = $1`,
    [onzeker.id],
  );
}

async function main(): Promise<void> {
  const wachtwoordHash = leesWachtwoordHash();
  const limieten = await laadLimieten();

  const pg = new PGlite();
  const db = pgliteBackend(pg);
  await draaiMigraties(db, MIGRATIE_MAP);
  await zaaiDemodata(db);

  const adminApp = maakAdminApp({
    db,
    limieten,
    klok: systeemKlok,
    wachtwoordHash,
    cookieSecure: false, // lokaal via HTTP; in productie staat Railway op TLS
  });

  const app = new Hono();
  app.route('/', adminApp);
  app.get('/', (c) => c.redirect('/admin/login', 303));

  const poort = Number(process.env['PORT'] ?? '3000');
  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: poort }, () => {
      process.stdout.write(`http://localhost:${poort}/admin/login\n`);
      resolve();
    });
  });
}

main().catch((err: unknown) => {
  const bericht = err instanceof Error ? err.message : String(err);
  process.stderr.write(`dev:demo-fout: ${bericht}\n`);
  process.exit(1);
});
