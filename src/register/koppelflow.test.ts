import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import {
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
} from '../unipile/errors.ts';

import { maakClient } from './clients.ts';
import { registreerAccount, vindAccount } from './accounts.ts';
import {
  KoppelflowFout,
  maakCreateLink,
  maakReconnectLink,
  verwerkKoppelCallback,
} from './koppelflow.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let clientId: string;
let accountId: string;

const OPTIES = {
  notifyUrl: 'https://gateway.markaas.test/webhooks/koppel',
  apiUrl: 'https://api68.unipile.example:19841',
};

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'geheim-koppel', timeoutMs: 200 });
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
  const client = await maakClient(db, { naam: 'Aqua', slug: 'aqua' });
  clientId = client.id;
  const account = await registreerAccount(db, {
    clientId,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
});

describe('koppelflow — maakCreateLink', () => {
  it('bouwt een create-link met account-id als name en notify_url uit opties', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/abc' },
    });
    const res = await maakCreateLink(db, unipile, OPTIES, accountId);
    assert.equal(res.url, 'https://account.unipile.com/link/abc');
    const call = fake.aanroepen[0];
    const body = call?.body as Record<string, unknown>;
    assert.equal(body['type'], 'create');
    assert.deepEqual(body['providers'], ['LINKEDIN']);
    assert.equal(body['name'], accountId);
    assert.equal(body['notify_url'], OPTIES.notifyUrl);
    assert.equal(body['api_url'], OPTIES.apiUrl);
    assert.equal(body['single_use'], true);
  });

  it('geeft success- en failure-redirect uit de opties door aan Unipile', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/abc' },
    });
    await maakCreateLink(
      db,
      unipile,
      {
        ...OPTIES,
        successRedirectUrl: 'https://gateway.markaas.test/koppelen/klaar',
        failureRedirectUrl: 'https://gateway.markaas.test/koppelen/mislukt',
      },
      accountId,
    );
    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['success_redirect_url'], 'https://gateway.markaas.test/koppelen/klaar');
    assert.equal(body['failure_redirect_url'], 'https://gateway.markaas.test/koppelen/mislukt');
  });

  it('vertaalt 429 op hosted/link naar een Nederlandse KoppelflowFout en slaat geen link op', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 429,
      headers: { 'Retry-After': '30' },
      body: { error: 'rate_limited' },
    });
    await assert.rejects(
      maakCreateLink(db, unipile, OPTIES, accountId),
      (err: Error) => {
        assert.ok(err instanceof KoppelflowFout);
        assert.match(err.message, /tijdelijk|opnieuw|later/i);
        assert.equal((err as KoppelflowFout).oorzaak, 'tijdelijk');
        return true;
      },
    );
    const account = await vindAccount(db, accountId);
    assert.equal(account?.unipileAccountId, null);
  });

  it('vertaalt time-out naar een Nederlandse KoppelflowFout', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://x' },
      delayMs: 500,
    });
    await assert.rejects(
      maakCreateLink(db, unipile, OPTIES, accountId),
      (err: Error) => {
        assert.ok(err instanceof KoppelflowFout);
        assert.equal((err as KoppelflowFout).oorzaak, 'timeout');
        return true;
      },
    );
  });

  it('propageert UnipileGatewayAuthFout ongewijzigd (gateway stopt)', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 401,
      body: { error: 'unauthorized' },
    });
    await assert.rejects(maakCreateLink(db, unipile, OPTIES, accountId), UnipileGatewayAuthFout);
  });
});

describe('koppelflow — maakReconnectLink', () => {
  it('vereist dat het account al gekoppeld is', async () => {
    await assert.rejects(
      maakReconnectLink(db, unipile, OPTIES, accountId),
      (err: Error) => {
        assert.ok(err instanceof KoppelflowFout);
        assert.match(err.message, /nog niet gekoppeld|geen unipile/i);
        return true;
      },
    );
  });

  it('stuurt reconnect_account = het bekende unipile_account_id mee', async () => {
    await db.query(
      "update accounts set unipile_account_id = 'unipile-abc', status = 'CREDENTIALS' where id = $1",
      [accountId],
    );
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/reconnect' },
    });
    const res = await maakReconnectLink(db, unipile, OPTIES, accountId);
    assert.equal(res.url, 'https://account.unipile.com/link/reconnect');
    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['type'], 'reconnect');
    assert.equal(body['reconnect_account'], 'unipile-abc');
    assert.equal(body['providers'], undefined);
  });
});

describe('koppelflow — verwerkKoppelCallback', () => {
  it('CREATION_SUCCESS: koppelt het account, zet status OK en opbouw_factor 0.50', async () => {
    const uitkomst = await verwerkKoppelCallback(db, {
      status: 'CREATION_SUCCESS',
      account_id: 'unipile-nieuw',
      name: accountId,
    });
    assert.equal(uitkomst.verwerkt, true);

    const account = await vindAccount(db, accountId);
    assert.equal(account?.unipileAccountId, 'unipile-nieuw');
    assert.equal(account?.status, 'OK');
    assert.equal(account?.opbouwFactor, 0.5);
  });

  it('dedup binnen 10 minuten: dezelfde CREATION_SUCCESS-callback wordt maar één keer verwerkt', async () => {
    const nu = new Date('2026-10-01T10:00:00Z');
    await verwerkKoppelCallback(
      db,
      { status: 'CREATION_SUCCESS', account_id: 'unipile-nieuw', name: accountId },
      { nu },
    );
    const tweede = await verwerkKoppelCallback(
      db,
      { status: 'CREATION_SUCCESS', account_id: 'unipile-nieuw', name: accountId },
      { nu: new Date(nu.getTime() + 5 * 60 * 1000) },
    );
    assert.equal(tweede.verwerkt, false);
    assert.match(tweede.reden ?? '', /al verwerkt|dubbel/i);

    const rijen: Array<{ aantal: string }> = await db.query<{ aantal: string }>(
      "select count(*)::text as aantal from events where bron='unipile' and type='hosted_auth'",
    );
    assert.equal(rijen[0]?.aantal, '1');
  });

  it('een tweede RECONNECTED na meer dan 10 minuten wordt wél verwerkt', async () => {
    await db.query(
      "update accounts set unipile_account_id='unipile-x', status='CREDENTIALS' where id=$1",
      [accountId],
    );
    const eerste = await verwerkKoppelCallback(
      db,
      { status: 'RECONNECTED', account_id: 'unipile-x' },
      { nu: new Date('2026-10-01T10:00:00Z') },
    );
    assert.equal(eerste.verwerkt, true);

    // Sessie loopt later opnieuw af, wordt hersteld — moet niet worden geblokkeerd door dedup.
    await db.query("update accounts set status='CREDENTIALS' where id=$1", [accountId]);

    const eenWeekLater = new Date('2026-10-08T10:00:00Z');
    const tweede = await verwerkKoppelCallback(
      db,
      { status: 'RECONNECTED', account_id: 'unipile-x' },
      { nu: eenWeekLater },
    );
    assert.equal(tweede.verwerkt, true);

    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'OK');
  });

  it('RECONNECTED: zet status op OK maar wist afkoeling_tot NIET (afkoeling komt van 429/waarschuwing, niet van de sessie)', async () => {
    const afkoelingTot = new Date('2026-10-03T12:00:00Z');
    await db.query(
      `update accounts
       set unipile_account_id='unipile-oud', status='CREDENTIALS',
           afkoeling_tot = $2
       where id = $1`,
      [accountId, afkoelingTot.toISOString()],
    );

    const uitkomst = await verwerkKoppelCallback(db, {
      status: 'RECONNECTED',
      account_id: 'unipile-oud',
    });
    assert.equal(uitkomst.verwerkt, true);

    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'OK');
    assert.ok(account?.afkoelingTot instanceof Date);
    assert.equal(account.afkoelingTot.getTime(), afkoelingTot.getTime());
  });

  it('slaat onbekende status op in events en crasht niet', async () => {
    const uitkomst = await verwerkKoppelCallback(db, {
      status: 'IETS_NIEUWS',
      account_id: 'unipile-ander',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.match(uitkomst.reden ?? '', /onbekend/i);

    const rijen: Array<{ aantal: string }> = await db.query<{ aantal: string }>(
      "select count(*)::text as aantal from events where type='hosted_auth'",
    );
    assert.equal(rijen[0]?.aantal, '1');
  });

  it('gooit een Nederlandse fout bij een ontbrekende status of account_id', async () => {
    await assert.rejects(
      verwerkKoppelCallback(db, { status: '', account_id: 'x' }),
      /status/i,
    );
    await assert.rejects(
      verwerkKoppelCallback(db, { status: 'CREATION_SUCCESS', account_id: '' }),
      /account_id/i,
    );
  });

  it('CREATION_SUCCESS zonder name: waarschuwt maar bewaart het event', async () => {
    const uitkomst = await verwerkKoppelCallback(db, {
      status: 'CREATION_SUCCESS',
      account_id: 'unipile-wees',
    });
    assert.equal(uitkomst.verwerkt, false);
    assert.match(uitkomst.reden ?? '', /name ontbreekt|onbekend account/i);

    const rijen: Array<{ aantal: string }> = await db.query<{ aantal: string }>(
      "select count(*)::text as aantal from events where type='hosted_auth'",
    );
    assert.equal(rijen[0]?.aantal, '1');
  });
});

describe('koppelflow — foutpad UnipileTijdelijkeFout expliciet', () => {
  it('gebruikt de retryAfter uit de originele fout in de KoppelflowFout', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 429,
      headers: { 'Retry-After': '45' },
      body: { error: 'rate_limited' },
    });
    try {
      await maakCreateLink(db, unipile, OPTIES, accountId);
      assert.fail('had moeten falen');
    } catch (err) {
      assert.ok(err instanceof KoppelflowFout);
      assert.equal((err as KoppelflowFout).retryAfterSeconden, 45);
      assert.ok((err as KoppelflowFout).origineel instanceof UnipileTijdelijkeFout);
    }
  });

  it('markeert een UnipileTimeoutFout in de KoppelflowFout.origineel', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { url: 'https://x' },
      delayMs: 500,
    });
    try {
      await maakCreateLink(db, unipile, OPTIES, accountId);
      assert.fail('had moeten falen');
    } catch (err) {
      assert.ok(err instanceof KoppelflowFout);
      assert.ok((err as KoppelflowFout).origineel instanceof UnipileTimeoutFout);
    }
  });
});
