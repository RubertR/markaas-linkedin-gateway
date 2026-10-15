import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import { laadLimieten, type Limieten } from '../budget/limits.ts';
import type { Backend } from '../db/backend.ts';
import { vastePauze } from '../queue/pauze.ts';
import { markeerAccountGekoppeld, registreerAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import {
  McpSynchroonFout,
  voerSynchroonUit,
  type SynchroonContext,
} from './synchroon.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;

const NU = new Date('2026-10-06T10:00:00Z');

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
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();

  const client = await maakClient(db, { naam: 'Markaas Test', slug: 'markaas-sync-test' });
  const account = await registreerAccount(db, {
    clientId: client.id,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, 'unipile-rubert');
  // Opbouw op 1.0 zodat 1 zoekrun door het dagbudget past.
  await db.query(`update accounts set opbouw_factor = 1.0 where id = $1`, [accountId]);
});

function maakCtx(opts: { pauzeSec?: number } = {}): SynchroonContext {
  return {
    db,
    unipile,
    limieten,
    klok: vasteKlok(NU),
    pauzeKiezer: vastePauze(opts.pauzeSec ?? 60),
  };
}

async function registreerEerdereActie(
  type: 'profile' | 'search',
  uitgevoerdOp: Date,
): Promise<void> {
  await db.query(
    `insert into actions(account_id, type, payload, status, uitgevoerd_op)
     values ($1, $2::action_type, '{}'::jsonb, 'done'::action_status, $3)`,
    [accountId, type, uitgevoerdOp.toISOString()],
  );
}

describe('synchroon-pauze per type', () => {
  it('gebruikt de profiel-pauze uit limits.json (geen hardcoded waarde)', () => {
    const grens = limieten.tijdvenster.pauze_mcp_sync_seconden.profile;
    assert.equal(grens.min, 30);
    assert.equal(grens.max, 90);
    const zoekGrens = limieten.tijdvenster.pauze_mcp_sync_seconden.search;
    assert.equal(zoekGrens.min, 120);
    assert.equal(zoekGrens.max, 480);
  });

  it('laat profiel direct door wanneer er nog geen profile-actie is uitgevoerd', async () => {
    fake.antwoord('GET', /\/api\/v1\/users\/rubert/, {
      status: 200,
      body: { provider_id: 'ACo-abc', public_identifier: 'rubert' },
    });
    const ctx = maakCtx({ pauzeSec: 45 });
    const uit = await voerSynchroonUit(ctx, {
      accountId,
      type: 'profile',
      payload: { identifier: 'rubert' },
    });
    assert.equal(uit.response['provider_id'], 'ACo-abc');
  });

  it('weigert een tweede profiel binnen de minimale pauze met NL-melding', async () => {
    // Vorige profile-actie 10 seconden geleden; minPauze = 45 s (vastePauze).
    await registreerEerdereActie('profile', new Date(NU.getTime() - 10_000));
    const ctx = maakCtx({ pauzeSec: 45 });
    await assert.rejects(
      () =>
        voerSynchroonUit(ctx, {
          accountId,
          type: 'profile',
          payload: { identifier: 'rubert' },
        }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.equal((err as McpSynchroonFout).oorzaak, 'wachtrij');
        assert.equal((err as McpSynchroonFout).actieId, null);
        assert.match(err.message, /probeer opnieuw over \d+ seconden/i);
        assert.match(err.message, /profile/);
        return true;
      },
    );
    // Belangrijk: géén nieuwe actie aangemaakt (alleen de eerder-ingevoegde
    // 'done'-rij), géén Unipile-aanroep.
    const rijen = await db.query<{ aantal: number | string }>(
      `select count(*)::int as aantal from actions
       where account_id = $1 and status in ('draft'::action_status, 'approved'::action_status,
                                            'queued'::action_status, 'rejected'::action_status)`,
      [accountId],
    );
    assert.equal(Number(rijen[0]?.aantal), 0, 'er mag geen nieuwe actie zijn aangemaakt');
    assert.equal(fake.aanroepen.length, 0, 'Unipile mag niet aangeroepen zijn');
  });

  it('laat een profiel door nadat de minimale pauze is verstreken', async () => {
    // Vorige profile-actie 100 s geleden; minPauze = 45 s → mag door.
    await registreerEerdereActie('profile', new Date(NU.getTime() - 100_000));
    fake.antwoord('GET', /\/api\/v1\/users\/rubert/, {
      status: 200,
      body: { provider_id: 'ACo-abc', public_identifier: 'rubert' },
    });
    const ctx = maakCtx({ pauzeSec: 45 });
    const uit = await voerSynchroonUit(ctx, {
      accountId,
      type: 'profile',
      payload: { identifier: 'rubert' },
    });
    assert.equal(uit.response['provider_id'], 'ACo-abc');
  });

  it('weegt per type: een recente profile blokkeert geen search', async () => {
    // profile 10 s geleden; voor type search is er nog niets.
    await registreerEerdereActie('profile', new Date(NU.getTime() - 10_000));
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: { items: [{ id: 'ACo-1', public_identifier: 'p-1' }], paging: { total_count: 1 } },
    });
    const ctx = maakCtx({ pauzeSec: 180 });
    const uit = await voerSynchroonUit(ctx, {
      accountId,
      type: 'search',
      payload: { keywords: 'logistiek', limit: 10 },
    });
    assert.ok(uit.actieId);
    assert.equal((uit.response as { items: unknown[] }).items.length, 1);
  });

  it('weigert een tweede search binnen de 2-8 min grens met NL-melding', async () => {
    // Vorige search 30 s geleden; minPauze = 180 s → wachten.
    await registreerEerdereActie('search', new Date(NU.getTime() - 30_000));
    const ctx = maakCtx({ pauzeSec: 180 });
    await assert.rejects(
      () =>
        voerSynchroonUit(ctx, {
          accountId,
          type: 'search',
          payload: { keywords: 'logistiek' },
        }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.match(err.message, /probeer opnieuw over 150 seconden/i);
        assert.match(err.message, /search/);
        return true;
      },
    );
  });

  it('kiest de pauze op basis van de JUISTE grens per type (profile vs search)', async () => {
    const gezien: Array<{ min: number; max: number }> = [];
    const kiezer = {
      kies: () => 0,
      kiesSeconden: (grens: { min: number; max: number }) => {
        gezien.push({ min: grens.min, max: grens.max });
        return grens.min; // deterministisch
      },
    };
    const ctx: SynchroonContext = {
      db,
      unipile,
      limieten,
      klok: vasteKlok(NU),
      pauzeKiezer: kiezer,
    };
    fake.antwoord('GET', /\/api\/v1\/users\/rubert/, {
      status: 200,
      body: { provider_id: 'ACo-abc', public_identifier: 'rubert' },
    });
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 200,
      body: { items: [], paging: { total_count: 0 } },
    });

    await voerSynchroonUit(ctx, {
      accountId,
      type: 'profile',
      payload: { identifier: 'rubert' },
    });
    await voerSynchroonUit(ctx, {
      accountId,
      type: 'search',
      payload: { keywords: 'x' },
    });
    assert.deepEqual(gezien[0], { min: 30, max: 90 });
    assert.deepEqual(gezien[1], { min: 120, max: 480 });
  });
});

describe('synchroon — terugboeken bij weigering vóór LinkedIn (SPEC §5.1)', () => {
  it('400 invalid_parameters: NL-melding "zoekrun is niet verbruikt", verbruik 0, direct opnieuw kan', async () => {
    let aanroepen = 0;
    fake.antwoord('POST', '/api/v1/linkedin/search', () => {
      aanroepen += 1;
      return aanroepen === 1
        ? { status: 400, body: { status: 400, type: 'errors/invalid_parameters', title: 'Invalid parameters' } }
        : { status: 200, body: { items: [{ id: 'ACo-1' }], paging: { total_count: 1 } } };
    });
    const ctx = maakCtx({ pauzeSec: 180 });
    await assert.rejects(
      () => voerSynchroonUit(ctx, { accountId, type: 'search', payload: { keywords: 'x' } }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.match(err.message, /vóór LinkedIn/);
        assert.match(err.message, /errors\/invalid_parameters/);
        assert.match(err.message, /zoekrun is niet verbruikt/);
        return true;
      },
    );
    const rijen = await db.query<{ aantal: number }>(
      `select coalesce(sum(aantal), 0)::int as aantal from usage where account_id = $1 and type = 'search'`,
      [accountId],
    );
    assert.equal(Number(rijen[0]?.aantal), 0);

    // Gecorrigeerde aanvraag: geen pauze-blokkade en het dagbudget is er nog.
    const uit = await voerSynchroonUit(ctx, { accountId, type: 'search', payload: { keywords: 'y' } });
    assert.equal((uit.response as { items: unknown[] }).items.length, 1);
  });

  it('400 target_audience_too_small: zoekrun telt wel mee', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 400,
      body: { status: 400, type: 'errors/target_audience_too_small' },
    });
    await assert.rejects(
      () => voerSynchroonUit(maakCtx(), { accountId, type: 'search', payload: { keywords: 'x' } }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /niet verbruikt/);
        return true;
      },
    );
    const rijen = await db.query<{ aantal: number }>(
      `select coalesce(sum(aantal), 0)::int as aantal from usage where account_id = $1 and type = 'search'`,
      [accountId],
    );
    assert.equal(Number(rijen[0]?.aantal), 1);
  });
});

describe('synchroon — 401/403 per account (SPEC §6a)', () => {
  async function accountStatus(): Promise<string | undefined> {
    const rijen = await db.query<{ status: string }>('select status from accounts where id = $1', [accountId]);
    return rijen[0]?.status;
  }

  it('403 feature_not_subscribed: structurele NL-fout, account blijft OK, zoekrun telt mee', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 403,
      body: { status: 403, type: 'errors/feature_not_subscribed' },
    });
    await assert.rejects(
      () =>
        voerSynchroonUit(maakCtx(), {
          accountId,
          type: 'search',
          payload: { api: 'sales_navigator', keywords: 'x' },
        }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.equal(err.structureel, true);
        assert.match(err.message, /functie zit niet in het LinkedIn-abonnement van dit account/);
        return true;
      },
    );
    assert.equal(await accountStatus(), 'OK');
    const rijen = await db.query<{ aantal: number }>(
      `select coalesce(sum(aantal), 0)::int as aantal from usage where account_id = $1 and type = 'search'`,
      [accountId],
    );
    assert.equal(Number(rijen[0]?.aantal), 1);
  });

  it('401 expired_credentials op een profiel: account naar CREDENTIALS, NL-fout', async () => {
    fake.antwoord('GET', /^\/api\/v1\/users\//, {
      status: 401,
      body: { status: 401, type: 'errors/expired_credentials' },
    });
    await assert.rejects(
      () => voerSynchroonUit(maakCtx(), { accountId, type: 'profile', payload: { identifier: 'jan' } }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.match(err.message, /sessie/i);
        return true;
      },
    );
    assert.equal(await accountStatus(), 'CREDENTIALS');
  });

  it('401 zonder type, controle-aanroep geslaagd: account naar ERROR, geen gateway-stop', async () => {
    fake.antwoord('GET', /^\/api\/v1\/users\//, { status: 401, body: {} });
    fake.antwoord('GET', '/api/v1/accounts', { status: 200, body: { items: [] } });
    await assert.rejects(
      () => voerSynchroonUit(maakCtx(), { accountId, type: 'profile', payload: { identifier: 'jan' } }),
      (err: Error) => {
        assert.ok(err instanceof McpSynchroonFout);
        assert.match(err.message, /controle-aanroep geslaagd/);
        return true;
      },
    );
    assert.equal(await accountStatus(), 'ERROR');
  });
});

describe('synchroon — account op pauze (SPEC §6b)', () => {
  async function tellen(): Promise<{ acties: number; usage: number }> {
    const [a] = await db.query<{ n: number }>('select count(*)::int as n from actions where account_id = $1', [accountId]);
    const [u] = await db.query<{ n: number }>(
      'select coalesce(sum(aantal), 0)::int as n from usage where account_id = $1',
      [accountId],
    );
    return { acties: Number(a?.n), usage: Number(u?.n) };
  }

  for (const status of ['CREDENTIALS', 'ERROR', 'STOPPED'] as const) {
    for (const type of ['search', 'profile'] as const) {
      it(`${type} op een account met ${status}: NL-weigering, geen Unipile-aanroep, geen budget, geen actie`, async () => {
        await db.query(`update accounts set status = $2::account_status where id = $1`, [accountId, status]);
        fake.antwoord('POST', '/api/v1/linkedin/search', { status: 200, body: { items: [] } });
        fake.antwoord('GET', /^\/api\/v1\/users\//, { status: 200, body: { provider_id: 'ACo-x' } });
        await assert.rejects(
          () =>
            voerSynchroonUit(maakCtx(), {
              accountId,
              type,
              payload: type === 'search' ? { keywords: 'x' } : { identifier: 'jan' },
            }),
          (err: Error) => {
            assert.ok(err instanceof McpSynchroonFout);
            const f = err as McpSynchroonFout;
            assert.equal(f.oorzaak, 'weigering');
            assert.equal(f.structureel, true);
            assert.equal(f.actieId, null);
            assert.match(err.message, /geweigerd: dit account staat op pauze/);
            assert.match(err.message, new RegExp(status));
            assert.match(err.message, /niet geparkeerd/);
            assert.match(err.message, /geen budget verbruikt/);
            return true;
          },
        );
        assert.equal(fake.aanroepen.length, 0, 'Unipile mag niet aangeroepen zijn');
        assert.deepEqual(await tellen(), { acties: 0, usage: 0 });
      });
    }
  }

  it('401 tijdens de aanroep zet het account op pauze: de actie wordt rejected, niet queued', async () => {
    fake.antwoord('POST', '/api/v1/linkedin/search', {
      status: 401,
      body: { status: 401, type: 'errors/disconnected_account' },
    });
    await assert.rejects(() => voerSynchroonUit(maakCtx(), { accountId, type: 'search', payload: { keywords: 'x' } }));
    const rijen = await db.query<{ status: string }>(
      'select status::text as status from actions where account_id = $1',
      [accountId],
    );
    assert.deepEqual(rijen.map((r) => r.status), ['rejected']);
  });
});
