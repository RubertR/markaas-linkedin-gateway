import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { vasteKlok } from '../budget/klok.ts';
import { telGebruikOpDag, verhoogGebruik } from '../budget/gebruik.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakActie, vindActie } from './acties.ts';
import { voerActieUit, type WorkerContext } from './worker.ts';

/**
 * SPEC §6a: 401 en 403 van Unipile per account of gateway-breed. Alle
 * Unipile-antwoorden komen uit test/fake-unipile/.
 */

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let clientId: string;
let accountId: string;

const T0 = '2026-10-06T10:00:00Z';
const DAG = '2026-10-06';

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'geheim', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();
  const client = await maakClient(db, { naam: 'Test', slug: 'auth' });
  clientId = client.id;
  accountId = await nieuwAccount('Rubert', 'unipile-auth-1');
});

async function nieuwAccount(naam: string, unipileId: string): Promise<string> {
  const account = await registreerAccount(db, {
    clientId,
    eigenaarNaam: naam,
    abonnement: 'salesnav_core',
  });
  await markeerAccountGekoppeld(db, account.id, unipileId);
  return account.id;
}

function ctx(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return { db, unipile, limieten, klok: vasteKlok(T0), ...overrides };
}

async function lopendeActie(
  type: 'invite' | 'search',
  payload: Record<string, unknown>,
  voorAccount = accountId,
) {
  const actie = await maakActie(db, { accountId: voorAccount, type, payload });
  await db.query(`update actions set status = 'running'::action_status where id = $1`, [actie.id]);
  return (await vindActie(db, actie.id))!;
}

async function invite(providerId = 'ACo-auth', voorAccount = accountId) {
  return await lopendeActie('invite', { providerId }, voorAccount);
}

async function gatewayStatusEvents(voorAccount = accountId): Promise<Array<Record<string, unknown>>> {
  const rijen = await db.query<{ payload: Record<string, unknown> }>(
    `select payload from events
     where bron = 'gateway' and type = 'account_status' and account_id = $1
     order by ontvangen_op`,
    [voorAccount],
  );
  return rijen.map((r) => r.payload);
}

function controleAanroepen(): number {
  return fake.aanroepen.filter((a) => a.method === 'GET' && a.path.startsWith('/api/v1/accounts'))
    .length;
}

describe('worker — sessie van dit account werkt niet → CREDENTIALS', () => {
  const SESSIE: Array<[number, string]> = [
    [401, 'disconnected_account'],
    [401, 'expired_credentials'],
    [401, 'invalid_credentials'],
    [401, 'missing_credentials'],
    [401, 'multiple_sessions'],
    [401, 'checkpoint_error'],
    [401, 'invalid_checkpoint_solution'],
    [401, 'wrong_account'],
    [403, 'session_mismatch'],
    [403, 'unknown_authentication_context'],
    [403, 'account_mismatch'],
  ];
  for (const [status, type] of SESSIE) {
    it(`${status} errors/${type} → alleen dit account CREDENTIALS, reconnect-link, actie queued, event`, async () => {
      fake.antwoord('POST', '/api/v1/users/invite', { status, body: { status, type: `errors/${type}` } });
      let hook: string | null = null;
      const actie = await invite();
      const uit = await voerActieUit(
        ctx({
          reconnectHook: async (aid) => {
            hook = aid;
          },
        }),
        actie,
      );
      assert.equal(uit.status, 'queued');
      assert.equal(uit.gatewayAuthFout, undefined);
      assert.equal(uit.alleenDitAccountPauzeren, true);
      assert.equal(hook, accountId);
      assert.equal((await vindAccount(db, accountId))?.status, 'CREDENTIALS');
      assert.equal((await vindActie(db, actie.id))?.status, 'queued');
      assert.equal(controleAanroepen(), 0, 'geen controle-aanroep nodig bij een bekend type');
      const events = await gatewayStatusEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0]?.status, 'CREDENTIALS');
      assert.equal(events[0]?.vorige_status, 'OK');
      assert.equal(events[0]?.fout_type, `errors/${type}`);
      assert.equal(events[0]?.http_status, status);
    });
  }
});

describe('worker — 403 account_restricted → STOPPED', () => {
  it('account STOPPED met reden, géén reconnect-link, actie queued, event', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 403,
      body: { status: 403, type: 'errors/account_restricted' },
    });
    let hook = false;
    const actie = await invite();
    const uit = await voerActieUit(
      ctx({
        reconnectHook: async () => {
          hook = true;
        },
      }),
      actie,
    );
    assert.equal(uit.status, 'queued');
    assert.equal(uit.gatewayAuthFout, undefined);
    assert.equal(uit.alleenDitAccountPauzeren, true);
    assert.equal(hook, false, 'geen reconnect-link bij een beperking door LinkedIn');
    assert.match(uit.reden!, /beperkt/);
    assert.match(uit.reden!, /eigenaar/);
    assert.equal((await vindActie(db, actie.id))?.status, 'queued');
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
    const events = await gatewayStatusEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 'STOPPED');
    assert.equal(events[0]?.fout_type, 'errors/account_restricted');
    assert.match(String(events[0]?.reden), /beperkt/);
  });
});

describe('worker — functie niet in het abonnement → alleen de actie failed', () => {
  const FUNCTIE: Array<[number, string]> = [
    [403, 'feature_not_subscribed'],
    [403, 'insufficient_permissions'],
    [401, 'insufficient_privileges'],
    [401, 'disconnected_feature'],
  ];
  for (const [status, type] of FUNCTIE) {
    it(`${status} errors/${type} → actie failed met NL-reden, account blijft OK, verbruik telt mee`, async () => {
      fake.antwoord('POST', '/api/v1/linkedin/search', {
        status,
        body: { status, type: `errors/${type}` },
      });
      const actie = await lopendeActie('search', { api: 'sales_navigator', keywords: 'cto' });
      await verhoogGebruik(db, accountId, 'search', DAG, 1);
      const uit = await voerActieUit(ctx(), actie);
      assert.equal(uit.status, 'failed');
      assert.equal(uit.teruggeboekt, undefined);
      assert.match(uit.reden!, /functie zit niet in het LinkedIn-abonnement van dit account/);
      assert.equal((await vindAccount(db, accountId))?.status, 'OK');
      const na = await vindActie(db, actie.id);
      assert.equal(na?.status, 'failed');
      assert.equal(na?.teruggeboektOp ?? null, null);
      assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
      assert.equal(controleAanroepen(), 0);
      assert.equal((await gatewayStatusEvents()).length, 0);
    });
  }
});

describe('worker — onbekend type → controle-aanroep', () => {
  it('controle geslaagd → alleen dit account ERROR, met HTTP-status en type in de reden', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 403,
      body: { status: 403, type: 'errors/iets_nieuws' },
    });
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { object: 'AccountList', items: [] } });
    const actie = await invite();
    const uit = await voerActieUit(ctx(), actie);
    assert.equal(uit.status, 'queued');
    assert.equal(uit.gatewayAuthFout, undefined);
    assert.equal(uit.alleenDitAccountPauzeren, true);
    assert.match(uit.reden!, /HTTP 403/);
    assert.match(uit.reden!, /errors\/iets_nieuws/);
    assert.equal(controleAanroepen(), 1);
    assert.equal((await vindAccount(db, accountId))?.status, 'ERROR');
    const events = await gatewayStatusEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.status, 'ERROR');
    assert.equal(events[0]?.http_status, 403);
    assert.equal(events[0]?.fout_type, 'errors/iets_nieuws');
  });

  it('geen type + controle geslaagd → ERROR met "zonder type" in de reden', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: { error: 'unauthorized' } });
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });
    const uit = await voerActieUit(ctx(), await invite());
    assert.match(uit.reden!, /HTTP 401/);
    assert.match(uit.reden!, /zonder type/);
    assert.equal((await vindAccount(db, accountId))?.status, 'ERROR');
  });

  it('controle mislukt (401/403) → gateway stopt, account ongewijzigd, geen event', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 403, body: {} });
    const actie = await invite();
    const uit = await voerActieUit(ctx(), actie);
    assert.equal(uit.status, 'queued');
    assert.equal(uit.gatewayAuthFout, true);
    assert.match(uit.reden!, /Gateway-API-sleutel/);
    assert.equal((await vindAccount(db, accountId))?.status, 'OK');
    assert.equal((await vindActie(db, actie.id))?.status, 'queued');
    assert.equal((await gatewayStatusEvents()).length, 0);
  });

  it('controle zonder uitsluitsel (500) → account ongewijzigd, actie over 5 minuten opnieuw', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 500, body: {} });
    const actie = await invite();
    const uit = await voerActieUit(ctx(), actie);
    assert.equal(uit.status, 'queued');
    assert.equal(uit.gatewayAuthFout, undefined);
    assert.equal((await vindAccount(db, accountId))?.status, 'OK');
    assert.equal((await vindActie(db, actie.id))?.geplandOp?.toISOString(), '2026-10-06T10:05:00.000Z');
  });
});

describe('worker — controle-aanroep hoogstens eens per 5 minuten per account', () => {
  it('binnen 5 minuten geldt de laatste uitkomst; daarna mag er weer één', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });

    await voerActieUit(ctx(), await invite('ACo-1'));
    assert.equal(controleAanroepen(), 1);
    assert.equal((await vindAccount(db, accountId))?.status, 'ERROR');

    const uit2 = await voerActieUit(ctx({ klok: vasteKlok('2026-10-06T10:04:59Z') }), await invite('ACo-2'));
    assert.equal(controleAanroepen(), 1, 'geen tweede controle binnen 5 minuten');
    assert.equal(uit2.alleenDitAccountPauzeren, true);
    assert.equal((await gatewayStatusEvents()).length, 1, 'status ongewijzigd → geen tweede event');

    await voerActieUit(ctx({ klok: vasteKlok('2026-10-06T10:05:30Z') }), await invite('ACo-3'));
    assert.equal(controleAanroepen(), 2);
  });

  it('een mislukte controle wordt ook hergebruikt: gateway stopt zonder tweede controle', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 401, body: {} });
    const uit1 = await voerActieUit(ctx(), await invite('ACo-1'));
    const uit2 = await voerActieUit(ctx({ klok: vasteKlok('2026-10-06T10:02:00Z') }), await invite('ACo-2'));
    assert.equal(uit1.gatewayAuthFout, true);
    assert.equal(uit2.gatewayAuthFout, true);
    assert.equal(controleAanroepen(), 1);
  });

  it('de grens is per account: een ander account krijgt een eigen controle', async () => {
    const tweede = await nieuwAccount('Tweede', 'unipile-auth-2');
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });
    await voerActieUit(ctx(), await invite('ACo-1'));
    await voerActieUit(ctx(), await invite('ACo-2', tweede));
    assert.equal(controleAanroepen(), 2);
  });
});

describe('worker — strengste status wint en events zijn dedup-veilig', () => {
  it('een sessiefout zet een STOPPED account niet terug naar CREDENTIALS', async () => {
    await db.query(`update accounts set status = 'STOPPED'::account_status where id = $1`, [accountId]);
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 401,
      body: { status: 401, type: 'errors/disconnected_account' },
    });
    let hook = false;
    await voerActieUit(
      ctx({
        reconnectHook: async () => {
          hook = true;
        },
      }),
      await invite(),
    );
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
    assert.equal(hook, false);
    assert.equal((await gatewayStatusEvents()).length, 0);
  });

  it('account_restricted op een CREDENTIALS-account → STOPPED (strenger)', async () => {
    await db.query(`update accounts set status = 'CREDENTIALS'::account_status where id = $1`, [accountId]);
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 403,
      body: { status: 403, type: 'errors/account_restricted' },
    });
    await voerActieUit(ctx(), await invite());
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
  });

  it('dezelfde statusovergang op hetzelfde moment geeft één event', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 403,
      body: { status: 403, type: 'errors/account_restricted' },
    });
    await voerActieUit(ctx(), await invite('ACo-1'));
    await db.query(`update accounts set status = 'OK'::account_status where id = $1`, [accountId]);
    await voerActieUit(ctx(), await invite('ACo-2'));
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
    assert.equal((await gatewayStatusEvents()).length, 1);
  });
});
