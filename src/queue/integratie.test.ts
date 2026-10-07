import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { telGebruikOpDag } from '../budget/gebruik.ts';
import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { keurActieGoed, maakActie, vindActie } from './acties.ts';
import { vastePauze } from './pauze.ts';
import { voerPlannerTickUit } from './planner.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;

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

  const client = await maakClient(db, { naam: 'Test', slug: 'test', abonnementVereist: false });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'unipile-abc');
});

describe('integratie: invite van draft → done', () => {
  it('loopt via approved → queued → running → done, met usage-telling en Unipile-aanroep', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-end-to-end' },
    });

    // 1. Skill maakt een draft-actie (via MCP in fase 3; nu rechtstreeks).
    const draft = await maakActie(db, {
      accountId,
      type: 'invite',
      payload: { providerId: 'ACo-xyz', message: 'Hoi!' },
    });
    assert.equal(draft.status, 'draft');

    // 2. Rubert keurt de actie goed.
    const nu = new Date('2026-10-06T10:00:00Z');
    await keurActieGoed(db, draft.id, 'rubert@rietkerk.org', nu);
    const na1 = await vindActie(db, draft.id);
    assert.equal(na1?.status, 'approved');

    // 3. Planner-tick → budgetmotor → worker → Unipile.
    const resultaat = await voerPlannerTickUit({
      db,
      unipile,
      limieten,
      klok: vasteKlok(nu),
      pauzeKiezer: vastePauze(120),
    });
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.resultaat, 'done');
    assert.equal(resultaat.gatewayGestopt, false);

    // 4. Actie staat op done met Unipile-response.
    const klaar = await vindActie(db, draft.id);
    assert.equal(klaar?.status, 'done');
    assert.equal(
      (klaar?.unipileResponse as { invitationId?: string } | null)?.invitationId,
      'inv-end-to-end',
    );
    assert.ok(klaar?.uitgevoerdOp);

    // 5. Usage-teller voor vandaag is 1.
    const telling = await telGebruikOpDag(db, accountId, 'invite', '2026-10-06');
    assert.equal(telling, 1);

    // 6. Fake-Unipile ontving precies één invite-aanroep.
    const invites = fake.aanroepen.filter((a) => a.path === '/api/v1/users/invite');
    assert.equal(invites.length, 1);
    const body = invites[0]!.body as Record<string, unknown>;
    assert.equal(body['account_id'], 'unipile-abc');
    assert.equal(body['provider_id'], 'ACo-xyz');
  });
});
