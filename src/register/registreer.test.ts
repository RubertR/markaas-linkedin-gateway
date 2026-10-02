import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { markeerAccountGekoppeld, registreerAccount, vindAccount } from './accounts.ts';
import { maakClient, vindClientBijSlug } from './clients.ts';
import {
  maakSlug,
  parseerArgumenten,
  registreerKlantEnAccount,
  type RegistreerKlantInvoer,
} from './registreer.ts';

let db: Backend;
let close: () => Promise<void>;

const INVOER: RegistreerKlantInvoer = {
  klant: 'MARKaaS',
  eigenaar: 'Rubert Rietkerk',
  unipileId: 'unipile-abc-123',
  abonnement: 'salesnav_core',
};

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from accounts');
  await db.query('delete from clients');
});

async function aantal(tabel: 'clients' | 'accounts'): Promise<number> {
  const rijen = await db.query<{ n: string }>(`select count(*)::text as n from ${tabel}`);
  return Number(rijen[0]?.n);
}

describe('maakSlug', () => {
  it('maakt kleine letters en vervangt overige tekens door streepjes', () => {
    assert.equal(maakSlug('MARKaaS'), 'markaas');
    assert.equal(maakSlug('  Acme & Zn. B.V. '), 'acme-zn-b-v');
  });
});

describe('registreerKlantEnAccount', () => {
  it('maakt klant en account aan met status OK, opbouw 0.5 en Europe/Amsterdam', async () => {
    const uitkomst = await registreerKlantEnAccount(db, INVOER);
    assert.equal(uitkomst.klant, 'aangemaakt');
    assert.equal(uitkomst.account, 'aangemaakt');
    assert.ok(uitkomst.accountId);

    const account = await vindAccount(db, uitkomst.accountId);
    assert.equal(account?.status, 'OK');
    assert.equal(account?.opbouwFactor, 0.5);
    assert.equal(account?.tijdzone, 'Europe/Amsterdam');
    assert.equal(account?.abonnement, 'salesnav_core');
    assert.equal(account?.eigenaarNaam, 'Rubert Rietkerk');
    assert.equal(account?.unipileAccountId, 'unipile-abc-123');

    const klant = await vindClientBijSlug(db, 'markaas');
    assert.equal(klant?.naam, 'MARKaaS');
    assert.equal(account?.clientId, klant?.id);
  });

  it('is idempotent: de tweede keer bestaat alles al en blijft het id gelijk', async () => {
    const eerste = await registreerKlantEnAccount(db, INVOER);
    const tweede = await registreerKlantEnAccount(db, INVOER);
    assert.equal(tweede.klant, 'bestaat_al');
    assert.equal(tweede.account, 'bestaat_al');
    assert.equal(tweede.accountId, eerste.accountId);
    assert.equal(await aantal('clients'), 1);
    assert.equal(await aantal('accounts'), 1);
  });

  it('hergebruikt een bestaande klant en maakt alleen het account aan', async () => {
    const klant = await maakClient(db, { naam: 'MARKaaS', slug: 'markaas' });
    const uitkomst = await registreerKlantEnAccount(db, INVOER);
    assert.equal(uitkomst.klant, 'bestaat_al');
    assert.equal(uitkomst.account, 'aangemaakt');
    assert.equal((await vindAccount(db, uitkomst.accountId!))?.clientId, klant.id);
  });

  it('weigert als het Unipile-id al bij een account van een andere klant hoort', async () => {
    const ander = await maakClient(db, { naam: 'Ander', slug: 'ander' });
    const a = await registreerAccount(db, {
      clientId: ander.id,
      eigenaarNaam: 'Iemand',
      abonnement: 'free',
    });
    await markeerAccountGekoppeld(db, a.id, INVOER.unipileId);
    await assert.rejects(registreerKlantEnAccount(db, INVOER), /andere klant/);
    assert.equal(await aantal('clients'), 1, 'geen halve registratie achtergelaten');
  });

  describe('dry-run', () => {
    it('schrijft niets en meldt wat er zou gebeuren', async () => {
      const uitkomst = await registreerKlantEnAccount(db, INVOER, { dryRun: true });
      assert.equal(uitkomst.klant, 'zou_aanmaken');
      assert.equal(uitkomst.account, 'zou_aanmaken');
      assert.equal(uitkomst.accountId, null);
      assert.equal(await aantal('clients'), 0);
      assert.equal(await aantal('accounts'), 0);
    });

    it('geeft het bestaande id als alles al bestaat', async () => {
      const echt = await registreerKlantEnAccount(db, INVOER);
      const droog = await registreerKlantEnAccount(db, INVOER, { dryRun: true });
      assert.equal(droog.klant, 'bestaat_al');
      assert.equal(droog.account, 'bestaat_al');
      assert.equal(droog.accountId, echt.accountId);
    });
  });
});

describe('parseerArgumenten', () => {
  const BASIS = [
    '--klant', 'MARKaaS',
    '--eigenaar', 'Rubert Rietkerk',
    '--unipile-id', 'unipile-abc-123',
    '--abonnement', 'salesnav_core',
  ];

  it('leest alle opties, dry-run standaard uit', () => {
    assert.deepEqual(parseerArgumenten(BASIS), { invoer: INVOER, dryRun: false });
  });

  it('herkent --dry-run', () => {
    assert.equal(parseerArgumenten([...BASIS, '--dry-run']).dryRun, true);
  });

  it('noemt alle ontbrekende opties in één melding', () => {
    assert.throws(() => parseerArgumenten(['--klant', 'MARKaaS']), (err: Error) => {
      assert.match(err.message, /--eigenaar/);
      assert.match(err.message, /--unipile-id/);
      assert.match(err.message, /--abonnement/);
      return true;
    });
  });

  it('weigert een onbekend abonnement en noemt de geldige waarden', () => {
    const args = [...BASIS.slice(0, 6), '--abonnement', 'gold'];
    assert.throws(() => parseerArgumenten(args), /salesnav_core/);
  });

  it('weigert onbekende opties', () => {
    assert.throws(() => parseerArgumenten([...BASIS, '--force']), /--force/);
  });
});
