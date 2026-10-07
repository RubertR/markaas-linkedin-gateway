import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Klok } from '../budget/klok.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Backend } from '../db/backend.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { maakStripeClient, type StripeClient } from '../stripe/client.ts';
import { startFakeStripe, type FakeStripe } from '../../test/fake-stripe/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  laatsteAantalSync,
  synchroniseerAantal,
  synchroniseerAantalVoorAccount,
  type AantalSyncDeps,
} from './aantal.ts';

const klok: Klok = { nu: () => new Date('2026-10-07T10:00:00Z') };
const CONFIG: AbonnementConfig = { proefperiode_dagen: 30, prijs_per: 'account', waarschuwing_past_due: true };

let db: Backend;
let close: () => Promise<void>;
let fake: FakeStripe;
let stripe: StripeClient;
let klant: string;

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
  await db.query(
    "insert into subscriptions(client_id, stripe_customer_id, stripe_subscription_id, status) values ($1, 'cus_1', 'sub_1', 'active')",
    [klant],
  );
  fake.abonnementen.set('sub_1', {
    id: 'sub_1', customer: 'cus_1', status: 'active', trial_end: null, cancel_at_period_end: false,
    items: { object: 'list', data: [{ id: 'si_1', quantity: 1 }] },
  });
});

function deps(over: Partial<AantalSyncDeps> = {}): AantalSyncDeps {
  return { db, stripe, config: CONFIG, klok, ...over };
}

async function koppel(n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const a = await registreerAccount(db, { clientId: klant, eigenaarNaam: `E${i}`, abonnement: 'free' });
    await markeerAccountGekoppeld(db, a.id, `uni-${a.id}`);
    ids.push(a.id);
  }
  return ids;
}

function quantity(): unknown {
  return (fake.abonnementen.get('sub_1')!['items'] as { data: Array<{ quantity: number }> }).data[0]!.quantity;
}

describe('synchroniseerAantal', () => {
  it('werkt items[0][quantity] bij naar het aantal gekoppelde accounts, met proration', async () => {
    const [eerste] = await koppel(3);
    const u = await synchroniseerAantalVoorAccount(deps(), eerste!, 'koppeling');
    assert.deepEqual(u, { resultaat: 'bijgewerkt', van: 1, naar: 3 });
    assert.equal(quantity(), 3);
    const post = fake.aanroepen.find((a) => a.method === 'POST' && a.path === '/v1/subscriptions/sub_1')!;
    assert.equal(post.velden['items[0][id]'], 'si_1');
    assert.equal(post.velden['proration_behavior'], 'create_prorations');
    const s = await laatsteAantalSync(db, klant);
    assert.equal(s?.gelukt, true);
  });

  it('ongewijzigd als het aantal al klopt (geen POST)', async () => {
    await koppel(1);
    assert.equal((await synchroniseerAantal(deps(), klant, 'admin')).resultaat, 'ongewijzigd');
    assert.ok(!fake.aanroepen.some((a) => a.method === 'POST'));
  });

  it('na ontkoppelen gaat het aantal omlaag (minimaal 1)', async () => {
    fake.abonnementen.get('sub_1')!['items'] = { data: [{ id: 'si_1', quantity: 4 }] };
    const ids = await koppel(2);
    await db.query('update accounts set unipile_account_id = null where id = $1', [ids[0]]);
    assert.deepEqual(await synchroniseerAantal(deps(), klant, 'admin'), { resultaat: 'bijgewerkt', van: 4, naar: 1 });
  });

  it('overgeslagen bij prijs per klant, Stripe uit of zonder lopend abonnement', async () => {
    await koppel(2);
    assert.equal((await synchroniseerAantal(deps({ config: { ...CONFIG, prijs_per: 'klant' } }), klant, 'x')).resultaat, 'overgeslagen');
    assert.equal((await synchroniseerAantal(deps({ stripe: null }), klant, 'x')).resultaat, 'overgeslagen');
    await db.query("update subscriptions set status = 'canceled'");
    assert.equal((await synchroniseerAantal(deps(), klant, 'x')).resultaat, 'overgeslagen');
    assert.equal(fake.aanroepen.length, 0);
  });

  it('Stripe-fout: gooit niet, logt en slaat een event op dat de admin toont', async () => {
    await koppel(2);
    fake.storing('POST', '/v1/subscriptions/sub_1', { status: 500 });
    const fouten: string[] = [];
    const u = await synchroniseerAantal(
      deps({ logger: { debug() {}, info() {}, warn() {}, error: (b: string) => fouten.push(b) } }),
      klant,
      'koppeling',
    );
    assert.equal(u.resultaat, 'mislukt');
    assert.equal(fouten.length, 1);
    const s = await laatsteAantalSync(db, klant);
    assert.equal(s?.gelukt, false);
    assert.match(s?.fout ?? '', /serverfout/);
  });
});
