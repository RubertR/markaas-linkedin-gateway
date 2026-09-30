import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { maakClient } from './clients.ts';
import {
  markeerAccountGekoppeld,
  registreerAccount,
  vindAccount,
  vindAccountBijUnipileId,
  werkAccountStatusBij,
} from './accounts.ts';

let db: Backend;
let close: () => Promise<void>;
let clientId: string;

before(async () => {
  const opgezet = await verseDatabaseMetMigraties();
  db = opgezet.db;
  close = opgezet.close;
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from accounts');
  await db.query('delete from clients');
  const client = await maakClient(db, { naam: 'Test-klant', slug: 'test-klant' });
  clientId = client.id;
});

describe('accounts — registreerAccount', () => {
  it('start op status CONNECTING, opbouw_factor 0.50, openstaande_verzoeken 0', async () => {
    const account = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert Rietkerk',
      abonnement: 'salesnav_core',
    });
    assert.ok(account.id);
    assert.equal(account.status, 'CONNECTING');
    assert.equal(account.opbouwFactor, 0.5);
    assert.equal(account.openstaandeVerzoeken, 0);
    assert.equal(account.unipileAccountId, null);
    assert.equal(account.afkoelingTot, null);
    assert.equal(account.tijdzone, 'Europe/Amsterdam');
  });

  it('accepteert een expliciete tijdzone', async () => {
    const account = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
      tijdzone: 'Europe/Berlin',
    });
    assert.equal(account.tijdzone, 'Europe/Berlin');
  });
});

describe('accounts — vindAccount / vindAccountBijUnipileId', () => {
  it('vindt een account op id', async () => {
    const gemaakt = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
    });
    const gevonden = await vindAccount(db, gemaakt.id);
    assert.ok(gevonden);
    assert.equal(gevonden?.id, gemaakt.id);
  });

  it('geeft null terug bij een onbekend id', async () => {
    const gevonden = await vindAccount(db, '00000000-0000-0000-0000-000000000000');
    assert.equal(gevonden, null);
  });

  it('vindt een account op unipile_account_id na koppeling', async () => {
    const gemaakt = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
    });
    await markeerAccountGekoppeld(db, gemaakt.id, 'unipile-xyz-42');
    const gevonden = await vindAccountBijUnipileId(db, 'unipile-xyz-42');
    assert.ok(gevonden);
    assert.equal(gevonden?.id, gemaakt.id);
    assert.equal(gevonden?.unipileAccountId, 'unipile-xyz-42');
  });
});

describe('accounts — markeerAccountGekoppeld', () => {
  it('zet unipile_account_id, status OK en status_sinds op nu', async () => {
    const gemaakt = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
    });
    const voor = new Date();
    await markeerAccountGekoppeld(db, gemaakt.id, 'unipile-xyz');
    const na = new Date();

    const account = await vindAccount(db, gemaakt.id);
    assert.equal(account?.unipileAccountId, 'unipile-xyz');
    assert.equal(account?.status, 'OK');
    assert.ok(account?.statusSinds);
    assert.ok(account.statusSinds.getTime() >= voor.getTime() - 1000);
    assert.ok(account.statusSinds.getTime() <= na.getTime() + 1000);
  });

  it('weigert een dubbele koppeling met hetzelfde unipile_account_id', async () => {
    const a = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert 1',
      abonnement: 'salesnav_core',
    });
    const b = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert 2',
      abonnement: 'salesnav_core',
    });
    await markeerAccountGekoppeld(db, a.id, 'unipile-dubbel');
    await assert.rejects(
      markeerAccountGekoppeld(db, b.id, 'unipile-dubbel'),
      /unipile_account_id|bestaat al|duplicaat/i,
    );
  });
});

describe('accounts — werkAccountStatusBij', () => {
  it('werkt status bij en zet status_sinds op nu', async () => {
    const gemaakt = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
    });
    await markeerAccountGekoppeld(db, gemaakt.id, 'unipile-x');

    await werkAccountStatusBij(db, gemaakt.id, 'CREDENTIALS');
    const na = await vindAccount(db, gemaakt.id);
    assert.equal(na?.status, 'CREDENTIALS');
  });

  it('wist afkoeling_tot bij een expliciete vlag', async () => {
    const gemaakt = await registreerAccount(db, {
      clientId,
      eigenaarNaam: 'Rubert',
      abonnement: 'salesnav_core',
    });
    await db.query(
      `update accounts set afkoeling_tot = now() + interval '48 hours' where id = $1`,
      [gemaakt.id],
    );

    await werkAccountStatusBij(db, gemaakt.id, 'OK', { afkoelingTotWissen: true });
    const na = await vindAccount(db, gemaakt.id);
    assert.equal(na?.status, 'OK');
    assert.equal(na?.afkoelingTot, null);
  });
});
