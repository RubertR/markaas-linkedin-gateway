import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { markeerAccountGekoppeld, vindAccount } from './accounts.ts';
import { vindClientBijSlug } from './clients.ts';
import {
  NieuweKlantFout,
  maakNieuweKlant,
  maakNieuweKoppeluitnodiging,
  valideerSlug,
} from './nieuweklant.ts';
import { vindGeldigeUitnodiging } from './uitnodiging.ts';

let db: Backend;
let close: () => Promise<void>;
const NU = new Date('2026-10-07T10:00:00Z');
const OPTIES = { klok: vasteKlok(NU), geldigDagen: 7 };

const INVOER = {
  klantNaam: 'Acme B.V.',
  slug: 'acme',
  eigenaarNaam: 'Eva de Vries',
  eigenaarEmail: 'eva@acme.nl',
  abonnement: 'salesnav_core' as const,
  abonnementVereist: true,
};

before(async () => {
  ({ db, close } = await verseDatabaseMetMigraties());
});

after(async () => {
  await close();
});

beforeEach(async () => {
  await db.query('delete from account_consents');
  await db.query('delete from koppel_uitnodigingen');
  await db.query('delete from accounts');
  await db.query('delete from clients');
});

describe('valideerSlug', () => {
  it('accepteert a-z, 0-9 en koppeltekens', () => {
    assert.equal(valideerSlug('acme-2'), null);
  });
  it('weigert hoofdletters, spaties, lege en randkoppeltekens', () => {
    for (const fout of ['', 'Acme', 'ac me', '-acme', 'acme-', 'acmé', 'a_b']) {
      assert.ok(valideerSlug(fout), `"${fout}" zou geweigerd moeten worden`);
    }
  });
});

describe('maakNieuweKlant', () => {
  it('maakt client, account (CONNECTING, opbouw 0.5) en uitnodiging in één keer', async () => {
    const r = await maakNieuweKlant(db, INVOER, OPTIES);
    const client = await vindClientBijSlug(db, 'acme');
    assert.equal(client?.naam, 'Acme B.V.');
    assert.equal(client?.abonnementVereist, true);
    const account = await vindAccount(db, r.accountId);
    assert.equal(account?.clientId, client?.id);
    assert.equal(account?.eigenaarNaam, 'Eva de Vries');
    assert.equal(account?.eigenaarEmail, 'eva@acme.nl');
    assert.equal(account?.abonnement, 'salesnav_core');
    assert.equal(account?.status, 'CONNECTING');
    assert.equal(account?.opbouwFactor, 0.5);
    assert.equal(account?.tijdzone, 'Europe/Amsterdam');
    assert.equal(account?.unipileAccountId, null);
    const u = await vindGeldigeUitnodiging(db, r.uitnodiging.token, vasteKlok(NU));
    assert.equal(u?.accountId, r.accountId);
  });

  it('bewaart abonnement_vereist = false als het vinkje uit staat', async () => {
    await maakNieuweKlant(db, { ...INVOER, abonnementVereist: false }, OPTIES);
    assert.equal((await vindClientBijSlug(db, 'acme'))?.abonnementVereist, false);
  });

  it('geeft een NL-fout bij een dubbele slug en maakt niets aan', async () => {
    await maakNieuweKlant(db, INVOER, OPTIES);
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, klantNaam: 'Andere' }, OPTIES),
      (err: Error) => {
        assert.ok(err instanceof NieuweKlantFout);
        assert.match(err.message, /slug "acme" is al in gebruik/i);
        return true;
      },
    );
    const [t] = await db.query<{ c: number; a: number }>(
      `select (select count(*)::int from clients) as c, (select count(*)::int from accounts) as a`,
    );
    assert.deepEqual(t, { c: 1, a: 1 });
  });

  it('rolt alles terug als een latere stap faalt (transactie)', async () => {
    // Ongeldige geldigheid laat pas de uitnodiging (de laatste stap) falen.
    await assert.rejects(
      maakNieuweKlant(db, INVOER, { klok: vasteKlok(NU), geldigDagen: Number.NaN }),
    );
    const [t] = await db.query<{ c: number; a: number }>(
      `select (select count(*)::int from clients) as c, (select count(*)::int from accounts) as a`,
    );
    assert.deepEqual(t, { c: 0, a: 0 }, 'client en account mogen niet blijven staan');
  });

  it('weigert ongeldige invoer met NL-meldingen', async () => {
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, slug: 'Acme Corp' }, OPTIES),
      /slug/i,
    );
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, eigenaarEmail: 'geen-mail' }, OPTIES),
      /e-mailadres/i,
    );
    await assert.rejects(maakNieuweKlant(db, { ...INVOER, klantNaam: '  ' }, OPTIES), /klantnaam/i);
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, eigenaarNaam: '' }, OPTIES),
      /naam van de accounteigenaar/i,
    );
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, abonnement: 'gratis' as never }, OPTIES),
      /abonnement/i,
    );
  });
});

describe('maakNieuweKoppeluitnodiging', () => {
  it('maakt een nieuwe uitnodiging en laat de vorige vervallen', async () => {
    const r = await maakNieuweKlant(db, INVOER, OPTIES);
    const nieuw = await maakNieuweKoppeluitnodiging(db, r.accountId, OPTIES);
    assert.notEqual(nieuw.token, r.uitnodiging.token);
    assert.equal(await vindGeldigeUitnodiging(db, r.uitnodiging.token, vasteKlok(NU)), null);
    assert.ok(await vindGeldigeUitnodiging(db, nieuw.token, vasteKlok(NU)));
  });

  it('weigert voor een al gekoppeld account', async () => {
    const r = await maakNieuweKlant(db, INVOER, OPTIES);
    await markeerAccountGekoppeld(db, r.accountId, 'uni-9');
    await assert.rejects(
      maakNieuweKoppeluitnodiging(db, r.accountId, OPTIES),
      /al gekoppeld/i,
    );
  });

  it('weigert een onbekend account', async () => {
    await assert.rejects(
      maakNieuweKoppeluitnodiging(db, '00000000-0000-0000-0000-000000000000', OPTIES),
      /onbekend account/i,
    );
  });
});
