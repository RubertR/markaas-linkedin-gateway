import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { laadLimieten } from '../budget/limits.ts';

import { vastePauze, zaadRandom } from './pauze.ts';

describe('zaadRandom', () => {
  it('kiest pauze tussen min en max uit limits.json', async () => {
    const l = await laadLimieten();
    const kiezer = zaadRandom(42);
    for (let i = 0; i < 100; i++) {
      const sec = kiezer.kies(l.tijdvenster.pauze_tussen_acties_minuten);
      assert.ok(sec >= l.tijdvenster.pauze_tussen_acties_minuten.min * 60);
      assert.ok(sec <= l.tijdvenster.pauze_tussen_acties_minuten.max * 60);
    }
  });

  it('is deterministisch met een vast zaad', async () => {
    const l = await laadLimieten();
    const a = zaadRandom(123);
    const b = zaadRandom(123);
    const grens = l.tijdvenster.pauze_tussen_acties_minuten;
    for (let i = 0; i < 10; i++) {
      assert.equal(a.kies(grens), b.kies(grens));
    }
  });
});

describe('vastePauze', () => {
  it('geeft altijd dezelfde pauze terug (handig voor tests)', () => {
    const pauze = vastePauze(300);
    const grens = { min: 2, max: 8 };
    assert.equal(pauze.kies(grens), 300);
    assert.equal(pauze.kies(grens), 300);
  });
});
