import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Klok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount, werkAccountStatusBij } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { vindGeldigeUitnodiging } from '../register/uitnodiging.ts';
import { startSequentie } from '../sequences/motor.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakWachtwoordHash } from '../admin/wachtwoord.ts';
import { deactiveerGebruiker, gebruikUitnodiging, nodigGebruikerUit } from './gebruikers.ts';
import { maakPortaalApp, type PortaalDeps } from './server.ts';

const NU = new Date('2026-10-07T10:00:00Z');
const UUR = 60 * 60 * 1000;
const LINK = '/api/v1/hosted/accounts/link';
const UNIPILE_URL = 'https://account.unipile.com/link/reconnect-123';
const WACHTWOORD_A = 'eva-haar-wachtwoord-1';
const WACHTWOORD_B = 'bob-zijn-wachtwoord-2';

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let fake: FakeUnipile;
let unipile: UnipileClient;
let hashA: string;
let hashB: string;

// Verstelbare klok: sessie-verloop testen zonder te wachten.
let nu = NU;
const klok: Klok = { nu: () => nu };

let klantA: string;
let klantB: string;
let accA: string;
let accA2: string;
let accB: string;
let evaId: string;

function deps(extra: Partial<PortaalDeps> = {}): PortaalDeps {
  return {
    db,
    limieten,
    klok,
    unipile,
    koppelOpties: {
      notifyUrl: 'https://gateway.test/webhooks/koppel?k=x',
      apiUrl: 'https://api68.unipile.example:19841',
    },
    cookieSecure: false,
    vertrouwProxy: true,
    koppeluitnodigingGeldigDagen: 7,
    ...extra,
  };
}

let app: ReturnType<typeof maakPortaalApp>;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 300 });
  hashA = await maakWachtwoordHash(WACHTWOORD_A);
  hashB = await maakWachtwoordHash(WACHTWOORD_B);
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  nu = NU;
  fake.reset();
  for (const t of [
    'portal_sessions',
    'client_user_uitnodigingen',
    'client_users',
    'koppel_uitnodigingen',
    'usage',
    'actions',
    'sequences',
    'events',
    'accounts',
    'clients',
  ]) {
    await db.query(`delete from ${t}`);
  }
  // Betaalpoort staat hier niet ter test (zie abonnement.test.ts).
  klantA = (await maakClient(db, { naam: 'Acme B.V.', slug: 'acme', abonnementVereist: false })).id;
  klantB = (await maakClient(db, { naam: 'Bolt NV', slug: 'bolt', abonnementVereist: false })).id;
  accA = (await registreerAccount(db, { clientId: klantA, eigenaarNaam: 'Eva de Vries', abonnement: 'premium_business' })).id;
  accA2 = (await registreerAccount(db, { clientId: klantA, eigenaarNaam: 'Adam Acme', eigenaarEmail: 'adam@acme.nl', abonnement: 'free' })).id;
  accB = (await registreerAccount(db, { clientId: klantB, eigenaarNaam: 'Bob Bolt', abonnement: 'free' })).id;
  await markeerAccountGekoppeld(db, accA, 'uni-a');
  await markeerAccountGekoppeld(db, accB, 'uni-b');
  evaId = await maakGebruiker(klantA, 'Eva de Vries', 'eva@acme.nl', hashA);
  await maakGebruiker(klantB, 'Bob Bolt', 'bob@bolt.nl', hashB);
  app = maakPortaalApp(deps());
});

async function maakGebruiker(clientId: string, naam: string, email: string, hash: string): Promise<string> {
  const r = await nodigGebruikerUit(db, { clientId, naam, email }, { klok, geldigDagen: 7 });
  await gebruikUitnodiging(db, r.uitnodiging.token, hash, klok);
  return r.gebruiker.id;
}

function ontvanger(naam: string): Record<string, unknown> {
  return {
    ontvanger_naam: naam,
    ontvanger_functie: 'Salesdirecteur',
    ontvanger_bedrijf: `${naam} BV`,
    ontvanger_url: `https://www.linkedin.com/in/${naam.toLowerCase()}/`,
    waarom: 'Plaatste vorige week een vacature.',
  };
}

async function draft(accountId: string, naam: string, tekst = `Hoi ${naam}, zullen we kennismaken?`) {
  return await maakActie(db, {
    accountId,
    type: 'invite',
    payload: { ...ontvanger(naam), providerId: `ACo-${naam}`, message: tekst },
  });
}

// -- HTTP-hulpjes -----------------------------------------------------------

interface Jar {
  cookies: Map<string, string>;
  ruw: string[];
}

function jar(): Jar {
  return { cookies: new Map(), ruw: [] };
}

function vang(resp: Response, j: Jar): void {
  for (const header of resp.headers.getSetCookie()) {
    j.ruw.push(header);
    const stuk = header.split(';')[0] ?? '';
    const idx = stuk.indexOf('=');
    const naam = stuk.slice(0, idx).trim();
    const waarde = stuk.slice(idx + 1).trim();
    if (waarde === '' || /max-age=0/i.test(header)) j.cookies.delete(naam);
    else j.cookies.set(naam, waarde);
  }
}

function cookieHeader(j: Jar): Record<string, string> {
  return j.cookies.size === 0
    ? {}
    : { cookie: [...j.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

async function get(pad: string, j: Jar, a = app): Promise<Response> {
  const resp = await a.request(pad, { headers: cookieHeader(j) });
  vang(resp, j);
  return resp;
}

async function post(
  pad: string,
  velden: Record<string, string | string[]>,
  j: Jar,
  opts: { ip?: string; a?: ReturnType<typeof maakPortaalApp> } = {},
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(velden)) {
    if (Array.isArray(v)) v.forEach((x) => form.append(k, x));
    else form.append(k, v);
  }
  const resp = await (opts.a ?? app).request(pad, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': opts.ip ?? '198.51.100.1',
      ...cookieHeader(j),
    },
    body: form.toString(),
  });
  vang(resp, j);
  return resp;
}

function csrfUit(html: string): string {
  const m = html.match(/name="csrf" value="([^"]+)"/);
  if (!m) throw new Error('geen csrf-veld in de pagina');
  return m[1]!;
}

async function login(
  email: string,
  wachtwoord: string,
  opts: { ip?: string; j?: Jar; a?: ReturnType<typeof maakPortaalApp> } = {},
): Promise<{ j: Jar; resp: Response }> {
  const j = opts.j ?? jar();
  const pagina = await get('/portaal/login', j, opts.a);
  const csrf = csrfUit(await pagina.text());
  const resp = await post('/portaal/login', { csrf, email, wachtwoord }, j, opts);
  return { j, resp };
}

async function ingelogd(email = 'eva@acme.nl', wachtwoord = WACHTWOORD_A): Promise<{ j: Jar; csrf: string }> {
  const { j, resp } = await login(email, wachtwoord);
  assert.equal(resp.status, 303, 'login moet lukken');
  const pagina = await get('/portaal/', j);
  assert.equal(pagina.status, 200);
  return { j, csrf: csrfUit(await pagina.text()) };
}

async function status(actieId: string): Promise<string | undefined> {
  return (await vindActie(db, actieId))?.status;
}

// -- uitnodiging en wachtwoord kiezen ---------------------------------------

describe('portaal: uitnodiging en wachtwoord kiezen', () => {
  async function nieuweUitnodiging() {
    return await nodigGebruikerUit(
      db,
      { clientId: klantA, naam: 'Nina Nieuw', email: 'nina@acme.nl' },
      { klok, geldigDagen: 7 },
    );
  }

  it('toont naam en klant bij een geldige link', async () => {
    const r = await nieuweUitnodiging();
    const resp = await get(`/portaal/uitnodiging/${r.uitnodiging.token}`, jar());
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /Nina Nieuw/);
    assert.match(html, /Acme B\.V\./);
    assert.match(html, /minimaal 12 tekens/);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    assert.equal(resp.headers.get('referrer-policy'), 'no-referrer');
  });

  it('ongeldige, verlopen en gebruikte links geven 410 met een vriendelijke tekst', async () => {
    const onbekend = await get('/portaal/uitnodiging/onzin', jar());
    assert.equal(onbekend.status, 410);
    assert.match(await onbekend.text(), /werkt niet meer/);

    const r = await nieuweUitnodiging();
    nu = new Date(NU.getTime() + 8 * 24 * UUR);
    assert.equal((await get(`/portaal/uitnodiging/${r.uitnodiging.token}`, jar())).status, 410);
  });

  it('wachtwoord kiezen: minimaal 12 tekens en twee keer gelijk, anders 400', async () => {
    const r = await nieuweUitnodiging();
    const j = jar();
    const csrf = csrfUit(await (await get(`/portaal/uitnodiging/${r.uitnodiging.token}`, j)).text());
    const kort = await post(`/portaal/uitnodiging/${r.uitnodiging.token}`, { csrf, wachtwoord: 'kort', herhaling: 'kort' }, j);
    assert.equal(kort.status, 400);
    assert.match(await kort.text(), /minimaal 12 tekens/);
    const ongelijk = await post(
      `/portaal/uitnodiging/${r.uitnodiging.token}`,
      { csrf, wachtwoord: 'twaalf-tekens-a', herhaling: 'twaalf-tekens-b' },
      j,
    );
    assert.equal(ongelijk.status, 400);
    assert.match(await ongelijk.text(), /niet gelijk/);
  });

  it('zonder geldig CSRF-token wordt niets opgeslagen (403)', async () => {
    const r = await nieuweUitnodiging();
    const resp = await post(
      `/portaal/uitnodiging/${r.uitnodiging.token}`,
      { csrf: 'verkeerd', wachtwoord: 'een-goed-wachtwoord', herhaling: 'een-goed-wachtwoord' },
      jar(),
    );
    assert.equal(resp.status, 403);
    const [g] = await db.query<{ wachtwoord_hash: string | null }>(
      "select wachtwoord_hash from client_users where email = 'nina@acme.nl'",
    );
    assert.equal(g?.wachtwoord_hash, null);
  });

  it('na een geldig wachtwoord direct ingelogd; de link werkt daarna niet meer; inloggen met het wachtwoord lukt', async () => {
    const r = await nieuweUitnodiging();
    const j = jar();
    const csrf = csrfUit(await (await get(`/portaal/uitnodiging/${r.uitnodiging.token}`, j)).text());
    const resp = await post(
      `/portaal/uitnodiging/${r.uitnodiging.token}`,
      { csrf, wachtwoord: 'nina-kiest-iets-moois', herhaling: 'nina-kiest-iets-moois' },
      j,
    );
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/');
    assert.ok(j.cookies.has('portaal_sessie'));
    const start = await get('/portaal/', j);
    assert.equal(start.status, 200);
    assert.match(await start.text(), /Acme B\.V\./);
    assert.equal((await get(`/portaal/uitnodiging/${r.uitnodiging.token}`, jar())).status, 410);
    const { resp: loginResp } = await login('nina@acme.nl', 'nina-kiest-iets-moois');
    assert.equal(loginResp.status, 303);
  });
});

// -- login, logout, brute force, sessies ------------------------------------

describe('portaal: inloggen en uitloggen', () => {
  it('juiste gegevens: 303 en een sessiecookie met HttpOnly, SameSite=Lax en Path=/portaal', async () => {
    const { j, resp } = await login('Eva@Acme.nl', WACHTWOORD_A);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/');
    const cookie = j.ruw.find((c) => c.startsWith('portaal_sessie='))!;
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.match(cookie, /Path=\/portaal/i);
    assert.doesNotMatch(cookie, /Secure/i); // cookieSecure: false in tests
    const [g] = await db.query<{ laatst_ingelogd_op: unknown }>(
      'select laatst_ingelogd_op from client_users where id = $1',
      [evaId],
    );
    assert.ok(g?.laatst_ingelogd_op);
  });

  it('met cookieSecure krijgt de cookie Secure', async () => {
    const a = maakPortaalApp(deps({ cookieSecure: true }));
    const { j } = await login('eva@acme.nl', WACHTWOORD_A, { a });
    assert.match(j.ruw.find((c) => c.startsWith('portaal_sessie='))!, /Secure/);
  });

  it('fout wachtwoord en onbekend adres geven dezelfde melding (401)', async () => {
    const fout = await login('eva@acme.nl', 'verkeerd-wachtwoord');
    const onbekend = await login('niemand@acme.nl', 'verkeerd-wachtwoord');
    assert.equal(fout.resp.status, 401);
    assert.equal(onbekend.resp.status, 401);
    const m1 = (await fout.resp.text()).match(/<p class="melding fout">([^<]+)<\/p>/)?.[1];
    const m2 = (await onbekend.resp.text()).match(/<p class="melding fout">([^<]+)<\/p>/)?.[1];
    assert.ok(m1);
    assert.equal(m1, m2);
    assert.ok(!fout.j.cookies.has('portaal_sessie'));
  });

  it('login zonder CSRF-token wordt geweigerd (403)', async () => {
    const j = jar();
    await get('/portaal/login', j);
    const resp = await post('/portaal/login', { csrf: 'x', email: 'eva@acme.nl', wachtwoord: WACHTWOORD_A }, j);
    assert.equal(resp.status, 403);
    assert.ok(!j.cookies.has('portaal_sessie'));
  });

  it('brute force per IP: na 5 fouten vanaf één IP is ook het juiste wachtwoord geblokkeerd (429)', async () => {
    for (let i = 0; i < 5; i++) {
      const { resp } = await login(`gok${i}@acme.nl`, 'fout-fout-fout', { ip: '203.0.113.5' });
      assert.equal(resp.status, 401);
    }
    const { resp } = await login('eva@acme.nl', WACHTWOORD_A, { ip: '203.0.113.5' });
    assert.equal(resp.status, 429);
    assert.match(await resp.text(), /Te veel/);
    // Vanaf een ander IP lukt het gewoon.
    assert.equal((await login('eva@acme.nl', WACHTWOORD_A, { ip: '203.0.113.6' })).resp.status, 303);
  });

  it('brute force per e-mailadres: 5 fouten vanaf verschillende IPs blokkeren dat adres', async () => {
    for (let i = 0; i < 5; i++) {
      await login('eva@acme.nl', 'fout-fout-fout', { ip: `203.0.113.${10 + i}` });
    }
    const { resp } = await login('EVA@acme.nl', WACHTWOORD_A, { ip: '203.0.113.99' });
    assert.equal(resp.status, 429);
    // Een andere gebruiker heeft er geen last van.
    assert.equal((await login('bob@bolt.nl', WACHTWOORD_B, { ip: '203.0.113.98' })).resp.status, 303);
  });

  it('zonder sessie: pagina’s sturen door naar de login, POSTs wijzigen niets', async () => {
    const d = await draft(accA, 'Lisa');
    const resp = await get('/portaal/', jar());
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/login');
    const p = await post('/portaal/acties/goedkeuren', { csrf: 'x', actieId: d.id }, jar());
    assert.equal(p.status, 303);
    assert.equal(await status(d.id), 'draft');
  });

  it('uitloggen vereist het CSRF-token en verwijdert de sessie uit de database', async () => {
    const { j, csrf } = await ingelogd();
    assert.equal((await post('/portaal/logout', { csrf: 'fout' }, j)).status, 403);
    assert.equal((await get('/portaal/', j)).status, 200);
    const resp = await post('/portaal/logout', { csrf }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/login');
    const [t] = await db.query<{ n: number }>('select count(*)::int as n from portal_sessions');
    assert.equal(t?.n, 0);
    assert.equal((await get('/portaal/', j)).status, 303);
  });

  it('sessies overleven een herstart (nieuwe app op dezelfde database)', async () => {
    const { j } = await ingelogd();
    const herstart = maakPortaalApp(deps());
    assert.equal((await get('/portaal/', j, herstart)).status, 200);
  });

  it('een verlopen sessie (na 12 uur) wordt geweigerd', async () => {
    const { j } = await ingelogd();
    nu = new Date(NU.getTime() + 12 * UUR + 1000);
    const resp = await get('/portaal/', j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/login');
  });

  it('een gedeactiveerde gebruiker kan niet inloggen en zijn open sessie werkt niet meer', async () => {
    const { j } = await ingelogd();
    await deactiveerGebruiker(db, klantA, evaId, klok);
    assert.equal((await get('/portaal/', j)).status, 303);
    const { resp } = await login('eva@acme.nl', WACHTWOORD_A);
    assert.equal(resp.status, 401);
  });

  it('ook een sessie die nog in de database staat werkt niet als de gebruiker inactief is', async () => {
    const { j } = await ingelogd();
    await db.query('update client_users set actief = false where id = $1', [evaId]);
    assert.equal((await get('/portaal/', j)).status, 303);
  });
});

// -- concepten -------------------------------------------------------------

describe('portaal: concepten', () => {
  it('toont de open concepten van alle accounts van de eigen klant, met lead, account, stap en tekst', async () => {
    await draft(accA, 'Lisa', 'Hoi Lisa, mooi bericht over jullie groei.');
    await draft(accA2, 'Mark');
    await draft(accB, 'Geheim');
    await startSequentie(db, {
      accountId: accA,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead uit zoekactie',
      },
      teksten: { invite: 'Hoi Sven', bericht: 'Dank Sven', opvolging: 'Reminder Sven' },
    });
    const { j } = await ingelogd();
    const html = await (await get('/portaal/', j)).text();
    assert.match(html, /Acme B\.V\./);
    assert.match(html, /Lisa/);
    assert.match(html, /Salesdirecteur/);
    assert.match(html, /Lisa BV/);
    assert.match(html, /https:\/\/www\.linkedin\.com\/in\/lisa\//);
    assert.match(html, /Hoi Lisa, mooi bericht over jullie groei\./);
    assert.match(html, /Eva de Vries/);
    assert.match(html, /Adam Acme/);
    assert.match(html, /Connectieverzoek/);
    assert.match(html, /Stap 1 van 3/);
    assert.doesNotMatch(html, /Geheim/);
    assert.doesNotMatch(html, /Bob Bolt/);
    // Navigatie
    assert.match(html, /href="\/portaal\/resultaten"/);
    assert.match(html, /Uitloggen/);
  });

  it('goedkeuren zet de actie op approved met goedgekeurd_door = klant:<e-mail>', async () => {
    const d = await draft(accA, 'Lisa');
    const { j, csrf } = await ingelogd();
    const resp = await post('/portaal/acties/goedkeuren', { csrf, actieId: d.id }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/');
    const na = await vindActie(db, d.id);
    assert.equal(na?.status, 'approved');
    assert.equal(na?.goedgekeurdDoor, 'klant:eva@acme.nl');
    assert.match(await (await get('/portaal/', j)).text(), /Concept goedgekeurd/);
  });

  it('goedkeuren zonder of met een fout CSRF-token: 403 en niets gewijzigd', async () => {
    const d = await draft(accA, 'Lisa');
    const { j } = await ingelogd();
    assert.equal((await post('/portaal/acties/goedkeuren', { actieId: d.id }, j)).status, 403);
    const bob = await ingelogd('bob@bolt.nl', WACHTWOORD_B);
    // CSRF-token van een andere sessie telt niet.
    assert.equal((await post('/portaal/acties/goedkeuren', { csrf: bob.csrf, actieId: d.id }, j)).status, 403);
    assert.equal(await status(d.id), 'draft');
  });

  it('afwijzen vereist een reden; met reden wordt de actie rejected en afgewezen_door gezet', async () => {
    const d = await draft(accA, 'Lisa');
    const { j, csrf } = await ingelogd();
    await post('/portaal/acties/afwijzen', { csrf, actieId: d.id, reden: '  ' }, j);
    assert.equal(await status(d.id), 'draft');
    assert.match(await (await get('/portaal/', j)).text(), /Reden voor afwijzen is verplicht/);
    await post('/portaal/acties/afwijzen', { csrf, actieId: d.id, reden: 'Geen doelgroep' }, j);
    const na = await vindActie(db, d.id);
    assert.equal(na?.status, 'rejected');
    assert.equal(na?.reden, 'Geen doelgroep');
    assert.equal(na?.afgewezenDoor, 'klant:eva@acme.nl');
  });

  it('afwijzen van een sequentiestap stopt de sequentie, net als in de admin', async () => {
    const uit = await startSequentie(db, {
      accountId: accA,
      lead: {
        providerId: 'ACo-sven',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead uit zoekactie',
      },
      teksten: { invite: 'Hoi Sven', bericht: 'Dank Sven', opvolging: 'Reminder Sven' },
    });
    const { j, csrf } = await ingelogd();
    await post('/portaal/acties/afwijzen', { csrf, actieId: uit.invite!.id, reden: 'te formeel' }, j);
    const [seq] = await db.query<{ status: string; stop_reden: string }>(
      'select status::text as status, stop_reden from sequences where id = $1',
      [uit.sequentie.id],
    );
    assert.equal(seq?.status, 'gestopt');
    assert.equal(seq?.stop_reden, 'afgewezen bij goedkeuring: te formeel');
  });

  it('alles goedkeuren keurt alle getoonde concepten van de klant goed', async () => {
    const a = await draft(accA, 'Lisa');
    const b = await draft(accA2, 'Mark');
    const anders = await draft(accB, 'Geheim');
    const { j } = await ingelogd();
    const html = await (await get('/portaal/', j)).text();
    const csrf = csrfUit(html);
    const ids = [...html.matchAll(/name="ids" value="([^"]+)"/g)].map((m) => m[1]!);
    assert.deepEqual(ids.sort(), [a.id, b.id].sort());
    const resp = await post('/portaal/acties/goedkeuren-alles', { csrf, ids }, j);
    assert.equal(resp.status, 303);
    for (const id of [a.id, b.id]) {
      const na = await vindActie(db, id);
      assert.equal(na?.status, 'approved');
      assert.equal(na?.goedgekeurdDoor, 'klant:eva@acme.nl');
    }
    assert.equal(await status(anders.id), 'draft');
    assert.match(await (await get('/portaal/', j)).text(), /2 concepten goedgekeurd/);
  });
});

// -- afscherming tussen klanten (SPEC §14.1) -------------------------------

describe('portaal: afscherming tussen klant A en klant B', () => {
  it('goedkeuren van een actie van klant B: 404 en niets gewijzigd', async () => {
    const vanB = await draft(accB, 'Geheim');
    const { j, csrf } = await ingelogd();
    const resp = await post('/portaal/acties/goedkeuren', { csrf, actieId: vanB.id }, j);
    assert.equal(resp.status, 404);
    const na = await vindActie(db, vanB.id);
    assert.equal(na?.status, 'draft');
    assert.equal(na?.goedgekeurdDoor, null);
  });

  it('afwijzen van een actie van klant B: 404 en niets gewijzigd', async () => {
    const vanB = await draft(accB, 'Geheim');
    const { j, csrf } = await ingelogd();
    const resp = await post('/portaal/acties/afwijzen', { csrf, actieId: vanB.id, reden: 'weg ermee' }, j);
    assert.equal(resp.status, 404);
    const na = await vindActie(db, vanB.id);
    assert.equal(na?.status, 'draft');
    assert.equal(na?.afgewezenDoor, null);
  });

  it('alles goedkeuren met een id van klant B ertussen: 404 en ook de eigen concepten blijven open', async () => {
    const eigen = await draft(accA, 'Lisa');
    const vanB = await draft(accB, 'Geheim');
    const { j, csrf } = await ingelogd();
    const resp = await post('/portaal/acties/goedkeuren-alles', { csrf, ids: [eigen.id, vanB.id] }, j);
    assert.equal(resp.status, 404);
    assert.equal(await status(eigen.id), 'draft');
    assert.equal(await status(vanB.id), 'draft');
  });

  it('onzin-id of een eigen actie die geen concept meer is: 404', async () => {
    const eigen = await draft(accA, 'Lisa');
    await db.query("update actions set status = 'onzeker' where id = $1", [eigen.id]);
    const { j, csrf } = await ingelogd();
    assert.equal((await post('/portaal/acties/goedkeuren', { csrf, actieId: 'geen-uuid' }, j)).status, 404);
    assert.equal(
      (await post('/portaal/acties/goedkeuren', { csrf, actieId: '00000000-0000-0000-0000-000000000000' }, j)).status,
      404,
    );
    assert.equal((await post('/portaal/acties/goedkeuren', { csrf, actieId: eigen.id }, j)).status, 404);
    assert.equal(await status(eigen.id), 'onzeker');
  });

  it('klant B ziet de concepten en accounts van klant A niet', async () => {
    await draft(accA, 'Lisa');
    await draft(accB, 'Bea');
    const { j } = await ingelogd('bob@bolt.nl', WACHTWOORD_B);
    const html = await (await get('/portaal/', j)).text();
    assert.match(html, /Bea/);
    assert.doesNotMatch(html, /Lisa/);
    assert.doesNotMatch(html, /Acme/);
    const res = await (await get('/portaal/resultaten', j)).text();
    assert.match(res, /Bob Bolt/);
    assert.doesNotMatch(res, /Eva de Vries/);
    assert.doesNotMatch(res, /Adam Acme/);
  });

  it('opnieuw koppelen van een account van klant B: 404 en geen Unipile-aanroep', async () => {
    await werkAccountStatusBij(db, accB, 'CREDENTIALS');
    const { j, csrf } = await ingelogd();
    const resp = await post(`/portaal/accounts/${accB}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(resp.status, 404);
    assert.equal(fake.aanroepen.length, 0);
  });
});

// -- resultaten ------------------------------------------------------------

describe('portaal: resultaten', () => {
  it('toont per account de stand en per week verstuurd, geaccepteerd en gereageerd', async () => {
    await db.query(
      `insert into actions(account_id, type, payload, status, uitgevoerd_op)
       values ($1, 'invite', '{}'::jsonb, 'done', '2026-10-06T09:00:00Z'),
              ($1, 'invite', '{}'::jsonb, 'done', '2026-10-06T10:00:00Z')`,
      [accA],
    );
    await db.query(
      `insert into events(bron, type, account_id, payload, ontvangen_op)
       values ('gateway', 'acceptatie', $1, '{}'::jsonb, '2026-10-06T12:00:00Z')`,
      [accA],
    );
    const { j } = await ingelogd();
    const resp = await get('/portaal/resultaten', j);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /Eva de Vries/);
    assert.match(html, /Adam Acme/);
    assert.match(html, /opbouw/i);
    assert.match(html, /nog niet gekoppeld/i);
    assert.match(html, /<tr class="week"><td>5 okt<\/td><td>2<\/td><td>1<\/td><td>0<\/td><\/tr>/);
  });

  it('toont "in afkoeling" en "opnieuw koppelen nodig" met knop', async () => {
    await db.query("update accounts set afkoeling_tot = '2026-10-08T10:00:00Z' where id = $1", [accA]);
    const { j } = await ingelogd();
    let html = await (await get('/portaal/resultaten', j)).text();
    assert.match(html, /in afkoeling/i);
    await db.query('update accounts set afkoeling_tot = null where id = $1', [accA]);
    await werkAccountStatusBij(db, accA, 'CREDENTIALS');
    html = await (await get('/portaal/resultaten', j)).text();
    assert.match(html, /opnieuw koppelen nodig/i);
    assert.match(html, new RegExp(`/portaal/accounts/${accA}/opnieuw-koppelen`));
  });

  it('opnieuw koppelen bij CREDENTIALS maakt een reconnect-link en stuurt door (303)', async () => {
    await werkAccountStatusBij(db, accA, 'CREDENTIALS');
    fake.antwoord('POST', LINK, { status: 200, body: { object: 'HostedAuthUrl', url: UNIPILE_URL } });
    const { j, csrf } = await ingelogd();
    const resp = await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), UNIPILE_URL);
    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['type'], 'reconnect');
    assert.equal(body['reconnect_account'], 'uni-a');
  });

  it('nog niet gekoppeld account: geen knop, geen nieuwe uitnodiging; melding "Vraag MARKaaS…"', async () => {
    const { j, csrf } = await ingelogd();
    const html = await (await get('/portaal/resultaten', j)).text();
    assert.doesNotMatch(html, new RegExp(`/portaal/accounts/${accA2}/opnieuw-koppelen`));
    assert.match(html, /Vraag MARKaaS om een nieuwe koppellink voor de accounteigenaar/);
    const resp = await post(`/portaal/accounts/${accA2}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/resultaten');
    assert.match(await (await get('/portaal/resultaten', j)).text(), /Vraag MARKaaS om een nieuwe koppellink/);
    const [t] = await db.query<{ n: number }>('select count(*)::int as n from koppel_uitnodigingen where account_id = $1', [accA2]);
    assert.equal(t!.n, 0);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('rem: maximaal één reconnect-link per account per 5 minuten', async () => {
    await werkAccountStatusBij(db, accA, 'CREDENTIALS');
    fake.antwoord('POST', LINK, { status: 200, body: { object: 'HostedAuthUrl', url: UNIPILE_URL } });
    const { j, csrf } = await ingelogd();
    assert.equal((await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j)).headers.get('location'), UNIPILE_URL);
    nu = new Date(NU.getTime() + 4 * 60 * 1000);
    const tweede = await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(tweede.headers.get('location'), '/portaal/resultaten');
    assert.match(await (await get('/portaal/resultaten', j)).text(), /over 5 minuten opnieuw/);
    assert.equal(fake.aanroepen.length, 1);
    nu = new Date(NU.getTime() + 6 * 60 * 1000);
    assert.equal((await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j)).headers.get('location'), UNIPILE_URL);
    assert.equal(fake.aanroepen.length, 2);
  });

  it('rem telt niet als Unipile faalt: direct opnieuw proberen kan', async () => {
    await werkAccountStatusBij(db, accA, 'CREDENTIALS');
    let keer = 0;
    fake.antwoord('POST', LINK, () =>
      ++keer === 1 ? { status: 503, body: {} } : { status: 200, body: { object: 'HostedAuthUrl', url: UNIPILE_URL } },
    );
    const { j, csrf } = await ingelogd();
    assert.equal((await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j)).headers.get('location'), '/portaal/resultaten');
    assert.equal((await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j)).headers.get('location'), UNIPILE_URL);
  });

  it('opnieuw koppelen van een werkend account: melding, geen link', async () => {
    const { j, csrf } = await ingelogd();
    const resp = await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/resultaten');
    assert.equal(fake.aanroepen.length, 0);
    assert.match(await (await get('/portaal/resultaten', j)).text(), /niet nodig/);
  });

  it('Unipile tijdelijk niet beschikbaar: nette melding, geen 500', async () => {
    await werkAccountStatusBij(db, accA, 'CREDENTIALS');
    fake.antwoord('POST', LINK, { status: 429, headers: { 'Retry-After': '30' }, body: {} });
    const { j, csrf } = await ingelogd();
    const resp = await post(`/portaal/accounts/${accA}/opnieuw-koppelen`, { csrf }, j);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/portaal/resultaten');
    assert.match(await (await get('/portaal/resultaten', j)).text(), /tijdelijk niet beschikbaar/);
  });
});


describe('portaal: foutmeldingen (alleen bekende fouten letterlijk)', () => {
  it('te lange tekst (bekende invoerfout) wordt letterlijk getoond', async () => {
    const d = await draft(accA, 'Lang', 'x'.repeat(400));
    const { j, csrf } = await ingelogd();
    await post('/portaal/acties/goedkeuren', { csrf, actieId: d.id }, j);
    assert.match(await (await get('/portaal/', j)).text(), /Tekst is 400 tekens/);
    assert.equal(await status(d.id), 'draft');
  });

  it('onverwachte fout: algemene NL-melding, geen interne details; details in de log', async () => {
    const d = await draft(accA, 'Kapot');
    const regels: string[] = [];
    const kapotteDb: Backend = {
      ...db,
      exec: (sql) => db.exec(sql),
      close: () => db.close(),
      transaction: (fn) => db.transaction(fn),
      query: async (sql, params) => {
        if (/goedgekeurd_door = \$2/.test(sql)) throw new Error('relation "geheim_intern" bestaat niet');
        return await db.query(sql, params);
      },
    };
    const a = maakPortaalApp(
      deps({
        db: kapotteDb,
        logger: {
          debug: () => {},
          info: () => {},
          warn: (b: string, v?: Record<string, unknown>) => regels.push(`${b} ${JSON.stringify(v ?? {})}`),
          error: () => {},
        } as never,
      }),
    );
    const { j } = await login('eva@acme.nl', WACHTWOORD_A, { a });
    const csrf = csrfUit(await (await get('/portaal/', j, a)).text());
    await post('/portaal/acties/goedkeuren', { csrf, actieId: d.id }, j, { a });
    const html = await (await get('/portaal/', j, a)).text();
    assert.match(html, /Er ging iets mis; probeer het opnieuw of neem contact op met MARKaaS\./);
    assert.doesNotMatch(html, /geheim_intern/);
    assert.ok(regels.some((r) => r.includes('geheim_intern')));
  });
});

describe('portaal: CSRF op elke POST, geen state-wijzigende GET (SameSite=Lax)', () => {
  it('alle POST-routes weigeren een verzoek zonder CSRF-token met 403', async () => {
    const posts = [...new Set(app.routes.filter((r) => r.method === 'POST').map((r) => r.path))];
    assert.ok(posts.length >= 8, `verwacht alle POST-routes, kreeg ${posts.join(', ')}`);
    const r = await nodigGebruikerUit(db, { clientId: klantA, naam: 'Nieuw', email: 'nieuw@acme.nl' }, { klok, geldigDagen: 7 });
    const { j } = await ingelogd();
    for (const pad of posts) {
      const concreet = pad.replace(':token', r.uitnodiging.token).replace(':accountId', accA);
      const resp = await post(concreet, { email: 'eva@acme.nl', wachtwoord: WACHTWOORD_A }, j);
      assert.equal(resp.status, 403, pad);
    }
  });

  it('de GET-routes zijn alleen-lezen pagina\'s (lijst bijhouden bij een nieuwe GET)', () => {
    const gets = [...new Set(app.routes.filter((r) => r.method === 'GET').map((r) => r.path))].sort();
    assert.deepEqual(gets, [
      '/portaal',
      '/portaal/',
      '/portaal/abonnement',
      '/portaal/abonnement/geannuleerd',
      '/portaal/abonnement/gelukt',
      '/portaal/login',
      '/portaal/resultaten',
      '/portaal/uitnodiging/:token',
    ]);
  });

  it('terugkeer van Stripe (cross-site GET met Lax-cookie) toont de pagina, niet de login', async () => {
    const { j } = await ingelogd();
    const resp = await get('/portaal/abonnement/gelukt', j);
    assert.equal(resp.status, 200);
  });
});
