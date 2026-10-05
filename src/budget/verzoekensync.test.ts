import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import type { Backend } from '../db/backend.ts';
import { markeerAccountGekoppeld, registreerAccount, vindAccount } from '../register/accounts.ts';
import { maakClient } from '../register/clients.ts';
import { maakUnipileClient, type UnipileClient } from '../unipile/client.ts';
import { startFakeUnipile, type FakeUnipile } from '../../test/fake-unipile/server.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { vasteKlok } from './klok.ts';
import { laadLimieten, type Limieten } from './limits.ts';
import {
  spreidingPerDag,
  syncVerzoekenNu,
  verwerkVerzoekenSyncTick,
  type SyncMomentKiezer,
  type VerzoekenSyncDeps,
} from './verzoekensync.ts';

let db: Backend;
let close: () => Promise<void>;
let fake: FakeUnipile;
let unipile: UnipileClient;
let limieten: Limieten;
let accountId: string;
let clientId: string;
const UNIPILE_ACCOUNT_ID = 'uni-sync-1';
const PAD = '/api/v1/users/invite/sent';

// Dinsdag 6 okt 2026, 12:00 in Amsterdam.
const DINSDAG_MIDDAG = '2026-10-06T10:00:00Z';
const METEEN: SyncMomentKiezer = { minutenNaStart: () => 0 };

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
  fake = await startFakeUnipile();
  unipile = maakUnipileClient({ baseUrl: fake.baseUrl, apiKey: 'geheim', timeoutMs: 200 });
  limieten = await laadLimieten();
});

after(async () => {
  await fake.stop();
  await close();
});

beforeEach(async () => {
  await db.query('delete from actions');
  await db.query('delete from events');
  await db.query('delete from accounts');
  await db.query('delete from clients');
  fake.reset();
  const klant = await maakClient(db, { naam: 'Test', slug: 'sync' });
  clientId = klant.id;
  const account = await registreerAccount(db, {
    clientId,
    eigenaarNaam: 'Rubert',
    abonnement: 'salesnav_core',
  });
  accountId = account.id;
  await markeerAccountGekoppeld(db, accountId, UNIPILE_ACCOUNT_ID);
});

function deps(moment: string, overrides: Partial<VerzoekenSyncDeps> = {}): VerzoekenSyncDeps {
  return { db, unipile, limieten, klok: vasteKlok(moment), moment: METEEN, ...overrides };
}

function openstaandBijUnipile(aantal: number, cursor: string | null = null): void {
  fake.antwoord('GET', PAD, {
    status: 200,
    body: {
      object: 'InvitationList',
      items: Array.from({ length: aantal }, (_, i) => ({
        object: 'InvitationSent',
        id: `inv-${i}`,
        invited_user_id: `ACo-${i}`,
      })),
      cursor,
    },
  });
}

async function zetTeller(waarde: number): Promise<void> {
  await db.query('update accounts set openstaande_verzoeken = $2 where id = $1', [
    accountId,
    waarde,
  ]);
}

async function teller(): Promise<number | undefined> {
  return (await vindAccount(db, accountId))?.openstaandeVerzoeken;
}

function aantalGets(): number {
  return fake.aanroepen.filter((a) => a.method === 'GET' && a.path.startsWith(PAD)).length;
}

describe('verzoeken-sync — gelijkzetten', () => {
  it('zet de teller omhoog naar het werkelijke aantal openstaande invites', async () => {
    openstaandBijUnipile(6);
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(await teller(), 6);
    assert.equal(uit.resultaten.length, 1);
    assert.equal(uit.resultaten[0]?.resultaat, 'gelijkgezet');
    assert.equal(uit.resultaten[0]?.voor, 0);
    assert.equal(uit.resultaten[0]?.werkelijk, 6);
    assert.equal(uit.gatewayGestopt, false);
  });

  it('zet de teller omlaag (verlopen of ingetrokken invites staan niet meer in de lijst)', async () => {
    await zetTeller(9);
    openstaandBijUnipile(2);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(await teller(), 2);
  });

  it('legt de sync vast als gateway-event met voor en werkelijk', async () => {
    await zetTeller(4);
    openstaandBijUnipile(3);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    const rijen = await db.query<{ extern_id: string; payload: Record<string, unknown> }>(
      "select extern_id, payload from events where type = 'verzoeken_sync'",
    );
    assert.equal(rijen.length, 1);
    assert.equal(rijen[0]?.extern_id, `verzoeken_sync:${accountId}:2026-10-06`);
    assert.equal(rijen[0]?.payload['resultaat'], 'gelijkgezet');
    assert.equal(rijen[0]?.payload['voor'], 4);
    assert.equal(rijen[0]?.payload['werkelijk'], 3);
  });

  it('meer pagina’s dan max_paginas: teller wordt de ondergrens en het resultaat zegt "minstens"', async () => {
    const klein: Limieten = { ...limieten, verzoeken_sync: { pagina_grootte: 2, max_paginas: 2 } };
    openstaandBijUnipile(2, 'nog-meer');
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG, { limieten: klein }));
    assert.equal(await teller(), 4);
    assert.equal(uit.resultaten[0]?.volledig, false);
    assert.match(uit.resultaten[0]?.reden ?? '', /minstens 4/);
    assert.equal(aantalGets(), 2);
  });
});

describe('verzoeken-sync — één keer per werkdag binnen het tijdvenster', () => {
  it('tweede tick op dezelfde dag doet geen GET meer', async () => {
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    const tweede = await verwerkVerzoekenSyncTick(deps('2026-10-06T14:00:00Z'));
    assert.equal(aantalGets(), 1);
    assert.equal(tweede.resultaten.length, 0);
  });

  it('de volgende werkdag weer wel', async () => {
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    await verwerkVerzoekenSyncTick(deps('2026-10-07T10:00:00Z'));
    assert.equal(aantalGets(), 2);
  });

  it('zaterdag: geen GET', async () => {
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps('2026-10-10T10:00:00Z'));
    assert.equal(aantalGets(), 0);
  });

  it('vóór 08:30 lokale tijd: geen GET', async () => {
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps('2026-10-06T06:00:00Z')); // 08:00 Amsterdam
    assert.equal(aantalGets(), 0);
  });

  it('tijdvenster in de tijdzone van het account', async () => {
    await db.query("update accounts set tijdzone = 'America/New_York' where id = $1", [accountId]);
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG)); // 06:00 in New York
    assert.equal(aantalGets(), 0);
    await verwerkVerzoekenSyncTick(deps('2026-10-06T15:00:00Z')); // 11:00 in New York
    assert.equal(aantalGets(), 1);
  });

  it('wacht tot het willekeurige moment van de dag', async () => {
    openstaandBijUnipile(1);
    const om1330: SyncMomentKiezer = { minutenNaStart: () => 300 }; // 08:30 + 5 uur
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG, { moment: om1330 }));
    assert.equal(aantalGets(), 0);
    await verwerkVerzoekenSyncTick(deps('2026-10-06T11:45:00Z', { moment: om1330 })); // 13:45
    assert.equal(aantalGets(), 1);
  });

  it('spreidingPerDag: vast per account en dag, binnen het venster, verschilt per dag', () => {
    const a = spreidingPerDag.minutenNaStart('acc-1', '2026-10-06', 540);
    assert.equal(spreidingPerDag.minutenNaStart('acc-1', '2026-10-06', 540), a);
    const dagen = ['2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12'];
    const waarden = dagen.map((d) => spreidingPerDag.minutenNaStart('acc-1', d, 540));
    for (const w of waarden) {
      assert.ok(Number.isInteger(w) && w >= 0 && w < 540 - 30, `buiten venster: ${w}`);
    }
    assert.ok(new Set(waarden).size > 1);
  });
});

describe('verzoeken-sync — accounts die niet aan de beurt zijn', () => {
  it('in afkoeling: geen GET', async () => {
    await db.query(
      "update accounts set afkoeling_tot = '2026-10-07T10:00:00Z' where id = $1",
      [accountId],
    );
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(aantalGets(), 0);
  });

  it('status CREDENTIALS: geen GET', async () => {
    await db.query("update accounts set status = 'CREDENTIALS' where id = $1", [accountId]);
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(aantalGets(), 0);
  });

  it('nog niet gekoppeld: geen GET', async () => {
    await registreerAccount(db, { clientId, eigenaarNaam: 'Nieuw', abonnement: 'free' });
    openstaandBijUnipile(1);
    await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(aantalGets(), 1);
  });
});

describe('verzoeken-sync — foutpaden', () => {
  it('429: teller ongewijzigd, account in afkoeling, geen tweede poging dezelfde dag', async () => {
    await zetTeller(5);
    fake.antwoord('GET', PAD, { status: 429, body: { error: 'rate_limited' } });
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(uit.resultaten[0]?.resultaat, 'afkoeling');
    assert.match(uit.resultaten[0]?.reden ?? '', /429/);
    const account = await vindAccount(db, accountId);
    assert.equal(account?.openstaandeVerzoeken, 5);
    assert.ok(account?.afkoelingTot);

    await verwerkVerzoekenSyncTick(deps('2026-10-06T14:00:00Z'));
    assert.equal(aantalGets(), 1);
  });

  it('time-out: teller ongewijzigd, geen tweede poging dezelfde dag, de volgende werkdag wel', async () => {
    await zetTeller(5);
    fake.antwoord('GET', PAD, {
      status: 200,
      delayMs: 400,
      body: { object: 'InvitationList', items: [], cursor: null },
    });
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(uit.resultaten[0]?.resultaat, 'time-out');
    assert.match(uit.resultaten[0]?.reden ?? '', /time-out|niet binnen/i);
    assert.equal(await teller(), 5);
    assert.equal((await vindAccount(db, accountId))?.afkoelingTot, null);

    await verwerkVerzoekenSyncTick(deps('2026-10-06T14:00:00Z'));
    assert.equal(aantalGets(), 1);

    fake.reset();
    openstaandBijUnipile(3);
    await verwerkVerzoekenSyncTick(deps('2026-10-07T10:00:00Z'));
    assert.equal(await teller(), 3);
  });

  it('CREDENTIALS-fout: alleen dit account op CREDENTIALS, teller ongewijzigd', async () => {
    await zetTeller(5);
    fake.antwoord('GET', PAD, {
      status: 400,
      body: { type: 'errors/disconnected_account', title: 'Disconnected account' },
    });
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(uit.resultaten[0]?.resultaat, 'fout');
    const account = await vindAccount(db, accountId);
    assert.equal(account?.status, 'CREDENTIALS');
    assert.equal(account?.openstaandeVerzoeken, 5);
  });

  it('401 (gateway-sleutel): gatewayGestopt en geen GET voor de volgende accounts', async () => {
    const tweede = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Tweede',
      abonnement: 'salesnav_core',
    });
    await markeerAccountGekoppeld(db, tweede.id, 'uni-sync-2');
    fake.antwoord('GET', PAD, { status: 401, body: { error: 'nope' } });
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(uit.gatewayGestopt, true);
    assert.equal(aantalGets(), 1);
  });

  it('500: teller ongewijzigd, nette NL-reden', async () => {
    await zetTeller(5);
    fake.antwoord('GET', PAD, { status: 500, body: {} });
    const uit = await verwerkVerzoekenSyncTick(deps(DINSDAG_MIDDAG));
    assert.equal(uit.resultaten[0]?.resultaat, 'fout');
    assert.match(uit.resultaten[0]?.reden ?? '', /Unipile/);
    assert.equal(await teller(), 5);
  });
});

describe('syncVerzoekenNu (eenmalig script)', () => {
  it('dry-run: doet de GET maar schrijft niets', async () => {
    await zetTeller(0);
    openstaandBijUnipile(6);
    const uit = await syncVerzoekenNu(deps(DINSDAG_MIDDAG), { uitvoeren: false });
    assert.equal(uit.resultaten[0]?.resultaat, 'zou_gelijkzetten');
    assert.equal(uit.resultaten[0]?.werkelijk, 6);
    assert.equal(await teller(), 0);
    const events = await db.query("select 1 from events where type = 'verzoeken_sync'");
    assert.equal(events.length, 0);
  });

  it('--uitvoeren: zet gelijk en telt als de sync van vandaag', async () => {
    openstaandBijUnipile(6);
    await syncVerzoekenNu(deps(DINSDAG_MIDDAG), { uitvoeren: true });
    assert.equal(await teller(), 6);
    await verwerkVerzoekenSyncTick(deps('2026-10-06T14:00:00Z'));
    assert.equal(aantalGets(), 1);
  });

  it('wacht niet op het willekeurige moment, maar respecteert het tijdvenster', async () => {
    openstaandBijUnipile(1);
    const laat: SyncMomentKiezer = { minutenNaStart: () => 500 };
    await syncVerzoekenNu(deps(DINSDAG_MIDDAG, { moment: laat }), { uitvoeren: false });
    assert.equal(aantalGets(), 1);

    const buiten = await syncVerzoekenNu(deps('2026-10-10T10:00:00Z'), { uitvoeren: false });
    assert.equal(aantalGets(), 1);
    assert.equal(buiten.resultaten[0]?.resultaat, 'overgeslagen');
    assert.match(buiten.resultaten[0]?.reden ?? '', /werkdag|tijdvenster/i);
  });

  it('dry-run bij 429: geen afkoeling geschreven, wel een duidelijke melding', async () => {
    fake.antwoord('GET', PAD, { status: 429, body: {} });
    const uit = await syncVerzoekenNu(deps(DINSDAG_MIDDAG), { uitvoeren: false });
    assert.equal(uit.resultaten[0]?.resultaat, 'afkoeling');
    assert.match(uit.resultaten[0]?.reden ?? '', /429/);
    assert.equal((await vindAccount(db, accountId))?.afkoelingTot, null);
  });
});
