import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { KlantAbonnement } from './abonnementen.ts';
import { beschrijfAbonnement } from './weergave.ts';

const basis: KlantAbonnement = {
  clientId: 'k',
  stripeCustomerId: 'cus_1',
  stripeSubscriptionId: 'sub_1',
  status: 'trialing',
  proefTot: new Date('2026-11-06T10:00:00Z'),
  periodeTot: new Date('2026-11-06T10:00:00Z'),
  opgezegdPerEinde: false,
  bijgewerktOp: new Date('2026-10-07T10:00:00Z'),
};

describe('beschrijfAbonnement', () => {
  it('niet vereist: "Geen abonnement nodig", geen knop', () => {
    const w = beschrijfAbonnement(false, null);
    assert.equal(w.titel, 'Geen abonnement nodig');
    assert.equal(w.knop, null);
    assert.equal(w.verzendenToegestaan, true);
  });

  it('geen abonnement: knop starten, verzenden niet toegestaan', () => {
    const w = beschrijfAbonnement(true, null);
    assert.equal(w.titel, 'Geen abonnement');
    assert.equal(w.knop, 'starten');
    assert.equal(w.verzendenToegestaan, false);
    assert.equal(beschrijfAbonnement(true, { ...basis, status: null }).knop, 'starten');
  });

  it('proefperiode tot <datum>, volgende betaling op het einde van de proef', () => {
    const w = beschrijfAbonnement(true, basis);
    assert.equal(w.titel, 'Proefperiode tot 6 november 2026');
    assert.equal(w.volgendeBetaling?.toISOString(), basis.proefTot!.toISOString());
    assert.equal(w.knop, 'beheren');
  });

  it('proef opgezegd: geen betaling', () => {
    const w = beschrijfAbonnement(true, { ...basis, opgezegdPerEinde: true });
    assert.match(w.uitleg, /Opgezegd per 6 november 2026/);
    assert.equal(w.volgendeBetaling, null);
  });

  it('actief en opgezegd per <datum>', () => {
    assert.equal(beschrijfAbonnement(true, { ...basis, status: 'active' }).titel, 'Actief');
    const w = beschrijfAbonnement(true, { ...basis, status: 'active', opgezegdPerEinde: true });
    assert.equal(w.titel, 'Opgezegd per 6 november 2026');
    assert.equal(w.volgendeBetaling, null);
  });

  it('betaling mislukt (past_due): waarschuwing, verzenden gaat door', () => {
    const w = beschrijfAbonnement(true, { ...basis, status: 'past_due' });
    assert.equal(w.titel, 'Betaling mislukt');
    assert.equal(w.soort, 'let-op');
    assert.equal(w.verzendenToegestaan, true);
  });

  it('canceled: beëindigd, opnieuw starten mogelijk', () => {
    const w = beschrijfAbonnement(true, { ...basis, status: 'canceled' });
    assert.equal(w.titel, 'Abonnement beëindigd');
    assert.equal(w.knop, 'starten');
  });

  it('unpaid: niet betaald, verzenden gestopt', () => {
    const w = beschrijfAbonnement(true, { ...basis, status: 'unpaid' });
    assert.equal(w.verzendenToegestaan, false);
    assert.equal(w.knop, 'beheren');
  });
});
