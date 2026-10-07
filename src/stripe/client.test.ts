import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { startFakeStripe, FAKE_CHECKOUT_URL, FAKE_PORTAAL_URL, type FakeStripe } from '../../test/fake-stripe/server.ts';

import { maakStripeClient, type StripeClient } from './client.ts';
import {
  StripeSleutelFout,
  StripeTijdelijkeFout,
  StripeTimeoutFout,
  StripeVerzoekFout,
} from './errors.ts';

let fake: FakeStripe;
let stripe: StripeClient;

before(async () => {
  fake = await startFakeStripe();
});
after(async () => {
  await fake.stop();
});
beforeEach(() => {
  fake.reset();
  stripe = maakStripeClient({ secretKey: 'sk_test_123', baseUrl: fake.baseUrl, timeoutMs: 300 });
});

describe('Stripe-client tegen fake-stripe', () => {
  it('klant aanmaken: POST /v1/customers met Bearer-auth, form-encoded en metadata[client_id]', async () => {
    const k = await stripe.maakKlant({ clientId: 'klant-1', naam: 'Acme B.V.', email: 'eva@acme.nl' });
    assert.match(k.id, /^cus_/);
    const a = fake.aanroepen.at(-1)!;
    assert.equal(a.method, 'POST');
    assert.equal(a.path, '/v1/customers');
    assert.equal(a.headers['authorization'], 'Bearer sk_test_123');
    assert.match(a.headers['content-type'] ?? '', /application\/x-www-form-urlencoded/);
    assert.equal(a.velden['metadata[client_id]'], 'klant-1');
    assert.equal(a.velden['name'], 'Acme B.V.');
    assert.equal(a.velden['email'], 'eva@acme.nl');
  });

  it('klant ophalen; onbekende klant geeft null', async () => {
    const k = await stripe.maakKlant({ clientId: 'klant-1', naam: 'Acme' });
    assert.equal((await stripe.haalKlant(k.id))?.id, k.id);
    assert.equal(await stripe.haalKlant('cus_bestaatniet'), null);
  });

  it('verwijderde klant geeft null', async () => {
    fake.klanten.set('cus_weg', { id: 'cus_weg', object: 'customer', deleted: true });
    assert.equal(await stripe.haalKlant('cus_weg'), null);
  });

  it('Checkout Session: subscription-modus, prijs, aantal, proefperiode, URLs en client_reference_id', async () => {
    const k = await stripe.maakKlant({ clientId: 'klant-1', naam: 'Acme' });
    const s = await stripe.maakCheckoutSessie({
      clientId: 'klant-1',
      customerId: k.id,
      priceId: 'price_maand',
      aantal: 3,
      proefperiodeDagen: 30,
      successUrl: 'https://gw.test/portaal/abonnement/gelukt',
      cancelUrl: 'https://gw.test/portaal/abonnement/geannuleerd',
    });
    assert.ok(s.url.startsWith(FAKE_CHECKOUT_URL));
    const v = fake.aanroepen.at(-1)!.velden;
    assert.equal(fake.aanroepen.at(-1)!.path, '/v1/checkout/sessions');
    assert.equal(v['mode'], 'subscription');
    assert.equal(v['customer'], k.id);
    assert.equal(v['client_reference_id'], 'klant-1');
    assert.equal(v['line_items[0][price]'], 'price_maand');
    assert.equal(v['line_items[0][quantity]'], '3');
    assert.equal(v['subscription_data[trial_period_days]'], '30');
    assert.equal(v['subscription_data[metadata][client_id]'], 'klant-1');
    assert.equal(v['success_url'], 'https://gw.test/portaal/abonnement/gelukt');
    assert.equal(v['cancel_url'], 'https://gw.test/portaal/abonnement/geannuleerd');
  });

  it('Checkout zonder proefperiode stuurt geen trial_period_days', async () => {
    const k = await stripe.maakKlant({ clientId: 'klant-1', naam: 'Acme' });
    await stripe.maakCheckoutSessie({
      clientId: 'klant-1', customerId: k.id, priceId: 'p', aantal: 1, proefperiodeDagen: 0,
      successUrl: 'https://a', cancelUrl: 'https://b',
    });
    assert.equal(fake.aanroepen.at(-1)!.velden['subscription_data[trial_period_days]'], undefined);
  });

  it('Billing Portal Session met return_url', async () => {
    const k = await stripe.maakKlant({ clientId: 'klant-1', naam: 'Acme' });
    const s = await stripe.maakPortaalSessie({ customerId: k.id, returnUrl: 'https://gw.test/portaal/abonnement' });
    assert.ok(s.url.startsWith(FAKE_PORTAAL_URL));
    const a = fake.aanroepen.at(-1)!;
    assert.equal(a.path, '/v1/billing_portal/sessions');
    assert.equal(a.velden['customer'], k.id);
    assert.equal(a.velden['return_url'], 'https://gw.test/portaal/abonnement');
  });

  it('abonnement ophalen', async () => {
    fake.abonnementen.set('sub_1', { id: 'sub_1', customer: 'cus_1', status: 'active', trial_end: null, cancel_at_period_end: false });
    assert.equal((await stripe.haalAbonnement('sub_1')).status, 'active');
  });
});

describe('Stripe-client: fouten naar NL-foutklassen', () => {
  it('401 → StripeSleutelFout zonder de sleutel in de melding', async () => {
    fake.storing('POST', '/v1/customers', { status: 401, body: { error: { message: 'Invalid API Key provided: sk_test_***123' } } });
    await assert.rejects(stripe.maakKlant({ clientId: 'k', naam: 'A' }), (err: Error) => {
      assert.ok(err instanceof StripeSleutelFout);
      assert.match(err.message, /STRIPE_SECRET_KEY/);
      assert.doesNotMatch(err.message, /sk_test_123/);
      return true;
    });
  });

  it('400 → StripeVerzoekFout met code en veld', async () => {
    fake.storing('POST', '/v1/checkout/sessions', {
      status: 400,
      body: { error: { type: 'invalid_request_error', code: 'resource_missing', param: 'line_items[0][price]', message: 'No such price' } },
    });
    await assert.rejects(
      stripe.maakCheckoutSessie({ clientId: 'k', customerId: 'cus_x', priceId: 'p', aantal: 1, proefperiodeDagen: 0, successUrl: 'https://a', cancelUrl: 'https://b' }),
      (err: Error) => {
        assert.ok(err instanceof StripeVerzoekFout);
        assert.equal(err.code, 'resource_missing');
        assert.match(err.message, /Stripe weigerde het verzoek/);
        assert.match(err.message, /line_items\[0\]\[price\]/);
        return true;
      },
    );
  });

  it('429 en 5xx → StripeTijdelijkeFout', async () => {
    fake.storing('POST', '/v1/customers', { status: 429 });
    await assert.rejects(stripe.maakKlant({ clientId: 'k', naam: 'A' }), StripeTijdelijkeFout);
    fake.reset();
    fake.storing('POST', '/v1/billing_portal/sessions', { status: 503 });
    await assert.rejects(stripe.maakPortaalSessie({ customerId: 'cus', returnUrl: 'https://a' }), /serverfout/);
  });

  it('time-out → StripeTimeoutFout', async () => {
    fake.storing('POST', '/v1/customers', { status: 200, body: { id: 'cus_laat' }, delayMs: 600 });
    await assert.rejects(stripe.maakKlant({ clientId: 'k', naam: 'A' }), StripeTimeoutFout);
  });

  it('onbereikbaar → StripeTijdelijkeFout', async () => {
    const dood = maakStripeClient({ secretKey: 'sk_test', baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });
    await assert.rejects(dood.haalAbonnement('sub_1'), StripeTijdelijkeFout);
  });

  it('sessie zonder url → nette fout', async () => {
    fake.storing('POST', '/v1/billing_portal/sessions', { status: 200, body: { id: 'bps_1' } });
    await assert.rejects(stripe.maakPortaalSessie({ customerId: 'cus', returnUrl: 'https://a' }), /geen sessie-URL/);
  });
});
