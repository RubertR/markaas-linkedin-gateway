import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { stripeForm } from './form.ts';

describe('stripeForm', () => {
  it('codeert geneste objecten en lijsten zoals Stripe ze verwacht', () => {
    const tekst = stripeForm({
      mode: 'subscription',
      line_items: [{ price: 'price_1', quantity: 2 }],
      subscription_data: { trial_period_days: 30, metadata: { client_id: 'k-1' } },
      leeg: undefined,
      niets: null,
      vlag: true,
    });
    assert.deepEqual(Object.fromEntries(new URLSearchParams(tekst)), {
      mode: 'subscription',
      'line_items[0][price]': 'price_1',
      'line_items[0][quantity]': '2',
      'subscription_data[trial_period_days]': '30',
      'subscription_data[metadata][client_id]': 'k-1',
      vlag: 'true',
    });
  });

  it('escapet speciale tekens in waarden', () => {
    const tekst = stripeForm({ success_url: 'https://x.nl/a?b=1&c=2' });
    assert.equal(new URLSearchParams(tekst).get('success_url'), 'https://x.nl/a?b=1&c=2');
  });
});
