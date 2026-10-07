import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { markeerAccountGekoppeld, registreerAccount } from './accounts.ts';
import { maakClient } from './clients.ts';
import {
  claimUitnodiging,
  geefUitnodigingVrij,
  hashToken,
  maakUitnodiging,
  vindGeldigeUitnodiging,
} from './uitnodiging.ts';

let db: Backend;
let close: () => Promise<void>;
let accountId: string;
const NU = new Date('2026-10-07T10:00:00Z');
const DAG = 24 * 60 * 60 * 1000;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from account_consents');
  await db.query('delete from koppel_uitnodigingen');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Klant', slug: 'klant' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Eva',
    abonnement: 'free',
  });
  accountId = account.id;
});

describe('maakUitnodiging', () => {
  it('geeft een 32-byte base64url-token en bewaart alleen de sha256-hash', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    assert.match(r.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(r.token, 'base64url').length, 32);
    assert.equal(r.verlooptOp.getTime(), NU.getTime() + 7 * DAG);
    const rijen = await db.query<{ token_hash: string }>(
      'select token_hash from koppel_uitnodigingen',
    );
    assert.equal(rijen.length, 1);
    const verwacht = createHash('sha256').update(r.token).digest('hex');
    assert.equal(rijen[0]!.token_hash, verwacht);
    assert.equal(hashToken(r.token), verwacht);
    const dump = JSON.stringify(await db.query('select * from koppel_uitnodigingen'));
    assert.ok(!dump.includes(r.token), 'token zelf mag nergens in de database staan');
  });

  it('maakt elke keer een ander token', async () => {
    const a = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    const b = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    assert.notEqual(a.token, b.token);
  });

  it('laat eerdere open uitnodigingen van hetzelfde account vervallen', async () => {
    const oud = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    const later = new Date(NU.getTime() + DAG);
    const nieuw = await maakUitnodiging(db, accountId, { klok: vasteKlok(later), geldigDagen: 7 });
    assert.equal(await vindGeldigeUitnodiging(db, oud.token, vasteKlok(later)), null);
    assert.ok(await vindGeldigeUitnodiging(db, nieuw.token, vasteKlok(later)));
  });
});

describe('vindGeldigeUitnodiging', () => {
  it('vindt een geldige uitnodiging met account-id', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    const u = await vindGeldigeUitnodiging(db, r.token, vasteKlok(NU));
    assert.equal(u?.accountId, accountId);
    assert.equal(u?.id, r.id);
  });

  it('geeft null voor een onbekend of misvormd token', async () => {
    assert.equal(await vindGeldigeUitnodiging(db, 'bestaat-niet', vasteKlok(NU)), null);
    assert.equal(await vindGeldigeUitnodiging(db, '', vasteKlok(NU)), null);
  });

  it('geeft null na verlopen', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    const net = new Date(NU.getTime() + 7 * DAG - 1000);
    assert.ok(await vindGeldigeUitnodiging(db, r.token, vasteKlok(net)));
    const verlopen = new Date(NU.getTime() + 7 * DAG);
    assert.equal(await vindGeldigeUitnodiging(db, r.token, vasteKlok(verlopen)), null);
  });

  it('geeft null na gebruik (eenmalig)', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    assert.equal(await claimUitnodiging(db, r.id, vasteKlok(NU)), true);
    assert.equal(await vindGeldigeUitnodiging(db, r.token, vasteKlok(NU)), null);
    assert.equal(await claimUitnodiging(db, r.id, vasteKlok(NU)), false, 'tweede claim faalt');
  });

  it('geeft null als het account inmiddels gekoppeld is', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    await markeerAccountGekoppeld(db, accountId, 'uni-1');
    assert.equal(await vindGeldigeUitnodiging(db, r.token, vasteKlok(NU)), null);
  });
});

describe('claimUitnodiging / geefUitnodigingVrij', () => {
  it('kan een geclaimde uitnodiging weer vrijgeven zodat ze opnieuw bruikbaar is', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 7 });
    assert.equal(await claimUitnodiging(db, r.id, vasteKlok(NU)), true);
    await geefUitnodigingVrij(db, r.id);
    assert.ok(await vindGeldigeUitnodiging(db, r.token, vasteKlok(NU)));
  });

  it('claimt geen verlopen uitnodiging', async () => {
    const r = await maakUitnodiging(db, accountId, { klok: vasteKlok(NU), geldigDagen: 1 });
    const later = new Date(NU.getTime() + 2 * DAG);
    assert.equal(await claimUitnodiging(db, r.id, vasteKlok(later)), false);
  });
});
