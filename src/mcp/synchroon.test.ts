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
