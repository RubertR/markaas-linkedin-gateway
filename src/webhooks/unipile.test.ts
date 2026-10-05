import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { maakClient } from '../register/clients.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import type { KoppelflowOpties } from '../register/koppelflow.ts';

import { verwerkUnipileWebhook } from './unipile.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let accountId: string;
const UNIPILE_ACCOUNT_ID = 'unipile-abc-123';

const KOPPEL_OPTIES: KoppelflowOpties = {
  notifyUrl: 'https://gateway.markaas.test/webhooks/koppel',
  apiUrl: 'https://api68.unipile.example:19841',
};

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'geheim-hook', timeoutMs: 200 });
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

  const client = await maakClient(db, { naam: 'Test', slug: 'test' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);
});

async function tel(waar: string): Promise<number> {
  const rijen = await db.query<{ aantal: string }>(
    `select count(*)::text as aantal from ${waar}`,
  );
  return Number(rijen[0]?.aantal ?? '0');
}

describe('account_status webhook', () => {
  it('CREDENTIALS: pauzeert het account en zet een reconnect-link klaar in events', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/nieuw' },
    });

    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'credentials',
      account_id: UNIPILE_ACCOUNT_ID,
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, true);

    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'CREDENTIALS');

    const rijen = await db.query<{ payload: unknown }>(
      "select payload from events where type='reconnect_link_klaar'",
    );
    assert.equal(rijen.length, 1);
    const payload = rijen[0]?.payload as { url: string; account_id: string };
    assert.equal(payload.url, 'https://account.unipile.com/link/nieuw');
    assert.equal(payload.account_id, accountId);
  });

  it('OK: werkt status bij, geen extra actie', async () => {
    // Zet eerst op CREDENTIALS, dan OK-signaal binnen.
    await db.query("update accounts set status='CREDENTIALS' where id=$1", [accountId]);

    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'ok',
      account_id: UNIPILE_ACCOUNT_ID,
      timestamp: '2026-10-01T10:05:00Z',
    });
    assert.equal(uitkomst.verwerkt, true);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'OK');
  });

  it('onbekende Unipile-status wordt UNKNOWN in plaats van te falen', async () => {
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'iets_nieuws_dat_we_niet_kennen',
      account_id: UNIPILE_ACCOUNT_ID,
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, true);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'UNKNOWN');
  });

  it('onbekend account_id: event opgeslagen, geen crash, geen accountwijziging', async () => {
    const voor = await tel("accounts where status='OK'");
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'credentials',
      account_id: 'onbekend-unipile-id',
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.match(uitkomst.reden ?? '', /onbekend/i);
    const na = await tel("accounts where status='OK'");
    assert.equal(na, voor);
    assert.equal(await tel("events where type='account_status'"), 1);
  });
});

describe('users.new_relation webhook', () => {
  it('verlaagt openstaande_verzoeken met 1 en slaat het event op', async () => {
    await db.query('update accounts set openstaande_verzoeken = 3 where id=$1', [accountId]);

    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'new_relation',
      account_id: UNIPILE_ACCOUNT_ID,
      attendee_provider_id: 'ACo-lead-1',
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, true);

    const account = await vindAccount(db, accountId);
    assert.equal(account?.openstaandeVerzoeken, 2);
    assert.equal(await tel("events where type='new_relation'"), 1);
  });

  it('nooit onder 0: als openstaande_verzoeken al 0 is blijft het 0', async () => {
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'new_relation',
      account_id: UNIPILE_ACCOUNT_ID,
      attendee_provider_id: 'ACo-lead-2',
      timestamp: '2026-10-01T10:00:00Z',
    });
    const account = await vindAccount(db, accountId);
    assert.equal(account?.openstaandeVerzoeken, 0);
  });

  it('onbekend account: event opgeslagen, geen crash', async () => {
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'new_relation',
      account_id: 'onbekend-unipile-id',
      attendee_provider_id: 'ACo-lead-x',
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await tel("events where type='new_relation'"), 1);
  });
});

describe('messaging.message_received webhook', () => {
  it('bericht van de ander (is_sender=false): event opgeslagen', async () => {
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'message_received',
      account_id: UNIPILE_ACCOUNT_ID,
      chat_id: 'chat-1',
      message_id: 'msg-1',
      is_sender: false,
      sender: { attendee_provider_id: 'ACo-lead-1' },
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, true);
    assert.equal(await tel("events where type='message_received'"), 1);
  });

  it('eigen bericht (is_sender=true): opgeslagen als message_sent_self, telt niet als reactie', async () => {
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'message_received',
      account_id: UNIPILE_ACCOUNT_ID,
      chat_id: 'chat-1',
      message_id: 'msg-eigen-1',
      is_sender: true,
      sender: { attendee_provider_id: 'ACo-onszelf' },
      timestamp: '2026-10-01T10:00:00Z',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.match(uitkomst.reden ?? '', /eigen bericht/i);
    assert.equal(await tel("events where type='message_received'"), 0);
    assert.equal(await tel("events where type='message_sent_self'"), 1);
  });

  it('eigen bericht tweemaal geleverd levert één message_sent_self op', async () => {
    const payload = eigenBericht({ messageId: 'msg-eigen-dubbel' });
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, payload);
    const tweede = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, payload);
    assert.equal(tweede.verwerkt, false);
    assert.match(tweede.reden ?? '', /dubbel|al verwerkt/i);
    assert.equal(await tel("events where type='message_sent_self'"), 1);
  });

  it('idempotent: dezelfde message_id tweemaal levert één event op', async () => {
    const payload = {
      event: 'message_received',
      account_id: UNIPILE_ACCOUNT_ID,
      chat_id: 'chat-1',
      message_id: 'msg-dubbel',
      is_sender: false,
      sender: { attendee_provider_id: 'ACo-lead-1' },
      timestamp: '2026-10-01T10:00:00Z',
    };
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, payload);
    const tweede = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, payload);
    assert.equal(tweede.verwerkt, false);
    assert.match(tweede.reden ?? '', /dubbel|al verwerkt/i);
    assert.equal(await tel("events where type='message_received'"), 1);
  });
});

const ONSZELF = 'ACo-onszelf';
const LEAD = 'ACo-lead-1';

function eigenBericht(opties: {
  chatId?: string;
  messageId?: string;
  attendees?: string[] | null;
} = {}): Record<string, unknown> {
  const attendees = opties.attendees === undefined ? [ONSZELF, LEAD] : opties.attendees;
  return {
    event: 'message_received',
    account_id: UNIPILE_ACCOUNT_ID,
    chat_id: opties.chatId ?? 'chat-acc-1',
    message_id: opties.messageId ?? 'msg-eigen-1',
    is_sender: true,
    sender: { attendee_provider_id: ONSZELF },
    ...(attendees ? { attendees: attendees.map((id) => ({ attendee_provider_id: id })) } : {}),
    timestamp: '2026-10-01T10:00:00Z',
  };
}

async function inviteVerstuurd(providerId: string, status = 'done'): Promise<void> {
  await db.query(
    `insert into actions(account_id, type, payload, status)
     values ($1, 'invite', $2::jsonb, $3::action_status)`,
    [accountId, JSON.stringify({ providerId }), status],
  );
}

async function openstaand(): Promise<number | undefined> {
  return (await vindAccount(db, accountId))?.openstaandeVerzoeken;
}

describe('acceptatie via het eerste eigen bericht in een gesprek', () => {
  beforeEach(async () => {
    await db.query('update accounts set openstaande_verzoeken = 3 where id=$1', [accountId]);
  });

  it('eerste eigen bericht naar iemand met een verstuurde invite telt als acceptatie', async () => {
    await inviteVerstuurd(LEAD);
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(uitkomst.verwerkt, true);
    assert.match(uitkomst.reden ?? '', /acceptatie/i);
    assert.equal(await openstaand(), 2);
    assert.equal(await tel("events where type='message_sent_self'"), 1);
    assert.equal(await tel("events where type='acceptatie'"), 1);
    assert.equal(await tel("events where type='message_received'"), 0);
  });

  it('geen acceptatie als de invite nog niet verstuurd is (status queued)', async () => {
    await inviteVerstuurd(LEAD, 'queued');
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await openstaand(), 3);
    assert.equal(await tel("events where type='acceptatie'"), 0);
  });

  it('geen acceptatie zonder invite naar deze persoon', async () => {
    await inviteVerstuurd('ACo-iemand-anders');
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(await openstaand(), 3);
  });

  it('geen acceptatie als het niet het eerste bericht in het gesprek is', async () => {
    await inviteVerstuurd(LEAD);
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'message_received',
      account_id: UNIPILE_ACCOUNT_ID,
      chat_id: 'chat-acc-1',
      message_id: 'msg-van-lead',
      is_sender: false,
      sender: { attendee_provider_id: LEAD },
    });
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await openstaand(), 3);
  });

  it('tweede eigen bericht in hetzelfde gesprek telt niet opnieuw', async () => {
    await inviteVerstuurd(LEAD);
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht({ messageId: 'msg-eigen-2' }));
    assert.equal(await openstaand(), 2);
    assert.equal(await tel("events where type='message_sent_self'"), 2);
  });

  it('zonder attendees in de payload: opgeslagen, geen acceptatie', async () => {
    await inviteVerstuurd(LEAD);
    const uitkomst = await verwerkUnipileWebhook(
      db, unipile, KOPPEL_OPTIES, eigenBericht({ attendees: null }),
    );
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await openstaand(), 3);
    assert.equal(await tel("events where type='message_sent_self'"), 1);
  });

  it('latere new_relation voor dezelfde persoon verlaagt de teller niet nog eens', async () => {
    await inviteVerstuurd(LEAD);
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    const relatie = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'new_relation',
      account_id: UNIPILE_ACCOUNT_ID,
      attendee_provider_id: LEAD,
      timestamp: '2026-10-01T13:00:00Z',
    });
    assert.equal(relatie.verwerkt, false);
    assert.match(relatie.reden ?? '', /al geregistreerd/i);
    assert.equal(await openstaand(), 2);
    assert.equal(await tel("events where type='new_relation'"), 1);
  });

  it('eerdere new_relation: eerste eigen bericht verlaagt de teller niet nog eens', async () => {
    await inviteVerstuurd(LEAD);
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      event: 'new_relation',
      account_id: UNIPILE_ACCOUNT_ID,
      attendee_provider_id: LEAD,
      timestamp: '2026-10-01T09:00:00Z',
    });
    assert.equal(await openstaand(), 2);
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await openstaand(), 2);
  });

  it('new_relation van vóór deze ontdubbeling (zonder acceptatie-event) telt ook als geregistreerd', async () => {
    await inviteVerstuurd(LEAD);
    await db.query(
      `insert into events(bron, type, extern_id, account_id, payload)
       values ('unipile', 'new_relation', 'oud-1', $1, $2::jsonb)`,
      [accountId, JSON.stringify({ event: 'new_relation', attendee_provider_id: LEAD })],
    );
    await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(await openstaand(), 3);
  });

  it('invite met status onzeker (telde mee) wordt ook verlaagd bij het eerste eigen bericht', async () => {
    await inviteVerstuurd(LEAD, 'onzeker');
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht());
    assert.equal(uitkomst.verwerkt, true);
    assert.equal(await openstaand(), 2);
  });

  it('twee new_relation-leveringen met verschillende timestamp verlagen maar één keer', async () => {
    await inviteVerstuurd(LEAD);
    for (const timestamp of ['2026-10-01T09:00:00Z', '2026-10-01T15:00:00Z']) {
      await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
        event: 'new_relation',
        account_id: UNIPILE_ACCOUNT_ID,
        attendee_provider_id: LEAD,
        timestamp,
      });
    }
    assert.equal(await openstaand(), 2);
    assert.equal(await tel("events where type='acceptatie'"), 1);
  });

  it('new_relation en eigen bericht tegelijk binnen: één acceptatie, één verlaging', async () => {
    await inviteVerstuurd(LEAD);
    await Promise.all([
      verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
        event: 'new_relation',
        account_id: UNIPILE_ACCOUNT_ID,
        attendee_provider_id: LEAD,
        timestamp: '2026-10-01T10:00:01Z',
      }),
      verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, eigenBericht()),
    ]);
    assert.equal(await openstaand(), 2);
    assert.equal(await tel("events where type='acceptatie'"), 1);
  });

  it('onbekend account: eigen bericht opgeslagen, geen crash', async () => {
    const uitkomst = await verwerkUnipileWebhook(db, unipile, KOPPEL_OPTIES, {
      ...eigenBericht(),
      account_id: 'onbekend-unipile-id',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.equal(await tel("events where type='message_sent_self'"), 1);
  });
});
