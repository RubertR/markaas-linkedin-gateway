import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vasteKlok } from '../budget/klok.ts';
import { zetActieStatus } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { herstelAfgewezenSequenties, herstelMislukteEersteBerichten } from './herstel.ts';
import { startSequentie, vindSequentie } from './motor.ts';
import { vasteWerkdagen } from './wachttijd.ts';

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
  await zetActieStatus(db, uit.invite!.id, 'rejected', { reden });
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

describe('herstelMislukteEersteBerichten (404 op "pending:"-chat)', () => {
  const klok = vasteKlok('2026-10-12T09:00:00Z');
  const werkdagen = vasteWerkdagen(5);

  async function sequentieMetMisluktBericht(slug: string, chatId = `pending:ACo-${slug}`) {
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
      teksten: { invite: 'Hoi', bericht: 'Dank voor de connectie', opvolging: 'Reminder' },
    });
    await zetActieStatus(db, uit.invite!.id, 'done');
    await db.query(
      `update sequences set status = 'geaccepteerd', stap = 2,
         volgende_actie_op = '2026-10-19T08:00:00Z' where id = $1`,
      [uit.sequentie.id],
    );
    await db.query(
      `insert into actions(account_id, type, payload, status, reden, sequence_id, sequence_stap)
       values ($1, 'message', $2::jsonb, 'failed', 'Onverwacht antwoord van Unipile (HTTP 404)', $3, 2)`,
      [accountId, JSON.stringify({ chatId, tekst: 'Dank voor de connectie' }), uit.sequentie.id],
    );
    return uit.sequentie.id;
  }

  async function stap2Acties(id: string) {
    return db.query<{ status: string; payload: Record<string, unknown> }>(
      `select status::text as status, payload from actions
       where sequence_id = $1 and sequence_stap = 2 order by aangemaakt_op`,
      [id],
    );
  }

  it('dry-run: toont de sequentie maar schrijft niets', async () => {
    const id = await sequentieMetMisluktBericht('erik');
    const plan = await herstelMislukteEersteBerichten(db, { klok, limieten, werkdagen }, { uitvoeren: false });
    assert.equal(plan.length, 1);
    assert.equal(plan[0]!.sequentieId, id);
    assert.equal(plan[0]!.uitgevoerd, false);
    assert.equal((await stap2Acties(id)).length, 1);
  });

  it('uitvoeren: nieuwe draft voor stap 2 met providerId en dezelfde tekst; nooit approved', async () => {
    const id = await sequentieMetMisluktBericht('erik');
    const plan = await herstelMislukteEersteBerichten(db, { klok, limieten, werkdagen }, { uitvoeren: true });
    assert.equal(plan[0]!.uitgevoerd, true);
    const acties = await stap2Acties(id);
    assert.equal(acties.length, 2);
    assert.equal(acties[0]!.status, 'failed');
    assert.equal(acties[1]!.status, 'draft');
    assert.equal(acties[1]!.payload['providerId'], 'ACo-erik');
    assert.equal(acties[1]!.payload['chatId'], undefined);
    assert.equal(acties[1]!.payload['tekst'], 'Dank voor de connectie');
    const seq = await vindSequentie(db, id);
    assert.equal(seq?.status, 'geaccepteerd');
    assert.equal(seq?.stap, 2);
    assert.ok(seq!.volgendeActieOp! > new Date('2026-10-12T09:00:00Z'));
  });

  it('is idempotent: een tweede run maakt geen tweede draft', async () => {
    const id = await sequentieMetMisluktBericht('erik');
    await herstelMislukteEersteBerichten(db, { klok, limieten, werkdagen }, { uitvoeren: true });
    const tweede = await herstelMislukteEersteBerichten(db, { klok, limieten, werkdagen }, { uitvoeren: true });
    assert.deepEqual(tweede, []);
    assert.equal((await stap2Acties(id)).length, 2);
  });

  it('laat andere mislukte berichten (met een echte chatId) en gestopte sequenties met rust', async () => {
    await sequentieMetMisluktBericht('echt', 'C-echt');
    const gestopt = await sequentieMetMisluktBericht('stop');
    await db.query(`update sequences set status = 'gestopt' where id = $1`, [gestopt]);
    const plan = await herstelMislukteEersteBerichten(db, { klok, limieten, werkdagen }, { uitvoeren: true });
    assert.deepEqual(plan, []);
  });
});
