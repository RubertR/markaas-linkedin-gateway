import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { juridischUitObject, laadJuridisch } from './juridisch.ts';

describe('laadJuridisch', () => {
  it('leest config/juridisch.json', async () => {
    const j = await laadJuridisch();
    assert.equal(j.voorwaarden.versie, '0.1');
    assert.equal(j.voorwaarden.url, '');
    assert.equal(j.verwerkersovereenkomst.versie, '0.1');
    assert.equal(j.verwerkersovereenkomst.url, '');
    assert.equal(j.koppeluitnodiging_geldig_dagen, 7);
  });
});

describe('juridischUitObject', () => {
  const geldig = {
    voorwaarden: { versie: '1.0', url: 'https://markaas.nl/voorwaarden' },
    verwerkersovereenkomst: { versie: '1.1', url: '' },
    koppeluitnodiging_geldig_dagen: 3,
  };

  it('accepteert een geldige configuratie en negeert $-velden', () => {
    const j = juridischUitObject({ $toelichting: 'x', ...geldig });
    assert.equal(j.voorwaarden.url, 'https://markaas.nl/voorwaarden');
    assert.equal(j.koppeluitnodiging_geldig_dagen, 3);
  });

  it('weigert een lege versie met een NL-melding', () => {
    assert.throws(
      () => juridischUitObject({ ...geldig, voorwaarden: { versie: '', url: '' } }),
      /voorwaarden\.versie/,
    );
  });

  it('weigert een url die geen http(s) is', () => {
    assert.throws(
      () =>
        juridischUitObject({
          ...geldig,
          verwerkersovereenkomst: { versie: '1', url: 'javascript:alert(1)' },
        }),
      /verwerkersovereenkomst\.url/,
    );
  });

  it('weigert een geldigheid die geen positief geheel getal is', () => {
    assert.throws(
      () => juridischUitObject({ ...geldig, koppeluitnodiging_geldig_dagen: 0 }),
      /koppeluitnodiging_geldig_dagen/,
    );
    assert.throws(
      () => juridischUitObject({ ...geldig, koppeluitnodiging_geldig_dagen: 1.5 }),
      /koppeluitnodiging_geldig_dagen/,
    );
  });
});
