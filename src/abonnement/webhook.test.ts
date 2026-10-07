import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Klok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { maakClient } from '../register/clients.ts';
import { maakStripeClient, type StripeClient } from '../stripe/client.ts';
import { startFakeStripe, type FakeStripe } from '../../test/fake-stripe/server.ts';
import { maakStripeEvent } from '../../test/fake-stripe/webhook.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { vindAbonnement } from './abonnementen.ts';
import { alsStripeEvent, verwerkStripeEvent, type StripeEvent } from './webhook.ts';

const NU = new Date('2026-10-07T10:00:00Z');
const T = Math.floor(NU.getTime() / 1000);
const DAG = 86_400;
const klok: Klok = { nu: () => NU };

let db: Backend;
let close: () => Promise<void>;
let fake: FakeStripe;
let stripe: StripeClient;
let klant: string;
let ander: string;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  fake = await startFakeStripe();
  stripe = maakStripeClient({ secretKey: 'sk_test', baseUrl: fake.baseUrl, timeoutMs: 500 });
});
after(async () => {
  await fake.stop();
  await close();
});
beforeEach(async () => {
  fake.reset();
  for (const t of ['subscriptions', 'events', 'accounts', 'clients']) await db.query(`delete from ${t}`);
  klant = (await maakClient(db, { naam: 'Acme', slug: 'acme' })).id;
  ander = (await maakClient(db, { naam: 'Bolt', slug: 'bolt' })).id;
});

function sub(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_1',
    object: 'subscription',
    customer: 'cus_1',
    status: 'trialing',
    trial_end: T + 30 * DAG,
    current_period_end: T + 30 * DAG,
    cancel_at_period_end: false,
    metadata: { client_id: klant },
    ...over,
  };
}

async function verwerk(type: string, object: Record<string, unknown>, opties: { id?: string; created?: number } = {}) {
  const event = alsStripeEvent(maakStripeEvent(type, object, { created: T, ...opties })) as StripeEvent;
  return await verwerkStripeEvent({ db, stripe, klok }, event);
}

async function eventTelling(): Promise<number> {
  const [r] = await db.query<{ n: number }>("select count(*)::int as n from events where bron = 'stripe'");
  return r!.n;
}

describe('Stripe-webhook: checkout.session.completed', () => {
  it('koppelt customer en subscription via client_reference_id en haalt de stand op', async () => {
    fake.abonnementen.set('sub_1', sub({ metadata: {} }));
    const u = await verwerk('checkout.session.completed', {
      id: 'cs_1', object: 'checkout.session', mode: 'subscription',
      client_reference_id: klant, customer: 'cus_1', subscription: 'sub_1', metadata: {},
    });
    assert.deepEqual(u, { verwerkt: true });
    const a = await vindAbonnement(db, klant);
    assert.equal(a?.stripeCustomerId, 'cus_1');
    assert.equal(a?.stripeSubscriptionId, 'sub_1');
    assert.equal(a?.status, 'trialing');
    assert.equal(a?.proefTot?.toISOString(), new Date((T + 30 * DAG) * 1000).toISOString());
    assert.ok(fake.aanroepen.some((x) => x.path === '/v1/subscriptions/sub_1'));
  });

  it('valt terug op metadata.client_id', async () => {
    fake.abonnementen.set('sub_1', sub({ metadata: {} }));
    await verwerk('checkout.session.completed', {
      id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', client_reference_id: null, metadata: { client_id: klant },
    });
    assert.equal((await vindAbonnement(db, klant))?.stripeSubscriptionId, 'sub_1');
  });

  it('onbekende of ongeldige klant: opgeslagen, niets gekoppeld', async () => {
    const u = await verwerk('checkout.session.completed', {
      id: 'cs_1', customer: 'cus_1', subscription: null, client_reference_id: 'geen-uuid', metadata: {},
    });
    assert.equal(u.verwerkt, false);
    assert.equal(await eventTelling(), 1);
    const [r] = await db.query<{ n: number }>('select count(*)::int as n from subscriptions');
    assert.equal(r!.n, 0);
  });

  it('Stripe onbereikbaar bij ophalen: fout, event niet opgeslagen (Stripe probeert opnieuw)', async () => {
    fake.storing('GET', '/v1/subscriptions/sub_1', { status: 500 });
    await assert.rejects(
      verwerk('checkout.session.completed', { id: 'cs_1', customer: 'cus_1', subscription: 'sub_1', client_reference_id: klant }, { id: 'evt_x' }),
    );
    assert.equal(await eventTelling(), 0);
  });
});

describe('Stripe-webhook: customer.subscription.*', () => {
  it('created → trialing met proef_tot en periode_tot', async () => {
    await verwerk('customer.subscription.created', sub());
    const a = await vindAbonnement(db, klant);
    assert.equal(a?.status, 'trialing');
    assert.equal(a?.stripeCustomerId, 'cus_1');
    assert.ok(a?.periodeTot);
    assert.equal(a?.opgezegdPerEinde, false);
  });

  it('updated → active; cancel_at_period_end wordt opgezegd_per_einde', async () => {
    await verwerk('customer.subscription.created', sub());
    await verwerk('customer.subscription.updated', sub({ status: 'active', trial_end: null, cancel_at_period_end: true }), { created: T + 10 });
    const a = await vindAbonnement(db, klant);
    assert.equal(a?.status, 'active');
    assert.equal(a?.proefTot, null);
    assert.equal(a?.opgezegdPerEinde, true);
  });

  it('nieuwere API-vorm: current_period_end per item', async () => {
    await verwerk('customer.subscription.updated', sub({
      status: 'active', current_period_end: undefined,
      items: { object: 'list', data: [{ id: 'si_1', current_period_end: T + 31 * DAG }] },
    }));
    assert.equal((await vindAbonnement(db, klant))?.periodeTot?.toISOString(), new Date((T + 31 * DAG) * 1000).toISOString());
  });

  it('deleted → canceled', async () => {
    await verwerk('customer.subscription.created', sub({ status: 'active' }));
    await verwerk('customer.subscription.deleted', sub({ status: 'canceled' }), { created: T + 5 });
    assert.equal((await vindAbonnement(db, klant))?.status, 'canceled');
  });

  it('zonder metadata: klant gevonden via bekende customer-id', async () => {
    await db.query("insert into subscriptions(client_id, stripe_customer_id) values ($1, 'cus_9')", [klant]);
    await verwerk('customer.subscription.created', sub({ id: 'sub_9', customer: 'cus_9', metadata: {} }));
    assert.equal((await vindAbonnement(db, klant))?.stripeSubscriptionId, 'sub_9');
  });

  it('onbekende klant: opgeslagen, verder niets', async () => {
    const u = await verwerk('customer.subscription.created', sub({ customer: 'cus_onbekend', metadata: {} }));
    assert.equal(u.verwerkt, false);
    assert.equal(await eventTelling(), 1);
  });

  it('ouder event na een nieuwer event verandert niets', async () => {
    await verwerk('customer.subscription.updated', sub({ status: 'past_due' }), { created: T + 100 });
    const u = await verwerk('customer.subscription.updated', sub({ status: 'active' }), { created: T });
    assert.equal(u.verwerkt, false);
    assert.equal((await vindAbonnement(db, klant))?.status, 'past_due');
  });

  it('beëindigen van een eerder abonnement overschrijft een nieuw abonnement niet', async () => {
    await verwerk('customer.subscription.created', sub({ id: 'sub_nieuw', status: 'active' }), { created: T + 100 });
    await verwerk('customer.subscription.deleted', sub({ id: 'sub_oud', status: 'canceled' }), { created: T + 200 });
    const a = await vindAbonnement(db, klant);
    assert.equal(a?.stripeSubscriptionId, 'sub_nieuw');
    assert.equal(a?.status, 'active');
  });

  it('een nieuw abonnement na een beëindigd abonnement neemt het over', async () => {
    await verwerk('customer.subscription.deleted', sub({ id: 'sub_oud', status: 'canceled' }), { created: T });
    await verwerk('customer.subscription.created', sub({ id: 'sub_nieuw', status: 'trialing' }), { created: T + 50 });
    const a = await vindAbonnement(db, klant);
    assert.equal(a?.stripeSubscriptionId, 'sub_nieuw');
    assert.equal(a?.status, 'trialing');
  });
});

describe('Stripe-webhook: invoice.*', () => {
  it('invoice.payment_failed → status opnieuw opgehaald (past_due)', async () => {
    await verwerk('customer.subscription.created', sub({ status: 'active' }));
    fake.abonnementen.set('sub_1', sub({ status: 'past_due' }));
    await verwerk('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer: 'cus_1', subscription: 'sub_1' }, { created: T + 10 });
    assert.equal((await vindAbonnement(db, klant))?.status, 'past_due');
  });

  it('invoice.paid (nieuwere vorm: parent.subscription_details) → active', async () => {
    await verwerk('customer.subscription.created', sub({ status: 'past_due' }));
    fake.abonnementen.set('sub_1', sub({ status: 'active' }));
    await verwerk(
      'invoice.paid',
      { id: 'in_2', object: 'invoice', customer: 'cus_1', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_1' } } },
      { created: T + 10 },
    );
    assert.equal((await vindAbonnement(db, klant))?.status, 'active');
  });

  it('factuur zonder abonnement: alleen opgeslagen', async () => {
    const u = await verwerk('invoice.paid', { id: 'in_3', object: 'invoice', customer: 'cus_1' });
    assert.equal(u.verwerkt, false);
    assert.equal(await eventTelling(), 1);
  });
});

describe('Stripe-webhook: opslag en dubbele levering', () => {
  it('slaat elk event op met extern_id stripe:<id>; tweede levering wordt genegeerd', async () => {
    const event = alsStripeEvent(maakStripeEvent('customer.subscription.created', sub(), { id: 'evt_dubbel', created: T }));
    assert.deepEqual(await verwerkStripeEvent({ db, stripe, klok }, event), { verwerkt: true });
    // Tussendoor handmatig de status veranderen: een tweede levering mag die niet terugzetten.
    await db.query("update subscriptions set status = 'active' where client_id = $1", [klant]);
    const tweede = await verwerkStripeEvent({ db, stripe, klok }, event);
    assert.equal(tweede.dubbel, true);
    assert.equal((await vindAbonnement(db, klant))?.status, 'active');
    const rijen = await db.query<{ extern_id: string; type: string }>("select extern_id, type from events where bron = 'stripe'");
    assert.deepEqual(rijen, [{ extern_id: 'stripe:evt_dubbel', type: 'customer.subscription.created' }]);
  });

  it('onbekend eventtype: opgeslagen, niet verwerkt', async () => {
    const u = await verwerk('customer.created', { id: 'cus_1', object: 'customer' });
    assert.equal(u.verwerkt, false);
    assert.match(u.reden ?? '', /alleen opgeslagen/);
    assert.equal(await eventTelling(), 1);
  });

  it('alsStripeEvent weigert een event zonder id of data.object', () => {
    assert.throws(() => alsStripeEvent({ type: 'x', created: 1, data: { object: {} } }));
    assert.throws(() => alsStripeEvent({ id: 'evt', type: 'x', created: 1, data: {} }));
    assert.throws(() => alsStripeEvent(null));
  });

  it('klant B wordt niet geraakt door events van klant A', async () => {
    await verwerk('customer.subscription.created', sub());
    assert.equal(await vindAbonnement(db, ander), null);
  });
});
