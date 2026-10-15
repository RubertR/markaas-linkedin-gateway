import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';

import { maakUnipileClient } from './client.ts';
import {
  Unipile422Fout,
  UnipileAccountBeperktFout,
  UnipileAccountCredentialsFout,
  UnipileFunctieNietInAbonnementFout,
  UnipileGatewayAuthFout,
  UnipileOnbekendeAuthFout,
  UnipileTijdelijkeFout,
  UnipileTimeoutFout,
  UnipileValidatieFout,
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

  it('401 zonder account-context (haalAccounts) blijft UnipileGatewayAuthFout (API-sleutel, gateway-breed)', async () => {
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

  it('403 zonder account-context blijft ook UnipileGatewayAuthFout', async () => {
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

describe('UnipileClient — 401/403 met account-context (SPEC §6a)', () => {
  const SESSIE: Array<[number, string]> = [
    [401, 'disconnected_account'],
    [401, 'expired_credentials'],
    [401, 'invalid_credentials'],
    [401, 'missing_credentials'],
    [401, 'multiple_sessions'],
    [401, 'checkpoint_error'],
    [401, 'invalid_checkpoint_solution'],
    [401, 'wrong_account'],
    [403, 'session_mismatch'],
    [403, 'unknown_authentication_context'],
    [403, 'account_mismatch'],
  ];
  for (const [status, type] of SESSIE) {
    it(`${status} errors/${type} → UnipileAccountCredentialsFout (sessie van dit account)`, async () => {
      fake.antwoord('POST', '/api/v1/users/invite', {
        status,
        body: { status, type: `errors/${type}`, title: 'x' },
      });
      await assert.rejects(
        maakClient().stuurInvite({ accountId: 'acc-9', providerId: 'ACo1' }),
        (err: Error) => {
          assert.ok(err instanceof UnipileAccountCredentialsFout, err.name);
          assert.equal((err as UnipileAccountCredentialsFout).code, type);
          assert.equal((err as UnipileAccountCredentialsFout).accountId, 'acc-9');
          assert.equal((err as UnipileAccountCredentialsFout).status, status);
          return true;
        },
      );
    });
  }

  it('403 errors/account_restricted → UnipileAccountBeperktFout', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', {
      status: 403,
      body: { status: 403, type: 'errors/account_restricted', title: 'Restricted' },
    });
    await assert.rejects(
      maakClient().stuurInvite({ accountId: 'acc-9', providerId: 'ACo1' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileAccountBeperktFout, err.name);
        assert.equal((err as UnipileAccountBeperktFout).accountId, 'acc-9');
        assert.match(err.message, /beperkt/);
        return true;
      },
    );
  });

  const FUNCTIE: Array<[number, string]> = [
    [403, 'feature_not_subscribed'],
    [403, 'insufficient_permissions'],
    [401, 'insufficient_privileges'],
    [401, 'disconnected_feature'],
  ];
  for (const [status, type] of FUNCTIE) {
    it(`${status} errors/${type} → UnipileFunctieNietInAbonnementFout`, async () => {
      fake.antwoord('POST', '/api/v1/linkedin/search', {
        status,
        body: { status, type: `errors/${type}` },
      });
      await assert.rejects(
        maakClient().zoekPersonen({ accountId: 'acc-9', api: 'sales_navigator' }),
        (err: Error) => {
          assert.ok(err instanceof UnipileFunctieNietInAbonnementFout, err.name);
          assert.equal((err as UnipileFunctieNietInAbonnementFout).foutType, `errors/${type}`);
          assert.match(err.message, /niet in het LinkedIn-abonnement/);
          return true;
        },
      );
    });
  }

  it('401 zonder type op een account-aanroep → UnipileOnbekendeAuthFout, níet meteen een gateway-stop', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: { error: 'unauthorized' } });
    await assert.rejects(
      maakClient().stuurInvite({ accountId: 'acc-9', providerId: 'ACo1' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileOnbekendeAuthFout, err.name);
        assert.ok(!(err instanceof UnipileGatewayAuthFout));
        assert.equal((err as UnipileOnbekendeAuthFout).foutType, undefined);
        assert.equal((err as UnipileOnbekendeAuthFout).status, 401);
        assert.doesNotMatch(err.message, new RegExp(GEHEIME_SLEUTEL));
        return true;
      },
    );
  });

  it('403 met een onbekend type → UnipileOnbekendeAuthFout met het type erbij', async () => {
    fake.antwoord('GET', /^\/api\/v1\/users\//, {
      status: 403,
      body: { status: 403, type: 'errors/iets_nieuws' },
    });
    await assert.rejects(
      maakClient().haalProfiel({ accountId: 'acc-9', identifier: 'jan' }),
      (err: Error) => {
        assert.ok(err instanceof UnipileOnbekendeAuthFout, err.name);
        assert.equal((err as UnipileOnbekendeAuthFout).foutType, 'errors/iets_nieuws');
        return true;
      },
    );
  });

  it('401 met een niet-JSON-body → UnipileOnbekendeAuthFout', async () => {
    fake.antwoord('POST', '/api/v1/users/invite', { status: 401, body: 'Unauthorized' });
    await assert.rejects(
      maakClient().stuurInvite({ accountId: 'acc-9', providerId: 'ACo1' }),
      UnipileOnbekendeAuthFout,
    );
  });
});

describe('UnipileClient — controleerGatewaySleutel (SPEC §6a)', () => {
  it('doet één GET /api/v1/accounts?limit=1 zonder account_id en slaagt bij 200', async () => {
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { object: 'AccountList', items: [] } });
    await maakClient().controleerGatewaySleutel();
    assert.equal(fake.aanroepen.length, 1);
    assert.equal(fake.aanroepen[0]?.path, '/api/v1/accounts?limit=1');
    assert.doesNotMatch(fake.aanroepen[0]!.path, /account_id/);
  });

  it('401 of 403 op de controle → UnipileGatewayAuthFout', async () => {
    fake.antwoord('GET', '/api/v1/accounts', { status: 401, body: { type: 'errors/missing_credentials' } });
    await assert.rejects(maakClient().controleerGatewaySleutel(), UnipileGatewayAuthFout);
    fake.reset();
    fake.antwoord('GET', '/api/v1/accounts', { status: 403, body: {} });
    await assert.rejects(maakClient().controleerGatewaySleutel(), UnipileGatewayAuthFout);
  });

  it('500 op de controle blijft een tijdelijke fout (geen uitsluitsel)', async () => {
    fake.antwoord('GET', '/api/v1/accounts', { status: 500, body: {} });
    await assert.rejects(maakClient().controleerGatewaySleutel(), UnipileTijdelijkeFout);
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

  it('401 (geen account-context) blijft UnipileGatewayAuthFout', async () => {
    fake.antwoord('GET', '/api/v1/webhooks', { status: 401, body: { error: 'nope' } });
    await assert.rejects(maakClient().haalWebhooks(), UnipileGatewayAuthFout);
  });
});

describe('UnipileClient — telVerstuurdeInvites', () => {
  function invitaties(aantal: number, start = 0): Array<Record<string, unknown>> {
    return Array.from({ length: aantal }, (_, i) => ({
      object: 'InvitationSent',
      id: `inv-${start + i}`,
      invited_user_id: `ACo-${start + i}`,
    }));
  }

  it('één pagina: telt de items, GET met account_id en limit', async () => {
    fake.antwoord('GET', '/api/v1/users/invite/sent', {
      status: 200,
      body: { object: 'InvitationList', items: invitaties(3), cursor: null },
    });
    const uit = await maakClient().telVerstuurdeInvites({
      accountId: 'acc-1',
      paginaGrootte: 250,
      maxPaginas: 2,
    });
    assert.deepEqual(uit, { aantal: 3, volledig: true, paginas: 1 });
    assert.equal(fake.aanroepen.length, 1);
    assert.equal(fake.aanroepen[0]?.method, 'GET');
    assert.match(fake.aanroepen[0]!.path, /account_id=acc-1/);
    assert.match(fake.aanroepen[0]!.path, /limit=250/);
  });

  it('volgt de cursor tot maxPaginas', async () => {
    let pagina = 0;
    fake.antwoord('GET', '/api/v1/users/invite/sent', () => {
      pagina++;
      return {
        status: 200,
        body: {
          object: 'InvitationList',
          items: invitaties(2, pagina * 10),
          cursor: pagina === 1 ? 'c2' : null,
        },
      };
    });
    const uit = await maakClient().telVerstuurdeInvites({
      accountId: 'acc-1',
      paginaGrootte: 2,
      maxPaginas: 3,
    });
    assert.deepEqual(uit, { aantal: 4, volledig: true, paginas: 2 });
    assert.match(fake.aanroepen[1]!.path, /cursor=c2/);
  });

  it('stopt na maxPaginas en meldt onvolledig', async () => {
    fake.antwoord('GET', '/api/v1/users/invite/sent', {
      status: 200,
      body: { object: 'InvitationList', items: invitaties(2), cursor: 'nog-meer' },
    });
    const uit = await maakClient().telVerstuurdeInvites({
      accountId: 'acc-1',
      paginaGrootte: 2,
      maxPaginas: 2,
    });
    assert.deepEqual(uit, { aantal: 4, volledig: false, paginas: 2 });
    assert.equal(fake.aanroepen.length, 2);
  });

  it('vertaalt 429 naar UnipileTijdelijkeFout', async () => {
    fake.antwoord('GET', '/api/v1/users/invite/sent', { status: 429, body: {} });
    await assert.rejects(
      maakClient().telVerstuurdeInvites({ accountId: 'acc-1', paginaGrootte: 250, maxPaginas: 2 }),
      (err: unknown) => err instanceof UnipileTijdelijkeFout && err.status === 429,
    );
  });

  it('vertaalt een trage Unipile naar UnipileTimeoutFout', async () => {
    fake.antwoord('GET', '/api/v1/users/invite/sent', {
      status: 200,
      delayMs: 300,
      body: { object: 'InvitationList', items: [], cursor: null },
    });
    await assert.rejects(
      maakClient({ timeoutMs: 100 }).telVerstuurdeInvites({
        accountId: 'acc-1',
        paginaGrootte: 250,
        maxPaginas: 2,
      }),
      UnipileTimeoutFout,
    );
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

  it('stuurt success_redirect_url en failure_redirect_url alleen mee als ze gegeven zijn', async () => {
    fake.antwoord('POST', '/api/v1/hosted/accounts/link', {
      status: 200,
      body: { object: 'HostedAuthUrl', url: 'https://account.unipile.com/link/r' },
    });
    const client = maakClient();
    await client.maakKoppellink({
      type: 'create',
      naam: 'account-42',
      notifyUrl: 'https://gateway.example/webhooks/koppel',
      vervaltOp: new Date('2026-10-01T00:00:00Z'),
      successRedirectUrl: 'https://gateway.example/koppelen/klaar',
      failureRedirectUrl: 'https://gateway.example/koppelen/mislukt',
    });
    await client.maakKoppellink({
      type: 'create',
      naam: 'account-43',
      notifyUrl: 'https://gateway.example/webhooks/koppel',
      vervaltOp: new Date('2026-10-01T00:00:00Z'),
    });
    const met = fake.aanroepen[0]?.body as Record<string, unknown>;
    assert.equal(met['success_redirect_url'], 'https://gateway.example/koppelen/klaar');
    assert.equal(met['failure_redirect_url'], 'https://gateway.example/koppelen/mislukt');
    const zonder = fake.aanroepen[1]?.body as Record<string, unknown>;
    assert.equal('success_redirect_url' in zonder, false);
    assert.equal('failure_redirect_url' in zonder, false);
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

describe('UnipileClient — 400 en terugboeken (SPEC §5.1)', () => {
  const zoek = { accountId: 'acc-1', api: 'sales_navigator' as const, keywords: 'x' };

  it('400 errors/invalid_parameters → UnipileValidatieFout met type en NL-melding', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 400,
      body: { status: 400, type: 'errors/invalid_parameters', title: 'Invalid parameters' },
    });
    await assert.rejects(maakClient().zoekPersonen(zoek), (err: unknown) => {
      assert.ok(err instanceof UnipileValidatieFout);
      assert.equal(err.foutType, 'errors/invalid_parameters');
      assert.equal(err.status, 400);
      assert.match(err.message, /vóór LinkedIn/);
      return true;
    });
  });

  for (const type of [
    'errors/malformed_request',
    'errors/missing_parameters',
    'errors/limit_too_high',
    'errors/invalid_url',
    'errors/too_many_characters',
    'errors/unescaped_characters',
    'errors/content_too_large',
  ]) {
    it(`400 ${type} → UnipileValidatieFout`, async () => {
      fake.antwoord('POST', '/api/v1/linkedin/search', { status: 400, body: { status: 400, type } });
      await assert.rejects(maakClient().zoekPersonen(zoek), UnipileValidatieFout);
    });
  }

  it('400 errors/target_audience_too_small → gewone UnipileFout (LinkedIn heeft gezocht)', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 400,
      body: { status: 400, type: 'errors/target_audience_too_small' },
    });
    await assert.rejects(maakClient().zoekPersonen(zoek), (err: unknown) => {
      assert.ok(!(err instanceof UnipileValidatieFout));
      assert.equal((err as { status?: number }).status, 400);
      return true;
    });
  });

  it('400 met onbekend type of zonder JSON → gewone UnipileFout (bij twijfel telt het)', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 400,
      body: { status: 400, type: 'errors/iets_nieuws' },
    });
    await assert.rejects(maakClient().zoekPersonen(zoek), (err: unknown) => {
      assert.ok(!(err instanceof UnipileValidatieFout));
      return true;
    });
    fake.reset();
    fake.antwoord('POST', '/api/v1/linkedin/search', { status: 400, body: 'Bad Request' });
    await assert.rejects(maakClient().zoekPersonen(zoek), (err: unknown) => {
      assert.ok(!(err instanceof UnipileValidatieFout));
      return true;
    });
  });

  it('422 blijft Unipile422Fout, ook met een validatie-achtig type', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 422,
      body: { status: 422, type: 'errors/invalid_parameters' },
    });
    await assert.rejects(maakClient().zoekPersonen(zoek), Unipile422Fout);
  });
});
