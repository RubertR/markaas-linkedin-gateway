import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';

import { SessieStore } from './sessie.ts';

const DUUR_12_UUR = 12 * 60 * 60 * 1000;

describe('SessieStore', () => {
  it('maakt een sessie met id, csrf-token en verlooptijd', () => {
    const store = new SessieStore({ duurMs: DUUR_12_UUR, klok: vasteKlok('2026-10-06T10:00:00Z') });
    const s = store.maak('rubert');
    assert.ok(s.id.length > 20);
    assert.ok(s.csrfToken.length > 20);
    assert.notEqual(s.id, s.csrfToken);
    assert.equal(s.gebruiker, 'rubert');
    assert.equal(s.verlooptOp.getTime() - s.aangemaaktOp.getTime(), DUUR_12_UUR);
  });

  it('vindt een geldige sessie en geeft null bij een onbekend id', () => {
    const store = new SessieStore({ duurMs: DUUR_12_UUR, klok: vasteKlok('2026-10-06T10:00:00Z') });
    const s = store.maak('rubert');
    assert.equal(store.vind(s.id)?.gebruiker, 'rubert');
    assert.equal(store.vind('onbekend'), null);
    assert.equal(store.vind(null), null);
    assert.equal(store.vind(undefined), null);
  });

  it('ruimt een verlopen sessie op', () => {
    let now = new Date('2026-10-06T10:00:00Z').getTime();
    const klok = { nu: () => new Date(now) };
    const store = new SessieStore({ duurMs: 1000, klok });
    const s = store.maak('rubert');
    assert.ok(store.vind(s.id));
    now += 1001;
    assert.equal(store.vind(s.id), null);
    assert.equal(store.aantal(), 0);
  });

  it('verwijdert een sessie expliciet (logout)', () => {
    const store = new SessieStore({ duurMs: DUUR_12_UUR, klok: vasteKlok('2026-10-06T10:00:00Z') });
    const s = store.maak('rubert');
    store.verwijder(s.id);
    assert.equal(store.vind(s.id), null);
  });

  it('elke sessie heeft een eigen csrf-token (random)', () => {
    const store = new SessieStore({ duurMs: DUUR_12_UUR, klok: vasteKlok('2026-10-06T10:00:00Z') });
    const a = store.maak('rubert');
    const b = store.maak('rubert');
    assert.notEqual(a.csrfToken, b.csrfToken);
  });
});
