import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';

import { maakUnipileClient } from './client.ts';
import {
  Unipile422Fout,
  UnipileAccountCredentialsFout,
  UnipileGatewayAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
} from './errors.ts';

const GEHEIME_SLEUTEL = 'geheime-sleutel-mag-nooit-lekken';

let fake: FakeUnipile;

before(async () => {
  fake = await startFakeUnipile();
});

after(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.reset();
});

function maakClient(overrides: { timeoutMs?: number } = {}) {
  return maakUnipileClient({
    baseUrl: fake.baseUrl,
    apiKey: GEHEIME_SLEUTEL,
    ...(overrides.timeoutMs !== undefined ? { timeoutMs: overrides.timeoutMs } : {}),
  });
}

describe('UnipileClient — algemeen', () => {
  it('stuurt X-API-KEY mee bij elke aanroep', async () => {
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });
    const client = maakClient();
    await client.haalAccounts();
    assert.equal(fake.aanroepen.length, 1);
    assert.equal(fake.aanroepen[0]?.headers['x-api-key'], GEHEIME_SLEUTEL);
  });

  it('lekt de API-sleutel niet in foutmeldingen bij een 500', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 500,
      body: { error: 'boom' },
    });
    const client = maakClient();
    try {
      await client.haalAccounts();
      assert.fail('had moeten falen');
    } catch (err) {
      assert.ok(err instanceof UnipileTijdelijkeFout);
      assert.doesNotMatch((err as Error).message, new RegExp(GEHEIME_SLEUTEL));
    }
  });

  it('vertaalt 429 met Retry-After naar UnipileTijdelijkeFout', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 429,
      headers: { 'Retry-After': '60' },
      body: { error: 'rate_limited' },
    });
    const client = maakClient();
    await assert.rejects(
      client.stuurInvite({ accountId: 'acc-1', providerId: 'ACo123' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileTijdelijkeFout);
        assert.equal((err as UnipileTijdelijkeFout).retryAfterSeconden, 60);
        assert.doesNotMatch(err.message, new RegExp(GEHEIME_SLEUTEL));
        return true;
      },
    );
  });

  it('vertaalt time-out naar UnipileTimeoutFout', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 200,
      body: { items: [] },
      delayMs: 500,
    });
    const client = maakClient({ timeoutMs: 80 });
    await assert.rejects(client.haalAccounts(), UnipileTimeoutFout);
  });

  it('vertaalt 401 naar UnipileGatewayAuthFout (API-sleutel, gateway-breed)', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 401,
      body: { error: 'unauthorized' },
    });
    const client = maakClient();
    await assert.rejects(client.haalAccounts(), (err: Error) => {
      assert.ok(err instanceof UnipileGatewayAuthFout);
      assert.equal(err.soort, 'api_sleutel');
      assert.match(err.message, /API-sleutel/i);
      assert.match(err.message, /gateway stopt/i);
      assert.match(err.message, /accounts NIET pauzeren/i);
      return true;
    });
  });

  it('vertaalt 403 ook naar UnipileGatewayAuthFout', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 403,
      body: { error: 'forbidden' },
    });
    const client = maakClient();
    await assert.rejects(client.haalAccounts(), UnipileGatewayAuthFout);
  });

  it('herkent een expliciete account-credentials code in het antwoord en geeft accountId mee', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 422,
      body: { type: 'errors/account_credentials', detail: 'account_credentials' },
    });
    const client = maakClient();
    await assert.rejects(
      client.stuurInvite({ accountId: 'acc-42', providerId: 'ACo1' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileAccountCredentialsFout);
        assert.equal((err as UnipileAccountCredentialsFout).accountId, 'acc-42');
        assert.equal((err as UnipileAccountCredentialsFout).code, 'account_credentials');
        assert.equal(err.soort, 'account_credentials');
        assert.match(err.message, /account acc-42/);
        assert.match(err.message, /Alleen dit account pauzeren/i);
        return true;
      },
    );
  });

  it('herkent disconnected_account als account-credentials signaal', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 400,
      body: { error: 'disconnected_account' },
    });
    const client = maakClient();
    await assert.rejects(
      client.stuurInvite({ accountId: 'acc-7', providerId: 'ACo1' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileAccountCredentialsFout);
        assert.equal((err as UnipileAccountCredentialsFout).code, 'disconnected_account');
        return true;
      },
    );
  });

  it('geeft géén accountId mee als de aanroep geen account-context heeft (bijv. haalAccounts)', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 422,
      body: { detail: 'session_expired' },
    });
    const client = maakClient();
    await assert.rejects(client.haalAccounts(), (err: Error) => {
      assert.ok(err instanceof UnipileAccountCredentialsFout);
      assert.equal((err as UnipileAccountCredentialsFout).accountId, undefined);
      assert.match(err.message, /dit account/i);
      return true;
    });
  });
});

describe('UnipileClient — haalAccounts', () => {
  it('geeft de items-array terug', async () => {
    fake.antwoord('GET', '/api/v1/accounts', {
      status: 200,
      body: {
        items: [
          { id: 'acc-1', type: 'LINKEDIN', sources: [{ status: 'OK' }] },
          { id: 'acc-2', type: 'LINKEDIN', sources: [{ status: 'CREDENTIALS' }] },
        ],
      },
    });
    const client = maakClient();
    const accounts = await client.haalAccounts();
    assert.equal(accounts.length, 2);
    assert.equal(accounts[0]?.id, 'acc-1');
    assert.equal(accounts[1]?.sources?.[0]?.status, 'CREDENTIALS');
  });
});

describe('UnipileClient — haalWebhooks', () => {
  it('volgt de cursor tot alle pagina’s binnen zijn', async () => {
    let pagina = 0;
    fake.antwoord('GET', '/api/v1/webhooks', () => {
      pagina++;
      return pagina === 1
        ? {
            status: 200,
            body: {
              object: 'WebhookList',
              items: [{ id: 'w1', name: 'een', request_url: 'https://a', enabled: true }],
              cursor: 'volgende',
            },
          }
        : {
            status: 200,
            body: {
              object: 'WebhookList',
              items: [{ id: 'w2', name: 'twee', request_url: 'https://b', enabled: false }],
              cursor: null,
            },
          };
    });
    const webhooks = await maakClient().haalWebhooks();
    assert.deepEqual(webhooks.map((w) => w.name), ['een', 'twee']);
    assert.equal(fake.aanroepen.length, 2);
    assert.match(fake.aanroepen[1]!.path, /cursor=volgende/);
  });

  it('vertaalt 401 naar UnipileGatewayAuthFout', async () => {
    fake.antwoord('GET', '/api/v1/webhooks', { status: 401, body: { error: 'nope' } });
    await assert.rejects(maakClient().haalWebhooks(), UnipileGatewayAuthFout);
  });
});

describe('UnipileClient — maakWebhook', () => {
  it('stuurt request_url, source, events, name, format, enabled en headers als key/value', async () => {
    fake.antwoord('POST', '/api/v1/webhooks', {
      status: 201,
      body: { object: 'WebhookCreated', webhook_id: 'wh-1' },
    });
    const uit = await maakClient().maakWebhook({
      naam: 'gateway-relaties',
      requestUrl: 'https://gateway.example/webhooks/unipile',
      bron: 'users',
      events: ['new_relation'],
      headers: { 'x-webhook-secret': 'geheim' },
    });
    assert.equal(uit.webhookId, 'wh-1');
    assert.deepEqual(fake.aanroepen[0]?.body, {
      name: 'gateway-relaties',
      request_url: 'https://gateway.example/webhooks/unipile',
      source: 'users',
      events: ['new_relation'],
      format: 'json',
      enabled: true,
      headers: [{ key: 'x-webhook-secret', value: 'geheim' }],
    });
  });

  it('vertaalt 429 naar UnipileTijdelijkeFout met Retry-After', async () => {
    fake.antwoord('POST', '/api/v1/webhooks', {
      status: 429,
      headers: { 'Retry-After': '30' },
      body: { error: 'rate_limited' },
    });
    await assert.rejects(
      maakClient().maakWebhook({
        naam: 'x',
        requestUrl: 'https://x',
        bron: 'users',
        events: ['new_relation'],
      }),
      (err: Error) => {
        assert.ok(err instanceof UnipileTijdelijkeFout);
        assert.equal((err as UnipileTijdelijkeFout).retryAfterSeconden, 30);
        return true;
      },
    );
  });
});

describe('UnipileClient — maakKoppellink', () => {
  it('bouwt de body voor type "create" met LINKEDIN, single_use en cookie_auth uit', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/xyz' },
    });
    const client = maakClient();
    const vervalt = new Date('2026-10-01T00:00:00Z');
    const res = await client.maakKoppellink({
      type: 'create',
      naam: 'account-42',
      notifyUrl: 'https://gateway.example/webhooks/unipile',
      vervaltOp: vervalt,
    });
    assert.equal(res.url, 'https://account.unipile.com/link/xyz');
    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['type'], 'create');
    assert.deepEqual(body['providers'], ['LINKEDIN']);
    assert.deepEqual(body['disabled_options'], ['cookie_auth']);
    assert.equal(body['expiresOn'], '2026-10-01T00:00:00.000Z');
    assert.equal(body['name'], 'account-42');
    assert.equal(body['notify_url'], 'https://gateway.example/webhooks/unipile');
    assert.equal(body['single_use'], true);
  });

  it('gebruikt reconnect_account bij type "reconnect" en geen providers', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/abc' },
    });
    const client = maakClient();
    await client.maakKoppellink({
      type: 'reconnect',
      naam: 'account-42',
      notifyUrl: 'https://gateway.example/webhooks/unipile',
      vervaltOp: new Date('2026-10-01T00:00:00Z'),
      reconnectAccountId: 'unipile-abc-def',
    });
    const body = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(body['type'], 'reconnect');
    assert.equal(body['reconnect_account'], 'unipile-abc-def');
    assert.equal(body['providers'], undefined);
  });

  it('gooit een fout als reconnect zonder reconnectAccountId komt', async () => {
    const client = maakClient();
    await assert.rejects(
      client.maakKoppellink({
        type: 'reconnect',
        naam: 'x',
        notifyUrl: 'https://y',
        vervaltOp: new Date(),
      }),
      /reconnectAccountId/,
    );
  });
});

describe('UnipileClient — haalProfiel (AVG-filter)', () => {
  it('filtert contact_info en birthdate standaard weg', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/[^?]+/, {
      status: 200,
      body: {
        provider_id: 'ACo123',
        public_identifier: 'jan-jansen',
        first_name: 'Jan',
        last_name: 'Jansen',
        contact_info: { email: 'prive@voorbeeld.nl', mobile: '0612345678' },
        birthdate: { day: 1, month: 4 },
        work_experience: [{ company: 'Voorbeeld BV' }],
      },
    });
    const client = maakClient();
    const profiel = await client.haalProfiel({
      accountId: 'acc-1',
      identifier: 'jan-jansen',
    });
    assert.equal((profiel as Record<string, unknown>)['contact_info'], undefined);
    assert.equal((profiel as Record<string, unknown>)['birthdate'], undefined);
    assert.equal(profiel['first_name'], 'Jan');
    assert.equal(profiel['provider_id'], 'ACo123');
  });

  it('houdt contact_info en birthdate wél als filterAvg=false', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/.*/, {
      status: 200,
      body: {
        provider_id: 'ACo1',
        contact_info: { email: 'x@y' },
        birthdate: { day: 1 },
      },
    });
    const client = maakClient();
    const profiel = await client.haalProfiel({
      accountId: 'acc-1',
      identifier: 'x',
      filterAvg: false,
    });
    assert.deepEqual(profiel['contact_info'], { email: 'x@y' });
    assert.deepEqual(profiel['birthdate'], { day: 1 });
  });

  it('stuurt account_id, linkedin_sections=*_preview en notify=false in de query', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/.*/, {
      status: 200,
      body: { provider_id: 'x' },
    });
    const client = maakClient();
    await client.haalProfiel({ accountId: 'acc-1', identifier: 'jan-jansen' });
    const pad = fake.aanroepen[0]?.path ?? '';
    assert.match(pad, /account_id=acc-1/);
    assert.match(pad, /linkedin_sections=(%2A|\*)_preview/);
    assert.match(pad, /notify=false/);
  });
});

describe('UnipileClient — stuurInvite', () => {
  it('stuurt JSON met account_id, provider_id en message', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1' },
    });
    const client = maakClient();
    const res = await client.stuurInvite({
      accountId: 'acc-1',
      providerId: 'ACo123',
      message: 'Hoi, leuk om te connecten.',
    });
    assert.equal(res.invitationId, 'inv-1');
    const call = fake.aanroepen[0];
    assert.match(call?.headers['content-type'] ?? '', /application\/json/);
    assert.deepEqual(call?.body, {
      account_id: 'acc-1',
      provider_id: 'ACo123',
      message: 'Hoi, leuk om te connecten.',
    });
  });

  it('leest usage=75 uit en geeft het terug als UsageSignaal', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1', usage: 75 },
    });
    const client = maakClient();
    const res = await client.stuurInvite({ accountId: 'acc-1', providerId: 'ACo1' });
    assert.deepEqual(res.usage, { percentage: 75 });
  });

  it('accepteert usage als string ("90%")', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1', usage: '90%' },
    });
    const client = maakClient();
    const res = await client.stuurInvite({ accountId: 'acc-1', providerId: 'ACo1' });
    assert.deepEqual(res.usage, { percentage: 90 });
  });

  it('negeert usage-waarden die niet 50/75/90/95 zijn', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 200,
      body: { object: 'UserInvitationSent', invitation_id: 'inv-1', usage: 42 },
    });
    const client = maakClient();
    const res = await client.stuurInvite({ accountId: 'acc-1', providerId: 'ACo1' });
    assert.equal(res.usage, undefined);
  });

  const codes422 = [
    { code: 'already_invited_recently', match: /recent al ontvangen/i },
    { code: 'limit_exceeded', match: /limiet overschreden|afkoeling/i },
    { code: 'connection_limit_reached', match: /limiet.*bereikt|afkoeling/i },
    { code: 'already_connected', match: /al een 1e-graads/i },
    { code: 'cannot_resend_yet', match: /nog niet opnieuw/i },
  ];

  for (const { code, match } of codes422) {
    it(`vertaalt 422 ${code} naar Unipile422Fout met NL-tekst`, async () => {
      fake.antwoord('POST', '/api/v1/users/invite', {
        status: 422,
        body: { detail: code },
      });
      const client = maakClient();
      await assert.rejects(
        client.stuurInvite({ accountId: 'acc-1', providerId: 'ACo1' }),
        (err: Error) => {
          assert.ok(err instanceof Unipile422Fout);
          assert.equal((err as Unipile422Fout).code, code);
          assert.match(err.message, match);
          return true;
        },
      );
    });
  }
});

describe('UnipileClient — stuurBericht (multipart)', () => {
  it('stuurt multipart/form-data met account_id en text naar het gesprek', async () => {
    fake.antwoord('POST', /\/api\/v1\/chats\/[^/]+\/messages/, {
      status: 200,
      body: { object: 'MessageSent', message_id: 'msg-1' },
    });
    const client = maakClient();
    const res = await client.stuurBericht({
      accountId: 'acc-1',
      chatId: 'chat-42',
      tekst: 'Hallo, dank voor de acceptatie.',
    });
    assert.equal(res.messageId, 'msg-1');
    const call = fake.aanroepen[0];
    assert.match(call?.headers['content-type'] ?? '', /multipart\/form-data/);
    assert.match(call?.path ?? '', /\/api\/v1\/chats\/chat-42\/messages/);
    const body = call?.body as Record<string, unknown>;
    assert.equal(body['account_id'], 'acc-1');
    assert.equal(body['text'], 'Hallo, dank voor de acceptatie.');
  });
});

describe('UnipileClient — startGesprek (InMail via multipart)', () => {
  it('stuurt subject, text, attendees_ids en linkedin[api] als InMail', async () => {
    fake.antwoord('POST', '/api/v1/chats', {
      status: 200,
      body: { object: 'ChatStarted', chat_id: 'chat-1', message_id: 'msg-1' },
    });
    const client = maakClient();
    const res = await client.startGesprek({
      accountId: 'acc-1',
      attendeesIds: ['ACw999'],
      onderwerp: 'Kort vraagje',
      tekst: 'Hoi, ik las ...',
      linkedinApi: 'sales_navigator',
    });
    assert.equal(res.chatId, 'chat-1');
    assert.equal(res.messageId, 'msg-1');
    const call = fake.aanroepen[0];
    assert.match(call?.headers['content-type'] ?? '', /multipart\/form-data/);
    const body = call?.body as Record<string, unknown>;
    assert.equal(body['account_id'], 'acc-1');
    assert.equal(body['subject'], 'Kort vraagje');
    assert.equal(body['text'], 'Hoi, ik las ...');
    assert.equal(body['linkedin[api]'], 'sales_navigator');
    assert.equal(body['attendees_ids'], 'ACw999');
  });

  const inmailCodes = [
    { code: 'insufficient_credits', match: /Onvoldoende InMail-tegoed/i },
    { code: 'not_allowed_inmail', match: /InMail naar deze persoon is niet toegestaan/i },
    { code: 'user_unreachable', match: /niet bereikbaar/i },
  ];

  for (const { code, match } of inmailCodes) {
    it(`vertaalt 422 ${code} naar Unipile422Fout met NL-tekst`, async () => {
      fake.antwoord('POST', '/api/v1/chats', {
        status: 422,
        body: { detail: code },
      });
      const client = maakClient();
      await assert.rejects(
        client.startGesprek({
          accountId: 'acc-1',
          attendeesIds: ['ACw999'],
          onderwerp: 'x',
          tekst: 'y',
          linkedinApi: 'sales_navigator',
        }),
        (err: Error) => {
          assert.ok(err instanceof Unipile422Fout);
          assert.equal((err as Unipile422Fout).code, code);
          assert.match(err.message, match);
          return true;
        },
      );
    });
  }
});
