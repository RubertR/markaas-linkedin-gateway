import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import { zetAccountStatusDoorGateway } from '../register/accountauth.ts';
import { verwerkKoppelCallback } from '../register/koppelflow.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { keurActieGoed, maakActie, vindActie, zetActieStatus } from './acties.ts';
import { vastePauze } from './pauze.ts';
import { voerPlannerTickUit, type PlannerContext } from './planner.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
let tweedeAccountId: string;
const UNIPILE_ACCOUNT_ID = 'unipile-acc-1';
const UNIPILE_ACCOUNT_ID_2 = 'unipile-acc-2';

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'geheim', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const client = await maakClient(db, { naam: 'Test', slug: 'test', abonnementVereist: false });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);
  const account2 = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert #2',
    abonnement: 'salesnav_core',
  });
  tweedeAccountId = account2.id;
  await markeerAccountGekoppeld(db, tweedeAccountId, UNIPILE_ACCOUNT_ID_2);
});

function basisContext(overrides: Partial<PlannerContext> = {}): PlannerContext {
  // 2026-10-06 10:00 UTC = 12:00 Europe/Amsterdam → werkuren.
  return {
    db,
    unipile,
    limieten,
    klok: vasteKlok('2026-10-06T10:00:00Z'),
    pauzeKiezer: vastePauze(120),
    ...overrides,
  };
}

async function maakGoedgekeurdeInvite(opties: {
  accountId: string;
  providerId: string;
  aangemaaktOp?: string;
  geplandOp?: string | null;
}) {
  const actie = await maakActie(db, {
    accountId: opties.accountId,
    type: 'invite',
    payload: { providerId: opties.providerId },
  });
  await keurActieGoed(db, actie.id, 'rubert', new Date('2026-10-01T10:00:00Z'));
  if (opties.aangemaaktOp !== undefined) {
    await db.query(
      `update actions set aangemaakt_op = $2 where id = $1`,
      [actie.id, opties.aangemaaktOp],
    );
  }
  if (opties.geplandOp !== undefined) {
    await db.query(
      `update actions set gepland_op = $2 where id = $1`,
      [actie.id, opties.geplandOp],
    );
  }
  return (await vindActie(db, actie.id))!;
}

describe('planner — kiest oudste approved actie per account', () => {
  it('pakt per account de oudste approved actie en voert haar uit', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const oud = await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-oud',
      aangemaaktOp: '2026-10-01T08:00:00Z',
    });
    const nieuw = await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-nieuw',
      aangemaaktOp: '2026-10-01T09:00:00Z',
    });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.actieId, oud.id);
    assert.equal(resultaat.details[0]?.resultaat, 'done');

    assert.equal((await vindActie(db, oud.id))?.status, 'done');
    assert.equal((await vindActie(db, nieuw.id))?.status, 'approved');
  });

  it('neemt per tick één actie per account (verschillende accounts parallel)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const a1 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-1' });
    const a2 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-2' });
    const b1 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-1' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 2);
    const uitgevoerd = resultaat.details.map((d) => d.actieId).sort();
    assert.deepEqual(
      uitgevoerd.sort(),
      [a1.id, b1.id].sort(),
    );
    assert.equal((await vindActie(db, a2.id))?.status, 'approved');
  });

  it('overslaat acties waarvan gepland_op in de toekomst ligt', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1' },
    }));
    await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-later',
      geplandOp: '2026-10-07T10:00:00Z',
    });
    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 0);
  });

  it('overslaat acties met status "draft"', async () => {
    await maakActie(db, {
      accountId,
      type: 'invite',
      payload: { providerId: 'ACo-draft' },
    });
    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 0);
  });

  it('overslaat acties met status "onzeker" (vereisen handmatige verificatie)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const onzeker = await maakActie(db, {
      accountId,
      type: 'invite',
      payload: { providerId: 'ACo-onzeker' },
    });
    await db.query(
      `update actions set status = 'onzeker'::action_status,
                          reden = 'Time-out: mogelijk verzonden...'
       where id = $1`,
      [onzeker.id],
    );
    // Een gewone approved actie ernaast — die moet wél opgepakt worden.
    const normaal = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-ok' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.actieId, normaal.id);
    assert.equal((await vindActie(db, onzeker.id))?.status, 'onzeker');
  });
});

describe('planner — budget', () => {
  it('bij wachtrij: zet actie terug op "queued" met reden en nieuwe gepland_op', async () => {
    // Dagnorm invite salesnav_core = 20 (opbouw 1.0). Verbruik vandaag al 20.
    await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [accountId]);
    await db.query(
      `insert into usage(account_id, type, dag, aantal)
       values ($1, 'invite'::action_type, '2026-10-06'::date, 20)`,
      [accountId],
    );
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-vol' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.resultaat, 'queued');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.ok(na?.geplandOp);
    assert.ok(na.geplandOp.getTime() > new Date('2026-10-06T10:00:00Z').getTime());
    assert.match(na.reden!, /dagnorm|budget|dag/i);
  });

  it('bij weigering (PERMISSIONS): zet actie op "rejected"', async () => {
    await db.query(
      `update accounts set status = 'PERMISSIONS'::account_status where id = $1`,
      [accountId],
    );
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-stop' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.verwerkt, 1);
    assert.equal(resultaat.details[0]?.resultaat, 'rejected');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'rejected');
    assert.match(na?.reden ?? '', /permissies/i);
  });
});

describe('planner — gelijktijdigheid', () => {
  it('twee planners parallel pakken niet dezelfde actie', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: `inv-${Math.random()}` },
    }));
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-samen' });

    const [r1, r2] = await Promise.all([
      voerPlannerTickUit(basisContext()),
      voerPlannerTickUit(basisContext()),
    ]);
    const totaal = r1.verwerkt + r2.verwerkt;
    assert.equal(totaal, 1, 'actie mag maar één keer verwerkt zijn');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'done');
  });
});

describe('planner — foutpaden via worker', () => {
  it('worker 429 → actie "queued" + account in afkoeling', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 429,
      headers: { 'Retry-After': '60' },
      body: { error: 'rate_limited' },
    });
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-429' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.details[0]?.resultaat, 'queued');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    const account = await vindAccount(db, accountId);
    assert.ok(account?.afkoelingTot);
  });

  it('gateway-sleutelfout (401 + mislukte controle-aanroep) stopt de planner (gatewayGestopt=true, overige acties niet aangeraakt)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 401,
      body: { error: 'unauthorized' },
    });
    fake.antwoord('GET', '/api/v1/accounts', { status: 401, body: { error: 'unauthorized' } });
    const a1 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-A' });
    const b1 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-B' });

    const resultaat = await voerPlannerTickUit(basisContext());
    assert.equal(resultaat.gatewayGestopt, true);
    // Minimaal één van de twee bleef onaangeraakt.
    const na1 = await vindActie(db, a1.id);
    const na2 = await vindActie(db, b1.id);
    const statussen = [na1?.status, na2?.status];
    assert.ok(
      statussen.includes('approved'),
      `verwachte een onaangeraakt approved; kreeg ${JSON.stringify(statussen)}`,
    );
  });
});

describe('planner — 401/403 per account: andere accounts lopen door (SPEC §6a)', () => {
  /** Eerste account krijgt `fout`, het tweede een geslaagde invite. */
  function inviteAntwoordPerAccount(fout: { status: number; body: unknown }): void {
    fake.antwoord('POST', '/api/v1/users/invite', (aanroep) => {
      const body = aanroep.body as { account_id?: string } | undefined;
      return body?.account_id === UNIPILE_ACCOUNT_ID
        ? fout
        : { status: 200, body: { object: 'UserInvitationSent', invitation_id: 'inv-ok' } };
    });
  }

  const GEVALLEN: Array<{ naam: string; fout: { status: number; body: unknown }; status: string }> = [
    {
      naam: 'CREDENTIALS (401 disconnected_account)',
      fout: { status: 401, body: { status: 401, type: 'errors/disconnected_account' } },
      status: 'CREDENTIALS',
    },
    {
      naam: 'STOPPED (403 account_restricted)',
      fout: { status: 403, body: { status: 403, type: 'errors/account_restricted' } },
      status: 'STOPPED',
    },
    {
      naam: 'ERROR (401 zonder type, controle-aanroep geslaagd)',
      fout: { status: 401, body: { error: 'unauthorized' } },
      status: 'ERROR',
    },
  ];

  for (const geval of GEVALLEN) {
    it(`eerste account op ${geval.naam}; tweede account gaat in dezelfde tick door`, async () => {
      inviteAntwoordPerAccount(geval.fout);
      fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });
      const a1 = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-A' });
      const b1 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-B' });

      const resultaat = await voerPlannerTickUit(basisContext());
      assert.equal(resultaat.gatewayGestopt, false);
      assert.equal(resultaat.verwerkt, 2);
      assert.equal((await vindActie(db, a1.id))?.status, 'queued');
      assert.equal((await vindActie(db, b1.id))?.status, 'done');
      assert.equal((await vindAccount(db, accountId))?.status, geval.status);
      assert.equal((await vindAccount(db, tweedeAccountId))?.status, 'OK');
    });
  }

  it('volgende tick: het stilgelegde account krijgt geen Unipile-aanroep, het tweede account loopt door', async () => {
    inviteAntwoordPerAccount({ status: 403, body: { status: 403, type: 'errors/account_restricted' } });
    await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-A' });
    await voerPlannerTickUit(basisContext());
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');

    fake.aanroepen.length = 0;
    const b2 = await maakGoedgekeurdeInvite({ accountId: tweedeAccountId, providerId: 'ACw-C' });
    const r2 = await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T10:30:00Z') }));
    assert.equal(r2.gatewayGestopt, false);
    assert.equal((await vindActie(db, b2.id))?.status, 'done');
    const naarEerste = fake.aanroepen.filter(
      (a) => (a.body as { account_id?: string } | undefined)?.account_id === UNIPILE_ACCOUNT_ID,
    );
    assert.equal(naarEerste.length, 0, 'geen LinkedIn-verkeer voor een STOPPED account');
  });
});

describe('planner — betaalpoort (SPEC §14.4)', () => {
  it('klant met abonnementsplicht zonder abonnement: invite blijft geparkeerd (queued) met NL-reden, geen Unipile-aanroep', async () => {
    await db.query("update clients set abonnement_vereist = true where slug = 'test'");
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-x' });
    const r = await voerPlannerTickUit(basisContext());
    assert.equal(r.details[0]?.resultaat, 'queued');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.equal(
      na?.reden,
      'Abonnement niet actief: de klant moet in het klantportaal een abonnement starten.',
    );
    // Over een uur opnieuw beoordelen (standaardWachtMinuten('abonnement') = 60).
    assert.equal(na?.geplandOp?.toISOString(), '2026-10-06T11:00:00.000Z');
    assert.equal(fake.aanroepen.length, 0);
  });

  it('na het starten van een abonnement gaat de geparkeerde actie alsnog door', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', () => ({
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-later' },
    }));
    const [c] = await db.query<{ id: string }>("update clients set abonnement_vereist = true where slug = 'test' returning id");
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-y' });
    await voerPlannerTickUit(basisContext());
    assert.equal((await vindActie(db, actie.id))?.status, 'queued');
    await db.query("insert into subscriptions(client_id, status) values ($1, 'trialing')", [c!.id]);
    await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T11:05:00Z') }));
    assert.equal((await vindActie(db, actie.id))?.status, 'done');
  });
});

describe('planner — account op pauze: wachtende acties blijven bewaard (SPEC §6b)', () => {
  const T0 = new Date('2026-10-06T10:00:00Z');
  const DAG = 86_400_000;

  async function zetStatus(status: 'CREDENTIALS' | 'ERROR' | 'STOPPED'): Promise<void> {
    await zetAccountStatusDoorGateway(db, accountId, status, { reden: 'test' }, T0);
  }

  async function usageTotaal(): Promise<number> {
    const [r] = await db.query<{ n: number }>(
      'select coalesce(sum(aantal), 0)::int as n from usage where account_id = $1',
      [accountId],
    );
    return Number(r?.n);
  }

  function naarEerste(): number {
    return fake.aanroepen.filter(
      (a) => (a.body as { account_id?: string } | undefined)?.account_id === UNIPILE_ACCOUNT_ID,
    ).length;
  }

  for (const status of ['CREDENTIALS', 'ERROR', 'STOPPED'] as const) {
    it(`${status}: goedgekeurde invite, message en inmail blijven queued, 60 minuten later opnieuw, geen Unipile-aanroep, geen verbruik`, async () => {
      await zetStatus(status);
      for (const type of ['invite', 'message', 'inmail'] as const) {
        await db.query('delete from actions');
        const actie = await maakActie(db, { accountId, type, payload: { providerId: 'ACo-p', tekst: 'Hoi' } });
        await keurActieGoed(db, actie.id, 'rubert', T0);
        const r = await voerPlannerTickUit(basisContext());
        assert.equal(r.details[0]?.resultaat, 'queued', `${status}/${type}`);
        const na = await vindActie(db, actie.id);
        assert.equal(na?.status, 'queued');
        assert.equal(na?.goedgekeurdDoor, 'rubert');
        assert.equal(na?.geplandOp?.toISOString(), new Date(T0.getTime() + 60 * 60_000).toISOString());
        assert.equal(na?.pauzeGeparkeerdSinds?.toISOString(), T0.toISOString());
        assert.match(na?.reden ?? '', /geparkeerd/);
      }
      assert.equal(naarEerste(), 0);
      assert.equal(await usageTotaal(), 0);
    });
  }

  it('CREDENTIALS: invite blijft queued en loopt door na RECONNECTED', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-na-reconnect' },
    });
    await zetStatus('CREDENTIALS');
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-wacht' });

    await voerPlannerTickUit(basisContext());
    assert.equal((await vindActie(db, actie.id))?.status, 'queued');
    // Tweede tick binnen het uur: niet opnieuw aan de beurt.
    const binnen = await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T10:30:00Z') }));
    assert.equal(binnen.verwerkt, 0);
    assert.equal(naarEerste(), 0);

    const cb = await verwerkKoppelCallback(
      db,
      { status: 'RECONNECTED', account_id: UNIPILE_ACCOUNT_ID },
      { nu: new Date('2026-10-06T10:40:00Z') },
    );
    assert.equal(cb.verwerkt, true);
    assert.equal((await vindAccount(db, accountId))?.status, 'OK');

    const r = await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T11:01:00Z') }));
    assert.equal(r.details[0]?.resultaat, 'done');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'done');
    assert.equal(na?.pauzeGeparkeerdSinds, null);
    assert.equal(naarEerste(), 1);
  });

  it('STOPPED door de gateway: na RECONNECTED blijft de actie geparkeerd', async () => {
    await zetStatus('STOPPED');
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-stop' });
    await voerPlannerTickUit(basisContext());
    await verwerkKoppelCallback(db, { status: 'RECONNECTED', account_id: UNIPILE_ACCOUNT_ID }, { nu: T0 });
    assert.equal((await vindAccount(db, accountId))?.status, 'STOPPED');
    await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T11:01:00Z') }));
    assert.equal((await vindActie(db, actie.id))?.status, 'queued');
    assert.equal(naarEerste(), 0);
  });

  it(`een geparkeerde actie vervalt na account_pauze.max_parkeer_dagen (rejected, "account stond te lang op pauze")`, async () => {
    const maxDagen = limieten.account_pauze.max_parkeer_dagen;
    assert.equal(maxDagen, 14);
    await zetStatus('CREDENTIALS');
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-oud' });

    await voerPlannerTickUit(basisContext());
    // Net vóór de grens: nog steeds geparkeerd, ijkpunt blijft het eerste parkeermoment.
    const bijna = new Date(T0.getTime() + maxDagen * DAG - 60_000);
    await voerPlannerTickUit(basisContext({ klok: vasteKlok(bijna) }));
    let na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.equal(na?.pauzeGeparkeerdSinds?.toISOString(), T0.toISOString());

    // Volgende herbeoordeling (60 minuten later) valt voorbij de grens.
    const voorbij = new Date(bijna.getTime() + 61 * 60_000);
    const r = await voerPlannerTickUit(basisContext({ klok: vasteKlok(voorbij) }));
    assert.equal(r.details[0]?.resultaat, 'rejected');
    na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'rejected');
    assert.match(na?.reden ?? '', /^account stond te lang op pauze/);
    assert.match(na?.reden ?? '', /14 dagen/);
    assert.equal(naarEerste(), 0);
    assert.equal(await usageTotaal(), 0);
  });

  it('ijkpunt is het eerste parkeermoment om de pauze, niet goedkeuring of aanmaak', async () => {
    // Al 20 dagen geleden goedgekeurd en aangemaakt (wachtte op iets anders).
    const actie = await maakGoedgekeurdeInvite({
      accountId,
      providerId: 'ACo-lang',
      aangemaaktOp: '2026-09-16T10:00:00Z',
    });
    await db.query(`update actions set goedgekeurd_op = '2026-09-16T10:00:00Z' where id = $1`, [actie.id]);
    await zetStatus('ERROR');
    await voerPlannerTickUit(basisContext());
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.equal(na?.pauzeGeparkeerdSinds?.toISOString(), T0.toISOString());
  });

  it('ijkpunt wordt gewist als de actie om een andere reden wacht; een nieuwe pauze telt opnieuw', async () => {
    await zetStatus('CREDENTIALS');
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-reset' });
    await voerPlannerTickUit(basisContext());
    assert.ok((await vindActie(db, actie.id))?.pauzeGeparkeerdSinds);

    // Account weer OK, maar dagbudget vol → wachtrij om dagbudget.
    await db.query(`update accounts set status = 'OK', opbouw_factor = 1.0 where id = $1`, [accountId]);
    await db.query(
      `insert into usage(account_id, type, dag, aantal) values ($1, 'invite'::action_type, '2026-10-06'::date, 20)`,
      [accountId],
    );
    await voerPlannerTickUit(basisContext({ klok: vasteKlok('2026-10-06T11:01:00Z') }));
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
    assert.match(na?.reden ?? '', /Dagnorm/);
    assert.equal(na?.pauzeGeparkeerdSinds, null);
  });

  it('search en profile in de wachtrij worden op een account met pauze niet geparkeerd maar rejected, zonder verbruik', async () => {
    await zetStatus('STOPPED');
    const search = await maakActie(db, { accountId, type: 'search', payload: { keywords: 'x' }, directApproved: true });
    await zetActieStatus(db, search.id, 'queued');
    await voerPlannerTickUit(basisContext());
    const na = await vindActie(db, search.id);
    assert.equal(na?.status, 'rejected');
    assert.match(na?.reden ?? '', /niet geparkeerd.*geen budget verbruikt/);
    assert.equal(await usageTotaal(), 0);
    assert.equal(naarEerste(), 0);
  });

  it('PERMISSIONS blijft weigeren (rejected)', async () => {
    await db.query(`update accounts set status = 'PERMISSIONS' where id = $1`, [accountId]);
    const actie = await maakGoedgekeurdeInvite({ accountId, providerId: 'ACo-perm' });
    await voerPlannerTickUit(basisContext());
    assert.equal((await vindActie(db, actie.id))?.status, 'rejected');
  });
});
