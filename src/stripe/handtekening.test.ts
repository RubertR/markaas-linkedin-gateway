import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { ondertekenStripe } from '../../test/fake-stripe/webhook.ts';

import { StripeHandtekeningFout, verifieerStripeHandtekening } from './handtekening.ts';

const GEHEIM = 'whsec_test_geheim';
const T = 1_791_360_000; // 2026-10-07 ~
const BODY = '{\n  "id": "evt_1",\n  "type": "invoice.paid"\n}';

function controleer(header: string | undefined, opts: { body?: string; nu?: number; geheim?: string } = {}) {
  verifieerStripeHandtekening({
    header,
    ruweBody: opts.body ?? BODY,
    geheim: opts.geheim ?? GEHEIM,
    klok: vasteKlok((opts.nu ?? T) * 1000),
  });
}

describe('verifieerStripeHandtekening', () => {
  it('accepteert een geldige handtekening over de ruwe body', () => {
    assert.doesNotThrow(() => controleer(ondertekenStripe(BODY, GEHEIM, T)));
  });

  it('weigert een handtekening met een ander geheim', () => {
    assert.throws(
      () => controleer(ondertekenStripe(BODY, 'whsec_ander', T)),
      (err: Error) => err instanceof StripeHandtekeningFout && /STRIPE_WEBHOOK_SECRET/.test(err.message),
    );
  });

  it('weigert als de body na ondertekenen is veranderd (ook alleen witruimte)', () => {
    const header = ondertekenStripe(BODY, GEHEIM, T);
    assert.throws(() => controleer(header, { body: JSON.stringify(JSON.parse(BODY)) }), StripeHandtekeningFout);
  });

  it('weigert een verlopen tijdstempel (> 300 s oud) en een tijdstip ver in de toekomst', () => {
    const header = ondertekenStripe(BODY, GEHEIM, T);
    assert.doesNotThrow(() => controleer(header, { nu: T + 300 }));
    assert.throws(() => controleer(header, { nu: T + 301 }), /300 seconden/);
    assert.throws(() => controleer(header, { nu: T - 301 }), /300 seconden/);
  });

  it('accepteert als één van meerdere v1-handtekeningen klopt (geheim roteren)', () => {
    const header = ondertekenStripe(BODY, GEHEIM, T, ['a'.repeat(64), 'kort']);
    assert.match(header, /v1=.*v1=.*v1=/);
    assert.doesNotThrow(() => controleer(header));
  });

  it('weigert als geen van meerdere v1-handtekeningen klopt', () => {
    assert.throws(() => controleer(`t=${T},v1=${'a'.repeat(64)},v1=${'b'.repeat(64)}`), StripeHandtekeningFout);
  });

  it('weigert een ontbrekende header, ontbrekend tijdstip of alleen v0', () => {
    assert.throws(() => controleer(undefined), /ontbreekt/);
    assert.throws(() => controleer(`v1=${'a'.repeat(64)}`), /tijdstip/);
    assert.throws(() => controleer(`t=${T},v0=${'a'.repeat(64)}`), /v1/);
    assert.throws(() => controleer('onzin'), StripeHandtekeningFout);
  });
});
