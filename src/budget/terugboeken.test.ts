import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { vasteKlok } from './klok.ts';
import { laadLimieten, type Limieten } from './limits.ts';
import { telGebruikOpDag, verhoogGebruik } from './gebruik.ts';
import { boekTerug } from './terugboeken.ts';
import { reserveerEnVerbruik } from './verbruik.ts';

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let accountId: string;

// Woensdag 15 okt 2026, 10:00 in Amsterdam (08:00 UTC).
const NU = new Date('2026-10-15T08:00:00Z');
const DAG = '2026-10-15';

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  limieten = await laadLimieten();
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Test', slug: 'test-terug' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'u-1');
  await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [accountId]);
});

async function nieuweActie(type: 'search' | 'profile' = 'search'): Promise<string> {
  const actie = await maakActie(db, { accountId, type, payload: {}, directApproved: true });
  return actie.id;
}

function terug(actieId: string, type: 'search' | 'profile' = 'search', nu = NU) {
  return boekTerug(db, {
    accountId,
    actieId,
    type,
    nu,
    maxPerDagPerType: limieten.terugboeken.max_per_dag_per_type,
  });
}

describe('boekTerug (SPEC §5.1)', () => {
  it('verlaagt het verbruik van vandaag met 1 en markeert de actie', async () => {
    await verhoogGebruik(db, accountId, 'search', DAG, 1);
    const id = await nieuweActie();
    assert.equal(await terug(id), true);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 0);
    const actie = await vindActie(db, id);
    assert.equal(actie?.teruggeboektOp?.toISOString(), NU.toISOString());
  });

  it('gaat nooit onder 0', async () => {
    const id = await nieuweActie();
    await terug(id);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 0);
  });

  it('boekt dezelfde actie maar één keer terug', async () => {
    await verhoogGebruik(db, accountId, 'search', DAG, 2);
    const id = await nieuweActie();
    assert.equal(await terug(id), true);
    assert.equal(await terug(id), false);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
  });

  it('na de grens per dag en type telt een weigering wél mee', async () => {
    const max = limieten.terugboeken.max_per_dag_per_type;
    assert.equal(max, 3, 'standaardgrens uit config/limits.json');
    await verhoogGebruik(db, accountId, 'search', DAG, max + 1);
    for (let i = 0; i < max; i++) {
      assert.equal(await terug(await nieuweActie()), true);
    }
    const vierde = await nieuweActie();
    assert.equal(await terug(vierde), false);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
    assert.equal((await vindActie(db, vierde))?.teruggeboektOp, null);
  });

  it('telt terugboekingen per type en per lokale dag', async () => {
    const max = limieten.terugboeken.max_per_dag_per_type;
    await verhoogGebruik(db, accountId, 'search', DAG, max);
    for (let i = 0; i < max; i++) await terug(await nieuweActie());
    // Ander type: eigen teller.
    await verhoogGebruik(db, accountId, 'profile', DAG, 1);
    assert.equal(await terug(await nieuweActie('profile'), 'profile'), true);
    // Volgende dag: teller begint opnieuw.
    const morgen = new Date('2026-10-16T08:00:00Z');
    await verhoogGebruik(db, accountId, 'search', '2026-10-16', 1);
    assert.equal(await terug(await nieuweActie(), 'search', morgen), true);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', '2026-10-16'), 0);
  });

  it('na terugboeken past de enige zoekrun van de dag weer, daarna niet meer', async () => {
    const reserveer = () =>
      reserveerEnVerbruik(db, {
        accountId,
        actieType: 'search',
        goedgekeurd: true,
        klok: vasteKlok(NU),
        limieten,
        minPauzeSeconden: 0,
        laatsteActieOp: null,
      });
    assert.equal((await reserveer()).status, 'toegestaan');
    assert.notEqual((await reserveer()).status, 'toegestaan');
    await terug(await nieuweActie());
    assert.equal((await reserveer()).status, 'toegestaan');
    assert.notEqual((await reserveer()).status, 'toegestaan');
  });
});
