import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';

import { laadIntake, type Intake, type IntakeRonde } from '../config/intake.ts';

import { leesRondeUitFormulier, ontbrekendeVerplichte, samenvatting, type Antwoorden } from './invoer.ts';

let intake: Intake;
let ronde: (id: string) => IntakeRonde;

before(async () => {
  intake = await laadIntake();
  ronde = (id) => intake.rondes.find((r) => r.id === id)!;
});

describe('leesRondeUitFormulier', () => {
  it('leest tekst, meerdere keuzes en "anders" van één ronde', () => {
    const r = leesRondeUitFormulier(ronde('propositie'), {
      v_wat_verkoopt: '  Interim salesleiding  ',
      v_probleem: 'Te weinig nieuwe klanten',
      v_kernwaarde: ['Meer omzet of nieuwe klanten', 'Tijdwinst of efficiëntie'],
      v_kernwaarde_anders: 'Rust in het team',
    });
    assert.deepEqual(r.fouten, []);
    assert.deepEqual(r.antwoorden['wat_verkoopt'], { tekst: 'Interim salesleiding' });
    assert.deepEqual(r.antwoorden['kernwaarde'], {
      keuzes: ['Meer omzet of nieuwe klanten', 'Tijdwinst of efficiëntie'],
      anders: 'Rust in het team',
    });
  });

  it('negeert opties die niet in de configuratie staan (geknoeid formulier)', () => {
    const r = leesRondeUitFormulier(ronde('doelgroep'), {
      v_sectoren: ['Energie', '<script>alert(1)</script>'],
      v_regio: 'Mars',
    });
    assert.deepEqual(r.antwoorden['sectoren'], { keuzes: ['Energie'] });
    assert.deepEqual(r.antwoorden['regio'], {});
  });

  it('enkele keuze met "anders" bewaart de vrije tekst', () => {
    const r = leesRondeUitFormulier(ronde('doelgroep'), { v_regio: '__anders__', v_regio_anders: 'Duitsland' });
    assert.deepEqual(r.antwoorden['regio'], { keuzes: [], anders: 'Duitsland' });
  });

  it('kapt vrije tekst af op 1000 tekens en "anders" op 300', () => {
    const r = leesRondeUitFormulier(ronde('propositie'), {
      v_wat_verkoopt: 'x'.repeat(1500),
      v_kernwaarde_anders: 'y'.repeat(500),
    });
    assert.equal(r.antwoorden['wat_verkoopt']!.tekst!.length, 1000);
    assert.equal(r.antwoorden['kernwaarde']!.anders!.length, 300);
  });

  it('claims: alleen met vinkje; een ingevulde claim zonder vinkje geeft een NL-fout', () => {
    const goed = leesRondeUitFormulier(ronde('bewijs'), {
      v_claims_tekst_1: 'Ruim 30% respons bij Acme',
      v_claims_ok_1: 'ja',
      v_claims_tekst_2: '',
      v_aanbod: 'Demo',
    });
    assert.deepEqual(goed.fouten, []);
    assert.deepEqual(goed.antwoorden['claims'], { claims: [{ tekst: 'Ruim 30% respons bij Acme', bevestigd: true }] });

    const fout = leesRondeUitFormulier(ronde('bewijs'), { v_claims_tekst_1: 'Geen resultaat, geen factuur' });
    assert.equal(fout.fouten.length, 1);
    assert.match(fout.fouten[0]!, /vinkje/);
  });

  it('claims boven het maximum worden genegeerd', () => {
    const velden: Record<string, string> = {};
    for (let n = 1; n <= 8; n += 1) {
      velden[`v_claims_tekst_${n}`] = `Claim ${n}`;
      velden[`v_claims_ok_${n}`] = 'ja';
    }
    const r = leesRondeUitFormulier(ronde('bewijs'), velden);
    assert.equal(r.antwoorden['claims']!.claims!.length, 5);
  });
});

describe('ontbrekendeVerplichte en samenvatting', () => {
  it('noemt elke verplichte vraag zonder antwoord, met de ronde erbij', () => {
    const antwoorden: Antwoorden = { wat_verkoopt: { tekst: 'Iets' } };
    const ontbreekt = ontbrekendeVerplichte(intake, antwoorden);
    assert.ok(ontbreekt.some((o) => /Propositie/.test(o) && /probleem/.test(o)));
    assert.ok(!ontbreekt.some((o) => /Wat verkoopt u/.test(o)));
  });

  it('een keuzevraag met alleen "anders" telt als beantwoord', () => {
    const ontbreekt = ontbrekendeVerplichte(intake, { regio: { keuzes: [], anders: 'Duitsland' } });
    assert.ok(!ontbreekt.some((o) => /In welke regio/.test(o)));
  });

  it('samenvatting zet antwoorden in gewone taal per ronde', () => {
    const s = samenvatting(intake, {
      kernwaarde: { keuzes: ['Kostenbesparing'], anders: 'Rust' },
      claims: { claims: [{ tekst: 'Klant X', bevestigd: true }] },
    });
    const propositie = s.find((r) => r.rondeId === 'propositie')!;
    assert.equal(propositie.regels.find((r) => r.vraagId === 'kernwaarde')!.waarde, 'Kostenbesparing; anders: Rust');
    assert.equal(propositie.regels.find((r) => r.vraagId === 'wat_verkoopt')!.waarde, '');
    const bewijs = s.find((r) => r.rondeId === 'bewijs')!;
    assert.equal(bewijs.regels.find((r) => r.vraagId === 'claims')!.waarde, 'Klant X');
  });
});
