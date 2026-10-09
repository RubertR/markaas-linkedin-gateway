import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { maakWachtwoordHash } from '../admin/wachtwoord.ts';
import type { Klok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { laadIntake, type Intake } from '../config/intake.ts';
import type { Backend } from '../db/backend.ts';
import { profielStand, stelVast, stuurTerug } from '../profiel/profielen.ts';
import { registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { maakUnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { gebruikUitnodiging, nodigGebruikerUit } from './gebruikers.ts';
import { maakPortaalApp, type PortaalDeps } from './server.ts';

const WACHTWOORD = 'een-lang-wachtwoord-1';
const klok: Klok = { nu: () => new Date('2026-10-08T10:00:00Z') };

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;
let intake: Intake;
let hash: string;
let klantA: string;
let klantB: string;
let app: ReturnType<typeof maakPortaalApp>;

function deps(extra: Partial<PortaalDeps> = {}): PortaalDeps {
  return {
    db,
    limieten,
    klok,
    // Wordt in deze tests niet aangeroepen (geen koppellinks).
    unipile: maakUnipileClient({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', timeoutMs: 50 }),
    koppelOpties: { notifyUrl: 'https://gateway.test/webhooks/koppel?k=x', apiUrl: 'https://api.example' },
    cookieSecure: false,
    intake,
    ...extra,
  };
}

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
  intake = await laadIntake();
  hash = await maakWachtwoordHash(WACHTWOORD);
});

after(async () => close());

beforeEach(async () => {
  for (const t of ['klantprofielen', 'portal_sessions', 'client_user_uitnodigingen', 'client_users', 'accounts', 'clients']) {
    await db.query(`delete from ${t}`);
  }
  klantA = (await maakClient(db, { naam: 'TAG', slug: 'tag', abonnementVereist: false })).id;
  klantB = (await maakClient(db, { naam: 'Bolt NV', slug: 'bolt', abonnementVereist: false })).id;
  await registreerAccount(db, { clientId: klantA, eigenaarNaam: 'Pieter Playsir', abonnement: 'salesnav_core' });
  await maakGebruiker(klantA, 'Eva', 'eva@tag.nl');
  await maakGebruiker(klantA, 'Fedor', 'fedor@tag.nl');
  await maakGebruiker(klantB, 'Bob', 'bob@bolt.nl');
  app = maakPortaalApp(deps());
});

async function maakGebruiker(clientId: string, naam: string, email: string): Promise<void> {
  const r = await nodigGebruikerUit(db, { clientId, naam, email }, { klok, geldigDagen: 7 });
  await gebruikUitnodiging(db, r.uitnodiging.token, hash, klok);
}

// -- HTTP-hulpjes (zoals server.test.ts) -------------------------------------

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
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': '198.51.100.7', ...cookies(j) },
    body: form.toString(),
  });
  vang(resp, j);
  return resp;
}

function veld(html: string, naam: string): string {
  const m = html.match(new RegExp(`name="${naam}" value="([^"]*)"`));
  if (!m) throw new Error(`geen veld ${naam} in de pagina`);
  return m[1]!;
}

async function login(email: string, a = app): Promise<{ j: Jar; resp: Response }> {
  const j: Jar = new Map();
  const csrf = veld(await (await get('/portaal/login', j, a)).text(), 'csrf');
  const resp = await post('/portaal/login', { csrf, email, wachtwoord: WACHTWOORD }, j, a);
  assert.equal(resp.status, 303, 'login moet lukken');
  return { j, resp };
}

/** Opent een ronde en geeft csrf en revisie uit het formulier. */
async function open(ronde: string, j: Jar): Promise<{ csrf: string; revisie: string; html: string }> {
  const resp = await get(`/portaal/profiel/${ronde}`, j);
  assert.equal(resp.status, 200, `ronde ${ronde} moet open gaan`);
  const html = await resp.text();
  return { csrf: veld(html, 'csrf'), revisie: veld(html, 'revisie'), html };
}

const RONDES: Record<string, Record<string, string | string[]>> = {
  propositie: {
    v_wat_verkoopt: 'Sales-acceleratie',
    v_probleem: 'Te weinig nieuwe klanten',
    v_kernwaarde: ['Meer omzet of nieuwe klanten'],
  },
  doelgroep: {
    v_sectoren: ['Energie', 'Facilitair'],
    v_omvang: ['201–500', '501–1.000'],
    v_regio: 'Nederland',
    v_functies: ['Sales director of CCO'],
  },
  signalen: { v_triggers: ['Overname of fusie'], v_uitsluiten: ['Concurrenten'] },
  afzender: { v_afzenders: 'Pieter (Pieter)', v_merk: 'Onze eigen bedrijfsnaam', v_aanspreekvorm: 'Je', v_taal: 'Nederlands' },
  bewijs: { v_aanbod: 'Vrijblijvend gesprek van een half uur' },
};

async function vulAllesIn(j: Jar): Promise<void> {
  for (const [ronde, velden] of Object.entries(RONDES)) {
    const f = await open(ronde, j);
    const resp = await post(`/portaal/profiel/${ronde}`, { csrf: f.csrf, revisie: f.revisie, richting: 'volgende', ...velden }, j);
    assert.equal(resp.status, 303, `ronde ${ronde} opslaan`);
  }
}

async function dienProfielIn(j: Jar): Promise<Response> {
  const html = await (await get('/portaal/profiel', j)).text();
  const indienFormulier = html.slice(html.indexOf('action="/portaal/profiel/indienen"'));
  return await post('/portaal/profiel/indienen', { csrf: veld(html, 'csrf'), revisie: veld(indienFormulier, 'revisie') }, j);
}

// -- tests -------------------------------------------------------------------

describe('portaal: klantprofiel na het aanmelden', () => {
  it('zonder intake-configuratie: login naar de concepten en geen tabblad (gedrag van vóór §14.6)', async () => {
    const { intake: _weg, ...zonderIntake } = deps();
    const zonder = maakPortaalApp(zonderIntake);
    const { j, resp } = await login('eva@tag.nl', zonder);
    assert.equal(resp.headers.get('location'), '/portaal/');
    const html = await (await get('/portaal/', j, zonder)).text();
    assert.doesNotMatch(html, /Klantprofiel/);
    assert.equal((await get('/portaal/profiel', j, zonder)).status, 404);
  });

  it('eerste login gaat naar het klantprofiel; andere pagina\'s tonen de balk "Stap 1"', async () => {
    const { j, resp } = await login('eva@tag.nl');
    assert.equal(resp.headers.get('location'), '/portaal/profiel');
    const overzicht = await (await get('/portaal/profiel', j)).text();
    assert.match(overzicht, /Uw klantprofiel/);
    assert.match(overzicht, /Beginnen/);
    const concepten = await (await get('/portaal/', j)).text();
    assert.match(concepten, /Stap 1: vul uw klantprofiel in/);
    assert.match(concepten, /href="\/portaal\/profiel"/);
  });

  it('rondes invullen, indienen; daarna geen balk meer en login naar de concepten', async () => {
    const { j } = await login('eva@tag.nl');
    const afzender = await open('afzender', j);
    assert.match(afzender.html, /Pieter Playsir/, 'gekoppelde accounts als geheugensteun');

    await vulAllesIn(j);
    const voor = await (await get('/portaal/profiel', j)).text();
    assert.match(voor, /Indienen bij MARKaaS/);
    // Alles ingevuld: "Wijzigen" in plaats van "Verder invullen".
    assert.match(voor, />Wijzigen<\/a><\/p>/);
    assert.doesNotMatch(voor, /Verder invullen/);
    assert.match(voor, /Alle verplichte vragen zijn beantwoord/);
    assert.match(voor, /Sales-acceleratie/);

    const resp = await dienProfielIn(j);
    assert.equal(resp.status, 303);
    const na = await (await get('/portaal/profiel', j)).text();
    assert.match(na, /is ingediend bij MARKaaS/);
    assert.match(na, /Ingediend bij MARKaaS/);

    const { open: p } = await profielStand(db, klantA);
    assert.equal(p!.status, 'ingediend');
    assert.equal(p!.ingediendDoor, 'klant:eva@tag.nl');
    assert.deepEqual(p!.antwoorden['sectoren'], { keuzes: ['Energie', 'Facilitair'] });

    // Ingediend: rondes zijn niet meer te openen, geen balk meer.
    assert.equal((await get('/portaal/profiel/propositie', j)).headers.get('location'), '/portaal/profiel');
    assert.doesNotMatch(await (await get('/portaal/', j)).text(), /Stap 1/);
    assert.equal((await login('fedor@tag.nl')).resp.headers.get('location'), '/portaal/');
  });

  it('indienen met ontbrekende verplichte vragen geeft een NL-melding', async () => {
    const { j } = await login('eva@tag.nl');
    const f = await open('propositie', j);
    await post('/portaal/profiel/propositie', { csrf: f.csrf, revisie: f.revisie, ...RONDES['propositie']! }, j);
    const html = await (await get('/portaal/profiel', j)).text();
    assert.match(html, /Verder invullen/, 'nog niet alles ingevuld: "Verder invullen"');
    assert.doesNotMatch(html, /Indienen bij MARKaaS<\/button>/);
    assert.match(html, /verplichte vragen te gaan/);
    const resp = await post('/portaal/profiel/indienen', { csrf: veld(html, 'csrf'), revisie: '1' }, j);
    assert.equal(resp.status, 303);
    assert.match(await (await get('/portaal/profiel', j)).text(), /Nog niet alle verplichte vragen/);
  });

  it('een claim zonder vinkje: 400, melding, ingevulde tekst blijft staan en niets wordt opgeslagen', async () => {
    const { j } = await login('eva@tag.nl');
    const f = await open('bewijs', j);
    const resp = await post(
      '/portaal/profiel/bewijs',
      { csrf: f.csrf, revisie: f.revisie, v_claims_tekst_1: 'Geen resultaat, geen factuur', v_aanbod: 'Demo' },
      j,
    );
    assert.equal(resp.status, 400);
    const html = await resp.text();
    assert.match(html, /vinkje/);
    assert.match(html, /value="Geen resultaat, geen factuur"/);
    assert.equal((await profielStand(db, klantA)).open, null);

    const goed = await post(
      '/portaal/profiel/bewijs',
      { csrf: f.csrf, revisie: f.revisie, v_claims_tekst_1: 'Geen resultaat, geen factuur', v_claims_ok_1: 'ja', v_aanbod: 'Demo' },
      j,
    );
    assert.equal(goed.status, 303);
    assert.deepEqual((await profielStand(db, klantA)).open!.antwoorden['claims'], {
      claims: [{ tekst: 'Geen resultaat, geen factuur', bevestigd: true }],
    });
  });

  it('"Opslaan en vorige" bewaart en gaat terug; de laatste ronde gaat naar het overzicht', async () => {
    const { j } = await login('eva@tag.nl');
    const f = await open('doelgroep', j);
    const terug = await post('/portaal/profiel/doelgroep', { csrf: f.csrf, revisie: f.revisie, richting: 'vorige', v_regio: 'Europa' }, j);
    assert.equal(terug.headers.get('location'), '/portaal/profiel/propositie');
    assert.deepEqual((await profielStand(db, klantA)).open!.antwoorden['regio'], { keuzes: ['Europa'] });
    const b = await open('bewijs', j);
    const laatste = await post('/portaal/profiel/bewijs', { csrf: b.csrf, revisie: b.revisie, richting: 'volgende' }, j);
    assert.equal(laatste.headers.get('location'), '/portaal/profiel');
  });

  it('twee collega\'s tegelijk: de tweede krijgt een melding en de nieuwste stand, geen stille overschrijving', async () => {
    const eva = (await login('eva@tag.nl')).j;
    const fedor = (await login('fedor@tag.nl')).j;
    const fe = await open('propositie', eva);
    const ff = await open('propositie', fedor);
    await post('/portaal/profiel/propositie', { csrf: fe.csrf, revisie: fe.revisie, v_wat_verkoopt: 'Versie Eva' }, eva);
    const resp = await post('/portaal/profiel/propositie', { csrf: ff.csrf, revisie: ff.revisie, v_wat_verkoopt: 'Versie Fedor' }, fedor);
    assert.equal(resp.headers.get('location'), '/portaal/profiel/propositie');
    const html = await (await get('/portaal/profiel/propositie', fedor)).text();
    assert.match(html, /collega heeft het klantprofiel intussen bijgewerkt/);
    assert.match(html, /Versie Eva/);
    assert.equal((await profielStand(db, klantA)).open!.antwoorden['wat_verkoopt']!.tekst, 'Versie Eva');
  });

  it('klant B ziet niets van het profiel van klant A', async () => {
    const eva = (await login('eva@tag.nl')).j;
    await vulAllesIn(eva);
    const bob = (await login('bob@bolt.nl')).j;
    const html = await (await get('/portaal/profiel', bob)).text();
    assert.match(html, /Beginnen/);
    assert.doesNotMatch(html, /Sales-acceleratie/);
    assert.equal((await profielStand(db, klantB)).open, null);
  });

  it('elke POST eist het CSRF-token; zonder token wordt niets opgeslagen', async () => {
    const { j } = await login('eva@tag.nl');
    const f = await open('propositie', j);
    assert.equal((await post('/portaal/profiel/propositie', { revisie: f.revisie, v_wat_verkoopt: 'x' }, j)).status, 403);
    assert.equal((await post('/portaal/profiel/indienen', { revisie: '0' }, j)).status, 403);
    assert.equal((await post('/portaal/profiel/wijziging', {}, j)).status, 403);
    assert.equal((await profielStand(db, klantA)).open, null);
  });

  it('antwoorden worden ge-escaped getoond', async () => {
    const { j } = await login('eva@tag.nl');
    const f = await open('propositie', j);
    await post('/portaal/profiel/propositie', { csrf: f.csrf, revisie: f.revisie, v_wat_verkoopt: '<script>alert(1)</script>' }, j);
    const html = await (await get('/portaal/profiel', j)).text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it('vraag van MARKaaS: login gaat naar het profiel, de vraag staat erbij; na vaststellen "Wijziging aanvragen"', async () => {
    const eva = (await login('eva@tag.nl')).j;
    await vulAllesIn(eva);
    await dienProfielIn(eva);
    await stuurTerug(db, { clientId: klantA, vraag: 'Welke sector heeft voorrang?', klok });

    const { j, resp } = await login('fedor@tag.nl');
    assert.equal(resp.headers.get('location'), '/portaal/profiel');
    assert.match(await (await get('/portaal/', j)).text(), /MARKaaS heeft een vraag over uw klantprofiel/);
    assert.match(await (await get('/portaal/profiel', j)).text(), /Welke sector heeft voorrang\?/);
    assert.match((await open('doelgroep', j)).html, /Welke sector heeft voorrang\?/);

    await dienProfielIn(j);
    await stelVast(db, { clientId: klantA, interneAanvulling: 'GEHEIM-FILTER', door: 'rubert', klok });
    const vastgesteld = await (await get('/portaal/profiel', j)).text();
    assert.match(vastgesteld, /Uw klantprofiel is vastgesteld/);
    assert.doesNotMatch(vastgesteld, /GEHEIM-FILTER/, 'de interne aanvulling is nooit zichtbaar voor de klant');
    assert.equal((await get('/portaal/profiel/propositie', j)).headers.get('location'), '/portaal/profiel');

    const wijziging = await post('/portaal/profiel/wijziging', { csrf: veld(vastgesteld, 'csrf') }, j);
    assert.equal(wijziging.headers.get('location'), '/portaal/profiel/propositie');
    const f = await open('propositie', j);
    assert.match(f.html, /Sales-acceleratie/, 'de nieuwe versie begint met de vastgestelde antwoorden');
    const stand = await profielStand(db, klantA);
    assert.equal(stand.open!.versie, 2);
    assert.equal(stand.vastgesteld!.versie, 1);
  });

  it('onbekende ronde geeft 404', async () => {
    const { j } = await login('eva@tag.nl');
    assert.equal((await get('/portaal/profiel/bestaat-niet', j)).status, 404);
  });
});
