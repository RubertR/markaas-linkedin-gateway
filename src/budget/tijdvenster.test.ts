import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  binnenWerkuren,
  dagenInMaand,
  isWerkdag,
  lokaleDag,
  lokaleDagen,
  lokaleWeekdag,
} from './tijdvenster.ts';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';

describe('lokaleDag', () => {
  it('geeft de kalenderdag in de tijdzone van het account', () => {
    // 00:30 UTC op 2 jan is 01:30 CET op 2 jan in Amsterdam.
    assert.equal(lokaleDag(new Date('2026-01-02T00:30:00Z'), AMS), '2026-01-02');
    // 23:30 UTC op 1 jan is 00:30 CET op 2 jan in Amsterdam.
    assert.equal(lokaleDag(new Date('2026-01-01T23:30:00Z'), AMS), '2026-01-02');
    // Zelfde moment is nog 18:30 EST op 1 jan in New York.
    assert.equal(lokaleDag(new Date('2026-01-01T23:30:00Z'), NY), '2026-01-01');
  });

  it('verwerkt zomer-/wintertijd (25 oktober 2026)', () => {
    // 00:30 UTC op 25 oktober 2026 is 02:30 CEST (nog zomertijd).
    assert.equal(lokaleDag(new Date('2026-10-25T00:30:00Z'), AMS), '2026-10-25');
    // 01:30 UTC op 25 oktober 2026 is 02:30 CET (na overgang, winter).
    assert.equal(lokaleDag(new Date('2026-10-25T01:30:00Z'), AMS), '2026-10-25');
    // 23:30 UTC op 25 oktober 2026 is 00:30 CET op 26 oktober (maandag).
    assert.equal(lokaleDag(new Date('2026-10-25T23:30:00Z'), AMS), '2026-10-26');
  });
});

describe('lokaleWeekdag', () => {
  it('geeft 0 voor zondag, 1..5 voor werkdagen, 6 voor zaterdag', () => {
    // 2026-10-25 is zondag.
    assert.equal(lokaleWeekdag(new Date('2026-10-25T12:00:00Z'), AMS), 0);
    // 2026-10-26 is maandag.
    assert.equal(lokaleWeekdag(new Date('2026-10-26T12:00:00Z'), AMS), 1);
    // 2026-10-30 is vrijdag.
    assert.equal(lokaleWeekdag(new Date('2026-10-30T12:00:00Z'), AMS), 5);
    // 2026-10-31 is zaterdag.
    assert.equal(lokaleWeekdag(new Date('2026-10-31T12:00:00Z'), AMS), 6);
  });
});

describe('isWerkdag', () => {
  it('zaterdag en zondag zijn geen werkdag', () => {
    assert.equal(isWerkdag(new Date('2026-10-25T12:00:00Z'), AMS, [1, 2, 3, 4, 5]), false);
    assert.equal(isWerkdag(new Date('2026-10-31T12:00:00Z'), AMS, [1, 2, 3, 4, 5]), false);
  });

  it('maandag tot en met vrijdag zijn werkdagen', () => {
    for (const iso of [
      '2026-10-26T12:00:00Z', // ma
      '2026-10-27T12:00:00Z', // di
      '2026-10-28T12:00:00Z', // wo
      '2026-10-29T12:00:00Z', // do
      '2026-10-30T12:00:00Z', // vr
    ]) {
      assert.equal(isWerkdag(new Date(iso), AMS, [1, 2, 3, 4, 5]), true, iso);
    }
  });
});

describe('binnenWerkuren', () => {
  it('tussen 08:30 en 17:30 lokaal is binnen, daarvoor en daarna niet', () => {
    // Winter: UTC = lokaal - 1 (CET).
    const voor = new Date('2026-01-05T07:29:00Z'); // 08:29 lokaal
    const start = new Date('2026-01-05T07:30:00Z'); // 08:30 lokaal
    const midden = new Date('2026-01-05T12:00:00Z'); // 13:00 lokaal
    const einde = new Date('2026-01-05T16:30:00Z'); // 17:30 lokaal
    const na = new Date('2026-01-05T16:31:00Z'); // 17:31 lokaal

    assert.equal(binnenWerkuren(voor, AMS, '08:30', '17:30'), false);
    assert.equal(binnenWerkuren(start, AMS, '08:30', '17:30'), true);
    assert.equal(binnenWerkuren(midden, AMS, '08:30', '17:30'), true);
    assert.equal(binnenWerkuren(einde, AMS, '08:30', '17:30'), true);
    assert.equal(binnenWerkuren(na, AMS, '08:30', '17:30'), false);
  });

  it('werkt na zomer-/wintertijd (26 oktober 2026)', () => {
    // Op 26 oktober 2026 is Amsterdam al in CET (UTC+1).
    const vroeg = new Date('2026-10-26T07:29:00Z'); // 08:29 lokaal CET
    const start = new Date('2026-10-26T07:30:00Z'); // 08:30 lokaal CET
    assert.equal(binnenWerkuren(vroeg, AMS, '08:30', '17:30'), false);
    assert.equal(binnenWerkuren(start, AMS, '08:30', '17:30'), true);
  });
});

describe('lokaleDagen', () => {
  it('geeft een reeks van N lokale dagen terug, oplopend tot en met de huidige dag', () => {
    const nu = new Date('2026-10-26T12:00:00Z');
    assert.deepEqual(lokaleDagen(nu, AMS, 7), [
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
  });

  it('overbrugt zomer-/wintertijd zonder dagen te verliezen', () => {
    const nu = new Date('2026-10-26T12:00:00Z');
    const reeks = lokaleDagen(nu, AMS, 7);
    assert.equal(reeks.length, 7);
    assert.equal(reeks[0], '2026-10-20');
    assert.equal(reeks[6], '2026-10-26');
  });

  it('werkt rond maandgrens', () => {
    const nu = new Date('2026-11-02T12:00:00Z');
    assert.deepEqual(lokaleDagen(nu, AMS, 7), [
      '2026-10-27',
      '2026-10-28',
      '2026-10-29',
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });
});

describe('dagenInMaand', () => {
  it('geeft alle lokale dagen van de huidige maand tot en met vandaag', () => {
    const nu = new Date('2026-10-05T12:00:00Z');
    const reeks = dagenInMaand(nu, AMS);
    assert.equal(reeks.length, 5);
    assert.equal(reeks[0], '2026-10-01');
    assert.equal(reeks[4], '2026-10-05');
  });

  it('werkt op de eerste van de maand', () => {
    const nu = new Date('2026-11-01T12:00:00Z');
    const reeks = dagenInMaand(nu, AMS);
    assert.deepEqual(reeks, ['2026-11-01']);
  });
});
