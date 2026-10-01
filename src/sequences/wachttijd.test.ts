import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  lokaleWeekdagKort,
  teltDoorWerkdagen,
  vasteWerkdagen,
} from './wachttijd.ts';

describe('teltDoorWerkdagen', () => {
  it('telt 2 werkdagen vanaf maandag correct door naar woensdag', () => {
    const start = new Date('2026-10-05T09:00:00Z'); // ma
    const doel = teltDoorWerkdagen(start, 2, 'Europe/Amsterdam');
    assert.equal(lokaleWeekdagKort(doel, 'Europe/Amsterdam'), 'Wed');
  });

  it('slaat zaterdag en zondag over bij 1 werkdag vanaf vrijdag → maandag', () => {
    const vrijdag = new Date('2026-10-09T09:00:00Z');
    const doel = teltDoorWerkdagen(vrijdag, 1, 'Europe/Amsterdam');
    assert.equal(lokaleWeekdagKort(doel, 'Europe/Amsterdam'), 'Mon');
  });

  it('0 werkdagen geeft hetzelfde moment terug', () => {
    const start = new Date('2026-10-05T09:00:00Z');
    const doel = teltDoorWerkdagen(start, 0, 'Europe/Amsterdam');
    assert.equal(doel.getTime(), start.getTime());
  });

  it('werpt een fout bij een negatief of niet-geheel getal', () => {
    assert.throws(
      () => teltDoorWerkdagen(new Date(), -1, 'Europe/Amsterdam'),
      /werkdagen/,
    );
    assert.throws(
      () => teltDoorWerkdagen(new Date(), 1.5, 'Europe/Amsterdam'),
      /werkdagen/,
    );
  });
});

describe('vasteWerkdagen', () => {
  it('geeft altijd dezelfde waarde terug', () => {
    const kiezer = vasteWerkdagen(4);
    assert.equal(kiezer.kies({ min: 1, max: 3 }), 4);
    assert.equal(kiezer.kies({ min: 5, max: 7 }), 4);
  });
});
