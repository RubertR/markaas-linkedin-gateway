import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import type { KoppelflowOpties } from '../register/koppelflow.ts';
import {
  markeerAccountGekoppeld,
  registreerAccount,
} from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';
import { verwerkUnipileWebhook } from '../webhooks/unipile.ts';

import { startSequentie, vindSequentie } from './motor.ts';
import { vasteWerkdagen } from './wachttijd.ts';

const UNIPILE_ID = 'uni-rubert-hooks';
const KOPPEL: KoppelflowOpties = {
  notifyUrl: 'https://gateway.markaas.test/webhooks/koppel',
  apiUrl: 'https://api.markaas.test',
};

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;

before(async () => {
  const op = await verseDatabaseMetMigraties();
  db = op.db;
  close = op.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const klant = await maakClient(db, { naam: 'T', slug: 't' });
  const account = await registreerAccount(db, {
    clientId: klant.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ID);
});

describe('Unipile-webhook met sequentie-hook', () => {
  it('new_relation zet een lopende sequentie op geaccepteerd', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead uit zoekactie',
      },
      teksten: {
        invite: 'Hoi Sven',
        bericht: 'Dank voor connectie',
        opvolging: 'Nog even een reminder',
      },
    });

    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z'));
    const resultaat = await verwerkUnipileWebhook(
      db,
      unipile,
      KOPPEL,
      {
        event: 'new_relation',
        account_id: UNIPILE_ID,
        attendee_provider_id: 'ACo-sven',
        timestamp: '2026-10-05T09:00:00Z',
      },
      { db, limieten, klok, werkdagen: vasteWerkdagen(2) },
    );
    assert.equal(resultaat.verwerkt, true);

    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'geaccepteerd');
    assert.equal(seq?.stap, 1);
  });

  it('dubbele new_relation binnen tien minuten bumpt stap niet twee keer (events-dedup)', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead',
      },
      teksten: {
        invite: 'Hoi',
        bericht: 'Dank',
        opvolging: 'Reminder',
      },
    });
    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z'));
    const payload = {
      event: 'new_relation' as const,
      account_id: UNIPILE_ID,
      attendee_provider_id: 'ACo-sven',
      timestamp: '2026-10-05T09:00:00Z',
    };
    await verwerkUnipileWebhook(db, unipile, KOPPEL, payload, {
      db,
      limieten,
      klok,
      werkdagen: vasteWerkdagen(2),
    });
    // Tweede keer: dezelfde payload → events-dedup moet het blokkeren.
    await verwerkUnipileWebhook(db, unipile, KOPPEL, payload, {
      db,
      limieten,
      klok,
      werkdagen: vasteWerkdagen(5), // andere waarde — mag geen effect hebben
    });
    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.stap, 1);
    assert.equal(seq?.status, 'geaccepteerd');
  });

  it('message_received (is_sender=false) zet sequentie op reactie', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead',
      },
      teksten: {
        invite: 'Hoi',
        bericht: 'Dank',
        opvolging: 'Reminder',
      },
    });
    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z'));
    await verwerkUnipileWebhook(
      db,
      unipile,
      KOPPEL,
      {
        event: 'message_received',
        account_id: UNIPILE_ID,
        chat_id: 'C-abc',
        message_id: 'M-1',
        is_sender: false,
        sender: { attendee_provider_id: 'ACo-sven' },
      },
      { db, limieten, klok, werkdagen: vasteWerkdagen(2) },
    );
    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'reactie');
  });

  it('message_received (is_sender=true, eigen bericht) laat sequentie met rust', async () => {
    const uit = await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead',
      },
      teksten: {
        invite: 'Hoi',
        bericht: 'Dank',
        opvolging: 'Reminder',
      },
    });
    const klok = vasteKlok(new Date('2026-10-05T09:00:00Z'));
    await verwerkUnipileWebhook(
      db,
      unipile,
      KOPPEL,
      {
        event: 'message_received',
        account_id: UNIPILE_ID,
        chat_id: 'C-abc',
        message_id: 'M-eigen',
        is_sender: true,
      },
      { db, limieten, klok, werkdagen: vasteWerkdagen(2) },
    );
    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'lopend');
  });
});
