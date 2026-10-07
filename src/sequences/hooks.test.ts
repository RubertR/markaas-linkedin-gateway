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
import { herstelGemisteAcceptaties } from '../webhooks/acceptatie-herstel.ts';

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

describe('acceptatie via het eerste eigen bericht (sequentie-hook)', () => {
  const HOOK = () => ({
    db,
    limieten,
    klok: vasteKlok(new Date('2026-10-05T09:00:00Z')),
    werkdagen: vasteWerkdagen(2),
  });

  function eigenBericht(messageId: string) {
    return {
      event: 'message_received',
      account_id: UNIPILE_ID,
      chat_id: 'C-nieuw',
      message_id: messageId,
      is_sender: true,
      sender: { attendee_provider_id: 'ACo-onszelf' },
      attendees: [
        { attendee_provider_id: 'ACo-onszelf' },
        { attendee_provider_id: 'ACo-sven' },
      ],
    };
  }

  async function sequentieMetVerstuurdeInvite() {
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
      teksten: { invite: 'Hoi', bericht: 'Dank', opvolging: 'Reminder' },
    });
    await db.query(
      `update actions set status = 'done' where sequence_id = $1 and type = 'invite'`,
      [uit.sequentie.id],
    );
    return uit.sequentie.id;
  }

  it('eerste eigen bericht zet de sequentie op geaccepteerd', async () => {
    const id = await sequentieMetVerstuurdeInvite();
    await verwerkUnipileWebhook(db, unipile, KOPPEL, eigenBericht('M-1'), HOOK());
    const seq = await vindSequentie(db, id);
    assert.equal(seq?.status, 'geaccepteerd');
    assert.equal(seq?.stap, 1);
  });

  it('latere new_relation verschuift de planning van stap 2 niet', async () => {
    const id = await sequentieMetVerstuurdeInvite();
    await verwerkUnipileWebhook(db, unipile, KOPPEL, eigenBericht('M-1'), HOOK());
    const voor = await vindSequentie(db, id);
    await verwerkUnipileWebhook(
      db,
      unipile,
      KOPPEL,
      {
        event: 'new_relation',
        account_id: UNIPILE_ID,
        attendee_provider_id: 'ACo-sven',
        timestamp: '2026-10-05T12:00:00Z',
      },
      { ...HOOK(), klok: vasteKlok(new Date('2026-10-07T09:00:00Z')), werkdagen: vasteWerkdagen(5) },
    );
    const na = await vindSequentie(db, id);
    assert.equal(na?.status, 'geaccepteerd');
    assert.deepEqual(na?.volgendeActieOp, voor?.volgendeActieOp);
  });

  it('eigen berichten stoppen de sequentie nooit', async () => {
    const id = await sequentieMetVerstuurdeInvite();
    await verwerkUnipileWebhook(db, unipile, KOPPEL, eigenBericht('M-1'), HOOK());
    await verwerkUnipileWebhook(db, unipile, KOPPEL, eigenBericht('M-2'), HOOK());
    const seq = await vindSequentie(db, id);
    assert.equal(seq?.status, 'geaccepteerd');
  });
});

const LEAD_ECHT = {
  providerId: 'ACoAAGC-echte-lead',
  naam: 'Guus',
  functie: 'Export Sales Manager',
  bedrijf: 'Bravilor',
  linkedinUrl: 'https://www.linkedin.com/in/guus/',
  waarom: 'Trigger: export',
};
const TEKSTEN = { invite: 'Hoi Guus', bericht: 'Dank voor het connecten', opvolging: 'Nog een vraag' };

/** Payload zoals Unipile hem echt levert (docs "Detecting accepted invitations"). */
function echteNewRelation(providerId: string) {
  return {
    event: 'new_relation',
    account_id: UNIPILE_ID,
    account_type: 'LINKEDIN',
    webhook_name: 'gateway-relaties',
    user_full_name: 'Guus V',
    user_provider_id: providerId,
    user_public_identifier: 'guus',
    user_profile_url: 'https://www.linkedin.com/in/guus/',
    user_picture_url: null,
  };
}

describe('new_relation met de echte Unipile-payload (user_provider_id)', () => {
  it('zet de lopende sequentie op geaccepteerd', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD_ECHT, teksten: TEKSTEN });
    const klok = vasteKlok(new Date('2026-10-07T09:00:00Z'));
    const resultaat = await verwerkUnipileWebhook(db, unipile, KOPPEL, echteNewRelation(LEAD_ECHT.providerId), {
      db, limieten, klok, werkdagen: vasteWerkdagen(2),
    });
    assert.equal(resultaat.verwerkt, true);
    const seq = await vindSequentie(db, uit.sequentie.id);
    assert.equal(seq?.status, 'geaccepteerd');
    assert.equal(seq?.stap, 1);
  });

  it('herstel: oud opgeslagen event zonder acceptatie wordt alsnog verwerkt (dry-run schrijft niets)', async () => {
    const uit = await startSequentie(db, { accountId, lead: LEAD_ECHT, teksten: TEKSTEN });
    await db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('unipile', 'new_relation', 'oud-zonder-acceptatie', $1, $2::jsonb)`,
      [accountId, JSON.stringify(echteNewRelation(LEAD_ECHT.providerId))],
    );
    await db.query('update accounts set openstaande_verzoeken = 4 where id = $1', [accountId]);
    const klok = vasteKlok(new Date('2026-10-07T09:00:00Z'));

    const plan = await herstelGemisteAcceptaties(db, limieten, klok, vasteWerkdagen(1), { uitvoeren: false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]?.sequentieId, uit.sequentie.id);
    assert.equal((await vindSequentie(db, uit.sequentie.id))?.status, 'lopend');

    const echt = await herstelGemisteAcceptaties(db, limieten, klok, vasteWerkdagen(1), { uitvoeren: true });
    assert.equal(echt[0]?.uitgevoerd, true);
    assert.equal((await vindSequentie(db, uit.sequentie.id))?.status, 'geaccepteerd');

    const teller = await db.query<{ n: number }>('select openstaande_verzoeken as n from accounts where id = $1', [accountId]);
    assert.equal(Number(teller[0]?.n), 4, 'herstel raakt de teller niet');

    const nogmaals = await herstelGemisteAcceptaties(db, limieten, klok, vasteWerkdagen(1), { uitvoeren: true });
    assert.equal(nogmaals[0]?.uitgevoerd, false);
    assert.match(nogmaals[0]?.uitkomst ?? '', /al geregistreerd/i);
  });
});
