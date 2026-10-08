import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { laadAbonnementConfig, type AbonnementConfig } from '../config/abonnement.ts';
import { leesEnv, type Env } from '../config/env.ts';
import { laadJuridisch, type Juridisch } from '../config/juridisch.ts';
import { laadIntake, type Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import { maakLogger } from '../log/logger.ts';
import { vastePauze } from '../queue/pauze.ts';
import { vasteWerkdagen } from '../sequences/wachttijd.ts';
import { maakStripeClient, type StripeClient } from '../stripe/client.ts';
import { maakUnipileClient } from '../unipile/client.ts';
import { koppelSleutel } from '../webhooks/geheim.ts';
import { startFakeStripe } from '../../test/fake-stripe/server.ts';
import { maakStripeEvent, ondertekendVerzoek } from '../../test/fake-stripe/webhook.ts';
import { maakClient } from '../register/clients.ts';
import { registreerAccount } from '../register/accounts.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakGatewayApp, maskeerPad, unipileBaseUrl } from './app.ts';
import { maakHealthApp } from './health.ts';
import { leesVersie } from './versie.ts';

const GEHEIMEN = {
  UNIPILE_DSN: 'api68.unipile.com:19841',
  UNIPILE_API_KEY: 'unipile-sleutel-zeer-geheim',
  WEBHOOK_SECRET: 'webhook-geheim-zeer-geheim',
  MCP_TOKEN: 'mcp-token-zeer-geheim',
  ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
  DATABASE_URL: 'postgres://gebruiker:dbwachtwoord@db.voorbeeld:5432/postgres',
};

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let juridisch: Juridisch;
let abonnement: AbonnementConfig;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
  juridisch = await laadJuridisch();
  abonnement = await laadAbonnementConfig();
});

after(async () => {
  await close();
});

function maakApp(
  env: Env,
  opties: { db?: Backend; regels?: string[]; stripe?: StripeClient; intake?: Intake } = {},
) {
  return maakGatewayApp({
    env,
    db: opties.db ?? db,
    // Wijst nergens heen: deze tests raken Unipile niet.
    unipile: maakUnipileClient({ baseUrl: 'http://127.0.0.1:9', apiKey: env.unipileApiKey }),
    limieten,
    juridisch,
    klok: vasteKlok('2026-10-01T08:00:00Z'),
    pauzeKiezer: vastePauze(0),
    werkdagen: vasteWerkdagen(1),
    logger: maakLogger({
      niveau: 'debug',
      geheimen: Object.values(GEHEIMEN),
      schrijf: (r) => opties.regels?.push(r),
    }),
    versie: leesVersie(),
    abonnement,
    ...(opties.stripe ? { stripe: opties.stripe } : {}),
    ...(opties.intake ? { intake: opties.intake } : {}),
  });
}

const kapotteDb: Backend = {
  exec: async () => {
    throw new Error('verbinding geweigerd: postgres://gebruiker:dbwachtwoord@db.voorbeeld');
  },
  query: async () => {
    throw new Error('verbinding geweigerd: postgres://gebruiker:dbwachtwoord@db.voorbeeld');
  },
  close: async () => {},
  transaction: async () => {
    throw new Error('geen db');
  },
};

describe('GET /health', () => {
  it('geeft 200 met versie uit package.json en een bereikbare database', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, {
      status: 'ok',
      versie: leesVersie(),
      database: { bereikbaar: true },
    });
    assert.match(body.versie, /^\d+\.\d+\.\d+/);
  });

  it('geeft 200 met bereikbaar=false als de database faalt, zonder de fouttekst', async () => {
    const app = maakApp(leesEnv(GEHEIMEN), { db: kapotteDb });
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const tekst = await res.text();
    assert.deepEqual(JSON.parse(tekst), {
      status: 'database_onbereikbaar',
      versie: leesVersie(),
      database: { bereikbaar: false },
    });
    assert.doesNotMatch(tekst, /dbwachtwoord|voorbeeld|geweigerd/);
  });

  it('meldt onbereikbaar als de database niet binnen de time-out antwoordt', async () => {
    const trageDb: Backend = { ...kapotteDb, query: () => new Promise(() => {}) };
    const app = maakHealthApp({ db: trageDb, versie: '1.2.3', timeoutMs: 20 });
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { database: { bereikbaar: boolean } };
    assert.equal(body.database.bereikbaar, false);
  });

  it('lekt geen geheimen, accountgegevens of database-URL', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const tekst = await (await app.request('/health')).text();
    for (const waarde of Object.values(GEHEIMEN)) {
      assert.ok(!tekst.includes(waarde), 'health-antwoord bevat een geheime waarde');
    }
    assert.doesNotMatch(tekst, /account|unipile|postgres/i);
  });

  it('vereist geen token of login', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, NODE_ENV: 'production' }));
    const res = await app.request('/health');
    assert.equal(res.status, 200);
  });
});

describe('maakGatewayApp', () => {
  it('monteert webhooks, MCP en admin achter hun eigen beveiliging', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    assert.equal((await app.request('/webhooks/unipile', { method: 'POST' })).status, 401);
    assert.equal((await app.request('/mcp', { method: 'POST' })).status, 401);
    const admin = await app.request('/admin/');
    assert.equal(admin.status, 303);
    assert.equal(admin.headers.get('location'), '/admin/login');
  });

  it('/admin zonder slash stuurt door naar /admin/', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/admin');
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/admin/');
  });

  it('zet cookies met Secure in productie', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, NODE_ENV: 'production' }));
    const res = await app.request('/admin/login');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /admin_csrf=/);
    assert.match(cookie, /;\s*Secure/i);
  });

  it('zet cookies zonder Secure buiten productie (lokaal via http)', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/admin/login');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /admin_csrf=/);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  });

  it('logt verzoeken als JSON zonder headers of geheimen', async () => {
    const regels: string[] = [];
    const app = maakApp(leesEnv(GEHEIMEN), { regels });
    await app.request('/mcp?x=1', {
      method: 'POST',
      headers: { authorization: `Bearer ${GEHEIMEN.MCP_TOKEN}` },
      body: '{}',
    });
    assert.ok(regels.length > 0);
    const regel = JSON.parse(regels.at(-1)!);
    assert.equal(regel.bericht, 'HTTP-verzoek');
    assert.equal(regel.pad, '/mcp');
    assert.equal(regel.methode, 'POST');
    for (const r of regels) {
      for (const waarde of Object.values(GEHEIMEN)) {
        assert.ok(!r.includes(waarde), 'logregel bevat een geheime waarde');
      }
    }
  });

  it('logt een koppel-callback zonder de sleutel uit de querystring', async () => {
    const regels: string[] = [];
    const app = maakApp(leesEnv(GEHEIMEN), { regels });
    const k = koppelSleutel(GEHEIMEN.WEBHOOK_SECRET);
    const res = await app.request(`/webhooks/koppel?k=${k}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'RECONNECTED', account_id: 'onbekend' }),
    });
    assert.equal(res.status, 200);
    const regel = JSON.parse(regels.at(-1)!);
    assert.equal(regel.pad, '/webhooks/koppel');
    for (const r of regels) assert.ok(!r.includes(k), 'logregel bevat de koppelsleutel');
  });
});

describe('koppelpagina in de gateway', () => {
  it('monteert /koppelen/* publiek: onbekend token geeft 410 zonder login', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/koppelen/onbekend-token');
    assert.equal(res.status, 410);
    assert.equal((await app.request('/koppelen/klaar')).status, 200);
  });

  it('logt het pad van de koppelpagina zonder het token', async () => {
    const regels: string[] = [];
    const app = maakApp(leesEnv(GEHEIMEN), { regels });
    const token = 'Zeer-Geheim-Token-1234567890abcdefghijklmnopq';
    await app.request(`/koppelen/${token}`);
    const regel = JSON.parse(regels.at(-1)!);
    assert.equal(regel.pad, '/koppelen/…');
    for (const r of regels) assert.ok(!r.includes(token), 'logregel bevat het koppeltoken');
  });

  it('maskeerPad laat vaste koppelpaden en andere paden staan', () => {
    assert.equal(maskeerPad('/koppelen/klaar'), '/koppelen/klaar');
    assert.equal(maskeerPad('/koppelen/mislukt'), '/koppelen/mislukt');
    assert.equal(maskeerPad('/admin/klanten'), '/admin/klanten');
    assert.equal(maskeerPad('/koppelen/abc'), '/koppelen/…');
  });
});

describe('klantportaal in de gateway', () => {
  it('monteert /portaal/*: zonder sessie naar de login, onbekende uitnodiging geeft 410', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const start = await app.request('/portaal/');
    assert.equal(start.status, 303);
    assert.equal(start.headers.get('location'), '/portaal/login');
    assert.equal((await app.request('/portaal/login')).status, 200);
    assert.equal((await app.request('/portaal/uitnodiging/onbekend')).status, 410);
  });

  it('klantprofiel (SPEC §14.6) alleen met intake-configuratie: portaal en admin', async () => {
    const zonder = maakApp(leesEnv(GEHEIMEN));
    assert.equal((await zonder.request('/portaal/profiel')).status, 404);
    const met = maakApp(leesEnv(GEHEIMEN), { intake: await laadIntake() });
    const portaal = await met.request('/portaal/profiel');
    assert.equal(portaal.status, 303);
    assert.equal(portaal.headers.get('location'), '/portaal/login');
    const admin = await met.request('/admin/klanten/tag/profiel');
    assert.equal(admin.headers.get('location'), '/admin/login');
  });

  it('logt het pad van de uitnodigingspagina zonder het token', async () => {
    const regels: string[] = [];
    const app = maakApp(leesEnv(GEHEIMEN), { regels });
    const token = 'Portaal-Geheim-Token-1234567890abcdefghijklmn';
    await app.request(`/portaal/uitnodiging/${token}`);
    const regel = JSON.parse(regels.at(-1)!);
    assert.equal(regel.pad, '/portaal/uitnodiging/…');
    for (const r of regels) assert.ok(!r.includes(token), 'logregel bevat het uitnodigingstoken');
    assert.equal(maskeerPad('/portaal/resultaten'), '/portaal/resultaten');
  });
});

describe('unipileBaseUrl', () => {
  it('maakt een https-URL van de DSN', () => {
    assert.equal(unipileBaseUrl('api68.unipile.com:19841'), 'https://api68.unipile.com:19841');
    assert.equal(unipileBaseUrl('https://api68.unipile.com:19841/'), 'https://api68.unipile.com:19841');
  });
});

describe('Stripe-webhook in de gateway (SPEC §14.4)', () => {
  const STRIPE = {
    STRIPE_SECRET_KEY: 'sk_test_zeer_geheim',
    STRIPE_WEBHOOK_SECRET: 'whsec_zeer_geheim',
    STRIPE_PRICE_ID: 'price_maand',
  };
  const NU_S = Math.floor(new Date('2026-10-01T08:00:00Z').getTime() / 1000);

  it('Stripe uit: /webhooks/stripe antwoordt 503 en slaat niets op', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const { body, headers } = ondertekendVerzoek(maakStripeEvent('invoice.paid', { id: 'in_1' }, { id: 'evt_uit' }), STRIPE.STRIPE_WEBHOOK_SECRET, NU_S);
    const r = await app.request('/webhooks/stripe', { method: 'POST', headers, body });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /nog niet ingericht/);
    const rijen = await db.query("select 1 from events where extern_id = 'stripe:evt_uit'");
    assert.equal(rijen.length, 0);
  });

  it('niet achter het Unipile-geheim; geldige Stripe-handtekening → 200 en opgeslagen', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, ...STRIPE }), {
      stripe: maakStripeClient({ secretKey: STRIPE.STRIPE_SECRET_KEY, baseUrl: 'http://127.0.0.1:9', timeoutMs: 200 }),
    });
    const { body, headers } = ondertekendVerzoek(
      maakStripeEvent('customer.created', { id: 'cus_1', object: 'customer' }, { id: 'evt_app_ok', created: NU_S }),
      STRIPE.STRIPE_WEBHOOK_SECRET,
      NU_S,
    );
    const r = await app.request('/webhooks/stripe', { method: 'POST', headers, body });
    assert.equal(r.status, 200);
    const rijen = await db.query<{ type: string }>("select type from events where extern_id = 'stripe:evt_app_ok'");
    assert.deepEqual(rijen, [{ type: 'customer.created' }]);
    // Tweede levering: ook 200, niets dubbel.
    const r2 = await app.request('/webhooks/stripe', { method: 'POST', headers, body });
    assert.equal(r2.status, 200);
    assert.equal(((await r2.json()) as { dubbel?: boolean }).dubbel, true);
  });

  it('ongeldige of verlopen handtekening → 400, niets opgeslagen', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, ...STRIPE }));
    const event = maakStripeEvent('invoice.paid', { id: 'in_1' }, { id: 'evt_app_fout', created: NU_S });
    const fout = ondertekendVerzoek(event, 'whsec_ander', NU_S);
    assert.equal((await app.request('/webhooks/stripe', { method: 'POST', headers: fout.headers, body: fout.body })).status, 400);
    const oud = ondertekendVerzoek(event, STRIPE.STRIPE_WEBHOOK_SECRET, NU_S - 301);
    assert.equal((await app.request('/webhooks/stripe', { method: 'POST', headers: oud.headers, body: oud.body })).status, 400);
    const zonder = await app.request('/webhooks/stripe', { method: 'POST', body: oud.body });
    assert.equal(zonder.status, 400);
    // Het Unipile-geheim helpt niet.
    const metUnipile = await app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': GEHEIMEN.WEBHOOK_SECRET },
      body: oud.body,
    });
    assert.equal(metUnipile.status, 400);
    assert.equal((await db.query("select 1 from events where extern_id = 'stripe:evt_app_fout'")).length, 0);
  });

  it('Unipile-webhooks blijven achter hun eigen geheim', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, ...STRIPE }));
    const r = await app.request('/webhooks/unipile', { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  });

  it('logt geen Stripe-geheimen', async () => {
    const regels: string[] = [];
    const env = leesEnv({ ...GEHEIMEN, ...STRIPE });
    const app = maakApp(env, { regels });
    const { body, headers } = ondertekendVerzoek(maakStripeEvent('x.y', { id: 'o' }), 'whsec_ander', NU_S);
    await app.request('/webhooks/stripe', { method: 'POST', headers, body });
    for (const r of regels) {
      assert.ok(!r.includes(STRIPE.STRIPE_WEBHOOK_SECRET));
      assert.ok(!r.includes(STRIPE.STRIPE_SECRET_KEY));
    }
  });
});

describe('aantal in Stripe na een nieuw gekoppeld account (SPEC §14.4)', () => {
  it('CREATION_SUCCESS via /webhooks/koppel werkt de quantity van het lopende abonnement bij', async () => {
    const fake = await startFakeStripe();
    try {
      const env = leesEnv({
        ...GEHEIMEN,
        STRIPE_SECRET_KEY: 'sk_test_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
        STRIPE_PRICE_ID: 'price_x',
      });
      const app = maakApp(env, { stripe: maakStripeClient({ secretKey: 'sk_test_x', baseUrl: fake.baseUrl, timeoutMs: 500 }) });
      const klant = await maakClient(db, { naam: 'Quantity BV', slug: 'quantity' });
      await db.query(
        "insert into subscriptions(client_id, stripe_customer_id, stripe_subscription_id, status) values ($1, 'cus_q', 'sub_q', 'active')",
        [klant.id],
      );
      fake.abonnementen.set('sub_q', {
        id: 'sub_q', customer: 'cus_q', status: 'active', trial_end: null, cancel_at_period_end: false,
        items: { object: 'list', data: [{ id: 'si_q', quantity: 1 }] },
      });
      for (const naam of ['Een', 'Twee']) {
        const acc = await registreerAccount(db, { clientId: klant.id, eigenaarNaam: naam, abonnement: 'free' });
        const r = await app.request('/webhooks/koppel', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-webhook-secret': GEHEIMEN.WEBHOOK_SECRET },
          body: JSON.stringify({ status: 'CREATION_SUCCESS', account_id: `uni-q-${naam}`, name: acc.id }),
        });
        assert.equal(r.status, 200);
      }
      const items = fake.abonnementen.get('sub_q')!['items'] as { data: Array<{ quantity: number }> };
      assert.equal(items.data[0]!.quantity, 2);
    } finally {
      await fake.stop();
    }
  });
});
