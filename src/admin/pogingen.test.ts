import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { PogingenTracker } from './pogingen.ts';

describe('PogingenTracker', () => {
  it('is pas geblokkeerd na 5 foute pogingen', () => {
    const klok = { nu: () => new Date('2026-10-06T10:00:00Z') };
    const t = new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok });
    for (let i = 0; i < 4; i++) {
      t.registreerFout('ip-1');
      assert.equal(t.isGeblokkeerd('ip-1'), false, `na ${i + 1} fouten nog niet geblokkeerd`);
    }
    t.registreerFout('ip-1');
    assert.equal(t.isGeblokkeerd('ip-1'), true, 'na 5 fouten geblokkeerd');
  });

  it('houdt 15 minuten blokkade aan en meldt resterende tijd', () => {
    let now = new Date('2026-10-06T10:00:00Z').getTime();
    const klok = { nu: () => new Date(now) };
    const t = new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok });
    for (let i = 0; i < 5; i++) t.registreerFout('ip-1');
    assert.equal(t.isGeblokkeerd('ip-1'), true);
    assert.ok(t.resterendSeconden('ip-1') > 0);
    assert.ok(t.resterendSeconden('ip-1') <= 15 * 60);
    now += 14 * 60 * 1000;
    assert.equal(t.isGeblokkeerd('ip-1'), true, 'na 14 min nog geblokkeerd');
    now += 61 * 1000;
    assert.equal(t.isGeblokkeerd('ip-1'), false, 'na 15 min 1 s weer vrij');
  });

  it('reset wist de teller na een geslaagde login', () => {
    const klok = { nu: () => new Date('2026-10-06T10:00:00Z') };
    const t = new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok });
    t.registreerFout('ip-1');
    t.registreerFout('ip-1');
    t.reset('ip-1');
    for (let i = 0; i < 4; i++) t.registreerFout('ip-1');
    assert.equal(t.isGeblokkeerd('ip-1'), false, 'na reset telt het weer vanaf 0');
  });

  it('scheidt sleutels (per IP)', () => {
    const klok = { nu: () => new Date('2026-10-06T10:00:00Z') };
    const t = new PogingenTracker({ maxFouten: 5, blokkadeMs: 15 * 60 * 1000, klok });
    for (let i = 0; i < 5; i++) t.registreerFout('ip-aanvaller');
    assert.equal(t.isGeblokkeerd('ip-aanvaller'), true);
    assert.equal(t.isGeblokkeerd('ip-rubert'), false);
  });
});
