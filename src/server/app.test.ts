import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import { leesEnv, type Env } from '../config/env.ts';
import type { Backend } from '../db/backend.ts';
import { maakLogger } from '../log/logger.ts';
import { vastePauze } from '../queue/pauze.ts';
import { vasteWerkdagen } from '../sequences/wachttijd.ts';
import { maakUnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakGatewayApp, unipileBaseUrl } from './app.ts';
import { maakHealthApp } from './health.ts';
import { leesVersie } from './versie.ts';

const GEHEIMEN = {
  UNIPILE_DSN: 'api68.unipile.com:19841',
  UNIPILE_API_KEY: 'unipile-sleutel-zeer-geheim',
  WEBHOOK_SECRET: 'webhook-geheim-zeer-geheim',
  MCP_TOKEN: 'mcp-token-zeer-geheim',
  ADMIN_PASSWORD_HASH: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
  DATABASE_URL: 'postgres://gebruiker:dbwachtwoord@db.voorbeeld:5432/postgres',
};

let db: Backend;
let close: () => Promise<void>;
let limieten: Limieten;

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  limieten = await laadLimieten();
});

after(async () => {
  await close();
});

function maakApp(env: Env, opties: { db?: Backend; regels?: string[] } = {}) {
  return maakGatewayApp({
    env,
    db: opties.db ?? db,
    // Wijst nergens heen: deze tests raken Unipile niet.
    unipile: maakUnipileClient({ baseUrl: 'http://127.0.0.1:9', apiKey: env.unipileApiKey }),
    limieten,
    klok: vasteKlok('2026-10-01T08:00:00Z'),
    pauzeKiezer: vastePauze(0),
    werkdagen: vasteWerkdagen(1),
    logger: maakLogger({
      niveau: 'debug',
      geheimen: Object.values(GEHEIMEN),
      schrijf: (r) => opties.regels?.push(r),
    }),
    versie: leesVersie(),
  });
}

const kapotteDb: Backend = {
  exec: async () => {
    throw new Error('verbinding geweigerd: postgres://gebruiker:dbwachtwoord@db.voorbeeld');
  },
  query: async () => {
    throw new Error('verbinding geweigerd: postgres://gebruiker:dbwachtwoord@db.voorbeeld');
  },
  close: async () => {},
  transaction: async () => {
    throw new Error('geen db');
  },
};

describe('GET /health', () => {
  it('geeft 200 met versie uit package.json en een bereikbare database', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.deepEqual(body, {
      status: 'ok',
      versie: leesVersie(),
      database: { bereikbaar: true },
    });
    assert.match(body.versie, /^\d+\.\d+\.\d+/);
  });

  it('geeft 200 met bereikbaar=false als de database faalt, zonder de fouttekst', async () => {
    const app = maakApp(leesEnv(GEHEIMEN), { db: kapotteDb });
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const tekst = await res.text();
    assert.deepEqual(JSON.parse(tekst), {
      status: 'database_onbereikbaar',
      versie: leesVersie(),
      database: { bereikbaar: false },
    });
    assert.doesNotMatch(tekst, /dbwachtwoord|voorbeeld|geweigerd/);
  });

  it('meldt onbereikbaar als de database niet binnen de time-out antwoordt', async () => {
    const trageDb: Backend = { ...kapotteDb, query: () => new Promise(() => {}) };
    const app = maakHealthApp({ db: trageDb, versie: '1.2.3', timeoutMs: 20 });
    const res = await app.request('/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { database: { bereikbaar: boolean } };
    assert.equal(body.database.bereikbaar, false);
  });

  it('lekt geen geheimen, accountgegevens of database-URL', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const tekst = await (await app.request('/health')).text();
    for (const waarde of Object.values(GEHEIMEN)) {
      assert.ok(!tekst.includes(waarde), 'health-antwoord bevat een geheime waarde');
    }
    assert.doesNotMatch(tekst, /account|unipile|postgres/i);
  });

  it('vereist geen token of login', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, NODE_ENV: 'production' }));
    const res = await app.request('/health');
    assert.equal(res.status, 200);
  });
});

describe('maakGatewayApp', () => {
  it('monteert webhooks, MCP en admin achter hun eigen beveiliging', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    assert.equal((await app.request('/webhooks/unipile', { method: 'POST' })).status, 401);
    assert.equal((await app.request('/mcp', { method: 'POST' })).status, 401);
    const admin = await app.request('/admin/');
    assert.equal(admin.status, 303);
    assert.equal(admin.headers.get('location'), '/admin/login');
  });

  it('zet cookies met Secure in productie', async () => {
    const app = maakApp(leesEnv({ ...GEHEIMEN, NODE_ENV: 'production' }));
    const res = await app.request('/admin/login');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /admin_csrf=/);
    assert.match(cookie, /;\s*Secure/i);
  });

  it('zet cookies zonder Secure buiten productie (lokaal via http)', async () => {
    const app = maakApp(leesEnv(GEHEIMEN));
    const res = await app.request('/admin/login');
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /admin_csrf=/);
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  });

  it('logt verzoeken als JSON zonder headers of geheimen', async () => {
    const regels: string[] = [];
    const app = maakApp(leesEnv(GEHEIMEN), { regels });
    await app.request('/mcp?x=1', {
      method: 'POST',
      headers: { authorization: `Bearer ${GEHEIMEN.MCP_TOKEN}` },
      body: '{}',
    });
    assert.ok(regels.length > 0);
    const regel = JSON.parse(regels.at(-1)!);
    assert.equal(regel.bericht, 'HTTP-verzoek');
    assert.equal(regel.pad, '/mcp');
    assert.equal(regel.methode, 'POST');
    for (const r of regels) {
      for (const waarde of Object.values(GEHEIMEN)) {
        assert.ok(!r.includes(waarde), 'logregel bevat een geheime waarde');
      }
    }
  });
});

describe('unipileBaseUrl', () => {
  it('maakt een https-URL van de DSN', () => {
    assert.equal(unipileBaseUrl('api68.unipile.com:19841'), 'https://api68.unipile.com:19841');
    assert.equal(unipileBaseUrl('https://api68.unipile.com:19841/'), 'https://api68.unipile.com:19841');
  });
});
