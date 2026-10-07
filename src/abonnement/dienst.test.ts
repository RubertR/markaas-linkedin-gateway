import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Klok } from '../budget/klok.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Backend } from '../db/backend.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { maakStripeClient } from '../stripe/client.ts';
import { StripeTijdelijkeFout } from '../stripe/errors.ts';
import { startFakeStripe, FAKE_CHECKOUT_URL, FAKE_PORTAAL_URL, type FakeStripe } from '../../test/fake-stripe/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  aantalVoorPrijs,
  betaalpoortVoorAccount,
  verzendenToegestaan,
  vindAbonnement,
  zetAbonnementVereist,
} from './abonnementen.ts';
import {
  AbonnementFout,
  AlAbonnementFout,
  NIET_INGERICHT,
  beheerAbonnement,
  startAbonnement,
  type AbonnementDeps,
} from './dienst.ts';

const NU = new Date('2026-10-07T10:00:00Z');
const klok: Klok = { nu: () => NU };
const CONFIG: AbonnementConfig = { proefperiode_dagen: 30, prijs_per: 'account', waarschuwing_past_due: true };

let db: Backend;
let close: () => Promise<void>;
let fake: FakeStripe;
let klant: string;
let ander: string;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  fake = await startFakeStripe();
});
after(async () => {
  await fake.stop();
  await close();
});
beforeEach(async () => {
  fake.reset();
  for (const t of ['subscriptions', 'events', 'accounts', 'clients']) await db.query(`delete from ${t}`);
  klant = (await maakClient(db, { naam: 'Acme B.V.', slug: 'acme' })).id;
  ander = (await maakClient(db, { naam: 'Bolt', slug: 'bolt' })).id;
});

function deps(over: Partial<AbonnementDeps> = {}): AbonnementDeps {
  return {
    db,
    klok,
    stripe: { client: maakStripeClient({ secretKey: 'sk_test', baseUrl: fake.baseUrl, timeoutMs: 500 }), priceId: 'price_maand' },
    config: CONFIG,
    publicBaseUrl: 'https://gw.test',
    ...over,
  };
}

async function account(clientId: string, gekoppeld: string | null): Promise<string> {
  const a = await registreerAccount(db, { clientId, eigenaarNaam: `Eigenaar ${gekoppeld ?? 'x'}`, abonnement: 'free' });
  if (gekoppeld) await markeerAccountGekoppeld(db, a.id, gekoppeld);
  return a.id;
}

describe('startAbonnement', () => {
  it('maakt een customer met metadata[client_id] en een Checkout Session; aantal = gekoppelde accounts', async () => {
    await account(klant, 'uni-1');
    await account(klant, 'uni-2');
    await account(klant, null); // nog niet gekoppeld: telt niet mee
    await account(ander, 'uni-3');
    const url = await startAbonnement(deps(), klant, { email: 'eva@acme.nl' });
    assert.ok(url.startsWith(FAKE_CHECKOUT_URL));
    const klantAanroep = fake.aanroepen.find((a) => a.path === '/v1/customers')!;
    assert.equal(klantAanroep.velden['metadata[client_id]'], klant);
    assert.equal(klantAanroep.velden['email'], 'eva@acme.nl');
    const checkout = fake.aanroepen.find((a) => a.path === '/v1/checkout/sessions')!.velden;
    assert.equal(checkout['line_items[0][quantity]'], '2');
    assert.equal(checkout['line_items[0][price]'], 'price_maand');
    assert.equal(checkout['subscription_data[trial_period_days]'], '30');
    assert.equal(checkout['success_url'], 'https://gw.test/portaal/abonnement/gelukt');
    assert.equal(checkout['cancel_url'], 'https://gw.test/portaal/abonnement/geannuleerd');
    assert.equal(checkout['client_reference_id'], klant);
    const a = await vindAbonnement(db, klant);
    assert.match(a?.stripeCustomerId ?? '', /^cus_/);
    assert.equal(a?.status, null);
  });

  it('zonder gekoppelde accounts is het aantal 1; bij prijs_per klant altijd 1', async () => {
    assert.equal(await aantalVoorPrijs(db, klant), 1);
    await account(klant, 'uni-1');
    await account(klant, 'uni-2');
    await startAbonnement(deps({ config: { ...CONFIG, prijs_per: 'klant' } }), klant);
    assert.equal(fake.aanroepen.find((a) => a.path === '/v1/checkout/sessions')!.velden['line_items[0][quantity]'], '1');
  });

  it('hergebruikt een bestaande Stripe-customer', async () => {
    await startAbonnement(deps(), klant);
    const eerste = (await vindAbonnement(db, klant))!.stripeCustomerId;
    await startAbonnement(deps(), klant);
    assert.equal(fake.aanroepen.filter((a) => a.path === '/v1/customers').length, 1);
    assert.equal((await vindAbonnement(db, klant))!.stripeCustomerId, eerste);
  });

  it('maakt een nieuwe customer als de bewaarde in Stripe verwijderd is', async () => {
    await db.query("insert into subscriptions(client_id, stripe_customer_id) values ($1, 'cus_weg')", [klant]);
    await startAbonnement(deps(), klant);
    assert.notEqual((await vindAbonnement(db, klant))!.stripeCustomerId, 'cus_weg');
  });

  it('weigert bij een lopend abonnement; na canceled mag het weer', async () => {
    await db.query("insert into subscriptions(client_id, stripe_customer_id, status) values ($1, 'cus_x', 'trialing')", [klant]);
    await assert.rejects(startAbonnement(deps(), klant), (e: Error) => e instanceof AbonnementFout && /al een abonnement/.test(e.message));
    await db.query("update subscriptions set status = 'canceled' where client_id = $1", [klant]);
    await assert.doesNotReject(startAbonnement(deps(), klant));
  });

  it('lopend abonnement bij Stripe (webhook nog niet binnen): AlAbonnementFout, geen Checkout', async () => {
    await startAbonnement(deps(), klant); // maakt de customer
    const cus = (await vindAbonnement(db, klant))!.stripeCustomerId!;
    fake.abonnementen.set('sub_live', { id: 'sub_live', customer: cus, status: 'active', trial_end: null, cancel_at_period_end: false });
    const voor = fake.aanroepen.filter((a) => a.path === '/v1/checkout/sessions').length;
    await assert.rejects(startAbonnement(deps(), klant), AlAbonnementFout);
    assert.equal(fake.aanroepen.filter((a) => a.path === '/v1/checkout/sessions').length, voor);
    assert.ok(fake.aanroepen.some((a) => a.path === '/v1/subscriptions' && a.method === 'GET'));
  });

  it('ook incomplete, past_due, unpaid of paused bij Stripe tellen als lopend', async () => {
    await startAbonnement(deps(), klant);
    const cus = (await vindAbonnement(db, klant))!.stripeCustomerId!;
    for (const status of ['incomplete', 'past_due', 'unpaid', 'paused', 'trialing']) {
      fake.abonnementen.set('sub_x', { id: 'sub_x', customer: cus, status, trial_end: null, cancel_at_period_end: false });
      await assert.rejects(startAbonnement(deps(), klant), AlAbonnementFout, status);
    }
  });

  it('proefperiode maar één keer: na een eerder (beëindigd) abonnement bij Stripe geen trial_period_days', async () => {
    await startAbonnement(deps(), klant);
    const eerste = fake.aanroepen.filter((a) => a.path === '/v1/checkout/sessions').at(-1)!.velden;
    assert.equal(eerste['subscription_data[trial_period_days]'], '30');
    const cus = (await vindAbonnement(db, klant))!.stripeCustomerId!;
    fake.abonnementen.set('sub_oud', { id: 'sub_oud', customer: cus, status: 'canceled', trial_end: null, cancel_at_period_end: false });
    await startAbonnement(deps(), klant);
    const tweede = fake.aanroepen.filter((a) => a.path === '/v1/checkout/sessions').at(-1)!.velden;
    assert.equal(tweede['subscription_data[trial_period_days]'], undefined);
    assert.equal(tweede['line_items[0][price]'], 'price_maand');
  });

  it('proefperiode maar één keer: ook niet als de tabel een eerder abonnement of proef_tot kent', async () => {
    await db.query(
      "insert into subscriptions(client_id, stripe_subscription_id, status) values ($1, 'sub_weg', 'canceled')",
      [klant],
    );
    await startAbonnement(deps(), klant);
    assert.equal(fake.aanroepen.find((a) => a.path === '/v1/checkout/sessions')!.velden['subscription_data[trial_period_days]'], undefined);
    await db.query('delete from subscriptions');
    fake.reset();
    await db.query(
      "insert into subscriptions(client_id, status, proef_tot) values ($1, 'incomplete_expired', '2026-09-01T00:00:00Z')",
      [klant],
    );
    await startAbonnement(deps(), klant);
    assert.equal(fake.aanroepen.find((a) => a.path === '/v1/checkout/sessions')!.velden['subscription_data[trial_period_days]'], undefined);
  });

  it('Stripe uit: nette melding "Betalen is nog niet ingericht", geen aanroep', async () => {
    await assert.rejects(startAbonnement(deps({ stripe: null }), klant), (e: Error) => e instanceof AbonnementFout && e.message === NIET_INGERICHT);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('klant zonder abonnementsplicht: geen Checkout', async () => {
    await zetAbonnementVereist(db, klant, false);
    await assert.rejects(startAbonnement(deps(), klant), /geen abonnement nodig/);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('Stripe-storing komt als Stripe-fout door', async () => {
    fake.storing('POST', '/v1/checkout/sessions', { status: 503 });
    await assert.rejects(startAbonnement(deps(), klant), StripeTijdelijkeFout);
  });
});

describe('beheerAbonnement', () => {
  it('maakt een Billing Portal-sessie voor de eigen customer met return_url naar het portaal', async () => {
    await startAbonnement(deps(), klant);
    const cus = (await vindAbonnement(db, klant))!.stripeCustomerId;
    const url = await beheerAbonnement(deps(), klant);
    assert.ok(url.startsWith(FAKE_PORTAAL_URL));
    const v = fake.aanroepen.at(-1)!.velden;
    assert.equal(v['customer'], cus);
    assert.equal(v['return_url'], 'https://gw.test/portaal/abonnement');
  });

  it('zonder customer: melding om eerst te starten', async () => {
    await assert.rejects(beheerAbonnement(deps(), klant), /Start eerst een abonnement/);
  });

  it('afscherming: klant B krijgt nooit de customer van klant A', async () => {
    await startAbonnement(deps(), klant);
    await assert.rejects(beheerAbonnement(deps(), ander), /Start eerst/);
    assert.ok(!fake.aanroepen.some((a) => a.path === '/v1/billing_portal/sessions'));
  });

  it('Stripe uit: nette melding', async () => {
    await assert.rejects(beheerAbonnement(deps({ stripe: null }), klant), (e: Error) => e.message === NIET_INGERICHT);
  });
});

describe('betaalpoort', () => {
  it('verzendenToegestaan: alleen trialing, active, past_due als het abonnement vereist is', () => {
    for (const s of ['trialing', 'active', 'past_due']) assert.equal(verzendenToegestaan({ vereist: true, status: s }), true, s);
    for (const s of [null, 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'paused']) {
      assert.equal(verzendenToegestaan({ vereist: true, status: s }), false, String(s));
    }
    assert.equal(verzendenToegestaan({ vereist: false, status: null }), true);
    assert.equal(verzendenToegestaan({ vereist: false, status: 'canceled' }), true);
  });

  it('betaalpoortVoorAccount leest abonnement_vereist van de klant en de status', async () => {
    const acc = await account(klant, 'uni-1');
    assert.deepEqual(await betaalpoortVoorAccount(db, acc), { vereist: true, status: null });
    await db.query("insert into subscriptions(client_id, status) values ($1, 'active')", [klant]);
    await zetAbonnementVereist(db, klant, false);
    assert.deepEqual(await betaalpoortVoorAccount(db, acc), { vereist: false, status: 'active' });
  });
});
