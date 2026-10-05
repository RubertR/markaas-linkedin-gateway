import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { zetActieStatus } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { herstelAfgewezenSequenties } from './herstel.ts';
import { startSequentie, vindSequentie } from './motor.ts';

let db: Backend;
let close: () => Promise<void>;
let accountId: string;
let limieten: Limieten;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const klant = await maakClient(db, { naam: 'Test', slug: 't' });
  const account = await registreerAccount(db, {
    clientId: klant.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'uni-herstel');
});

async function sequentieMetAfgewezenInvite(slug: string, reden: string) {
  const uit = await startSequentie(db, {
    accountId,
    lead: {
      providerId: `ACo-${slug}`,
      naam: slug,
      functie: 'CTO',
      bedrijf: 'Flux',
      linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
      waarom: 'Lead',
    },
    teksten: { invite: 'Hoi', bericht: 'Dank', opvolging: 'Reminder' },
  });
  // Oude situatie: invite afgewezen, sequentie bleef 'lopend'.
  await zetActieStatus(db, uit.invite.id, 'rejected', { reden });
  return uit.sequentie.id;
}

async function gezondeSequentie(slug: string) {
  const uit = await startSequentie(db, {
    accountId,
    lead: {
      providerId: `ACo-${slug}`,
      naam: slug,
      functie: 'CTO',
      bedrijf: 'Flux',
      linkedinUrl: `https://www.linkedin.com/in/${slug}/`,
      waarom: 'Lead',
    },
    teksten: { invite: 'Hoi', bericht: 'Dank', opvolging: 'Reminder' },
  });
  return uit.sequentie.id;
}

describe('herstelAfgewezenSequenties', () => {
  it('dry-run: toont de lopende sequenties met een afgewezen stap en wijzigt niets', async () => {
    const a = await sequentieMetAfgewezenInvite('a', 'te formeel');
    const b = await sequentieMetAfgewezenInvite('b', 'verkeerde lead');
    const gezond = await gezondeSequentie('c');

    const plan = await herstelAfgewezenSequenties(db, limieten, { uitvoeren: false });
    assert.deepEqual(plan.map((p) => p.sequentieId).sort(), [a, b].sort());
    const pa = plan.find((p) => p.sequentieId === a)!;
    assert.equal(pa.stap, 1);
    assert.equal(pa.stopReden, 'afgewezen bij goedkeuring: te formeel');
    assert.equal(pa.uitgevoerd, false);

    assert.equal((await vindSequentie(db, a))?.status, 'lopend');
    assert.equal((await vindSequentie(db, gezond))?.status, 'lopend');
  });

  it('uitvoeren: zet ze op gestopt met de afwijzingsreden, laat gezonde met rust', async () => {
    const a = await sequentieMetAfgewezenInvite('a', 'te formeel');
    const gezond = await gezondeSequentie('c');

    const plan = await herstelAfgewezenSequenties(db, limieten, { uitvoeren: true });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.uitgevoerd, true);

    const seq = await vindSequentie(db, a);
    assert.equal(seq?.status, 'gestopt');
    assert.equal(seq?.stopReden, 'afgewezen bij goedkeuring: te formeel');
    assert.equal(seq?.volgendeActieOp, null);
    assert.equal((await vindSequentie(db, gezond))?.status, 'lopend');
  });

  it('is idempotent: een tweede run vindt niets meer', async () => {
    await sequentieMetAfgewezenInvite('a', 'te formeel');
    await herstelAfgewezenSequenties(db, limieten, { uitvoeren: true });
    const tweede = await herstelAfgewezenSequenties(db, limieten, { uitvoeren: true });
    assert.deepEqual(tweede, []);
  });

  it('na herstel kan de lead opnieuw gestart worden', async () => {
    await sequentieMetAfgewezenInvite('a', 'te formeel');
    await herstelAfgewezenSequenties(db, limieten, { uitvoeren: true });
    const opnieuw = await gezondeSequentie('a');
    assert.equal((await vindSequentie(db, opnieuw))?.status, 'lopend');
  });

  it('raakt sequenties met status reactie niet (die hebben ook afgewezen stappen)', async () => {
    const id = await sequentieMetAfgewezenInvite('r', 'lead heeft gereageerd');
    await db.query(`update sequences set status = 'reactie' where id = $1`, [id]);
    const plan = await herstelAfgewezenSequenties(db, limieten, { uitvoeren: true });
    assert.deepEqual(plan, []);
    assert.equal((await vindSequentie(db, id))?.status, 'reactie');
  });
});
