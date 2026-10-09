import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { laadIntake, type Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import type { Antwoorden } from '../profiel/invoer.ts';
import { dienIn, profielStand, slaRondeOp } from '../profiel/profielen.ts';
import { registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakAdminApp, type AdminDeps } from './server.ts';
import { maakWachtwoordHash } from './wachtwoord.ts';

const WACHTWOORD = 'geheimpje123';
const klok = vasteKlok(new Date('2026-10-08T10:00:00Z'));

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let intake: Intake;
let wachtwoordHash: string;
let klantId: string;
let app: ReturnType<typeof maakAdminApp>;

const VOLLEDIG: Antwoorden = {
  wat_verkoopt: { tekst: 'Sales-acceleratie' },
  probleem: { tekst: 'Te weinig nieuwe klanten' },
  kernwaarde: { keuzes: ['Meer omzet of nieuwe klanten'] },
  sectoren: { keuzes: ['Energie'] },
  omvang: { keuzes: ['201–500'] },
  regio: { keuzes: ['Nederland'] },
  functies: { keuzes: ['Sales director of CCO'] },
  triggers: { keuzes: ['Overname of fusie'] },
  afzenders: { tekst: 'Pieter' },
  merk: { keuzes: ['Onze eigen bedrijfsnaam'] },
  aanspreekvorm: { keuzes: ['Je'] },
  taal: { keuzes: ['Nederlands'] },
  aanbod: { keuzes: ['Demo'] },
};

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
  intake = await laadIntake();
  wachtwoordHash = await maakWachtwoordHash(WACHTWOORD);
});

after(async () => close());

function deps(extra: Partial<AdminDeps> = {}): AdminDeps {
  return {
    db,
    limieten,
    klok,
    wachtwoordHash,
    cookieSecure: false,
    publicBaseUrl: 'https://gateway.test',
    intake,
    ...extra,
  };
}

beforeEach(async () => {
  await db.query('delete from klantprofielen');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  klantId = (await maakClient(db, { naam: 'TAG', slug: 'tag', abonnementVereist: false })).id;
  await registreerAccount(db, { clientId: klantId, eigenaarNaam: 'Fedor Hoevenaars', abonnement: 'salesnav_core' });
  app = maakAdminApp(deps());
});

// -- HTTP-hulpjes --------------------------------------------------------------

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

function cookies(j: Jar): Record<string, string> {
  return j.size === 0 ? {} : { cookie: [...j.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };
}

async function get(pad: string, j: Jar, a = app): Promise<Response> {
  const resp = await a.request(pad, { headers: cookies(j) });
  vang(resp, j);
  return resp;
}

async function post(pad: string, velden: Record<string, string | string[]>, j: Jar, a = app): Promise<Response> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(velden)) {
    if (Array.isArray(v)) v.forEach((x) => form.append(k, x));
    else form.append(k, v);
  }
  const resp = await a.request(pad, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies(j) },
    body: form.toString(),
  });
  vang(resp, j);
  return resp;
}

function veld(html: string, naam: string): string {
  const m = html.match(new RegExp(`name="${naam}"\\s+value="([^"]*)"`));
  if (!m) throw new Error(`geen veld ${naam}`);
  return m[1]!;
}

async function ingelogd(a = app): Promise<{ j: Jar; csrf: string }> {
  const j: Jar = new Map();
  const csrf = veld(await (await get('/admin/login', j, a)).text(), 'csrf');
  assert.equal((await post('/admin/login', { wachtwoord: WACHTWOORD, csrf }, j, a)).status, 303);
  const html = await (await get('/admin/klanten/tag', j, a)).text();
  return { j, csrf: veld(html, 'csrf') };
}

async function klantDientIn(): Promise<void> {
  const p = await slaRondeOp(db, { clientId: klantId, antwoorden: VOLLEDIG, revisie: 0, intake, klok });
  await dienIn(db, { clientId: klantId, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok });
}

// -- tests -----------------------------------------------------------------------

describe('admin: klantprofiel', () => {
  it('klantpagina toont de stand van het profiel en een link; zonder intake geen sectie', async () => {
    const { j } = await ingelogd();
    const html = await (await get('/admin/klanten/tag', j)).text();
    assert.match(html, /Klantprofiel en ICP/);
    assert.match(html, /Nog niet ingediend/);
    assert.match(html, /href="\/admin\/klanten\/tag\/profiel"/);

    const { intake: _weg, ...zonder } = deps();
    const zonderApp = maakAdminApp(zonder);
    const z = await ingelogd(zonderApp);
    assert.doesNotMatch(await (await get('/admin/klanten/tag', z.j, zonderApp)).text(), /Klantprofiel en ICP/);
  });

  it('zonder login naar de loginpagina; onbekende klant 404', async () => {
    assert.equal((await get('/admin/klanten/tag/profiel', new Map())).headers.get('location'), '/admin/login');
    const { j } = await ingelogd();
    assert.equal((await get('/admin/klanten/bestaat-niet/profiel', j)).status, 404);
  });

  it('ingediend profiel vaststellen met interne aanvulling', async () => {
    await klantDientIn();
    const { j, csrf } = await ingelogd();
    const html = await (await get('/admin/klanten/tag/profiel', j)).text();
    assert.match(html, /Ingediende versie 1/);
    assert.match(html, /klant:eva@tag\.nl/);
    assert.match(html, /Sales-acceleratie/);
    const resp = await post('/admin/klanten/tag/profiel/vaststellen', { csrf, interne_aanvulling: 'keywords: energie' }, j);
    assert.equal(resp.headers.get('location'), '/admin/klanten/tag/profiel');
    const na = await (await get('/admin/klanten/tag/profiel', j)).text();
    assert.match(na, /Klantprofiel vastgesteld/);
    assert.match(na, /Vastgestelde versie 1/);
    const { vastgesteld } = await profielStand(db, klantId);
    assert.equal(vastgesteld!.interneAanvulling, 'keywords: energie');
    assert.equal(vastgesteld!.vastgesteldDoor, 'rubert');
  });

  it('terugsturen met een vraag; zonder vraag een NL-melding', async () => {
    await klantDientIn();
    const { j, csrf } = await ingelogd();
    await post('/admin/klanten/tag/profiel/terugsturen', { csrf, vraag: '' }, j);
    assert.match(await (await get('/admin/klanten/tag/profiel', j)).text(), /Vul een vraag/);
    await post('/admin/klanten/tag/profiel/terugsturen', { csrf, vraag: 'Welke regio eerst?' }, j);
    const { open } = await profielStand(db, klantId);
    assert.equal(open!.status, 'concept');
    assert.equal(open!.vraagVanMarkaas, 'Welke regio eerst?');
    // Klant antwoordt bij opnieuw indienen; het gesprek staat in de admin.
    await dienIn(db, { clientId: klantId, revisie: open!.revisie, door: 'klant:eva@tag.nl', intake, klok, antwoord: 'Eerst Nederland.' });
    const html = await (await get('/admin/klanten/tag/profiel', j)).text();
    assert.match(html, /Gesprek met de klant/);
    assert.match(html, /Welke regio eerst\?/);
    assert.match(html, /Klant \(eva@tag\.nl\)/);
    assert.match(html, /Eerst Nederland\./);
  });

  it('namens de klant invullen en indienen (bestaande klant zoals TAG)', async () => {
    const { j } = await ingelogd();
    assert.match(await (await get('/admin/klanten/tag/profiel', j)).text(), /Invullen namens de klant/);
    const formulier = await (await get('/admin/klanten/tag/profiel/afzender', j)).text();
    assert.match(formulier, /Fedor Hoevenaars/);
    const resp = await post(
      '/admin/klanten/tag/profiel/afzender',
      { csrf: veld(formulier, 'csrf'), revisie: veld(formulier, 'revisie'), richting: 'volgende', v_afzenders: 'Fedor (Fedor)' },
      j,
    );
    assert.equal(resp.headers.get('location'), '/admin/klanten/tag/profiel/bewijs');
    // De rest via de database, dan indienen via de admin.
    const { open } = await profielStand(db, klantId);
    await slaRondeOp(db, { clientId: klantId, antwoorden: VOLLEDIG, revisie: open!.revisie, intake, klok });
    const overzicht = await (await get('/admin/klanten/tag/profiel', j)).text();
    assert.match(overzicht, /Indienen namens de klant/);
    const indienForm = overzicht.slice(overzicht.indexOf('/profiel/indienen'));
    await post('/admin/klanten/tag/profiel/indienen', { csrf: veld(overzicht, 'csrf'), revisie: veld(indienForm, 'revisie') }, j);
    const na = await profielStand(db, klantId);
    assert.equal(na.open!.status, 'ingediend');
    assert.equal(na.open!.ingediendDoor, 'rubert');
  });

  it('elke POST eist het CSRF-token', async () => {
    await klantDientIn();
    const { j } = await ingelogd();
    for (const actie of ['vaststellen', 'terugsturen', 'aanvulling', 'indienen', 'wijziging', 'propositie']) {
      assert.equal((await post(`/admin/klanten/tag/profiel/${actie}`, { vraag: 'x' }, j)).status, 403, actie);
    }
    assert.equal((await profielStand(db, klantId)).open!.status, 'ingediend');
  });
});
