import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient, vindClientBijSlug } from '../register/clients.ts';
import { vindGeldigeUitnodiging } from '../register/uitnodiging.ts';
import {
  gebruikUitnodiging,
  nodigGebruikerUit,
  vindGeldigeGebruikerUitnodiging,
} from '../portaal/gebruikers.ts';
import { maakPortaalSessie, vindPortaalSessie } from '../portaal/sessies.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakAdminApp, type AdminDeps } from './server.ts';
import { maakWachtwoordHash } from './wachtwoord.ts';

const WACHTWOORD = 'geheimpje123';
let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let wachtwoordHash: string;
let accountId: string;
let app: ReturnType<typeof maakAdminApp>;
let deps: AdminDeps;
const NU = new Date('2026-10-06T10:00:00Z');

before(async () => {
  const op = await verseDatabaseMetMigraties();
  db = op.db;
  close = op.close;
  limieten = await laadLimieten();
  wachtwoordHash = await maakWachtwoordHash(WACHTWOORD);
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Markaas', slug: 'markaas-ui' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'uni-r');
  deps = {
    db,
    limieten,
    klok: vasteKlok(NU),
    wachtwoordHash,
    cookieSecure: false, // in tests draaien we niet onder TLS
    publicBaseUrl: 'https://gateway.test',
    koppeluitnodigingGeldigDagen: 7,
  };
  app = maakAdminApp(deps);
});

interface CookieJar {
  cookies: Map<string, string>;
}

function nieuweJar(): CookieJar {
  return { cookies: new Map() };
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function vangCookiesOp(resp: Response, jar: CookieJar): void {
  const headers = resp.headers.getSetCookie
    ? resp.headers.getSetCookie()
    : resp.headers.get('set-cookie')?.split(/,(?=\s*\w+=)/) ?? [];
  for (const header of headers) {
    const stuk = header.split(';')[0] ?? '';
    const idx = stuk.indexOf('=');
    if (idx < 0) continue;
    const naam = stuk.slice(0, idx).trim();
    const waarde = stuk.slice(idx + 1).trim();
    if (!naam) continue;
    if (waarde === '' || waarde === 'deleted') jar.cookies.delete(naam);
    else jar.cookies.set(naam, waarde);
  }
}

async function get(pad: string, jar: CookieJar): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar.cookies.size > 0) headers['cookie'] = cookieHeader(jar);
  const resp = await app.request(pad, { method: 'GET', headers }, { env: {} } as never);
  vangCookiesOp(resp, jar);
  return resp;
}

async function post(
  pad: string,
  body: Record<string, string | string[]>,
  jar: CookieJar,
  opts: { ip?: string } = {},
): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (Array.isArray(v)) v.forEach((x) => form.append(k, x));
    else form.append(k, v);
  }
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (jar.cookies.size > 0) headers['cookie'] = cookieHeader(jar);
  if (opts.ip) headers['x-forwarded-for'] = opts.ip;
  const resp = await app.request(
    pad,
    { method: 'POST', headers, body: form.toString() },
    { env: {} } as never,
  );
  vangCookiesOp(resp, jar);
  return resp;
}

async function logIn(jar: CookieJar, opts: { ip?: string } = {}): Promise<void> {
  const resp = await get('/admin/login', jar);
  assert.equal(resp.status, 200);
  const html = await resp.text();
  const csrf = csrfUit(html);
  const login = await post('/admin/login', { wachtwoord: WACHTWOORD, csrf }, jar, opts);
  assert.equal(login.status, 303, `verwachtte redirect na login, kreeg ${login.status}`);
}

function csrfUit(html: string): string {
  const m = html.match(/name="csrf"\s+value="([^"]+)"/);
  if (!m) throw new Error('geen csrf-token in formulier');
  return m[1]!;
}

function ontvangerVelden(
  overschrijf: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ontvanger_naam: 'Nina Jansen',
    ontvanger_functie: 'Marketing manager',
    ontvanger_bedrijf: 'Acme NV',
    ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
    waarom: 'Afkomstig uit zoekactie X-123.',
    ...overschrijf,
  };
}

async function maakDraft(payload: Record<string, unknown> = {}): Promise<string> {
  const actie = await maakActie(db, {
    accountId,
    type: 'invite',
    payload: { providerId: 'ACo-abc', ...ontvangerVelden(), ...payload },
  });
  return actie.id;
}

describe('authenticatie', () => {
  it('redirect niet-ingelogd naar /admin/login', async () => {
    const jar = nieuweJar();
    const resp = await get('/admin/', jar);
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/admin/login');
  });

  it('login-formulier bevat een csrf-token', async () => {
    const jar = nieuweJar();
    const resp = await get('/admin/login', jar);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    assert.match(html, /name="csrf"/);
    assert.ok(jar.cookies.get('admin_csrf'));
  });

  it('weigert verkeerde wachtwoorden met NL-melding (zonder te lekken dat de gebruiker bestaat)', async () => {
    const jar = nieuweJar();
    const pre = await get('/admin/login', jar);
    const csrf = csrfUit(await pre.text());
    const resp = await post('/admin/login', { wachtwoord: 'fout', csrf }, jar);
    assert.equal(resp.status, 401);
    const html = await resp.text();
    assert.match(html, /Onjuist wachtwoord/);
    assert.doesNotMatch(html, /gebruiker/i);
  });

  it('weigert zonder csrf-token', async () => {
    const jar = nieuweJar();
    await get('/admin/login', jar);
    const resp = await post('/admin/login', { wachtwoord: WACHTWOORD, csrf: 'fout' }, jar);
    assert.equal(resp.status, 403);
  });

  it('zet sessiecookie als HttpOnly + SameSite=Strict na succesvolle login', async () => {
    const jar = nieuweJar();
    const pre = await get('/admin/login', jar);
    const csrf = csrfUit(await pre.text());
    const resp = await post('/admin/login', { wachtwoord: WACHTWOORD, csrf }, jar);
    assert.equal(resp.status, 303);
    const setCookies = resp.headers.getSetCookie
      ? resp.headers.getSetCookie()
      : [resp.headers.get('set-cookie') ?? ''];
    const sessieHeader = setCookies.find((c) => c.startsWith('admin_sessie='));
    assert.ok(sessieHeader, 'sessiecookie ontbreekt');
    assert.match(sessieHeader, /HttpOnly/i);
    assert.match(sessieHeader, /SameSite=Strict/i);
  });

  it('blokkeert 15 minuten na 5 foute pogingen op dezelfde IP', async () => {
    const jar = nieuweJar();
    const pre = await get('/admin/login', jar);
    const csrf = csrfUit(await pre.text());
    for (let i = 0; i < 5; i++) {
      const r = await post(
        '/admin/login',
        { wachtwoord: 'fout', csrf },
        jar,
        { ip: '9.9.9.9' },
      );
      assert.ok(r.status === 401 || r.status === 429);
    }
    // Zelfs met het juiste wachtwoord blijft 'ie geblokkeerd.
    const pre2 = await get('/admin/login', jar);
    const csrf2 = csrfUit(await pre2.text());
    const geblokkeerd = await post(
      '/admin/login',
      { wachtwoord: WACHTWOORD, csrf: csrf2 },
      jar,
      { ip: '9.9.9.9' },
    );
    assert.equal(geblokkeerd.status, 429);
    const html = await geblokkeerd.text();
    assert.match(html, /Te veel foute pogingen/i);
  });

  it('logout verwijdert de sessie en redirect naar login', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const uit = await post('/admin/logout', { csrf }, jar);
    assert.equal(uit.status, 303);
    const na = await get('/admin/', jar);
    assert.equal(na.status, 303);
  });
});

describe('overzicht', () => {
  it('toont concepten met naam/functie/bedrijf/klikbare LinkedIn-link, waarom, provider-id klein, en budget', async () => {
    await maakDraft({ providerId: 'ACo-xyz', message: 'Welkom!', _skill: 'leadworker' });
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    assert.equal(resp.status, 200);
    const html = await resp.text();
    // Leesbare ontvanger-weergave.
    assert.match(html, /Nina Jansen/);
    assert.match(html, /Marketing manager/);
    assert.match(html, /Acme NV/);
    assert.match(
      html,
      /<a href="https:\/\/www\.linkedin\.com\/in\/nina-jansen\/"[^>]*target="_blank"/,
      'LinkedIn-link moet klikbaar en in een nieuw tabblad openen',
    );
    // Provider-id staat klein onder de ontvanger (in <small>).
    assert.match(html, /<small>id: ACo-xyz<\/small>/);
    // Waarom-blok.
    assert.match(html, /class="waarom"/);
    assert.match(html, /zoekactie X-123/);
    // Overige.
    assert.match(html, /Welkom!/);
    assert.match(html, /leadworker/);
    assert.match(html, /Markaas/);
    assert.match(html, /dag 0\/10/); // salesnav_core invite 20/dag * 0.5
  });

  it('toont datum in Europe/Amsterdam, formaat "1 okt, 13:07"', async () => {
    // Standaard NU = 2026-10-06T10:00:00Z, dus aangemaakt_op valt rond dat moment.
    // We maken de draft en lezen pas daarna, zodat beide tegen vasteKlok klokken.
    await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    const html = await resp.text();
    // De aangemaakt_op krijgt een PGlite default now(); vorm van de datum is
    // belangrijker dan de exacte waarde. Verwacht: "<dag> <mnd>, HH:MM".
    assert.match(
      html,
      /\d{1,2} (jan|feb|mrt|apr|mei|jun|jul|aug|sep|okt|nov|dec), \d{2}:\d{2}/,
      'datum moet "1 okt, 13:07"-formaat gebruiken',
    );
  });

  it('toont de teken-teller met de limiet uit limits.json en schakelt Goedkeuren uit boven de limiet', async () => {
    const teLang = 'x'.repeat(limieten.tekst_max_tekens.invite + 50);
    await maakDraft({ providerId: 'ACo-xyz', message: teLang });
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    const html = await resp.text();
    assert.match(html, /class="teken-teller over"/);
    assert.match(html, /boven de limiet/i);
    assert.match(
      html,
      /<button type="submit" disabled>Goedkeuren<\/button>/,
      'Goedkeuren-knop moet uitgeschakeld zijn boven de limiet',
    );
    // En de tekst-teller bevat de limiet 300.
    assert.match(html, /\/300 tekens/);
  });

  it('neemt de limiet per actietype uit limits.json (message = 8000)', async () => {
    await db.query(
      `insert into actions(account_id, type, payload, status) values
       ($1, 'message'::action_type, $2::jsonb, 'draft'::action_status)`,
      [
        accountId,
        JSON.stringify({
          chatId: 'C-leo',
          tekst: 'Dag Leo',
          ...ontvangerVelden(),
        }),
      ],
    );
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    const html = await resp.text();
    assert.match(html, /data-maxtekens="8000"/);
    assert.match(html, /\/8000 tekens/);
  });

  it('voegt een inline tekenteller-script toe zodat het label en de knop live reageren', async () => {
    await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    const html = await resp.text();
    assert.match(html, /<script>[\s\S]*data-maxtekens[\s\S]*<\/script>/);
    assert.doesNotMatch(html, /\bimport\b/, 'script moet puur vanilla JS zijn');
  });

  it('toont "Stap N van 3 · sequentie gestart op …" bij een draft uit een sequentie', async () => {
    const { startSequentie } = await import('../sequences/motor.ts');
    await startSequentie(db, {
      accountId,
      lead: {
        providerId: 'ACo-sv',
        naam: 'Sven',
        functie: 'CTO',
        bedrijf: 'Flux',
        linkedinUrl: 'https://www.linkedin.com/in/sven/',
        waarom: 'Lead',
      },
      teksten: { invite: 'Hoi', bericht: 'Dank', opvolging: 'Reminder' },
    });
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await get('/admin/', jar);
    const html = await resp.text();
    assert.match(html, /Stap 1 van 3/);
    assert.match(html, /sequentie gestart op/i);
  });
});

describe('goedkeuren via de UI', () => {
  it('keurt een actie goed en zet goedgekeurd_door = rubert', async () => {
    const actieId = await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const resp = await post(
      '/admin/acties/goedkeuren',
      { csrf, actieId },
      jar,
    );
    assert.equal(resp.status, 303);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'approved');
    assert.equal(actie?.goedgekeurdDoor, 'rubert');
    assert.equal(actie?.goedgekeurdOp?.toISOString(), NU.toISOString());
  });

  it('werkt de tekst bij vóór goedkeuren', async () => {
    const actieId = await maakDraft({ providerId: 'A', message: 'oud' });
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    await post(
      '/admin/acties/goedkeuren',
      { csrf, actieId, nieuweTekst: 'nieuwe boodschap' },
      jar,
    );
    const actie = await vindActie(db, actieId);
    assert.equal((actie?.payload as { message?: string })?.message, 'nieuwe boodschap');
    assert.equal(actie?.goedgekeurdDoor, 'rubert');
  });

  it('keurt een batch geselecteerde acties in één keer goed', async () => {
    const a = await maakDraft({ providerId: 'A' });
    const b = await maakDraft({ providerId: 'B' });
    const c = await maakDraft({ providerId: 'C' });
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const resp = await post(
      '/admin/acties/goedkeuren-batch',
      { csrf, batch: [a, b] },
      jar,
    );
    assert.equal(resp.status, 303);
    assert.equal((await vindActie(db, a))?.status, 'approved');
    assert.equal((await vindActie(db, b))?.status, 'approved');
    assert.equal((await vindActie(db, c))?.status, 'draft');
  });

  it('wijst een actie af met reden', async () => {
    const actieId = await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const resp = await post(
      '/admin/acties/afwijzen',
      { csrf, actieId, reden: 'niet relevant' },
      jar,
    );
    assert.equal(resp.status, 303);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'rejected');
    assert.equal(actie?.reden, 'niet relevant');
  });

  it('weigert server-side goedkeuren wanneer de nieuwe tekst over de limiet gaat', async () => {
    const actieId = await maakDraft({ message: 'kort' });
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const teLang = 'x'.repeat(limieten.tekst_max_tekens.invite + 1);
    const resp = await post(
      '/admin/acties/goedkeuren',
      { csrf, actieId, nieuweTekst: teLang },
      jar,
    );
    assert.equal(resp.status, 303);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'draft', 'actie blijft draft bij te lange tekst');
    assert.equal(
      (actie?.payload as { message?: string })?.message,
      'kort',
      'tekst mag niet aangepast zijn',
    );
    // De flash-cookie bevat de foutmelding.
    const na = await get('/admin/', jar);
    const nahtml = await na.text();
    assert.match(nahtml, /maximum voor invite is 300/);
  });

  it('weigert goedkeuren zonder csrf-token (403)', async () => {
    const actieId = await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const resp = await post(
      '/admin/acties/goedkeuren',
      { csrf: 'fout', actieId },
      jar,
    );
    assert.equal(resp.status, 403);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'draft');
    assert.equal(actie?.goedgekeurdDoor, null);
  });

  it('weigert goedkeuren zonder sessie (redirect naar login)', async () => {
    const actieId = await maakDraft();
    const jar = nieuweJar();
    const resp = await post(
      '/admin/acties/goedkeuren',
      { csrf: 'wat-dan-ook', actieId },
      jar,
    );
    assert.equal(resp.status, 303);
    assert.equal(resp.headers.get('location'), '/admin/login');
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'draft');
  });
});

describe('onzeker-lijst via de UI', () => {
  async function maakOnzeker(): Promise<string> {
    const id = await maakDraft({ providerId: 'A' });
    await db.query(
      `update actions set status = 'onzeker'::action_status, reden = 'time-out' where id = $1`,
      [id],
    );
    return id;
  }

  it('zet een onzeker-actie handmatig op done', async () => {
    const actieId = await maakOnzeker();
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const resp = await post(
      '/admin/acties/onzeker-done',
      { csrf, actieId },
      jar,
    );
    assert.equal(resp.status, 303);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'done');
    assert.equal(actie?.uitgevoerdOp?.toISOString(), NU.toISOString());
  });

  it('kan een onzeker-actie opnieuw op approved zetten (met rubert als goedkeurder)', async () => {
    const actieId = await maakOnzeker();
    const jar = nieuweJar();
    await logIn(jar);
    const overzicht = await get('/admin/', jar);
    const csrf = csrfUit(await overzicht.text());
    const resp = await post(
      '/admin/acties/onzeker-opnieuw',
      { csrf, actieId },
      jar,
    );
    assert.equal(resp.status, 303);
    const actie = await vindActie(db, actieId);
    assert.equal(actie?.status, 'approved');
    assert.equal(actie?.goedgekeurdDoor, 'rubert');
  });
});

describe('klanten en koppellinks (SPEC §14.2)', () => {
  function tokenUit(html: string): string {
    const m = html.match(/https:\/\/gateway\.test\/koppelen\/([A-Za-z0-9_-]{43})/);
    if (!m) throw new Error('geen koppellink in pagina');
    return m[1]!;
  }

  function nieuweKlantVelden(csrf: string, extra: Record<string, string> = {}) {
    return {
      csrf,
      klantNaam: 'Acme B.V.',
      slug: 'acme',
      eigenaarNaam: 'Eva de Vries',
      eigenaarEmail: 'eva@acme.nl',
      abonnement: 'premium_business',
      abonnementVereist: 'ja',
      ...extra,
    };
  }

  it('alle klantenroutes vereisen een sessie', async () => {
    const jar = nieuweJar();
    for (const pad of ['/admin/klanten', '/admin/klanten/nieuw']) {
      const r = await get(pad, jar);
      assert.equal(r.status, 303, pad);
      assert.equal(r.headers.get('location'), '/admin/login');
    }
    const p1 = await post('/admin/klanten/nieuw', nieuweKlantVelden('x'), jar);
    assert.equal(p1.status, 303);
    assert.equal(p1.headers.get('location'), '/admin/login');
    const p2 = await post(`/admin/klanten/${accountId}/koppellink`, { csrf: 'x' }, jar);
    assert.equal(p2.status, 303);
    assert.equal(p2.headers.get('location'), '/admin/login');
    assert.equal(await vindClientBijSlug(db, 'acme'), null);
  });

  it('het overzicht linkt naar Klanten', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const html = await (await get('/admin/', jar)).text();
    assert.match(html, /href="\/admin\/klanten"/);
  });

  it('formulier nieuwe klant toont de abonnementen en het vinkje standaard aan', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const r = await get('/admin/klanten/nieuw', jar);
    assert.equal(r.status, 200);
    const html = await r.text();
    for (const a of ['free', 'premium_career', 'premium_business', 'salesnav_core', 'salesnav_advanced']) {
      assert.match(html, new RegExp(`value="${a}"`));
    }
    assert.match(html, /name="abonnementVereist" value="ja" checked/);
  });

  it('weigert nieuwe klant zonder CSRF (403) en maakt niets aan', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const r = await post('/admin/klanten/nieuw', nieuweKlantVelden('fout-token'), jar);
    assert.equal(r.status, 403);
    assert.equal(await vindClientBijSlug(db, 'acme'), null);
  });

  it('maakt klant + account + koppellink en toont de link eenmalig met voorbeeldmail', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const r = await post('/admin/klanten/nieuw', nieuweKlantVelden(csrfUit(form)), jar);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    const html = await r.text();
    const token = tokenUit(html);
    assert.match(html, /Eva de Vries/);
    assert.match(html, /eva@acme\.nl/);
    assert.match(html, /Beste Eva/);
    const u = await vindGeldigeUitnodiging(db, token, vasteKlok(NU));
    assert.ok(u, 'token uit de pagina is een geldige uitnodiging');
    const client = await vindClientBijSlug(db, 'acme');
    assert.equal(client?.abonnementVereist, true);

    // Daarna nergens meer op te vragen.
    const lijst = await (await get('/admin/klanten', jar)).text();
    assert.ok(!lijst.includes(token), 'token mag niet in de klantenlijst staan');
    assert.match(lijst, /Acme B\.V\./);
    assert.match(lijst, /Eva de Vries/);
    assert.match(lijst, /Nieuwe koppellink/);
  });

  it('bewaart abonnement_vereist = false als het vinkje uit staat', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const velden: Record<string, string> = nieuweKlantVelden(csrfUit(form));
    delete velden['abonnementVereist'];
    const r = await post('/admin/klanten/nieuw', velden, jar);
    assert.equal(r.status, 200);
    assert.equal((await vindClientBijSlug(db, 'acme'))?.abonnementVereist, false);
  });

  it('stelt een slug voor uit de naam als het slugveld leeg is', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const r = await post(
      '/admin/klanten/nieuw',
      nieuweKlantVelden(csrfUit(form), { klantNaam: 'Beta Groep', slug: '' }),
      jar,
    );
    assert.equal(r.status, 200);
    assert.ok(await vindClientBijSlug(db, 'beta-groep'));
  });

  it('dubbele slug: formulier opnieuw met NL-melding (400), ingevulde waarden blijven staan', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const r = await post(
      '/admin/klanten/nieuw',
      nieuweKlantVelden(csrfUit(form), { slug: 'markaas-ui' }),
      jar,
    );
    assert.equal(r.status, 400);
    const html = await r.text();
    assert.match(html, /al in gebruik/);
    assert.match(html, /value="eva@acme\.nl"/);
  });

  it('nieuwe koppellink voor een bestaand niet-gekoppeld account (CSRF verplicht)', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const csrf = csrfUit(form);
    const eerste = tokenUit(await (await post('/admin/klanten/nieuw', nieuweKlantVelden(csrf), jar)).text());
    const u = await vindGeldigeUitnodiging(db, eerste, vasteKlok(NU));
    const nieuwAccountId = u!.accountId;

    const zonder = await post(`/admin/klanten/${nieuwAccountId}/koppellink`, { csrf: 'fout' }, jar);
    assert.equal(zonder.status, 403);

    const r = await post(`/admin/klanten/${nieuwAccountId}/koppellink`, { csrf }, jar);
    assert.equal(r.status, 200);
    const tweede = tokenUit(await r.text());
    assert.notEqual(tweede, eerste);
    assert.equal(await vindGeldigeUitnodiging(db, eerste, vasteKlok(NU)), null);
    assert.ok(await vindGeldigeUitnodiging(db, tweede, vasteKlok(NU)));
  });

  it('weigert een nieuwe koppellink voor een al gekoppeld account met NL-melding', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    const r = await post(`/admin/klanten/${accountId}/koppellink`, { csrf: csrfUit(form) }, jar);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/klanten');
    const lijst = await (await get('/admin/klanten', jar)).text();
    assert.match(lijst, /al gekoppeld/);
  });
});


describe('account toevoegen aan een bestaande klant (SPEC §14.2a)', () => {
  const PAD = '/admin/klanten/markaas-ui/accounts';

  function tokenUit(html: string): string {
    const m = html.match(/https:\/\/gateway\.test\/koppelen\/([A-Za-z0-9_-]{43})/);
    if (!m) throw new Error('geen koppellink in pagina');
    return m[1]!;
  }

  function velden(csrf: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
      csrf,
      eigenaarNaam: 'Tom Baker',
      eigenaarEmail: 'tom@acme.co.uk',
      abonnement: 'salesnav_advanced',
      tijdzone: 'Europe/London',
      andereTijdzone: '',
      ...extra,
    };
  }

  async function detail(jar: CookieJar): Promise<{ html: string; csrf: string }> {
    const r = await get('/admin/klanten/markaas-ui', jar);
    assert.equal(r.status, 200);
    const html = await r.text();
    return { html, csrf: csrfUit(html) };
  }

  async function accountsVanKlant(): Promise<Array<{ eigenaar_naam: string; tijdzone: string }>> {
    return await db.query<{ eigenaar_naam: string; tijdzone: string }>(
      `select a.eigenaar_naam, a.tijdzone from accounts a join clients c on c.id = a.client_id
       where c.slug = 'markaas-ui' order by a.aangemaakt_op, a.id`,
    );
  }

  it('klantpagina toont per account eigenaar, abonnement, tijdzone en status, en het formulier', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { html } = await detail(jar);
    assert.match(html, /Account toevoegen/);
    assert.match(html, /<th>Abonnement<\/th>/);
    assert.match(html, /<th>Tijdzone<\/th>/);
    assert.match(html, /salesnav_core/);
    assert.match(html, /<td>Europe\/Amsterdam<\/td>/);
    assert.match(html, /werkt/);
    assert.match(html, new RegExp(`action="${PAD}"`));
    for (const tz of ['Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Europe/Brussels']) {
      assert.match(html, new RegExp(`<option value="${tz}">`));
    }
    assert.match(html, /<option value="Europe\/Amsterdam" selected>/);
    assert.match(html, /<option value="anders">/);
    assert.match(html, /name="andereTijdzone"/);
    // Gekoppeld account: geen knop voor een nieuwe koppellink.
    assert.doesNotMatch(html, /Nieuwe koppellink/);
  });

  it('vereist een sessie en CSRF; zonder geldig token 403 en niets aangemaakt', async () => {
    const zonderSessie = await post(PAD, velden('x'), nieuweJar());
    assert.equal(zonderSessie.status, 303);
    assert.equal(zonderSessie.headers.get('location'), '/admin/login');
    const jar = nieuweJar();
    await logIn(jar);
    const r = await post(PAD, velden('fout-token'), jar);
    assert.equal(r.status, 403);
    assert.equal((await accountsVanKlant()).length, 1);
  });

  it('succes: toont de koppellink eenmalig; het account staat met tijdzone op de klantpagina', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const r = await post(PAD, velden(csrf), jar);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('cache-control') ?? '', /no-store/);
    const html = await r.text();
    assert.match(html, /Koppellink gemaakt voor Tom Baker \(tom@acme\.co\.uk\), Markaas/);
    assert.match(html, /Beste Tom/);
    const token = tokenUit(html);
    const u = await vindGeldigeUitnodiging(db, token, vasteKlok(NU));
    assert.ok(u);
    const [acc] = await db.query<{ status: string; tijdzone: string; abonnement: string; opbouw_factor: string }>(
      'select status, tijdzone, abonnement::text as abonnement, opbouw_factor::text from accounts where id = $1',
      [u!.accountId],
    );
    assert.deepEqual(acc, {
      status: 'CONNECTING',
      tijdzone: 'Europe/London',
      abonnement: 'salesnav_advanced',
      opbouw_factor: '0.50',
    });

    const na = (await detail(jar)).html;
    assert.match(na, /Tom Baker/);
    assert.match(na, /<td>Europe\/London<\/td>/);
    assert.match(na, /wacht op koppelen/);
    assert.match(na, new RegExp(`action="/admin/klanten/${u!.accountId}/koppellink"`));
    assert.match(na, /Nieuwe koppellink/);
    assert.ok(!na.includes(token), 'token mag niet op de klantpagina staan');
  });

  it('"Andere" met een eigen IANA-naam wordt opgeslagen', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const r = await post(PAD, velden(csrf, { tijdzone: 'anders', andereTijdzone: 'America/New_York' }), jar);
    assert.equal(r.status, 200);
    assert.equal((await accountsVanKlant())[1]?.tijdzone, 'America/New_York');
  });

  it('fout: formulier opnieuw met NL-melding (400), ingevulde waarden blijven staan, niets aangemaakt', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);

    const ongeldig = await post(PAD, velden(csrf, { tijdzone: 'anders', andereTijdzone: 'Europe/Londen<b>' }), jar);
    assert.equal(ongeldig.status, 400);
    const html = await ongeldig.text();
    assert.match(html, /geen geldige tijdzone/);
    assert.match(html, /value="tom@acme\.co\.uk"/);
    assert.match(html, /value="Europe\/Londen&lt;b&gt;"/);
    assert.match(html, /<option value="anders" selected>/);
    assert.match(html, /<details[^>]*open/);
    assert.doesNotMatch(html, /<b>/);

    const leegAnders = await post(PAD, velden(csrf, { tijdzone: 'anders' }), jar);
    assert.equal(leegAnders.status, 400);
    assert.match(await leegAnders.text(), /Vul bij &quot;Andere&quot; een tijdzone in/);

    const abonnement = await post(PAD, velden(csrf, { abonnement: 'gratis' }), jar);
    assert.equal(abonnement.status, 400);
    assert.match(await abonnement.text(), /Onbekend LinkedIn-abonnement/);

    assert.equal((await accountsVanKlant()).length, 1);
  });

  it('dubbel e-mailadres van de eigenaar binnen de klant: 400 met NL-melding', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    assert.equal((await post(PAD, velden(csrf), jar)).status, 200);
    const dubbel = await post(PAD, velden(csrf, { eigenaarNaam: 'Tom B.', eigenaarEmail: 'TOM@acme.co.uk' }), jar);
    assert.equal(dubbel.status, 400);
    assert.match(await dubbel.text(), /heeft al een account van tom@acme\.co\.uk \(Tom Baker\)/);
    assert.equal((await accountsVanKlant()).length, 2);
  });

  it('onbekende klant: 404', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const r = await post('/admin/klanten/bestaat-niet/accounts', velden(csrf), jar);
    assert.equal(r.status, 404);
  });

  it('formulier Nieuwe klant heeft het tijdzoneveld; Europe/London wordt bewaard, onzin geweigerd', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const form = await (await get('/admin/klanten/nieuw', jar)).text();
    assert.match(form, /<option value="Europe\/Amsterdam" selected>/);
    assert.match(form, /name="andereTijdzone"/);
    const basis = {
      csrf: csrfUit(form),
      klantNaam: 'Gamma Ltd',
      slug: 'gamma',
      eigenaarNaam: 'Gail',
      eigenaarEmail: 'gail@gamma.co.uk',
      abonnement: 'premium_business',
      abonnementVereist: 'ja',
      andereTijdzone: '',
    };
    const fout = await post('/admin/klanten/nieuw', { ...basis, tijdzone: 'anders', andereTijdzone: 'Nergens' }, jar);
    assert.equal(fout.status, 400);
    const foutHtml = await fout.text();
    assert.match(foutHtml, /"Nergens" is geen geldige tijdzone|&quot;Nergens&quot; is geen geldige tijdzone/);
    assert.match(foutHtml, /value="Nergens"/);
    assert.equal(await vindClientBijSlug(db, 'gamma'), null);

    const ok = await post('/admin/klanten/nieuw', { ...basis, tijdzone: 'Europe/London' }, jar);
    assert.equal(ok.status, 200);
    const [acc] = await db.query<{ tijdzone: string }>(
      "select a.tijdzone from accounts a join clients c on c.id = a.client_id where c.slug = 'gamma'",
    );
    assert.equal(acc?.tijdzone, 'Europe/London');
  });
});

describe('klantgebruikers uitnodigen (SPEC §14.3)', () => {
  const KLOK = vasteKlok(NU);

  function portaalTokenUit(html: string): string {
    const m = html.match(/https:\/\/gateway\.test\/portaal\/uitnodiging\/([A-Za-z0-9_-]+)/);
    if (!m) throw new Error('geen uitnodigingslink in de pagina');
    return m[1]!;
  }

  async function detail(jar: CookieJar): Promise<{ html: string; csrf: string }> {
    const r = await get('/admin/klanten/markaas-ui', jar);
    assert.equal(r.status, 200);
    const html = await r.text();
    return { html, csrf: csrfUit(html) };
  }

  it('detailpagina vereist een sessie en geeft 404 voor een onbekende klant', async () => {
    const zonder = await get('/admin/klanten/markaas-ui', nieuweJar());
    assert.equal(zonder.status, 303);
    const jar = nieuweJar();
    await logIn(jar);
    assert.equal((await get('/admin/klanten/bestaat-niet', jar)).status, 404);
  });

  it('klantenoverzicht linkt naar de detailpagina; detail toont accounts en het uitnodigformulier', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const lijst = await (await get('/admin/klanten', jar)).text();
    assert.match(lijst, /href="\/admin\/klanten\/markaas-ui"/);
    const { html } = await detail(jar);
    assert.match(html, /Rubert/);
    assert.match(html, /Gebruiker uitnodigen/);
    assert.match(html, /Nog geen portaalgebruikers/);
  });

  it('uitnodigen zonder CSRF: 403 en niets aangemaakt', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const r = await post(
      '/admin/klanten/markaas-ui/gebruikers',
      { csrf: 'fout', naam: 'Eva', email: 'eva@acme.nl' },
      jar,
    );
    assert.equal(r.status, 403);
    const [t] = await db.query<{ n: number }>('select count(*)::int as n from client_users');
    assert.equal(t?.n, 0);
  });

  it('uitnodigen toont de link eenmalig met voorbeeldmail; de link werkt 7 dagen', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const r = await post(
      '/admin/klanten/markaas-ui/gebruikers',
      { csrf, naam: 'Eva de Vries', email: 'Eva@Acme.nl' },
      jar,
    );
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    const html = await r.text();
    const token = portaalTokenUit(html);
    assert.match(html, /Voorbeeldmail/);
    assert.match(html, /Beste Eva/);
    assert.match(html, /eva@acme\.nl/);
    const u = await vindGeldigeGebruikerUitnodiging(db, token, KLOK);
    assert.equal(u?.email, 'eva@acme.nl');
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, token, vasteKlok(NU.getTime() + 8 * 86_400_000)), null);
    const na = await detail(jar);
    assert.match(na.html, /Eva de Vries/);
    assert.doesNotMatch(na.html, new RegExp(token));
  });

  it('ongeldig e-mailadres of dubbel adres: 400 met NL-melding', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const fout = await post('/admin/klanten/markaas-ui/gebruikers', { csrf, naam: 'Eva', email: 'geen' }, jar);
    assert.equal(fout.status, 400);
    assert.match(await fout.text(), /geldig e-mailadres/);
    await post('/admin/klanten/markaas-ui/gebruikers', { csrf, naam: 'Eva', email: 'eva@acme.nl' }, jar);
    const dubbel = await post('/admin/klanten/markaas-ui/gebruikers', { csrf, naam: 'Eva', email: 'eva@acme.nl' }, jar);
    assert.equal(dubbel.status, 400);
    assert.match(await dubbel.text(), /bestaat al/);
  });

  it('"Nieuwe link" maakt de vorige link ongeldig; "Deactiveren" logt sessies uit', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const { csrf } = await detail(jar);
    const eerste = portaalTokenUit(
      await (await post('/admin/klanten/markaas-ui/gebruikers', { csrf, naam: 'Eva', email: 'eva@acme.nl' }, jar)).text(),
    );
    const [g] = await db.query<{ id: string }>("select id from client_users where email = 'eva@acme.nl'");
    const id = g!.id;

    const nieuw = await post(`/admin/klanten/markaas-ui/gebruikers/${id}/nieuwe-link`, { csrf }, jar);
    assert.equal(nieuw.status, 200);
    const tweede = portaalTokenUit(await nieuw.text());
    assert.equal(await vindGeldigeGebruikerUitnodiging(db, eerste, KLOK), null);
    assert.ok(await vindGeldigeGebruikerUitnodiging(db, tweede, KLOK));

    await gebruikUitnodiging(db, tweede, 'hash', KLOK);
    const sessie = await maakPortaalSessie(db, id, { klok: KLOK });
    const uit = await post(`/admin/klanten/markaas-ui/gebruikers/${id}/deactiveren`, { csrf }, jar);
    assert.equal(uit.status, 303);
    assert.equal(uit.headers.get('location'), '/admin/klanten/markaas-ui');
    assert.equal(await vindPortaalSessie(db, sessie.token, KLOK), null);
    const [na] = await db.query<{ actief: boolean }>('select actief from client_users where id = $1', [id]);
    assert.equal(na?.actief, false);
    assert.match((await detail(jar)).html, /gedeactiveerd/);
  });

  it('beheeractie op een gebruiker van een andere klant: melding en niets gewijzigd', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const ander = await maakClient(db, { naam: 'Ander', slug: 'ander' });
    const r = await nodigGebruikerUit(db, { clientId: ander.id, naam: 'Ad', email: 'ad@ander.nl' }, { klok: KLOK, geldigDagen: 7 });
    const { csrf } = await detail(jar);
    const resp = await post(`/admin/klanten/markaas-ui/gebruikers/${r.gebruiker.id}/deactiveren`, { csrf }, jar);
    assert.equal(resp.status, 303);
    const [na] = await db.query<{ actief: boolean }>('select actief from client_users where id = $1', [r.gebruiker.id]);
    assert.equal(na?.actief, true);
    assert.match((await detail(jar)).html, /Onbekende gebruiker/);
  });

  it('afwijzen vanuit de admin legt afgewezen_door = rubert vast', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const d = await maakActie(db, { accountId, type: 'invite', payload: { providerId: 'X' } });
    const csrf = csrfUit(await (await get('/admin/', jar)).text());
    await post('/admin/acties/afwijzen', { csrf, actieId: d.id, reden: 'nee' }, jar);
    assert.equal((await vindActie(db, d.id))?.afgewezenDoor, 'rubert');
  });
});

describe('abonnement per klant (SPEC §14.4)', () => {
  async function detailHtml(jar: CookieJar, a = app): Promise<string> {
    const r = await a.request('/admin/klanten/markaas-ui', { headers: { cookie: cookieHeader(jar) } });
    assert.equal(r.status, 200);
    return await r.text();
  }

  it('klantpagina toont de abonnementsstand en "Betalen is nog niet ingericht" zonder Stripe', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const html = await detailHtml(jar);
    assert.match(html, /<h2>Abonnement<\/h2>/);
    assert.match(html, /Geen abonnement/);
    assert.match(html, /geblokkeerd: abonnement niet actief/);
    assert.match(html, /Betalen is nog niet ingericht/);
    assert.match(html, /name="vereist" value="ja" checked/);
  });

  it('met Stripe ingericht en een abonnement in proef: stand, Stripe-status en datum', async () => {
    const klant = await vindClientBijSlug(db, 'markaas-ui');
    await db.query(
      "insert into subscriptions(client_id, stripe_customer_id, status, proef_tot) values ($1, 'cus_ui', 'trialing', '2026-11-05T10:00:00Z')",
      [klant!.id],
    );
    app = maakAdminApp({ ...deps, stripeIngericht: true });
    const jar = nieuweJar();
    await logIn(jar);
    const html = await detailHtml(jar);
    assert.match(html, /Proefperiode tot 5 november 2026/);
    assert.match(html, /Stripe: trialing/);
    assert.match(html, /cus_ui/);
    assert.doesNotMatch(html, /Betalen is nog niet ingericht/);
  });

  it('vinkje abonnement_vereist uitzetten en weer aanzetten (CSRF verplicht)', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const fout = await post('/admin/klanten/markaas-ui/abonnement-vereist', { csrf: 'fout' }, jar);
    assert.equal(fout.status, 403);
    assert.equal((await vindClientBijSlug(db, 'markaas-ui'))!.abonnementVereist, true);

    const uit = await post('/admin/klanten/markaas-ui/abonnement-vereist', { csrf }, jar);
    assert.equal(uit.status, 303);
    assert.equal((await vindClientBijSlug(db, 'markaas-ui'))!.abonnementVereist, false);
    const html = await detailHtml(jar);
    assert.match(html, /geen abonnement nodig/i);
    assert.doesNotMatch(html, /name="vereist" value="ja" checked/);

    await post('/admin/klanten/markaas-ui/abonnement-vereist', { csrf, vereist: 'ja' }, jar);
    assert.equal((await vindClientBijSlug(db, 'markaas-ui'))!.abonnementVereist, true);
  });

  it('vinkje aanpassen zonder sessie of voor een onbekende klant wijzigt niets', async () => {
    const zonder = await post('/admin/klanten/markaas-ui/abonnement-vereist', { csrf: 'x' }, nieuweJar());
    assert.equal(zonder.status, 303);
    assert.equal(zonder.headers.get('location'), '/admin/login');
    assert.equal((await vindClientBijSlug(db, 'markaas-ui'))!.abonnementVereist, true);
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const onbekend = await post('/admin/klanten/bestaat-niet/abonnement-vereist', { csrf }, jar);
    assert.equal(onbekend.status, 404);
  });

  it('concepten van een klant zonder actief abonnement krijgen een waarschuwing in het overzicht', async () => {
    await maakDraft();
    const jar = nieuweJar();
    await logIn(jar);
    const metPoort = await (await get('/admin/', jar)).text();
    assert.match(metPoort, /Abonnement niet actief: de klant moet in het klantportaal een abonnement starten\./);
    await db.query("update clients set abonnement_vereist = false where slug = 'markaas-ui'");
    const zonderPoort = await (await get('/admin/', jar)).text();
    assert.doesNotMatch(zonderPoort, /Abonnement niet actief/);
  });
});

describe('aantal in Stripe vanuit de admin (SPEC §14.4)', () => {
  it('knop roept de sync aan (CSRF) en een mislukte sync is zichtbaar op de klantpagina', async () => {
    const klant = await vindClientBijSlug(db, 'markaas-ui');
    await db.query("insert into subscriptions(client_id, stripe_subscription_id, status) values ($1, 'sub_ui', 'active')", [klant!.id]);
    const aanroepen: string[] = [];
    app = maakAdminApp({
      ...deps,
      stripeIngericht: true,
      aantalSync: async (clientId, aanleiding) => {
        aanroepen.push(`${clientId}:${aanleiding}`);
        await db.query(
          `insert into events(bron, type, payload) values ('gateway', 'stripe_aantal_mislukt', $1::jsonb)`,
          [JSON.stringify({ client_id: clientId, fout: 'Stripe-serverfout (HTTP 500)' })],
        );
        return { resultaat: 'mislukt', reden: 'Stripe-serverfout (HTTP 500)' };
      },
    });
    const jar = nieuweJar();
    await logIn(jar);
    const html = await (await get('/admin/klanten/markaas-ui', jar)).text();
    assert.match(html, /Aantal in Stripe bijwerken/);
    const csrf = csrfUit(html);
    assert.equal((await post('/admin/klanten/markaas-ui/abonnement-aantal', { csrf: 'fout' }, jar)).status, 403);
    assert.equal(aanroepen.length, 0);
    const r = await post('/admin/klanten/markaas-ui/abonnement-aantal', { csrf }, jar);
    assert.equal(r.status, 303);
    assert.deepEqual(aanroepen, [`${klant!.id}:admin`]);
    const na = await (await get('/admin/klanten/markaas-ui', jar)).text();
    assert.match(na, /bijwerken mislukt op/);
    assert.match(na, /Stripe-serverfout \(HTTP 500\)/);
  });
});

describe('account vrijgeven (SPEC §6b punt 3)', () => {
  const PAD = () => `/admin/klanten/markaas-ui/accounts/${accountId}/vrijgeven`;

  async function zetStatus(status: string, opbouw = 1.0): Promise<void> {
    await db.query(
      `update accounts set status = $2::account_status, opbouw_factor = $3, afkoeling_tot = null where id = $1`,
      [accountId, status, opbouw],
    );
  }

  async function account(): Promise<{ status: string; opbouw: number; afkoeling: Date | null }> {
    const [r] = await db.query<{ status: string; opbouw_factor: string | number; afkoeling_tot: Date | string | null }>(
      'select status::text as status, opbouw_factor, afkoeling_tot from accounts where id = $1',
      [accountId],
    );
    return {
      status: r!.status,
      opbouw: Number(r!.opbouw_factor),
      afkoeling: r!.afkoeling_tot === null ? null : new Date(r!.afkoeling_tot),
    };
  }

  async function detailHtml(jar: CookieJar): Promise<string> {
    const r = await get('/admin/klanten/markaas-ui', jar);
    assert.equal(r.status, 200);
    return await r.text();
  }

  it('knop "Account vrijgeven" met verplichte reden staat er bij ERROR en STOPPED', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    for (const status of ['ERROR', 'STOPPED']) {
      await zetStatus(status);
      const html = await detailHtml(jar);
      assert.match(html, new RegExp(`action="/admin/klanten/markaas-ui/accounts/${accountId}/vrijgeven"`), status);
      assert.match(html, /Account vrijgeven/);
      assert.match(html, /name="reden" required/);
    }
  });

  it('de knop staat er niet bij CREDENTIALS of OK', async () => {
    const jar = nieuweJar();
    await logIn(jar);
    for (const status of ['CREDENTIALS', 'OK']) {
      await zetStatus(status);
      const html = await detailHtml(jar);
      assert.doesNotMatch(html, /vrijgeven"/, status);
      assert.doesNotMatch(html, /Account vrijgeven/, status);
    }
  });

  it('een POST op een CREDENTIALS-account geeft niets vrij (NL-melding)', async () => {
    await zetStatus('CREDENTIALS');
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const r = await post(PAD(), { csrf, reden: 'toch proberen' }, jar);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /opnieuw inloggen|reconnect-link/);
    assert.equal((await account()).status, 'CREDENTIALS');
  });

  it('zonder of met fout CSRF-token: 403 en het account blijft STOPPED', async () => {
    await zetStatus('STOPPED');
    const jar = nieuweJar();
    await logIn(jar);
    assert.equal((await post(PAD(), { reden: 'gecontroleerd' }, jar)).status, 403);
    assert.equal((await post(PAD(), { csrf: 'fout', reden: 'gecontroleerd' }, jar)).status, 403);
    assert.equal((await account()).status, 'STOPPED');
    // Zonder sessie: naar login.
    const zonder = await post(PAD(), { csrf: 'x', reden: 'gecontroleerd' }, nieuweJar());
    assert.equal(zonder.status, 303);
    assert.equal(zonder.headers.get('location'), '/admin/login');
    assert.equal((await account()).status, 'STOPPED');
  });

  it('vrijgeven vereist een reden: leeg of alleen spaties → 400, account ongewijzigd', async () => {
    await zetStatus('STOPPED');
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    for (const reden of ['', '   ']) {
      const r = await post(PAD(), { csrf, reden }, jar);
      assert.equal(r.status, 400);
      assert.match(await r.text(), /Vul een reden in/);
    }
    assert.equal((await account()).status, 'STOPPED');
    const events = await db.query(`select 1 from events where type = 'account_status'`);
    assert.equal(events.length, 0);
  });

  it('STOPPED vrijgeven: OK, opbouw_factor naar afkoeling.opbouw_factor_na voor de opbouwperiode, event met reden en rubert', async () => {
    await zetStatus('STOPPED', 1.0);
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const r = await post(
      PAD(),
      { csrf, reden: 'eigenaar heeft in LinkedIn gecontroleerd, beperking opgeheven' },
      jar,
    );
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/admin/klanten/markaas-ui');
    const na = await account();
    assert.equal(na.status, 'OK');
    assert.equal(na.opbouw, limieten.afkoeling.opbouw_factor_na);
    // Zelfde mechanisme als na afkoeling: de periode hangt aan afkoeling_tot (= nu).
    assert.equal(na.afkoeling?.toISOString(), NU.toISOString());

    const [e] = await db.query<{ bron: string; payload: Record<string, unknown> }>(
      `select bron::text as bron, payload from events where type = 'account_status' and account_id = $1`,
      [accountId],
    );
    assert.equal(e?.bron, 'gateway');
    assert.equal(e?.payload['status'], 'OK');
    assert.equal(e?.payload['vorige_status'], 'STOPPED');
    assert.equal(e?.payload['door'], 'rubert');
    assert.match(String(e?.payload['reden']), /beperking opgeheven/);

    const html = await detailHtml(jar);
    assert.match(html, /is vrijgegeven \(was STOPPED\)/);
    assert.doesNotMatch(html, /Account vrijgeven/);
  });

  it('ERROR vrijgeven: OK, opbouw_factor blijft staan', async () => {
    await zetStatus('ERROR', 0.7);
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const r = await post(PAD(), { csrf, reden: 'oorzaak gevonden bij Unipile' }, jar);
    assert.equal(r.status, 303);
    const na = await account();
    assert.equal(na.status, 'OK');
    assert.equal(na.opbouw, 0.7);
    assert.equal(na.afkoeling, null);
  });

  it('account van een andere klant: 404, niets vrijgegeven', async () => {
    const ander = await maakClient(db, { naam: 'Ander', slug: 'ander' });
    const acc = await registreerAccount(db, { clientId: ander.id, eigenaarNaam: 'Eva', abonnement: 'free' });
    await db.query(`update accounts set status = 'STOPPED' where id = $1`, [acc.id]);
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    const r = await post(`/admin/klanten/markaas-ui/accounts/${acc.id}/vrijgeven`, { csrf, reden: 'x' }, jar);
    assert.equal(r.status, 404);
    const [rij] = await db.query<{ status: string }>('select status::text as status from accounts where id = $1', [acc.id]);
    assert.equal(rij?.status, 'STOPPED');
  });

  it('invoer wordt ge-escaped in de HTML (naam in de melding)', async () => {
    await db.query(`update accounts set eigenaar_naam = '<script>x</script>', status = 'STOPPED' where id = $1`, [accountId]);
    const jar = nieuweJar();
    await logIn(jar);
    const csrf = csrfUit(await detailHtml(jar));
    await post(PAD(), { csrf, reden: '<b>gecontroleerd</b>' }, jar);
    const html = await detailHtml(jar);
    assert.doesNotMatch(html, /<script>x<\/script>/);
    assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  });
});
