import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { laadLimieten, limietenUitObject } from './limits.ts';

describe('laadLimieten', () => {
  it('leest config/limits.json en levert alle vijf abonnementen', async () => {
    const limieten = await laadLimieten();
    assert.equal(limieten.opbouw.start_factor, 0.5);
    assert.equal(limieten.opbouw.stap_per_week, 0.2);
    assert.equal(limieten.opbouw.maximum, 1.0);
    assert.equal(limieten.afkoeling.duur_uren, 48);
    assert.equal(limieten.afkoeling.opbouw_factor_na, 0.5);
    assert.deepEqual(limieten.tijdvenster.werkdagen, [1, 2, 3, 4, 5]);
    assert.equal(limieten.tijdvenster.start_lokaal, '08:30');
    assert.equal(limieten.tijdvenster.einde_lokaal, '17:30');
    assert.equal(limieten.tijdvenster.pauze_mcp_sync_seconden.profile.min, 30);
    assert.equal(limieten.tijdvenster.pauze_mcp_sync_seconden.profile.max, 90);
    assert.equal(limieten.tijdvenster.pauze_mcp_sync_seconden.search.min, 120);
    assert.equal(limieten.tijdvenster.pauze_mcp_sync_seconden.search.max, 480);
    assert.equal(limieten.unipile_usage_signaal.afremmen_bij_percentage, 75);

    for (const abonnement of [
      'free',
      'premium_career',
      'premium_business',
      'salesnav_core',
      'salesnav_advanced',
    ] as const) {
      assert.ok(limieten.abonnementen[abonnement], `${abonnement} ontbreekt`);
    }
    assert.equal(limieten.abonnementen.salesnav_core.invite.dag, 20);
    assert.equal(limieten.abonnementen.salesnav_core.invite.week, 100);
    assert.equal(limieten.abonnementen.salesnav_core.invite.openstaand_maximum, 500);
    assert.equal(limieten.abonnementen.salesnav_core.invite.bonus_na_opbouw?.week_maximum, 150);
    assert.equal(limieten.abonnementen.free.inmail.maand, 0);
    assert.equal(limieten.abonnementen.premium_business.inmail.maand, 15);
  });
});

describe('limietenUitObject', () => {
  it('werpt NL-fout bij onbekend abonnement', () => {
    const kapot = {
      opbouw: { start_factor: 0.5, stap_per_week: 0.2, maximum: 1, acceptatie_drempel: 0.3, acceptatie_venster_dagen: 7 },
      afkoeling: { duur_uren: 48, opbouw_factor_na: 0.5, opbouw_periode_dagen: 7, triggers: [] },
      tijdvenster: {
        werkdagen: [1, 2, 3, 4, 5],
        start_lokaal: '08:30',
        einde_lokaal: '17:30',
        pauze_tussen_acties_minuten: { min: 2, max: 8 },
        pauze_mcp_sync_seconden: {
          profile: { min: 30, max: 90 },
          search: { min: 120, max: 480 },
        },
        tijdzone_standaard: 'Europe/Amsterdam',
      },
      unipile_usage_signaal: { afremmen_bij_percentage: 75, nieuwe_factor_bij_afremmen: 0.5 },
      abonnementen: {
        free: {},
      },
    };
    assert.throws(() => limietenUitObject(kapot), /abonnement.*(premium_career|premium_business|salesnav)/i);
  });

  it('werpt NL-fout als een actietype ontbreekt in een abonnement', () => {
    const basis = basisConfig();
    delete (basis.abonnementen.free as Record<string, unknown>).invite;
    assert.throws(() => limietenUitObject(basis), /invite.*ontbreekt/);
  });

  it('werpt NL-fout als start_factor buiten [0.5, 1.0] ligt', () => {
    const basis = basisConfig();
    basis.opbouw.start_factor = 0.3;
    assert.throws(() => limietenUitObject(basis), /start_factor/);
  });
});

function basisConfig(): Record<string, Record<string, unknown>> & {
  opbouw: Record<string, number>;
  abonnementen: Record<string, Record<string, unknown>>;
} {
  const perAbonnement = () => ({
    invite: {
      dag: 15,
      week: 70,
      openstaand_maximum: 500,
      notitie: { toegestaan: false },
    },
    message: { dag: 15, week: 80 },
    inmail: { maand: 0 },
    search: { resultaten_per_dag: 1000, runs_per_dag: 1 },
    profile: { dag: 80, week: 400 },
  });
  return {
    opbouw: {
      start_factor: 0.5,
      stap_per_week: 0.2,
      maximum: 1.0,
      acceptatie_drempel: 0.3,
      acceptatie_venster_dagen: 7,
    },
    afkoeling: {
      duur_uren: 48,
      opbouw_factor_na: 0.5,
      opbouw_periode_dagen: 7,
      triggers: [],
    },
    tijdvenster: {
      werkdagen: [1, 2, 3, 4, 5],
      start_lokaal: '08:30',
      einde_lokaal: '17:30',
      pauze_tussen_acties_minuten: { min: 2, max: 8 },
      pauze_mcp_sync_seconden: {
        profile: { min: 30, max: 90 },
        search: { min: 120, max: 480 },
      },
      tijdzone_standaard: 'Europe/Amsterdam',
    },
    unipile_usage_signaal: {
      afremmen_bij_percentage: 75,
      nieuwe_factor_bij_afremmen: 0.5,
    },
    abonnementen: {
      free: perAbonnement(),
      premium_career: perAbonnement(),
      premium_business: perAbonnement(),
      salesnav_core: perAbonnement(),
      salesnav_advanced: perAbonnement(),
    },
  };
}
