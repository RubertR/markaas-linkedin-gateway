import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  STANDAARD_TIJDZONE,
  TIJDZONE_KEUZES,
  leesTijdzone,
  valideerTijdzone,
} from './tijdzone.ts';

describe('valideerTijdzone', () => {
  it('accepteert de vaste keuzes en andere IANA-namen', () => {
    for (const tz of [...TIJDZONE_KEUZES, 'America/New_York', 'Asia/Kolkata', 'UTC', 'Etc/GMT+1']) {
      assert.equal(valideerTijdzone(tz), null, tz);
    }
  });

  it('weigert onbekende namen en offsets met een NL-melding', () => {
    for (const tz of ['Europe/Amsterdm', 'Foo/Bar', '+01:00', 'GMT+1:00', 'Europe/London ', 'x'.repeat(80)]) {
      const fout = valideerTijdzone(tz);
      assert.ok(fout, `"${tz}" zou geweigerd moeten worden`);
      assert.match(fout, /geen geldige tijdzone/i);
      assert.match(fout, /Europe\/Amsterdam/);
    }
  });
});

describe('leesTijdzone', () => {
  it('leeg of alleen spaties wordt de standaard Europe/Amsterdam', () => {
    assert.equal(STANDAARD_TIJDZONE, 'Europe/Amsterdam');
    assert.deepEqual(leesTijdzone(''), { tijdzone: 'Europe/Amsterdam' });
    assert.deepEqual(leesTijdzone('   '), { tijdzone: 'Europe/Amsterdam' });
    assert.deepEqual(leesTijdzone(undefined), { tijdzone: 'Europe/Amsterdam' });
  });

  it('trimt en zet de schrijfwijze recht (europe/london → Europe/London)', () => {
    assert.deepEqual(leesTijdzone(' europe/london '), { tijdzone: 'Europe/London' });
  });

  it('geeft een fout voor een ongeldige naam', () => {
    const r = leesTijdzone('Mars/Olympus');
    assert.ok('fout' in r);
    assert.match(r.fout, /"Mars\/Olympus" is geen geldige tijdzone/);
  });
});
