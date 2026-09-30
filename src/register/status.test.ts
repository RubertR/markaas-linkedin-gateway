import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mapUnipileStatus, type AccountStatus } from './status.ts';

describe('mapUnipileStatus', () => {
  const bekend: Array<[string, AccountStatus]> = [
    ['OK', 'OK'],
    ['CONNECTING', 'CONNECTING'],
    ['CREDENTIALS', 'CREDENTIALS'],
    ['ERROR', 'ERROR'],
    ['STOPPED', 'STOPPED'],
    ['RECONNECTED', 'RECONNECTED'],
    ['PERMISSIONS', 'PERMISSIONS'],
  ];

  for (const [input, verwacht] of bekend) {
    it(`vertaalt "${input}" naar ${verwacht}`, () => {
      assert.equal(mapUnipileStatus(input), verwacht);
    });
    it(`is hoofdletterongevoelig voor "${input.toLowerCase()}"`, () => {
      assert.equal(mapUnipileStatus(input.toLowerCase()), verwacht);
    });
  }

  it('vertaalt een onbekende string naar UNKNOWN (niet crashen)', () => {
    assert.equal(mapUnipileStatus('nooit_vertoond'), 'UNKNOWN');
  });

  it('vertaalt null, undefined en niet-strings naar UNKNOWN', () => {
    assert.equal(mapUnipileStatus(null), 'UNKNOWN');
    assert.equal(mapUnipileStatus(undefined), 'UNKNOWN');
    assert.equal(mapUnipileStatus(42), 'UNKNOWN');
    assert.equal(mapUnipileStatus({}), 'UNKNOWN');
  });

  it('accepteert ook UNKNOWN als expliciete waarde', () => {
    assert.equal(mapUnipileStatus('UNKNOWN'), 'UNKNOWN');
  });
});
