import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { keurActieGoed, maakActie, vindActie } from './acties.ts';
import { vastePauze } from './pauze.ts';
import { voerPlannerTickUit, type PlannerContext } from './planner.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
let tweedeAccountId: string;
const UNIPILE_ACCOUNT_ID = 'unipile-acc-1';
const UNIPILE_ACCOUNT_ID_2 = 'unipile-acc-2';

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
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

  const client = await maakClient(db, { naam: 'Test', slug: 'test' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);
  const account2 = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert #2',
    abonnement: 'salesnav_core',
  });
  tweedeAccountId = account2.id;
  await markeerAccountGekoppeld(db, tweedeAccountId, UNIPILE_ACCOUNT_ID_2);
});

function basisContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  // 2026-10-06 10:00 UTC = 12:00 Europe/Amsterdam → werkuren.
  return {
    db,
    unipile,
    limieten,
    klok: vasteKlok('2026-10-06T10:00:00Z'),
    pauzeKiezer: vastePauze(120),
    ...overrides,
  };
}

async function maakGoedgekeurdeInvite(opties: {
  accountId: string;
  providerId: string;
  aangemaaktOp?: string;
  geplandOp?: string | null;
}) {
  const actie = await maakActie(db, {
    accountId: opties.accountId,
    type: 'invite',
    payload: { providerId: opties.providerId },
  });
  await keurActieGoed(db, actie.id, 'rubert', new Date('2026-10-01T10:00:00Z'));
  if (opties.aangemaaktOp !== undefined) {
    await db.query(
      `update actions set aangemaakt_op = $2 where id = $1`,
      [actie.id, opties.aangemaaktOp],
    );
  }
  if (opties.geplandOp !== undefined) {
    await db.query(
      `update actions set gepland_op = $2 where id = $1`,
      [actie.id, opties.geplandOp],
    );
  }
  return (await vindActie(db, actie.id))!;
}

describe('planner — kiest oudste approved actie per account', () => {
  it('pakt per account de oudste approved actie en voert haar uit', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const oud = await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-oud',
      aangemaaktOp: '2026-10-01T08:00:00Z',
    });
    const nieuw = await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-nieuw',
      aangemaaktOp: '2026-10-01T09:00:00Z',
    });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.actieId, oud.id);
    assert.equal(resultaat.details[0]?.resultaat, 'done');

    assert.equal((await vindActie(db, oud.id))?.status, 'done');
    assert.equal((await vindActie(db, nieuw.id))?.status, 'approved');
  });

  it('neemt per tick één actie per account (verschillende accounts parallel)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const a1 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-1' });
    const a2 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-2' });
    const b1 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-1' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 2);
    const uitgevoerd = resultaat.details.map((d) => d.actieId).sort();
    assert.deepEqual(
      uitgevoerd.sort(),
      [a1.id, b1.id].sort(),
    );
    assert.equal((await vindActie(db, a2.id))?.status, 'approved');
  });

  it('overslaat acties waarvan gepland_op in de toekomst ligt', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1' },
    }));
    await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-later',
      geplandOp: '2026-10-07T10:00:00Z',
    });
    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 0);
  });

  it('overslaat acties met status "draft"', async () => {
    await maakActie(db, {
      accountId,
      type: 'invite',
      payload: { providerId: 'ACo-draft' },
    });
    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 0);
  });

  it('overslaat acties met status "onzeker" (vereisen handmatige verificatie)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const onzeker = await maakActie(db, {
      accountId,
      type: 'invite',
      payload: { providerId: 'ACo-onzeker' },
    });
    await db.query(
      `update actions set status = 'onzeker'::action_status,
                          reden = 'Time-out: mogelijk verzonden...'
       where id = $1`,
      [onzeker.id],
    );
    // Een gewone approved actie ernaast — die moet wél opgepakt worden.
    const normaal = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-ok' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.actieId, normaal.id);
    assert.equal((await vindActie(db, onzeker.id))?.status, 'onzeker');
  });
});

describe('planner — budget', () => {
  it('bij wachtrij: zet actie terug op "queued" met reden en nieuwe gepland_op', async () => {
    // Dagnorm invite salesnav_core = 20 (opbouw 1.0). Verbruik vandaag al 20.
    await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [accountId]);
    await db.query(
      `insert into usage(account_id, type, dag, aantal)
       values ($1, 'invite'::action_type, '2026-10-06'::date, 20)`,
      [accountId],
    );
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-vol' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.resultaat, 'queued');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.ok(na?.geplandOp);
    assert.ok(na.geplandOp.getTime() > new Date('2026-10-06T10:00:00Z').getTime());
    assert.match(na.reden!, /dagnorm|budget|dag/i);
  });

  it('bij weigering (STOPPED): zet actie op "rejected"', async () => {
    await db.query(
      `update accounts set status = 'STOPPED'::account_status where id = $1`,
      [accountId],
    );
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-stop' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.resultaat, 'rejected');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'rejected');
    assert.match(na?.reden ?? '', /gestopt/i);
  });
});

describe('planner — gelijktijdigheid', () => {
  it('twee planners parallel pakken niet dezelfde actie', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-samen' });

    const [r1, r2] = await Promise.all([
      voerPlannerTickUit(basisContext()),
      voerPlannerTickUit(basisContext()),
    ]);
    const totaal = r1.verwerkt + r2.verwerkt;
    assert.equal(totaal, 1, 'actie mag maar één keer verwerkt zijn');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'done');
  });
});

describe('planner — foutpaden via worker', () => {
  it('worker 429 → actie "queued" + account in afkoeling', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 429,
      headers: { 'Retry-After': '60' },
      body: { error: 'rate_limited' },
    });
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-429' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.details[0]?.resultaat, 'queued');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    const account = await vindAccount(db, accountId);
    assert.ok(account?.afkoelingTot);
  });

  it('gateway-sleutelfout stopt de planner (gatewayGestopt=true, overige acties niet aangeraakt)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 401,
      body: { error: 'unauthorized' },
    });
    const a1 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-A' });
    const b1 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-B' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.gatewayGestopt, true);
    // Minimaal één van de twee bleef onaangeraakt.
    const na1 = await vindActie(db, a1.id);
    const na2 = await vindActie(db, b1.id);
    const statussen = [na1?.status, na2?.status];
    assert.ok(
      statussen.includes('approved'),
      `verwachte een onaangeraakt approved; kreeg ${JSON.stringify(statussen)}`,
    );
  });
});
