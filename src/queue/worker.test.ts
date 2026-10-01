import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { vasteKlok } from '../budget/klok.ts';
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
