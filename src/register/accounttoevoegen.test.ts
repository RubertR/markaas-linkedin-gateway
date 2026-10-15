import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { vasteKlok } from '../budget/klok.ts';
import type { Backend } from '../db/backend.ts';
import { verseDatabaseMetMigraties } from '../../test/helpers/pglite.ts';

import { vindAccount } from './accounts.ts';
import { voegAccountToe } from './accounttoevoegen.ts';
import { vindClientBijSlug } from './clients.ts';
import { NieuweKlantFout, maakNieuweKlant } from './nieuweklant.ts';
import { vindGeldigeUitnodiging } from './uitnodiging.ts';

let db: Backend;
let close: () => Promise<void>;
const NU = new Date('2026-10-15T10:00:00Z');
const DAG = 24 * 60 * 60 * 1000;
const OPTIES = { klok: vasteKlok(NU), geldigDagen: 7 };

const TOEVOEGEN = {
  slug: 'acme',
  eigenaarNaam: 'Tom Baker',
  eigenaarEmail: 'tom@acme.co.uk',
  abonnement: 'salesnav_advanced' as const,
  tijdzone: 'Europe/London',
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
  await maakNieuweKlant(
    db,
    {
      klantNaam: 'Acme B.V.',
      slug: 'acme',
      eigenaarNaam: 'Eva de Vries',
      eigenaarEmail: 'Eva@Acme.nl',
      abonnement: 'premium_business',
      abonnementVereist: true,
    },
    OPTIES,
  );
});

async function aantalAccounts(): Promise<number> {
  const [r] = await db.query<{ n: number }>('select count(*)::int as n from accounts');
  return r?.n ?? 0;
}

async function weigert(invoer: Partial<typeof TOEVOEGEN>, patroon: RegExp): Promise<void> {
  await assert.rejects(voegAccountToe(db, { ...TOEVOEGEN, ...invoer }, OPTIES), (err: Error) => {
    assert.ok(err instanceof NieuweKlantFout, `verwachtte NieuweKlantFout, kreeg ${err.name}`);
    assert.match(err.message, patroon);
    return true;
  });
  assert.equal(await aantalAccounts(), 1, 'er mag geen account bij gekomen zijn');
}

describe('voegAccountToe (SPEC §14.2a)', () => {
  it('voegt een account toe met elk veld en de gekozen tijdzone, plus een uitnodiging van 7 dagen', async () => {
    const r = await voegAccountToe(db, TOEVOEGEN, OPTIES);
    const client = await vindClientBijSlug(db, 'acme');
    assert.equal(r.clientId, client?.id);
    const account = await vindAccount(db, r.accountId);
    assert.equal(account?.clientId, client?.id);
    assert.equal(account?.eigenaarNaam, 'Tom Baker');
    assert.equal(account?.eigenaarEmail, 'tom@acme.co.uk');
    assert.equal(account?.abonnement, 'salesnav_advanced');
    assert.equal(account?.tijdzone, 'Europe/London');
    assert.equal(account?.status, 'CONNECTING');
    assert.equal(account?.opbouwFactor, 0.5);
    assert.equal(account?.unipileAccountId, null);
    assert.equal(await aantalAccounts(), 2);

    const u = await vindGeldigeUitnodiging(db, r.uitnodiging.token, vasteKlok(NU));
    assert.equal(u?.accountId, r.accountId);
    assert.equal(r.uitnodiging.verlooptOp.getTime(), NU.getTime() + 7 * DAG);
  });

  it('trimt invoer en zet de tijdzone recht; leeg wordt Europe/Amsterdam', async () => {
    const r = await voegAccountToe(
      db,
      { ...TOEVOEGEN, eigenaarNaam: '  Tom Baker ', eigenaarEmail: ' tom@acme.co.uk ', tijdzone: 'europe/paris' },
      OPTIES,
    );
    const a = await vindAccount(db, r.accountId);
    assert.equal(a?.eigenaarNaam, 'Tom Baker');
    assert.equal(a?.eigenaarEmail, 'tom@acme.co.uk');
    assert.equal(a?.tijdzone, 'Europe/Paris');

    const r2 = await voegAccountToe(db, { ...TOEVOEGEN, eigenaarEmail: 'ann@acme.nl', tijdzone: '' }, OPTIES);
    assert.equal((await vindAccount(db, r2.accountId))?.tijdzone, 'Europe/Amsterdam');
  });

  it('weigert een ongeldige tijdzone', async () => {
    await weigert({ tijdzone: 'Europe/Londen' }, /"Europe\/Londen" is geen geldige tijdzone/);
    await weigert({ tijdzone: '+01:00' }, /geen geldige tijdzone/);
  });

  it('weigert een onbekend abonnement', async () => {
    await weigert({ abonnement: 'gratis' as never }, /Onbekend LinkedIn-abonnement "gratis"/);
  });

  it('weigert een lege naam en een ongeldig e-mailadres', async () => {
    await weigert({ eigenaarNaam: '   ' }, /naam van de accounteigenaar/i);
    await weigert({ eigenaarNaam: 'x'.repeat(201) }, /te lang/i);
    await weigert({ eigenaarEmail: 'geen-mail' }, /geldig e-mailadres/);
    await weigert({ eigenaarEmail: '' }, /geldig e-mailadres/);
  });

  it('weigert een dubbel e-mailadres van de eigenaar binnen dezelfde klant (hoofdletterongevoelig)', async () => {
    await weigert({ eigenaarEmail: 'eva@acme.NL' }, /heeft al een account van eva@acme\.nl \(Eva de Vries\)/i);
  });

  it('staat hetzelfde e-mailadres wel toe bij een andere klant', async () => {
    await maakNieuweKlant(
      db,
      {
        klantNaam: 'Beta',
        slug: 'beta',
        eigenaarNaam: 'Bert',
        eigenaarEmail: 'bert@beta.nl',
        abonnement: 'free',
        abonnementVereist: false,
      },
      OPTIES,
    );
    const r = await voegAccountToe(db, { ...TOEVOEGEN, slug: 'beta', eigenaarEmail: 'eva@acme.nl' }, OPTIES);
    assert.ok(await vindAccount(db, r.accountId));
  });

  it('weigert een onbekende klant', async () => {
    await weigert({ slug: 'bestaat-niet' }, /Onbekende klant "bestaat-niet"/);
  });

  it('rolt het account terug als de uitnodiging faalt (transactie)', async () => {
    await assert.rejects(voegAccountToe(db, TOEVOEGEN, { klok: vasteKlok(NU), geldigDagen: Number.NaN }));
    assert.equal(await aantalAccounts(), 1);
  });
});

describe('maakNieuweKlant met tijdzone (SPEC §14.2a punt 2)', () => {
  const INVOER = {
    klantNaam: 'Gamma Ltd',
    slug: 'gamma',
    eigenaarNaam: 'Gail',
    eigenaarEmail: 'gail@gamma.co.uk',
    abonnement: 'premium_business' as const,
    abonnementVereist: true,
  };

  it('een nieuwe klant met Europe/London krijgt die tijdzone ook echt', async () => {
    const r = await maakNieuweKlant(db, { ...INVOER, tijdzone: 'Europe/London' }, OPTIES);
    assert.equal((await vindAccount(db, r.accountId))?.tijdzone, 'Europe/London');
  });

  it('zonder of met lege tijdzone wordt het Europe/Amsterdam', async () => {
    const r = await maakNieuweKlant(db, { ...INVOER, tijdzone: '' }, OPTIES);
    assert.equal((await vindAccount(db, r.accountId))?.tijdzone, 'Europe/Amsterdam');
  });

  it('weigert een ongeldige tijdzone en maakt niets aan', async () => {
    await assert.rejects(
      maakNieuweKlant(db, { ...INVOER, tijdzone: 'Amsterdam' }, OPTIES),
      /"Amsterdam" is geen geldige tijdzone/,
    );
    assert.equal(await vindClientBijSlug(db, 'gamma'), null);
  });
});
