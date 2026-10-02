import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { maakClient } from '../register/clients.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import type { KoppelflowOpties } from '../register/koppelflow.ts';

import { WEBHOOK_SECRET_HEADER, koppelSleutel } from './geheim.ts';
import { maakWebhookApp } from './server.ts';

const SECRET = 'zeer-geheim-abc';
const UNIPILE_ACCOUNT_ID = 'unipile-hook-1';
const KOPPEL_OPTIES: KoppelflowOpties = {
  notifyUrl: 'https://gateway.markaas.test/webhooks/koppel',
  apiUrl: 'https://api68.unipile.example:19841',
};

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let accountId: string;
let app: ReturnType<typeof maakWebhookApp>;

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 200 });
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const c = await maakClient(db, { naam: 'Test', slug: 'test' });
  const a = await registreerAccount(db, {
    clientId: c.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = a.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);

  app = maakWebhookApp({
    db,
    unipile,
    webhookSecret: SECRET,
    koppelOpties: KOPPEL_OPTIES,
  });
});

async function verzoek(pad: string, opties: {
  method?: string;
  secret?: string | null;
  body?: unknown;
} = {}): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opties.secret !== null && opties.secret !== undefined) {
    headers[WEBHOOK_SECRET_HEADER] = opties.secret;
  }
  const init: RequestInit = {
    method: opties.method ?? 'POST',
    headers,
  };
  if (opties.body !== undefined) init.body = JSON.stringify(opties.body);
  return await app.request(pad, init);
}

describe('POST /webhooks/unipile', () => {
  it('401 zonder geheim', async () => {
    const res = await verzoek('/webhooks/unipile', {
      secret: null,
      body: { event: 'ok', account_id: UNIPILE_ACCOUNT_ID },
    });
    assert.equal(res.status, 401);
    const tekst = await res.text();
    assert.match(tekst, /geheim|onbevoegd|weiger/i);

    const rijen = await db.query<{ aantal: string }>(
      "select count(*)::text as aantal from events",
    );
    assert.equal(rijen[0]?.aantal, '0');
  });

  it('401 met verkeerd geheim', async () => {
    const res = await verzoek('/webhooks/unipile', {
      secret: 'fout',
      body: { event: 'ok', account_id: UNIPILE_ACCOUNT_ID },
    });
    assert.equal(res.status, 401);
  });

  it('200 met correct geheim en werkt de accountstatus bij', async () => {
    await db.query("update accounts set status='CREDENTIALS' where id=$1", [accountId]);
    const res = await verzoek('/webhooks/unipile', {
      secret: SECRET,
      body: { event: 'ok', account_id: UNIPILE_ACCOUNT_ID, timestamp: '2026-10-01T10:00:00Z' },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { verwerkt: boolean };
    assert.equal(body.verwerkt, true);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'OK');
  });

  it('400 bij ongeldige JSON', async () => {
    const res = await app.request('/webhooks/unipile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [WEBHOOK_SECRET_HEADER]: SECRET },
      body: 'niet-json',
    });
    assert.equal(res.status, 400);
  });
});

describe('POST /webhooks/koppel', () => {
  it('401 zonder geheim', async () => {
    const res = await verzoek('/webhooks/koppel', {
      secret: null,
      body: { status: 'CREATION_SUCCESS', account_id: 'unipile-nieuw', name: accountId },
    });
    assert.equal(res.status, 401);
  });

  it('401 met verkeerd geheim', async () => {
    const res = await verzoek('/webhooks/koppel', {
      secret: 'fout',
      body: { status: 'CREATION_SUCCESS', account_id: 'x', name: accountId },
    });
    assert.equal(res.status, 401);
  });

  it('200 met correct geheim voor een RECONNECTED-callback', async () => {
    const res = await verzoek('/webhooks/koppel', {
      secret: SECRET,
      body: { status: 'RECONNECTED', account_id: UNIPILE_ACCOUNT_ID },
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { verwerkt: boolean };
    assert.equal(body.verwerkt, true);
  });

  it('200 met correct geheim voor een CREATION_SUCCESS-callback en koppelt het account', async () => {
    // Andere, nog niet gekoppelde account
    const c = await maakClient(db, { naam: 'Nieuw', slug: 'nieuw' });
    const a = await registreerAccount(db, {
      clientId: c.id,
      eigenaarNaam: 'Andere',
      abonnement: 'salesnav_core',
    });
    const res = await verzoek('/webhooks/koppel', {
      secret: SECRET,
      body: { status: 'CREATION_SUCCESS', account_id: 'unipile-nieuw', name: a.id },
    });
    assert.equal(res.status, 200);
    const account = await vindAccount(db, a.id);
    assert.equal(account?.unipileAccountId, 'unipile-nieuw');
    assert.equal(account?.status, 'OK');
  });
});

describe('POST /webhooks/koppel met sleutel in de querystring (hosted auth)', () => {
  const K = koppelSleutel(SECRET);
  const CALLBACK = { status: 'RECONNECTED', account_id: UNIPILE_ACCOUNT_ID };

  it('verwerkt een callback zonder header maar met de juiste k', async () => {
    const res = await verzoek(`/webhooks/koppel?k=${K}`, { secret: null, body: CALLBACK });
    assert.equal(res.status, 200);
    const body = await res.json() as { verwerkt: boolean };
    assert.equal(body.verwerkt, true);
  });

  it('koppelt een nieuw account via CREATION_SUCCESS met alleen k', async () => {
    const c = await maakClient(db, { naam: 'Nieuw', slug: 'nieuw' });
    const a = await registreerAccount(db, {
      clientId: c.id,
      eigenaarNaam: 'Andere',
      abonnement: 'salesnav_core',
    });
    const res = await verzoek(`/webhooks/koppel?k=${K}`, {
      secret: null,
      body: { status: 'CREATION_SUCCESS', account_id: 'unipile-nieuw', name: a.id },
    });
    assert.equal(res.status, 200);
    assert.equal((await vindAccount(db, a.id))?.unipileAccountId, 'unipile-nieuw');
  });

  it('401 bij een foute k', async () => {
    const res = await verzoek('/webhooks/koppel?k=fout', { secret: null, body: CALLBACK });
    assert.equal(res.status, 401);
    const rijen = await db.query<{ aantal: string }>('select count(*)::text as aantal from events');
    assert.equal(rijen[0]?.aantal, '0');
  });

  it('401 bij een lege k', async () => {
    const res = await verzoek('/webhooks/koppel?k=', { secret: null, body: CALLBACK });
    assert.equal(res.status, 401);
  });

  it('401 als k het ruwe WEBHOOK_SECRET is in plaats van de afgeleide sleutel', async () => {
    const res = await verzoek(`/webhooks/koppel?k=${SECRET}`, { secret: null, body: CALLBACK });
    assert.equal(res.status, 401);
  });

  it('header blijft werken naast een foute k', async () => {
    const res = await verzoek('/webhooks/koppel?k=fout', { secret: SECRET, body: CALLBACK });
    assert.equal(res.status, 200);
  });

  it('/webhooks/unipile accepteert k niet: alleen de header telt', async () => {
    const res = await verzoek(`/webhooks/unipile?k=${K}`, {
      secret: null,
      body: { event: 'ok', account_id: UNIPILE_ACCOUNT_ID },
    });
    assert.equal(res.status, 401);
  });
});

describe('geheim-check is constante tijd', () => {
  it('geeft in beide gevallen 401 met dezelfde body-vorm', async () => {
    const r1 = await verzoek('/webhooks/unipile', { secret: null, body: {} });
    const r2 = await verzoek('/webhooks/unipile', { secret: 'fout', body: {} });
    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.equal(await r1.text(), await r2.text());
  });
});
