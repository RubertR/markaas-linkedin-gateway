import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHmac } from 'node:crypto';

import {
  KOPPEL_SLEUTEL_PARAM,
  koppelNotifyUrl,
  koppelpaginaSleutels,
  koppelSleutel,
  vergelijkGeheim,
} from './geheim.ts';

describe('koppelSleutel', () => {
  it('is HMAC-SHA256 over de vaste tekst "koppel" met WEBHOOK_SECRET als sleutel', () => {
    const verwacht = createHmac('sha256', 'geheim-abc').update('koppel').digest('hex');
    assert.equal(koppelSleutel('geheim-abc'), verwacht);
  });

  it('is niet het geheim zelf en verschilt per geheim', () => {
    assert.notEqual(koppelSleutel('geheim-abc'), 'geheim-abc');
    assert.notEqual(koppelSleutel('geheim-abc'), koppelSleutel('geheim-xyz'));
  });
});

describe('koppelNotifyUrl', () => {
  it('zet de afgeleide sleutel als queryparameter k achter /webhooks/koppel', () => {
    const url = new URL(koppelNotifyUrl('https://gateway.example', 'geheim-abc'));
    assert.equal(url.origin + url.pathname, 'https://gateway.example/webhooks/koppel');
    assert.equal(url.searchParams.get(KOPPEL_SLEUTEL_PARAM), koppelSleutel('geheim-abc'));
    assert.ok(!url.href.includes('geheim-abc'), 'notify_url bevat het geheim zelf');
  });
});

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

describe('koppelpaginaSleutels', () => {
  it('leidt twee verschillende sleutels af van WEBHOOK_SECRET, geen van beide het geheim zelf', () => {
    const s = koppelpaginaSleutels('geheim-abc');
    assert.equal(s.ipSleutel, createHmac('sha256', 'geheim-abc').update('consent-ip').digest('hex'));
    assert.equal(s.csrfSleutel, createHmac('sha256', 'geheim-abc').update('koppelen-csrf').digest('hex'));
    assert.notEqual(s.ipSleutel, s.csrfSleutel);
    assert.notEqual(s.ipSleutel, koppelSleutel('geheim-abc'));
    assert.notEqual(s.ipSleutel, 'geheim-abc');
  });
});
