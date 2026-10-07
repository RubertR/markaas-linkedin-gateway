import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { bepaalStand, resultatenVoorKlant, weekStarts } from './resultaten.ts';

// Woensdag 7 oktober 2026; maandag van deze week is 5 oktober.
const NU = new Date('2026-10-07T10:00:00Z');
const klok = vasteKlok(NU);

let db: Backend;
let close: () => Promise<void>;
let klantA: string;
let klantB: string;
let accA1: string;
let accA2: string;
let accB: string;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from events');
  await db.query('delete from actions');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  klantA = (await maakClient(db, { naam: 'Acme', slug: 'acme' })).id;
  klantB = (await maakClient(db, { naam: 'Bolt', slug: 'bolt' })).id;
  accA1 = (await registreerAccount(db, { clientId: klantA, eigenaarNaam: 'Eva', abonnement: 'premium_business' })).id;
  accA2 = (await registreerAccount(db, { clientId: klantA, eigenaarNaam: 'Adam', abonnement: 'free' })).id;
  accB = (await registreerAccount(db, { clientId: klantB, eigenaarNaam: 'Bob', abonnement: 'free' })).id;
  await markeerAccountGekoppeld(db, accA1, 'uni-a1');
  await markeerAccountGekoppeld(db, accB, 'uni-b');
});

async function invite(accountId: string, status: string, uitgevoerdOp: string | null): Promise<void> {
  await db.query(
    `insert into actions(account_id, type, payload, status, uitgevoerd_op)
     values ($1, 'invite', '{}'::jsonb, $2::action_status, $3)`,
    [accountId, status, uitgevoerdOp],
  );
}

async function event(accountId: string, type: string, op: string, payload: Record<string, unknown> = {}): Promise<void> {
  await db.query(
    `insert into events(bron, type, account_id, payload, ontvangen_op)
     values ('gateway', $1, $2, $3::jsonb, $4)`,
    [type, accountId, JSON.stringify(payload), op],
  );
}

describe('weekStarts', () => {
  it('geeft 8 maandagen, oudste eerst, eindigend in de huidige week (Europe/Amsterdam)', () => {
    const w = weekStarts(NU, 'Europe/Amsterdam', 8);
    assert.equal(w.length, 8);
    assert.equal(w[7], '2026-10-05');
    assert.equal(w[0], '2026-08-17');
    // Zondagnacht 23:30 UTC is maandag 01:30 in Amsterdam.
    assert.equal(weekStarts(new Date('2026-10-04T23:30:00Z'), 'Europe/Amsterdam', 1)[0], '2026-10-05');
  });
});

describe('bepaalStand', () => {
  const basis = {
    gekoppeld: true,
    status: 'OK' as const,
    afkoelingTot: null,
    opbouwFactor: 1,
  };
  it('kiest de stand in gewone taal-volgorde', () => {
    assert.equal(bepaalStand({ ...basis, gekoppeld: false, status: 'CONNECTING' }, NU), 'niet_gekoppeld');
    assert.equal(bepaalStand({ ...basis, status: 'CREDENTIALS' }, NU), 'opnieuw_koppelen');
    assert.equal(bepaalStand({ ...basis, status: 'ERROR' }, NU), 'storing');
    assert.equal(bepaalStand({ ...basis, afkoelingTot: new Date(NU.getTime() + 1000) }, NU), 'afkoeling');
    assert.equal(bepaalStand({ ...basis, afkoelingTot: new Date(NU.getTime() - 1000) }, NU), 'gekoppeld');
    assert.equal(bepaalStand({ ...basis, opbouwFactor: 0.5 }, NU), 'opbouw');
    assert.equal(bepaalStand({ ...basis, status: 'RECONNECTED' }, NU), 'gekoppeld');
  });
});

describe('resultatenVoorKlant', () => {
  it('telt per account en per week verstuurde verzoeken, acceptaties en reacties', async () => {
    await invite(accA1, 'done', '2026-10-05T09:00:00Z');
    await invite(accA1, 'onzeker', '2026-10-06T09:00:00Z'); // onzeker telt mee (kan verstuurd zijn)
    await invite(accA1, 'done', '2026-10-04T23:30:00Z'); // maandag 01:30 lokaal → deze week
    await invite(accA1, 'done', '2026-09-30T09:00:00Z'); // vorige week
    await invite(accA1, 'done', '2026-08-01T09:00:00Z'); // buiten 8 weken
    await invite(accA1, 'draft', null);
    await invite(accA1, 'rejected', null);
    await event(accA1, 'acceptatie', '2026-10-06T12:00:00Z');
    await event(accA1, 'acceptatie', '2026-09-29T12:00:00Z');
    // Twee berichten in hetzelfde gesprek = één reactie.
    await event(accA1, 'message_received', '2026-10-06T13:00:00Z', { chat_id: 'c1' });
    await event(accA1, 'message_received', '2026-10-06T14:00:00Z', { chat_id: 'c1' });
    await event(accA1, 'message_received', '2026-10-07T08:00:00Z', { chat_id: 'c2' });
    await event(accA1, 'message_sent_self', '2026-10-07T08:00:00Z', { chat_id: 'c3' });
    // Klant B telt nergens mee.
    await invite(accB, 'done', '2026-10-05T09:00:00Z');
    await event(accB, 'acceptatie', '2026-10-06T12:00:00Z');

    const r = await resultatenVoorKlant(db, klantA, klok);
    assert.deepEqual(r.map((a) => a.eigenaarNaam).sort(), ['Adam', 'Eva']);
    const eva = r.find((a) => a.accountId === accA1)!;
    assert.equal(eva.weken.length, 8);
    assert.deepEqual(eva.weken[7], { weekStart: '2026-10-05', verzoeken: 3, acceptaties: 1, reacties: 2 });
    assert.deepEqual(eva.weken[6], { weekStart: '2026-09-28', verzoeken: 1, acceptaties: 1, reacties: 0 });
    assert.deepEqual(eva.totaal, { verzoeken: 4, acceptaties: 2, reacties: 2 });
    assert.equal(eva.stand, 'opbouw'); // nieuw gekoppeld: opbouw_factor 0.5
    const adam = r.find((a) => a.accountId === accA2)!;
    assert.equal(adam.stand, 'niet_gekoppeld');
    assert.deepEqual(adam.totaal, { verzoeken: 0, acceptaties: 0, reacties: 0 });
    assert.ok(!r.some((a) => a.accountId === accB));
  });
});
