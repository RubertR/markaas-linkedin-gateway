import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Klok } from '../budget/klok.ts';
import { laadIntake, type Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import type { Antwoorden } from './invoer.ts';
import {
  ProfielConflictFout,
  ProfielFout,
  berichtenVoorProfiel,
  dienIn,
  profielActie,
  profielStand,
  profielVoorSlug,
  slaRondeOp,
  stelVast,
  stuurTerug,
  vraagWijzigingAan,
  werkInterneAanvullingBij,
} from './profielen.ts';

let db: Backend;
let close: () => Promise<void>;
let intake: Intake;
let klantA: string;
let klantB: string;
const klok: Klok = { nu: () => new Date('2026-10-08T10:00:00Z') };

/** Alle verplichte vragen beantwoord. */
const VOLLEDIG: Antwoorden = {
  wat_verkoopt: { tekst: 'Interim salesleiding' },
  probleem: { tekst: 'Te weinig nieuwe klanten' },
  kernwaarde: { keuzes: ['Meer omzet of nieuwe klanten'] },
  sectoren: { keuzes: ['Energie'] },
  omvang: { keuzes: ['201–500'] },
  regio: { keuzes: ['Nederland'] },
  functies: { keuzes: ['Sales director of CCO'] },
  triggers: { keuzes: ['Overname of fusie'] },
  afzenders: { tekst: 'Pieter (Pieter), Fedor (Fedor)' },
  merk: { keuzes: ['Onze eigen bedrijfsnaam'] },
  aanspreekvorm: { keuzes: ['Je'] },
  taal: { keuzes: ['Nederlands'] },
  aanbod: { keuzes: ['Vrijblijvend gesprek van een half uur'] },
};

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  intake = await laadIntake();
});

after(async () => close());

beforeEach(async () => {
  await db.query('delete from klantprofielen');
  await db.query('delete from clients');
  klantA = (await maakClient(db, { naam: 'TAG', slug: 'tag', abonnementVereist: false })).id;
  klantB = (await maakClient(db, { naam: 'Bolt', slug: 'bolt' })).id;
});

async function ingediend(clientId = klantA) {
  const p = await slaRondeOp(db, { clientId, antwoorden: VOLLEDIG, revisie: 0, intake, klok });
  return await dienIn(db, { clientId, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok });
}

describe('klantprofielen: invullen en indienen', () => {
  it('eerste opslag maakt versie 1 als concept; profielActie is "invullen"', async () => {
    assert.equal(profielActie(await profielStand(db, klantA)), 'invullen');
    const p = await slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'x' } }, revisie: 0, intake, klok });
    assert.equal(p.versie, 1);
    assert.equal(p.status, 'concept');
    assert.equal(p.revisie, 1);
    assert.equal(p.intakeVersie, intake.versie);
    assert.equal(profielActie(await profielStand(db, klantA)), 'invullen');
  });

  it('volgende rondes vullen aan; antwoorden van onbekende vragen worden niet bewaard', async () => {
    const p1 = await slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'x' } }, revisie: 0, intake, klok });
    const p2 = await slaRondeOp(db, {
      clientId: klantA,
      antwoorden: { sectoren: { keuzes: ['Energie'] }, verzonnen: { tekst: 'weg' } },
      revisie: p1.revisie,
      intake,
      klok,
    });
    assert.deepEqual(p2.antwoorden, { probleem: { tekst: 'x' }, sectoren: { keuzes: ['Energie'] } });
    assert.equal(p2.revisie, 2);
  });

  it('opslaan met een oude revisie geeft een conflict en verandert niets (twee collega\'s)', async () => {
    const p1 = await slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'eerst' } }, revisie: 0, intake, klok });
    await slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'collega' } }, revisie: p1.revisie, intake, klok });
    await assert.rejects(
      () => slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'ik' } }, revisie: p1.revisie, intake, klok }),
      ProfielConflictFout,
    );
    const { open } = await profielStand(db, klantA);
    assert.equal(open!.antwoorden['probleem']!.tekst, 'collega');
  });

  it('indienen weigert met een NL-lijst van ontbrekende verplichte vragen', async () => {
    const p = await slaRondeOp(db, { clientId: klantA, antwoorden: { probleem: { tekst: 'x' } }, revisie: 0, intake, klok });
    await assert.rejects(
      () => dienIn(db, { clientId: klantA, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok }),
      (err: Error) => err instanceof ProfielFout && /verplichte vragen/.test(err.message) && /Wat verkoopt u/.test(err.message),
    );
  });

  it('indienen zet status, wie en wanneer; daarna kan de klant niet meer wijzigen', async () => {
    const p = await ingediend();
    assert.equal(p.status, 'ingediend');
    assert.equal(p.ingediendDoor, 'klant:eva@tag.nl');
    assert.equal(profielActie(await profielStand(db, klantA)), 'ingediend');
    await assert.rejects(
      () => slaRondeOp(db, { clientId: klantA, antwoorden: {}, revisie: p.revisie, intake, klok }),
      /ingediend/,
    );
  });
});

describe('klantprofielen: beoordelen door MARKaaS', () => {
  it('terugsturen met een vraag zet het profiel terug op concept; indienen wist de vraag', async () => {
    await ingediend();
    await assert.rejects(() => stuurTerug(db, { clientId: klantA, vraag: '  ', klok }), /vraag/);
    const terug = await stuurTerug(db, { clientId: klantA, vraag: 'Welke sectoren eerst?', klok });
    assert.equal(terug.status, 'concept');
    assert.equal(profielActie(await profielStand(db, klantA)), 'vraag');
    const opnieuw = await dienIn(db, { clientId: klantA, revisie: terug.revisie, door: 'klant:eva@tag.nl', intake, klok });
    assert.equal(opnieuw.vraagVanMarkaas, null);
  });

  it('vaststellen kan alleen na indienen en bewaart de interne aanvulling', async () => {
    await slaRondeOp(db, { clientId: klantA, antwoorden: VOLLEDIG, revisie: 0, intake, klok });
    await assert.rejects(
      () => stelVast(db, { clientId: klantA, interneAanvulling: '', door: 'rubert', klok }),
      /Alleen een ingediend/,
    );
    await dienIn(db, { clientId: klantA, revisie: 1, door: 'rubert', intake, klok });
    const v = await stelVast(db, { clientId: klantA, interneAanvulling: ' keywords: energie ', door: 'rubert', klok });
    assert.equal(v.status, 'vastgesteld');
    assert.equal(v.interneAanvulling, 'keywords: energie');
    assert.equal(profielActie(await profielStand(db, klantA)), 'klaar');
  });

  it('wijziging aanvragen kopieert de vastgestelde versie; vaststellen vervangt de oude', async () => {
    await ingediend();
    const v1 = await stelVast(db, { clientId: klantA, interneAanvulling: 'filters v1', door: 'rubert', klok });
    const w = await vraagWijzigingAan(db, { clientId: klantA, klok });
    assert.equal(w.versie, 2);
    assert.equal(w.status, 'concept');
    assert.deepEqual(w.antwoorden, v1.antwoorden);
    assert.equal(w.interneAanvulling, 'filters v1');
    assert.equal((await vraagWijzigingAan(db, { clientId: klantA, klok })).id, w.id, 'dubbel klikken: geen tweede versie');
    assert.equal(profielActie(await profielStand(db, klantA)), 'wijziging');

    await dienIn(db, { clientId: klantA, revisie: w.revisie, door: 'klant:eva@tag.nl', intake, klok });
    const v2 = await stelVast(db, { clientId: klantA, interneAanvulling: 'filters v2', door: 'rubert', klok });
    assert.equal(v2.versie, 2);
    const statussen = await db.query<{ versie: number; status: string }>(
      'select versie, status from klantprofielen where client_id = $1 order by versie',
      [klantA],
    );
    assert.deepEqual(statussen, [
      { versie: 1, status: 'vervangen' },
      { versie: 2, status: 'vastgesteld' },
    ]);
  });

  it('een vastgesteld profiel wijzig je niet zonder "Wijziging aanvragen"', async () => {
    await ingediend();
    await stelVast(db, { clientId: klantA, interneAanvulling: '', door: 'rubert', klok });
    await assert.rejects(
      () => slaRondeOp(db, { clientId: klantA, antwoorden: {}, revisie: 0, intake, klok }),
      /Wijziging aanvragen/,
    );
  });

  it('interne aanvulling van het vastgestelde profiel bijwerken, met maximum', async () => {
    await assert.rejects(() => werkInterneAanvullingBij(db, { clientId: klantA, interneAanvulling: 'x', klok }), ProfielFout);
    await ingediend();
    await stelVast(db, { clientId: klantA, interneAanvulling: '', door: 'rubert', klok });
    const p = await werkInterneAanvullingBij(db, { clientId: klantA, interneAanvulling: 'nieuw', klok });
    assert.equal(p.interneAanvulling, 'nieuw');
    await assert.rejects(
      () => werkInterneAanvullingBij(db, { clientId: klantA, interneAanvulling: 'x'.repeat(10_001), klok }),
      /te lang/,
    );
  });
});

describe('klantprofielen: afscherming en skill', () => {
  it('profielen van klant A en klant B staan los van elkaar', async () => {
    await ingediend(klantA);
    const stand = await profielStand(db, klantB);
    assert.equal(stand.open, null);
    assert.equal(stand.vastgesteld, null);
    await assert.rejects(() => stelVast(db, { clientId: klantB, interneAanvulling: '', door: 'rubert', klok }), ProfielFout);
  });

  it('profielVoorSlug geeft de vastgestelde versie plus de status van een nieuwere', async () => {
    assert.equal(await profielVoorSlug(db, 'onbekend'), null);
    const leeg = await profielVoorSlug(db, 'tag');
    assert.equal(leeg!.vastgesteld, null);

    await ingediend();
    await stelVast(db, { clientId: klantA, interneAanvulling: 'f', door: 'rubert', klok });
    await vraagWijzigingAan(db, { clientId: klantA, klok });
    const p = await profielVoorSlug(db, 'tag');
    assert.equal(p!.vastgesteld!.versie, 1);
    assert.deepEqual(p!.nieuwereVersie, { versie: 2, status: 'concept' });
  });
});

describe('klantprofielen: vraag en antwoord (SPEC 0.4)', () => {
  it('terugsturen bewaart de vraag als bericht van MARKaaS; indienen met antwoord als bericht van de klant', async () => {
    await ingediend();
    const terug = await stuurTerug(db, { clientId: klantA, vraag: 'Welke sector eerst?', klok });
    const na = await dienIn(db, {
      clientId: klantA,
      revisie: terug.revisie,
      door: 'klant:eva@tag.nl',
      intake,
      klok,
      antwoord: '  Energie, daarna facilitair.  ',
    });
    const gesprek = await berichtenVoorProfiel(db, klantA, na.id);
    assert.deepEqual(
      gesprek.map((b) => [b.van, b.tekst, b.door]),
      [
        ['markaas', 'Welke sector eerst?', 'rubert'],
        ['klant', 'Energie, daarna facilitair.', 'klant:eva@tag.nl'],
      ],
    );
  });

  it('indienen zonder antwoord maakt geen bericht; een te lang antwoord geeft een NL-melding', async () => {
    const p = await slaRondeOp(db, { clientId: klantA, antwoorden: VOLLEDIG, revisie: 0, intake, klok });
    await assert.rejects(
      () => dienIn(db, { clientId: klantA, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok, antwoord: 'x'.repeat(1001) }),
      /antwoord is te lang/,
    );
    const na = await dienIn(db, { clientId: klantA, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok, antwoord: '   ' });
    assert.deepEqual(await berichtenVoorProfiel(db, klantA, na.id), []);
  });

  it('berichten van klant A zijn niet op te vragen met de klant-id van klant B', async () => {
    await ingediend();
    const terug = await stuurTerug(db, { clientId: klantA, vraag: 'Vraag?', klok });
    assert.equal((await berichtenVoorProfiel(db, klantA, terug.id)).length, 1);
    assert.equal((await berichtenVoorProfiel(db, klantB, terug.id)).length, 0);
  });
});
