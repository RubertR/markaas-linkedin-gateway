import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { abonnementConfigUitObject, laadAbonnementConfig } from './abonnement.ts';

describe('laadAbonnementConfig', () => {
  it('leest config/abonnement.json met 30 dagen proef en prijs per account', async () => {
    const c = await laadAbonnementConfig();
    assert.deepEqual(c, { proefperiode_dagen: 30, prijs_per: 'account', waarschuwing_past_due: true });
  });
});

describe('abonnementConfigUitObject', () => {
  const geldig = { proefperiode_dagen: 14, prijs_per: 'klant', waarschuwing_past_due: false };

  it('accepteert een geldige configuratie en negeert $-velden', () => {
    assert.deepEqual(abonnementConfigUitObject({ $toelichting: 'x', ...geldig }), geldig);
  });

  it('proefperiode 0 is toegestaan (geen proef)', () => {
    assert.equal(abonnementConfigUitObject({ ...geldig, proefperiode_dagen: 0 }).proefperiode_dagen, 0);
  });

  it('weigert een negatieve of gebroken proefperiode', () => {
    assert.throws(() => abonnementConfigUitObject({ ...geldig, proefperiode_dagen: -1 }), /proefperiode_dagen/);
    assert.throws(() => abonnementConfigUitObject({ ...geldig, proefperiode_dagen: 1.5 }), /proefperiode_dagen/);
    // Stripe staat maximaal 730 dagen proef toe.
    assert.throws(() => abonnementConfigUitObject({ ...geldig, proefperiode_dagen: 731 }), /proefperiode_dagen/);
  });

  it('weigert een onbekende prijs_per', () => {
    assert.throws(() => abonnementConfigUitObject({ ...geldig, prijs_per: 'gebruiker' }), /prijs_per/);
  });

  it('weigert een waarschuwing_past_due die geen boolean is', () => {
    assert.throws(() => abonnementConfigUitObject({ ...geldig, waarschuwing_past_due: 'ja' }), /waarschuwing_past_due/);
  });
});
