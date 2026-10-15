import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { inAfkoeling, mogelijkeOpbouwNaAfkoeling } from '../budget/afkoeling.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { registreerAccount, vindAccount } from './accounts.ts';
import { statusDoorGatewayGezet } from './accountauth.ts';
import {
  AccountVrijgaveFout,
  geefAccountVrij,
  herstelHeftStatusOp,
  isAccountPauze,
} from './accountpauze.ts';
import { maakClient } from './clients.ts';

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let accountId: string;
const NU = new Date('2026-10-06T10:00:00Z');
const DAG = 86_400_000;

before(async () => {
  const op = await verseDatabaseMetMigraties();
  db = op.db;
  close = op.close;
  limieten = await laadLimieten();
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Test', slug: 'test' });
  const account = await registreerAccount(db, { clientId: client.id, eigenaarNaam: 'Rubert', abonnement: 'salesnav_core' });
  accountId = account.id;
});

async function zet(status: string, opbouw = 1.0, afkoelingTot: Date | null = null): Promise<void> {
  await db.query(
    `update accounts set status = $2::account_status, opbouw_factor = $3, afkoeling_tot = $4 where id = $1`,
    [accountId, status, opbouw, afkoelingTot?.toISOString() ?? null],
  );
}

function vrij(reden = 'eigenaar heeft gecontroleerd') {
  return geefAccountVrij(db, { accountId, reden, door: 'rubert', nu: NU, afkoeling: limieten.afkoeling });
}

describe('isAccountPauze en herstelHeftStatusOp', () => {
  it('pauze is CREDENTIALS, ERROR en STOPPED; niet PERMISSIONS, UNKNOWN of OK', () => {
    for (const s of ['CREDENTIALS', 'ERROR', 'STOPPED'] as const) assert.equal(isAccountPauze(s), true, s);
    for (const s of ['OK', 'RECONNECTED', 'PERMISSIONS', 'UNKNOWN', 'CONNECTING'] as const) {
      assert.equal(isAccountPauze(s), false, s);
    }
  });

  it('herstel heft CREDENTIALS en ERROR op (ook van de gateway), STOPPED alleen als Unipile hem meldde', () => {
    assert.equal(herstelHeftStatusOp('CREDENTIALS', true), true);
    assert.equal(herstelHeftStatusOp('ERROR', true), true);
    assert.equal(herstelHeftStatusOp('ERROR', false), true);
    assert.equal(herstelHeftStatusOp('STOPPED', true), false);
    assert.equal(herstelHeftStatusOp('STOPPED', false), true);
  });
});

describe('geefAccountVrij', () => {
  it('STOPPED: OK en dezelfde opbouwperiode als na een afkoeling, maar geen afkoeling', async () => {
    await zet('STOPPED', 1.0);
    const u = await vrij();
    assert.deepEqual(u, { vorigeStatus: 'STOPPED', opbouwVerlaagd: true });
    const acc = await vindAccount(db, accountId);
    assert.equal(acc?.status, 'OK');
    assert.equal(acc?.opbouwFactor, limieten.afkoeling.opbouw_factor_na);
    const state = { afkoelingTot: acc!.afkoelingTot };
    assert.equal(inAfkoeling(state, NU), false, 'vrijgeven start geen pauze');
    const periode = limieten.afkoeling.opbouw_periode_dagen;
    assert.equal(mogelijkeOpbouwNaAfkoeling(state, new Date(NU.getTime() + (periode - 1) * DAG), limieten.afkoeling), false);
    assert.equal(mogelijkeOpbouwNaAfkoeling(state, new Date(NU.getTime() + periode * DAG), limieten.afkoeling), true);
  });

  it('een lopende afkoeling die later eindigt, blijft staan', async () => {
    const later = new Date(NU.getTime() + 2 * DAG);
    await zet('STOPPED', 1.0, later);
    await vrij();
    const acc = await vindAccount(db, accountId);
    assert.equal(acc?.afkoelingTot?.toISOString(), later.toISOString());
  });

  it('ERROR: OK, opbouw ongewijzigd', async () => {
    await zet('ERROR', 0.9);
    const u = await vrij();
    assert.equal(u.opbouwVerlaagd, false);
    const acc = await vindAccount(db, accountId);
    assert.equal(acc?.status, 'OK');
    assert.equal(acc?.opbouwFactor, 0.9);
    assert.equal(acc?.afkoelingTot, null);
  });

  it('legt een gateway-event account_status vast met reden en wie', async () => {
    await zet('STOPPED');
    await vrij('beperking opgeheven');
    const [e] = await db.query<{ bron: string; payload: Record<string, unknown> }>(
      `select bron::text as bron, payload from events where type = 'account_status' and account_id = $1`,
      [accountId],
    );
    assert.equal(e?.bron, 'gateway');
    assert.equal(e?.payload['status'], 'OK');
    assert.equal(e?.payload['vorige_status'], 'STOPPED');
    assert.equal(e?.payload['door'], 'rubert');
    assert.equal(e?.payload['vrijgave'], true);
    assert.match(String(e?.payload['reden']), /^Vrijgegeven door rubert: beperking opgeheven$/);
    assert.equal(await statusDoorGatewayGezet(db, accountId), true);
  });

  it('weigert zonder reden, met een te lange reden, bij CREDENTIALS en bij OK (NL-melding, niets gewijzigd)', async () => {
    await zet('STOPPED');
    await assert.rejects(() => vrij('  '), (e: Error) => e instanceof AccountVrijgaveFout && /Vul een reden in/.test(e.message));
    await assert.rejects(() => vrij('x'.repeat(501)), /te lang/);
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
    await zet('CREDENTIALS');
    await assert.rejects(() => vrij(), /opnieuw inloggen/);
    assert.equal((await vindAccount(db, accountId))?.status, 'CREDENTIALS');
    await zet('OK');
    await assert.rejects(() => vrij(), /niet op ERROR of STOPPED/);
    const events = await db.query('select 1 from events');
    assert.equal(events.length, 0);
  });
});
