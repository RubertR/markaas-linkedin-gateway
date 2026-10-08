import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vindActie } from '../queue/acties.ts';
import { vastePauze } from '../queue/pauze.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakMcpApp, type McpAppDeps } from './server.ts';

const TOKEN = 'mcp-token-xyz';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
let app: ReturnType<typeof maakMcpApp>;
let deps: McpAppDeps;

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'k', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from usage');
  await db.query('delete from actions');
  await db.query('delete from sequences');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const client = await maakClient(db, { naam: 'Markaas Test', slug: 'markaas-test' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'unipile-rubert');

  deps = {
    db,
    unipile,
    limieten,
    klok: vasteKlok(new Date('2026-10-06T10:00:00Z')),
    pauzeKiezer: vastePauze(120),
    mcpToken: TOKEN,
  };
  app = maakMcpApp(deps);
});

async function postMcp(
  bericht: unknown,
  opties: { token?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opties.token !== null && opties.token !== undefined) {
    headers['authorization'] = `Bearer ${opties.token}`;
  }
  return await app.request('/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(bericht),
  });
}

describe('authenticatie', () => {
  it('401 zonder Authorization-header', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { token: null },
    );
    assert.equal(res.status, 401);
    const tekst = await res.text();
    assert.match(tekst, /bearer-token/i);
  });

  it('401 met fout token', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { token: 'fout-token' },
    );
    assert.equal(res.status, 401);
  });

  it('401 met een token van gelijke lengte maar andere inhoud (constante-tijd check)', async () => {
    const sameLen = TOKEN.split('').reverse().join('');
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { token: sameLen },
    );
    assert.equal(res.status, 401);
  });

  it('200 met correct token op initialize', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { token: TOKEN },
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { protocolVersion: string } };
    assert.ok(body.result.protocolVersion);
  });

  it('405 op GET /mcp (geen server-SSE)', async () => {
    const res = await app.request('/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 405);
  });
});

describe('tools/list', () => {
  it('geeft precies de negen tools uit SPEC §7 terug', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: TOKEN },
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    const namen = body.result.tools.map((t) => t.name).sort();
    assert.deepEqual(namen, [
      'account_health',
      'get_budget',
      'get_klantprofiel',
      'get_profile',
      'get_results',
      'list_accounts',
      'queue_action',
      'search_people',
      'start_sequence',
    ]);
  });

  it('bevat GEEN tool die goedkeurt of verstuurt', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { token: TOKEN },
    );
    const body = (await res.json()) as {
      result: { tools: Array<{ name: string; description: string }> };
    };
    for (const tool of body.result.tools) {
      assert.doesNotMatch(
        tool.name,
        /^(approve|send|verstuur|goedkeur)/i,
        `Tool "${tool.name}" lijkt te verzenden of goed te keuren.`,
      );
    }
    const queueTool = body.result.tools.find((t) => t.name === 'queue_action');
    assert.match(queueTool!.description, /draft/i);
    assert.match(queueTool!.description, /goedkeuring/i);
    const startSeq = body.result.tools.find((t) => t.name === 'start_sequence');
    assert.match(startSeq!.description, /concept/i);
    assert.match(startSeq!.description, /goedkeuringspagina/i);
  });
});

describe('tools/call: queue_action blijft altijd draft', () => {
  it('maakt een draft en zet nooit goedkeurd_door of status=approved', async () => {
    const res = await postMcp(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'queue_action',
          arguments: {
            accountId,
            type: 'invite',
            payload: {
              providerId: 'ACo-xyz',
              message: 'Hoi Nina!',
              ontvanger_naam: 'Nina Jansen',
              ontvanger_functie: 'Marketing manager',
              ontvanger_bedrijf: 'Acme NV',
              ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
              waarom: 'Afkomstig uit zoekactie X-123.',
            },
          },
        },
      },
      { token: TOKEN },
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    assert.equal(body.result.isError, false);
    const payload = JSON.parse(body.result.content[0]!.text) as {
      actieId: string;
      status: string;
    };
    assert.equal(payload.status, 'draft');
    const actie = await vindActie(db, payload.actieId);
    assert.equal(actie?.status, 'draft');
    assert.equal(actie?.goedgekeurdDoor, null);
  });

  it('weigert een poging om "approved: true" mee te sturen', async () => {
    const res = await postMcp(
      {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/call',
        params: {
          name: 'queue_action',
          arguments: {
            accountId,
            type: 'invite',
            payload: {
              providerId: 'ACo-xyz',
              ontvanger_naam: 'Nina Jansen',
              ontvanger_functie: 'Marketing manager',
              ontvanger_bedrijf: 'Acme NV',
              ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
              waarom: 'Afkomstig uit zoekactie X-123.',
            },
            approved: true,
          },
        },
      },
      { token: TOKEN },
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0]!.text, /niet toegestaan via de MCP/);
  });
});

describe('tools/call: geen enkele tool verstuurt direct', () => {
  it('geen enkele tool kan Unipile aanroepen zonder dat er een draft/approved actie met budgetcheck is', async () => {
    // Haal alle tools op en roep ze aan met minimale argumenten;
    // controleer daarna dat er GEEN invite/message/inmail-aanroep naar fake-Unipile is gegaan
    // en dat er geen enkele actie met status "done" is voor invite/message/inmail.
    fake.antwoord('GET', /\/api\/v1\/users\/./, {
      status: 200,
      body: { provider_id: 'x', public_identifier: 'y' },
    });
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: { items: [] },
    });

    for (const naam of [
      'list_accounts',
      'account_health',
      'get_budget',
      'search_people',
      'get_profile',
      'queue_action',
      'start_sequence',
      'get_results',
    ]) {
      const argumenten: Record<string, unknown> = {};
      if (naam === 'account_health' || naam === 'get_budget') argumenten['accountId'] = accountId;
      if (naam === 'search_people') argumenten['accountId'] = accountId;
      if (naam === 'get_profile') {
        argumenten['accountId'] = accountId;
        argumenten['identifier'] = 'iemand';
      }
      if (naam === 'queue_action') {
        argumenten['accountId'] = accountId;
        argumenten['type'] = 'invite';
        argumenten['payload'] = {
          providerId: 'ACo-xyz',
          ontvanger_naam: 'Nina Jansen',
          ontvanger_functie: 'Marketing manager',
          ontvanger_bedrijf: 'Acme NV',
          ontvanger_url: 'https://www.linkedin.com/in/nina-jansen/',
          waarom: 'Afkomstig uit zoekactie X-123.',
        };
      }
      if (naam === 'start_sequence') {
        argumenten['accountId'] = accountId;
        argumenten['lead'] = {
          providerId: 'ACo-sv',
          naam: 'Sven',
          functie: 'CTO',
          bedrijf: 'Flux',
          linkedinUrl: 'https://www.linkedin.com/in/sven/',
          waarom: 'Lead uit zoekactie Y-456.',
        };
        argumenten['teksten'] = {
          invite: 'Hoi Sven, zullen we even sparren?',
          bericht: 'Dag Sven, dank voor de connectie.',
          opvolging: 'Nog even een reminder, Sven.',
        };
      }
      await postMcp(
        {
          jsonrpc: '2.0',
          id: naam,
          method: 'tools/call',
          params: { name: naam, arguments: argumenten },
        },
        { token: TOKEN },
      );
    }

    const invitePaden = fake.aanroepen.filter((a) => a.path === '/api/v1/users/invite');
    const berichtPaden = fake.aanroepen.filter((a) => /\/api\/v1\/chats\//.test(a.path));
    const chatStarts = fake.aanroepen.filter((a) => a.path === '/api/v1/chats');
    assert.equal(invitePaden.length, 0, 'MCP mag geen invite naar Unipile sturen');
    assert.equal(berichtPaden.length, 0, 'MCP mag geen bericht naar Unipile sturen');
    assert.equal(chatStarts.length, 0, 'MCP mag geen InMail naar Unipile sturen');

    const uitgevoerdeVerzendActies = await db.query<{ aantal: string }>(
      `select count(*)::text as aantal from actions
       where type in ('invite'::action_type, 'message'::action_type, 'inmail'::action_type)
         and status in ('done'::action_status, 'running'::action_status)`,
    );
    assert.equal(uitgevoerdeVerzendActies[0]?.aantal, '0');
  });
});

describe('JSON-RPC-protocol', () => {
  it('verwerkt notifications/initialized zonder antwoord-body (202)', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { token: TOKEN },
    );
    assert.equal(res.status, 202);
    const tekst = await res.text();
    assert.equal(tekst, '');
  });

  it('ping werkt', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 42, method: 'ping' },
      { token: TOKEN },
    );
    const body = (await res.json()) as { result: unknown; id: number };
    assert.equal(body.id, 42);
    assert.deepEqual(body.result, {});
  });

  it('onbekende methode levert JSON-RPC methodNotFound (−32601)', async () => {
    const res = await postMcp(
      { jsonrpc: '2.0', id: 1, method: 'bestaat/niet' },
      { token: TOKEN },
    );
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32601);
  });

  it('ongeldige JSON levert HTTP 400 met JSON-RPC-parsefout', async () => {
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: 'niet-json',
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: { code: number } };
    assert.equal(body.error?.code, -32700);
  });

  it('onbekende tool via tools/call levert isError:true met NL-tekst', async () => {
    const res = await postMcp(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'secret_tool', arguments: {} },
      },
      { token: TOKEN },
    );
    const body = (await res.json()) as {
      result: { content: Array<{ text: string }>; isError: boolean };
    };
    assert.equal(body.result.isError, true);
    assert.match(body.result.content[0]!.text, /Onbekende tool/);
  });
});
