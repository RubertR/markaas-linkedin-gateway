import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { formatteerAmsterdam } from './datum.ts';

describe('formatteerAmsterdam', () => {
  it('formatteert een UTC-tijd als "1 okt, 13:07" in Europe/Amsterdam (zomertijd)', () => {
    // 1 oktober 2026 11:07 UTC = 13:07 lokaal (nog zomertijd tot zondag 25 okt).
    const d = new Date('2026-10-01T11:07:00Z');
    assert.equal(formatteerAmsterdam(d), '1 okt, 13:07');
  });

  it('respecteert winterwijziging (november staat in wintertijd)', () => {
    // 2 november 2026 08:05 UTC = 09:05 lokaal (wintertijd, UTC+1).
    const d = new Date('2026-11-02T08:05:00Z');
    assert.equal(formatteerAmsterdam(d), '2 nov, 09:05');
  });

  it('gebruikt 24-uursnotatie (geen 24:00)', () => {
    const d = new Date('2026-10-01T22:00:00Z'); // 00:00 Europe/Amsterdam volgende dag
    assert.equal(formatteerAmsterdam(d), '2 okt, 00:00');
  });

  it('toont dubbele cijfers voor uren onder 10', () => {
    const d = new Date('2026-10-01T06:03:00Z'); // 08:03 lokaal
    assert.equal(formatteerAmsterdam(d), '1 okt, 08:03');
  });
});
