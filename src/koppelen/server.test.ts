import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { laadJuridisch, type Juridisch } from '../config/juridisch.ts';
import type { Backend } from '../db/backend.ts';
import { maakNieuweKlant } from '../register/nieuweklant.ts';
import { vindGeldigeUitnodiging } from '../register/uitnodiging.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { koppelpaginaSleutels } from '../webhooks/geheim.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakKoppelApp } from './server.ts';

const GEHEIM = 'webhook-geheim-voor-tests';
const NU = new Date('2026-10-07T10:00:00Z');
const DAG = 24 * 60 * 60 * 1000;
const LINK = '/api/v1/hosted/accounts/link';
const UNIPILE_URL = 'https://account.unipile.com/link/fake-123';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let juridisch: Juridisch;
let token: string;
let accountId: string;

function app(klok = vasteKlok(NU)) {
  return maakKoppelApp({
    db,
    unipile,
    klok,
    limieten,
    juridisch,
    webhookSecret: GEHEIM,
    vertrouwProxy: true,
    koppelOpties: {
      notifyUrl: 'https://gateway.test/webhooks/koppel?k=x',
      apiUrl: 'https://api68.unipile.example:19841',
      successRedirectUrl: 'https://gateway.test/koppelen/klaar',
      failureRedirectUrl: 'https://gateway.test/koppelen/mislukt',
    },
  });
}

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 300 });
  limieten = await laadLimieten();
  juridisch = await laadJuridisch();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from account_consents');
  await db.query('delete from koppel_uitnodigingen');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();
  const r = await maakNieuweKlant(
    db,
    {
      klantNaam: 'Acme B.V.',
      slug: 'acme',
      eigenaarNaam: 'Eva de Vries',
      eigenaarEmail: 'eva@acme.nl',
      abonnement: 'premium_business',
      abonnementVereist: true,
    },
    { klok: vasteKlok(NU), geldigDagen: 7 },
  );
  token = r.uitnodiging.token;
  accountId = r.accountId;
});

function csrfVoor(t: string): string {
  return createHmac('sha256', koppelpaginaSleutels(GEHEIM).csrfSleutel)
    .update(t)
    .digest('base64url');
}

function csrfUit(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error('geen csrf-veld');
  return m[1]!;
}

const CSRF_COOKIE_WAARDE = 'abcdefghijklmnopqrstuvwxyz012345';

/** Stuurt standaard de double-submit-cookie mee; `cookie: null` laat hem weg. */
async function post(
  t: string,
  velden: Record<string, string>,
  opts: { klok?: ReturnType<typeof vasteKlok>; headers?: Record<string, string>; cookie?: string | null } = {},
): Promise<Response> {
  const cookie = opts.cookie === undefined ? CSRF_COOKIE_WAARDE : opts.cookie;
  return await app(opts.klok).request(`/koppelen/${t}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': '203.0.113.9',
      'user-agent': 'Testbrowser/1.0',
      ...(cookie === null ? {} : { cookie: `koppel_csrf=${cookie}` }),
      ...(opts.headers ?? {}),
    },
    body: new URLSearchParams(velden).toString(),
  });
}

function volledigFormulier(t: string): Record<string, string> {
  return {
    csrf: csrfVoor(t),
    csrf_cookie: CSRF_COOKIE_WAARDE,
    naam: 'Eva de Vries',
    email: 'eva@acme.nl',
    eigenaar: 'ja',
    toestemming: 'ja',
    voorwaarden: 'ja',
  };
}

async function aantalConsents(): Promise<number> {
  const [r] = await db.query<{ c: number }>('select count(*)::int as c from account_consents');
  return r?.c ?? 0;
}

describe('GET /koppelen/:token', () => {
  it('toont uitleg, vooringevuld formulier en de drie vinkjes met versienummers', async () => {
    const res = await app().request(`/koppelen/${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
    const html = await res.text();
    assert.match(html, /value="Eva de Vries"/);
    assert.match(html, /value="eva@acme\.nl"/);
    assert.match(html, /Acme B\.V\./);
    assert.match(html, /Ik ben eigenaar van dit LinkedIn-account of handel met toestemming van de eigenaar\./);
    assert.match(html, /Ik geef toestemming om dit account via de gateway te gebruiken binnen de vastgelegde limieten\./);
    assert.match(html, /voorwaarden \(versie 0\.1\)/);
    assert.match(html, /verwerkersovereenkomst \(versie 0\.1\)/);
    assert.match(html, /wordt meegestuurd door MARKaaS/);
    assert.match(html, /goedgekeurd/i);
    assert.match(html, /wachtwoord/i);
    assert.match(html, /Unipile/);
    // Limieten uit config/limits.json voor premium_business.
    const inv = limieten.abonnementen.premium_business.invite;
    assert.match(html, new RegExp(`${inv.dag} per dag`));
    assert.match(html, new RegExp(`${inv.week} per week`));
    assert.equal((html.match(/type="checkbox"[^>]*required/g) ?? []).length, 3);
    assert.equal(csrfUit(html), csrfVoor(token));
  });

  it('toont een link als de url van de voorwaarden gevuld is', async () => {
    const met = maakKoppelApp({
      db,
      unipile,
      klok: vasteKlok(NU),
      limieten,
      juridisch: { ...juridisch, voorwaarden: { versie: '1.0', url: 'https://markaas.nl/voorwaarden' } },
      webhookSecret: GEHEIM,
      koppelOpties: { notifyUrl: 'x', apiUrl: 'y' },
    });
    const html = await (await met.request(`/koppelen/${token}`)).text();
    assert.match(html, /href="https:\/\/markaas\.nl\/voorwaarden"/);
    assert.match(html, /voorwaarden \(versie 1\.0\)/);
  });

  it('geeft 410 met dezelfde pagina voor onbekend, verlopen en gebruikt token', async () => {
    const onbekend = await app().request('/koppelen/onbekend-token-xyz');
    assert.equal(onbekend.status, 410);
    const tekstOnbekend = await onbekend.text();
    assert.match(tekstOnbekend, /niet meer geldig/);
    assert.match(tekstOnbekend, /vraag MARKaaS om een nieuwe/i);

    const verlopen = await app(vasteKlok(NU.getTime() + 8 * DAG)).request(`/koppelen/${token}`);
    assert.equal(verlopen.status, 410);
    assert.equal(await verlopen.text(), tekstOnbekend);

    await db.query('update koppel_uitnodigingen set gebruikt_op = now()');
    const gebruikt = await app().request(`/koppelen/${token}`);
    assert.equal(gebruikt.status, 410);
    assert.equal(await gebruikt.text(), tekstOnbekend);
  });
});

describe('POST /koppelen/:token', () => {
  it('weigert zonder alle drie vinkjes: formulier opnieuw met NL-melding, niets opgeslagen', async () => {
    const velden = volledigFormulier(token);
    delete velden['voorwaarden'];
    const res = await post(token, velden);
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /alle drie/i);
    assert.match(html, /value="eva@acme\.nl"/);
    assert.equal(await aantalConsents(), 0);
    assert.equal(fake.aanroepen.length, 0);
    assert.ok(await vindGeldigeUitnodiging(db, token, vasteKlok(NU)));
  });

  it('weigert een ongeldig e-mailadres', async () => {
    const res = await post(token, { ...volledigFormulier(token), email: 'geen-mail' });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /e-mailadres/);
    assert.equal(await aantalConsents(), 0);
  });

  it('double-submit: zonder cookie, zonder veld of met afwijkende waarde 403, niets opgeslagen', async () => {
    assert.equal((await post(token, volledigFormulier(token), { cookie: null })).status, 403);
    const zonderVeld = volledigFormulier(token);
    delete zonderVeld['csrf_cookie'];
    assert.equal((await post(token, zonderVeld)).status, 403);
    assert.equal((await post(token, volledigFormulier(token), { cookie: 'Z'.repeat(32) })).status, 403);
    assert.equal(await aantalConsents(), 0);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('GET zet de double-submit-cookie (HttpOnly, SameSite=Lax, Path=/koppelen) en het formulierveld klopt', async () => {
    const res = await app().request(`/koppelen/${token}`);
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('koppel_csrf='))!;
    assert.ok(setCookie);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Path=\/koppelen/i);
    const waarde = setCookie.split(';')[0]!.split('=')[1]!;
    const html = await res.text();
    assert.match(html, new RegExp(`name="csrf_cookie" value="${waarde}"`));
  });

  it('weigert zonder of met fout CSRF-veld (403)', async () => {
    const zonder = volledigFormulier(token);
    delete zonder['csrf'];
    assert.equal((await post(token, zonder)).status, 403);
    assert.equal((await post(token, { ...volledigFormulier(token), csrf: 'fout' })).status, 403);
    assert.equal(await aantalConsents(), 0);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('slaat toestemming op, markeert de uitnodiging en stuurt door naar Unipile (303)', async () => {
    fake.antwoord('POST', LINK, { status: 200, body: { object: 'HostedAuthUrl', url: UNIPILE_URL } });
    const langeUa = 'U'.repeat(600);
    const res = await post(token, volledigFormulier(token), { headers: { 'user-agent': langeUa } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), UNIPILE_URL);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');

    const rijen = await db.query<Record<string, unknown>>('select * from account_consents');
    assert.equal(rijen.length, 1);
    const c = rijen[0]!;
    assert.equal(c['account_id'], accountId);
    assert.equal(c['naam'], 'Eva de Vries');
    assert.equal(c['email'], 'eva@acme.nl');
    assert.equal(c['versie_voorwaarden'], '0.1');
    assert.equal(c['versie_verwerkersovereenkomst'], '0.1');
    assert.equal(
      c['ip_hash'],
      createHmac('sha256', koppelpaginaSleutels(GEHEIM).ipSleutel).update('203.0.113.9').digest('hex'),
    );
    assert.equal((c['user_agent'] as string).length, 400);
    assert.ok(c['uitnodiging_id']);
    // Momentopname (migratie 0007).
    const [acc] = await db.query<{ client_id: string; eigenaar_naam: string; klant: string }>(
      'select a.client_id, a.eigenaar_naam, c.naam as klant from accounts a join clients c on c.id = a.client_id where a.id = $1',
      [accountId],
    );
    assert.equal(c['client_id'], acc!.client_id);
    assert.equal(c['klantnaam'], acc!.klant);
    assert.equal(c['account_eigenaar_naam'], acc!.eigenaar_naam);
    assert.equal(c['unipile_account_id'], null);

    assert.equal(await vindGeldigeUitnodiging(db, token, vasteKlok(NU)), null, 'eenmalig');
    const [u] = await db.query<{ gebruikt_op: Date | null }>('select gebruikt_op from koppel_uitnodigingen');
    assert.ok(u?.gebruikt_op);

    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['type'], 'create');
    assert.equal(body['name'], accountId);
    assert.equal(body['success_redirect_url'], 'https://gateway.test/koppelen/klaar');
    assert.equal(body['failure_redirect_url'], 'https://gateway.test/koppelen/mislukt');

    // Tweede keer: link is op.
    const nogmaals = await post(token, volledigFormulier(token));
    assert.equal(nogmaals.status, 410);
    assert.equal(fake.aanroepen.length, 1);
  });

  it('bij een Unipile-fout blijft de toestemming staan en blijft de uitnodiging bruikbaar', async () => {
    fake.antwoord('POST', LINK, { status: 429, headers: { 'Retry-After': '30' }, body: {} });
    const res = await post(token, volledigFormulier(token));
    assert.equal(res.status, 503);
    assert.match(await res.text(), /probeer het over een paar minuten opnieuw/i);
    assert.equal(await aantalConsents(), 1);
    assert.ok(await vindGeldigeUitnodiging(db, token, vasteKlok(NU)), 'uitnodiging niet gebruikt');

    fake.reset();
    fake.antwoord('POST', LINK, { status: 200, body: { object: 'HostedAuthUrl', url: UNIPILE_URL } });
    const opnieuw = await post(token, volledigFormulier(token));
    assert.equal(opnieuw.status, 303);
    assert.equal(await aantalConsents(), 2);
  });

  it('bij een time-out van Unipile hetzelfde vriendelijke foutpad', async () => {
    fake.antwoord('POST', LINK, {
      status: 200,
      body: { object: 'HostedAuthUrl', url: UNIPILE_URL },
      delayMs: 600,
    });
    const res = await post(token, volledigFormulier(token));
    assert.equal(res.status, 503);
    assert.ok(await vindGeldigeUitnodiging(db, token, vasteKlok(NU)));
  });

  it('geeft 410 op een verlopen token, zonder iets op te slaan', async () => {
    const res = await post(token, volledigFormulier(token), {
      klok: vasteKlok(NU.getTime() + 8 * DAG),
    });
    assert.equal(res.status, 410);
    assert.equal(await aantalConsents(), 0);
  });
});

describe('terugkeerpagina’s', () => {
  it('GET /koppelen/klaar en /koppelen/mislukt geven nette pagina’s', async () => {
    const klaar = await app().request('/koppelen/klaar');
    assert.equal(klaar.status, 200);
    assert.match(await klaar.text(), /gekoppeld/i);
    const mislukt = await app().request('/koppelen/mislukt');
    assert.equal(mislukt.status, 200);
    assert.match(await mislukt.text(), /niet gelukt/i);
  });
});
