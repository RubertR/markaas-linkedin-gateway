import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { laadIntake, type Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import { maakActie, vindActie } from '../queue/acties.ts';
import type { Antwoorden } from '../profiel/invoer.ts';
import { dienIn, profielStand, slaRondeOp, stelVast } from '../profiel/profielen.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakVoorbeeld } from './als-klant.ts';
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
let accountId: string;
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

function deps(): AdminDeps {
  return { db, limieten, klok, wachtwoordHash, cookieSecure: false, publicBaseUrl: 'https://gateway.test', intake, proefperiodeDagen: 30 };
}

beforeEach(async () => {
  for (const t of ['klantprofielen', 'usage', 'actions', 'sequences', 'events', 'accounts', 'clients']) {
    await db.query(`delete from ${t}`);
  }
  klantId = (await maakClient(db, { naam: 'TAG', slug: 'tag', abonnementVereist: false })).id;
  accountId = (await registreerAccount(db, { clientId: klantId, eigenaarNaam: 'Fedor Hoevenaars', abonnement: 'salesnav_core' })).id;
  await markeerAccountGekoppeld(db, accountId, 'uni-f');
  app = maakAdminApp(deps());
});

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

const cookies = (j: Jar): Record<string, string> =>
  j.size === 0 ? {} : { cookie: [...j.entries()].map(([k, v]) => `${k}=${v}`).join('; ') };

async function get(pad: string, j: Jar): Promise<Response> {
  const resp = await app.request(pad, { headers: cookies(j) });
  vang(resp, j);
  return resp;
}

async function post(pad: string, velden: Record<string, string>, j: Jar): Promise<Response> {
  const resp = await app.request(pad, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...cookies(j) },
    body: new URLSearchParams(velden).toString(),
  });
  vang(resp, j);
  return resp;
}

async function ingelogd(): Promise<{ j: Jar; csrf: string }> {
  const j: Jar = new Map();
  const html = await (await get('/admin/login', j)).text();
  const csrf = html.match(/name="csrf"\s+value="([^"]+)"/)![1]!;
  assert.equal((await post('/admin/login', { wachtwoord: WACHTWOORD, csrf }, j)).status, 303);
  const pagina = await (await get('/admin/klanten/tag', j)).text();
  return { j, csrf: pagina.match(/name="csrf"\s+value="([^"]+)"/)![1]! };
}

async function draft(): Promise<string> {
  const a = await maakActie(db, {
    accountId,
    type: 'invite',
    payload: {
      providerId: 'ACo-x',
      message: 'Hoi Laura, zullen we connecten?',
      ontvanger_naam: 'Laura Visser',
      ontvanger_functie: 'Sales director',
      ontvanger_bedrijf: 'Voorbeeld BV',
      ontvanger_url: 'https://www.linkedin.com/in/laura/',
      waarom: 'Nieuwe rol.',
    },
  });
  return a.id;
}

describe('admin: bekijk als klant (SPEC §14.7)', () => {
  it('klantpagina heeft de knop; zonder admin-sessie naar de login; onbekende klant 404', async () => {
    assert.equal((await get('/admin/klanten/tag/als-klant/', new Map())).headers.get('location'), '/admin/login');
    const { j } = await ingelogd();
    assert.match(await (await get('/admin/klanten/tag', j)).text(), /href="\/admin\/klanten\/tag\/als-klant\/">Bekijk als klant/);
    assert.equal((await get('/admin/klanten/bestaat-niet/als-klant/', j)).status, 404);
    assert.equal((await get('/admin/klanten/tag/als-klant', j)).headers.get('location'), '/admin/klanten/tag/als-klant/');
  });

  it('concepten zoals de klant ze ziet, met balk, uitgeschakelde knoppen en zonder formulier-acties', async () => {
    const actieId = await draft();
    const { j } = await ingelogd();
    const resp = await get('/admin/klanten/tag/als-klant/', j);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('cache-control'), 'no-store');
    const html = await resp.text();
    assert.match(html, /Voorbeeld:<\/strong> zo ziet TAG het portaal/);
    assert.match(html, /Laura Visser/);
    assert.match(html, /Hoi Laura, zullen we connecten\?/);
    assert.doesNotMatch(html, /action="/, 'geen enkel formulier mag ergens heen posten');
    assert.doesNotMatch(html, /<button(?![^>]*disabled)/, 'elke knop is uitgeschakeld');
    assert.doesNotMatch(html, /<input(?![^>]*disabled)/, 'elk veld is uitgeschakeld');
    assert.match(html, /href="\/admin\/klanten\/tag\/als-klant\/resultaten"/);
    assert.doesNotMatch(html, /href="\/portaal\//);
    assert.equal((await vindActie(db, actieId))?.status, 'draft');
  });

  it('er bestaan geen POST-routes onder /als-klant; niets verandert', async () => {
    const actieId = await draft();
    const { j, csrf } = await ingelogd();
    for (const pad of ['/admin/klanten/tag/als-klant/', '/admin/klanten/tag/als-klant/acties/goedkeuren', '/admin/klanten/tag/als-klant/profiel/indienen', '/admin/klanten/tag/als-klant/profiel/propositie']) {
      assert.equal((await post(pad, { csrf, actieId }, j)).status, 404, pad);
    }
    assert.equal((await vindActie(db, actieId))?.status, 'draft');
    assert.equal((await profielStand(db, klantId)).open, null);
  });

  it('resultaten, abonnement en klantprofiel; de interne aanvulling blijft verborgen', async () => {
    const p = await slaRondeOp(db, { clientId: klantId, antwoorden: VOLLEDIG, revisie: 0, intake, klok });
    await dienIn(db, { clientId: klantId, revisie: p.revisie, door: 'klant:eva@tag.nl', intake, klok });
    await stelVast(db, { clientId: klantId, interneAanvulling: 'GEHEIM-FILTER', door: 'rubert', klok });
    const { j } = await ingelogd();
    assert.match(await (await get('/admin/klanten/tag/als-klant/resultaten', j)).text(), /Fedor Hoevenaars/);
    assert.match(await (await get('/admin/klanten/tag/als-klant/abonnement', j)).text(), /Abonnement/);
    const profiel = await (await get('/admin/klanten/tag/als-klant/profiel', j)).text();
    assert.match(profiel, /Uw klantprofiel is vastgesteld/);
    assert.match(profiel, /Sales-acceleratie/);
    assert.doesNotMatch(profiel, /GEHEIM-FILTER/);
    // Vastgesteld: rondes gaan terug naar het overzicht, net als in het portaal.
    assert.equal(
      (await get('/admin/klanten/tag/als-klant/profiel/propositie', j)).headers.get('location'),
      '/admin/klanten/tag/als-klant/profiel',
    );
  });

  it('een ronde van een concept-profiel is te bekijken, met uitgeschakelde velden', async () => {
    await slaRondeOp(db, { clientId: klantId, antwoorden: { wat_verkoopt: { tekst: 'Iets moois' } }, revisie: 0, intake, klok });
    const { j } = await ingelogd();
    const html = await (await get('/admin/klanten/tag/als-klant/profiel/propositie', j)).text();
    assert.match(html, /Iets moois/);
    assert.match(html, /<textarea disabled/);
    assert.doesNotMatch(html, /action="/);
  });
});

describe('maakVoorbeeld', () => {
  it('escaped de klantnaam in de balk en zet links en formulieren om', () => {
    const uit = maakVoorbeeld(
      '<body><a href="/portaal/profiel">x</a><form method="post" action="/portaal/logout"><button type="submit">Uit</button></form></body>',
      { naam: '<Acme & Co>', slug: 'acme' },
    );
    assert.match(uit, /&lt;Acme &amp; Co&gt;/);
    assert.match(uit, /href="\/admin\/klanten\/acme\/als-klant\/profiel"/);
    assert.match(uit, /<form onsubmit="return false"><button disabled type="submit">/);
  });
});
