import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vergelijkGeheim } from './geheim.ts';

describe('vergelijkGeheim', () => {
  it('geeft true bij een exact gelijk geheim', () => {
    assert.equal(vergelijkGeheim('geheim-abc', 'geheim-abc'), true);
  });

  it('geeft false bij een verkeerd geheim', () => {
    assert.equal(vergelijkGeheim('fout', 'geheim-abc'), false);
  });

  it('geeft false bij undefined of null', () => {
    assert.equal(vergelijkGeheim(undefined, 'geheim-abc'), false);
    assert.equal(vergelijkGeheim(null, 'geheim-abc'), false);
  });

  it('geeft false bij een leeg geleverd geheim', () => {
    assert.equal(vergelijkGeheim('', 'geheim-abc'), false);
  });

  it('geeft false bij verschillende lengte zonder te crashen', () => {
    assert.equal(vergelijkGeheim('kort', 'veel-langer-geheim'), false);
    assert.equal(vergelijkGeheim('veel-langer-geheim-nog', 'kort'), false);
  });

  it('is byte-exact (case-sensitive, spaties tellen)', () => {
    assert.equal(vergelijkGeheim('Geheim', 'geheim'), false);
    assert.equal(vergelijkGeheim(' geheim', 'geheim'), false);
  });
});
