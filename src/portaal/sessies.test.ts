import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { maakClient } from '../register/clients.ts';
import { hashToken } from '../register/uitnodiging.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { gebruikUitnodiging, nodigGebruikerUit } from './gebruikers.ts';
import {
  PORTAAL_SESSIE_DUUR_MS,
  maakPortaalSessie,
  verwijderPortaalSessie,
  vindPortaalSessie,
} from './sessies.ts';

const NU = new Date('2026-10-07T10:00:00Z');
const klok = vasteKlok(NU);

let db: Backend;
let close: () => Promise<void>;
let gebruikerId: string;
let clientId: string;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from portal_sessions');
  await db.query('delete from client_user_uitnodigingen');
  await db.query('delete from client_users');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  clientId = (await maakClient(db, { naam: 'Acme', slug: 'acme' })).id;
  const r = await nodigGebruikerUit(
    db,
    { clientId, naam: 'Eva', email: 'eva@acme.nl' },
    { klok, geldigDagen: 7 },
  );
  await gebruikUitnodiging(db, r.uitnodiging.token, 'hash', klok);
  gebruikerId = r.gebruiker.id;
});

describe('portaalsessies in de database (SPEC §14.3)', () => {
  it('slaat alleen de hash van het token op en geeft gebruiker, klant en CSRF-token terug', async () => {
    const s = await maakPortaalSessie(db, gebruikerId, { klok });
    const rijen = await db.query<{ id: string }>('select id from portal_sessions');
    assert.deepEqual(rijen.map((r) => r.id), [hashToken(s.token)]);
    const gevonden = await vindPortaalSessie(db, s.token, klok);
    assert.equal(gevonden?.gebruikerId, gebruikerId);
    assert.equal(gevonden?.clientId, clientId);
    assert.equal(gevonden?.email, 'eva@acme.nl');
    assert.equal(gevonden?.klantNaam, 'Acme');
    assert.equal(gevonden?.csrfToken, s.csrfToken);
    assert.equal(gevonden?.verlooptOp.getTime(), NU.getTime() + PORTAAL_SESSIE_DUUR_MS);
  });

  it('weigert een verlopen sessie (na 12 uur) en een onbekend token', async () => {
    const s = await maakPortaalSessie(db, gebruikerId, { klok });
    const bijna = vasteKlok(NU.getTime() + PORTAAL_SESSIE_DUUR_MS - 1000);
    const voorbij = vasteKlok(NU.getTime() + PORTAAL_SESSIE_DUUR_MS);
    assert.ok(await vindPortaalSessie(db, s.token, bijna));
    assert.equal(await vindPortaalSessie(db, s.token, voorbij), null);
    assert.equal(await vindPortaalSessie(db, 'onbekend', klok), null);
    assert.equal(await vindPortaalSessie(db, '', klok), null);
  });

  it('werkt laatst_gezien_op bij', async () => {
    const s = await maakPortaalSessie(db, gebruikerId, { klok });
    const later = new Date(NU.getTime() + 60_000);
    await vindPortaalSessie(db, s.token, vasteKlok(later));
    const [rij] = await db.query<{ laatst_gezien_op: string | Date }>(
      'select laatst_gezien_op from portal_sessions',
    );
    assert.equal(new Date(rij!.laatst_gezien_op).getTime(), later.getTime());
  });

  it('sessie van een gedeactiveerde gebruiker of klant werkt niet', async () => {
    const s = await maakPortaalSessie(db, gebruikerId, { klok });
    await db.query('update client_users set actief = false where id = $1', [gebruikerId]);
    assert.equal(await vindPortaalSessie(db, s.token, klok), null);
    await db.query('update client_users set actief = true where id = $1', [gebruikerId]);
    await db.query('update clients set actief = false where id = $1', [clientId]);
    assert.equal(await vindPortaalSessie(db, s.token, klok), null);
  });

  it('verwijderen (uitloggen) maakt de sessie ongeldig', async () => {
    const s = await maakPortaalSessie(db, gebruikerId, { klok });
    await verwijderPortaalSessie(db, s.token);
    assert.equal(await vindPortaalSessie(db, s.token, klok), null);
  });
});
