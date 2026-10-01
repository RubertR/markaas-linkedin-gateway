import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { laadLimieten } from './limits.ts';
import {
  nieuweOpbouwFactor,
  verlagingNaUnipileSignaal,
  weekBudgetMetBonus,
} from './opbouw.ts';

const limietenPromise = laadLimieten();

describe('nieuweOpbouwFactor', () => {
  it('verhoogt met stap_per_week als acceptatie >= drempel en nog niet op max', async () => {
    const l = await limietenPromise;
    const nieuw = nieuweOpbouwFactor({
      huidigeFactor: 0.5,
      acceptatieVerhouding: 0.42,
      opbouw: l.opbouw,
    });
    assert.equal(nieuw, 0.7);
  });

  it('verandert niets als acceptatie onder de drempel ligt', async () => {
    const l = await limietenPromise;
    const nieuw = nieuweOpbouwFactor({
      huidigeFactor: 0.7,
      acceptatieVerhouding: 0.25,
      opbouw: l.opbouw,
    });
    assert.equal(nieuw, 0.7);
  });

  it('kapt af op maximum (1.0)', async () => {
    const l = await limietenPromise;
    const nieuw = nieuweOpbouwFactor({
      huidigeFactor: 0.9,
      acceptatieVerhouding: 0.5,
      opbouw: l.opbouw,
    });
    assert.equal(nieuw, 1.0);
  });

  it('exacte drempelwaarde telt mee (>= drempel)', async () => {
    const l = await limietenPromise;
    const nieuw = nieuweOpbouwFactor({
      huidigeFactor: 0.5,
      acceptatieVerhouding: 0.3,
      opbouw: l.opbouw,
    });
    assert.equal(nieuw, 0.7);
  });
});

describe('verlagingNaUnipileSignaal', () => {
  it('verlaagt opbouw_factor als Unipile usage ≥ drempel teruggeeft (75%)', async () => {
    const l = await limietenPromise;
    assert.equal(
      verlagingNaUnipileSignaal({ huidigeFactor: 1.0, usagePercentage: 75, signaal: l.unipile_usage_signaal }),
      0.5,
    );
    assert.equal(
      verlagingNaUnipileSignaal({ huidigeFactor: 0.7, usagePercentage: 90, signaal: l.unipile_usage_signaal }),
      0.5,
    );
  });

  it('laat opbouw_factor ongemoeid onder de drempel', async () => {
    const l = await limietenPromise;
    assert.equal(
      verlagingNaUnipileSignaal({ huidigeFactor: 0.7, usagePercentage: 50, signaal: l.unipile_usage_signaal }),
      null,
    );
    assert.equal(
      verlagingNaUnipileSignaal({ huidigeFactor: 1.0, usagePercentage: 74.9, signaal: l.unipile_usage_signaal }),
      null,
    );
  });

  it('verlaagt niet verder dan nodig: als huidige factor al lager is, geen wijziging', async () => {
    const l = await limietenPromise;
    assert.equal(
      verlagingNaUnipileSignaal({ huidigeFactor: 0.5, usagePercentage: 95, signaal: l.unipile_usage_signaal }),
      null,
    );
  });
});

describe('weekBudgetMetBonus', () => {
  it('zonder bonus-config: gewone weeknorm × factor', async () => {
    const l = await limietenPromise;
    const invite = l.abonnementen.premium_business.invite;
    assert.equal(
      weekBudgetMetBonus({
        invite,
        opbouwFactor: 1.0,
        wekenSindsStart: 10,
        acceptatieVerhouding: 0.4,
      }),
      70, // premium_business.invite.week
    );
  });

  it('met bonus-config (salesnav): < min_weken_opbouw geeft gewone norm', async () => {
    const l = await limietenPromise;
    const invite = l.abonnementen.salesnav_core.invite;
    assert.equal(
      weekBudgetMetBonus({
        invite,
        opbouwFactor: 1.0,
        wekenSindsStart: 3,
        acceptatieVerhouding: 0.5,
      }),
      100,
    );
  });

  it('met bonus-config (salesnav): >= min_weken en acceptatie boven drempel geeft week_maximum', async () => {
    const l = await limietenPromise;
    const invite = l.abonnementen.salesnav_core.invite;
    assert.equal(
      weekBudgetMetBonus({
        invite,
        opbouwFactor: 1.0,
        wekenSindsStart: 4,
        acceptatieVerhouding: 0.4,
      }),
      150,
    );
  });

  it('met bonus-config: acceptatie onder drempel blokkeert de bonus', async () => {
    const l = await limietenPromise;
    const invite = l.abonnementen.salesnav_core.invite;
    assert.equal(
      weekBudgetMetBonus({
        invite,
        opbouwFactor: 1.0,
        wekenSindsStart: 10,
        acceptatieVerhouding: 0.2,
      }),
      100,
    );
  });

  it('schaalt met opbouw-factor', async () => {
    const l = await limietenPromise;
    const invite = l.abonnementen.salesnav_core.invite;
    // 100 × 0.5 = 50
    assert.equal(
      weekBudgetMetBonus({
        invite,
        opbouwFactor: 0.5,
        wekenSindsStart: 1,
        acceptatieVerhouding: 0.0,
      }),
      50,
    );
  });
});
