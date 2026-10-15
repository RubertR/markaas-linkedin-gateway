import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { vasteKlok } from '../budget/klok.ts';
import { telGebruikOpDag, verhoogGebruik } from '../budget/gebruik.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakActie, vindActie } from './acties.ts';
import { voerActieUit, type WorkerContext } from './worker.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
const UNIPILE_ACCOUNT_ID = 'unipile-abc';

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

  const client = await maakClient(db, { naam: 'Test', slug: 'test' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);
});

function basisContext(overrides: Partial<WorkerContext> = {}): WorkerContext {
  return {
    db,
    unipile,
    limieten,
    klok: vasteKlok('2026-10-06T10:00:00Z'),
    ...overrides,
  };
}

async function maakReservedeActie(opties: {
  type: 'invite' | 'message' | 'inmail' | 'profile' | 'search';
  payload: Record<string, unknown>;
}) {
  const actie = await maakActie(db, {
    accountId,
    type: opties.type,
    payload: opties.payload,
  });
  await db.query(
    `update actions set status = 'running'::action_status where id = $1`,
    [actie.id],
  );
  return (await vindActie(db, actie.id))!;
}

describe('worker — invite (succes)', () => {
  it('slaat response op en zet actie op "done"', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-123' },
    });
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-999' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.response?.invitationId, 'inv-123');
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'done');
    assert.ok(na?.uitgevoerdOp);
    assert.equal(
      (na?.unipileResponse as { invitationId?: string } | null)?.invitationId,
      'inv-123',
    );
  });

  it('leest Unipile-usage-signaal (75%) en verlaagt opbouw_factor + typeDagStop', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-2', usage: 75 },
    });
    // Account begint op 1.0 — zorg daarvoor expliciet.
    await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [accountId]);
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-998' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.usageSignaalPercentage, 75);
    assert.equal(uitkomst.typeDagStop, true);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.opbouwFactor, 0.5);
  });
});

describe('worker — invite (foutpaden)', () => {
  it('429 → actie "queued" en account in afkoeling', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 429,
      headers: { 'Retry-After': '60' },
      body: { error: 'rate_limited' },
    });
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-1' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    assert.match(uitkomst.reden!, /429|LinkedIn|pauze|afkoeling/i);
    const account = await vindAccount(db, accountId);
    assert.ok(account?.afkoelingTot);
    // Factor 0.5 als gevolg van afkoeling.
    assert.equal(account?.opbouwFactor, 0.5);
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'queued');
  });

  it('422 limit_exceeded → actie "queued" en account in afkoeling', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 422,
      body: { error: 'limit_exceeded' },
    });
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-2' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    assert.match(uitkomst.reden!, /limiet|afkoeling|limit_exceeded/i);
    const account = await vindAccount(db, accountId);
    assert.ok(account?.afkoelingTot);
  });

  it('422 already_invited_recently → actie "failed" (permanent)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 422,
      body: { error: 'already_invited_recently' },
    });
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-3' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.match(uitkomst.reden!, /recent|verzoek|opnieuw/i);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.afkoelingTot, null);
  });

  it('timeout bij invite → actie "onzeker" (nooit automatisch opnieuw) en event voor Rubert', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      delayMs: 400,
      body: { object: 'UserInvitationSent', invitation_id: 'nooit' },
    });
    const nu = new Date('2026-10-06T10:00:00Z');
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-4' },
    });
    const uitkomst = await voerActieUit(basisContext({ klok: vasteKlok(nu) }), actie);
    assert.equal(uitkomst.status, 'onzeker');
    assert.match(uitkomst.reden!, /time-?out.*mogelijk verzonden.*LinkedIn/i);
    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'onzeker');
    // Geplande herhaling is uit — alleen handmatige actie van Rubert kan dit verder brengen.
    assert.equal(na?.geplandOp, null);

    const events = await db.query<{ type: string; payload: unknown }>(
      "select type, payload from events where type = 'actie_onzeker'",
    );
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { actie_id: string; reden: string; type: string };
    assert.equal(payload.actie_id, actie.id);
    assert.equal(payload.type, 'invite');
    assert.match(payload.reden, /mogelijk verzonden/i);
  });

  it('timeout bij message → actie "onzeker"', async () => {
    fake.antwoord('POST', /^\/api\/v1\/chats\/[^/]+\/messages$/, {
      status: 200,
      delayMs: 400,
      body: { object: 'MessageSent', message_id: 'nooit' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'chat-1', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'onzeker');
    const events = await db.query<{ type: string }>(
      "select type from events where type = 'actie_onzeker'",
    );
    assert.equal(events.length, 1);
  });

  it('timeout bij inmail → actie "onzeker"', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      delayMs: 400,
      body: { object: 'ChatStarted', chat_id: 'nooit', message_id: 'nooit' },
    });
    const actie = await maakReservedeActie({
      type: 'inmail',
      payload: {
        attendeesIds: ['ACw-1'],
        tekst: 'Hoi!',
        linkedinApi: 'sales_navigator',
      },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'onzeker');
  });

  it('timeout bij profile → actie "queued" (lezen mag opnieuw)', async () => {
    fake.antwoord('GET', /^\/api\/v1\/users\//, {
      status: 200,
      delayMs: 400,
      body: { provider_id: 'ACo-9' },
    });
    const nu = new Date('2026-10-06T10:00:00Z');
    const actie = await maakReservedeActie({
      type: 'profile',
      payload: { identifier: 'john' },
    });
    const uitkomst = await voerActieUit(basisContext({ klok: vasteKlok(nu) }), actie);
    assert.equal(uitkomst.status, 'queued');
    assert.match(uitkomst.reden!, /time-?out|niet bereikbaar|5 minuten/i);
    const na = await vindActie(db, actie.id);
    assert.ok(na?.geplandOp);
    const verschilSec = (na!.geplandOp!.getTime() - nu.getTime()) / 1000;
    assert.ok(verschilSec >= 290 && verschilSec <= 310);
    // Geen event: alleen voor onzeker-overgang.
    const events = await db.query<{ aantal: string }>(
      "select count(*)::text as aantal from events where type = 'actie_onzeker'",
    );
    assert.equal(events[0]?.aantal, '0');
  });

  it('account-credentials-fout → account naar CREDENTIALS en reconnectHook aangeroepen', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 400,
      body: { error: 'account_credentials' },
    });
    let hookAangeroepen: string | null = null;
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-5' },
    });
    const uitkomst = await voerActieUit(
      basisContext({
        reconnectHook: async (aid: string) => {
          hookAangeroepen = aid;
        },
      }),
      actie,
    );
    assert.equal(uitkomst.status, 'queued');
    assert.match(uitkomst.reden!, /sessie|credentials|koppel/i);
    assert.equal(uitkomst.alleenDitAccountPauzeren, true);
    assert.equal(hookAangeroepen, accountId);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'CREDENTIALS');
    // Geen afkoeling: dit is géén LinkedIn-waarschuwing.
    assert.equal(account?.afkoelingTot, null);
  });

  it('gateway-sleutelfout (401) → signaal "stop alles", actie "queued", GEEN pauze van account', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 401,
      body: { error: 'unauthorized' },
    });
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-6' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    assert.equal(uitkomst.gatewayAuthFout, true);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'OK'); // niet gepauzeerd
    assert.equal(account?.afkoelingTot, null);
  });
});

describe('worker — message', () => {
  it('stuurt bericht via multipart en zet actie op "done"', async () => {
    fake.antwoord('POST', /^\/api\/v1\/chats\/[^/]+\/messages$/, {
      status: 200,
      body: { object: 'MessageSent', message_id: 'msg-1' },
    });

    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'chat-xyz', tekst: 'Hallo!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.response?.messageId, 'msg-1');
  });
});

describe('worker — message zonder bestaand gesprek (eerste bericht na acceptatie)', () => {
  it('start een nieuw gesprek met providerId, zonder InMail-opties, en bewaart de chatId', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      body: { object: 'ChatStarted', chat_id: 'chat-nieuw', message_id: 'msg-n' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { providerId: 'ACo-lead', tekst: 'Dank voor de connectie!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.response?.chatId, 'chat-nieuw');
    assert.equal(uitkomst.response?.messageId, 'msg-n');

    const aanroepen = fake.aanroepen.filter((a) => a.path.startsWith('/api/v1/chats'));
    assert.equal(aanroepen.length, 1, 'precies één aanroep naar Unipile');
    assert.equal(aanroepen[0]!.path, '/api/v1/chats');
    const body = aanroepen[0]!.body as Record<string, unknown>;
    assert.equal(body['attendees_ids'], 'ACo-lead');
    assert.equal(body['text'], 'Dank voor de connectie!');
    assert.equal(body['account_id'], UNIPILE_ACCOUNT_ID);
    assert.equal(body['linkedin[inmail]'], undefined, 'geen InMail-credit verbruiken');
    assert.equal(body['linkedin[api]'], undefined);

    const na = await vindActie(db, actie.id);
    assert.equal(na?.status, 'done');
    assert.equal((na?.unipileResponse as { chatId?: string } | null)?.chatId, 'chat-nieuw');
  });

  it('oude placeholder "pending:<providerId>" start ook een nieuw gesprek (geen 404 meer)', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      body: { object: 'ChatStarted', chat_id: 'chat-p', message_id: 'msg-p' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'pending:ACo-oud', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    const body = fake.aanroepen.find((a) => a.path === '/api/v1/chats')?.body as Record<string, unknown>;
    assert.equal(body['attendees_ids'], 'ACo-oud');
    assert.equal(
      fake.aanroepen.filter((a) => /\/api\/v1\/chats\/.+\/messages/.test(a.path)).length,
      0,
    );
  });

  it('zonder chatId én zonder providerId → "failed" met NL-reden, geen Unipile-aanroep', async () => {
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.match(uitkomst.reden!, /geen gesprek.*providerId/i);
    assert.equal(fake.aanroepen.length, 0);
  });

  it('"pending:" met een LinkedIn-URL in plaats van providerId → "failed", geen Unipile-aanroep', async () => {
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'pending:https://www.linkedin.com/in/x', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.equal(fake.aanroepen.length, 0);
  });

  it('429 bij nieuw gesprek → "queued" en account in afkoeling', async () => {
    fake.antwoord('POST', '/api/v1/chats', { status: 429, body: { error: 'rate_limited' } });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { providerId: 'ACo-lead', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    const account = await vindAccount(db, accountId);
    assert.ok(account?.afkoelingTot);
  });

  it('time-out bij nieuw gesprek → "onzeker" (mogelijk verzonden)', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      delayMs: 400,
      body: { object: 'ChatStarted', chat_id: 'nooit', message_id: 'nooit' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { providerId: 'ACo-lead', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'onzeker');
  });

  it('422 user_unreachable bij nieuw gesprek → "failed" (permanent)', async () => {
    fake.antwoord('POST', '/api/v1/chats', { status: 422, body: { error: 'user_unreachable' } });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { providerId: 'ACo-lead', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
  });

  it('account-credentials-fout bij nieuw gesprek → account naar CREDENTIALS, actie "queued"', async () => {
    fake.antwoord('POST', '/api/v1/chats', { status: 400, body: { error: 'account_credentials' } });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { providerId: 'ACo-lead', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'CREDENTIALS');
  });

  it('bestaand gesprek blijft via /chats/{id}/messages gaan', async () => {
    fake.antwoord('POST', /^\/api\/v1\/chats\/[^/]+\/messages$/, {
      status: 200,
      body: { object: 'MessageSent', message_id: 'msg-b' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'chat-bestaat', providerId: 'ACo-lead', tekst: 'Hoi!' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(fake.aanroepen.filter((a) => a.path === '/api/v1/chats').length, 0);
    assert.equal(uitkomst.response?.chatId, 'chat-bestaat');
  });
});

describe('worker — inmail', () => {
  it('start gesprek met InMail-vlag en zet actie op "done"', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      body: { object: 'ChatStarted', chat_id: 'chat-1', message_id: 'msg-1' },
    });
    const actie = await maakReservedeActie({
      type: 'inmail',
      payload: {
        attendeesIds: ['ACw-1'],
        tekst: 'Hallo!',
        onderwerp: 'Even voorstellen',
        linkedinApi: 'sales_navigator',
      },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.response?.chatId, 'chat-1');

    const aanroep = fake.aanroepen.find((a) => a.path.startsWith('/api/v1/chats'));
    assert.ok(aanroep);
    // multipart body wordt door hono geparsed naar object; check de inmail-vlag.
    const body = aanroep.body as Record<string, unknown>;
    assert.equal(body['linkedin[inmail]'], 'true');
  });
});

describe('worker — profile', () => {
  it('haalt profiel op, filtert contact_info/birthdate weg (AVG) en zet actie op "done"', async () => {
    fake.antwoord('GET', /^\/api\/v1\/users\//, {
      status: 200,
      body: {
        provider_id: 'ACo-9',
        public_identifier: 'john-doe',
        contact_info: { email: 'john@example.com' },
        birthdate: '1980-01-01',
      },
    });
    const actie = await maakReservedeActie({
      type: 'profile',
      payload: { identifier: 'john-doe' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    assert.equal(uitkomst.response?.provider_id, 'ACo-9');
    assert.equal(uitkomst.response?.contact_info, undefined);
    assert.equal(uitkomst.response?.birthdate, undefined);
  });
});

describe('worker — search (fase 3)', () => {
  it('voert een zoekopdracht uit via Unipile en bewaart items in de response', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: {
        items: [{ id: 'ACo-1', public_identifier: 'persoon-1' }],
        paging: { total_count: 1 },
      },
    });
    const actie = await maakReservedeActie({
      type: 'search',
      payload: { keywords: 'ceo', api: 'sales_navigator', limit: 10 },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'done');
    const items = (uitkomst.response as { items?: unknown[] })?.items ?? [];
    assert.equal(items.length, 1);
  });
});

describe('worker — ongekoppeld account', () => {
  it('weigert als het account geen unipile_account_id heeft', async () => {
    await db.query(
      `update accounts set unipile_account_id = null, status = 'CONNECTING' where id = $1`,
      [accountId],
    );
    const actie = await maakReservedeActie({
      type: 'invite',
      payload: { providerId: 'ACo-X' },
    });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.match(uitkomst.reden!, /koppel|unipile_account_id/i);
  });
});

describe('worker — openstaande_verzoeken', () => {
  async function openstaand(): Promise<number | undefined> {
    return (await vindAccount(db, accountId))?.openstaandeVerzoeken;
  }

  function inviteLukt(id = 'inv-1'): void {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: id },
    });
  }

  it('invite op "done" verhoogt de teller met 1', async () => {
    await db.query('update accounts set openstaande_verzoeken = 4 where id = $1', [accountId]);
    inviteLukt();
    const actie = await maakReservedeActie({ type: 'invite', payload: { providerId: 'ACo-o1' } });
    await voerActieUit(basisContext(), actie);
    assert.equal(await openstaand(), 5);
  });

  it('zes verstuurde invites → teller 6', async () => {
    inviteLukt();
    for (let i = 0; i < 6; i++) {
      const actie = await maakReservedeActie({ type: 'invite', payload: { providerId: `ACo-z${i}` } });
      await voerActieUit(basisContext(), actie);
    }
    assert.equal(await openstaand(), 6);
  });

  it('invite op "onzeker" (time-out) verhoogt de teller ook (veilige kant)', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      delayMs: 400,
      body: { object: 'UserInvitationSent', invitation_id: 'nooit' },
    });
    const actie = await maakReservedeActie({ type: 'invite', payload: { providerId: 'ACo-o2' } });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'onzeker');
    assert.equal(await openstaand(), 1);
  });

  it('onzeker → opnieuw goedgekeurd → done telt maar één keer', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      delayMs: 400,
      body: { object: 'UserInvitationSent', invitation_id: 'nooit' },
    });
    const actie = await maakReservedeActie({ type: 'invite', payload: { providerId: 'ACo-o3' } });
    await voerActieUit(basisContext(), actie);
    assert.equal(await openstaand(), 1);

    fake.reset();
    inviteLukt('inv-o3');
    await db.query(`update actions set status = 'running'::action_status where id = $1`, [actie.id]);
    const opnieuw = await voerActieUit(basisContext(), (await vindActie(db, actie.id))!);
    assert.equal(opnieuw.status, 'done');
    assert.equal(await openstaand(), 1);
  });

  it('message en inmail raken de teller niet', async () => {
    fake.antwoord('POST', /\/api\/v1\/chats\/.+\/messages/, {
      status: 200,
      body: { object: 'MessageSent', message_id: 'm-1' },
    });
    const actie = await maakReservedeActie({
      type: 'message',
      payload: { chatId: 'chat-1', tekst: 'hoi' },
    });
    await voerActieUit(basisContext(), actie);
    assert.equal(await openstaand(), 0);
  });

  it('429, 422 en failed laten de teller ongemoeid', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 429, body: { error: 'rate_limited' } });
    const a = await maakReservedeActie({ type: 'invite', payload: { providerId: 'ACo-o4' } });
    assert.equal((await voerActieUit(basisContext(), a)).status, 'queued');

    fake.reset();
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 422,
      body: { error: 'already_connected' },
    });
    const b = await maakReservedeActie({ type: 'invite', payload: { providerId: 'ACo-o5' } });
    assert.equal((await voerActieUit(basisContext(), b)).status, 'failed');
    assert.equal(await openstaand(), 0);
  });
});

describe('worker — terugboeken als Unipile vóór LinkedIn weigert (SPEC §5.1)', () => {
  const DAG = '2026-10-06';

  async function zoekActieMetReservering() {
    await verhoogGebruik(db, accountId, 'search', DAG, 1);
    return maakReservedeActie({
      type: 'search',
      payload: { api: 'sales_navigator', filters: { company: [{ keywords: 'x' }] } },
    });
  }

  function zoekAntwoord(status: number, body: unknown, delayMs?: number) {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status,
      body,
      ...(delayMs ? { delayMs } : {}),
    });
  }

  it('400 invalid_parameters → "failed", verbruik teruggeboekt, geen uitgevoerd_op', async () => {
    zoekAntwoord(400, { status: 400, type: 'errors/invalid_parameters', title: 'Invalid parameters' });
    const actie = await zoekActieMetReservering();
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.equal(uitkomst.teruggeboekt, true);
    assert.match(uitkomst.reden!, /niet verbruikt/);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 0);
    const opgeslagen = await vindActie(db, actie.id);
    assert.equal(opgeslagen?.status, 'failed');
    assert.ok(opgeslagen?.teruggeboektOp);
    assert.equal(opgeslagen?.uitgevoerdOp, null);
  });

  it('400 target_audience_too_small → "failed", telt wél mee', async () => {
    zoekAntwoord(400, { status: 400, type: 'errors/target_audience_too_small' });
    const actie = await zoekActieMetReservering();
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.notEqual(uitkomst.teruggeboekt, true);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
    assert.equal((await vindActie(db, actie.id))?.teruggeboektOp, null);
  });

  it('400 met onbekend type → telt mee', async () => {
    zoekAntwoord(400, { status: 400, type: 'errors/iets_nieuws' });
    const actie = await zoekActieMetReservering();
    await voerActieUit(basisContext(), actie);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
  });

  it('429 → telt mee en account in afkoeling', async () => {
    zoekAntwoord(429, { status: 429 });
    const actie = await zoekActieMetReservering();
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'queued');
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
    assert.ok((await vindAccount(db, accountId))?.afkoelingTot);
  });

  it('time-out → telt mee', async () => {
    zoekAntwoord(200, { items: [] }, 400);
    const actie = await zoekActieMetReservering();
    await voerActieUit(basisContext(), actie);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
  });

  it('422 → telt mee', async () => {
    zoekAntwoord(422, { status: 422, type: 'errors/limit_exceeded' });
    const actie = await zoekActieMetReservering();
    await voerActieUit(basisContext(), actie);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
  });

  it('vierde terugboeking op één dag → telt wél mee, reden zegt het', async () => {
    zoekAntwoord(400, { status: 400, type: 'errors/invalid_parameters' });
    const max = limieten.terugboeken.max_per_dag_per_type;
    for (let i = 0; i < max; i++) {
      const uit = await voerActieUit(basisContext(), await zoekActieMetReservering());
      assert.equal(uit.teruggeboekt, true);
    }
    const laatste = await voerActieUit(basisContext(), await zoekActieMetReservering());
    assert.equal(laatste.status, 'failed');
    assert.notEqual(laatste.teruggeboekt, true);
    assert.match(laatste.reden!, /telt mee/);
    assert.equal(await telGebruikOpDag(db, accountId, 'search', DAG), 1);
  });

  it('bericht zonder ontvanger (eigen payloadfout) → verbruik teruggeboekt', async () => {
    await verhoogGebruik(db, accountId, 'message', DAG, 1);
    const actie = await maakReservedeActie({ type: 'message', payload: { tekst: 'Hoi' } });
    const uitkomst = await voerActieUit(basisContext(), actie);
    assert.equal(uitkomst.status, 'failed');
    assert.equal(uitkomst.teruggeboekt, true);
    assert.equal(await telGebruikOpDag(db, accountId, 'message', DAG), 0);
  });
});
