import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
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
