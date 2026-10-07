import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { maakClient } from '../register/clients.ts';
import { hashToken } from '../register/uitnodiging.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  PortaalGebruikerFout,
  deactiveerGebruiker,
  gebruikUitnodiging,
  lijstGebruikers,
  maakNieuweGebruikerLink,
  nodigGebruikerUit,
  valideerNieuwWachtwoord,
  vindGebruikerVoorLogin,
  vindGeldigeGebruikerUitnodiging,
} from './gebruikers.ts';
import { maakPortaalSessie, vindPortaalSessie } from './sessies.ts';

const NU = new Date('2026-10-07T10:00:00Z');
const DAG = 24 * 60 * 60 * 1000;
const klok = vasteKlok(NU);
const opties = { klok, geldigDagen: 7 };

let db: Backend;
let close: () => Promise<void>;
let klantA: string;
let klantB: string;

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
  klantA = (await maakClient(db, { naam: 'Acme', slug: 'acme' })).id;
  klantB = (await maakClient(db, { naam: 'Bolt', slug: 'bolt' })).id;
});

describe('nodigGebruikerUit', () => {
  it('maakt een gebruiker zonder wachtwoord en een uitnodiging van 7 dagen; e-mail in kleine letters', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: ' Eva de Vries ', email: ' Eva@Acme.NL ' }, opties);
    assert.equal(r.gebruiker.email, 'eva@acme.nl');
    assert.equal(r.gebruiker.naam, 'Eva de Vries');
    assert.equal(r.gebruiker.heeftWachtwoord, false);
    assert.equal(r.uitnodiging.verlooptOp.getTime(), NU.getTime() + 7 * DAG);
    assert.ok(r.uitnodiging.token.length >= 40);
    const [rij] = await db.query<{ token_hash: string }>(
      'select token_hash from client_user_uitnodigingen',
    );
    // Alleen de hash staat in de database.
    assert.equal(rij?.token_hash, hashToken(r.uitnodiging.token));
  });

  it('weigert een ongeldig e-mailadres en een lege naam met een NL-melding', async () => {
    await assert.rejects(
      nodigGebruikerUit(db, { clientId: klantA, naam: '', email: 'geen-adres' }, opties),
      (err: Error) => err instanceof PortaalGebruikerFout && /naam/.test(err.message) && /e-mailadres/.test(err.message),
    );
  });

  it('weigert een e-mailadres dat al bestaat (ook bij een andere klant), ongeacht hoofdletters', async () => {
    await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await assert.rejects(
      nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'EVA@acme.nl' }, opties),
      /bestaat al/,
    );
    await assert.rejects(
      nodigGebruikerUit(db, { clientId: klantB, naam: 'Eva', email: 'eva@acme.nl' }, opties),
      /in gebruik/,
    );
  });
});

describe('uitnodiging gebruiken', () => {
  it('vindt een geldige uitnodiging met naam, e-mail en klantnaam', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    const u = await vindGeldigeGebruikerUitnodiging(db, r.uitnodiging.token, klok);
    assert.equal(u?.email, 'eva@acme.nl');
    assert.equal(u?.klantNaam, 'Acme');
  });

  it('zet het wachtwoord en maakt de link onbruikbaar (eenmalig)', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    const g = await gebruikUitnodiging(db, r.uitnodiging.token, 'scrypt$hash', klok);
    assert.equal(g?.id, r.gebruiker.id);
    assert.equal(g?.heeftWachtwoord, true);
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, r.uitnodiging.token, klok), null);
    assert.equal(await gebruikUitnodiging(db, r.uitnodiging.token, 'scrypt$ander', klok), null);
    const login = await vindGebruikerVoorLogin(db, 'EVA@acme.nl');
    assert.equal(login?.wachtwoordHash, 'scrypt$hash');
  });

  it('een verlopen of onbekende link werkt niet', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    const later = vasteKlok(NU.getTime() + 7 * DAG + 1000);
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, r.uitnodiging.token, later), null);
    assert.equal(await gebruikUitnodiging(db, r.uitnodiging.token, 'x', later), null);
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, 'onzin', klok), null);
  });

  it('een nieuwe link maakt de vorige open link ongeldig', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    const nieuw = await maakNieuweGebruikerLink(db, klantA, r.gebruiker.id, opties);
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, r.uitnodiging.token, klok), null);
    assert.ok(await vindGeldigeGebruikerUitnodiging(db, nieuw.token, klok));
  });

  it('wachtwoord opnieuw zetten (wachtwoord vergeten) logt bestaande sessies uit', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await gebruikUitnodiging(db, r.uitnodiging.token, 'oud', klok);
    const sessie = await maakPortaalSessie(db, r.gebruiker.id, { klok });
    const link = await maakNieuweGebruikerLink(db, klantA, r.gebruiker.id, opties);
    // Nieuwe link alleen: oude wachtwoord en sessie werken nog.
    assert.ok(await vindPortaalSessie(db, sessie.token, klok));
    await gebruikUitnodiging(db, link.token, 'nieuw', klok);
    assert.equal(await vindPortaalSessie(db, sessie.token, klok), null);
    assert.equal((await vindGebruikerVoorLogin(db, 'eva@acme.nl'))?.wachtwoordHash, 'nieuw');
  });

  it('valideert het nieuwe wachtwoord: minimaal 12 tekens en twee keer gelijk', () => {
    assert.match(valideerNieuwWachtwoord('kort', 'kort') ?? '', /12 tekens/);
    assert.match(valideerNieuwWachtwoord('lang-genoeg-123', 'lang-genoeg-124') ?? '', /niet gelijk/);
    assert.equal(valideerNieuwWachtwoord('lang-genoeg-123', 'lang-genoeg-123'), null);
  });
});

describe('deactiveren en nieuwe link', () => {
  it('deactiveren logt alle sessies uit, maakt open links ongeldig en blokkeert inloggen', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await gebruikUitnodiging(db, r.uitnodiging.token, 'hash', klok);
    const s1 = await maakPortaalSessie(db, r.gebruiker.id, { klok });
    const s2 = await maakPortaalSessie(db, r.gebruiker.id, { klok });
    const open = await maakNieuweGebruikerLink(db, klantA, r.gebruiker.id, opties);
    await deactiveerGebruiker(db, klantA, r.gebruiker.id, klok);
    assert.equal(await vindPortaalSessie(db, s1.token, klok), null);
    assert.equal(await vindPortaalSessie(db, s2.token, klok), null);
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, open.token, klok), null);
    const login = await vindGebruikerVoorLogin(db, 'eva@acme.nl');
    assert.equal(login?.gebruiker.actief, false);
  });

  it('nieuwe link voor een gedeactiveerde gebruiker activeert opnieuw en wist het oude wachtwoord', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await gebruikUitnodiging(db, r.uitnodiging.token, 'hash', klok);
    await deactiveerGebruiker(db, klantA, r.gebruiker.id, klok);
    await maakNieuweGebruikerLink(db, klantA, r.gebruiker.id, opties);
    const login = await vindGebruikerVoorLogin(db, 'eva@acme.nl');
    assert.equal(login?.gebruiker.actief, true);
    assert.equal(login?.wachtwoordHash, null);
  });

  it('beheeracties op een gebruiker van een andere klant geven een fout en wijzigen niets', async () => {
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await assert.rejects(maakNieuweGebruikerLink(db, klantB, r.gebruiker.id, opties), PortaalGebruikerFout);
    await assert.rejects(deactiveerGebruiker(db, klantB, r.gebruiker.id, klok), PortaalGebruikerFout);
    assert.ok(await vindGeldigeGebruikerUitnodiging(db, r.uitnodiging.token, klok));
  });

  it('lijstGebruikers toont alleen de gebruikers van de klant, met stand van de laatste link', async () => {
    const eva = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Eva', email: 'eva@acme.nl' }, opties);
    await nodigGebruikerUit(db, { clientId: klantA, naam: 'Adam', email: 'adam@acme.nl' }, opties);
    await nodigGebruikerUit(db, { clientId: klantB, naam: 'Bob', email: 'bob@bolt.nl' }, opties);
    await gebruikUitnodiging(db, eva.uitnodiging.token, 'hash', klok);
    const lijst = await lijstGebruikers(db, klantA, klok);
    assert.deepEqual(
      lijst.map((g) => [g.naam, g.uitnodiging, g.heeftWachtwoord]),
      [
        ['Adam', 'open', false],
        ['Eva', 'gebruikt', true],
      ],
    );
  });
});
