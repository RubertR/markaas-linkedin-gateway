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
import { startSequentie } from '../src/sequences/motor.ts';
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
  const klant = await maakClient(db, { naam: 'Demo', slug: 'demo', abonnementVereist: false });
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
      ontvanger_naam: 'Nina Jansen',
      ontvanger_functie: 'Head of Marketing',
      ontvanger_bedrijf: 'Acme Logistics',
      ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
      waarom:
        'Afkomstig uit zoekactie "logistiek marketing" op Sales Navigator (actie S-2026-10-01-003). ' +
        'Score 0.82 — werkt sinds 2024 bij Acme, groei van 20 naar 65 FTE.',
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
      ontvanger_naam: 'Leo Bakker',
      ontvanger_functie: 'Head of Growth',
      ontvanger_bedrijf: 'Finbase',
      ontvanger_url: 'https://www.linkedin.com/in/leo-bakker/',
      waarom:
        'Opvolgbericht: Leo accepteerde ons connectieverzoek op 29 sep. Nog geen reactie ' +
        'op het verzoek met notitie — nu een kort follow-up met een concrete haak (de lezing).',
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
      ontvanger_naam: 'Pieter Vermeulen',
      ontvanger_functie: 'Sales Director',
      ontvanger_bedrijf: 'Trident BV',
      ontvanger_url: 'https://www.linkedin.com/in/pieter-vermeulen/',
      waarom:
        'Pieter past bij ons ICP (B2B SaaS, 25-100 FTE, Pipedrive) en reageerde eerder dit ' +
        'jaar op een branchepost over funnel-optimalisatie. InMail-tegoed vandaag beschikbaar.',
      _skill: 'onderzoeker',
    },
  });

  // Eén lopende sequentie (ronde 3): stap 1 (invite) staat als draft op de
  // goedkeuringspagina met het "Stap 1 van 3 · sequentie gestart op …"-blok.
  await startSequentie(db, {
    accountId: account.id,
    lead: {
      providerId: 'ACo-eva-de-boer',
      naam: 'Eva de Boer',
      functie: 'Chief Marketing Officer',
      bedrijf: 'Veldstra Logistiek',
      linkedinUrl: 'https://www.linkedin.com/in/eva-de-boer/',
      waarom:
        'Afkomstig uit zoekactie "logistiek CMO" (actie S-2026-10-01-004). ' +
        'Score 0.88 — Veldstra breidt uit richting B2B SaaS; dit is stap 1 van 3.',
    },
    teksten: {
      invite:
        'Hoi Eva, ik volg Veldstra sinds jullie uitbreiding naar B2B SaaS. ' +
        'Zullen we even sparren over marketing-automatisering voor MKB-logistiek?',
      bericht:
        'Hoi Eva, dank voor de connectie! Je gaf laatst een interview over ' +
        'account-based marketing — ik ben benieuwd welke onderdelen jullie zelf doen.',
      opvolging:
        'Hoi Eva, nog even een korte reminder — mocht het beter uitkomen om later ' +
        'te sparren, dan hoor ik dat ook graag.',
    },
  });

  // Eén onzeker-actie — simuleert een time-out tijdens verzenden.
  const onzeker = await maakActie(db, {
    accountId: account.id,
    type: 'invite',
    payload: {
      providerId: 'ACo-marieke-visser',
      message: 'Hoi Marieke, zullen we even sparren over jullie account-based marketing?',
      ontvanger_naam: 'Marieke Visser',
      ontvanger_functie: 'Marketing Director',
      ontvanger_bedrijf: 'Northline',
      ontvanger_url: 'https://www.linkedin.com/in/marieke-visser/',
      waarom:
        'Afkomstig uit zoekactie "ABM mkb Nederland" (actie S-2026-09-30-012). ' +
        'Score 0.74 — paste in jouw ICP maar time-out tijdens verzenden; controleer handmatig.',
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
