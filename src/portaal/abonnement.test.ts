import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { maakWachtwoordHash } from '../admin/wachtwoord.ts';
import type { Klok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { AbonnementConfig } from '../config/abonnement.ts';
import type { Backend } from '../db/backend.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { maakStripeClient } from '../stripe/client.ts';
import { maakUnipileClient } from '../unipile/client.ts';
import { FAKE_CHECKOUT_URL, FAKE_PORTAAL_URL, startFakeStripe, type FakeStripe } from '../../test/fake-stripe/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { gebruikUitnodiging, nodigGebruikerUit } from './gebruikers.ts';
import { maakPortaalApp, type PortaalDeps } from './server.ts';

/**
 * Klantportaal: abonnementspagina, starten (Checkout), beheren (Customer
 * Portal), terugkeerpagina's, waarschuwingsbalk en afscherming (SPEC §14.3, §14.4).
 */

const NU = new Date('2026-10-07T10:00:00Z');
const klok: Klok = { nu: () => NU };
const WACHTWOORD_A = 'eva-haar-wachtwoord-1';
const WACHTWOORD_B = 'bob-zijn-wachtwoord-2';
const CONFIG: AbonnementConfig = { proefperiode_dagen: 30, prijs_per: 'account', waarschuwing_past_due: true };

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let fake: FakeStripe;
let hashA: string;
let hashB: string;
let klantA: string;
let klantB: string;
let app: ReturnType<typeof maakPortaalApp>;

function deps(extra: Partial<PortaalDeps> = {}): PortaalDeps {
  return {
    db,
    limieten,
    klok,
    unipile: maakUnipileClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k' }),
    koppelOpties: { notifyUrl: 'https://gw.test/webhooks/koppel?k=x', apiUrl: 'https://api.unipile.test' },
    cookieSecure: false,
    abonnement: {
      stripe: {
        client: maakStripeClient({ secretKey: 'sk_test_x', baseUrl: fake.baseUrl, timeoutMs: 500 }),
        priceId: 'price_maand',
      },
      config: CONFIG,
      publicBaseUrl: 'https://gw.test',
    },
    ...extra,
  };
}

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
  fake = await startFakeStripe();
  hashA = await maakWachtwoordHash(WACHTWOORD_A);
  hashB = await maakWachtwoordHash(WACHTWOORD_B);
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  fake.reset();
  for (const t of ['portal_sessions', 'client_user_uitnodigingen', 'client_users', 'subscriptions', 'accounts', 'clients']) {
    await db.query(`delete from ${t}`);
  }
  klantA = (await maakClient(db, { naam: 'Acme B.V.', slug: 'acme' })).id;
  klantB = (await maakClient(db, { naam: 'Bolt NV', slug: 'bolt' })).id;
  for (const [klant, n] of [[klantA, 2], [klantB, 1]] as const) {
    for (let i = 0; i < n; i++) {
      const acc = await registreerAccount(db, { clientId: klant, eigenaarNaam: `E${i}`, abonnement: 'free' });
      await markeerAccountGekoppeld(db, acc.id, `uni-${klant}-${i}`);
    }
  }
  await maakGebruiker(klantA, 'Eva', 'eva@acme.nl', hashA);
  await maakGebruiker(klantB, 'Bob', 'bob@bolt.nl', hashB);
  app = maakPortaalApp(deps());
});

async function maakGebruiker(clientId: string, naam: string, email: string, hash: string): Promise<void> {
  const r = await nodigGebruikerUit(db, { clientId, naam, email }, { klok, geldigDagen: 7 });
  await gebruikUitnodiging(db, r.uitnodiging.token, hash, klok);
}

// -- HTTP-hulpjes -----------------------------------------------------------

type Jar = Map<string, string>;

function vang(resp: Response, j: Jar): void {
  for (const header of resp.headers.getSetCookie()) {
    const stuk = header.split(';')[0] ?? '';
    const idx = stuk.indexOf('=');
    const naam = stuk.slice(0, idx).trim();
    const waarde = stuk.slice(idx + 1).trim();
    if (waarde === '' || /max-age=0/i.test(header)) j.delete(naam);
    else j.set(naam, waarde);
  }
}

function cookie(j: Jar): Record<string, string> {
  return j.size === 0 ? {} : { cookie: [...j.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

async function get(pad: string, j: Jar, a = app): Promise<Response> {
  const r = await a.request(pad, { headers: cookie(j) });
  vang(r, j);
  return r;
}

async function post(pad: string, velden: Record<string, string>, j: Jar, a = app): Promise<Response> {
  const r = await a.request(pad, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7', ...cookie(j) },
    body: new URLSearchParams(velden).toString(),
  });
  vang(r, j);
  return r;
}

function csrfUit(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error('geen csrf-veld');
  return m[1]!;
}

async function ingelogd(email = 'eva@acme.nl', wachtwoord = WACHTWOORD_A, a = app): Promise<{ j: Jar; csrf: string }> {
  const j: Jar = new Map();
  const csrfLogin = csrfUit(await (await get('/portaal/login', j, a)).text());
  const r = await post('/portaal/login', { csrf: csrfLogin, email, wachtwoord }, j, a);
  assert.equal(r.status, 303);
  return { j, csrf: csrfUit(await (await get('/portaal/', j, a)).text()) };
}

async function pagina(j: Jar, a = app): Promise<string> {
  const r = await get('/portaal/abonnement', j, a);
  assert.equal(r.status, 200);
  return await r.text();
}

async function zetAbonnement(clientId: string, velden: Record<string, unknown>): Promise<void> {
  await db.query(
    `insert into subscriptions(client_id, stripe_customer_id, stripe_subscription_id, status, proef_tot, periode_tot, opgezegd_per_einde)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      clientId,
      velden['customer'] ?? null,
      velden['sub'] ?? null,
      velden['status'] ?? null,
      velden['proefTot'] ?? null,
      velden['periodeTot'] ?? null,
      velden['opgezegd'] ?? false,
    ],
  );
}

// -- tests -----------------------------------------------------------------

describe('portaal: abonnementspagina', () => {
  it('zonder sessie: door naar de login', async () => {
    const r = await app.request('/portaal/abonnement');
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/portaal/login');
  });

  it('"Abonnement" staat in de navigatie van alle portaalpagina\'s', async () => {
    const { j } = await ingelogd();
    for (const pad of ['/portaal/', '/portaal/resultaten', '/portaal/abonnement']) {
      assert.match(await (await get(pad, j)).text(), /href="\/portaal\/abonnement"[^>]*>Abonnement</, pad);
    }
  });

  it('geen abonnement: "Geen abonnement", aantal accounts en knop "Abonnement starten (30 dagen gratis)"', async () => {
    const { j } = await ingelogd();
    const html = await pagina(j);
    assert.match(html, /Geen abonnement/);
    assert.match(html, /Gekoppelde accounts<\/dt><dd>2</);
    assert.match(html, /Abonnement starten \(30 dagen gratis\)/);
    assert.match(html, /action="\/portaal\/abonnement\/starten"/);
    assert.doesNotMatch(html, /Abonnement beheren/);
  });

  it('proefperiode: "Proefperiode tot <datum>", volgende betaling en knop beheren', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', sub: 'sub_a', status: 'trialing', proefTot: '2026-11-06T10:00:00Z', periodeTot: '2026-11-06T10:00:00Z' });
    const { j } = await ingelogd();
    const html = await pagina(j);
    assert.match(html, /Proefperiode tot 6 november 2026/);
    assert.match(html, /Volgende betaling<\/dt><dd>6 november 2026/);
    assert.match(html, /Abonnement beheren/);
    assert.doesNotMatch(html, /Abonnement starten/);
  });

  it('actief, opgezegd per <datum>', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', sub: 'sub_a', status: 'active', periodeTot: '2026-12-01T10:00:00Z', opgezegd: true });
    const { j } = await ingelogd();
    assert.match(await pagina(j), /Opgezegd per 1 december 2026/);
  });

  it('past_due: "Betaling mislukt" en een waarschuwingsbalk op alle portaalpagina\'s', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', sub: 'sub_a', status: 'past_due' });
    const { j } = await ingelogd();
    assert.match(await pagina(j), /Betaling mislukt/);
    for (const pad of ['/portaal/', '/portaal/resultaten', '/portaal/abonnement', '/portaal/abonnement/gelukt']) {
      assert.match(await (await get(pad, j)).text(), /class="waarschuwing"/, pad);
    }
    // Klant B (geen past_due) ziet geen balk.
    const b = await ingelogd('bob@bolt.nl', WACHTWOORD_B);
    assert.doesNotMatch(await (await get('/portaal/', b.j)).text(), /class="waarschuwing"/);
  });

  it('waarschuwing_past_due = false: geen balk', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', status: 'past_due' });
    const d = deps();
    const a = maakPortaalApp({ ...d, abonnement: { ...d.abonnement!, config: { ...CONFIG, waarschuwing_past_due: false } } });
    const { j } = await ingelogd('eva@acme.nl', WACHTWOORD_A, a);
    assert.doesNotMatch(await (await get('/portaal/', j, a)).text(), /class="waarschuwing"/);
  });

  it('abonnement_vereist = false: "Geen abonnement nodig", geen knoppen', async () => {
    await db.query('update clients set abonnement_vereist = false where id = $1', [klantA]);
    const { j } = await ingelogd();
    const html = await pagina(j);
    assert.match(html, /Geen abonnement nodig/);
    assert.doesNotMatch(html, /abonnement\/starten|abonnement\/beheren/);
  });

  it('Stripe uit: "Betalen is nog niet ingericht" in plaats van een knop; POST geeft dezelfde melding', async () => {
    const a = maakPortaalApp(deps({ abonnement: { ...deps().abonnement!, stripe: null } }));
    const { j, csrf } = await ingelogd('eva@acme.nl', WACHTWOORD_A, a);
    const html = await pagina(j, a);
    assert.match(html, /Betalen is nog niet ingericht/);
    assert.doesNotMatch(html, /action="\/portaal\/abonnement\/starten"/);
    const r = await post('/portaal/abonnement/starten', { csrf }, j, a);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/portaal/abonnement');
    assert.match(await pagina(j, a), /Betalen is nog niet ingericht/);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('zonder abonnement-deps (bestaande opzet) werkt de pagina en meldt "nog niet ingericht"', async () => {
    const { abonnement: _weg, ...zonder } = deps();
    const a = maakPortaalApp(zonder);
    const { j } = await ingelogd('eva@acme.nl', WACHTWOORD_A, a);
    assert.match(await pagina(j, a), /Betalen is nog niet ingericht/);
  });
});

describe('portaal: abonnement starten en beheren', () => {
  it('starten: 303 naar Stripe Checkout, met aantal = gekoppelde accounts van de eigen klant', async () => {
    const { j, csrf } = await ingelogd();
    const r = await post('/portaal/abonnement/starten', { csrf }, j);
    assert.equal(r.status, 303);
    assert.ok(r.headers.get('location')!.startsWith(FAKE_CHECKOUT_URL));
    const checkout = fake.aanroepen.find((x) => x.path === '/v1/checkout/sessions')!.velden;
    assert.equal(checkout['client_reference_id'], klantA);
    assert.equal(checkout['line_items[0][quantity]'], '2');
    assert.equal(fake.aanroepen.find((x) => x.path === '/v1/customers')!.velden['email'], 'eva@acme.nl');
  });

  it('starten zonder geldig CSRF-token: 403, geen Stripe-aanroep', async () => {
    const { j } = await ingelogd();
    const r = await post('/portaal/abonnement/starten', { csrf: 'fout' }, j);
    assert.equal(r.status, 403);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('starten zonder sessie: naar login, geen Stripe-aanroep', async () => {
    const r = await post('/portaal/abonnement/starten', { csrf: 'x' }, new Map());
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/portaal/login');
    assert.equal(fake.aanroepen.length, 0);
  });

  it('starten bij een lopend abonnement: melding, geen Checkout', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', status: 'active' });
    const { j, csrf } = await ingelogd();
    const r = await post('/portaal/abonnement/starten', { csrf }, j);
    assert.equal(r.headers.get('location'), '/portaal/abonnement');
    assert.match(await pagina(j), /al een abonnement/);
    assert.ok(!fake.aanroepen.some((x) => x.path === '/v1/checkout/sessions'));
  });

  it('Stripe-storing bij starten: nette melding, geen 500', async () => {
    fake.storing('POST', '/v1/customers', { status: 500 });
    const { j, csrf } = await ingelogd();
    const r = await post('/portaal/abonnement/starten', { csrf }, j);
    assert.equal(r.status, 303);
    assert.match(await pagina(j), /Stripe is op dit moment niet bereikbaar/);
  });

  it('beheren: 303 naar het Stripe Customer Portal van de eigen customer', async () => {
    fake.klanten.set('cus_a', { id: 'cus_a', object: 'customer' });
    await zetAbonnement(klantA, { customer: 'cus_a', sub: 'sub_a', status: 'active' });
    const { j, csrf } = await ingelogd();
    const r = await post('/portaal/abonnement/beheren', { csrf }, j);
    assert.equal(r.status, 303);
    assert.ok(r.headers.get('location')!.startsWith(FAKE_PORTAAL_URL));
    const v = fake.aanroepen.at(-1)!.velden;
    assert.equal(v['customer'], 'cus_a');
    assert.equal(v['return_url'], 'https://gw.test/portaal/abonnement');
  });

  it('afscherming: klant B kan het abonnement van klant A niet beheren, ook niet met een customer-id in het formulier', async () => {
    fake.klanten.set('cus_a', { id: 'cus_a', object: 'customer' });
    await zetAbonnement(klantA, { customer: 'cus_a', sub: 'sub_a', status: 'active' });
    const { j, csrf } = await ingelogd('bob@bolt.nl', WACHTWOORD_B);
    const r = await post('/portaal/abonnement/beheren', { csrf, customer: 'cus_a', clientId: klantA }, j);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/portaal/abonnement');
    assert.ok(!fake.aanroepen.some((x) => x.path === '/v1/billing_portal/sessions'));
    const html = await pagina(j);
    assert.match(html, /Start eerst een abonnement/);
    assert.doesNotMatch(html, /Acme/);
  });

  it('afscherming: B die start, krijgt een Checkout voor klant B (eigen aantal), niet voor A', async () => {
    await zetAbonnement(klantA, { customer: 'cus_a', status: 'active' });
    const { j, csrf } = await ingelogd('bob@bolt.nl', WACHTWOORD_B);
    await post('/portaal/abonnement/starten', { csrf, clientId: klantA }, j);
    const checkout = fake.aanroepen.find((x) => x.path === '/v1/checkout/sessions')!.velden;
    assert.equal(checkout['client_reference_id'], klantB);
    assert.equal(checkout['line_items[0][quantity]'], '1');
    assert.notEqual(checkout['customer'], 'cus_a');
  });
});

describe('portaal: terugkeerpagina\'s na Stripe', () => {
  it('gelukt en geannuleerd tonen een NL-tekst; zonder sessie naar login', async () => {
    const { j } = await ingelogd();
    assert.match(await (await get('/portaal/abonnement/gelukt', j)).text(), /Uw abonnement is gestart/);
    assert.match(await (await get('/portaal/abonnement/geannuleerd', j)).text(), /niets afgeschreven/);
    const r = await app.request('/portaal/abonnement/gelukt');
    assert.equal(r.headers.get('location'), '/portaal/login');
  });
});
