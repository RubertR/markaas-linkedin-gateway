import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient } from '../unipile/client.ts';

import {
  GATEWAY_WEBHOOKS,
  WebhookRegistratieFout,
  beschrijf,
  draaiRegistratie,
  leesEnvBestand,
  parseerArgumenten,
  registreerWebhooks,
} from './registratie.ts';

const GEHEIM = 'webhook-geheim-mag-nooit-lekken';
const API_SLEUTEL = 'api-sleutel-mag-nooit-lekken';
const URL = 'https://gateway.example/webhooks/unipile';

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

function client() {
  return maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: API_SLEUTEL, timeoutMs: 100 });
}

function bestaand(...namen: string[]) {
  fake.antwoord('GET', '/api/v1/webhooks', {
    status: 200,
    body: {
      object: 'WebhookList',
      items: namen.map((name, i) => ({ id: `w${i}`, name, request_url: URL, enabled: true })),
      cursor: null,
    },
  });
}

function posts() {
  return fake.aanroepen.filter((a) => a.method === 'POST');
}

function bevatGeenGeheim(tekst: string) {
  assert.ok(!tekst.includes(GEHEIM), 'tekst bevat WEBHOOK_SECRET');
  assert.ok(!tekst.includes(API_SLEUTEL), 'tekst bevat de API-sleutel');
}

describe('GATEWAY_WEBHOOKS', () => {
  it('bevat precies de drie gateway-webhooks met de juiste bron en events', () => {
    assert.deepEqual(
      GATEWAY_WEBHOOKS.map((w) => [w.naam, w.bron, [...w.events].sort()]),
      [
        [
          'gateway-accountstatus',
          'account_status',
          ['credentials', 'deleted', 'error', 'ok', 'permissions', 'reconnected', 'stopped'],
        ],
        ['gateway-messaging', 'messaging', ['message_received']],
        ['gateway-relaties', 'users', ['new_relation']],
      ],
    );
  });

  it('abonneert niet op creation_success/fail, sync_success of connecting', () => {
    const alle = GATEWAY_WEBHOOKS.flatMap((w) => w.events);
    for (const e of ['creation_success', 'creation_fail', 'sync_success', 'connecting']) {
      assert.ok(!alle.includes(e), `${e} hoort er niet bij`);
    }
  });
});

describe('registreerWebhooks', () => {
  it('dry-run: haalt bestaande op maar maakt niets aan', async () => {
    bestaand();
    const regels = await registreerWebhooks(client(), {
      requestUrl: URL,
      geheim: GEHEIM,
      uitvoeren: false,
    });
    assert.deepEqual(regels.map((r) => r.actie), ['zou_aanmaken', 'zou_aanmaken', 'zou_aanmaken']);
    assert.equal(posts().length, 0);
  });

  it('uitvoeren: maakt alle drie aan met het geheim in de header', async () => {
    bestaand();
    let n = 0;
    fake.antwoord('POST', '/api/v1/webhooks', () => ({
      status: 201,
      body: { object: 'WebhookCreated', webhook_id: `nieuw-${++n}` },
    }));
    const regels = await registreerWebhooks(client(), {
      requestUrl: URL,
      geheim: GEHEIM,
      uitvoeren: true,
    });
    assert.deepEqual(regels.map((r) => r.actie), ['aangemaakt', 'aangemaakt', 'aangemaakt']);
    assert.deepEqual(regels.map((r) => r.webhookId), ['nieuw-1', 'nieuw-2', 'nieuw-3']);
    assert.equal(posts().length, 3);
    for (const p of posts()) {
      const body = p.body as Record<string, unknown>;
      assert.equal(body['request_url'], URL);
      assert.deepEqual(body['headers'], [{ key: 'x-webhook-secret', value: GEHEIM }]);
      assert.equal(body['account_ids'], undefined, 'geldt voor alle accounts');
    }
    const accountstatus = posts()[0]!.body as Record<string, unknown>;
    assert.equal(accountstatus['source'], 'account_status');
  });

  it('is idempotent: slaat webhooks over die op naam al bestaan', async () => {
    bestaand('gateway-messaging', 'iets-anders');
    fake.antwoord('POST', '/api/v1/webhooks', {
      status: 201,
      body: { object: 'WebhookCreated', webhook_id: 'nieuw' },
    });
    const regels = await registreerWebhooks(client(), {
      requestUrl: URL,
      geheim: GEHEIM,
      uitvoeren: true,
    });
    assert.deepEqual(regels.map((r) => [r.naam, r.actie]), [
      ['gateway-accountstatus', 'aangemaakt'],
      ['gateway-messaging', 'bestaat_al'],
      ['gateway-relaties', 'aangemaakt'],
    ]);
    assert.deepEqual(
      posts().map((p) => (p.body as { name: string }).name),
      ['gateway-accountstatus', 'gateway-relaties'],
    );
  });

  it('waarschuwt als een bestaande webhook naar een andere URL wijst', async () => {
    fake.antwoord('GET', '/api/v1/webhooks', {
      status: 200,
      body: {
        items: [
          { id: 'w', name: 'gateway-relaties', request_url: 'https://oud.example/x', enabled: true },
        ],
      },
    });
    const regels = await registreerWebhooks(client(), {
      requestUrl: URL,
      geheim: GEHEIM,
      uitvoeren: false,
    });
    const relaties = regels.find((r) => r.naam === 'gateway-relaties')!;
    assert.equal(relaties.actie, 'bestaat_al');
    assert.match(relaties.waarschuwing ?? '', /andere URL/);
  });

  it('401 bij ophalen: Nederlandse melding over de API-sleutel, niets aangemaakt', async () => {
    fake.antwoord('GET', '/api/v1/webhooks', { status: 401, body: { error: 'unauthorized' } });
    await assert.rejects(
      registreerWebhooks(client(), { requestUrl: URL, geheim: GEHEIM, uitvoeren: true }),
      (err: Error) => {
        assert.ok(err instanceof WebhookRegistratieFout);
        assert.match(err.message, /API-sleutel/);
        assert.deepEqual(err.aangemaakt, []);
        bevatGeenGeheim(err.message);
        return true;
      },
    );
    assert.equal(posts().length, 0);
  });

  it('429 halverwege: meldt wat al is aangemaakt en wanneer opnieuw', async () => {
    bestaand();
    let n = 0;
    fake.antwoord('POST', '/api/v1/webhooks', () =>
      ++n === 1
        ? { status: 201, body: { object: 'WebhookCreated', webhook_id: 'nieuw-1' } }
        : { status: 429, headers: { 'Retry-After': '45' }, body: { error: 'rate_limited' } },
    );
    await assert.rejects(
      registreerWebhooks(client(), { requestUrl: URL, geheim: GEHEIM, uitvoeren: true }),
      (err: Error) => {
        assert.ok(err instanceof WebhookRegistratieFout);
        assert.deepEqual(err.aangemaakt, ['gateway-accountstatus']);
        assert.match(err.message, /45 seconden/);
        assert.match(err.message, /gateway-accountstatus/);
        assert.match(err.message, /opnieuw/);
        bevatGeenGeheim(err.message);
        return true;
      },
    );
    assert.equal(posts().length, 2, 'stopt na de eerste fout');
  });

  it('time-out: Nederlandse melding, veilig om opnieuw te draaien', async () => {
    bestaand();
    fake.antwoord('POST', '/api/v1/webhooks', { status: 201, delayMs: 500, body: {} });
    await assert.rejects(
      registreerWebhooks(client(), { requestUrl: URL, geheim: GEHEIM, uitvoeren: true }),
      (err: Error) => {
        assert.ok(err instanceof WebhookRegistratieFout);
        assert.match(err.message, /niet op tijd|time-out/i);
        assert.match(err.message, /controleer/i, 'bij een time-out kan de webhook toch bestaan');
        return true;
      },
    );
  });

  it('lekt het geheim niet als Unipile de body terugkaatst in een fout', async () => {
    bestaand();
    fake.antwoord('POST', '/api/v1/webhooks', {
      status: 400,
      body: { error: 'bad_request', echo: { headers: [{ key: 'x-webhook-secret', value: GEHEIM }] } },
    });
    await assert.rejects(
      registreerWebhooks(client(), { requestUrl: URL, geheim: GEHEIM, uitvoeren: true }),
      (err: Error) => {
        bevatGeenGeheim(err.message);
        return true;
      },
    );
  });
});

describe('beschrijf', () => {
  it('toont naam, bron, events en URL, met het geheim gemaskeerd', async () => {
    bestaand('gateway-relaties');
    const regels = await registreerWebhooks(client(), {
      requestUrl: URL,
      geheim: GEHEIM,
      uitvoeren: false,
    });
    const tekst = beschrijf(regels, { requestUrl: URL, uitvoeren: false });
    assert.match(tekst, /gateway-accountstatus/);
    assert.match(tekst, /account_status/);
    assert.match(tekst, /message_received/);
    assert.match(tekst, /bestaat al/);
    assert.match(tekst, /x-webhook-secret: \*{8}/);
    assert.match(tekst, /--uitvoeren/);
    assert.ok(tekst.includes(URL));
    bevatGeenGeheim(tekst);
  });
});

describe('parseerArgumenten', () => {
  it('standaard dry-run met .env', () => {
    assert.deepEqual(parseerArgumenten([]), { envBestand: '.env', uitvoeren: false });
  });

  it('leest --env-file en --uitvoeren', () => {
    assert.deepEqual(parseerArgumenten(['--env-file', '.env.railway', '--uitvoeren']), {
      envBestand: '.env.railway',
      uitvoeren: true,
    });
    assert.equal(parseerArgumenten(['--env-file=.env.railway']).envBestand, '.env.railway');
  });

  it('weigert --dry-run samen met --uitvoeren, onbekende opties en een lege --env-file', () => {
    assert.throws(() => parseerArgumenten(['--dry-run', '--uitvoeren']), /niet allebei/);
    assert.throws(() => parseerArgumenten(['--force']), /--force/);
    assert.throws(() => parseerArgumenten(['--env-file']), /--env-file/);
  });
});

describe('draaiRegistratie (volledige scriptflow tegen de fake-server)', () => {
  async function geldigEnvBestand(): Promise<string> {
    const map = await mkdtemp(join(tmpdir(), 'webhooks-flow-'));
    const pad = join(map, '.env.test');
    await writeFile(
      pad,
      `UNIPILE_DSN=api1.unipile.com:1\nUNIPILE_API_KEY=${API_SLEUTEL}\nWEBHOOK_SECRET=${GEHEIM}\n`,
    );
    return pad;
  }

  function deps() {
    let clientGemaakt = false;
    return {
      get clientGemaakt() {
        return clientGemaakt;
      },
      requestUrl: URL,
      maakClient: () => {
        clientGemaakt = true;
        return client();
      },
    };
  }

  it('--dry-run samen met --uitvoeren: fout vóór er een client of verzoek is', async () => {
    const d = deps();
    const pad = await geldigEnvBestand();
    await assert.rejects(
      draaiRegistratie(['--env-file', pad, '--dry-run', '--uitvoeren'], d),
      /niet allebei/,
    );
    assert.equal(d.clientGemaakt, false);
    assert.equal(fake.aanroepen.length, 0, 'geen enkel verzoek naar Unipile');
  });

  it('ontbrekend env-bestand met --uitvoeren: fout vóór er een client of verzoek is', async () => {
    const d = deps();
    await assert.rejects(
      draaiRegistratie(['--env-file', '/bestaat/niet/.env.railway', '--uitvoeren'], d),
      /niet gevonden|niet lezen/,
    );
    assert.equal(d.clientGemaakt, false);
    assert.equal(fake.aanroepen.length, 0, 'geen enkel verzoek naar Unipile');
  });

  it('geldige dry-run: alleen een GET, uitvoer zonder geheimen', async () => {
    bestaand();
    const pad = await geldigEnvBestand();
    const uitvoer = await draaiRegistratie(['--env-file', pad], deps());
    assert.deepEqual(fake.aanroepen.map((a) => a.method), ['GET']);
    assert.match(uitvoer, /Dry-run/);
    bevatGeenGeheim(uitvoer);
  });
});

describe('leesEnvBestand', () => {
  async function bestand(inhoud: string): Promise<string> {
    const map = await mkdtemp(join(tmpdir(), 'webhooks-env-'));
    const pad = join(map, '.env.test');
    await writeFile(pad, inhoud);
    return pad;
  }

  it('leest DSN, API-sleutel en WEBHOOK_SECRET uit het bestand', async () => {
    const pad = await bestand(
      `UNIPILE_DSN=api1.unipile.com:1\nUNIPILE_API_KEY=${API_SLEUTEL}\nWEBHOOK_SECRET="${GEHEIM}"\n`,
    );
    assert.deepEqual(await leesEnvBestand(pad), {
      unipileDsn: 'api1.unipile.com:1',
      unipileApiKey: API_SLEUTEL,
      webhookSecret: GEHEIM,
    });
  });

  it('noemt ontbrekende variabelen bij naam, zonder waarden', async () => {
    const pad = await bestand(`UNIPILE_DSN=api1.unipile.com:1\nUNIPILE_API_KEY=${API_SLEUTEL}\n`);
    await assert.rejects(leesEnvBestand(pad), (err: Error) => {
      assert.match(err.message, /WEBHOOK_SECRET/);
      assert.doesNotMatch(err.message, /UNIPILE_DSN|UNIPILE_API_KEY/);
      bevatGeenGeheim(err.message);
      return true;
    });
  });

  it('geeft een duidelijke melding als het bestand niet bestaat', async () => {
    await assert.rejects(leesEnvBestand('/bestaat/niet/.env.railway'), /niet gevonden|niet lezen/);
  });
});
