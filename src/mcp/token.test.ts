import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tokenUitAuthorization, vergelijkMcpToken } from './token.ts';

describe('vergelijkMcpToken', () => {
  it('is true bij een exact gelijk token', () => {
    assert.equal(vergelijkMcpToken('abc-123', 'abc-123'), true);
  });

  it('is false bij een afwijkend token van gelijke lengte', () => {
    assert.equal(vergelijkMcpToken('abc-123', 'xyz-123'), false);
  });

  it('is false bij een token van afwijkende lengte zonder te gooien', () => {
    assert.equal(vergelijkMcpToken('abc', 'abcdef'), false);
    assert.equal(vergelijkMcpToken('abcdef', 'abc'), false);
  });

  it('is false bij een leeg of ontbrekend token', () => {
    assert.equal(vergelijkMcpToken('', 'abc'), false);
    assert.equal(vergelijkMcpToken(undefined, 'abc'), false);
    assert.equal(vergelijkMcpToken(null, 'abc'), false);
  });
});

describe('tokenUitAuthorization', () => {
  it('leest een bearer-token', () => {
    assert.equal(tokenUitAuthorization('Bearer geheim-123'), 'geheim-123');
  });

  it('is hoofdletter-ongevoelig op het schema', () => {
    assert.equal(tokenUitAuthorization('bearer geheim-123'), 'geheim-123');
    assert.equal(tokenUitAuthorization('BEARER geheim-123'), 'geheim-123');
  });

  it('geeft undefined bij een onbekend schema', () => {
    assert.equal(tokenUitAuthorization('Basic abc'), undefined);
    assert.equal(tokenUitAuthorization('geheim-123'), undefined);
  });

  it('geeft undefined bij een lege waarde of lege token', () => {
    assert.equal(tokenUitAuthorization(''), undefined);
    assert.equal(tokenUitAuthorization(undefined), undefined);
    assert.equal(tokenUitAuthorization('Bearer   '), undefined);
  });
});
